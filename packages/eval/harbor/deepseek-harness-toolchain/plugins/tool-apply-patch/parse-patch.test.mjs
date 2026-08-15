import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parsePatch } from './parse-patch.mjs';
import { applyDiff } from './vendor/apply-diff.mjs';

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('parsePatch', () => {
  it('splits the envelope from the Codex instructions into its three operations', () => {
    // The worked example in openai/codex's apply_patch tool instructions,
    // verbatim. It is the one input the grammar's own documentation promises
    // works, so it is the case a regression here would be most visible in.
    assert.deepEqual(
      parsePatch(
        patch(
          '*** Add File: hello.txt',
          '+Hello world',
          '*** Update File: src/app.py',
          '*** Move to: src/main.py',
          '@@ def greet():',
          '-print("Hi")',
          '+print("Hello, world!")',
          '*** Delete File: obsolete.txt',
        ),
      ),
      [
        { type: 'create_file', path: 'hello.txt', diff: '+Hello world' },
        {
          type: 'update_file',
          path: 'src/app.py',
          movePath: 'src/main.py',
          diff: '@@ def greet():\n-print("Hi")\n+print("Hello, world!")',
        },
        { type: 'delete_file', path: 'obsolete.txt' },
      ],
    );
  });

  it('keeps operation order', () => {
    const operations = parsePatch(
      patch('*** Delete File: a', '*** Delete File: b', '*** Delete File: c'),
    );
    assert.deepEqual(
      operations.map(({ path }) => path),
      ['a', 'b', 'c'],
    );
  });

  it('accepts an update that only renames', () => {
    assert.deepEqual(parsePatch(patch('*** Update File: old.txt', '*** Move to: new.txt')), [
      { type: 'update_file', path: 'old.txt', movePath: 'new.txt' },
    ]);
  });

  it('keeps `*** End of File` inside the section body', () => {
    // The applier reads this marker as an end-of-file anchor. Cutting the body
    // at it would silently drop the anchor and change where the hunk matches.
    const [operation] = parsePatch(
      patch('*** Update File: a.txt', '@@', ' tail', '+added', '*** End of File'),
    );
    assert.equal(operation.diff, '@@\n tail\n+added\n*** End of File');
    assert.equal(applyDiff('head\ntail', operation.diff), 'head\ntail\nadded');
  });

  it('takes a path verbatim, spaces included', () => {
    assert.deepEqual(parsePatch(patch('*** Delete File: dir with spaces/a b.txt')), [
      { type: 'delete_file', path: 'dir with spaces/a b.txt' },
    ]);
  });

  it('does not treat a later `*** Move to:` as a rename', () => {
    // Only the line straight after the header renames. Anywhere else it is a
    // body line, and the applier refuses it — which is the behaviour that keeps
    // a malformed patch from half-applying.
    const [operation] = parsePatch(
      patch('*** Update File: a.txt', '@@', ' keep', '*** Move to: b.txt'),
    );
    assert.equal(operation.movePath, undefined);
    assert.throws(() => applyDiff('keep', operation.diff), /Invalid Line/u);
  });

  it('tolerates CRLF and trailing blank lines', () => {
    assert.deepEqual(
      parsePatch('*** Begin Patch\r\n*** Delete File: a.txt\r\n*** End Patch\r\n\n'),
      [{ type: 'delete_file', path: 'a.txt' }],
    );
  });

  it('passes an Add File body through unparsed', () => {
    // Whether every line starts with `+` is the applier's rule, checked in its
    // create mode. Enforcing it here too would put the same rule in two places.
    const [operation] = parsePatch(patch('*** Add File: a.txt', 'no plus prefix'));
    assert.equal(operation.diff, 'no plus prefix');
    assert.throws(() => applyDiff('', operation.diff, 'create'), /Invalid Add File Line/u);
  });

  for (const [name, input, message] of [
    ['a missing opener', '*** Delete File: a\n*** End Patch', /must start with/u],
    ['a missing terminator', '*** Begin Patch\n*** Delete File: a', /must end with/u],
    ['an empty envelope', '*** Begin Patch\n*** End Patch', /no file operations/u],
    ['an unknown header', patch('*** Rename File: a'), /expected a file header/u],
    ['a header with no path', patch('*** Delete File: '), /needs a path/u],
    ['a rename with no path', patch('*** Update File: a', '*** Move to:  '), /needs a path/u],
    ['a body line outside any section', patch('+orphan'), /expected a file header/u],
    ['an empty Add File', patch('*** Add File: a.txt'), /no content lines/u],
    ['an empty Update File', patch('*** Update File: a.txt'), /no hunks and no/u],
  ]) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parsePatch(input), { name: 'SyntaxError', message });
    });
  }
});
