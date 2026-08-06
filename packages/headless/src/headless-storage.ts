import {
  openHeadlessArtifactStoreForWrite,
  type HeadlessArtifactStoreWriter,
} from '@maka/storage/artifact-stores';
import {
  acquireOperationalStateDatabase,
  operationalStateRequiresExclusiveMigration,
} from '@maka/storage';
import {
  authenticateExecutionStoresReader,
  authenticateExecutionStoresWriter,
  openHeadlessExecutionStoresForRead,
  openHeadlessExecutionStoresForWrite,
  type ExecutionStoresReader,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import {
  discoverMarkedStorageRoot,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireHeadlessRootCompatibilityLock,
  tryAcquireHeadlessRootMigrationOwner,
  type DiscoveredStorageRootCapability,
  type HeadlessRootCompatibilityLock,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import {
  openHeadlessTaskRunReader,
  openHeadlessTaskRunWriter,
  type TaskRunReader,
  type TaskRunWriter,
} from './task-run-store.js';

const headlessStorageWriterBrand: unique symbol = Symbol('HeadlessStorageWriter');
const headlessStorageReaderBrand: unique symbol = Symbol('HeadlessStorageReader');
const headlessStorageWriters = new WeakSet<object>();
const headlessStorageReaders = new WeakSet<object>();

export type HeadlessArtifactStore = HeadlessArtifactStoreWriter;

export interface HeadlessStorageWriter {
  readonly [headlessStorageWriterBrand]: true;
  readonly taskRunStore: Readonly<TaskRunWriter>;
  readonly executionStores: ExecutionStoresWriter<'headless'>;
  readonly artifactStore: HeadlessArtifactStore;
  close(): Promise<void>;
}

export interface HeadlessStorageReader {
  readonly [headlessStorageReaderBrand]: true;
  readonly taskRunStore: Readonly<TaskRunReader>;
  readonly executionStores: ExecutionStoresReader<'headless'>;
  close(): Promise<void>;
}

export async function openHeadlessStorageForWrite(
  storageRoot: string,
): Promise<HeadlessStorageWriter> {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
  await applyRequiredExclusiveMigration(capability);
  const lock = await requireCompatibilityLock(capability, 'write');
  const lease = lock.lease;
  let executionStores: ExecutionStoresWriter<'headless'> | undefined;
  let artifactStore: HeadlessArtifactStore | undefined;
  let taskRunStore: TaskRunWriter;
  try {
    taskRunStore = await openHeadlessTaskRunWriter(lease);
    executionStores = await openHeadlessExecutionStoresForWrite(lease);
    artifactStore = await openHeadlessArtifactStoreForWrite(lease);
  } catch (error) {
    await closeStorage(lock, executionStores, artifactStore).catch(() => {});
    throw error;
  }

  let closed = false;
  const storage: HeadlessStorageWriter = {
    [headlessStorageWriterBrand]: true,
    taskRunStore,
    executionStores,
    artifactStore,
    close: async () => {
      if (closed) return;
      closed = true;
      headlessStorageWriters.delete(storage);
      await closeStorage(lock, executionStores, artifactStore);
    },
  };
  Object.freeze(storage);
  headlessStorageWriters.add(storage);
  return storage;
}

export async function openHeadlessStorageForRead(
  source: string | StorageRootCapability<'headless'>,
): Promise<HeadlessStorageReader> {
  const capability =
    typeof source === 'string'
      ? requireHeadlessCapability(await discoverMarkedStorageRoot({ path: source }))
      : source;
  await applyRequiredExclusiveMigration(capability);
  const lock = await requireCompatibilityLock(capability, 'read');
  const lease = lock.lease;
  let executionStores: ExecutionStoresReader<'headless'> | undefined;
  let taskRunStore: TaskRunReader;
  try {
    taskRunStore = await openHeadlessTaskRunReader(lease);
    executionStores = await openHeadlessExecutionStoresForRead(lease);
  } catch (error) {
    await closeStorage(lock, executionStores).catch(() => {});
    throw error;
  }

  let closed = false;
  const storage: HeadlessStorageReader = {
    [headlessStorageReaderBrand]: true,
    taskRunStore,
    executionStores,
    close: async () => {
      if (closed) return;
      closed = true;
      headlessStorageReaders.delete(storage);
      await closeStorage(lock, executionStores);
    },
  };
  Object.freeze(storage);
  headlessStorageReaders.add(storage);
  return storage;
}

async function applyRequiredExclusiveMigration(
  capability: StorageRootCapability<'headless'>,
): Promise<void> {
  if (!operationalStateRequiresExclusiveMigration(capability.canonicalPath)) return;
  const owner = await tryAcquireHeadlessRootMigrationOwner(capability);
  if (!owner) {
    throw new StorageRootAuthorityError(
      'lock_failed',
      'Headless storage requires an operational schema migration; close older processes before retrying',
    );
  }
  try {
    if (!operationalStateRequiresExclusiveMigration(capability.canonicalPath)) return;
    acquireOperationalStateDatabase(capability.canonicalPath).close();
  } finally {
    await owner.close();
  }
}

async function requireCompatibilityLock<A extends 'read' | 'write'>(
  capability: StorageRootCapability<'headless'>,
  access: A,
): Promise<HeadlessRootCompatibilityLock<A>> {
  const lock = await tryAcquireHeadlessRootCompatibilityLock(capability, access);
  if (lock) return lock;
  throw new StorageRootAuthorityError(
    'lock_failed',
    'Headless storage is unavailable while an operational schema migration owns this root',
  );
}

async function closeStorage(
  lock: HeadlessRootCompatibilityLock<'read' | 'write'>,
  executionStores?: ExecutionStoresReader<'headless'> | ExecutionStoresWriter<'headless'>,
  artifactStore?: HeadlessArtifactStore,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await executionStores?.sessionStore.close?.();
  } catch (error) {
    errors.push(error);
  }
  try {
    artifactStore?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await lock.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Unable to close Headless storage');
}

export function authenticateHeadlessStorageWriter(
  storage: HeadlessStorageWriter,
): HeadlessStorageWriter {
  if (!headlessStorageWriters.has(storage)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic Headless storage writer',
    );
  }
  authenticateExecutionStoresWriter(storage.executionStores, 'headless');
  return storage;
}

export function authenticateHeadlessStorageReader(
  storage: HeadlessStorageReader,
): HeadlessStorageReader {
  if (!headlessStorageReaders.has(storage)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic Headless storage reader',
    );
  }
  authenticateExecutionStoresReader(storage.executionStores, 'headless');
  return storage;
}

export function isStorageRootAuthorityError(error: unknown): error is StorageRootAuthorityError {
  return error instanceof StorageRootAuthorityError;
}

function requireHeadlessCapability(
  capability: DiscoveredStorageRootCapability,
): StorageRootCapability<'headless'> {
  if (capability.kind !== 'headless') {
    throw new StorageRootAuthorityError(
      'root_kind_mismatch',
      `Storage root ${capability.canonicalPath} is ${capability.kind}, not headless`,
    );
  }
  return capability;
}
