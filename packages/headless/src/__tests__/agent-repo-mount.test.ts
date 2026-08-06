import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  buildAgentRepoMounts,
  competitorRepoFiles,
  CONTAINER_MAKA_REPO,
  isOptionalRepoPath,
  makaRepoPaths,
} from '../agent-repo-mount.js';
import { type HarnessAgentId, harnessAgentImportPath } from '../harness-agent-registry.js';

const COMPETITORS: readonly Exclude<HarnessAgentId, 'maka'>[] = [
  'opencode',
  'kimi-code',
  'codex',
  'claude-code',
  'reasonix',
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Renderer-only workspaces never load in the headless container; the rest sit
 * in the CLI's import graph directly or through `@maka/*` symlinks.
 */
const RENDERER_ONLY = new Set(['packages/ui', 'apps/desktop', 'packages/cli']);

/** The workspaces the container is expected to be able to load. */
const MAKA_WORKSPACES = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { workspaces: string[] }
).workspaces.filter((workspace) => !RENDERER_ONLY.has(workspace));

describe('agent repo mounts', () => {
  test('gives Maka its build outputs, not the repo root', () => {
    const mounts = buildAgentRepoMounts('maka', '/repo', { pathExists: () => true }) as Array<{
      source: string;
      target: string;
      read_only: boolean;
    }>;
    assert.ok(
      mounts.every((mount) => mount.target !== CONTAINER_MAKA_REPO),
      'Maka must not receive the repo root',
    );
    assert.deepEqual(
      mounts.map((mount) => mount.target),
      makaRepoPaths().map((repoPath) => `${CONTAINER_MAKA_REPO}/${repoPath}`),
    );
    assert.ok(
      mounts.every((mount) => mount.read_only),
      'Maka must not receive a writable repo path',
    );
  });

  test('every required path Maka declares exists in the repo', () => {
    for (const repoPath of makaRepoPaths()) {
      if (isOptionalRepoPath(repoPath)) continue;
      assert.ok(existsSync(join(REPO_ROOT, repoPath)), `Maka declares missing ${repoPath}`);
    }
  });

  test('declares every workspace dependency tree npm could not hoist away', () => {
    // This is the direction that actually broke: `packages/runtime/node_modules`
    // exists — npm could not hoist `@slack/socket-mode` past a version conflict
    // — and omitting it resolved fine on the host, then failed in the container
    // on the first import that needed it. Nothing but a live container run
    // caught that. The repo already knows the answer, so ask it here.
    const mounted = new Set(makaRepoPaths());
    for (const workspace of MAKA_WORKSPACES) {
      const repoPath = `${workspace}/node_modules`;
      if (!existsSync(join(REPO_ROOT, repoPath))) continue;
      assert.ok(
        mounted.has(repoPath),
        `${workspace} keeps a private ${repoPath} that is not mounted`,
      );
    }
  });

  test('drops a workspace dependency tree npm managed to hoist away', () => {
    // Mounting it blind would have Docker create the directory on the host,
    // inside the repo, as a side effect of starting a graded run.
    const absent = `${CONTAINER_MAKA_REPO}/packages/runtime/node_modules`;
    const mounts = buildAgentRepoMounts('maka', '/repo', {
      pathExists: (path) => !path.endsWith('packages/runtime/node_modules'),
    }) as Array<{ target: string }>;
    assert.ok(!mounts.some((mount) => mount.target === absent));
    assert.ok(mounts.some((mount) => mount.target.endsWith('/packages/runtime/dist')));
  });

  test('keeps sources and evaluation records out of the Maka container', () => {
    // What the #2245 run actually reached through the old repo-root mount: the
    // benchmark's own per-task results under docs/eval, and the verifier source
    // under packages/headless/src. The container executes dist, so neither is
    // needed to run — only to look up what this benchmark expects.
    for (const repoPath of makaRepoPaths()) {
      assert.ok(!repoPath.startsWith('docs'), `Maka must not be handed evaluation records`);
      assert.ok(!/(^|\/)src(\/|$)/.test(repoPath), `Maka must not be handed sources (${repoPath})`);
      assert.ok(!/(^|\/)\.git(\/|$)/.test(repoPath), `Maka must not be handed repo history`);
      assert.notEqual(
        repoPath,
        'packages/headless/harbor/run-harness-ab.mjs',
        'Maka must not be handed the harness manifest source',
      );
    }
  });

  test('mounts the build output of every workspace the container CLI can reach', () => {
    // The declared list is the authority for what exists in the container, and
    // nothing else checks it against the workspaces that actually ship. A new
    // runtime workspace added without an entry here resolves at build time and
    // fails inside the container partway through a graded run.
    const mounted = new Set(makaRepoPaths());
    for (const workspace of MAKA_WORKSPACES) {
      assert.ok(
        mounted.has(`${workspace}/dist`),
        `${workspace} ships but its dist is not mounted for Maka`,
      );
      assert.ok(
        mounted.has(`${workspace}/package.json`),
        `${workspace} ships but its manifest is not mounted for Maka`,
      );
    }
  });

  for (const agent of COMPETITORS) {
    test(`hands ${agent} files, never a directory it can walk`, () => {
      const mounts = buildAgentRepoMounts(agent, '/repo') as Array<{
        source: string;
        target: string;
        read_only: boolean;
      }>;
      // The whole point: no target is the repo root, so there is nothing to
      // enumerate. A directory mount here is how Codex reached the benchmark's
      // pinned revision and retrieved a task's reference solution.
      assert.ok(
        mounts.every((mount) => mount.target !== CONTAINER_MAKA_REPO),
        `${agent} must not receive the repo root`,
      );
      assert.deepEqual(
        mounts.map((mount) => mount.target),
        competitorRepoFiles(agent).map((file) => `${CONTAINER_MAKA_REPO}/${file}`),
      );
      assert.ok(
        mounts.every((mount) => mount.read_only),
        `${agent} must not receive a writable repo path`,
      );
    });

    test(`every file ${agent} declares exists in the repo`, () => {
      // A declared-but-missing path is worse than a missing mount: Docker
      // materialises the target as an empty directory, so the adapter reads a
      // directory where it expected its config and fails inside the container
      // rather than here.
      for (const file of competitorRepoFiles(agent)) {
        assert.ok(existsSync(join(REPO_ROOT, file)), `${agent} declares missing ${file}`);
      }
    });
  }

  test('declares every repo file the adapters read at a container path', () => {
    // Every assertion above derives its expectation from competitorRepoFiles(),
    // so none of them can tell a wrong list from a right one. The adapters are
    // the authority for what is read at a container path, so read them instead:
    // a repo read added there without an entry here mounts nothing, and the arm
    // fails inside the container partway through a graded run.
    const harborDir = join(REPO_ROOT, 'packages/headless/harbor');
    const repoFileByBasename = new Map(
      readdirSync(harborDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const absolute = join(entry.parentPath, entry.name);
          return [entry.name, relative(REPO_ROOT, absolute)] as const;
        }),
    );

    for (const agent of COMPETITORS) {
      const adapterModule = harnessAgentImportPath(agent).split(':')[0];
      const source = readFileSync(join(harborDir, `${adapterModule}.py`), 'utf8');
      const read = new Set<string>();
      for (const [, literal] of source.matchAll(/["']([^"'\n]+)["']/g)) {
        // Adapters name a file either by its absolute container path or by
        // joining MAKA_REPO_ROOT with the path segments, so match both.
        if (literal.startsWith(`${CONTAINER_MAKA_REPO}/`)) {
          read.add(literal.slice(CONTAINER_MAKA_REPO.length + 1));
          continue;
        }
        const repoFile = repoFileByBasename.get(literal);
        if (repoFile) read.add(repoFile);
      }
      for (const repoFile of read) {
        assert.ok(
          competitorRepoFiles(agent).includes(repoFile),
          `${adapterModule}.py reads ${repoFile}, which ${agent} is not mounted`,
        );
      }
    }
  });

  test('keeps the benchmark identity out of every competitor container', () => {
    // run-harness-ab.mjs carries TERMINAL_BENCH_2_1_REVISION and the upstream
    // repository URL; docs/eval carries earlier per-task results. Neither is a
    // file any arm needs, and both convert a graded run into retrieval.
    for (const agent of COMPETITORS) {
      for (const file of competitorRepoFiles(agent)) {
        assert.ok(
          !file.startsWith('docs/'),
          `${agent} must not be handed evaluation records (${file})`,
        );
        assert.notEqual(
          file,
          'packages/headless/harbor/run-harness-ab.mjs',
          `${agent} must not be handed the harness manifest source`,
        );
      }
    }
  });
});
