import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createExternalSubjectAdapter } from '../external-subject.js';
import type { ExperimentCell } from '../experiment.js';
import { createMakaSubjectAdapter } from '../maka-subject.js';
import type { SubjectExecutionContext } from '../runner.js';

test('external subject delegates exactly one declared command to its executor', async () => {
  const cell = subjectCell('external', {
    command: '/opt/competitor',
    args: ['solve', '{{task.id}}', '{{task.input}}'],
  });
  let request: unknown;
  const result = await createExternalSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async (input) => {
        request = input;
        return {
          termination: 'exited',
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 'maka.external_subject_result.v1',
            usage: null,
            costUsd: null,
            artifacts: [],
          }),
        };
      },
    },
  });

  assert.deepEqual(request, {
    command: '/opt/competitor',
    args: ['solve', 'task', 'official instruction'],
    credentialNames: ['PROVIDER_KEY'],
  });
  assert.equal(result.status, 'completed');
});

test('Maka subject delegates one Hosted execution without owning Runtime lifecycle', async () => {
  const cell = subjectCell('maka', {
    nodePath: '/opt/node/bin/node',
    shimPath: '/opt/maka/harbor-maka-subject.js',
    runtimeHostsPath: '/tmp/maka-runtime-hosts',
    baseUrl: 'https://provider.test/v1',
    connectionSlug: 'provider',
    model: 'model',
    thinkingLevel: 'high',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  });
  let request: { readonly args: readonly string[] } | undefined;
  const result = await createMakaSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async (input) => {
        request = input;
        const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
          execution: {
            executionId: string;
            session: { workspace: { kind: string; path: string } };
            content: { text: string };
            maxSteps: number;
          };
        };
        assert.deepEqual(payload.execution.session.workspace, { kind: 'host_path', path: '/app' });
        assert.equal(payload.execution.content.text, 'official instruction');
        assert.equal(payload.execution.maxSteps, 100);
        return {
          termination: 'exited',
          exitCode: 0,
          stdout: JSON.stringify({
            executionId: payload.execution.executionId,
            kind: 'settled',
            status: 'completed',
            usage: zeroUsage(),
            costUsd: null,
          }),
        };
      },
    },
  });

  assert.equal(request?.args[0], '/opt/maka/harbor-maka-subject.js');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.artifacts, []);
});

test('framework timeout remains a verifiable failure for every subject kind', async () => {
  const cell = subjectCell('maka', {
    nodePath: '/opt/node/bin/node',
    shimPath: '/opt/maka/harbor-maka-subject.js',
    runtimeHostsPath: '/tmp/maka-runtime-hosts',
    baseUrl: 'https://provider.test/v1',
    connectionSlug: 'provider',
    model: 'model',
    thinkingLevel: 'high',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  });
  const makaResult = await createMakaSubjectAdapter().execute({
    cell,
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async (input) => {
        const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
          execution: { executionId: string };
        };
        return {
          termination: 'framework_timeout' as const,
          exitCode: 124,
          stdout: JSON.stringify({
            executionId: payload.execution.executionId,
            kind: 'settled',
            status: 'cancelled',
            usage: zeroUsage(),
            costUsd: null,
          }),
        };
      },
    },
  });

  assert.equal(makaResult.status, 'failed');

  const externalResult = await createExternalSubjectAdapter().execute({
    cell: subjectCell('external', { command: '/opt/competitor', args: [] }),
    context: {
      cwd: '/app',
      taskInput: 'official instruction',
      metadata: {},
      execute: async () => ({ termination: 'framework_timeout', exitCode: 0, stdout: '' }),
    },
  });
  assert.equal(externalResult.status, 'failed');
});

test('Maka subject records the precise safe failure stage', async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly stage: string;
    readonly execute: (input: Parameters<SubjectExecutionContext['execute']>[0]) => Promise<{
      termination: 'exited';
      exitCode: number;
      stdout: string;
    }>;
  }[] = [
    {
      name: 'relay execute rejection',
      stage: 'relay-execute',
      execute: async () => {
        throw new Error('test-only sensitive relay detail');
      },
    },
    {
      name: 'empty output',
      stage: 'empty-output',
      execute: async () => ({ termination: 'exited', exitCode: 1, stdout: '' }),
    },
    {
      name: 'JSON parse',
      stage: 'json-parse',
      execute: async () => ({ termination: 'exited', exitCode: 1, stdout: '{' }),
    },
    {
      name: 'result decode',
      stage: 'result-decode',
      execute: async () => ({ termination: 'exited', exitCode: 1, stdout: '{}' }),
    },
    {
      name: 'identity check',
      stage: 'identity-check',
      execute: async () => ({
        termination: 'exited',
        exitCode: 0,
        stdout: JSON.stringify({
          executionId: 'different-execution',
          kind: 'settled',
          status: 'completed',
          usage: zeroUsage(),
          costUsd: null,
        }),
      }),
    },
  ];

  for (const failure of cases) {
    await t.test(failure.name, async () => {
      const result = await createMakaSubjectAdapter().execute({
        cell: subjectCell('maka', makaConfig()),
        context: {
          cwd: '/app',
          taskInput: 'official instruction',
          metadata: {},
          execute: failure.execute,
        },
      });

      assert.equal(result.status, 'infra_failed');
      assert.equal(result.failureReason, `Maka subject failed during ${failure.stage}`);
      assert.equal(result.artifacts[0]?.kind, 'subject-failure');
      assert.equal(result.artifacts[0]?.stage, failure.stage);
      assert.doesNotMatch(JSON.stringify(result), /sensitive relay detail|different-execution/u);
    });
  }
});

test('Maka subject keeps only fixed Runtime Host failure reasons', async () => {
  for (const [projection, expectedStatus, expectedReason] of [
    [
      { kind: 'indeterminate', failureReason: 'PROVIDER_KEY=test-only-sensitive-value' },
      'indeterminate',
      'Maka execution did not settle',
    ],
    [
      {
        kind: 'indeterminate',
        failureReason: 'Runtime Host usage did not settle: missing_attempt_usage',
      },
      'indeterminate',
      'Runtime Host usage did not settle: missing_attempt_usage',
    ],
    [
      {
        kind: 'settled',
        status: 'completed',
        failureReason: 'PROVIDER_KEY=test-only-sensitive-value',
        usage: zeroUsage(),
        costUsd: null,
      },
      'completed',
      null,
    ],
    [
      { kind: 'settled', status: 'cancelled', usage: zeroUsage(), costUsd: null },
      'indeterminate',
      'Maka subject cancelled',
    ],
  ] as const) {
    const result = await createMakaSubjectAdapter().execute({
      cell: subjectCell('maka', makaConfig()),
      context: {
        cwd: '/app',
        taskInput: 'official instruction',
        metadata: {},
        execute: async (input) => {
          const payload = JSON.parse(Buffer.from(input.args[1] ?? '', 'base64url').toString()) as {
            execution: { executionId: string };
          };
          return {
            termination: 'exited',
            exitCode: 0,
            stdout: JSON.stringify({
              executionId: payload.execution.executionId,
              ...projection,
            }),
          };
        },
      },
    });

    assert.equal(result.status, expectedStatus);
    assert.equal(result.failureReason, expectedReason);
    assert.doesNotMatch(result.failureReason ?? '', /test-only-sensitive-value/u);
  }
});

function subjectCell(
  kind: 'maka' | 'external',
  config: ExperimentCell['subject']['config'],
): ExperimentCell {
  return {
    id: `task::1::${kind}`,
    experimentId: 'experiment',
    benchmark: { id: 'benchmark', version: '1', config: {} },
    executor: { kind: 'harbor', config: {} },
    subject: { id: kind, kind, credentials: ['PROVIDER_KEY'], config },
    task: { id: 'task', input: 'instruction', config: {} },
    repetition: 1,
    budget: { maxSteps: 100 },
    verifier: {},
  };
}

function makaConfig(): ExperimentCell['subject']['config'] {
  return {
    nodePath: '/opt/node/bin/node',
    shimPath: '/opt/maka/harbor-maka-subject.js',
    runtimeHostsPath: '/tmp/maka-runtime-hosts',
    baseUrl: 'https://provider.test/v1',
    connectionSlug: 'provider',
    model: 'model',
    thinkingLevel: 'high',
    permissionMode: 'bypass',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}
