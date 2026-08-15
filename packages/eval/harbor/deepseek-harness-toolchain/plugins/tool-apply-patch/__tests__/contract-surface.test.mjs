// Everything the model can observe about this arm, asserted.
//
// The treatment is not the applier, which the model never sees. It is the tool
// name, the parameter it takes, and the description text — and until this file
// existed none of the three was covered, so a build that registered the tool
// under another name or shipped a truncated description would have run a
// benchmark cohort and produced numbers.
//
// The description is the part that has to be argued rather than asserted, so it
// is argued here once. `upstream-apply-patch-instructions.md` is a byte-for-byte
// slice of an upstream artifact; the substitutions in `DESCRIPTION_ADAPTATIONS`
// are the only thing this repository adds; and the test below checks both ends
// of that claim — the file is what it was copied as, and the built text differs
// from it in exactly those places.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { buildDescription, DESCRIPTION_ADAPTATIONS, UPSTREAM_DESCRIPTION } from '../index.mjs';
import { harness } from './test-harness.mjs';

// openai/codex a7edf37cb46b5fc4d50bd03df8e5999a86f602eb, Apache-2.0:
//
//   git show a7edf37cb46b5fc4d50bd03df8e5999a86f602eb:codex-rs/core/\
//     prompt_with_apply_patch_instructions.md | sed -n '277,351p'
//
// That command reproduces the file byte for byte, and is how a reviewer checks
// this digest against the source rather than against this repository. The digest
// alone only proves the copy has not drifted since it was taken.
const UPSTREAM_SHA256 = '061ad07965f437292a604be2518a6fe445c19324946f9e827fffa0a3e8695d94';

describe('apply_patch contract surface', () => {
  it('carries the upstream instructions unmodified', async () => {
    const bytes = await readFile(
      new URL('../upstream-apply-patch-instructions.md', import.meta.url),
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), UPSTREAM_SHA256);
    assert.equal(bytes.toString('utf8'), UPSTREAM_DESCRIPTION);
  });

  it('differs from the upstream text in exactly the listed adaptations', () => {
    // Recomputed here by splitting rather than by slicing, so this is an
    // independent formulation of the same rule and not a call to the code under
    // test. Anything the build does beyond the list — a stray replace, a
    // template that interpolates — fails at the last assertion.
    let reference = UPSTREAM_DESCRIPTION;
    for (const { from, to, why } of DESCRIPTION_ADAPTATIONS) {
      const parts = reference.split(from);
      assert.equal(parts.length, 2, `adaptation must match exactly once: ${why}`);
      reference = parts.join(to);
    }
    assert.equal(buildDescription(UPSTREAM_DESCRIPTION), reference.trim());
  });

  it('describes no delivery this arm does not have', () => {
    const built = buildDescription(UPSTREAM_DESCRIPTION);
    // The upstream text is written for apply_patch reached through the shell.
    // Any surviving mention would send the model to bash for a binary no arm
    // installs, and it would spend turns finding that out.
    assert.ok(!/\bshell\b/u.test(built));
    assert.ok(!built.includes('```'));
  });

  it('registers one tool, named and shaped as the contract', async () => {
    const { tool, root } = await harness({ files: {} });
    try {
      assert.equal(tool.name, 'apply_patch');
      // The schema `defineTool` publishes, not the shorthand it was given.
      assert.deepEqual(Object.keys(tool.parameters.properties), ['input']);
      assert.equal(tool.parameters.properties.input.type, 'string');
      assert.deepEqual(tool.parameters.required, ['input']);
      // The whole of what the model is told about the format. A parameter
      // description that repeated or contradicted it would be a second contract.
      assert.equal(tool.description, buildDescription(UPSTREAM_DESCRIPTION));
      assert.ok(!/JSON/u.test(tool.parameters.properties.input.description));
    } finally {
      await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
    }
  });
});
