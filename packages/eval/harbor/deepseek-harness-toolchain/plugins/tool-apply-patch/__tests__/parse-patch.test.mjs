// The operations `parsePatch` produces, as opposed to the file they end up
// producing.
//
// What a patch does to a tree is pinned against the real `codex` binary in
// codex-fixtures.test.mjs, which is a stronger check than anything written by
// hand. What that cannot see is the shape in between — which lines went to
// `oldLines` and which to `newLines`, whether a context line reached both, what
// `changeContext` a chunk carries — and a parser can get all of it wrong in
// ways that happen to cancel out on the cases tested. That is what is here.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parsePatch } from '../parse-patch.mjs';

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const chunk = (fields) => ({ oldLines: [], newLines: [], isEndOfFile: false, ...fields });

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
        { type: 'add_file', path: 'hello.txt', contents: 'Hello world\n' },
        {
          type: 'update_file',
          path: 'src/app.py',
          movePath: 'src/main.py',
          chunks: [
            chunk({
              changeContext: 'def greet():',
              oldLines: ['print("Hi")'],
              newLines: ['print("Hello, world!")'],
            }),
          ],
        },
        { type: 'delete_file', path: 'obsolete.txt' },
      ],
    );
  });

  it('sends a context line to both sides of the chunk', () => {
    // `push_context_line` appends to `old_lines` and `new_lines` alike. Sending
    // it to only one turns every context line into an edit.
    const [operation] = parsePatch(
      patch('*** Update File: a.txt', '@@', ' before', '-old', '+new', ' after'),
    );
    assert.deepEqual(operation.chunks, [
      chunk({ oldLines: ['before', 'old', 'after'], newLines: ['before', 'new', 'after'] }),
    ]);
  });

  it('reads an empty line as context whose leading space was dropped', () => {
    const [operation] = parsePatch(patch('*** Update File: a.txt', '@@', ' a', '', '-b', '+B'));
    assert.deepEqual(operation.chunks, [
      chunk({ oldLines: ['a', '', 'b'], newLines: ['a', '', 'B'] }),
    ]);
  });

  it('starts a new chunk at each @@, with and without a header', () => {
    const [operation] = parsePatch(
      patch('*** Update File: a.txt', '@@ first', '-a', '+A', '@@', '-b', '+B'),
    );
    assert.deepEqual(operation.chunks, [
      chunk({ changeContext: 'first', oldLines: ['a'], newLines: ['A'] }),
      chunk({ oldLines: ['b'], newLines: ['B'] }),
    ]);
  });

  it('marks the chunk `*** End of File` closes', () => {
    const [operation] = parsePatch(
      patch('*** Update File: a.txt', '@@', '-a', '+A', '*** End of File', '@@', '-b', '+B'),
    );
    assert.deepEqual(operation.chunks, [
      chunk({ oldLines: ['a'], newLines: ['A'], isEndOfFile: true }),
      chunk({ oldLines: ['b'], newLines: ['B'] }),
    ]);
  });

  it('opens a chunk for a hunk that starts without any @@', () => {
    const [operation] = parsePatch(patch('*** Update File: a.txt', '-a', '+A'));
    assert.deepEqual(operation.chunks, [chunk({ oldLines: ['a'], newLines: ['A'] })]);
  });

  it('terminates every added line of a created file', () => {
    const [operation] = parsePatch(patch('*** Add File: a.txt', '+one', '+', '+three'));
    assert.equal(operation.contents, 'one\n\nthree\n');
  });

  it('creates an empty file from an Add File with no lines', () => {
    // The grammar says `add_line+`; the parser does not enforce it, and an empty
    // `__init__.py` is a thing models write. Where the two disagree the
    // implementation wins, because that is what the model is scored against.
    assert.deepEqual(parsePatch(patch('*** Add File: pkg/__init__.py')), [
      { type: 'add_file', path: 'pkg/__init__.py', contents: '' },
    ]);
  });

  it('keeps operation order', () => {
    assert.deepEqual(
      parsePatch(patch('*** Delete File: a', '*** Delete File: b', '*** Delete File: c')).map(
        ({ path }) => path,
      ),
      ['a', 'b', 'c'],
    );
  });

  it('takes a path verbatim, spaces included', () => {
    assert.deepEqual(parsePatch(patch('*** Delete File: dir with spaces/a b.txt')), [
      { type: 'delete_file', path: 'dir with spaces/a b.txt' },
    ]);
  });

  it('accepts the whitespace Codex accepts', () => {
    // The whole patch is trimmed before parsing and each marker line compared
    // with `trim()`. A model that indents the envelope or opens with a newline
    // wrote a valid patch, and refusing it would cost this arm turns the
    // reference never spends.
    for (const input of [
      '\n*** Begin Patch\n*** Delete File: a\n*** End Patch',
      '*** Begin Patch \n*** Delete File: a\n*** End Patch',
      '*** Begin Patch\n*** Delete File: a\n *** End Patch',
      '  *** Begin Patch\n  *** Delete File: a\n  *** End Patch',
      '*** Begin Patch\r\n*** Delete File: a\r\n*** End Patch\r\n\n',
    ]) {
      assert.deepEqual(parsePatch(input), [{ type: 'delete_file', path: 'a' }]);
    }
  });

  it('keeps an indented marker inside an update body as content', () => {
    // Inside an update Codex compares `line.trim_end()`, not `line.trim()`, so
    // an indented line that reads like a header is a context line. Trimming both
    // ends here would end the section early and silently drop the rest.
    const [operation] = parsePatch(
      patch('*** Update File: a.txt', '@@', '-x', '  *** Update File: elsewhere'),
    );
    assert.deepEqual(operation.chunks, [
      chunk({
        oldLines: ['x', ' *** Update File: elsewhere'],
        newLines: [' *** Update File: elsewhere'],
      }),
    ]);
  });

  it('closes the patch on an indented `*** End Patch`, but only as the last line', () => {
    // Upstream flushes whatever is left in its line buffer through
    // `line.trim()`, and the patch was trimmed first, so the leftover is always
    // the final line. One line further in and the same text is content.
    assert.deepEqual(parsePatch('*** Begin Patch\n*** Delete File: a\n  *** End Patch'), [
      { type: 'delete_file', path: 'a' },
    ]);
    const [operation] = parsePatch(
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n  *** End Patch\n+y\n*** End Patch',
    );
    assert.deepEqual(operation.chunks, [
      chunk({ oldLines: ['x', ' *** End Patch'], newLines: [' *** End Patch', 'y'] }),
    ]);
  });

  it('renames only before any hunk', () => {
    // Anywhere else `*** Move to:` is a body line with no `+`, `-` or space
    // prefix, and refusing it is what stops a malformed patch from
    // half-applying under a rename the model did not get.
    assert.throws(
      () => parsePatch(patch('*** Update File: a.txt', '@@', ' keep', '*** Move to: b.txt')),
      { name: 'SyntaxError', message: /start with a @@ context marker/u },
    );
  });

  for (const [name, input, message] of [
    ['a missing opener', '*** Delete File: a\n*** End Patch', /must start with/u],
    ['a missing terminator', '*** Begin Patch\n*** Delete File: a', /must end with/u],
    ['an empty envelope', '*** Begin Patch\n*** End Patch', /no file operations/u],
    ['an unknown header', patch('*** Rename File: a'), /expected a file header/u],
    // Codex's marker carries its trailing space, so a header with nothing after
    // the colon fails `strip_prefix` and is reported as not a header at all.
    ['a header with no path', patch('*** Delete File: '), /expected a file header/u],
    ['a body line outside any section', patch('+orphan'), /expected a file header/u],
    [
      'a stray line under a Delete File',
      patch('*** Delete File: a', '+x'),
      /expected a file header/u,
    ],
    [
      'a blank line between sections',
      patch('*** Delete File: a', '', '*** Delete File: b'),
      /expected a file header/u,
    ],
    ['an Add File line without a plus', patch('*** Add File: a.txt', 'x'), /expects `\+` lines/u],
    ['an Update File with no hunks', patch('*** Update File: a.txt'), /is empty/u],
    // `ensure_update_hunk_is_not_empty` runs before `move_path` is read, so a
    // bare rename is not a patch upstream either.
    [
      'an update that only renames',
      patch('*** Update File: a.txt', '*** Move to: b.txt'),
      /is empty/u,
    ],
    [
      'a trailing @@ with nothing under it',
      patch('*** Update File: a.txt', '@@', '-a', '+A', '@@'),
      /does not contain any lines/u,
    ],
    [
      '`*** End of File` on an empty chunk',
      patch('*** Update File: a.txt', '@@', '*** End of File'),
      /does not contain any lines/u,
    ],
    [
      'two @@ markers in a row',
      patch('*** Update File: a.txt', '@@ outer', '@@ inner', '-a', '+A'),
      /unexpected line found in update hunk/u,
    ],
    [
      'an unprefixed line in a hunk',
      patch('*** Update File: a.txt', '@@', 'bare'),
      /unexpected line found in update hunk/u,
    ],
    [
      'a line after `*** End of File`',
      patch('*** Update File: a.txt', '@@', '-a', '+A', '*** End of File', '-b'),
      /start with a @@ context marker/u,
    ],
    ['a trailing sentence', `${patch('*** Delete File: a')}\nand also`, /must be the last line/u],
    [
      'a second envelope',
      `${patch('*** Delete File: a')}\n${patch('*** Delete File: b')}`,
      /must be the last line/u,
    ],
  ]) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parsePatch(input), { name: 'SyntaxError', message });
    });
  }
});
