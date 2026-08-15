// What this tool does over the Harness filesystem seam, as opposed to what the
// port computes.
//
// The hunk semantics are pinned by codex-fixtures.test.mjs against the real
// `codex` binary. What is left, and what is here, is everything the reference
// has no equivalent of: the write guards `ctx.fs` takes, the `fs/observed`
// trail, delete and rename going out through `processPath`, and the refusals a
// confining provider forces.

import { strict as assert } from 'node:assert';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { harness } from './test-harness.mjs';

let mounted;
const run = (input) => mounted.run(input);
const read = (path) => mounted.read(path);
const exists = (path) => mounted.exists(path);
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

afterEach(() => rm(mounted.root, { recursive: true, force: true }));

describe('apply_patch', () => {
  beforeEach(async () => {
    mounted = await harness({ files: { 'app.py': 'def greet():\n    print("Hi")\n' } });
  });

  it('reports what it changed the way Codex reports it', async () => {
    // `print_summary`, verbatim. The summary is part of the contract: it is how
    // the model learns that a rename landed as `M <new path>` rather than as a
    // delete and an add.
    await writeFile(join(mounted.root, 'stale.txt'), 'gone soon\n');
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
    assert.equal(result, 'Success. Updated the following files:\nA a.txt\nM app.py\nD stale.txt');
    assert.equal(await read('a.txt'), 'alpha\n');
    assert.equal(await read('app.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(await exists('stale.txt'), false);
  });

  it('creates the parent directories a new file needs', async () => {
    // Codex creates a missing parent rather than refusing, and a model writing
    // a module into a package it is also creating depends on it.
    await run(patch('*** Add File: pkg/sub/mod.py', '+x = 1'));
    assert.equal(await read('pkg/sub/mod.py'), 'x = 1\n');
  });

  it('guards a create against the absence it observed', async () => {
    await run(patch('*** Add File: fresh.txt', '+x'));
    assert.deepEqual(mounted.intents, ['createIfAbsent']);
  });

  it('guards an update against the version it read', async () => {
    await run(patch('*** Update File: app.py', '@@', '-    print("Hi")', '+    print("Hello")'));
    assert.deepEqual(mounted.intents, ['replaceIfVersion']);
  });

  it('guards an overwriting Add File against the version it read', async () => {
    // Codex has no already-exists refusal on `*** Add File:`; it reads what is
    // there, records it as overwritten, and writes. The file it read is still
    // the file it must not clobber blindly, so the guard is the version rather
    // than an absence that does not hold.
    const result = await run(patch('*** Add File: app.py', '+clobbered'));
    assert.equal(await read('app.py'), 'clobbered\n');
    assert.equal(result, 'Success. Updated the following files:\nA app.py');
    assert.deepEqual(mounted.intents, ['replaceIfVersion']);
  });

  it('deletes a symlink and not what it points at', async () => {
    // The provider's target key is realpath-derived, so removing it would have
    // deleted the pointee and left the link dangling. Codex unlinks the path the
    // patch named.
    await writeFile(join(mounted.root, 'real.py'), 'kept\n');
    await symlink(join(mounted.root, 'real.py'), join(mounted.root, 'link.py'));
    await run(patch('*** Delete File: link.py'));
    assert.equal(await exists('link.py'), false, 'the link itself is gone');
    assert.equal(await read('real.py'), 'kept\n', 'the file it pointed at survives');
  });

  it('renames and patches in one operation', async () => {
    const result = await run(
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
    // `AffectedPaths` records a rename as a modification of its destination.
    assert.equal(result, 'Success. Updated the following files:\nM src/main.py');
    // The source file's version cannot guard a different file, so the
    // destination write is unconditional.
    assert.deepEqual(mounted.intents, ['unconditional']);
  });

  it('overwrites an existing rename destination', async () => {
    // Codex records what was overwritten and proceeds rather than refusing.
    await writeFile(join(mounted.root, 'taken.py'), 'old\n');
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
  });

  it('refuses an envelope that names one path twice', async () => {
    // `try_verify_apply_patch_args` collects the hunks into a map keyed by
    // resolved path and refuses a duplicate key before reading anything
    // (invocation.rs:232). Composing them instead — which the standalone
    // binary does — would give this arm a second edit the model's own Codex
    // would have rejected.
    await assert.rejects(
      run(
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
      ),
      /multiple operations target app\.py/u,
    );
    assert.equal(await read('app.py'), 'def greet():\n    print("Hi")\n');
  });

  it('refuses a rename onto a path the same envelope also edits', async () => {
    // A rename claims its destination as well as its source, so the map has to
    // hold both or two sections could silently write the same file.
    await writeFile(join(mounted.root, 'other.py'), 'x = 1\n');
    await assert.rejects(
      run(
        patch(
          '*** Update File: app.py',
          '*** Move to: other.py',
          '@@',
          '-    print("Hi")',
          '+    print("Hello")',
          '*** Update File: other.py',
          '@@',
          '-x = 1',
          '+x = 2',
        ),
      ),
      /multiple operations target other\.py/u,
    );
    assert.equal(await read('other.py'), 'x = 1\n');
  });

  it('writes nothing when a later section fails to apply', async () => {
    // The map is built over the pre-patch tree, so a hunk the model guessed at
    // fails while nothing has been written yet. The standalone binary, which
    // applies as it goes, would have left `created.txt` behind.
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
      /Failed to find expected lines in app\.py/u,
    );
    assert.equal(await exists('created.txt'), false);
    assert.deepEqual(mounted.intents, [], 'nothing reached the provider');
  });

  it('names the file whose hunk failed', async () => {
    // `Invalid Context 0` alone leaves the model guessing which of several
    // sections to rewrite. Upstream names the resolved absolute path; this
    // names the path the model wrote, which is the string it has to fix.
    await assert.rejects(run(patch('*** Update File: app.py', '@@', '-nope', '+x')), {
      code: 'FS_EDIT_NOT_FOUND',
      message: /^Failed to find expected lines in app\.py:\nnope$/u,
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

  it('refuses to update something that is not a regular file', async () => {
    await assert.rejects(run(patch('*** Update File: .', '@@', '-a', '+b')), {
      code: 'FS_NOT_REGULAR_FILE',
    });
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
      /multiple operations target app\.py/u,
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
    assert.deepEqual(mounted.events, [
      ['fs/observed', 'app.py', 'present'],
      ['fs/observed', 'app.py', 'present'],
    ]);
  });

  it('records a confirmed absence when creating', async () => {
    await run(patch('*** Add File: fresh.txt', '+x'));
    assert.deepEqual(mounted.events, [
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
    assert.deepEqual(mounted.events, [
      ['fs/observed', 'app.py', 'present'],
      ['fs/observed', 'moved.py', 'absent'],
      ['fs/observed', 'moved.py', 'present'],
      ['fs/observed', 'app.py', 'absent'],
    ]);
  });

  it('presents the paths a patch touches', () => {
    assert.deepEqual(mounted.tool.presentCall({ input: patch('*** Delete File: a.py') }), {
      card: 'generic',
      title: 'apply_patch a.py',
      kind: 'edit',
      locations: [{ path: 'a.py' }],
    });
  });

  it('falls back to a bare card when the patch does not parse', () => {
    assert.deepEqual(mounted.tool.presentCall({ input: 'not a patch' }), {
      card: 'generic',
      title: 'apply_patch',
      kind: 'edit',
    });
  });
});

describe('apply_patch under a confining provider', () => {
  beforeEach(async () => {
    mounted = await harness({ files: { 'app.py': 'x = 1\n' }, sandboxMode: 'workspace-write' });
  });

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
