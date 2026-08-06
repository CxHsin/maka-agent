import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import {
  configureSqliteRuntimeDatabase,
  configureSqliteRuntimeLockWait,
  migrateSqliteRuntimeDatabase,
  readUserVersion,
  SQLITE_RUNTIME_SCHEMA_VERSION,
} from './sqlite-runtime-schema.js';
import {
  migrateSqliteSessionMetadataDatabase,
  readSqliteSessionMetadataSchemaVersion,
  SQLITE_SESSION_METADATA_SCHEMA_VERSION,
} from './sqlite-session-metadata-schema.js';
import {
  migrateSqliteCoreExecutionDatabase,
  SQLITE_CORE_EXECUTION_SCHEMA_VERSION,
} from './sqlite-core-execution-schema.js';
import {
  migrateSqliteWorkflowDatabase,
  SQLITE_WORKFLOW_SCHEMA_VERSION,
} from './sqlite-workflow-schema.js';
import { migrateSqliteUsageDatabase, SQLITE_USAGE_SCHEMA_VERSION } from './sqlite-usage-schema.js';
import {
  migrateSqliteArtifactDatabase,
  SQLITE_ARTIFACT_SCHEMA_VERSION,
} from './sqlite-artifact-schema.js';
import { migrateSqliteAutomationDatabase } from './sqlite-automation-schema.js';
import {
  OPERATIONAL_SCHEMA_MANIFEST,
  OPERATIONAL_STATE_READER_EPOCH,
  OPERATIONAL_STATE_SCHEMA_VERSION,
  validateOperationalSchemaManifest,
} from './operational-schema-manifest.js';

export const OPERATIONAL_STATE_DATABASE_NAME = 'runtime.sqlite';
export { OPERATIONAL_STATE_READER_EPOCH, OPERATIONAL_STATE_SCHEMA_VERSION };

validateOperationalSchemaManifest(OPERATIONAL_SCHEMA_MANIFEST, OPERATIONAL_STATE_READER_EPOCH);

const OPERATIONAL_SCHEMA_VERSIONS: ReadonlyMap<string, number> = new Map(
  OPERATIONAL_SCHEMA_MANIFEST.map(({ scope, currentVersion }) => [scope, currentVersion]),
);

const require = createRequire(import.meta.url);
const owners = new Map<string, OperationalStateDatabaseOwner>();

export interface OperationalStateDatabaseOptions {
  now?: () => number;
}

export interface OperationalStateDatabaseLease {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  transaction<T>(mode: 'read' | 'write', operation: () => T): T;
  backup(destinationPath: string): Promise<number>;
  close(): void;
}

/**
 * Acquire the process-local owner for the operational SQLite authority.
 *
 * Repositories receive leases instead of opening independent connections.
 * The last lease closes the connection, while transaction boundaries remain
 * centralized on the owner for the lifetime of the workspace.
 */
export function acquireOperationalStateDatabase(
  workspaceRoot: string,
  options: OperationalStateDatabaseOptions = {},
): OperationalStateDatabaseLease {
  const databasePath = resolve(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME);
  let owner = owners.get(databasePath);
  if (!owner) {
    owner = new OperationalStateDatabaseOwner(databasePath, options);
    owners.set(databasePath, owner);
  }
  return owner.acquire();
}

export function operationalStateRequiresExclusiveMigration(
  workspaceRoot: string,
  targetReaderEpoch = OPERATIONAL_STATE_READER_EPOCH,
): boolean {
  if (!Number.isSafeInteger(targetReaderEpoch) || targetReaderEpoch < 1) {
    throw new Error('Operational target reader epoch must be a positive integer');
  }
  const databasePath = resolve(workspaceRoot, OPERATIONAL_STATE_DATABASE_NAME);
  if (!existsSync(databasePath)) return targetReaderEpoch > 1;
  const Database = loadDatabaseSync();
  const database = new Database(databasePath, { readOnly: true });
  try {
    configureSqliteRuntimeLockWait(database);
    const minimumReaderEpoch = readMinimumReaderEpoch(database);
    return minimumReaderEpoch === undefined
      ? targetReaderEpoch > 1
      : minimumReaderEpoch < targetReaderEpoch;
  } finally {
    database.close();
  }
}

class OperationalStateDatabaseOwner {
  readonly database: DatabaseSync;
  private references = 0;
  private closed = false;
  private transactionDepth = 0;

  constructor(
    readonly databasePath: string,
    options: OperationalStateDatabaseOptions,
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const Database = loadDatabaseSync();
    this.database = new Database(databasePath);
    try {
      // Preflight reads must wait for another opener's WAL transition, but this
      // connection-only pragma keeps rejected databases byte-for-byte intact.
      configureSqliteRuntimeLockWait(this.database);
      // Reject every unsupported authority before the first migration commits,
      // so a newer later scope cannot leave an older earlier scope half-upgraded.
      assertOperationalSchemaCanMigrate(this.database);
      configureSqliteRuntimeDatabase(this.database);
      this.database.exec('BEGIN IMMEDIATE');
      try {
        // Recheck under the write lock: another process may have migrated after
        // the optimistic preflight and before this transaction was admitted.
        const compatibility = assertOperationalSchemaCanMigrate(this.database);
        if (
          !compatibility.allowsNewerScopes ||
          readUserVersion(this.database) <= SQLITE_RUNTIME_SCHEMA_VERSION
        ) {
          migrateSqliteRuntimeDatabase(this.database, { transaction: 'caller' });
        }
        if (
          !compatibility.allowsNewerScopes ||
          !hasTable(this.database, 'session_metadata_schema') ||
          readSqliteSessionMetadataSchemaVersion(this.database) <=
            SQLITE_SESSION_METADATA_SCHEMA_VERSION
        ) {
          migrateSqliteSessionMetadataDatabase(this.database, { transaction: 'caller' });
        }
        migrateSqliteCoreExecutionDatabase(this.database);
        migrateSqliteWorkflowDatabase(this.database);
        migrateSqliteUsageDatabase(this.database);
        migrateSqliteArtifactDatabase(this.database);
        migrateSqliteAutomationDatabase(this.database);
        migrateOperationalStateDatabase(this.database, options.now ?? Date.now, 'caller');
        this.database.exec('COMMIT');
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  acquire(): OperationalStateDatabaseLease {
    if (this.closed) throw new Error('Operational state database is closed');
    this.references += 1;
    let released = false;
    return {
      database: this.database,
      databasePath: this.databasePath,
      transaction: (mode, operation) => this.transaction(mode, operation),
      backup: (destinationPath) => this.backup(destinationPath),
      close: () => {
        if (released) return;
        released = true;
        this.releaseReference();
      },
    };
  }

  private async backup(destinationPath: string): Promise<number> {
    if (this.closed) throw new Error('Operational state database is closed');
    if (!destinationPath) throw new Error('Operational state backup destination is required');
    const canonicalDestination = resolve(destinationPath);
    if (canonicalDestination === this.databasePath) {
      throw new Error('Operational state backup destination must differ from the source database');
    }
    if (existsSync(canonicalDestination)) {
      throw new Error(
        `Operational state backup destination already exists: ${canonicalDestination}`,
      );
    }
    mkdirSync(dirname(canonicalDestination), { recursive: true });
    this.references += 1;
    try {
      return await loadSqliteModule().backup(this.database, canonicalDestination);
    } finally {
      this.releaseReference();
    }
  }

  private releaseReference(): void {
    this.references -= 1;
    if (this.references !== 0) return;
    this.closed = true;
    owners.delete(this.databasePath);
    this.database.close();
  }

  private transaction<T>(mode: 'read' | 'write', operation: () => T): T {
    if (this.closed) throw new Error('Operational state database is closed');
    if (this.transactionDepth > 0) return operation();
    this.database.exec(mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.database);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
}

interface OperationalSchemaCompatibility {
  allowsNewerScopes: boolean;
}

function assertOperationalSchemaCanMigrate(database: DatabaseSync): OperationalSchemaCompatibility {
  const compatibility = readOperationalSchemaCompatibility(database);
  assertSupportedOperationalSchemaVersion(
    'runtime',
    readUserVersion(database),
    SQLITE_RUNTIME_SCHEMA_VERSION,
    compatibility.allowsNewerScopes,
  );
  if (hasTable(database, 'session_metadata_schema')) {
    assertSupportedOperationalSchemaVersion(
      'session_metadata',
      readSqliteSessionMetadataSchemaVersion(database),
      SQLITE_SESSION_METADATA_SCHEMA_VERSION,
      compatibility.allowsNewerScopes,
    );
  }

  if (!hasTable(database, 'operational_schema_migrations')) return compatibility;
  const rows = database
    .prepare('SELECT scope, version FROM operational_schema_migrations')
    .all() as Array<{ scope?: unknown; version?: unknown }>;
  for (const { scope, version } of rows) {
    if (typeof scope !== 'string' || scope.length === 0) {
      throw new Error(
        'Operational schema has invalid scope metadata; ' +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    const supportedVersion = OPERATIONAL_SCHEMA_VERSIONS.get(scope);
    if (supportedVersion === undefined) {
      if (compatibility.allowsNewerScopes) continue;
      throw new Error(
        `Operational schema ${scope} is unknown to this Maka build; ` +
          'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
      );
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
      throw new Error(
        `Operational schema ${scope} has invalid version ${String(version)}; ` +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    assertSupportedOperationalSchemaVersion(
      scope,
      version,
      supportedVersion,
      compatibility.allowsNewerScopes,
    );
  }
  return compatibility;
}

function assertSupportedOperationalSchemaVersion(
  scope: string,
  observedVersion: number,
  supportedVersion: number,
  allowsNewerScopes = false,
): void {
  if (observedVersion <= supportedVersion || allowsNewerScopes) return;
  throw new Error(
    `Operational schema ${scope} is newer than supported version ${supportedVersion}; ` +
      'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
  );
}

function readOperationalSchemaCompatibility(
  database: DatabaseSync,
): OperationalSchemaCompatibility {
  const minimumReaderEpoch = readMinimumReaderEpoch(database);
  if (minimumReaderEpoch === undefined) return { allowsNewerScopes: false };
  if (minimumReaderEpoch > OPERATIONAL_STATE_READER_EPOCH) {
    throw new Error(
      `Operational state requires reader epoch ${minimumReaderEpoch}, but this Maka build supports epoch ${OPERATIONAL_STATE_READER_EPOCH}; ` +
        'Maka did not migrate or delete the database. Upgrade Maka to open this workspace.',
    );
  }
  return { allowsNewerScopes: true };
}

function readMinimumReaderEpoch(database: DatabaseSync): number | undefined {
  if (!hasTable(database, 'operational_schema_compatibility')) return undefined;
  const rows = database
    .prepare(`
      SELECT singleton, minimum_reader_epoch AS minimumReaderEpoch
      FROM operational_schema_compatibility
    `)
    .all() as Array<{ singleton?: unknown; minimumReaderEpoch?: unknown }>;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.singleton !== 1 ||
    typeof row.minimumReaderEpoch !== 'number' ||
    !Number.isSafeInteger(row.minimumReaderEpoch) ||
    row.minimumReaderEpoch < 1
  ) {
    throw new Error(
      'Operational schema compatibility metadata is invalid; ' +
        'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
    );
  }
  return row.minimumReaderEpoch;
}

function hasTable(database: DatabaseSync, name: string): boolean {
  const table = database
    .prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `)
    .get(name) as { present?: unknown } | undefined;
  return table?.present === 1;
}

function migrateOperationalStateDatabase(
  db: DatabaseSync,
  now: () => number,
  transaction: 'self' | 'caller' = 'self',
): void {
  const ownsTransaction = transaction === 'self';
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_schema_compatibility (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        minimum_reader_epoch INTEGER NOT NULL CHECK (minimum_reader_epoch >= 1)
      );
      INSERT INTO operational_schema_compatibility(singleton, minimum_reader_epoch)
      VALUES (1, ${OPERATIONAL_STATE_READER_EPOCH})
      ON CONFLICT(singleton) DO UPDATE SET
        minimum_reader_epoch = MAX(
          operational_schema_compatibility.minimum_reader_epoch,
          excluded.minimum_reader_epoch
        );

      CREATE TABLE IF NOT EXISTS operational_schema_migrations (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
      );
    `);
    const appliedAt = now();
    for (const [scope, version] of OPERATIONAL_SCHEMA_VERSIONS) {
      registerSchema(db, scope, version, appliedAt);
    }
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

function registerSchema(db: DatabaseSync, scope: string, version: number, appliedAt: number): void {
  const existing = db
    .prepare('SELECT version FROM operational_schema_migrations WHERE scope = ?')
    .get(scope) as { version?: unknown } | undefined;
  if (existing) {
    if (
      typeof existing.version !== 'number' ||
      !Number.isSafeInteger(existing.version) ||
      existing.version < 0
    ) {
      throw new Error(
        `Operational schema ${scope} has invalid version ${String(existing.version)}; ` +
          'Maka did not migrate or delete the database. Restore or repair this workspace before opening it.',
      );
    }
    if (existing.version >= version) return;
  }
  db.prepare(`
    INSERT INTO operational_schema_migrations(scope, version, applied_at)
    VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      version = excluded.version,
      applied_at = CASE
        WHEN operational_schema_migrations.version = excluded.version
        THEN operational_schema_migrations.applied_at
        ELSE excluded.applied_at
      END
  `).run(scope, version, appliedAt);
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningType = typeof args[0] === 'string' ? args[0] : undefined;
    if (
      warningType === 'ExperimentalWarning' &&
      String(warning).startsWith('SQLite is an experimental feature')
    ) {
      return;
    }
    Reflect.apply(emitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;
  try {
    return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  } finally {
    process.emitWarning = emitWarning;
  }
}

function loadSqliteModule(): typeof import('node:sqlite') {
  return require('node:sqlite') as typeof import('node:sqlite');
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the failure that triggered rollback.
  }
}
