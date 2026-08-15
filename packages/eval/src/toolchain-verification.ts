import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type ExternalProfile =
  | 'codex'
  | 'claude-code'
  | 'reasonix'
  | 'opencode'
  | 'kimi-code'
  | 'zcode'
  | 'pi'
  | 'deepseek-harness'
  | 'deepseek-harness-fs'
  | 'deepseek-harness-apply-patch';

export interface ToolchainIdentity {
  readonly root: string;
  readonly version: string;
  readonly fingerprint: string;
}

export const TOOLCHAIN_IDENTITY_ENV = 'MAKA_EVAL_VERIFIED_TOOLCHAIN';

// The three DeepSeek Harness arms differ only in the profile they compose, and
// a profile is copied out of this repository rather than installed. So they run
// one toolchain, named once: three copies of a fingerprint would have to be
// updated together, and the failure mode of missing one is an arm silently
// verified against a tree it does not run.
const DEEPSEEK_HARNESS_TOOLCHAIN: ToolchainIdentity = {
  root: '/opt/maka-deepseek-harness-toolchain',
  version: '0.1.0-rc.6',
  fingerprint: 'sha256:9bd17d63bfbbed6a30d61e07d603b4f458c22ab90c041bf844e6a850eca48fa8',
};

// The DeepSeek Harness arms, and the profile directory each one composes. The
// directory is where the edit contract is chosen, and it is the only place the
// arms are allowed to diverge.
//
// One table: the subject builds its profile preparers from it, and the test
// that holds the arms to differing only in their edit contract reads it rather
// than restating it. An arm pointed at the wrong directory would otherwise be
// checked against the composition it was meant to run instead of the one it
// runs. It lives here, beside the identity table, because both are profile
// registration and neither should require loading the launcher to consult.
export const DEEPSEEK_HARNESS_ARMS = {
  'deepseek-harness': 'deepseek-harness-profile',
  'deepseek-harness-fs': 'deepseek-harness-fs-profile',
  'deepseek-harness-apply-patch': 'deepseek-harness-apply-patch-profile',
} as const satisfies Partial<Record<ExternalProfile, string>>;

export const TOOLCHAIN_IDENTITIES: Readonly<Record<ExternalProfile, ToolchainIdentity>> = {
  codex: {
    root: '/opt/maka-codex-toolchain',
    version: '0.144.6',
    fingerprint: 'sha256:ed452d0c13ebd20aaede480a32ec221123619ccee357a33e42b7a1d809eb1b80',
  },
  'claude-code': {
    root: '/opt/maka-claude-code-toolchain',
    version: '2.1.220',
    fingerprint: 'sha256:efa64bb159062d23e49654fa29448d7108e7da1a343eeb0bf06169f21bd9dd2b',
  },
  reasonix: {
    root: '/opt/maka-reasonix-toolchain',
    version: '1.19.4',
    fingerprint: 'sha256:27f2f5b9a05be252547344a557ca9438aca57ecede52590ece9b45a12cb7e9fd',
  },
  opencode: {
    root: '/opt/maka-opencode-toolchain',
    version: '1.17.18',
    fingerprint: 'sha256:60741862d8fe68944ddf55184d8520cd25d5d3480d312f745607a1b147c35c43',
  },
  'kimi-code': {
    root: '/opt/maka-kimi-code-toolchain',
    version: '0.26.0',
    fingerprint: 'sha256:6fba6386f65df4247d116491d9ba464b2aaf040f4c1184db1aa33edd87a216d7',
  },
  zcode: {
    root: '/opt/maka-zcode-toolchain',
    version: '3.7.5/cli-0.16.1',
    fingerprint: 'sha256:e344ee527a482a1984efbed1081365a135a9b66279a5bffdbec632ea00016a8c',
  },
  pi: {
    root: '/opt/maka-pi-toolchain',
    version: '0.84.1',
    fingerprint: 'sha256:995a47ce9e2a5cd38865d22c932775b86484396d61889968310246cf7e82e3ec',
  },
  'deepseek-harness': DEEPSEEK_HARNESS_TOOLCHAIN,
  'deepseek-harness-fs': DEEPSEEK_HARNESS_TOOLCHAIN,
  'deepseek-harness-apply-patch': DEEPSEEK_HARNESS_TOOLCHAIN,
};

// The identity table is the profile registry: a profile without a pinned
// toolchain identity cannot be admitted, so nothing may recognize a name the
// table does not carry.
export function isExternalProfile(value: string | undefined): value is ExternalProfile {
  return value !== undefined && Object.hasOwn(TOOLCHAIN_IDENTITIES, value);
}

export async function verifyToolchainDirectory(
  profile: ExternalProfile,
  root: string,
  // What the tree has to be. The profile only names it; the identity itself is
  // the thing being checked, and a caller that has one already need not go
  // through the table to say so.
  expected: ToolchainIdentity = TOOLCHAIN_IDENTITIES[profile],
): Promise<ToolchainIdentity> {
  const resolvedRoot = resolve(root);
  // The pinned fingerprint is the digest of the checksum manifest, so it is
  // computed here from the manifest on disk rather than read out of the tree.
  // Taking the tree's own `manifest.json` value would only compare the pin
  // against whatever the directory claims to be, which any directory can claim.
  const checksums = await readFile(join(resolvedRoot, 'checksums.sha256'), 'utf8');
  const fingerprint = `sha256:${createHash('sha256').update(checksums).digest('hex')}`;
  if (fingerprint !== expected.fingerprint) {
    throw new Error(`${profile} toolchain fingerprint mismatch`);
  }
  for (const line of checksums.split('\n')) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+(.+)$/u.exec(line);
    if (!match) throw new Error(`${profile} toolchain checksum manifest is invalid`);
    const path = resolve(resolvedRoot, match[2]);
    if (!path.startsWith(`${resolvedRoot}/`)) {
      throw new Error(`${profile} toolchain checksum path escaped`);
    }
    if ((await hashFile(path)) !== match[1]) {
      throw new Error(`${profile} toolchain checksum mismatch`);
    }
  }
  return expected;
}

export function decodePreverifiedToolchain(
  profile: ExternalProfile,
  systemRoot: string,
  executable: string,
): Pick<ToolchainIdentity, 'version' | 'fingerprint'> {
  const expected = TOOLCHAIN_IDENTITIES[profile];
  const expectedRoot = rooted(systemRoot, expected.root);
  if (!resolve(executable).startsWith(`${resolve(expectedRoot)}/`)) {
    return { version: 'test-command', fingerprint: 'unverified-test-command' };
  }
  const raw = process.env[TOOLCHAIN_IDENTITY_ENV];
  delete process.env[TOOLCHAIN_IDENTITY_ENV];
  if (!raw) throw new Error(`${profile} toolchain preflight identity is missing`);
  const value = JSON.parse(raw) as Partial<ToolchainIdentity>;
  if (value.version !== expected.version || value.fingerprint !== expected.fingerprint) {
    throw new Error(`${profile} toolchain preflight identity mismatch`);
  }
  return { version: expected.version, fingerprint: expected.fingerprint };
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolveHash(hash.digest('hex')));
  });
}

function rooted(root: string, absolutePath: string): string {
  return root === '/' ? absolutePath : join(root, absolutePath.replace(/^\//u, ''));
}
