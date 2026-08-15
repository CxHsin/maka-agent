import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { TOOLCHAIN_IDENTITIES, type ExternalProfile } from '../toolchain-verification.js';

// What makes the three DeepSeek Harness arms a controlled comparison rather
// than three arms that happen to resemble each other.
//
// Their compositions are three files, so nothing structural stops one of them
// from acquiring a second difference — a bumped timeout, a reasoning setting,
// an extra service — and a run would still produce numbers. The numbers would
// just no longer be about the edit contract. These assertions are the thing
// that fails first when that happens.

const ARMS = {
  'deepseek-harness': 'deepseek-harness-profile',
  'deepseek-harness-fs': 'deepseek-harness-fs-profile',
  'deepseek-harness-apply-patch': 'deepseek-harness-apply-patch-profile',
} as const satisfies Partial<Record<ExternalProfile, string>>;

// The rows each arm is allowed to differ by: its editor, and — for the arm
// whose tool family documents one — the file-observation policy that family's
// own prompt text tells the model about.
const EDIT_CONTRACT_ROWS: Readonly<Record<keyof typeof ARMS, readonly string[]>> = {
  'deepseek-harness': ['str-replace-editor'],
  'deepseek-harness-fs': ['fs-observation-policy', 'fs-tools'],
  'deepseek-harness-apply-patch': ['apply-patch'],
};

function profileFile(directory: string, file: string): URL {
  return new URL(`../../harbor/${directory}/${file}`, import.meta.url);
}

const read = (directory: string, file: string) => readFile(profileFile(directory, file), 'utf8');

// Every `- id:` row with the package or path on the line under it. Compared
// instead of the raw text so that a comment rewritten in one file is not a
// failure, while a service added to one arm is.
function rows(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  for (const [index, line] of lines.entries()) {
    const id = /^\s*- id:\s*(\S+)\s*$/u.exec(line);
    if (id === null) continue;
    const name = /^\s*name:\s*(.+?)\s*$/u.exec(lines[index + 1] ?? '');
    found.push(`${id[1]} -> ${name?.[1] ?? '(none)'}`);
  }
  return found;
}

test('the three arms share every profile file that is not the composition', async () => {
  const [baseline, ...others] = await Promise.all(
    Object.values(ARMS).map(async (directory) => ({
      directory,
      files: await Promise.all(['package.json', 'cordis.yml'].map((file) => read(directory, file))),
    })),
  );
  for (const other of others) {
    assert.deepEqual(
      other.files,
      baseline.files,
      `${other.directory} diverges from ${baseline.directory} outside cordis.patch.yml`,
    );
  }
});

test('the three compositions differ only in their edit-contract rows', async () => {
  const composed = await Promise.all(
    Object.entries(ARMS).map(async ([arm, directory]) => {
      const all = rows(await read(directory, 'cordis.patch.yml'));
      const allowed = EDIT_CONTRACT_ROWS[arm as keyof typeof ARMS];
      const contract = all.filter((row) => allowed.includes(row.split(' -> ')[0] ?? ''));
      // A row named here that the file does not have would silently widen what
      // the comparison tolerates, so the allowance has to be spent in full.
      assert.equal(contract.length, allowed.length, `${arm} is missing an edit-contract row`);
      return {
        arm,
        contract,
        rest: all.filter((row) => !allowed.includes(row.split(' -> ')[0] ?? '')),
      };
    }),
  );

  const [baseline, ...others] = composed;
  for (const other of others) {
    assert.deepEqual(other.rest, baseline.rest, `${other.arm} differs from ${baseline.arm}`);
    // Without this the assertion above would pass just as well if two arms
    // were accidentally given the same editor.
    assert.notDeepEqual(
      other.contract,
      baseline.contract,
      `${other.arm} has no contract of its own`,
    );
  }
});

test('the settings that are not the variable are identical across the arms', async () => {
  // The controls worth pinning by value: what the model is, how hard it
  // reasons, how long a command may run, what the sandbox allows, and the
  // persona that is the whole system prompt. Each of these would move a score
  // on its own.
  const CONTROLS = [
    /model: deepseek-v4-flash/u,
    /thinking: enabled/u,
    /reasoningEffort: max/u,
    /mode: danger-full-access/u,
    /persona: You are a helpful software engineer assistant\./u,
    /includeHarnessIdentity: false/u,
    /includeRuntimeContext: false/u,
  ];
  for (const [arm, directory] of Object.entries(ARMS)) {
    const source = await read(directory, 'cordis.patch.yml');
    for (const control of CONTROLS) {
      assert.match(source, control, `${arm} does not pin ${control.source}`);
    }
    // Both the terminal and the tool carry the deadline, and the arm set is
    // only comparable if neither drifted in one file.
    assert.equal(
      source.match(/timeoutMs: 3900000/gu)?.length,
      2,
      `${arm} does not carry both bash deadlines`,
    );
  }
});

test('the arms are pinned to one toolchain identity', async () => {
  const identities = Object.keys(ARMS).map((arm) => TOOLCHAIN_IDENTITIES[arm as keyof typeof ARMS]);
  for (const identity of identities) {
    // Object identity, not deep equality: three equal copies would drift the
    // moment one fingerprint is re-pinned and the others are not.
    assert.equal(identity, identities[0]);
  }
});

test('the experiment runs the three arms against one another', async () => {
  const experiment = JSON.parse(
    await readFile(
      new URL(
        '../../experiments/terminal-bench-2.1-deepseek-v4-flash-edit-contracts.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { subjects: Array<{ id: string; config: { args: string[] } }> };

  assert.deepEqual(
    experiment.subjects.map(({ id }) => id),
    Object.keys(ARMS),
  );
  // The profile argument is the only thing that may differ: it is what selects
  // the composition, and therefore the contract.
  const [first, ...rest] = experiment.subjects;
  for (const subject of rest) {
    assert.equal(subject.config.args[1], subject.id);
    assert.deepEqual(
      subject.config.args.filter((_, index) => index !== 1),
      first.config.args.filter((_, index) => index !== 1),
      `${subject.id} is launched differently from ${first.id}`,
    );
  }
});
