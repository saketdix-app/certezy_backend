// src/modules/backups/backups.service.js
// Database backups: a full SQL dump of the database, gzipped, stored privately
// in S3 under db-backups/. Once a day (BACKUP_TIME_IST, default 02:30) and on
// demand from Admin → Backups. Only the newest BACKUP_KEEP (default 7) are
// kept; older ones are deleted from S3. Super Admins only: a backup holds
// every record, so listing / downloading / running one is audited.
//
// The dump is made here in Node (no mysqldump needed on the server): table
// definitions (SHOW CREATE TABLE / VIEW) and every row as INSERT statements,
// in one consistent snapshot (REPEATABLE READ, consistent snapshot).
// Restore: gunzip -c backup.sql.gz | mysql -u USER -p DB_NAME  (see docs/BACKUPS.md)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import mysql2 from 'mysql2'
import env from '../../config/env.js'
import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { deletePrivateFile, isConfigured, listPrivateFiles, presignPrivateGet, uploadPrivateFile } from '../../utils/upload.js'

const PREFIX = 'db-backups/'
const LOCK = 'certezy_db_backup'
export const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7)
// "HH:MM" in IST
export const BACKUP_TIME = /^\d{1,2}:\d{2}$/.test(process.env.BACKUP_TIME_IST ?? '') ? process.env.BACKUP_TIME_IST : '02:30'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const assertSuperAdmin = (actor) => {
  if (actor?.role !== 'super_admin') throw fail(403, 'Database backups are for Super Admins only')
}
const istParts = (d = new Date()) => {
  const t = new Date(d.getTime() + 330 * 60e3).toISOString()
  return { day: t.slice(0, 10), hm: t.slice(11, 16), stamp: `${t.slice(0, 10)}_${t.slice(11, 13)}${t.slice(14, 16)}${t.slice(17, 19)}` }
}

// ── Dump ──────────────────────────────────────────────────────────────────
const q = (name) => `\`${String(name).replace(/`/g, '``')}\``

/** A separate connection that returns values exactly as stored (dates as text, big numbers as text, JSON as text). */
const dumpConnection = () =>
  mysql2.createConnection({
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password || '',
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    typeCast: (field, next) => (field.type === 'JSON' ? field.string('utf8') : next()),
  })

const value = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (Buffer.isBuffer(v)) return v.length ? `X'${v.toString('hex')}'` : "''"
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return mysql2.escape(String(v))
}

/** Write the whole database as SQL to `out` (a writable stream). Returns { tables, rows }. */
export const dumpDatabase = async (out) => {
  const conn = dumpConnection()
  const c = conn.promise()
  const write = (s) => (out.write(s) ? null : new Promise((r) => out.once('drain', r)))
  let tables = 0
  let rows = 0
  try {
    await c.query("SET SESSION time_zone = '+00:00'")
    await c.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
    const [list] = await c.query('SHOW FULL TABLES')
    const key = Object.keys(list[0] ?? {}).find((k) => k.startsWith('Tables_in_'))
    const base = list.filter((t) => t.Table_type === 'BASE TABLE').map((t) => t[key])
    const views = list.filter((t) => t.Table_type === 'VIEW').map((t) => t[key])

    await write(
      `-- CERTEZY database backup\n-- Database: ${env.db.name}\n-- Made: ${new Date().toISOString()} (UTC)\n` +
        `-- Restore: gunzip -c FILE.sql.gz | mysql -u USER -p DATABASE\n\n` +
        `SET NAMES utf8mb4;\nSET time_zone = '+00:00';\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\nSET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n\n`
    )
    for (const table of base) {
      const [[def]] = await c.query(`SHOW CREATE TABLE ${q(table)}`)
      await write(`--\n-- Table ${table}\n--\nDROP TABLE IF EXISTS ${q(table)};\n${def['Create Table']};\n\n`)
      // Computed (VIRTUAL / STORED GENERATED) columns can't be inserted. Careful: columns
      // with DEFAULT CURRENT_TIMESTAMP show "DEFAULT_GENERATED" — those must be kept.
      const [cols] = await c.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
           AND EXTRA NOT LIKE '%VIRTUAL GENERATED%' AND EXTRA NOT LIKE '%STORED GENERATED%' ORDER BY ORDINAL_POSITION`,
        [table]
      )
      const names = cols.map((x) => x.COLUMN_NAME)
      if (!names.length) continue
      const head = `INSERT INTO ${q(table)} (${names.map(q).join(', ')}) VALUES\n`
      let batch = []
      let size = 0
      const flush = async () => {
        if (!batch.length) return
        await write(head + batch.join(',\n') + ';\n')
        batch = []
        size = 0
      }
      // Stream the rows (no whole table in memory)
      const stream = conn.query({ sql: `SELECT ${names.map(q).join(', ')} FROM ${q(table)}`, rowsAsArray: true }).stream({ highWaterMark: 500 })
      for await (const row of stream) {
        const line = `(${row.map(value).join(', ')})`
        batch.push(line)
        size += line.length
        rows++
        if (size > 512 * 1024 || batch.length >= 500) await flush()
      }
      await flush()
      await write('\n')
      tables++
    }
    for (const view of views) {
      const [[def]] = await c.query(`SHOW CREATE VIEW ${q(view)}`)
      await write(`DROP VIEW IF EXISTS ${q(view)};\n${def['Create View'].replace(/DEFINER=`[^`]*`@`[^`]*`\s*/, '')};\n\n`)
    }
    await write('SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n-- End of backup\n')
    await c.query('COMMIT')
  } finally {
    await c.end().catch(() => {})
  }
  return { tables, rows }
}

// ── Run, keep 7, list ───────────────────────────────────────────────────────

/**
 * Make a backup and upload it; then delete all but the newest KEEP.
 * Only one runs at a time (also across server processes). Returns the record.
 */
export const runBackup = async ({ trigger = 'scheduled', userId = null } = {}) => {
  if (!isConfigured()) throw fail(503, 'File storage (S3) is not set up on the server — backups need it')
  const lockConn = await pool.getConnection()
  let id
  try {
    const [[{ got }]] = await lockConn.query('SELECT GET_LOCK(?, 0) AS got', [LOCK])
    if (!got) throw fail(409, 'A backup is already running')
    const { stamp } = istParts()
    const key = `${PREFIX}certezy-${env.db.name}-${stamp}-IST.sql.gz`
    const [r] = await pool.query(
      "INSERT INTO db_backups (s3_key, status, trigger_type, triggered_by, started_at) VALUES (?, 'running', ?, ?, UTC_TIMESTAMP())",
      [key, trigger, userId]
    )
    id = r.insertId
    const started = Date.now()
    const file = path.join(os.tmpdir(), `certezy-backup-${process.pid}-${started}.sql.gz`)
    try {
      const gzip = zlib.createGzip({ level: 6 })
      const sink = fs.createWriteStream(file)
      const piping = pipeline(gzip, sink)
      const stats = await dumpDatabase(gzip)
      gzip.end()
      await piping
      const size = fs.statSync(file).size
      await uploadPrivateFile({ key, filePath: file, size, mimeType: 'application/gzip' })
      await pool.query(
        "UPDATE db_backups SET status = 'done', size_bytes = ?, tables_count = ?, rows_count = ?, duration_ms = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?",
        [size, stats.tables, stats.rows, Date.now() - started, id]
      )
    } finally {
      fs.rm(file, { force: true }, () => {})
    }
    await prune()
    const [[row]] = await pool.query('SELECT * FROM db_backups WHERE id = ?', [id])
    return row
  } catch (err) {
    if (id) await pool.query("UPDATE db_backups SET status = 'failed', error = ?, finished_at = UTC_TIMESTAMP() WHERE id = ?", [String(err.message).slice(0, 500), id]).catch(() => {})
    throw err
  } finally {
    await lockConn.query('SELECT RELEASE_LOCK(?)', [LOCK]).catch(() => {})
    lockConn.release()
  }
}

/** Keep the newest KEEP backups in S3; delete the rest (and mark them deleted). */
export const prune = async () => {
  const files = (await listPrivateFiles(PREFIX)).filter((f) => f.key.endsWith('.sql.gz'))
  files.sort((a, b) => b.lastModified - a.lastModified)
  const old = files.slice(KEEP)
  for (const f of old) {
    await deletePrivateFile(f.key)
    await pool.query("UPDATE db_backups SET status = 'deleted', deleted_at = UTC_TIMESTAMP() WHERE s3_key = ? AND status = 'done'", [f.key])
  }
  return old.length
}

/** Next scheduled run (ms), in IST BACKUP_TIME. */
export const nextRun = (now = new Date()) => {
  const [h, m] = BACKUP_TIME.split(':').map(Number)
  const { day } = istParts(now)
  let at = new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`)
  if (at <= now) at = new Date(at.getTime() + 864e5)
  return at
}

/** Scheduler: once a day after BACKUP_TIME (IST), if today's backup hasn't been made. */
export const backupDue = async (now = new Date()) => {
  const { day, hm } = istParts(now)
  if (hm < BACKUP_TIME.padStart(5, '0')) return false
  const start = new Date(`${day}T00:00:00+05:30`).toISOString().slice(0, 19).replace('T', ' ')
  const [[r]] = await pool.query(
    "SELECT COUNT(*) AS n FROM db_backups WHERE trigger_type = 'scheduled' AND started_at >= ? AND status IN ('done', 'running', 'deleted')",
    [start]
  )
  // a failed scheduled run is retried on the next tick, at most 3 times a day
  const [[f]] = await pool.query("SELECT COUNT(*) AS n FROM db_backups WHERE trigger_type = 'scheduled' AND started_at >= ? AND status = 'failed'", [start])
  return Number(r.n) === 0 && Number(f.n) < 3
}

export const tick = async () => {
  if (!isConfigured()) return
  try {
    // A run left "running" by a restart is over
    await pool.query("UPDATE db_backups SET status = 'failed', error = 'Interrupted (server restarted)', finished_at = UTC_TIMESTAMP() WHERE status = 'running' AND started_at < UTC_TIMESTAMP() - INTERVAL 2 HOUR")
    if (await backupDue()) await runBackup({ trigger: 'scheduled' })
  } catch (err) {
    if (err.statusCode !== 409) console.error('Database backup failed:', err.message)
  }
}

// ── Admin → Backups ─────────────────────────────────────────────────────────

const iso = (d) => (d ? new Date(d).toISOString() : null)
const shape = (r) => ({
  id: r.id,
  file_name: r.s3_key.slice(PREFIX.length),
  status: r.status,
  trigger: r.trigger_type,
  triggered_by: r.triggered_by_name ?? null,
  size_bytes: Number(r.size_bytes ?? 0),
  tables: Number(r.tables_count ?? 0),
  rows: Number(r.rows_count ?? 0),
  duration_ms: Number(r.duration_ms ?? 0),
  error: r.error ?? null,
  started_at: iso(r.started_at),
  finished_at: iso(r.finished_at),
  deleted_at: iso(r.deleted_at),
})

export const overview = async (actor) => {
  assertSuperAdmin(actor)
  const [rows] = await pool.query(
    `SELECT b.*, u.name AS triggered_by_name FROM db_backups b LEFT JOIN users u ON u.id = b.triggered_by
     ORDER BY b.id DESC LIMIT 40`
  )
  const list = rows.map(shape)
  return {
    storage_ready: isConfigured(),
    keep: KEEP,
    time_ist: BACKUP_TIME,
    next_run: nextRun().toISOString(),
    running: list.some((b) => b.status === 'running'),
    available: list.filter((b) => b.status === 'done'),
    history: list.filter((b) => b.status !== 'done').slice(0, 15),
  }
}

/** Start a backup now; it runs in the background (the page shows it as running). */
export const backupNow = async (req) => {
  assertSuperAdmin(req.user)
  if (!isConfigured()) throw fail(503, 'File storage (S3) is not set up on the server — backups need it')
  const [[{ free }]] = await pool.query('SELECT IS_FREE_LOCK(?) AS free', [LOCK])
  if (!free) throw fail(409, 'A backup is already running')
  await audit(req, { action: 'backup.run', targetType: 'backup' })
  runBackup({ trigger: 'manual', userId: req.user.id }).catch((err) => {
    if (err.statusCode !== 409) console.error('Database backup failed:', err.message)
  })
  // let the run record appear before the page reloads
  await new Promise((r) => setTimeout(r, 300))
  return { started: true }
}

/** Every 10 minutes: make today's backup once it's past the backup time. */
export const scheduleBackups = () => {
  setTimeout(tick, 2 * 60e3).unref()
  setInterval(tick, 10 * 60e3).unref()
}

export const downloadLink = async (req, id) => {
  assertSuperAdmin(req.user)
  const [[r]] = await pool.query("SELECT * FROM db_backups WHERE id = ? AND status = 'done'", [id])
  if (!r) throw fail(404, 'Backup not found')
  const name = r.s3_key.slice(PREFIX.length)
  const url = await presignPrivateGet({ key: r.s3_key, downloadName: name, mimeType: 'application/gzip', expiresIn: 300 })
  await audit(req, { action: 'backup.download', targetType: 'backup', targetId: r.id, details: { file: name } })
  return { url, file_name: name, expires_in: 300 }
}
