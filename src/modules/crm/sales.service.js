// src/modules/crm/sales.service.js
// 2.0 Phase 5 — sales tracking (PRD §4.4, §9.1).
//
// Attribution (decided, PRD §10.3): when a payment is confirmed, the sale is
// credited to whoever owns the lead at that moment (SALE_ATTRIBUTION =
// 'owner_at_sale'), stored on the payment so later transfers don't move it.
// The lead is found through the discount link used (if it came from a lead),
// else the student's newest lead (same course first), else a lead with the
// student's email (which is then linked).
// A generated discount link is never a sale; only a confirmed payment is.

import { pool } from '../../config/db.js'
import { notify } from '../../utils/notify.js'
import { SALE_ATTRIBUTION } from './crm.constants.js'
import { onSale } from './automation.service.js'

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const MANAGERS = ['super_admin', 'admin']
const isManager = (actor) => MANAGERS.includes(actor?.role)
const ABANDONED_HOURS = 24

const findLeadForPayment = async (payment) => {
  if (payment.discount_link_id) {
    const [[d]] = await pool.query('SELECT lead_id FROM discount_links WHERE id = ?', [payment.discount_link_id])
    if (d?.lead_id) {
      const [[l]] = await pool.query('SELECT id, owner_id, user_id FROM leads WHERE id = ? AND archived_at IS NULL', [d.lead_id])
      if (l) return l
    }
  }
  const [[byUser]] = await pool.query(
    `SELECT id, owner_id, user_id FROM leads WHERE user_id = ? AND archived_at IS NULL
     ORDER BY (course_id = ?) DESC, id DESC LIMIT 1`,
    [payment.user_id, payment.course_id]
  )
  if (byUser) return byUser
  const [[byEmail]] = await pool.query(
    `SELECT l.id, l.owner_id, l.user_id FROM leads l JOIN users u ON u.id = ?
     WHERE l.email_norm = LOWER(u.email) AND l.user_id IS NULL AND l.archived_at IS NULL
     ORDER BY (l.course_id = ?) DESC, l.id DESC LIMIT 1`,
    [payment.user_id, payment.course_id]
  )
  if (byEmail) await pool.query('UPDATE leads SET user_id = ? WHERE id = ?', [payment.user_id, byEmail.id])
  return byEmail ?? null
}

/**
 * Credit a confirmed payment to the lead owner at sale time. Called right
 * after the payment is marked successful. Never throws — attribution must not
 * break a payment.
 */
export const attributeSale = async (paymentId) => {
  try {
    const [[payment]] = await pool.query('SELECT * FROM payments WHERE id = ?', [paymentId])
    if (!payment || payment.status !== 'success' || payment.lead_id) return null
    const lead = await findLeadForPayment(payment)
    if (!lead) return null
    await pool.query('UPDATE payments SET lead_id = ?, attributed_to = ?, attributed_at = UTC_TIMESTAMP() WHERE id = ?', [
      lead.id,
      lead.owner_id ?? null,
      payment.id,
    ])
    await pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, meta) VALUES (?, NULL, ?, ?)', [
      lead.id,
      'sale',
      JSON.stringify({
        payment_id: payment.id,
        amount: Number(payment.amount),
        currency: payment.currency,
        course_id: payment.course_id,
        credited_to: lead.owner_id ?? null,
        rule: SALE_ATTRIBUTION,
      }),
    ])
    if (lead.owner_id) {
      await notify(lead.owner_id, {
        type: 'sale',
        title: 'New sale on your lead 🎉',
        body: `${payment.currency} ${Number(payment.amount).toFixed(2)} — lead #${lead.id}`,
        link: `/consultant/leads?lead=${lead.id}`,
      })
    }
    await onSale(lead.id) // automation: paid → Application (if earlier)
    return { lead_id: lead.id, attributed_to: lead.owner_id ?? null }
  } catch (err) {
    console.error(`Sale attribution for payment ${paymentId} failed:`, err.message)
    return null
  }
}

// ── Reports ───────────────────────────────────────────────────────────────

const toSql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')

/** Who the report covers: a consultant → themselves; an Admin → everyone or one owner. */
const ownerScope = (actor, ownerId) => {
  if (!isManager(actor)) return [actor.id]
  return ownerId ? [Number(ownerId)] : null // null = all
}

const groupMoney = (rows) => {
  const out = {}
  for (const r of rows) out[r.currency] = Math.round(Number(r.amount) * 100) / 100
  return out
}

export const salesReport = async (actor, { from, to, owner_id } = {}) => {
  if (!isManager(actor) && actor?.role !== 'consultant') throw fail(403, 'Sales reports are for consultants and admins')
  const owners = ownerScope(actor, owner_id)
  const start = from ? toSql(from) : toSql(Date.now() - 30 * 86400e3)
  const end = to ? toSql(new Date(to).getTime() + 86400e3) : toSql(Date.now() + 60e3)

  // Paid sales: credited owner (fixed at sale time)
  const paidWhere = `p.status = 'success' AND p.lead_id IS NOT NULL AND p.created_at >= ? AND p.created_at < ?${owners ? ' AND p.attributed_to IN (?)' : ''}`
  const paidValues = owners ? [start, end, owners] : [start, end]

  const [[paid]] = await pool.query(`SELECT COUNT(*) AS n FROM payments p WHERE ${paidWhere}`, paidValues)
  const [revenue] = await pool.query(
    `SELECT p.currency, SUM(p.amount) AS amount FROM payments p WHERE ${paidWhere} GROUP BY p.currency`,
    paidValues
  )
  const [gross] = await pool.query(
    `SELECT p.currency, SUM(COALESCE(p.original_amount, p.amount)) AS amount FROM payments p WHERE ${paidWhere} GROUP BY p.currency`,
    paidValues
  )
  const [byCourse] = await pool.query(
    `SELECT c.title, p.currency, COUNT(*) AS sales, SUM(p.amount) AS amount
     FROM payments p LEFT JOIN courses c ON c.id = p.course_id
     WHERE ${paidWhere} GROUP BY c.title, p.currency ORDER BY sales DESC`,
    paidValues
  )
  const [bySource] = await pool.query(
    `SELECT l.source, p.currency, COUNT(*) AS sales, SUM(p.amount) AS amount
     FROM payments p JOIN leads l ON l.id = p.lead_id
     WHERE ${paidWhere} GROUP BY l.source, p.currency ORDER BY sales DESC`,
    paidValues
  )
  const [byConsultant] = isManager(actor)
    ? await pool.query(
        `SELECT p.attributed_to AS id, u.name, p.currency, COUNT(*) AS sales, SUM(p.amount) AS amount
         FROM payments p LEFT JOIN users u ON u.id = p.attributed_to
         WHERE ${paidWhere} GROUP BY p.attributed_to, u.name, p.currency ORDER BY sales DESC`,
        paidValues
      )
    : [[]]
  const [recent] = await pool.query(
    `SELECT p.id, p.amount, p.original_amount, p.currency, p.method, p.gateway_txn_id, p.created_at, p.discount_link_id,
            p.lead_id, l.name AS lead_name, c.title AS course_title, u.name AS credited_to
     FROM payments p LEFT JOIN leads l ON l.id = p.lead_id LEFT JOIN courses c ON c.id = p.course_id
     LEFT JOIN users u ON u.id = p.attributed_to
     WHERE ${paidWhere} ORDER BY p.id DESC LIMIT 25`,
    paidValues
  )

  // Every payment state, for students on leads in scope (PRD §4.4: shown separately)
  const leadScope = owners ? 'l.owner_id IN (?)' : '1 = 1'
  const [states] = await pool.query(
    `SELECT CASE
              WHEN p.status = 'pending' AND p.created_at < UTC_TIMESTAMP() - INTERVAL ${ABANDONED_HOURS} HOUR THEN 'cancelled'
              ELSE p.status END AS state,
            COUNT(*) AS n
     FROM payments p
     WHERE p.created_at >= ? AND p.created_at < ?
       AND (p.lead_id IS NOT NULL ${owners ? 'AND p.attributed_to IN (?)' : ''}
            OR (p.status <> 'success' AND EXISTS (SELECT 1 FROM leads l WHERE l.user_id = p.user_id AND ${leadScope} AND l.archived_at IS NULL)))
     GROUP BY state`,
    owners ? [start, end, owners, owners] : [start, end]
  )

  // Conversion: leads created in the period that ended in a paid sale
  const [[conv]] = await pool.query(
    `SELECT COUNT(*) AS leads,
            SUM(EXISTS (SELECT 1 FROM payments p WHERE p.lead_id = l.id AND p.status = 'success')) AS converted
     FROM leads l WHERE l.created_at >= ? AND l.created_at < ? AND l.archived_at IS NULL ${owners ? 'AND l.owner_id IN (?)' : ''}`,
    owners ? [start, end, owners] : [start, end]
  )

  // Discount links (generated ≠ sold)
  const [[links]] = await pool.query(
    `SELECT COUNT(*) AS generated,
            SUM(d.click_count > 0) AS clicked,
            SUM(d.is_used = 1) AS redeemed,
            SUM(d.revoked_at IS NOT NULL AND d.is_used = 0) AS revoked,
            SUM(d.is_used = 0 AND d.revoked_at IS NULL AND d.expires_at < UTC_TIMESTAMP()) AS expired
     FROM discount_links d WHERE d.created_at >= ? AND d.created_at < ? ${owners ? 'AND d.created_by IN (?)' : ''}`,
    owners ? [start, end, owners] : [start, end]
  )
  const [linkRevenue] = await pool.query(
    `SELECT p.currency, SUM(p.amount) AS amount FROM payments p JOIN discount_links d ON d.id = p.discount_link_id
     WHERE ${paidWhere} GROUP BY p.currency`,
    paidValues
  )

  const n = (v) => Number(v ?? 0)
  const stateCounts = Object.fromEntries(['success', 'pending', 'failed', 'refunded', 'cancelled'].map((s) => [s, 0]))
  for (const s of states) stateCounts[s.state] = n(s.n)
  return {
    period: { from: start, to: end },
    attribution: SALE_ATTRIBUTION,
    sales: n(paid.n),
    revenue: groupMoney(revenue),
    gross: groupMoney(gross),
    conversion: { leads: n(conv.leads), converted: n(conv.converted), rate: n(conv.leads) ? Math.round((n(conv.converted) / n(conv.leads)) * 1000) / 10 : 0 },
    payment_states: stateCounts,
    by_course: byCourse.map((r) => ({ ...r, sales: n(r.sales), amount: n(r.amount) })),
    by_source: bySource.map((r) => ({ ...r, sales: n(r.sales), amount: n(r.amount) })),
    by_consultant: byConsultant.map((r) => ({ ...r, sales: n(r.sales), amount: n(r.amount) })),
    discount_links: {
      generated: n(links.generated),
      clicked: n(links.clicked),
      redeemed: n(links.redeemed),
      expired: n(links.expired),
      revoked: n(links.revoked),
      revenue: groupMoney(linkRevenue),
    },
    recent,
  }
}
