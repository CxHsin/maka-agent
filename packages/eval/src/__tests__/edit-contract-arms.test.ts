import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import yaml from 'js-yaml';
import { DEEPSEEK_HARNESS_ARMS, TOOLCHAIN_IDENTITIES } from '../toolchain-verification.js';

// What makes the three DeepSeek Harness arms a controlled comparison rather
// than three arms that happen to resemble each other.
//
// Their compositions are three files, so nothing structural stops one of them
// from acquiring a second difference — a bumped timeout, a reasoning setting,
// an extra service, a narrowed context window — and a run would still produce
// numbers. The numbers would just no longer be about the edit contract. These
// assertions are the thing that fails first when that happens.
//
// The arm-to-directory table is imported rather than restated, so a test that
// passes is a statement about the compositions the subject actually copies.

const ARMS = DEEPSEEK_HARNESS_ARMS;

// The rows each arm is allowed to differ by: its editor, and nothing else. No
// arm mounts `fs-observation-policy` — it is not part of any edit contract, and
// mounting it in one arm gave that arm failure modes the others cannot have.
//
// Pinned whole rather than by id. Naming only the id would leave the treatment
// itself unguarded — the one thing the experiment measures — so an override of
// the patch tool's description, or a tenfold cut to an editor's output budget,
// would be the sole edit here that no assertion covers. Changing a contract is
// allowed; changing it without saying so here is not.
const EDIT_CONTRACT_ROWS: Readonly<Record<keyof typeof ARMS, readonly Entry[]>> = {
  'deepseek-harness': [
    {
      id: 'str-replace-editor',
      name: '@deepseek-ai/dsh-tool-str-replace-editor',
      config: { maxOutputChars: 16000 },
    },
  ],
  'deepseek-harness-fs': [
    // Matched to the baseline's output budget: the size of a read is not part
    // of the contract, and the shipped default is 51200 bytes.
    { id: 'fs-tools', name: '@deepseek-ai/dsh-tool-fs', config: { readMaxBytes: 16000 } },
  ],
  'deepseek-harness-apply-patch': [
    {
      id: 'apply-patch',
      name: "!!js process.env.MAKA_EVAL_DSH_PLUGINS + '/tool-apply-patch/index.mjs'",
    },
  ],
};

function profileFile(directory: string, file: string): URL {
  return new URL(`../../harbor/${directory}/${file}`, import.meta.url);
}

const read = (directory: string, file: string) => readFile(profileFile(directory, file), 'utf8');

interface Entry {
  readonly id: string;
  readonly name?: string;
  readonly config?: Record<string, unknown>;
}

// `!!js` marks an expression the harness evaluates when it loads the file. It
// is kept as text: the point is to compare what the arms declare, and two arms
// declaring the same expression is the thing being checked.
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data: unknown) => `!!js ${String(data)}`,
  }),
]);

// The composed entries, whole. An earlier version of this test read each `- id:`
// row with the `name:` on the line below it and compared those strings, which
// left every `config:` block unchecked: narrowing one arm's `contextWindow`,
// halving its editor's output budget, rewriting the shared bash description, or
// overriding the patch tool's description all kept it green. Parsing the file
// is what makes the comparison cover what the model actually receives.
function entries(source: string): Entry[] {
  const document = yaml.load(source, { schema: SCHEMA }) as Array<{ insert?: Entry[] }>;
  const inserted = document.flatMap((step) => step.insert ?? []);
  assert.ok(inserted.length > 0, 'composition declares no entries');
  return inserted;
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
      const all = entries(await read(directory, 'cordis.patch.yml'));
      const allowed = EDIT_CONTRACT_ROWS[arm as keyof typeof ARMS];
      const ids = allowed.map((entry) => entry.id);
      const contract = all.filter((entry) => ids.includes(entry.id));
      // The treatment, exactly as declared. A row named here that the file does
      // not have would silently widen what the comparison tolerates, so the
      // allowance has to be spent in full.
      assert.deepEqual(contract, allowed, `${arm} does not compose the contract it declares`);
      return {
        arm,
        contract,
        rest: all.filter((entry) => !ids.includes(entry.id)),
        // Position matters as much as membership: the model reads its tools in
        // the order they are registered, and moving the editor row past bash
        // reorders the tool list without changing what is in it.
        order: all.map((entry) => (ids.includes(entry.id) ? '(contract)' : entry.id)),
      };
    }),
  );

  const [baseline, ...others] = composed;
  for (const other of others) {
    // Whole entries, `config` included.
    assert.deepEqual(other.rest, baseline.rest, `${other.arm} differs from ${baseline.arm}`);
    assert.deepEqual(other.order, baseline.order, `${other.arm} composes in a different order`);
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
  //
  // Asserted against the parsed entry a setting belongs to, not against the
  // file text. A regex over the whole file matches a comment mentioning the
  // value just as happily as the setting itself, and says nothing about which
  // service carries it.
  const CONTROLS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['agent-default-model', { provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    ['sandbox-policy', { mode: 'danger-full-access' }],
    [
      'system-prompt',
      {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        persona: 'You are a helpful software engineer assistant.',
      },
    ],
    ['terminal-bash', { timeoutMs: 3900000 }],
  ];
  for (const [arm, directory] of Object.entries(ARMS)) {
    const composed = entries(await read(directory, 'cordis.patch.yml'));
    const find = (id: string) => composed.find((entry) => entry.id === id);
    for (const [id, config] of CONTROLS) {
      assert.deepEqual(find(id)?.config, config, `${arm} does not pin ${id}`);
    }
    // Reasoning strength is the deliberate deviation from the upstream
    // composition, so it is the setting most likely to be edited back.
    const provider = find('llm-deepseek')?.config;
    assert.equal(provider?.thinking, 'enabled', `${arm} does not pin thinking`);
    assert.equal(provider?.reasoningEffort, 'max', `${arm} does not pin reasoning effort`);
    // Both the terminal and the tool carry the deadline, and the arm set is
    // only comparable if neither drifted in one file.
    assert.equal(
      find('persistent-bash')?.config?.timeoutMs,
      3900000,
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
