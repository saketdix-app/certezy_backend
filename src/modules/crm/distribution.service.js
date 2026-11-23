// src/modules/crm/distribution.service.js
// 2.0 Phase 4 — lead distribution (PRD §6): Round Robin pools, unassigned
// queue, manual assignment, transfer, bulk rebalance and reports.
//
// Round Robin (PRD §6.2): each pool keeps a rotation cursor. To assign, lock
// the pool row (SELECT … FOR UPDATE), take the next eligible consultant after
// the cursor, save the owner + assignment event, move the cursor — all in one
// transaction, so simultaneous leads never get the same turn.
// Eligible = active consultant, receiving leads, not on leave, under the daily
// and open-lead limits (PRD §6.1). Skipped consultants are recorded.
// No one eligible → the lead waits in the unassigned queue and Admins are told.
// Manual assignment and transfers never move the cursor (PRD §6.5).

import { pool } from '../../config/db.js'
import { audit } from '../../utils/audit.js'
import { managerIds, notify } from '../../utils/notify.js'
import { CLOSED_STAGES, POOL_RULE_KEYS, SOURCES } from './crm.constants.js'
import { todayBounds } from './leads.service.js'
import { can, canAssignLeads } from '../../utils/access.js'

const fail = (statusCode, message, extra) => Object.assign(new Error(message), { statusCode }, extra)
const MANAGERS = ['super_admin', 'admin']
// Admins, and Sub-Admins with CRM access + "Lead assignment" (Team → Permissions)
const assertManager = (actor) => {
  if (!canAssignLeads(actor)) throw fail(403, 'Only Admins manage lead distribution')
}
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null)
const OPEN_STAGES_SQL = `l.stage NOT IN ('not_interested', 'junk', 'course_done')`

// ── Settings ──────────────────────────────────────────────────────────────

export const isRoundRobinOn = async (db = pool) => {
  const [[row]] = await db.query("SELECT value FROM crm_settings WHERE setting = 'round_robin_enabled'")
  return row?.value === '1'
}

export const setRoundRobin = async (req, enabled) => {
  assertManager(req.user)
  await pool.query(
    `INSERT INTO crm_settings (setting, value, updated_by) VALUES ('round_robin_enabled', ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
    [enabled ? '1' : '0', req.user.id]
  )
  await audit(req, { action: enabled ? 'distribution.enable' : 'distribution.disable', targetType: 'crm' })
  return { round_robin_enabled: Boolean(enabled) }
}

// ── Pools ─────────────────────────────────────────────────────────────────

const normalizeRules = (rules = {}) => {
  const out = {}
  if (rules.course_ids?.length) out.course_ids = [...new Set(rules.course_ids.map(Number))]
  if (rules.sources?.length) out.sources = rules.sources.filter((s) => SOURCES.includes(s))
  if (rules.campaigns?.length) out.campaigns = rules.campaigns.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
  return out
}

/** Does a lead match a pool's routing rules? (every rule given must match) */
export const poolMatches = (rules, lead) => {
  if (!rules) return false
  const keys = POOL_RULE_KEYS.filter((k) => rules[k]?.length)
  if (!keys.length) return false
  const campaign = String(parseJson(lead.source_meta)?.campaign ?? '').trim().toLowerCase()
  return keys.every((k) =>
    k === 'course_ids'
      ? rules.course_ids.includes(Number(lead.course_id))
      : k === 'sources'
        ? rules.sources.includes(lead.source)
        : rules.campaigns.includes(campaign)
  )
}

const loadPools = async (db = pool) => {
  const [pools] = await db.query('SELECT * FROM distribution_pools ORDER BY is_default ASC, priority ASC, id ASC')
  return pools.map((p) => ({ ...p, rules: parseJson(p.rules), enabled: Boolean(p.enabled), is_default: Boolean(p.is_default) }))
}

/** The pool a lead routes to: first matching custom pool, else the default. */
export const resolvePool = async (lead, db = pool) => {
  const pools = await loadPools(db)
  return pools.find((p) => !p.is_default && poolMatches(p.rules, lead)) ?? pools.find((p) => p.is_default) ?? null
}

/** Members in rotation order. The default pool = every active consultant. */
const poolMembers = async (p, db = pool) => {
  if (p.is_default) {
    const [rows] = await db.query(
      `SELECT id AS user_id FROM users
       WHERE role = 'consultant' AND is_active = 1 AND deleted_at IS NULL ORDER BY id`
    )
    return rows.map((r) => r.user_id)
  }
  const [rows] = await db.query(
    'SELECT user_id FROM distribution_pool_members WHERE pool_id = ? ORDER BY position, added_at, user_id',
    [p.id]
  )
  return rows.map((r) => r.user_id)
}

export const listPools = async (actor) => {
  assertManager(actor)
  const pools = await loadPools()
  const [names] = await pool.query("SELECT id, name FROM users WHERE role = 'consultant' AND deleted_at IS NULL")
  const nameOf = Object.fromEntries(names.map((u) => [u.id, u.name]))
  const out = []
  for (const p of pools) {
    const members = await poolMembers(p)
    out.push({
      ...p,
      members: members.map((id) => ({ id, name: nameOf[id] ?? `#${id}` })),
      next_up: p.cursor_user_id ? nameOf[p.cursor_user_id] ?? null : null,
    })
  }
  return { pools: out, round_robin_enabled: await isRoundRobinOn() }
}

export const savePool = async (req, id, { name, enabled, rules, priority, member_ids }) => {
  assertManager(req.user)
  const normalized = normalizeRules(rules)
  if (id) {
    const [[existing]] = await pool.query('SELECT * FROM distribution_pools WHERE id = ?', [id])
    if (!existing) throw fail(404, 'Pool not found')
    if (!existing.is_default && !Object.keys(normalized).length) {
      throw fail(400, 'Give the pool at least one rule (course, source or campaign)')
    }
    await pool.query(
      'UPDATE distribution_pools SET name = ?, enabled = ?, rules = ?, priority = ? WHERE id = ?',
      [
        name ?? existing.name,
        enabled === undefined ? existing.enabled : enabled ? 1 : 0,
        existing.is_default ? null : JSON.stringify(normalized),
        priority ?? existing.priority,
        id,
      ]
    )
  } else {
    if (!Object.keys(normalized).length) throw fail(400, 'Give the pool at least one rule (course, source or campaign)')
    const [r] = await pool.query(
      'INSERT INTO distribution_pools (name, enabled, rules, priority, created_by) VALUES (?, ?, ?, ?, ?)',
      [name, enabled === false ? 0 : 1, JSON.stringify(normalized), priority ?? 100, req.user.id]
    )
    id = r.insertId
  }
  // Members (custom pools only; the default pool is every consultant)
  const [[p]] = await pool.query('SELECT is_default FROM distribution_pools WHERE id = ?', [id])
  if (!p.is_default && Array.isArray(member_ids)) {
    await pool.query('DELETE FROM distribution_pool_members WHERE pool_id = ?', [id])
    if (member_ids.length) {
      await pool.query(
        `INSERT INTO distribution_pool_members (pool_id, user_id, position) VALUES ${member_ids.map(() => '(?, ?, ?)').join(', ')}`,
        member_ids.flatMap((uid, i) => [id, uid, i])
      )
    }
  }
  await audit(req, {
    action: 'distribution.pool_save',
    targetType: 'pool',
    targetId: id,
    details: { name, enabled, rules: normalized, member_ids },
  })
  return listPools(req.user)
}

export const deletePool = async (req, id) => {
  assertManager(req.user)
  const [[p]] = await pool.query('SELECT * FROM distribution_pools WHERE id = ?', [id])
  if (!p) throw fail(404, 'Pool not found')
  if (p.is_default) throw fail(400, "The default pool can't be deleted — turn it off instead")
  await pool.query('DELETE FROM distribution_pool_members WHERE pool_id = ?', [id])
  await pool.query('DELETE FROM distribution_pools WHERE id = ?', [id])
  await audit(req, { action: 'distribution.pool_delete', targetType: 'pool', targetId: Number(id), details: { name: p.name } })
  return listPools(req.user)
}

// ── Eligibility (PRD §6.1) ────────────────────────────────────────────────

/** Why a consultant can't take a lead now, or null if they can. */
export const ineligibleReason = async (userId, db = pool) => {
  const [[u]] = await db.query(
    `SELECT u.role, u.is_active, u.deleted_at, cs.accepting_leads, cs.on_leave_from, cs.on_leave_until, cs.daily_limit, cs.open_limit
     FROM users u LEFT JOIN consultant_settings cs ON cs.user_id = u.id WHERE u.id = ?`,
    [userId]
  )
  if (!u || u.role !== 'consultant' || !u.is_active || u.deleted_at) return 'inactive'
  if (u.accepting_leads === 0) return 'paused'
  const { start } = todayBounds()
  // On leave from (or now) until the end date — planned leave starts on its first day
  const today = start.slice(0, 10)
  const day = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10)
  if (u.on_leave_until && day(u.on_leave_until) >= today && (!u.on_leave_from || day(u.on_leave_from) <= today)) return 'on_leave'
  if (u.daily_limit != null) {
    const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM leads WHERE owner_id = ? AND assigned_at >= ?', [userId, start])
    if (n >= u.daily_limit) return 'daily_limit'
  }
  if (u.open_limit != null) {
    const [[{ n }]] = await db.query(
      `SELECT COUNT(*) AS n FROM leads l WHERE l.owner_id = ? AND l.archived_at IS NULL AND ${OPEN_STAGES_SQL}`,
      [userId]
    )
    if (n >= u.open_limit) return 'open_limit'
  }
  return null
}

/** Next eligible member after the cursor (wrapping), and who was skipped. */
export const pickNext = async (members, cursorUserId, db = pool) => {
  if (!members.length) return { pick: null, skipped: [] }
  const start = members.indexOf(cursorUserId) + 1 // -1 (unknown/none) → 0
  const skipped = []
  for (let i = 0; i < members.length; i++) {
    const uid = members[(start + i) % members.length]
    const why = await ineligibleReason(uid, db)
    if (!why) return { pick: uid, skipped }
    skipped.push({ user_id: uid, reason: why })
  }
  return { pick: null, skipped }
}

// ── Round Robin ───────────────────────────────────────────────────────────

/**
 * Auto-assign one lead. Returns { assigned_to, pool, skipped } or
 * { assigned_to: null, reason } when it stays in the unassigned queue.
 * Already-owned leads are left alone (safe to call twice, e.g. on webhook retries).
 */
export const autoAssign = async (leadId, { req = null } = {}) => {
  if (!(await isRoundRobinOn())) return { assigned_to: null, reason: 'round_robin_off' }

  const conn = await pool.getConnection()
  let result
  try {
    await conn.beginTransaction()
    const [[lead]] = await conn.query('SELECT * FROM leads WHERE id = ? FOR UPDATE', [leadId])
    if (!lead || lead.owner_id || lead.archived_at || CLOSED_STAGES.includes(lead.stage)) {
      await conn.rollback()
      return { assigned_to: lead?.owner_id ?? null, reason: 'not_assignable' }
    }
    const target = await resolvePool(lead, conn)
    if (!target?.enabled) {
      await conn.rollback()
      result = { assigned_to: null, reason: 'pool_off', pool: target?.name }
    } else {
      // Lock the pool's cursor: concurrent leads take turns one after another
      const [[locked]] = await conn.query('SELECT cursor_user_id FROM distribution_pools WHERE id = ? FOR UPDATE', [target.id])
      const members = await poolMembers(target, conn)
      const { pick, skipped } = await pickNext(members, locked.cursor_user_id, conn)
      if (!pick) {
        await conn.rollback()
        result = { assigned_to: null, reason: members.length ? 'no_eligible_consultant' : 'empty_pool', pool: target.name, skipped }
      } else {
        await conn.query(
          'UPDATE leads SET owner_id = ?, assigned_by = NULL, assigned_at = UTC_TIMESTAMP() WHERE id = ?',
          [pick, lead.id]
        )
        await conn.query('UPDATE distribution_pools SET cursor_user_id = ? WHERE id = ?', [pick, target.id])
        await conn.query('INSERT INTO lead_activities (lead_id, actor_id, type, meta) VALUES (?, NULL, ?, ?)', [
          lead.id,
          'assignment',
          JSON.stringify({ how: 'round_robin', to: pick, pool: target.name, pool_id: target.id, skipped }),
        ])
        await conn.commit()
        result = { assigned_to: pick, pool: target.name, skipped }
      }
    }
  } catch (err) {
    await conn.rollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }

  if (result.assigned_to) {
    await notify(result.assigned_to, {
      type: 'lead_assigned',
      title: 'New lead assigned to you',
      body: `Lead #${leadId} via Round Robin (${result.pool})`,
      link: `/consultant/leads?lead=${leadId}`,
    })
    await audit(req, { action: 'lead.assign', targetType: 'lead', targetId: leadId, details: { how: 'round_robin', to: result.assigned_to, pool: result.pool, skipped: result.skipped } })
  } else if (['no_eligible_consultant', 'empty_pool'].includes(result.reason)) {
    // PRD §6.2 fallback: hold it and alert Admins rather than exceed limits
    await notify(await managerIds(), {
      type: 'lead_unassigned',
      title: 'A lead is waiting to be assigned',
      body: `Lead #${leadId}: no consultant in "${result.pool}" can take it (paused, on leave or at capacity).`,
      link: '/admin/leads?owner=unassigned',
    })
    await audit(req, { action: 'lead.unassigned', targetType: 'lead', targetId: leadId, result: 'failed', details: result })
  }
  return result
}

/** Distribute everything waiting in the unassigned queue (Admin button). */
export const distributeQueue = async (req) => {
  assertManager(req.user)
  if (!(await isRoundRobinOn())) throw fail(400, 'Turn Round Robin on first')
  const [rows] = await pool.query(
    `SELECT id FROM leads l WHERE l.owner_id IS NULL AND l.archived_at IS NULL AND ${OPEN_STAGES_SQL} ORDER BY id LIMIT 500`
  )
  let assigned = 0
  let waiting = 0
  for (const { id } of rows) {
    const r = await autoAssign(id, { req })
    if (r.assigned_to) assigned++
    else waiting++
  }
  return { assigned, waiting }
}

// ── Manual assignment, transfer, rebalance (PRD §6.3–6.4) ────────────────

const loadLeadsForMove = async (leadIds) => {
  if (!leadIds?.length) throw fail(400, 'Select at least one lead')
  const [rows] = await pool.query(
    `SELECT l.id, l.name, l.stage, l.owner_id, u.name AS owner_name,
            (SELECT COUNT(*) FROM lead_follow_ups f WHERE f.lead_id = l.id AND f.status = 'pending') AS pending_follow_ups
     FROM leads l LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.id IN (?) AND l.archived_at IS NULL`,
    [leadIds]
  )
  if (rows.length !== new Set(leadIds.map(Number)).size) throw fail(404, 'Some of these leads no longer exist')
  return rows
}

const assertOwner = async (ownerId) => {
  const [[u]] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ? AND deleted_at IS NULL', [ownerId])
  if (!u || !u.is_active || !['consultant', ...MANAGERS].includes(u.role)) {
    throw fail(400, 'Choose an active consultant or admin')
  }
  return u
}

/** What a bulk assign/transfer would do — shown before confirming. */
export const previewMove = async (actor, { lead_ids, owner_id }) => {
  assertManager(actor)
  const owner = await assertOwner(owner_id)
  const leads = await loadLeadsForMove(lead_ids)
  const why = owner.role === 'consultant' ? await ineligibleReason(owner.id) : null
  return {
    new_owner: { id: owner.id, name: owner.name, warning: why },
    leads: leads.map((l) => ({
      id: l.id,
      name: l.name,
      stage: l.stage,
      current_owner: l.owner_name ?? null,
      pending_follow_ups: Number(l.pending_follow_ups),
      change: l.owner_id === owner.id ? 'no_change' : l.owner_id ? 'transfer' : 'assign',
    })),
    needs_reason: leads.some((l) => l.owner_id && l.owner_id !== owner.id),
  }
}

/**
 * Assign unassigned leads / transfer owned ones to `owner_id`. Transfers need
 * a reason. Pending follow-ups move with the lead; history is kept; the
 * Round Robin cursor is not touched.
 */
export const moveLeads = async (req, { lead_ids, owner_id, owner_ids, reason, mode }) => {
  assertManager(req.user)
  const ids = owner_ids?.length ? owner_ids : [owner_id]
  const owners = []
  for (const id of ids) owners.push(await assertOwner(id))
  const leads = await loadLeadsForMove(lead_ids)
  const why = String(reason ?? '').trim()
  const willTransfer = leads.some((l) => l.owner_id && !ids.includes(l.owner_id))
  if (willTransfer && !why) throw fail(400, 'Give a reason for transferring leads to another consultant')

  // Several owners: deal the leads out in turn (1st → A, 2nd → B, …) so everyone gets an even share
  const shares = owners.map(() => [])
  leads.forEach((l, i) => shares[i % owners.length].push(l))
  let moved = 0
  const per_owner = []
  for (let i = 0; i < owners.length; i++) {
    const n = await moveTo(req, owners[i], shares[i], why, mode)
    moved += n
    per_owner.push({ id: owners[i].id, name: owners[i].name, moved: n })
  }
  return { moved, unchanged: leads.length - moved, per_owner }
}

/** Move these leads to one owner: history, follow-ups and notifications. */
const moveTo = async (req, owner, leads, why, mode) => {
  const transfers = leads.filter((l) => l.owner_id && l.owner_id !== owner.id)
  const how = mode === 'rebalance' ? 'rebalance' : mode === 'handover' ? 'handover' : null
  let moved = 0
  for (const l of leads) {
    if (l.owner_id === owner.id) continue
    const kind = how ?? (l.owner_id ? 'transfer' : 'manual')
    await pool.query('UPDATE leads SET owner_id = ?, assigned_by = ?, assigned_at = UTC_TIMESTAMP() WHERE id = ?', [
      owner.id,
      req.user.id,
      l.id,
    ])
    await pool.query("UPDATE lead_follow_ups SET owner_id = ? WHERE lead_id = ? AND status = 'pending'", [owner.id, l.id])
    await pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, ?, ?, ?, ?)', [
      l.id,
      req.user.id,
      'assignment',
      why || null,
      JSON.stringify({ how: kind, from: l.owner_id, to: owner.id }),
    ])
    await audit(req, {
      action: kind === 'manual' ? 'lead.assign' : 'lead.transfer',
      targetType: 'lead',
      targetId: l.id,
      details: { how: kind, from: l.owner_id, to: owner.id, reason: why || undefined },
    })
    moved++
  }
  if (moved) {
    await notify(owner.id, {
      type: 'lead_assigned',
      title: moved === 1 ? 'A lead was assigned to you' : `${moved} leads were assigned to you`,
      body: why || null,
      link: owner.role === 'consultant' ? '/consultant/leads' : '/admin/leads',
    })
    const previous = [...new Set(transfers.map((l) => l.owner_id))]
    for (const prev of previous) {
      const n = transfers.filter((l) => l.owner_id === prev).length
      await notify(prev, {
        type: 'lead_transferred',
        title: n === 1 ? 'A lead was moved to another consultant' : `${n} leads were moved to another consultant`,
        body: `Now with ${owner.name}. Reason: ${why}`,
      })
    }
  }
  return moved
}

// ── Handover: someone leaves, is blocked or changes role ────────────────

const OPEN_FOR_HANDOVER = "l.stage NOT IN ('course_done', 'not_interested', 'junk')"

/** What this person still has: open leads they own, exams they coordinate. */
export const handoverSummary = async (actor, userId) => {
  // Read-only: also for Sub-Admins who manage the team (shown before blocking someone)
  if (!canAssignLeads(actor) && !can(actor, 'can_manage_team')) assertManager(actor)
  const [[u]] = await pool.query('SELECT id, name, role, is_active FROM users WHERE id = ? AND deleted_at IS NULL', [userId])
  if (!u) throw fail(404, 'Team member not found')
  const [[c]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM leads l WHERE l.owner_id = ? AND l.archived_at IS NULL AND ${OPEN_FOR_HANDOVER}) AS open_leads,
       (SELECT COUNT(*) FROM leads l WHERE l.owner_id = ? AND l.archived_at IS NULL) AS all_leads,
       (SELECT COUNT(*) FROM leads l WHERE l.exam_coordinator_id = ? AND l.archived_at IS NULL AND l.stage NOT IN ('course_done', 'not_interested', 'junk')) AS open_exams`,
    [u.id, u.id, u.id]
  )
  return {
    user: { id: u.id, name: u.name, role: u.role, is_active: Boolean(u.is_active) },
    open_leads: Number(c.open_leads),
    closed_leads: Number(c.all_leads) - Number(c.open_leads),
    open_exams: Number(c.open_exams),
    round_robin_enabled: await isRoundRobinOn(),
  }
}

/**
 * Hand someone's open leads to another owner (or Round Robin, or the
 * unassigned queue) and their open exams to another coordinator (or none).
 * Closed leads keep their owner for history.
 */
export const handoverFrom = async (req, userId, { owner_mode = 'keep', owner_id, coordinator_mode = 'keep', coordinator_id } = {}) => {
  assertManager(req.user)
  if (!['keep', 'owner', 'round_robin', 'unassigned'].includes(owner_mode)) throw fail(400, 'Choose what happens to their leads')
  if (!['keep', 'coordinator', 'unassigned'].includes(coordinator_mode)) throw fail(400, 'Choose what happens to their exams')
  const [[from]] = await pool.query('SELECT id, name FROM users WHERE id = ?', [userId])
  if (!from) throw fail(404, 'Team member not found')
  const why = `Handover from ${from.name}`
  const result = { leads_moved: 0, leads_unassigned: 0, leads_round_robin: 0, leads_waiting: 0, exams_moved: 0 }

  if (owner_mode !== 'keep') {
    if (owner_mode === 'owner' && Number(owner_id) === Number(from.id)) throw fail(400, 'Choose someone else to take the leads')
    const owner = owner_mode === 'owner' ? await assertOwner(owner_id) : null
    const [rows] = await pool.query(
      `SELECT l.id, l.name, l.stage, l.owner_id FROM leads l
       WHERE l.owner_id = ? AND l.archived_at IS NULL AND ${OPEN_FOR_HANDOVER} ORDER BY l.id`,
      [from.id]
    )
    if (owner) {
      result.leads_moved = await moveTo(req, owner, rows, why, 'handover')
    } else {
      for (const l of rows) {
        await pool.query('UPDATE leads SET owner_id = NULL, assigned_by = ?, assigned_at = NULL WHERE id = ?', [req.user.id, l.id])
        await pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, ?, ?, ?, ?)', [
          l.id,
          req.user.id,
          'assignment',
          why,
          JSON.stringify({ how: 'handover', from: from.id, to: null }),
        ])
        if (owner_mode === 'round_robin') {
          const r = await autoAssign(l.id, { req })
          if (r.assigned_to) result.leads_round_robin++
          else result.leads_waiting++
        } else {
          result.leads_unassigned++
        }
      }
      if (rows.length) {
        await audit(req, { action: 'lead.handover', targetType: 'user', targetId: from.id, details: { mode: owner_mode, leads: rows.length } })
      }
    }
  }

  if (coordinator_mode !== 'keep') {
    let to = null
    if (coordinator_mode === 'coordinator') {
      const [[c]] = await pool.query(
        "SELECT id, name FROM users WHERE id = ? AND role = 'exam_coordinator' AND is_active = 1 AND deleted_at IS NULL",
        [coordinator_id]
      )
      if (!c || c.id === from.id) throw fail(400, 'Choose another active exam coordinator')
      to = c.id
    }
    const [rows] = await pool.query(
      `SELECT l.id, l.name FROM leads l WHERE l.exam_coordinator_id = ? AND l.archived_at IS NULL AND l.stage NOT IN ('course_done', 'not_interested', 'junk')`,
      [from.id]
    )
    for (const l of rows) {
      await pool.query('UPDATE leads SET exam_coordinator_id = ?, exam_coordinator_assigned_at = ? WHERE id = ?', [
        to,
        to ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        l.id,
      ])
      await pool.query('INSERT INTO lead_activities (lead_id, actor_id, type, body, meta) VALUES (?, ?, ?, ?, ?)', [
        l.id,
        req.user.id,
        'exam_coordinator',
        why,
        JSON.stringify({ from: from.id, to }),
      ])
    }
    result.exams_moved = rows.length
    if (rows.length && to) {
      await notify(to, {
        type: 'exam_assigned',
        title: rows.length === 1 ? 'A student was handed to you for the exam' : `${rows.length} students were handed to you for the exam`,
        body: why,
        link: '/consultant/leads',
      })
    }
    if (rows.length) {
      await audit(req, { action: 'lead.exam_handover', targetType: 'user', targetId: from.id, details: { to, leads: rows.length } })
    }
  }
  return result
}

// ── Reports (PRD §6.3 distribution reports, §9.1) ────────────────────────

export const distributionReport = async (actor, { from, to } = {}) => {
  assertManager(actor)
  const toSql = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ')
  const fromSql = from ? toSql(from) : toSql(Date.now() - 30 * 86400e3)
  const toSqlEnd = to ? toSql(new Date(to).getTime() + 86400e3) : toSql(Date.now() + 60e3)
  const { start } = todayBounds()

  const [people] = await pool.query(
    `SELECT u.id, u.name, u.is_active, cs.accepting_leads, cs.on_leave_until, cs.daily_limit, cs.open_limit
     FROM users u LEFT JOIN consultant_settings cs ON cs.user_id = u.id
     WHERE u.role = 'consultant' AND u.deleted_at IS NULL ORDER BY u.name`
  )
  const [moves] = await pool.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(meta, '$.how')) AS how,
            CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.to')) AS UNSIGNED) AS to_id,
            CAST(JSON_UNQUOTE(JSON_EXTRACT(meta, '$.from')) AS UNSIGNED) AS from_id
     FROM lead_activities WHERE type = 'assignment' AND created_at >= ? AND created_at < ?`,
    [fromSql, toSqlEnd]
  )
  const [open] = await pool.query(
    `SELECT l.owner_id, COUNT(*) AS n FROM leads l
     WHERE l.owner_id IS NOT NULL AND l.archived_at IS NULL AND ${OPEN_STAGES_SQL} GROUP BY l.owner_id`
  )
  const [today] = await pool.query('SELECT owner_id, COUNT(*) AS n FROM leads WHERE assigned_at >= ? GROUP BY owner_id', [start])
  const [[{ unassigned }]] = await pool.query(
    `SELECT COUNT(*) AS unassigned FROM leads l WHERE l.owner_id IS NULL AND l.archived_at IS NULL AND ${OPEN_STAGES_SQL}`
  )
  const openOf = Object.fromEntries(open.map((r) => [r.owner_id, Number(r.n)]))
  const todayOf = Object.fromEntries(today.map((r) => [r.owner_id, Number(r.n)]))

  const rows = []
  for (const p of people) {
    const mine = moves.filter((m) => Number(m.to_id) === p.id)
    rows.push({
      id: p.id,
      name: p.name,
      state: await ineligibleReason(p.id),
      round_robin: mine.filter((m) => m.how === 'round_robin').length,
      manual: mine.filter((m) => ['manual', 'on_create'].includes(m.how)).length,
      transfers_in: mine.filter((m) => ['transfer', 'rebalance'].includes(m.how)).length,
      transfers_out: moves.filter((m) => Number(m.from_id) === p.id && ['transfer', 'rebalance'].includes(m.how)).length,
      open_leads: openOf[p.id] ?? 0,
      today: todayOf[p.id] ?? 0,
      daily_limit: p.daily_limit,
      open_limit: p.open_limit,
    })
  }
  return { from: fromSql, to: toSqlEnd, unassigned: Number(unassigned), round_robin_enabled: await isRoundRobinOn(), consultants: rows }
}
