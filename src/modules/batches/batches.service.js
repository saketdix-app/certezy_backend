// src/modules/batches/batches.service.js
// Live batches (instructor-led, by our certified trainers):
//   • Admins add batches (draft → published → closed / cancelled).
//   • Published batches that haven't started show on the website with an Enroll form.
//   • Each enrollment is stored with the batch AND becomes a CRM lead (source
//     "website", same intake as the other forms: duplicate check, Round Robin),
//     so Admins can assign a batch's enrollments to consultants in one go.

import crypto from 'node:crypto'
import { pool } from '../../config/db.js'
import { managerIds, notify } from '../../utils/notify.js'
import { audit } from '../../utils/audit.js'
import { processEvent, recordEvent } from '../integrations/ingest.service.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
export const BATCH_STATUSES = ['draft', 'published', 'closed', 'cancelled']
export const BATCH_MODES = ['online', 'classroom', 'hybrid']
const FIELDS = [
  'title', 'course_id', 'trainer_name', 'trainer_title', 'start_date', 'end_date', 'schedule', 'timezone',
  'mode', 'location', 'seats', 'price', 'currency', 'description', 'status',
]
// DATE columns come back as local-midnight Dates: format by local parts (no UTC shift)
const day = (d) => {
  if (!d) return null
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return String(d).slice(0, 10)
}
const today = () => day(new Date())

const shape = (b) => ({
  ...b,
  start_date: day(b.start_date),
  end_date: day(b.end_date),
  price: b.price == null ? null : Number(b.price),
  seats: b.seats == null ? null : Number(b.seats),
  enrolled: Number(b.enrolled ?? 0),
  seats_left: b.seats == null ? null : Math.max(0, Number(b.seats) - Number(b.enrolled ?? 0)),
})

const COUNT = '(SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id)'

// ── Public ────────────────────────────────────────────────────────────────

/** Published batches that start today or later, soonest first. */
export const upcomingBatches = async () => {
  const [rows] = await pool.query(
    `SELECT b.id, b.title, b.course_id, c.title AS course_title, c.slug AS course_slug, b.trainer_name, b.trainer_title,
            b.start_date, b.end_date, b.schedule, b.timezone, b.mode, b.location, b.seats, b.price, b.currency,
            b.description, ${COUNT} AS enrolled
     FROM live_batches b LEFT JOIN courses c ON c.id = b.course_id
     WHERE b.status = 'published' AND b.start_date >= CURDATE()
     ORDER BY b.start_date ASC, b.id ASC LIMIT 50`
  )
  return rows.map(shape)
}

/** Enroll form → enrollment + CRM lead. A filled honeypot ("website") is a bot. */
export const enroll = async (batchId, body, { ip = null, userAgent = null } = {}) => {
  if (body.website) return { ok: true }
  const [[b]] = await pool.query(
    `SELECT b.*, ${COUNT} AS enrolled FROM live_batches b WHERE b.id = ? LIMIT 1`,
    [batchId]
  )
  if (!b || b.status !== 'published') throw fail(404, 'This batch is not open for enrollment')
  if (day(b.start_date) < today()) throw fail(409, 'This batch has already started')

  const email = body.email.trim().toLowerCase()
  const phone = body.phone.trim()
  const digits = phone.replace(/\D/g, '').slice(-10)
  // Same person enrolling twice: no second seat, just a friendly answer
  const [[again]] = await pool.query(
    `SELECT id FROM batch_enrollments WHERE batch_id = ? AND (LOWER(email) = ? OR phone_norm = ?) LIMIT 1`,
    [b.id, email, digits]
  )
  if (again) return { ok: true, already: true }
  if (b.seats != null && Number(b.enrolled) >= Number(b.seats)) throw fail(409, 'Sorry, this batch is full')

  const [ins] = await pool.query(
    `INSERT INTO batch_enrollments (batch_id, name, email, phone, phone_norm, company, experience_years, message, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.id, body.name.trim(), email, phone, digits, body.company?.trim() || null, body.experience_years ?? null,
      body.message?.trim() || null, ip, userAgent?.slice(0, 200) ?? null]
  )

  // Same intake pipeline as the other website forms (duplicates, Round Robin)
  const ref = `batch-${crypto.randomUUID()}`
  const answers = Object.fromEntries(
    Object.entries({
      batch: `${b.title} (starts ${day(b.start_date)})`,
      schedule: b.schedule,
      company: body.company,
      experience_years: body.experience_years,
      message: body.message,
    }).filter(([, v]) => v !== undefined && v !== null && v !== '')
  )
  const { id: eventId } = await recordEvent('website', ref, {
    lead: {
      name: body.name.trim(),
      email,
      phone,
      course_id: b.course_id ?? null,
      platform_lead_id: ref,
      source_meta: { form: 'Live batch enrollment', batch_id: b.id, page: '/pmp', answers },
      consent: { platform: 'website', note: `Enrolled for the live batch "${b.title}"`, at: new Date().toISOString(), ip, user_agent: userAgent?.slice(0, 200) ?? null },
    },
  })
  await processEvent(eventId).catch((err) => console.error('Batch enrollment → lead failed (kept for retry):', err.message))
  const [[ev]] = await pool.query('SELECT lead_id FROM lead_ingest_events WHERE id = ? LIMIT 1', [eventId])
  await pool.query('UPDATE batch_enrollments SET lead_id = ?, ingest_event_id = ? WHERE id = ?', [ev?.lead_id ?? null, eventId, ins.insertId])

  await notify(await managerIds(), {
    type: 'batch_enrollment',
    title: `New enrollment: ${b.title}`,
    body: `${body.name.trim()} · starts ${day(b.start_date)}`,
    link: `/admin/live-batches?batch=${b.id}`,
  }).catch(() => {})
  return { ok: true }
}

// ── Admin ─────────────────────────────────────────────────────────────────

export const listBatches = async () => {
  const [rows] = await pool.query(
    `SELECT b.*, c.title AS course_title, u.name AS created_by_name, ${COUNT} AS enrolled,
            (SELECT COUNT(*) FROM batch_enrollments e JOIN leads l ON l.id = e.lead_id
              WHERE e.batch_id = b.id AND l.owner_id IS NULL) AS unassigned
     FROM live_batches b
     LEFT JOIN courses c ON c.id = b.course_id
     LEFT JOIN users u ON u.id = b.created_by
     ORDER BY (b.status = 'published' AND b.start_date >= CURDATE()) DESC, b.start_date DESC, b.id DESC`
  )
  return rows.map((r) => ({ ...shape(r), unassigned: Number(r.unassigned ?? 0) }))
}

const clean = (body) => {
  const out = {}
  for (const k of FIELDS) {
    if (body[k] === undefined) continue
    const v = body[k]
    out[k] = typeof v === 'string' ? v.trim() || null : v
  }
  // Joi turns "2026-12-05" into a UTC-midnight Date: take the UTC day
  const inDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))
  if (out.start_date) out.start_date = inDay(out.start_date)
  if (out.end_date) out.end_date = inDay(out.end_date)
  return out
}

const checkDates = (b) => {
  if (b.end_date && b.start_date && b.end_date < b.start_date) throw fail(400, 'The end date is before the start date')
}

export const createBatch = async (req, body) => {
  const b = clean(body)
  checkDates(b)
  const cols = Object.keys(b)
  const [r] = await pool.query(
    `INSERT INTO live_batches (${cols.join(', ')}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
    [...cols.map((c) => b[c]), req.user.id]
  )
  await audit(req, { action: 'batch.create', targetType: 'batch', targetId: r.insertId, details: { title: b.title, status: b.status } })
  return getBatch(r.insertId)
}

export const getBatch = async (id) => {
  const [[b]] = await pool.query(
    `SELECT b.*, c.title AS course_title, ${COUNT} AS enrolled FROM live_batches b LEFT JOIN courses c ON c.id = b.course_id WHERE b.id = ? LIMIT 1`,
    [id]
  )
  if (!b) throw fail(404, 'Batch not found')
  return shape(b)
}

export const updateBatch = async (req, id, body) => {
  const current = await getBatch(id)
  const b = clean(body)
  checkDates({ ...current, ...b })
  if (b.seats != null && b.seats < current.enrolled) throw fail(409, `${current.enrolled} people have already enrolled; seats can't be lower`)
  const cols = Object.keys(b)
  if (cols.length) {
    await pool.query(`UPDATE live_batches SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => b[c]), id])
  }
  await audit(req, { action: 'batch.update', targetType: 'batch', targetId: Number(id), details: { fields: cols, status: b.status } })
  return getBatch(id)
}

/** Only batches nobody enrolled in can be deleted; otherwise close or cancel them. */
export const deleteBatch = async (req, id) => {
  const b = await getBatch(id)
  if (b.enrolled > 0) throw fail(409, 'People have enrolled in this batch — close or cancel it instead')
  await pool.query('DELETE FROM live_batches WHERE id = ?', [id])
  await audit(req, { action: 'batch.delete', targetType: 'batch', targetId: Number(id), details: { title: b.title } })
  return { id: Number(id), deleted: true }
}

/** Everyone who enrolled in a batch, with their CRM lead (owner, stage). */
export const batchEnrollments = async (id) => {
  const batch = await getBatch(id)
  const [rows] = await pool.query(
    `SELECT e.id, e.name, e.email, e.phone, e.company, e.experience_years, e.message, e.created_at, e.lead_id,
            l.stage, l.owner_id, u.name AS owner_name, l.next_follow_up_at, l.payment_status
     FROM batch_enrollments e
     LEFT JOIN leads l ON l.id = e.lead_id
     LEFT JOIN users u ON u.id = l.owner_id
     WHERE e.batch_id = ?
     ORDER BY e.id DESC`,
    [id]
  )
  return { batch, enrollments: rows }
}
