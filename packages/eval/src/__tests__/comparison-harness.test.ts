import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createExternalSubjectAdapter } from '../external-subject.js';
import type { ExperimentCell } from '../experiment.js';

const executeFile = promisify(execFile);

test('external subject preserves a versioned failure with metering evidence', async () => {
  const result = await createExternalSubjectAdapter().execute({
    cell: externalCell(),
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async () => ({
        termination: 'exited',
        exitCode: 1,
        stdout: JSON.stringify({
          schemaVersion: 'maka.external_subject_result.v2',
          status: 'failed',
          failureReason: 'competitor execution failed',
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 4,
            cacheWriteTokens: 0,
            reasoningTokens: 1,
            totalTokens: 12,
          },
          costUsd: 0.01,
          artifacts: [{ kind: 'trajectory', path: '/logs/agent/competitor.jsonl' }],
        }),
      }),
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureReason, 'competitor execution failed');
  assert.equal(result.usage?.totalTokens, 12);
  assert.equal(result.artifacts[0]?.kind, 'trajectory');
});

test('Pi profile uses the shared wrapper with a frozen DeepSeek model condition', async () => {
  const systemRoot = await mkdtemp(join(tmpdir(), 'maka-pi-profile-'));
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const { stdout } = await executeFile(
    process.execPath,
    [
      wrapper.pathname,
      'pi',
      'https://provider.invalid',
      systemRoot,
      '/bin/sh',
      '-c',
      'printf \'{"type":"agent_end"}\\n\'',
    ],
    { env: { ...process.env, OPENAI_API_KEY: 'test-only-placeholder' } },
  );

  const result = JSON.parse(stdout) as { status?: unknown };
  assert.equal(result.status, 'completed');
  const models = JSON.parse(
    await readFile(join(systemRoot, 'tmp/maka-eval-pi/.pi/agent/models.json'), 'utf8'),
  ) as {
    providers: {
      'maka-proxy': {
        api: string;
        models: Array<{ id: string; thinkingLevelMap: { max: string } }>;
      };
    };
  };
  assert.equal(models.providers['maka-proxy'].api, 'openai-completions');
  assert.equal(models.providers['maka-proxy'].models[0]?.id, 'deepseek-v4-flash');
  assert.equal(models.providers['maka-proxy'].models[0]?.thinkingLevelMap.max, 'max');
});

test('Codex profile uses fallback metadata without vendoring a system prompt', async () => {
  const systemRoot = await mkdtemp(join(tmpdir(), 'maka-codex-profile-'));
  const wrapper = new URL('../harbor-external-subject.js', import.meta.url);
  const { stdout } = await executeFile(
    process.execPath,
    [
      wrapper.pathname,
      'codex',
      'https://provider.invalid',
      systemRoot,
      '/bin/sh',
      '-c',
      'printf \'{"type":"turn.completed"}\\n\'',
    ],
    { env: { ...process.env, OPENAI_API_KEY: 'test-only-placeholder' } },
  );

  const result = JSON.parse(stdout) as { status?: unknown };
  assert.equal(result.status, 'completed');
  const config = await readFile(join(systemRoot, 'tmp/maka-eval-codex/config.toml'), 'utf8');
  assert.match(config, /model_reasoning_effort = "max"/u);
  assert.match(config, /model_context_window = 1048576/u);
  assert.match(config, /plugins = false/u);
  assert.doesNotMatch(config, /model_catalog_json/u);
});

function externalCell(): ExperimentCell {
  return {
    id: 'task::1::external',
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: {
      id: 'external',
      kind: 'external',
      credentials: ['PROVIDER_KEY'],
      config: { command: '/opt/competitor', args: [] },
    },
    task: { id: 'task', input: 'instruction', config: {} },
    repetition: 1,
    budget: {},
    verifier: {},
  };
}
