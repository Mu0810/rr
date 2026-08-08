/**
 * Storage layer. Uses Node's built-in `node:sqlite` — no npm dependency.
 *
 * All candidate answers live in one `answers` JSON column so adding a question
 * to schema.js never needs a migration. The columns pulled out separately are
 * only the ones we filter, sort or search on.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(import.meta.dirname, '../data/applications.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS applications (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ref              TEXT    NOT NULL UNIQUE,
    category         TEXT    NOT NULL,
    brand            TEXT    NOT NULL,
    full_name        TEXT    NOT NULL,
    email            TEXT    NOT NULL,
    phone            TEXT    NOT NULL,
    city             TEXT,
    experience_years REAL,
    expected_ctc     TEXT,
    notice_period    TEXT,
    answers          TEXT    NOT NULL,
    cv_original_name TEXT,
    cv_stored_name   TEXT,
    cv_size          INTEGER,
    cv_mime          TEXT,
    status           TEXT    NOT NULL DEFAULT 'new',
    recruiter_notes  TEXT    NOT NULL DEFAULT '',
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL,
    ip_hash          TEXT,
    user_agent       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_app_category ON applications (category);
  CREATE INDEX IF NOT EXISTS idx_app_status   ON applications (status);
  CREATE INDEX IF NOT EXISTS idx_app_created  ON applications (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_app_email    ON applications (email);

  -- Outbox. A lost notification is a lost candidate, so each destination is
  -- tracked per application and retried with backoff instead of fire-and-forget.
  CREATE TABLE IF NOT EXISTS deliveries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id  INTEGER NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
    sink            TEXT    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL,
    UNIQUE (application_id, sink)
  );

  CREATE INDEX IF NOT EXISTS idx_delivery_due ON deliveries (status, next_attempt_at);
`);

/* ------------------------------------------------------------------ outbox */

export function queueDelivery(applicationId, sink) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO deliveries (application_id, sink, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)
     ON CONFLICT (application_id, sink) DO NOTHING`,
  ).run(applicationId, sink, now, now, now);
}

/** Pending deliveries whose retry time has arrived, oldest first. */
export function dueDeliveries(limit = 20) {
  return db
    .prepare(
      `SELECT * FROM deliveries
        WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(new Date().toISOString(), limit);
}

export function markDelivered(id) {
  db.prepare(
    `UPDATE deliveries
        SET status = 'sent', last_error = NULL, attempts = attempts + 1,
            next_attempt_at = NULL, updated_at = ?
      WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

/**
 * Records a failure. Retries back off 1min, 5min, 15min, 1h, 6h; after
 * `maxAttempts` the row is parked as 'failed' so it shows up in the dashboard
 * instead of retrying forever.
 *
 * DELIVERY_BACKOFF_MS scales the schedule (default one minute per unit) — the
 * test suite shortens it so retry behaviour can be verified in seconds.
 */
const BACKOFF_UNIT_MS = Number(process.env.DELIVERY_BACKOFF_MS || 60_000);

export function markFailed(id, error, maxAttempts = 6) {
  const row = db.prepare('SELECT attempts FROM deliveries WHERE id = ?').get(id);
  const attempts = (row?.attempts ?? 0) + 1;
  const backoffUnits = [1, 5, 15, 60, 360][Math.min(attempts - 1, 4)];
  const giveUp = attempts >= maxAttempts;

  db.prepare(
    `UPDATE deliveries
        SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    giveUp ? 'failed' : 'pending',
    attempts,
    String(error).slice(0, 500),
    giveUp ? null : new Date(Date.now() + backoffUnits * BACKOFF_UNIT_MS).toISOString(),
    new Date().toISOString(),
    id,
  );
}

export function deliveriesFor(applicationId) {
  return db
    .prepare('SELECT sink, status, attempts, last_error, updated_at FROM deliveries WHERE application_id = ?')
    .all(applicationId);
}

export function deliveryHealth() {
  return db
    .prepare(`SELECT sink, status, COUNT(*) AS n FROM deliveries GROUP BY sink, status`)
    .all();
}

/* ------------------------------------------------------------- applications */

export function insertApplication(row) {
  const stmt = db.prepare(`
    INSERT INTO applications (
      ref, category, brand, full_name, email, phone, city, experience_years,
      expected_ctc, notice_period, answers, cv_original_name, cv_stored_name,
      cv_size, cv_mime, status, created_at, updated_at, ip_hash, user_agent
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, 'new', ?, ?, ?, ?
    )
  `);
  const now = new Date().toISOString();
  const info = stmt.run(
    row.ref,
    row.category,
    row.brand,
    row.fullName,
    row.email,
    row.phone,
    row.city ?? null,
    row.experienceYears ?? null,
    row.expectedCtc ?? null,
    row.noticePeriod ?? null,
    JSON.stringify(row.answers),
    row.cvOriginalName ?? null,
    row.cvStoredName ?? null,
    row.cvSize ?? null,
    row.cvMime ?? null,
    now,
    now,
    row.ipHash ?? null,
    row.userAgent ?? null,
  );
  return Number(info.lastInsertRowid);
}

/** True when this email already applied to this category in the last `hours`. */
export function isDuplicate(email, category, hours = 24) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM applications
        WHERE lower(email) = lower(?) AND category = ? AND created_at > ?`,
    )
    .get(email, category, since);
  return (row?.n ?? 0) > 0;
}

export function listApplications({ category, status, q, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(full_name LIKE ? OR email LIKE ? OR phone LIKE ? OR ref LIKE ? OR city LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total =
    db.prepare(`SELECT COUNT(*) AS n FROM applications ${clause}`).get(...params)?.n ?? 0;

  const rows = db
    .prepare(
      `SELECT id, ref, category, full_name, email, phone, city, experience_years,
              expected_ctc, notice_period, cv_original_name, cv_stored_name,
              status, created_at
         FROM applications ${clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  return { total, rows };
}

export function getApplication(id) {
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, answers: JSON.parse(row.answers) };
}

export function updateApplication(id, { status, recruiterNotes }) {
  const sets = ['updated_at = ?'];
  const params = [new Date().toISOString()];

  if (status !== undefined) {
    sets.push('status = ?');
    params.push(status);
  }
  if (recruiterNotes !== undefined) {
    sets.push('recruiter_notes = ?');
    params.push(recruiterNotes);
  }

  params.push(id);
  const info = db
    .prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params);
  return info.changes > 0;
}

export function allForExport({ category, status } = {}) {
  const where = [];
  const params = [];
  if (category) {
    where.push('category = ?');
    params.push(category);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM applications ${clause} ORDER BY created_at DESC`)
    .all(...params)
    .map((r) => ({ ...r, answers: JSON.parse(r.answers) }));
}

export function stats() {
  const byCategory = db
    .prepare('SELECT category, COUNT(*) AS n FROM applications GROUP BY category')
    .all();
  const byStatus = db
    .prepare('SELECT status, COUNT(*) AS n FROM applications GROUP BY status')
    .all();
  const total = db.prepare('SELECT COUNT(*) AS n FROM applications').get()?.n ?? 0;
  const last24h =
    db
      .prepare('SELECT COUNT(*) AS n FROM applications WHERE created_at > ?')
      .get(new Date(Date.now() - 86_400_000).toISOString())?.n ?? 0;
  return { total, last24h, byCategory, byStatus };
}
