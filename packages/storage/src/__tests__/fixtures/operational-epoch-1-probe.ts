import { DatabaseSync } from 'node:sqlite';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('usage: operational-epoch-1-probe <runtime.sqlite>');

const database = new DatabaseSync(databasePath);
try {
  const compatibility = database
    .prepare(`
      SELECT minimum_reader_epoch AS minimumReaderEpoch
      FROM operational_schema_compatibility
      WHERE singleton = 1
    `)
    .get() as { minimumReaderEpoch?: unknown } | undefined;
  if (compatibility?.minimumReaderEpoch !== 1) {
    throw new Error(`epoch-1 reader rejected minimum epoch ${compatibility?.minimumReaderEpoch}`);
  }

  const minimumVersions = new Map([
    ['core_execution', 1],
    ['workflow', 3],
    ['usage', 3],
    ['artifact', 1],
    ['automation', 1],
    ['operational', 1],
  ]);
  for (const row of database
    .prepare('SELECT scope, version FROM operational_schema_migrations')
    .all() as Array<{ scope: string; version: number }>) {
    const minimum = minimumVersions.get(row.scope);
    if (minimum !== undefined && row.version < minimum) {
      throw new Error(`epoch-1 reader found ${row.scope} version ${row.version} below ${minimum}`);
    }
  }
  const runtimeVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (runtimeVersion < 11) throw new Error(`epoch-1 reader found runtime ${runtimeVersion}`);
  const metadataVersion = (
    database
      .prepare(`SELECT version FROM session_metadata_schema WHERE scope = 'session_metadata'`)
      .get() as { version: number }
  ).version;
  if (metadataVersion < 22) {
    throw new Error(`epoch-1 reader found session_metadata ${metadataVersion}`);
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(`
        INSERT INTO runtime_events(
          event_id, session_id, invocation_id, run_id, turn_id, event_seq,
          event_kind, payload_json, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'epoch-1-event',
        'epoch-1-session',
        'epoch-1-invocation',
        'epoch-1-run',
        'epoch-1-turn',
        1,
        'epoch_1_probe',
        '{}',
        1,
      );
    database
      .prepare(`
        INSERT INTO session_metadata(
          session_id, payload_json, created_at, last_used_at, last_message_at,
          name, is_flagged, is_archived, status, status_updated_at,
          parent_session_id, revision_root_session_id, revision_index,
          has_unread, backend, llm_connection_slug, model, metadata_version, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'epoch-1-session',
        '{}',
        1,
        1,
        1,
        'Epoch 1',
        0,
        0,
        'active',
        1,
        null,
        null,
        null,
        0,
        'fake',
        'fake',
        'fake',
        1,
        1,
      );
    database
      .prepare('INSERT INTO core_message_host_epochs(host_epoch) VALUES (?)')
      .run('epoch-1-host');
    database
      .prepare('INSERT INTO workflow_quote_companion_cleanup(session_id, tracked_at) VALUES (?, ?)')
      .run('epoch-1-session', 1);
    database
      .prepare('INSERT INTO usage_pricing_overrides(model_key, record_json) VALUES (?, ?)')
      .run('epoch-1-model', '{}');
    database
      .prepare(`
        INSERT INTO artifact_records(
          storage_key, artifact_id, session_id, created_at, status, relative_path, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'epoch-1-artifact-key',
        'epoch-1-artifact',
        'epoch-1-session',
        1,
        'live',
        'epoch-1-artifact.txt',
        '{}',
      );
    database
      .prepare(`
        INSERT INTO automation_definitions(
          automation_id, session_id, created_at, status, durable, record_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run('epoch-1-automation', 'epoch-1-session', 1, 'active', 1, '{}');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
} finally {
  database.close();
}
