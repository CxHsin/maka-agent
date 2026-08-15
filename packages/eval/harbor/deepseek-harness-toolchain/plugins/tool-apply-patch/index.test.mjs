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
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
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

  const target = (path) => ({ targetKey: path, displayPath: path });
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
      events.push([event, rel(subject.targetKey), observation.kind]),
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

  it('creates a file', async () => {
    const result = await run(patch('*** Add File: notes.txt', '+first', '+second'));
    assert.equal(await read('notes.txt'), 'first\nsecond');
    assert.match(result, /A notes\.txt/u);
  });

  it('creates the parent directories a new file needs', async () => {
    // Codex creates a missing parent rather than refusing, and a model writing
    // a module into a package it is also creating depends on it.
    await run(patch('*** Add File: pkg/sub/mod.py', '+x = 1'));
    assert.equal(await read('pkg/sub/mod.py'), 'x = 1');
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

  it('renames a file without touching its content', async () => {
    // `*** Move to:` with no hunks is a bare rename; the grammar allows it, and
    // the content must survive untouched.
    const result = await run(patch('*** Update File: app.py', '*** Move to: greeter.py'));
    assert.equal(await exists('app.py'), false);
    assert.equal(await read('greeter.py'), 'def greet():\n    print("Hi")\n');
    assert.equal(result, 'Applied patch:\nR app.py -> greeter.py');
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
    await run(patch('*** Update File: app.py', '*** Move to: taken.py'));
    assert.equal(await read('taken.py'), 'def greet():\n    print("Hi")\n');
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
    assert.equal(await read('a.txt'), 'alpha');
    assert.equal(await read('app.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(await exists('stale.txt'), false);
    assert.equal(result, 'Applied patch:\nA a.txt\nM app.py\nD stale.txt');
  });

  it('changes nothing when a later hunk does not match', async () => {
    // Planning resolves and applies every hunk before the first write, so the
    // usual failure — context the model guessed at — costs nothing.
    await assert.rejects(
      run(
        patch(
          '*** Add File: created.txt',
          '+alpha',
          '*** Delete File: app.py',
          '*** Update File: app.py',
          '@@',
          '-    print("nothing like this")',
          '+    print("Hello")',
        ),
      ),
      /Invalid Context/u,
    );
    assert.equal(await exists('created.txt'), false, 'the earlier add must not have landed');
    assert.equal(await exists('app.py'), true, 'the earlier delete must not have landed');
  });

  it('refuses to add over an existing file', async () => {
    await assert.rejects(run(patch('*** Add File: app.py', '+clobbered')), {
      code: 'FS_ALREADY_EXISTS',
    });
    assert.equal(await read('app.py'), 'def greet():\n    print("Hi")\n');
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
    await assert.rejects(run(patch('*** Update File: app.py', '*** Move to: app.py')), {
      code: 'FS_INVALID_TARGET',
    });
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
    await run(patch('*** Update File: app.py', '*** Move to: moved.py'));
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
  // anything is planned.
  it('refuses to delete', async () => {
    await assert.rejects(run(patch('*** Delete File: app.py')), /Delete File.*unavailable/su);
    assert.equal(await exists('app.py'), true);
  });

  it('refuses to rename', async () => {
    await assert.rejects(
      run(patch('*** Update File: app.py', '*** Move to: b.py')),
      /Move to.*unavailable/su,
    );
    assert.equal(await exists('app.py'), true);
  });

  it('still edits in place', async () => {
    await run(patch('*** Update File: app.py', '@@', '-x = 1', '+x = 2'));
    assert.equal(await read('app.py'), 'x = 2\n');
  });
});
