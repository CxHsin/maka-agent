// Recording what the real `apply_patch` does, so the port is checked against
// the reference rather than against my reading of it.
//
// The last version of this tool used a different project's V4A implementation
// on the assumption that they agree. They do not, and no amount of reading the
// Rust would have settled it as cheaply as running it. So the expectations in
// codex-fixtures.json are generated, not written: each case below is applied to
// a temporary tree by the `codex` binary itself, and codex-fixtures.test.mjs
// replays the same case through this tool and compares.
//
// Regenerate with a `codex` on PATH, from this directory:
//
//   node codex-oracle.mjs --write
//
// It runs the binary under argv[0] `apply_patch`, which is how Codex's
// multitool dispatches to the standalone applier. That applier composes an
// envelope's operations sequentially where the function tool the model actually
// calls verifies the whole envelope first; codex-fixtures.test.mjs names the
// cases where the two differ and asserts the function-tool behaviour for them.
// Everything else — the hunk grammar, context matching, newline handling — is
// one shared implementation, and that is what these fixtures pin.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const P = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');

export const cases = [
  {
    name: 'instructions worked example',
    files: { 'src/app.py': 'def greet():\n    print("Hi")\n', 'obsolete.txt': 'gone\n' },
    patch: P(
      '*** Add File: hello.txt',
      '+Hello world',
      '*** Update File: src/app.py',
      '*** Move to: src/main.py',
      '@@ def greet():',
      '-    print("Hi")',
      '+    print("Hello, world!")',
      '*** Delete File: obsolete.txt',
    ),
  },
  {
    name: 'add-only hunk under an anchor lands at EOF, not at the anchor',
    files: { 'a.txt': 'alpha\nbeta\ngamma\ndelta\n' },
    patch: P('*** Update File: a.txt', '@@ alpha', '+INSERTED'),
  },
  {
    name: 'add-only hunk with context lines around it',
    files: { 'a.txt': 'one\ntwo\nthree\nfour\n' },
    patch: P('*** Update File: a.txt', '@@', ' one', ' two', '+INSERTED', ' three'),
  },
  {
    name: 'file with no trailing newline gains one',
    files: { 'a.txt': 'one\ntwo' },
    patch: P('*** Update File: a.txt', '@@', '-one', '+ONE'),
  },
  {
    name: 'CRLF file is normalised to LF',
    files: { 'a.txt': 'one\r\ntwo\r\nthree\r\n' },
    patch: P('*** Update File: a.txt', '@@', '-two', '+TWO'),
  },
  {
    name: 'context matched with trailing whitespace only',
    files: { 'a.txt': 'keep   \nchange\ntail\n' },
    patch: P('*** Update File: a.txt', '@@', ' keep', '-change', '+CHANGED'),
  },
  {
    name: 'context matched with leading whitespace differing',
    files: { 'a.txt': '    indented\nchange\n' },
    patch: P('*** Update File: a.txt', '@@', ' indented', '-change', '+CHANGED'),
  },
  {
    name: 'curly quotes in the file, straight quotes in the patch',
    files: { 'a.txt': 'say \u201Chello\u201D now\ntail\n' },
    patch: P('*** Update File: a.txt', '@@', '-say "hello" now', '+said it'),
  },
  {
    name: 'en dash in the file, hyphen in the patch',
    files: { 'a.txt': 'range 1\u201310\ntail\n' },
    patch: P('*** Update File: a.txt', '@@', ' range 1-10', '-tail', '+TAIL'),
  },
  {
    name: 'non-breaking space in the file, plain space in the patch',
    files: { 'a.txt': 'a\u00A0b\ntail\n' },
    patch: P('*** Update File: a.txt', '@@', '-a b', '+ab'),
  },
  {
    name: 'two chunks in one file',
    files: { 'a.txt': 'one\ntwo\nthree\nfour\nfive\n' },
    patch: P('*** Update File: a.txt', '@@', '-one', '+ONE', '@@', '-five', '+FIVE'),
  },
  {
    name: 'repeated block disambiguated by an @@ anchor',
    files: {
      'a.py': 'class A:\n    def f():\n        pass\nclass B:\n    def f():\n        pass\n',
    },
    patch: P(
      '*** Update File: a.py',
      '@@ class B:',
      '     def f():',
      '-        pass',
      '+        return 1',
    ),
  },
  {
    name: 'End of File anchor appends at the end',
    files: { 'a.txt': 'head\ntail\n' },
    patch: P('*** Update File: a.txt', '@@', ' tail', '+added', '*** End of File'),
  },
  {
    name: 'End of File anchor with a repeated line picks the last one',
    files: { 'a.txt': 'x\ny\nx\n' },
    patch: P('*** Update File: a.txt', '@@', '-x', '+X', '*** End of File'),
  },
  {
    name: 'add file with no lines at all',
    files: {},
    patch: P('*** Add File: pkg/__init__.py'),
  },
  {
    name: 'add file into a directory that does not exist',
    files: {},
    patch: P('*** Add File: deep/er/still/a.txt', '+content'),
  },
  {
    name: 'add file over an existing file',
    files: { 'a.txt': 'old\n' },
    patch: P('*** Add File: a.txt', '+new'),
  },
  {
    name: 'add file body line without a plus prefix',
    files: {},
    patch: P('*** Add File: a.txt', 'no plus prefix'),
  },
  {
    name: 'add file with an empty added line',
    files: {},
    patch: P('*** Add File: a.txt', '+one', '+', '+three'),
  },
  {
    name: 'delete a file that does not exist',
    files: {},
    patch: P('*** Delete File: missing.txt'),
  },
  {
    name: 'update a file that does not exist',
    files: {},
    patch: P('*** Update File: missing.txt', '@@', '-x', '+y'),
  },
  {
    name: 'move only, no hunks',
    files: { 'old.txt': 'body\n' },
    patch: P('*** Update File: old.txt', '*** Move to: new.txt'),
  },
  {
    name: 'move with a hunk',
    files: { 'old.txt': 'body\n' },
    patch: P('*** Update File: old.txt', '*** Move to: sub/new.txt', '@@', '-body', '+BODY'),
  },
  {
    name: 'move onto an existing destination',
    files: { 'old.txt': 'body\n', 'new.txt': 'clobbered\n' },
    patch: P('*** Update File: old.txt', '*** Move to: new.txt', '@@', '-body', '+BODY'),
  },
  {
    name: 'move to appearing after a hunk is a body line',
    files: { 'a.txt': 'keep\n' },
    patch: P('*** Update File: a.txt', '@@', ' keep', '*** Move to: b.txt'),
  },
  {
    name: 'context line whose leading space the model dropped',
    files: { 'a.txt': 'one\n\ntwo\n' },
    patch: P('*** Update File: a.txt', '@@', ' one', '', '-two', '+TWO'),
  },
  {
    name: 'context that is not in the file',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt', '@@', '-nowhere', '+x'),
  },
  {
    name: 'anchor that is not in the file',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt', '@@ class Missing', '-one', '+ONE'),
  },
  {
    name: 'consecutive @@ markers with nothing between',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt', '@@ outer', '@@ inner', '-one', '+ONE'),
  },
  {
    name: 'nested @@ markers as the instructions describe them',
    files: {
      'a.py': 'class BaseClass:\n    def method():\n        old\n',
    },
    patch: P(
      '*** Update File: a.py',
      '@@ class BaseClass:',
      '@@     def method():',
      '-        old',
      '+        new',
    ),
  },
  {
    name: 'update with no hunks at all',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt'),
  },
  {
    name: 'trailing @@ with no lines under it',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt', '@@', '-one', '+ONE', '@@ dangling'),
  },
  {
    name: 'body line with no prefix inside a hunk',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt', '@@', 'one'),
  },
  {
    name: 'indented marker inside an update body is content',
    files: { 'a.txt': 'x\n' },
    patch: P('*** Update File: a.txt', '@@', '-x', '+    *** Update File: elsewhere'),
  },
  {
    name: 'missing opener',
    files: { 'a.txt': 'x\n' },
    patch: '*** Delete File: a.txt\n*** End Patch\n',
  },
  {
    name: 'missing terminator',
    files: { 'a.txt': 'x\n' },
    patch: '*** Begin Patch\n*** Delete File: a.txt\n',
  },
  {
    name: 'empty envelope',
    files: {},
    patch: P(),
  },
  {
    name: 'unknown header',
    files: {},
    patch: P('*** Rename File: a.txt'),
  },
  {
    name: 'header with no path',
    files: {},
    patch: P('*** Delete File: '),
  },
  {
    name: 'body line outside any section',
    files: {},
    patch: P('+orphan'),
  },
  {
    name: 'text after End Patch',
    files: { 'a.txt': 'x\n' },
    patch: `${P('*** Delete File: a.txt')}and also\n`,
  },
  {
    name: 'indented envelope',
    files: { 'a.txt': 'x\n' },
    patch: '  *** Begin Patch\n  *** Delete File: a.txt\n  *** End Patch\n',
  },
  {
    name: 'leading newline before the envelope',
    files: { 'a.txt': 'x\n' },
    patch: `\n${P('*** Delete File: a.txt')}`,
  },
  {
    name: 'CRLF envelope',
    files: { 'a.txt': 'x\n' },
    patch: '*** Begin Patch\r\n*** Delete File: a.txt\r\n*** End Patch\r\n',
  },
  {
    name: 'path with spaces',
    files: { 'dir with spaces/a b.txt': 'x\n' },
    patch: P('*** Delete File: dir with spaces/a b.txt'),
  },
  {
    name: 'delete hunk with a stray line under it',
    files: { 'a.txt': 'x\n' },
    patch: P('*** Delete File: a.txt', '+stray'),
  },
  {
    name: 'removal of every line leaves an empty file',
    files: { 'a.txt': 'only\n' },
    patch: P('*** Update File: a.txt', '@@', '-only'),
  },
  {
    name: 'old lines ending in an empty element',
    files: { 'a.txt': 'one\ntwo\n' },
    patch: P('*** Update File: a.txt', '@@', '-one', '-two', '-', '+ONE'),
  },
  {
    name: 'three sections, the third malformed',
    files: { 'a.txt': 'x\n', 'b.txt': 'y\n' },
    patch: P(
      '*** Update File: a.txt',
      '@@',
      '-x',
      '+X',
      '*** Add File: c.txt',
      '+new',
      '*** Update File: b.txt',
      '@@',
      '-nowhere',
      '+z',
    ),
  },
  {
    name: 'tab-indented context',
    files: { 'a.txt': '\tindented\nchange\n' },
    patch: P('*** Update File: a.txt', '@@', ' \tindented', '-change', '+CHANGED'),
  },
  {
    name: 'pattern longer than the file',
    files: { 'a.txt': 'one\n' },
    patch: P('*** Update File: a.txt', '@@', '-one', '-two', '-three', '+X'),
  },
  {
    name: 'indented End Patch after an update hunk',
    files: { 'a.txt': 'x\n' },
    patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n  *** End Patch\n',
  },
  {
    name: 'indented End Patch after an add hunk',
    files: {},
    patch: '*** Begin Patch\n*** Add File: a.txt\n+x\n  *** End Patch\n',
  },
  {
    name: 'indented next header after an update hunk',
    files: { 'a.txt': 'x\n', 'b.txt': 'y\n' },
    patch:
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+X\n  *** Delete File: b.txt\n*** End Patch\n',
  },
  {
    name: 'trailing-space End Patch after an update hunk',
    files: { 'a.txt': 'x\n' },
    patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+y\n*** End Patch \n',
  },
  {
    name: 'blank line between sections',
    files: { 'a.txt': 'x\n', 'b.txt': 'y\n' },
    patch: '*** Begin Patch\n*** Delete File: a.txt\n\n*** Delete File: b.txt\n*** End Patch\n',
  },
  {
    name: 'blank line at the end of an update hunk',
    files: { 'a.txt': 'x\ny\n' },
    patch: P('*** Update File: a.txt', '@@', '-x', '+X', ''),
  },
  {
    name: 'add hunk after an update hunk with no blank line',
    files: { 'a.txt': 'x\n' },
    patch: P('*** Update File: a.txt', '@@', '-x', '+X', '*** Add File: b.txt', '+new'),
  },
  {
    name: 'End of File on a chunk that is not the last',
    files: { 'a.txt': 'one\ntwo\nthree\n' },
    patch: P(
      '*** Update File: a.txt',
      '@@',
      '-three',
      '+THREE',
      '*** End of File',
      '@@',
      '-one',
      '+ONE',
    ),
  },
  {
    name: 'chunks given out of file order',
    files: { 'a.txt': 'one\ntwo\nthree\n' },
    patch: P('*** Update File: a.txt', '@@', '-three', '+THREE', '@@', '-one', '+ONE'),
  },
  {
    name: 'delete then add the same path',
    files: { 'a.txt': 'old\n' },
    patch: P('*** Delete File: a.txt', '*** Add File: a.txt', '+new'),
  },
  {
    name: 'add file whose body contains a line starting with plus plus',
    files: {},
    patch: P('*** Add File: a.txt', '++nested'),
  },
  {
    name: 'update whose added line starts with a marker prefix',
    files: { 'a.txt': 'x\n' },
    patch: P('*** Update File: a.txt', '@@', '-x', '+*** not a marker'),
  },
  {
    name: 'context line that is only a space',
    files: { 'a.txt': 'one\n \ntwo\n' },
    patch: P('*** Update File: a.txt', '@@', ' one', '  ', '-two', '+TWO'),
  },
  {
    name: 'CRLF inside an added line',
    files: { 'a.txt': 'x\n' },
    patch: '*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n-x\r\n+y\r\n*** End Patch\r\n',
  },
  {
    name: 'file whose last line has no newline and is the match target',
    files: { 'a.txt': 'one\ntwo' },
    patch: P('*** Update File: a.txt', '@@', '-two', '+TWO'),
  },
  {
    name: 'empty file updated',
    files: { 'a.txt': '' },
    patch: P('*** Update File: a.txt', '@@', '+added'),
  },
  {
    name: 'an exact match later in the file beats a whitespace-only match earlier',
    files: { 'a.txt': 'target   \nfiller\ntarget\n' },
    patch: P('*** Update File: a.txt', '@@', '-target', '+HIT'),
  },
  {
    name: 'an exact match later beats a case-folded punctuation match earlier',
    files: { 'a.txt': 'say \u201Chi\u201D\nfiller\nsay "hi"\n' },
    patch: P('*** Update File: a.txt', '@@', '-say "hi"', '+HIT'),
  },
  {
    name: 'the first occurrence at or after the previous chunk wins',
    files: { 'a.txt': 'dup\ndup\ndup\n' },
    patch: P('*** Update File: a.txt', '@@', '-dup', '+ONE', '@@', '-dup', '+TWO'),
  },
  {
    name: 'a second chunk cannot match before the first',
    files: { 'a.txt': 'one\ntwo\none\n' },
    patch: P('*** Update File: a.txt', '@@', '-two', '+TWO', '@@', '-one', '+ONE'),
  },
  {
    name: 'an anchor matched loosely still advances the search',
    files: { 'a.txt': 'class A:   \n    x\nclass A:\n    x\n' },
    patch: P('*** Update File: a.txt', '@@ class A:', '-    x', '+    y'),
  },
];

const run = promisify(execFile);

async function tree(root) {
  const out = {};
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[relative(root, path)] = await readFile(path, 'utf8');
    }
  };
  await walk(root);
  return out;
}

async function record(testCase, binary) {
  const root = await mkdtemp(join(tmpdir(), 'codex-oracle-'));
  try {
    for (const [path, content] of Object.entries(testCase.files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    let refused = false;
    let output = '';
    try {
      const { stdout } = await run(binary, [testCase.patch], { cwd: root, encoding: 'utf8' });
      output = stdout;
    } catch (error) {
      refused = true;
      // The reference reports absolute resolved paths; this tool reports the
      // path the model wrote. The text is not compared, only whether it refused.
      output = (error.stderr ?? '').split(root).join('<root>');
    }
    return { ...testCase, refused, output, tree: await tree(root) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--write')) {
  const here = dirname(new URL(import.meta.url).pathname);
  // Codex's multitool dispatches on argv[0]; the standalone applier has no
  // subcommand of its own.
  const binary = join(await mkdtemp(join(tmpdir(), 'codex-argv0-')), 'apply_patch');
  const { stdout: which } = await run('sh', ['-c', 'command -v codex']);
  await run('ln', ['-s', which.trim(), binary]);
  const { stdout: version } = await run(binary, ['--version']).catch(() =>
    run('codex', ['--version']),
  );

  const recorded = [];
  for (const testCase of cases) recorded.push(await record(testCase, binary));
  await writeFile(
    join(here, 'codex-fixtures.json'),
    `${JSON.stringify({ codex: version.trim(), cases: recorded }, undefined, 2)}\n`,
  );
  console.log(`recorded ${recorded.length} cases from ${version.trim()}`);
}
