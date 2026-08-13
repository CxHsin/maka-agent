// Build the DeepSeek Harness toolchain that the Eval external subject mounts
// read-only at /opt/maka-deepseek-harness-toolchain.
//
// The harness's minimal composition pulls in two native modules — node-pty for
// the persistent shell, koffi for the filesystem and session backends — and
// node-pty publishes no Linux prebuild. The toolchain therefore cannot be
// installed on a macOS host and mounted into a linux/amd64 task container; it
// is built inside a matching container, which also supplies the pinned Node.
//
// The fingerprint identifies the pinned specification, not the resulting file
// tree, matching how the other arms' toolchains are identified. File-level
// integrity is carried separately by checksums.sha256, which the Eval executor
// verifies before every cohort.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const identityPath = join(repoRoot, 'packages', 'eval', 'src', 'toolchain-verification.ts');

export const DEEPSEEK_HARNESS_TOOLCHAIN_SPEC = {
  schemaVersion: 1,
  platform: 'linux',
  arch: 'x64',
  node: {
    version: '22.23.2',
    // The build image is the interpreter's provenance: its Node is copied into
    // the toolchain rather than downloaded separately.
    image: 'node:22-bookworm',
    imageDigest: 'sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a',
  },
  deepseekHarness: {
    package: '@deepseek-ai/dsh',
    version: '0.1.0-rc.6',
    entrypoint: 'lib/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  },
};

export const DEEPSEEK_HARNESS_TOOLCHAIN_FINGERPRINT = `sha256:${createHash('sha256')
  .update(JSON.stringify(DEEPSEEK_HARNESS_TOOLCHAIN_SPEC))
  .digest('hex')}`;

export async function prepareDeepSeekHarnessToolchain({
  outputRoot,
  write = false,
  run = execFileAsync,
} = {}) {
  if (!outputRoot) throw new Error('--out is required');
  const spec = DEEPSEEK_HARNESS_TOOLCHAIN_SPEC;
  const root = resolve(outputRoot);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'lib', 'dsh'), { recursive: true });

  const image = `${spec.node.image}@${spec.node.imageDigest}`;
  const install = [
    'npm init -y >/dev/null',
    `npm i ${spec.deepseekHarness.package}@${spec.deepseekHarness.version} >/dev/null 2>&1`,
    // Fail the build here rather than at benchmark time if the native module
    // did not compile.
    'node -e "require(\'node-pty\')"',
    'cp "$(command -v node)" /out/bin/node',
    'cp -R package.json node_modules /out/lib/dsh/',
  ].join(' && ');
  await run('docker', [
    'run',
    '--rm',
    '--platform',
    `${spec.platform}/amd64`,
    '-v',
    `${root}:/out`,
    '-w',
    '/build',
    image,
    'sh',
    '-c',
    install,
  ]);

  const entrypoint = join(root, spec.deepseekHarness.entrypoint);
  await requireRegularFile(entrypoint, 'harness entrypoint');
  await requireRegularFile(join(root, 'bin', 'node'), 'pinned Node');
  await requireRegularFile(
    join(root, 'lib', 'dsh', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'),
    'compiled node-pty binding',
  );

  const checksums = await checksumTree(root);
  await writeFile(join(root, 'checksums.sha256'), checksums, { mode: 0o644 });
  await writeFile(
    join(root, 'manifest.json'),
    `${JSON.stringify(
      { schemaVersion: 1, fingerprint: DEEPSEEK_HARNESS_TOOLCHAIN_FINGERPRINT, spec },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );

  if (write) await recordFingerprint();
  return {
    root,
    version: spec.deepseekHarness.version,
    fingerprint: DEEPSEEK_HARNESS_TOOLCHAIN_FINGERPRINT,
  };
}

// Checksums cover every regular file, sorted by toolchain-relative path so the
// digest is stable across builds. manifest.json is written afterwards and is
// therefore not part of its own input.
async function checksumTree(root) {
  const files = [];
  await collect(root, files);
  files.sort();
  const lines = [];
  for (const path of files) lines.push(`${await hashFile(path)}  ${relative(root, path)}`);
  return `${lines.join('\n')}\n`;
}

async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function requireRegularFile(path, label) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`${label} is missing at ${path}`);
}

async function recordFingerprint() {
  const source = await readFile(identityPath, 'utf8');
  const pattern =
    /('deepseek-harness': \{\n\s*root: '[^']+',\n\s*version: ')([^']+)(',\n\s*fingerprint: ')([^']+)(')/u;
  if (!pattern.test(source)) throw new Error('deepseek-harness toolchain identity was not found');
  const next = source.replace(
    pattern,
    `$1${DEEPSEEK_HARNESS_TOOLCHAIN_SPEC.deepseekHarness.version}$3${DEEPSEEK_HARNESS_TOOLCHAIN_FINGERPRINT}$5`,
  );
  await writeFile(identityPath, next, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const result = await prepareDeepSeekHarnessToolchain({
    outputRoot: outIndex >= 0 ? argv[outIndex + 1] : undefined,
    write: argv.includes('--write'),
  });
  console.log(`${result.root}\n${result.fingerprint}`);
}
