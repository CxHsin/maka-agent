import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { migrateSqliteAutomationDatabase } from '../sqlite-automation-schema.js';
import { migrateSqliteWorkflowDatabase } from '../sqlite-workflow-schema.js';

describe('SQLite scheduling schema', () => {
  test('replaces the legacy durable Automation catalog with the heartbeat schema', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE automation_authority_state (
          singleton INTEGER PRIMARY KEY,
          revision INTEGER NOT NULL
        );
        INSERT INTO automation_authority_state VALUES (1, 9);
        CREATE TABLE automation_definitions (
          automation_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          durable INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
        INSERT INTO automation_definitions
        VALUES ('legacy-cron', 'session-1', 1, 'active', 1, '{}');
        CREATE TABLE automation_pending_fires (
          fire_id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          admitted_at INTEGER NOT NULL,
          record_json TEXT NOT NULL
        );
      `);

      migrateSqliteAutomationDatabase(database);

      assert.deepEqual(
        database
          .prepare('PRAGMA table_info(automation_definitions)')
          .all()
          .map((row) => row.name),
        ['automation_id', 'session_id', 'created_at', 'status', 'record_json'],
      );
      assert.equal(
        (
          database.prepare('SELECT COUNT(*) AS count FROM automation_definitions').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.prepare('SELECT revision FROM automation_authority_state').get() as {
            revision: number;
          }
        ).revision,
        0,
      );
    } finally {
      database.close();
    }
  });

  test('drops the legacy plan-reminder catalog instead of migrating it', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec(`
        CREATE TABLE workflow_plan_reminders (
          reminder_id TEXT PRIMARY KEY,
          record_json TEXT NOT NULL
        );
        CREATE INDEX workflow_plan_reminders_order
          ON workflow_plan_reminders(reminder_id);
        INSERT INTO workflow_plan_reminders VALUES ('legacy-reminder', '{}');
      `);

      migrateSqliteWorkflowDatabase(database);

      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'workflow_plan_reminders'",
          )
          .get()?.count,
        0,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'workflow_plan_reminders_order'",
          )
          .get()?.count,
        0,
      );
    } finally {
      database.close();
    }
  });
});
