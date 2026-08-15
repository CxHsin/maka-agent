// The `apply_patch` tool's behaviour, against a real `defineTool` registration
// and an in-memory `ctx.fs`.
//
// The provider is faked, not the Harness API: `@deepseek-ai/dsh-tools` and
// `@deepseek-ai/dsh-fs` are the versions the toolchain installs, so a schema
// this build would reject fails here rather than in a benchmark run. What the
// fake supplies is the file store, which is what the assertions are about.

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { apply } from './index.mjs';

const CWD = '/workspace';

function harness({ files = {} } = {}) {
  const store = new Map(Object.entries(files));
  const events = [];
  let version = 0;
  const target = (path) => ({ targetKey: path, displayPath: path });

  const ctx = {
    fs: {
      sandboxMode: undefined,
      resolve: async (path, options) => {
        assert.equal(options.cwd, CWD, 'the session cwd must reach the provider');
        return target(path.startsWith('/') ? path : `${CWD}/${path}`);
      },
      stat: async ({ targetKey }) =>
        store.has(targetKey)
          ? { type: 'file', version: `v${store.get(targetKey).length}` }
          : undefined,
      readText: async ({ targetKey }) => store.get(targetKey),
      writeText: async ({ targetKey }, content) => {
        store.set(targetKey, content);
        version += 1;
        return { version: `w${version}` };
      },
    },
    get: () => undefined,
    emit: (event, targetArg, observation) =>
      events.push([event, targetArg.targetKey, observation.kind]),
    waterfall: async (_event, _target, _exec, fallback) => fallback(),
    tools: { register: (tool) => ctx.tools.registered.push(tool) },
  };
  ctx.tools.registered = [];
  apply(ctx, {});

  const [tool] = ctx.tools.registered;
  const exec = { signal: undefined, agent: { session: { header: { cwd: CWD } } } };
  return {
    store,
    events,
    run: (input) => tool.execute({ input }, exec),
  };
}

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('apply_patch', () => {
  let h;
  beforeEach(() => {
    h = harness({ files: { '/workspace/app.py': 'def greet():\n    print("Hi")\n' } });
  });

  it('creates a file', async () => {
    const result = await h.run(patch('*** Add File: notes.txt', '+first', '+second'));
    assert.equal(h.store.get('/workspace/notes.txt'), 'first\nsecond');
    assert.match(result, /A notes\.txt/u);
  });

  it('updates a file by context', async () => {
    await h.run(
      patch(
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(h.store.get('/workspace/app.py'), 'def greet():\n    print("Hello")\n');
  });

  it('applies every operation in one envelope', async () => {
    const result = await h.run(
      patch(
        '*** Add File: a.txt',
        '+alpha',
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.equal(h.store.get('/workspace/a.txt'), 'alpha');
    assert.equal(h.store.get('/workspace/app.py'), 'def greet():\n    print("Hello")\n');
    assert.equal(result, 'Applied patch:\nA a.txt\nM app.py');
  });

  it('writes nothing when a later hunk does not match', async () => {
    // The deliberate deviation from Codex, and the reason this arm can be
    // compared with the single-file contracts: one call is one outcome.
    await assert.rejects(
      h.run(
        patch(
          '*** Add File: created.txt',
          '+alpha',
          '*** Update File: app.py',
          '@@',
          '-    print("nothing like this")',
          '+    print("Hello")',
        ),
      ),
      /Invalid Context/u,
    );
    assert.equal(
      h.store.has('/workspace/created.txt'),
      false,
      'the earlier add must not have landed',
    );
    assert.equal(h.store.get('/workspace/app.py'), 'def greet():\n    print("Hi")\n');
  });

  it('refuses to add over an existing file', async () => {
    await assert.rejects(h.run(patch('*** Add File: app.py', '+clobbered')), {
      code: 'FS_ALREADY_EXISTS',
    });
    assert.equal(h.store.get('/workspace/app.py'), 'def greet():\n    print("Hi")\n');
  });

  it('refuses to update a file that does not exist', async () => {
    await assert.rejects(h.run(patch('*** Update File: missing.py', '@@', '-a', '+b')), {
      code: 'FS_NOT_FOUND',
    });
  });

  it('refuses a delete with a pointer to the shell', async () => {
    await assert.rejects(
      h.run(patch('*** Delete File: app.py')),
      /not supported by this tool.*shell/su,
    );
    assert.equal(h.store.has('/workspace/app.py'), true);
  });

  it('refuses a rename with a pointer to the shell', async () => {
    await assert.rejects(
      h.run(patch('*** Update File: app.py', '*** Move to: other.py')),
      /Move to.*not supported by this tool.*shell/su,
    );
  });

  it('surfaces a syntax error unchanged', async () => {
    await assert.rejects(h.run('*** Add File: a.txt\n+x'), { name: 'SyntaxError' });
  });

  it('records what it observed before writing', async () => {
    await h.run(
      patch(
        '*** Update File: app.py',
        '@@ def greet():',
        '-    print("Hi")',
        '+    print("Hello")',
      ),
    );
    assert.deepEqual(h.events, [
      ['fs/observed', '/workspace/app.py', 'present'],
      ['fs/observed', '/workspace/app.py', 'present'],
    ]);
  });

  it('records a confirmed absence when creating', async () => {
    await h.run(patch('*** Add File: fresh.txt', '+x'));
    assert.deepEqual(h.events, [
      ['fs/observed', '/workspace/fresh.txt', 'absent'],
      ['fs/observed', '/workspace/fresh.txt', 'present'],
    ]);
  });
});
