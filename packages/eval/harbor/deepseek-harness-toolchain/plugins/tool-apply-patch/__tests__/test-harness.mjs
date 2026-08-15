// A registered `apply_patch` over a real temporary directory.
//
// The Harness API is not faked: `@deepseek-ai/dsh-tools` and
// `@deepseek-ai/dsh-fs` are the versions the toolchain installs, so a schema
// this build would reject fails in a test rather than in a benchmark run.
// Neither is the filesystem — `*** Delete File:` and `*** Move to:` go through
// `ctx.fs.processPath` to real syscalls, which an in-memory store could not
// observe. What stands in for `dsh-fs-local` is a thin provider over a
// temporary directory, and every assertion reads that directory back.
//
// Not a `.test.mjs` file, so `node --test` does not pick it up.

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FsError } from '@deepseek-ai/dsh-fs';
import { apply } from '../index.mjs';

/**
 * Mount `apply_patch` over a fresh temporary directory seeded with `files`.
 *
 * @param {{files?: Record<string, string>, sandboxMode?: string}} options
 * @returns {Promise<{
 *   root: string,
 *   run: (input: string) => Promise<string>,
 *   events: Array<[string, string, string]>,
 *   intents: string[],
 *   read: (path: string) => Promise<string>,
 *   exists: (path: string) => Promise<boolean>,
 *   tree: () => Promise<Record<string, string>>,
 * }>}
 */
export async function harness({ files = {}, sandboxMode } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-apply-patch-'));
  const events = [];
  const intents = [];
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
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
      stat: async ({ targetKey }) => {
        const info = await stat(targetKey).catch(() => undefined);
        if (info === undefined) return undefined;
        return {
          type: info.isDirectory() ? 'directory' : 'file',
          version: `${info.size}:${info.mtimeMs}`,
        };
      },
      readText: ({ targetKey }) => readFile(targetKey, 'utf8'),
      // The write guards `dsh-fs-local` enforces, enforced here too. A fake that
      // records the guard and writes anyway would pass whatever guard this tool
      // passed it, including none.
      writeText: async ({ targetKey }, content, expected) => {
        intents.push(expected === undefined ? 'unconditional' : expected.kind);
        const current = await version(targetKey);
        if (expected?.kind === 'createIfAbsent' && current !== undefined) {
          throw new FsError(`${targetKey} already exists`, 'FS_NOT_OBSERVED');
        }
        if (expected?.kind === 'replaceIfVersion' && current !== expected.version) {
          throw new FsError(`${targetKey} changed since it was read`, 'FS_STALE_VERSION');
        }
        // `dsh-fs-local` creates the parent, in `writeFileAtomic`. Leaving that
        // out here made the tool carry an `ensureParent` of its own that no
        // mounted provider needed — a fake weaker than the real thing does not
        // just fail to catch bugs, it invents code.
        await mkdir(dirname(targetKey), { recursive: true });
        await writeFile(targetKey, content);
        return { version: await version(targetKey) };
      },
      processPath: ({ targetKey }) => targetKey,
    },
    get: () => (sandboxMode === undefined ? undefined : { resolve: () => ({ mode: sandboxMode }) }),
    emit: (event, subject, observation) =>
      events.push([event, subject.displayPath.slice(root.length + 1), observation.kind]),
    waterfall: async (_event, _target, _exec, fallback) => fallback(),
    tools: { register: (tool) => registered.push(tool) },
  };
  apply(ctx, {});

  const [tool] = registered;
  const exec = { signal: undefined, agent: { session: { header: { cwd: root } } } };
  const walk = async (dir, out) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, out);
      else out[relative(root, path)] = await readFile(path, 'utf8');
    }
    return out;
  };

  return {
    root,
    events,
    intents,
    tool,
    run: (input) => tool.execute({ input }, exec),
    read: (path) => readFile(join(root, path), 'utf8'),
    exists: (path) =>
      stat(join(root, path)).then(
        () => true,
        () => false,
      ),
    tree: () => walk(root, {}),
  };
}
