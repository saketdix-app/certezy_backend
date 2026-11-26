// src/modules/crm/recordings.service.js
// Lead call recordings. The phone's own dialer records calls; the Team app
// finds the recordings of calls with a lead, and uploads only those, straight
// to a private S3 folder (call-recordings/…, never public).
//   • Consultants can upload recordings of their own leads' calls, nothing else.
//   • Only Super Admins can list, play, download or delete recordings; every
//     play / download / delete is written to the audit log.

import { randomUUID } from 'node:crypto'
import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { IST } from '../../utils/ist.js'
import { deleteFile, isConfigured, objectSize, presignPrivateGet, presignPrivatePut } from '../../utils/upload.js'
import { scopeFor } from './leads.service.js'
import { istRange } from './teamReports.service.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const toSql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')
const n = (v) => Number(v ?? 0)

const EXT = { 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/amr': 'amr', 'audio/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm' }
const AUDIO_EXT = new Set(['m4a', 'aac', 'mp3', 'amr', '3gp', '3gpp', 'ogg', 'opus', 'wav', 'webm', 'mp4', 'awb'])

const assertSuperAdmin = (actor) => {
  if (actor?.role !== 'super_admin') throw fail(403, 'Call recordings are for Super Admins only')
}
const assertStorage = () => {
  if (!isConfigured()) throw fail(503, 'File storage (S3) is not set up on the server')
}

/** Phone → server: "I have this recording for this lead call" → a signed upload link (or "already have it"). */
export const startUpload = async (req, body) => {
  const actor = req.user
  assertStorage()
  const ext = (body.file_name.split('.').pop() || '').toLowerCase()
  const mime = String(body.mime || '').toLowerCase()
  if (!mime.startsWith('audio/') && !AUDIO_EXT.has(ext)) throw fail(400, 'Only audio recordings can be uploaded')
  const callAt = new Date(body.call_at)
  if (callAt > Date.now() + 10 * 60e3 || callAt < Date.now() - 60 * 864e5) throw fail(400, 'That call is too old or in the future')

  // Only a lead this person can see
  const scope = scopeFor(actor)
  const [[lead]] = await pool.query(`SELECT l.id FROM leads l WHERE l.id = ? AND ${scope.sql} AND l.archived_at IS NULL`, [body.lead_id, ...scope.values])
  if (!lead) throw fail(404, 'Lead not found')

  const [[existing]] = await pool.query(
    'SELECT id, status, s3_key FROM lead_call_recordings WHERE user_id = ? AND file_name = ? AND size_bytes = ?',
    [actor.id, body.file_name, body.size_bytes]
  )
  if (existing?.status === 'uploaded') return { exists: true, id: existing.id }

  const safeMime = mime.startsWith('audio/') ? mime : 'audio/mp4'
  const fileExt = AUDIO_EXT.has(ext) ? ext : EXT[safeMime] || 'm4a'
  const local = new Date(callAt.getTime() + 330 * 60e3).toISOString()
  const key = existing?.s3_key ?? `call-recordings/${local.slice(0, 4)}/${local.slice(5, 7)}/u${actor.id}/l${lead.id}-${local.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${randomUUID().slice(0, 8)}.${fileExt}`
  let id = existing?.id
  if (existing) {
    await pool.query('UPDATE lead_call_recordings SET lead_id = ?, call_at = ?, direction = ?, duration_sec = ?, mime = ? WHERE id = ?', [
      lead.id, toSql(callAt), body.direction ?? null, body.duration_sec ?? 0, safeMime, id,
    ])
  } else {
    const [r] = await pool.query(
      `INSERT INTO lead_call_recordings (lead_id, user_id, call_at, direction, duration_sec, file_name, size_bytes, mime, s3_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lead.id, actor.id, toSql(callAt), body.direction ?? null, body.duration_sec ?? 0, body.file_name, body.size_bytes, safeMime, key]
    )
    id = r.insertId
  }
  const { signedUrl, headers } = await presignPrivatePut({ key, mimeType: safeMime })
  return { exists: false, id, upload_url: signedUrl, headers }
}

/** Phone → server after the PUT: check the file really is in S3, then mark it uploaded. */
export const finishUpload = async (req, id) => {
  const actor = req.user
  assertStorage()
  const [[rec]] = await pool.query('SELECT * FROM lead_call_recordings WHERE id = ? AND user_id = ?', [id, actor.id])
  if (!rec) throw fail(404, 'Recording not found')
  if (rec.status === 'uploaded') return { id: rec.id, uploaded: true }
  const size = await objectSize(rec.s3_key)
  if (!size) throw fail(409, 'The file has not reached storage yet')
  // size_bytes stays as the phone reported it: it's how a re-sent file is recognised
  await pool.query("UPDATE lead_call_recordings SET status = 'uploaded', uploaded_at = UTC_TIMESTAMP() WHERE id = ?", [rec.id])
  return { id: rec.id, uploaded: true }
}

const ids = (v) =>
  String(v ?? '')
    .split(',')
    .map(Number)
    .filter((x) => Number.isInteger(x) && x > 0)

/** Super Admins: recordings in a period (IST days), newest first. */
export const listRecordings = async (actor, q = {}) => {
  assertSuperAdmin(actor)
  const range = istRange({ from: q.from, to: q.to })
  const where = ["r.status = 'uploaded'", 'r.deleted_at IS NULL', 'r.call_at >= ?', 'r.call_at < ?']
  const values = [range.start, range.end]
  const users = ids(q.user_ids)
  if (users.length) {
    where.push('r.user_id IN (?)')
    values.push(users)
  }
  if (Number(q.lead_id) > 0) {
    where.push('r.lead_id = ?')
    values.push(Number(q.lead_id))
  }
  if (['incoming', 'outgoing'].includes(q.direction)) {
    where.push('r.direction = ?')
    values.push(q.direction)
  }
  if (Number(q.min_duration) > 0) {
    where.push('r.duration_sec >= ?')
    values.push(Math.round(Number(q.min_duration)))
  }
  if (q.search) {
    const s = `%${String(q.search).trim()}%`
    const digits = String(q.search).replace(/\D/g, '')
    where.push(`(l.name LIKE ?${digits.length >= 4 ? ' OR l.phone LIKE ?' : ''})`)
    values.push(s, ...(digits.length >= 4 ? [`%${digits}%`] : []))
  }
  const W = where.join(' AND ')
  const page = Math.max(1, Number(q.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 25))
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(r.duration_sec), 0) AS seconds, COALESCE(SUM(r.size_bytes), 0) AS bytes
     FROM lead_call_recordings r JOIN leads l ON l.id = r.lead_id WHERE ${W}`,
    values
  )
  const [rows] = await pool.query(
    `SELECT r.id, r.lead_id, l.name AS lead_name, l.phone AS lead_phone, l.stage AS lead_stage,
            r.user_id, u.name AS user_name, r.call_at, r.direction, r.duration_sec, r.size_bytes, r.mime, r.uploaded_at
     FROM lead_call_recordings r
     JOIN leads l ON l.id = r.lead_id
     LEFT JOIN users u ON u.id = r.user_id
     WHERE ${W}
     ORDER BY r.call_at DESC, r.id DESC
     LIMIT ? OFFSET ?`,
    [...values, limit, (page - 1) * limit]
  )
  return {
    period: { from: range.from, to: range.to, timezone: IST },
    recordings: rows.map((r) => ({
      ...r,
      call_at: new Date(r.call_at).toISOString(),
      uploaded_at: r.uploaded_at ? new Date(r.uploaded_at).toISOString() : null,
      duration_sec: n(r.duration_sec),
      size_bytes: n(r.size_bytes),
    })),
    totals: { recordings: n(t.total), seconds: n(t.seconds), bytes: n(t.bytes) },
    pagination: { page, limit, total: n(t.total), totalPages: Math.max(1, Math.ceil(n(t.total) / limit)) },
  }
}

const fileNameFor = (r) => {
  const local = new Date(new Date(r.call_at).getTime() + 330 * 60e3).toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  const ext = r.s3_key.split('.').pop()
  return `${(r.lead_name || `lead-${r.lead_id}`).replace(/[^\w\- ]/g, '').trim() || 'lead'} - ${r.user_name || 'consultant'} - ${local} IST.${ext}`
}

/** Super Admins: a 10-minute link to play (or download) one recording. Audited. */
export const recordingLink = async (req, id, { download = false } = {}) => {
  assertSuperAdmin(req.user)
  assertStorage()
  const [[r]] = await pool.query(
    `SELECT r.*, l.name AS lead_name, u.name AS user_name FROM lead_call_recordings r
     JOIN leads l ON l.id = r.lead_id LEFT JOIN users u ON u.id = r.user_id
     WHERE r.id = ? AND r.status = 'uploaded' AND r.deleted_at IS NULL`,
    [id]
  )
  if (!r) throw fail(404, 'Recording not found')
  const name = fileNameFor(r)
  const url = await presignPrivateGet({ key: r.s3_key, mimeType: r.mime, ...(download && { downloadName: name }) })
  await audit(req, {
    action: download ? 'call_recording.download' : 'call_recording.play',
    targetType: 'lead',
    targetId: r.lead_id,
    details: { recording_id: r.id },
  })
  return { url, file_name: name, expires_in: 600 }
}

/** Super Admins: delete a recording (file and record). Audited. */
export const deleteRecording = async (req, id) => {
  assertSuperAdmin(req.user)
  assertStorage()
  const [[r]] = await pool.query('SELECT id, lead_id, s3_key FROM lead_call_recordings WHERE id = ? AND deleted_at IS NULL', [id])
  if (!r) throw fail(404, 'Recording not found')
  await deleteFile(r.s3_key)
  await pool.query('UPDATE lead_call_recordings SET deleted_at = UTC_TIMESTAMP(), deleted_by = ? WHERE id = ?', [req.user.id, r.id])
  await audit(req, { action: 'call_recording.delete', targetType: 'lead', targetId: r.lead_id, details: { recording_id: r.id } })
  return { deleted: true }
}
