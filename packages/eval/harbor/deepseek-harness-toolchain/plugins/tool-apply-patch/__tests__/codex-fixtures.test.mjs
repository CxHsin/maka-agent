// Every fixture in codex-fixtures.json, replayed through this tool.
//
// The expectations were produced by running the `codex` binary itself over the
// same tree (see codex-oracle.mjs), so this asserts against the reference
// rather than against a reading of it. That distinction is the reason the file
// exists: the previous version of this tool applied hunks with a different
// project's V4A implementation, which reads correct and diverges on where a
// context-free `+` hunk lands, on trailing newlines, on CRLF, and on how far a
// near-miss context line may drift.
//
// Two cases are expected to diverge, both for the same reason. The fixtures
// come from the standalone `apply_patch` binary, which composes an envelope's
// operations one at a time; the function tool a model actually calls verifies
// the whole envelope first (`try_verify_apply_patch_args`, invocation.rs:214)
// and so refuses a duplicate path and writes nothing when any section fails.
// This tool implements the function tool. Both are named below with what they
// do instead.

import { strict as assert } from 'node:assert';
import { readFile, rm } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { cases } from './codex-oracle.mjs';
import { harness } from './test-harness.mjs';

const fixtures = JSON.parse(
  await readFile(new URL('./codex-fixtures.json', import.meta.url), 'utf8'),
);

const DIVERGENCES = new Map([
  [
    'delete then add the same path',
    {
      why: 'the envelope names one path twice, which the function tool refuses outright',
      refused: true,
      tree: { 'a.txt': 'old\n' },
    },
  ],
  [
    'three sections, the third malformed',
    {
      why: 'the function tool verifies every section before writing, so a late failure costs nothing',
      refused: true,
      tree: { 'a.txt': 'x\n', 'b.txt': 'y\n' },
    },
  ],
]);

describe(`codex ${fixtures.codex} fixtures`, () => {
  for (const fixture of fixtures.cases) {
    const divergence = DIVERGENCES.get(fixture.name);
    const title = divergence === undefined ? fixture.name : `${fixture.name} — ${divergence.why}`;

    it(title, async () => {
      const expected = divergence ?? fixture;
      const { run, tree, root } = await harness({ files: fixture.files });
      try {
        if (expected.refused) {
          await assert.rejects(run(fixture.patch));
        } else {
          assert.equal(await run(fixture.patch), expected.output.trimEnd());
        }
        assert.deepEqual(await tree(), expected.tree);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it('is in sync with the case list it was generated from', () => {
    // Editing a case without rerunning `node codex-oracle.mjs --write` would
    // otherwise leave this suite asserting the old expectations against the new
    // input, which is the one way a generated fixture can quietly stop being an
    // oracle.
    assert.deepEqual(
      fixtures.cases.map(({ name, files, patch }) => ({ name, files, patch })),
      cases.map(({ name, files, patch }) => ({ name, files, patch })),
    );
    assert.equal(
      new Set(cases.map(({ name }) => name)).size,
      cases.length,
      'case names must be unique, since the divergence list is keyed by them',
    );
    for (const name of DIVERGENCES.keys()) {
      assert.ok(
        cases.some((entry) => entry.name === name),
        `divergence "${name}" names no case`,
      );
    }
  });
});
