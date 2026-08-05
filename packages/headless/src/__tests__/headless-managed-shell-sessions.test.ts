import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { z } from 'zod';
import {
  createHarborCellLocalToolExecutor,
  createHarborHttpToolExecutor,
} from '../harbor-cell-tool-executor.js';
import type { IsolatedToolExecutor } from '../isolation.js';
import { buildIsolatedHeadlessProductToolSurface, buildIsolatedBashTool } from '../tools.js';

const workspace = () => mkdtemp(join(tmpdir(), 'maka-managed-shell-'));

const toolCtx = (cwd: string, toolCallId = 'tool-1') => ({
  sessionId: 'session-1',
  turnId: 'turn-1',
  cwd,
  toolCallId,
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
});

const shapeOf = (parameters: unknown): Record<string, unknown> => {
  const schema = z.toJSONSchema(parameters as z.ZodType, { io: 'input' }) as {
    properties?: Record<string, unknown>;
    allOf?: Array<{ properties?: Record<string, unknown> }>;
  };
  return schema.properties ?? schema.allOf?.[0]?.properties ?? {};
};

const toolNames = (executor: IsolatedToolExecutor) =>
  buildIsolatedHeadlessProductToolSurface(executor).tools.map((tool) => tool.name);

describe('headless managed shell sessions', () => {
  test('a remote executor keeps the stateless single-command surface', () => {
    const executor = createHarborHttpToolExecutor({
      MAKA_HARBOR_TOOL_EXECUTOR_URL: 'http://127.0.0.1:1/',
      MAKA_HARBOR_TOOL_EXECUTOR_TOKEN: 'token',
    });

    // Spawning managed processes locally for a remote workspace would put them
    // on the host beside the credentials, not in the task container.
    assert.equal(executor.shellSessions, undefined);
    const names = toolNames(executor);
    assert.ok(!names.includes('WriteStdin'));
    assert.ok(!names.includes('StopBackgroundTask'));
    assert.deepEqual(Object.keys(shapeOf(buildIsolatedBashTool(executor).parameters)).sort(), [
      'command',
      'timeout_ms',
    ]);
  });

  test('an in-container executor binds background, stdin, and ref reads together', () => {
    const executor = createHarborCellLocalToolExecutor({});
    const names = toolNames(executor);

    assert.ok(names.includes('WriteStdin'), 'a ref the model cannot write to is a dead ref');
    assert.ok(names.includes('StopBackgroundTask'));
    const bash = Object.keys(shapeOf(buildIsolatedBashTool(executor).parameters)).sort();
    assert.deepEqual(bash, ['command', 'pty', 'run_in_background', 'timeout_ms']);
    // No sandbox manager exists behind an external isolation boundary, so the
    // model is never asked to declare an authority nothing would enforce.
    assert.ok(!bash.includes('required_boundary'));
  });

  test('managed commands inherit the executor’s stripped env, not the cell’s credentials', async () => {
    const cwd = await workspace();
    const secretName = 'MAKA_MANAGED_SHELL_TEST_API_KEY';
    const publicName = 'MAKA_MANAGED_SHELL_TEST_PUBLIC';
    process.env[secretName] = 'provider-credential';
    process.env[publicName] = 'visible';
    try {
      const bash = buildIsolatedBashTool(createHarborCellLocalToolExecutor({}));
      const result = (await bash.impl(
        { command: `printenv ${secretName} || true; printenv ${publicName} || true` },
        toolCtx(cwd),
      )) as { output: { stdout: string } };

      // ShellRunProcessManager falls back to the headless process's own env when
      // a launch carries none, and in a Harbor cell that env holds the key the
      // cell uses to call the model.
      assert.ok(
        !result.output.stdout.includes('provider-credential'),
        'provider credential reached the model’s shell',
      );
      assert.ok(result.output.stdout.includes('visible'), 'non-secret env still passes through');
    } finally {
      delete process.env[secretName];
      delete process.env[publicName];
    }
  });

  test('a PTY task survives across calls: start, write, read back, stop', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const sessions = executor.shellSessions;
    assert.ok(sessions);
    const surface = buildIsolatedHeadlessProductToolSurface(executor);
    const tool = (name: string) => {
      const found = surface.tools.find((entry) => entry.name === name);
      assert.ok(found, `${name} is not bound`);
      return found;
    };

    const started = (await tool('Bash').impl(
      { command: 'cat', run_in_background: true, pty: true },
      toolCtx(cwd, 'tool-start'),
    )) as { kind: string; ref: string };
    assert.equal(started.kind, 'shell_run');

    // The whole point of the seam: a second tool call reaches the SAME process.
    const written = (await tool('WriteStdin').impl(
      { ref: started.ref, input: 'interactive-round-trip\r' },
      toolCtx(cwd, 'tool-write'),
    )) as { kind: string };
    assert.equal(written.kind, 'shell_run');

    // WriteStdin returns the screen at its own parser cut, which may precede the
    // child's echo; later output is observed by reading the ref, as its
    // description tells the model.
    let screen = '';
    for (
      let attempt = 0;
      attempt < 50 && !screen.includes('interactive-round-trip');
      attempt += 1
    ) {
      const observed = (await tool('Read').impl(
        { ref: started.ref },
        toolCtx(cwd, `tool-read-${attempt}`),
      )) as { kind: string; output: { mode: string; screen: string } };
      assert.equal(observed.output.mode, 'pty');
      screen = observed.output.screen;
      if (!screen.includes('interactive-round-trip')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.match(screen, /interactive-round-trip/);

    const stopped = (await tool('StopBackgroundTask').impl(
      { ref: started.ref },
      toolCtx(cwd, 'tool-stop'),
    )) as { status: string };
    assert.equal(stopped.status, 'cancelled');
  });

  test('terminateAll leaves nothing managed alive for the grader', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const sessions = executor.shellSessions;
    assert.ok(sessions);
    const bash = buildIsolatedBashTool(executor);

    const started = (await bash.impl(
      { command: 'sleep 600', run_in_background: true },
      toolCtx(cwd, 'tool-sleep'),
    )) as { kind: string; ref: string; status: string };
    assert.equal(started.status, 'running');

    await sessions.terminateAll();

    const after = (await sessions.readRuntimeResource(
      'session-1',
      started.ref,
      new AbortController().signal,
    )) as { status: string };
    assert.notEqual(after.status, 'running');
  });

  test('Read still refuses a path/ref pair and rejects non-runtime refs', async () => {
    const cwd = await workspace();
    const executor = createHarborCellLocalToolExecutor({});
    const read = buildIsolatedHeadlessProductToolSurface(executor).tools.find(
      (tool) => tool.name === 'Read',
    );
    assert.ok(read);

    const parsed = (read.parameters as z.ZodType).safeParse({
      path: 'a.txt',
      ref: 'maka://runtime/background-tasks/x',
    });
    assert.equal(parsed.success, false);

    await assert.rejects(
      async () => await read.impl({ ref: 'https://example.com/not-a-runtime-ref' }, toolCtx(cwd)),
      /Unsupported runtime resource ref/,
    );
  });
});
