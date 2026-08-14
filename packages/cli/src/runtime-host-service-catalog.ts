import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import { withProcessFileLock } from '@maka/storage/file-update-lock';

export const RUNTIME_HOST_SERVICE_CATALOG_SCHEMA_VERSION = 1 as const;
export const RUNTIME_HOST_SERVICE_CONFIG_SCHEMA_VERSION = 1 as const;

const CATALOG_DIRECTORY = 'runtime-host-services';
const CATALOG_FILE = 'catalog.json';
const CATALOG_MAX_BYTES = 256 * 1024;
const CONFIG_COUNT_MAX = 64;
const CONFIG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const CONFIG_REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const START_ATTEMPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const START_ATTEMPT_MAX_BYTES = 1_024;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export type ManagedRuntimeHostTransport =
  | {
      readonly kind: 'ssh';
      readonly bindHost: '127.0.0.1' | '::1';
      readonly port: number;
      readonly path: string;
      readonly sshDestination: string;
      readonly sshPort?: number;
    }
  | {
      readonly kind: 'tls';
      readonly bindHost: string;
      readonly port: number;
      readonly path: string;
      readonly publicHost: string;
      readonly certificatePath: string;
      readonly privateKeyPath: string;
      readonly allowedOrigins: readonly string[];
    }
  | {
      readonly kind: 'plaintext';
      readonly bindHost: string;
      readonly port: number;
      readonly path: string;
      readonly publicHost: string;
      readonly allowedOrigins: readonly string[];
      readonly acknowledgement: 'plaintext-bearer-v1';
    };

export interface ManagedRuntimeHostServiceConfig {
  readonly schemaVersion: typeof RUNTIME_HOST_SERVICE_CONFIG_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly expectedRootId: string;
  readonly transport: ManagedRuntimeHostTransport;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeHostServiceCatalogDocument {
  readonly schemaVersion: typeof RUNTIME_HOST_SERVICE_CATALOG_SCHEMA_VERSION;
  readonly configs: readonly ManagedRuntimeHostServiceConfig[];
}

export interface RuntimeHostServiceStartAttempt {
  readonly schemaVersion: 1;
  readonly configId: string;
  readonly configRevision: `sha256:${string}`;
  readonly attemptId: string;
  readonly expiresAt: string;
}

export interface RuntimeHostServiceCatalog {
  readonly path: string;
  read(): Promise<RuntimeHostServiceCatalogDocument>;
  create(config: ManagedRuntimeHostServiceConfig): Promise<RuntimeHostServiceCatalogDocument>;
  save(
    config: ManagedRuntimeHostServiceConfig,
    expectedRevision: `sha256:${string}`,
  ): Promise<RuntimeHostServiceCatalogDocument>;
  remove(
    configId: string,
    expectedRevision: `sha256:${string}`,
  ): Promise<RuntimeHostServiceCatalogDocument>;
}

export type RuntimeHostServiceConfigConflict =
  | {
      readonly kind: 'root';
      readonly leftConfigId: string;
      readonly rightConfigId: string;
      readonly expectedRootId: string;
    }
  | {
      readonly kind: 'listener';
      readonly leftConfigId: string;
      readonly rightConfigId: string;
      readonly port: number;
    };

export function createRuntimeHostServiceCatalog(clientDataRoot: string): RuntimeHostServiceCatalog {
  if (!isAbsolute(clientDataRoot)) throw new Error('Maka client data root must be absolute');
  return new FileRuntimeHostServiceCatalog(join(clientDataRoot, CATALOG_DIRECTORY));
}

export async function withRuntimeHostServiceConfigOperation<T>(
  clientDataRoot: string,
  configId: string,
  operation: () => Promise<T>,
): Promise<T> {
  if (!isAbsolute(clientDataRoot)) throw new Error('Maka client data root must be absolute');
  const id = requireConfigId(configId);
  const directory = join(clientDataRoot, CATALOG_DIRECTORY, 'locks');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  return withProcessFileLock(join(directory, `${id}.lock`), operation);
}

export async function publishRuntimeHostServiceStartAttempt(
  clientDataRoot: string,
  configId: string,
  configRevision: `sha256:${string}`,
  expiresAt: string,
): Promise<RuntimeHostServiceStartAttempt> {
  const attempt = decodeRuntimeHostServiceStartAttempt({
    schemaVersion: 1,
    configId,
    configRevision,
    attemptId: randomUUID(),
    expiresAt,
  });
  const path = runtimeHostServiceStartAttemptPath(clientDataRoot, attempt.configId);
  await publishPrivateJson(path, attempt);
  return attempt;
}

export async function readRuntimeHostServiceStartAttempt(
  clientDataRoot: string,
  configId: string,
): Promise<RuntimeHostServiceStartAttempt | undefined> {
  const id = requireConfigId(configId);
  const path = runtimeHostServiceStartAttemptPath(clientDataRoot, id);
  let bytes: Buffer;
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > START_ATTEMPT_MAX_BYTES) {
      throw new Error('Runtime Host service start attempt must be a bounded regular file');
    }
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const attempt = decodeRuntimeHostServiceStartAttempt(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
  );
  if (attempt.configId !== id) {
    throw new Error('Runtime Host service start attempt does not match its config path');
  }
  return attempt;
}

export async function clearRuntimeHostServiceStartAttempt(
  clientDataRoot: string,
  configId: string,
  expected: {
    readonly attemptId?: string;
    readonly configRevision?: `sha256:${string}`;
  } = {},
): Promise<void> {
  const current = await readRuntimeHostServiceStartAttempt(clientDataRoot, configId);
  if (
    !current ||
    (expected.attemptId !== undefined && current.attemptId !== expected.attemptId) ||
    (expected.configRevision !== undefined &&
      current.configRevision !== requireRuntimeHostServiceConfigRevision(expected.configRevision))
  ) {
    return;
  }
  const path = runtimeHostServiceStartAttemptPath(clientDataRoot, current.configId);
  await unlink(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  await syncDirectory(join(clientDataRoot, CATALOG_DIRECTORY, 'locks'));
}

export function createManagedRuntimeHostServiceConfig(input: {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly expectedRootId: string;
  readonly transport: ManagedRuntimeHostTransport;
  readonly now?: Date;
}): ManagedRuntimeHostServiceConfig {
  const timestamp = (input.now ?? new Date()).toISOString();
  return decodeManagedRuntimeHostServiceConfig({
    schemaVersion: RUNTIME_HOST_SERVICE_CONFIG_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    rootPath: input.rootPath,
    expectedRootId: input.expectedRootId,
    transport: input.transport,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function updateManagedRuntimeHostServiceConfig(
  current: ManagedRuntimeHostServiceConfig,
  input: { readonly name?: string; readonly transport?: ManagedRuntimeHostTransport; now?: Date },
): ManagedRuntimeHostServiceConfig {
  return decodeManagedRuntimeHostServiceConfig({
    ...current,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    updatedAt: (input.now ?? new Date()).toISOString(),
  });
}

export function runtimeHostServiceConfigRevision(
  config: ManagedRuntimeHostServiceConfig,
): `sha256:${string}` {
  const canonical = JSON.stringify([
    config.schemaVersion,
    config.id,
    config.name,
    config.rootPath,
    config.expectedRootId,
    config.transport,
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function runtimeHostServiceClientTransport(config: ManagedRuntimeHostServiceConfig):
  | { readonly kind: 'tls'; readonly url: string }
  | {
      readonly kind: 'plaintext';
      readonly url: string;
      readonly acknowledgement: 'plaintext-bearer-v1';
    }
  | {
      readonly kind: 'ssh';
      readonly destination: string;
      readonly sshPort?: number;
      readonly remotePort: number;
      readonly websocketPath: string;
    } {
  const transport = config.transport;
  if (transport.kind === 'ssh') {
    return {
      kind: 'ssh',
      destination: transport.sshDestination,
      ...(transport.sshPort === undefined ? {} : { sshPort: transport.sshPort }),
      remotePort: transport.port,
      websocketPath: transport.path,
    };
  }
  const hostname = formatUrlHostname(transport.publicHost);
  const url = `${transport.kind === 'tls' ? 'wss' : 'ws'}://${hostname}:${transport.port}${transport.path}`;
  return transport.kind === 'tls'
    ? { kind: 'tls', url }
    : { kind: 'plaintext', url, acknowledgement: transport.acknowledgement };
}

export function findRuntimeHostServiceConfigConflicts(
  configs: readonly ManagedRuntimeHostServiceConfig[],
): RuntimeHostServiceConfigConflict[] {
  const conflicts: RuntimeHostServiceConfigConflict[] = [];
  for (let leftIndex = 0; leftIndex < configs.length; leftIndex += 1) {
    const left = configs[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < configs.length; rightIndex += 1) {
      const right = configs[rightIndex]!;
      if (left.expectedRootId === right.expectedRootId || left.rootPath === right.rootPath) {
        conflicts.push({
          kind: 'root',
          leftConfigId: left.id,
          rightConfigId: right.id,
          expectedRootId: left.expectedRootId,
        });
      }
      if (
        left.transport.port === right.transport.port &&
        listenerHostsConflict(left.transport.bindHost, right.transport.bindHost)
      ) {
        conflicts.push({
          kind: 'listener',
          leftConfigId: left.id,
          rightConfigId: right.id,
          port: left.transport.port,
        });
      }
    }
  }
  return conflicts;
}

export function decodeRuntimeHostServiceCatalogDocument(
  value: unknown,
): RuntimeHostServiceCatalogDocument {
  const record = requireExactRecord(value, 'Runtime Host service catalog', [
    'schemaVersion',
    'configs',
  ]);
  if (record.schemaVersion !== RUNTIME_HOST_SERVICE_CATALOG_SCHEMA_VERSION) {
    throw new Error('Runtime Host service catalog has an unsupported schema');
  }
  if (!Array.isArray(record.configs) || record.configs.length > CONFIG_COUNT_MAX) {
    throw new Error('Runtime Host service catalog has an invalid config list');
  }
  const configs = record.configs.map(decodeManagedRuntimeHostServiceConfig);
  if (new Set(configs.map((config) => config.id)).size !== configs.length) {
    throw new Error('Runtime Host service catalog contains duplicate config ids');
  }
  const conflicts = findRuntimeHostServiceConfigConflicts(configs);
  if (conflicts.some((conflict) => conflict.kind === 'root')) {
    throw new Error('Runtime Host service catalog assigns one State Root to multiple configs');
  }
  if (conflicts.some((conflict) => conflict.kind === 'listener')) {
    throw new Error('Runtime Host service catalog assigns conflicting listeners');
  }
  return Object.freeze({
    schemaVersion: RUNTIME_HOST_SERVICE_CATALOG_SCHEMA_VERSION,
    configs: Object.freeze(configs),
  });
}

export function decodeManagedRuntimeHostServiceConfig(
  value: unknown,
): ManagedRuntimeHostServiceConfig {
  const record = requireExactRecord(value, 'Runtime Host service config', [
    'schemaVersion',
    'id',
    'name',
    'rootPath',
    'expectedRootId',
    'transport',
    'createdAt',
    'updatedAt',
  ]);
  if (record.schemaVersion !== RUNTIME_HOST_SERVICE_CONFIG_SCHEMA_VERSION) {
    throw new Error('Runtime Host service config has an unsupported schema');
  }
  const id = requireString(record.id, 'Runtime Host service config id', 64);
  if (!CONFIG_ID_PATTERN.test(id)) throw new Error('Runtime Host service config id is invalid');
  const name = requireString(record.name, 'Runtime Host service config name', 128).trim();
  if (name.length === 0 || UNSAFE_DISPLAY_CHARACTER_PATTERN.test(name)) {
    throw new Error('Runtime Host service config name is invalid');
  }
  const rootPath = requireAbsolutePath(record.rootPath, 'Runtime Host State Root');
  const expectedRootId = requireString(record.expectedRootId, 'Runtime Host root id', 64);
  if (!ROOT_ID_PATTERN.test(expectedRootId)) throw new Error('Runtime Host root id is invalid');
  const createdAt = requireTimestamp(record.createdAt, 'Runtime Host service creation time');
  const updatedAt = requireTimestamp(record.updatedAt, 'Runtime Host service update time');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('Runtime Host service update time precedes its creation time');
  }
  return Object.freeze({
    schemaVersion: RUNTIME_HOST_SERVICE_CONFIG_SCHEMA_VERSION,
    id,
    name,
    rootPath,
    expectedRootId,
    transport: decodeTransport(record.transport),
    createdAt,
    updatedAt,
  });
}

export function requireRuntimeHostServiceConfigRevision(value: unknown): `sha256:${string}` {
  const revision = requireString(value, 'Runtime Host service config revision', 71);
  if (!CONFIG_REVISION_PATTERN.test(revision)) {
    throw new Error('Runtime Host service config revision is invalid');
  }
  return revision as `sha256:${string}`;
}

class FileRuntimeHostServiceCatalog implements RuntimeHostServiceCatalog {
  readonly path: string;
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
    this.path = join(directory, CATALOG_FILE);
  }

  async read(): Promise<RuntimeHostServiceCatalogDocument> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCatalog();
      throw error;
    }
    if (bytes.byteLength > CATALOG_MAX_BYTES) {
      throw new Error('Runtime Host service catalog exceeds its size limit');
    }
    try {
      return decodeRuntimeHostServiceCatalogDocument(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown,
      );
    } catch (error) {
      throw new Error('Runtime Host service catalog is invalid', { cause: error });
    }
  }

  create(config: ManagedRuntimeHostServiceConfig): Promise<RuntimeHostServiceCatalogDocument> {
    return this.#mutate(config, true);
  }

  save(
    config: ManagedRuntimeHostServiceConfig,
    expectedRevision: `sha256:${string}`,
  ): Promise<RuntimeHostServiceCatalogDocument> {
    return this.#mutate(config, false, expectedRevision);
  }

  remove(
    configId: string,
    expectedRevision: `sha256:${string}`,
  ): Promise<RuntimeHostServiceCatalogDocument> {
    const id = requireConfigId(configId);
    const expected = requireRuntimeHostServiceConfigRevision(expectedRevision);
    return this.#mutateLocked(async () => {
      const current = await this.read();
      const previous = current.configs.find((config) => config.id === id);
      if (!previous || runtimeHostServiceConfigRevision(previous) !== expected) {
        throw new Error('Runtime Host service config changed before it could be removed');
      }
      const next = decodeRuntimeHostServiceCatalogDocument({
        ...current,
        configs: current.configs.filter((config) => config.id !== id),
      });
      await this.#write(next);
      return next;
    });
  }

  #mutate(
    value: ManagedRuntimeHostServiceConfig,
    requireNew: boolean,
    expectedRevision?: `sha256:${string}`,
  ): Promise<RuntimeHostServiceCatalogDocument> {
    const config = decodeManagedRuntimeHostServiceConfig(value);
    const expected =
      expectedRevision === undefined
        ? undefined
        : requireRuntimeHostServiceConfigRevision(expectedRevision);
    return this.#mutateLocked(async () => {
      const current = await this.read();
      const previous = current.configs.find((candidate) => candidate.id === config.id);
      if (requireNew && previous) {
        throw new Error('A new Runtime Host service config must use a new id');
      }
      if (!requireNew && !previous) {
        throw new Error('Runtime Host service config changed before it could be saved');
      }
      if (previous) {
        if (!requireNew && runtimeHostServiceConfigRevision(previous) !== expected) {
          throw new Error('Runtime Host service config changed before it could be saved');
        }
        if (
          previous.expectedRootId !== config.expectedRootId ||
          previous.rootPath !== config.rootPath
        ) {
          throw new Error('A Runtime Host service config cannot change its State Root');
        }
        if (previous.createdAt !== config.createdAt) {
          throw new Error('A Runtime Host service config cannot change its creation time');
        }
      }
      const configs = previous
        ? current.configs.map((candidate) => (candidate.id === config.id ? config : candidate))
        : [...current.configs, config];
      const next = decodeRuntimeHostServiceCatalogDocument({ ...current, configs });
      await this.#write(next);
      return next;
    });
  }

  async #write(document: RuntimeHostServiceCatalogDocument): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    if (bytes.byteLength > CATALOG_MAX_BYTES) {
      throw new Error('Runtime Host service catalog exceeds its size limit');
    }
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.#directory, 0o700);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== 'win32') await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await syncDirectory(this.#directory);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #mutateLocked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.#directory, 0o700);
    return withProcessFileLock(`${this.path}.update.lock`, operation);
  }
}

function emptyCatalog(): RuntimeHostServiceCatalogDocument {
  return Object.freeze({
    schemaVersion: RUNTIME_HOST_SERVICE_CATALOG_SCHEMA_VERSION,
    configs: Object.freeze([]),
  });
}

function decodeTransport(value: unknown): ManagedRuntimeHostTransport {
  const record = requireRecord(value, 'Runtime Host service transport');
  if (record.kind === 'ssh') {
    const exact = requireExactRecord(record, 'SSH Runtime Host service transport', [
      'kind',
      'bindHost',
      'port',
      'path',
      ...(record.sshPort === undefined ? [] : ['sshPort']),
      'sshDestination',
    ]);
    if (exact.bindHost !== '127.0.0.1' && exact.bindHost !== '::1') {
      throw new Error('SSH Runtime Host listeners must bind to loopback');
    }
    return Object.freeze({
      kind: 'ssh',
      bindHost: exact.bindHost,
      port: requirePort(exact.port, 'Runtime Host listener port'),
      path: requireWebSocketPath(exact.path),
      sshDestination: requireSshDestination(exact.sshDestination),
      ...(exact.sshPort === undefined ? {} : { sshPort: requirePort(exact.sshPort, 'SSH port') }),
    });
  }
  if (record.kind === 'tls') {
    const exact = requireExactRecord(record, 'TLS Runtime Host service transport', [
      'kind',
      'bindHost',
      'port',
      'path',
      'publicHost',
      'certificatePath',
      'privateKeyPath',
      'allowedOrigins',
    ]);
    return Object.freeze({
      kind: 'tls',
      bindHost: requireHost(exact.bindHost, 'Runtime Host listener host'),
      port: requirePort(exact.port, 'Runtime Host listener port'),
      path: requireWebSocketPath(exact.path),
      publicHost: requirePublicHost(exact.publicHost),
      certificatePath: requireAbsolutePath(exact.certificatePath, 'TLS certificate path'),
      privateKeyPath: requireAbsolutePath(exact.privateKeyPath, 'TLS private key path'),
      allowedOrigins: requireAllowedOrigins(exact.allowedOrigins),
    });
  }
  if (record.kind === 'plaintext') {
    const exact = requireExactRecord(record, 'plaintext Runtime Host service transport', [
      'kind',
      'bindHost',
      'port',
      'path',
      'publicHost',
      'allowedOrigins',
      'acknowledgement',
    ]);
    if (exact.acknowledgement !== 'plaintext-bearer-v1') {
      throw new Error('Plaintext Runtime Host service transport lacks its risk acknowledgement');
    }
    return Object.freeze({
      kind: 'plaintext',
      bindHost: requireHost(exact.bindHost, 'Runtime Host listener host'),
      port: requirePort(exact.port, 'Runtime Host listener port'),
      path: requireWebSocketPath(exact.path),
      publicHost: requirePublicHost(exact.publicHost),
      allowedOrigins: requireAllowedOrigins(exact.allowedOrigins),
      acknowledgement: exact.acknowledgement,
    });
  }
  throw new Error('Runtime Host service transport kind is invalid');
}

function listenerHostsConflict(left: string, right: string): boolean {
  const normalizedLeft = normalizeHost(left);
  const normalizedRight = normalizeHost(right);
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft === '::' || normalizedRight === '::') return true;
  if (normalizedLeft === '0.0.0.0') return isIpv4Host(normalizedRight);
  if (normalizedRight === '0.0.0.0') return isIpv4Host(normalizedLeft);
  return false;
}

function normalizeHost(host: string): string {
  const bare =
    host.startsWith('[') && host.endsWith(']')
      ? host.slice(1, -1).toLowerCase()
      : host.toLowerCase();
  const family = isIP(bare);
  if (family === 0) return bare;
  const hostname = new URL(`http://${family === 6 ? `[${bare}]` : bare}`).hostname;
  return family === 6 ? hostname.slice(1, -1) : hostname;
}

function isIpv4Host(host: string): boolean {
  return host !== '::' && host !== '::1' && !host.includes(':');
}

function formatUrlHostname(host: string): string {
  const normalized = normalizeHost(host);
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

function requireConfigId(value: unknown): string {
  const id = requireString(value, 'Runtime Host service config id', 64);
  if (!CONFIG_ID_PATTERN.test(id)) throw new Error('Runtime Host service config id is invalid');
  return id;
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, 64);
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} is invalid`);
  }
  return timestamp;
}

function requireAbsolutePath(value: unknown, label: string): string {
  const path = requireString(value, label, 4_096);
  if (!isAbsolute(path) || UNSAFE_DISPLAY_CHARACTER_PATTERN.test(path)) {
    throw new Error(`${label} must be a safe absolute path`);
  }
  return path;
}

function requirePort(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return value as number;
}

function requireWebSocketPath(value: unknown): string {
  const path = requireString(value, 'Runtime Host WebSocket path', 512);
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('Runtime Host WebSocket path must be an absolute URL path');
  }
  return path;
}

function requireHost(value: unknown, label: string): string {
  const host = requireString(value, label, 512).trim();
  if (host.length === 0 || /[\s/?#@]/u.test(host) || UNSAFE_DISPLAY_CHARACTER_PATTERN.test(host)) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = normalizeHost(host);
  if (normalized.length === 0 || normalized === '*') throw new Error(`${label} is invalid`);
  let parsed: URL;
  try {
    parsed = new URL(`http://${formatUrlHostname(normalized)}`);
    if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') {
      throw new Error(`${label} is invalid`);
    }
  } catch (error) {
    throw new Error(`${label} is invalid`, { cause: error });
  }
  return normalizeHost(parsed.hostname);
}

function requirePublicHost(value: unknown): string {
  const host = requireHost(value, 'Runtime Host public host');
  if (host === '0.0.0.0' || host === '::') {
    throw new Error('Runtime Host public host must be a connectable hostname or IP');
  }
  return host;
}

function requireSshDestination(value: unknown): string {
  const destination = requireString(value, 'SSH destination', 512).trim();
  if (
    destination.length === 0 ||
    /\s/u.test(destination) ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(destination) ||
    destination.startsWith('-')
  ) {
    throw new Error('SSH destination is invalid');
  }
  return destination;
}

function requireAllowedOrigins(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('Runtime Host Origin allowlist is invalid');
  }
  const origins = value.map((candidate) => {
    const origin = requireString(candidate, 'Runtime Host allowed Origin', 1_024);
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new Error('Runtime Host allowed Origin is invalid', { cause: error });
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.origin !== origin ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      throw new Error('Runtime Host allowed Origin must be an HTTP(S) origin');
    }
    return origin;
  });
  if (new Set(origins).size !== origins.length) {
    throw new Error('Runtime Host Origin allowlist contains duplicates');
  }
  return Object.freeze(origins);
}

function decodeRuntimeHostServiceStartAttempt(value: unknown): RuntimeHostServiceStartAttempt {
  const record = requireExactRecord(value, 'Runtime Host service start attempt', [
    'schemaVersion',
    'configId',
    'configRevision',
    'attemptId',
    'expiresAt',
  ]);
  if (record.schemaVersion !== 1) {
    throw new Error('Runtime Host service start attempt has an unsupported schema');
  }
  const attemptId = requireString(record.attemptId, 'Runtime Host service start attempt id', 36);
  if (!START_ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new Error('Runtime Host service start attempt id is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    configId: requireConfigId(record.configId),
    configRevision: requireRuntimeHostServiceConfigRevision(record.configRevision),
    attemptId,
    expiresAt: requireTimestamp(record.expiresAt, 'Runtime Host service start attempt expiry'),
  });
}

function runtimeHostServiceStartAttemptPath(clientDataRoot: string, configId: string): string {
  if (!isAbsolute(clientDataRoot)) throw new Error('Maka client data root must be absolute');
  return join(
    clientDataRoot,
    CATALOG_DIRECTORY,
    'locks',
    `${requireConfigId(configId)}.start.json`,
  );
}

async function publishPrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.byteLength > START_ATTEMPT_MAX_BYTES) {
    throw new Error('Runtime Host service start attempt exceeds its size limit');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporary, 0o600);
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  label: string,
  fields: readonly string[],
): Record<string, unknown> {
  const record = requireRecord(value, label);
  const expected = new Set(fields);
  const keys = Object.keys(record);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label} has unexpected fields`);
  }
  return record;
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
