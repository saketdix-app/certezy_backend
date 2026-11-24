// src/modules/crm/calls.service.js
// Team app call log → lead history. The phone matches calls to leads itself
// (using phoneIndex), so only calls with a lead's number ever leave the phone.

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { scopeFor } from './leads.service.js'

const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10)

const LABEL = {
  outgoing: 'Outgoing call',
  incoming: 'Incoming call',
  missed: 'Missed call from the lead',
  rejected: 'Declined call from the lead',
  unanswered: 'Call not answered',
}

const fmtDuration = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0))
  if (!n) return ''
  const m = Math.floor(n / 60)
  return m ? `${m}m ${n % 60}s` : `${n}s`
}

/** The last 10 digits of each lead's phone / WhatsApp number this person can see. */
export const phoneIndex = async (actor) => {
  const scope = scopeFor(actor)
  const [rows] = await pool.query(
    `SELECT l.id, l.phone, l.whatsapp_number FROM leads l
     WHERE ${scope.sql} AND l.archived_at IS NULL AND (l.phone IS NOT NULL OR l.whatsapp_number IS NOT NULL)
     LIMIT 50000`,
    scope.values
  )
  return rows
    .map((r) => ({ id: r.id, p: last10(r.phone) || null, w: last10(r.whatsapp_number) || null }))
    .filter((r) => (r.p && r.p.length === 10) || (r.w && r.w.length === 10))
}

/**
 * Record calls the app matched to leads. Each call is recorded once (same
 * lead + same call time), only on leads this person can see.
 */
export const syncCalls = async (req, { calls }) => {
  const actor = req.user
  if (!calls?.length) return { recorded: 0, skipped: 0 }
  const scope = scopeFor(actor)
  const ids = [...new Set(calls.map((c) => Number(c.lead_id)))]
  const [visible] = await pool.query(`SELECT l.id FROM leads l WHERE l.id IN (?) AND ${scope.sql} AND l.archived_at IS NULL`, [
    ids,
    ...scope.values,
  ])
  const allowed = new Set(visible.map((r) => r.id))
  const at = (c) => new Date(c.at).toISOString()

  // Already recorded (the app may send a call again after a lost connection)
  const keys = calls.filter((c) => allowed.has(Number(c.lead_id))).map((c) => `${Number(c.lead_id)}|${at(c)}`)
  const seen = new Set()
  if (keys.length) {
    const [done] = await pool.query(
      `SELECT lead_id, JSON_UNQUOTE(JSON_EXTRACT(meta, '$.call_at')) AS call_at FROM lead_activities
       WHERE type = 'call' AND lead_id IN (?) AND JSON_UNQUOTE(JSON_EXTRACT(meta, '$.source')) = 'call_log'`,
      [[...allowed]]
    )
    for (const d of done) seen.add(`${d.lead_id}|${d.call_at}`)
  }

  let recorded = 0
  let skipped = 0
  const contacted = new Set()
  for (const c of calls) {
    const leadId = Number(c.lead_id)
    const key = `${leadId}|${at(c)}`
    const when = new Date(c.at).getTime()
    // Not this person's lead, already recorded, or a time that can't be right (phone clock far off)
    if (!allowed.has(leadId) || seen.has(key) || when > Date.now() + 10 * 60e3 || when < Date.now() - 60 * 864e5) {
      skipped++
      continue
    }
    seen.add(key)
    const talked = ['incoming', 'outgoing'].includes(c.direction) && Number(c.duration_sec) > 0
    const direction = c.direction === 'outgoing' && !talked ? 'unanswered' : c.direction
    const length = fmtDuration(c.duration_sec)
    await pool.query(
      `INSERT INTO lead_activities (lead_id, actor_id, type, body, meta, created_at) VALUES (?, ?, 'call', ?, ?, ?)`,
      [
        leadId,
        actor.id,
        `${LABEL[direction] ?? 'Call'}${length ? ` · ${length}` : ''} (from the phone's call log)`,
        JSON.stringify({ source: 'call_log', direction, duration_sec: Math.round(Number(c.duration_sec) || 0), call_at: at(c) }),
        new Date(c.at),
      ]
    )
    if (talked) contacted.add(leadId)
    recorded++
  }
  if (contacted.size) {
    await pool.query('UPDATE leads SET first_contact_at = COALESCE(first_contact_at, UTC_TIMESTAMP()) WHERE id IN (?)', [[...contacted]])
  }
  if (recorded) await audit(req, { action: 'lead.calls_synced', targetType: 'user', targetId: actor.id, details: { recorded } })
  return { recorded, skipped }
}
