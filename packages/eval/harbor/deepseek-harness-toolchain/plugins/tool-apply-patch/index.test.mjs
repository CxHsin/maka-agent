// The `apply_patch` tool's behaviour, against a real `defineTool` registration
// and a real directory.
//
// The Harness API is not faked: `@deepseek-ai/dsh-tools` and
// `@deepseek-ai/dsh-fs` are the versions the toolchain installs, so a schema
// this build would reject fails here rather than in a benchmark run. Neither is
// the filesystem — `*** Delete File:` and `*** Move to:` go through
// `ctx.fs.processPath` to real syscalls, which an in-memory store could not
// observe. What stands in for `dsh-fs-local` is a thin provider over a
// temporary directory, and every assertion reads that directory back.

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { apply } from './index.mjs';

let root;
let events;
let run;
let intents;

async function harness({ files = {}, sandboxMode = undefined } = {}) {
  root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-'));
  events = [];
  intents = [];
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  // `dsh-fs-local` splits these two: `displayPath` is the lexical
  // `resolve(cwd, path)`, `targetKey` is derived from its realpath. Collapsing
  // them here would hide what a symlink does.
  const target = async (path) => ({
    displayPath: path,
    targetKey: await realpath(path).catch(() => path),
  });
  const version = async (path) => {
    const info = await stat(path).catch(() => undefined);
    return info === undefined ? undefined : `${info.size}:${info.mtimeMs}`;
  };

  const registered = [];
  const ctx = {
    fs: {
      sandboxMode,
      resolve: async (path, options) => {
        assert.equal(options.cwd, root, 'the session cwd must reach the provider');
        return target(isAbsolute(path) ? path : resolve(options.cwd, path));
      },
      lstat: async ({ targetKey }) => stat(targetKey).catch(() => undefined),
      stat: async ({ targetKey }) => {
        const info = await stat(targetKey).catch(() => undefined);
        if (info === undefined) return undefined;
        return {
          type: info.isDirectory() ? 'directory' : 'file',
          version: `${info.size}:${info.mtimeMs}`,
        };
      },
      readText: ({ targetKey }) => readFile(targetKey, 'utf8'),
      writeText: async ({ targetKey }, content, expected) => {
        intents.push(expected === undefined ? 'unconditional' : expected.kind);
        await writeFile(targetKey, content);
        return { version: await version(targetKey) };
      },
      processPath: ({ targetKey }) => targetKey,
      contains: (parent, child) => parent.targetKey === child.targetKey,
    },
    get: () => (sandboxMode === undefined ? undefined : { resolve: () => ({ mode: sandboxMode }) }),
    emit: (event, subject, observation) =>
      events.push([event, rel(subject.displayPath), observation.kind]),
    waterfall: async (_event, _target, _exec, fallback) => fallback(),
    tools: { register: (tool) => registered.push(tool) },
  };
  apply(ctx, {});

  const [tool] = registered;
  const exec = { signal: undefined, agent: { session: { header: { cwd: root } } } };
  run = (input) => tool.execute({ input }, exec);
}

const rel = (absolute) => absolute.slice(root.length + 1);
const read = (path) => readFile(join(root, path), 'utf8');
const exists = (path) =>
  stat(join(root, path)).then(
    () => true,
    () => false,
  );
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('apply_patch', () => {
  beforeEach(() => harness({ files: { 'app.py': 'def greet():\n    print("Hi")\n' } }));
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('creates a file, newline-terminated as Codex writes it', async () => {
    // `contents.push_str(line); contents.push('\n')` per added line, so the last
    // one is terminated too. A file that ends without a newline is a diff
    // artifact the benchmark would charge to the edit contract.
    const result = await run(patch('*** Add File: notes.txt', '+first', '+second'));
    assert.equal(await read('notes.txt'), 'first\nsecond\n');
    assert.match(result, /A notes\.txt/u);
  });

  it('creates the parent directories a new file needs', async () => {
    // Codex creates a missing parent rather than refusing, and a model writing
    // a module into a package it is also creating depends on it.
    await run(patch('*** Add File: pkg/sub/mod.py', '+x = 1'));
    assert.equal(await read('pkg/sub/mod.py'), 'x = 1\n');
  });

  it('overwrites an existing file on Add File, as Codex does', async () => {
    // Codex reads the old contents to report what it replaced and then writes
    // unconditionally; it has no already-exists refusal. Refusing was this
    // tool's own invention and cost the arm every from-scratch rewrite.
    const result = await run(patch('*** Add File: app.py', '+clobbered'));
    assert.equal(await read('app.py'), 'clobbered\n');
    assert.equal(result, 'Applied patch:\nA app.py');
  });

  it('updates a file by context', async () => {
    await run(
      patch(
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(await read('app.py'), 'def greet():\n    print("Hello")\n');
  });

  it('deletes a file', async () => {
    const result = await run(patch('*** Delete File: app.py'));
    assert.equal(await exists('app.py'), false);
    assert.equal(result, 'Applied patch:\nD app.py');
  });

  it('deletes a symlink and not what it points at', async () => {
    // The provider's target key is realpath-derived, so removing it would have
    // deleted the pointee and left the link dangling. Codex unlinks the path the
    // patch named.
    await writeFile(join(root, 'real.py'), 'kept\n');
    await symlink(join(root, 'real.py'), join(root, 'link.py'));
    await run(patch('*** Delete File: link.py'));
    assert.equal(await exists('link.py'), false, 'the link itself is gone');
    assert.equal(await read('real.py'), 'kept\n', 'the file it pointed at survives');
  });

  it('refuses a bare rename, as Codex does', async () => {
    // `ensure_update_hunk_is_not_empty` rejects an update with no chunks before
    // it ever looks at `move_path`, so `*** Move to:` on its own is not a patch
    // upstream either. The model renames with the shell, which all three arms
    // have on equal terms.
    await assert.rejects(run(patch('*** Update File: app.py', '*** Move to: greeter.py')), {
      name: 'SyntaxError',
    });
    assert.equal(await exists('app.py'), true);
  });

  it('renames and patches in one operation', async () => {
    await run(
      patch(
        '*** Update File: app.py',
        '*** Move to: src/main.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(await exists('app.py'), false);
    assert.equal(await read('src/main.py'), 'def greet():\n    print("Hello")\n');
  });

  it('overwrites an existing rename destination', async () => {
    // Codex records what was overwritten and proceeds rather than refusing, so
    // this arm behaves the same way.
    await writeFile(join(root, 'taken.py'), 'old\n');
    await run(
      patch(
        '*** Update File: app.py',
        '*** Move to: taken.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(await read('taken.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(await exists('app.py'), false);
    // The source file's version cannot guard a different file, so the
    // destination write is unconditional.
    assert.deepEqual(intents, ['unconditional']);
  });

  it('applies every operation in one envelope', async () => {
    await writeFile(join(root, 'stale.txt'), 'gone soon\n');
    const result = await run(
      patch(
        '*** Add File: a.txt',
        '+alpha',
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
        '*** Delete File: stale.txt',
      ),
    );
    assert.equal(await read('a.txt'), 'alpha\n');
    assert.equal(await read('app.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(await exists('stale.txt'), false);
    assert.equal(result, 'Applied patch:\nA a.txt\nM app.py\nD stale.txt');
  });

  it('composes two sections that name the same file', async () => {
    // Each operation reads what the previous one wrote, as Codex does. Planning
    // the envelope against one snapshot instead made this fail: the second
    // update was computed against content the first had already replaced.
    await run(
      patch(
        '*** Update File: app.py',
        '@@',
        '-    print("Hi")',
        '+    print("Hello")',
        '*** Update File: app.py',
        '@@',
        '-    print("Hello")',
        '+    print("Hey")',
      ),
    );
    assert.equal(await read('app.py'), 'def greet():\n    print("Hey")\n');
  });

  it('lets a later section recreate a file an earlier one deleted', async () => {
    const result = await run(patch('*** Delete File: app.py', '*** Add File: app.py', '+fresh'));
    assert.equal(await read('app.py'), 'fresh\n');
    assert.equal(result, 'Applied patch:\nD app.py\nA app.py');
  });

  it('keeps the operations that ran before a hunk failed', async () => {
    // Codex writes as it goes, so a later failure does not roll back an earlier
    // operation. The tool does not claim otherwise, and the arm has to fail the
    // way the reference fails.
    await assert.rejects(
      run(
        patch(
          '*** Add File: created.txt',
          '+alpha',
          '*** Update File: app.py',
          '@@',
          '-    print("nothing like this")',
          '+    print("Hello")',
        ),
      ),
      /app\.py: Invalid Context/u,
    );
    assert.equal(await read('created.txt'), 'alpha\n', 'the earlier add did land');
  });

  it('names the file whose hunk failed', async () => {
    // `Invalid Context 0` alone leaves the model guessing which of several
    // sections to rewrite.
    await assert.rejects(run(patch('*** Update File: app.py', '@@', '-nope', '+x')), {
      code: 'FS_IO_ERROR',
      message: /^app\.py: /u,
    });
  });

  it('refuses to update a file that does not exist', async () => {
    await assert.rejects(run(patch('*** Update File: missing.py', '@@', '-a', '+b')), {
      code: 'FS_NOT_FOUND',
    });
  });

  it('refuses to delete a file that does not exist', async () => {
    await assert.rejects(run(patch('*** Delete File: missing.py')), { code: 'FS_NOT_FOUND' });
  });

  it('refuses to move a file onto itself', async () => {
    await assert.rejects(
      run(
        patch(
          '*** Update File: app.py',
          '*** Move to: app.py',
          '@@',
          '-    print("Hi")',
          '+    print("Hello")',
        ),
      ),
      { code: 'FS_IO_ERROR' },
    );
    assert.equal(await exists('app.py'), true);
  });

  it('surfaces a syntax error unchanged', async () => {
    await assert.rejects(run('*** Add File: a.txt\n+x'), { name: 'SyntaxError' });
  });

  it('records what it observed before writing', async () => {
    await run(
      patch(
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.deepEqual(events, [
      ['fs/observed', 'app.py', 'present'],
      ['fs/observed', 'app.py', 'present'],
    ]);
  });

  it('records a confirmed absence when creating', async () => {
    await run(patch('*** Add File: fresh.txt', '+x'));
    assert.deepEqual(events, [
      ['fs/observed', 'fresh.txt', 'absent'],
      ['fs/observed', 'fresh.txt', 'present'],
    ]);
  });

  it('records both ends of a rename', async () => {
    await run(
      patch(
        '*** Update File: app.py',
        '*** Move to: moved.py',
        '@@',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.deepEqual(events, [
      ['fs/observed', 'app.py', 'present'],
      ['fs/observed', 'moved.py', 'absent'],
      ['fs/observed', 'moved.py', 'present'],
      ['fs/observed', 'app.py', 'absent'],
    ]);
  });
});

describe('apply_patch under a confining provider', () => {
  beforeEach(() => harness({ files: { 'app.py': 'x = 1\n' }, sandboxMode: 'workspace-write' }));
  afterEach(() => rm(root, { recursive: true, force: true }));

  // Delete and rename are the two operations `ctx.fs` cannot express, so they
  // reach the filesystem through `processPath`. Under a provider that confines,
  // that path is the way out of the sandbox — so they refuse instead, before
  // anything is written.
  it('refuses to delete', async () => {
    await assert.rejects(run(patch('*** Delete File: app.py')), /Delete File.*unavailable/su);
    assert.equal(await exists('app.py'), true);
  });

  it('refuses to rename', async () => {
    await assert.rejects(
      run(patch('*** Update File: app.py', '*** Move to: b.py', '@@', '-x = 1', '+x = 2')),
      /Move to.*unavailable/su,
    );
    assert.equal(await exists('app.py'), true);
  });

  it('still edits in place', async () => {
    await run(patch('*** Update File: app.py', '@@', '-x = 1', '+x = 2'));
    assert.equal(await read('app.py'), 'x = 2\n');
  });

  it('creates no directory of its own', async () => {
    // `mkdir` on a `processPath` is the same way out of the sandbox that delete
    // and rename refuse for, and it used to run on every write: a create the
    // provider then denied still left its parent directory behind. A provider
    // that confines owns the question of whether the directory may exist.
    await assert.rejects(run(patch('*** Add File: sub/dir/x.txt', '+x')));
    assert.equal(await exists('sub'), false);
  });
});
