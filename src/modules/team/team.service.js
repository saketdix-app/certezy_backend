// src/modules/team/team.service.js
// 2.0 Phase 1 — staff accounts, Super Admin delegation and audit (PRD §1–3, §9.2).
//
// Rules (PRD recommended defaults):
//   • Super Admin creates/promotes anyone, manages Admins, grants/revokes
//     "super_admin.create" to Admins.
//   • Admin creates Sub-Admins and Consultants. With an active
//     super_admin.create grant, also Super Admins — but cannot pass the grant on.
//   • Grants, revocations, Super Admin creation/promotion need the actor's
//     password again (re-authentication) and notify every Super Admin.
//   • The last active Super Admin can't be deactivated or demoted; nobody
//     changes their own role or status.
//   • Every attempt, allowed or refused, goes to the audit log.

import bcrypt from 'bcryptjs'
import { pool } from '../../config/db.js'
import { DEFAULT_PERMISSIONS, PRIVILEGES, STAFF_PERMISSIONS, STAFF_ROLES } from '../../constants.js'
import { audit } from '../../utils/audit.js'
import { issuePasswordLink } from '../auth/passwordReset.js'
import { sendSecurityNoticeJob, sendStaffInviteJob } from '../../jobs/emailQueue.js'

const INVITE_HOURS = 72
const SUPER = 'super_admin'

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  sub_admin: 'Sub-Admin',
  consultant: 'Consultant',
  exam_coordinator: 'Exam Coordinator',
  student: 'Student',
}

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

// ── Lookups ───────────────────────────────────────────────────────────────

const getUser = async (id) => {
  const [[row]] = await pool.query(
    `SELECT id, name, email, password, role, is_active, deleted_at FROM users WHERE id = ? LIMIT 1`,
    [id]
  )
  return row ?? null
}

/** Active (not revoked) grant of a privilege, or null. */
export const activeGrant = async (userId, key) => {
  const [[row]] = await pool.query(
    `SELECT id, granted_by, granted_at FROM user_permission_grants
     WHERE user_id = ? AND permission_key = ? AND revoked_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [userId, key]
  )
  return row ?? null
}

const activeSuperAdmins = async () => {
  const [rows] = await pool.query(
    `SELECT id, name, email FROM users
     WHERE role = 'super_admin' AND is_active = 1 AND deleted_at IS NULL`
  )
  return rows
}

// ── Permission checks ─────────────────────────────────────────────────────

/** May `actor` create (or promote someone to) `role`? */
export const canAssignRole = async (actor, role) => {
  if (!actor?.is_active) return false
  if (actor.role === SUPER) return STAFF_ROLES.includes(role) || role === 'student'
  if (actor.role === 'admin') {
    if (['sub_admin', 'consultant', 'exam_coordinator'].includes(role)) return true
    // A disabled admin never gets here (is_active checked above)
    if (role === SUPER) return Boolean(await activeGrant(actor.id, PRIVILEGES.CREATE_SUPER_ADMIN))
  }
  return false
}

/** May `actor` change the role or status of `target` (as they are now)? */
const canManage = (actor, target) => {
  if (actor.role === SUPER) return true
  if (actor.role === 'admin') return ['sub_admin', 'consultant', 'exam_coordinator', 'student'].includes(target.role)
  return false
}

export const reauthenticate = async (actor, password) => {
  const fresh = await getUser(actor.id)
  if (!fresh?.password) {
    throw fail(400, 'Set a password on your account (Profile → Password) before making this change')
  }
  if (!password || !(await bcrypt.compare(String(password), fresh.password))) {
    throw fail(401, 'Your password is incorrect')
  }
}

export const notifySuperAdmins = async (title, lines, exceptId) => {
  for (const sa of await activeSuperAdmins()) {
    if (sa.id === exceptId) continue
    await sendSecurityNoticeJob({ to: sa.email, name: sa.name, title, lines }).catch((err) =>
      console.error('Security notice email failed:', err.message)
    )
  }
}

const denied = async (req, action, target, message, details) => {
  await audit(req, {
    action,
    targetType: 'user',
    targetId: target?.id ?? null,
    result: 'denied',
    details: { reason: message, ...details },
  })
  return fail(403, message)
}

// ── Team directory ────────────────────────────────────────────────────────

export const listTeam = async ({ role, status, search }) => {
  const where = ['u.deleted_at IS NULL', `u.role IN (${STAFF_ROLES.map(() => '?').join(', ')})`]
  const values = [...STAFF_ROLES]
  if (role && STAFF_ROLES.includes(role)) {
    where.push('u.role = ?')
    values.push(role)
  }
  if (status === 'active') where.push('u.is_active = 1')
  if (status === 'inactive') where.push('u.is_active = 0')
  if (search) {
    where.push('(u.name LIKE ? OR u.email LIKE ?)')
    values.push(`%${search}%`, `%${search}%`)
  }

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.mobile, u.role, u.is_active, u.created_at, u.last_active_at,
            (u.password IS NULL AND u.oauth_provider = 'local') AS invite_pending,
            g.granted_at AS sa_grant_at, gu.name AS sa_granted_by,
            ${STAFF_PERMISSIONS.map((k) => `p.${k}`).join(', ')},
            cs.accepting_leads, cs.paused_reason, cs.on_leave_from, cs.on_leave_until, cs.daily_limit, cs.open_limit,
            (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.archived_at IS NULL
               AND l.stage NOT IN ('course_done', 'not_interested', 'junk')) AS open_leads,
            (SELECT COUNT(*) FROM leads l WHERE l.exam_coordinator_id = u.id AND l.archived_at IS NULL
               AND l.stage NOT IN ('course_done', 'not_interested', 'junk')) AS open_exams
     FROM users u
     LEFT JOIN admin_permissions p ON p.user_id = u.id
     LEFT JOIN consultant_settings cs ON cs.user_id = u.id
     LEFT JOIN user_permission_grants g
       ON g.user_id = u.id AND g.permission_key = ? AND g.revoked_at IS NULL
     LEFT JOIN users gu ON gu.id = g.granted_by
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(u.role, ${STAFF_ROLES.map(() => '?').join(', ')}), u.name`,
    [PRIVILEGES.CREATE_SUPER_ADMIN, ...values, ...STAFF_ROLES]
  )
  return rows.map((r) => ({
    ...withoutPermissionColumns(r),
    permissions: permissionsFor(r.role, r),
    allocation: r.role === 'consultant' ? allocationFrom(r) : null,
    is_active: Boolean(r.is_active),
    invite_pending: Boolean(r.invite_pending),
    open_leads: Number(r.open_leads ?? 0),
    open_exams: Number(r.open_exams ?? 0),
    can_create_super_admin: r.role === SUPER || Boolean(r.sa_grant_at),
    super_admin_grant: r.sa_grant_at ? { granted_at: r.sa_grant_at, granted_by: r.sa_granted_by } : null,
  }))
}

// ── Per-person permissions & consultant allocation (2.0 phase 2) ─────────

const withoutPermissionColumns = (row) => {
  const out = { ...row }
  for (const k of [...STAFF_PERMISSIONS, 'accepting_leads', 'paused_reason', 'on_leave_from', 'on_leave_until', 'daily_limit', 'open_limit'])
    delete out[k]
  return out
}

/** Effective permissions: Super Admins/Admins have all; others per their row. */
const permissionsFor = (role, row) =>
  Object.fromEntries(
    STAFF_PERMISSIONS.map((k) => [k, role === SUPER || role === 'admin' ? true : Boolean(row?.[k])])
  )

const dayOf = (d) => (d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null)
/** Leave state today: 'on_leave' (inside from–until), 'leave_planned' (starts later) or null. */
export const leaveState = (from, until, today = new Date().toISOString().slice(0, 10)) => {
  const f = dayOf(from)
  const u = dayOf(until)
  if (!u || u < today) return null
  return f && f > today ? 'leave_planned' : 'on_leave'
}

const allocationFrom = (row) => {
  const leave = leaveState(row?.on_leave_from, row?.on_leave_until)
  const accepting = row?.accepting_leads == null ? true : Boolean(row.accepting_leads)
  return {
    accepting_leads: accepting,
    paused_reason: row?.paused_reason ?? null,
    on_leave_from: dayOf(row?.on_leave_from),
    on_leave_until: dayOf(row?.on_leave_until),
    leave_planned: leave === 'leave_planned',
    daily_limit: row?.daily_limit ?? null,
    open_limit: row?.open_limit ?? null,
    // What Round Robin (phase 4) will see
    state: !accepting ? 'paused' : leave === 'on_leave' ? 'on_leave' : 'receiving',
  }
}

/** Make sure a Sub-Admin/Consultant has a permissions row (role defaults). */
const ensurePermissions = async (userId, role, createdBy, overrides) => {
  if (!DEFAULT_PERMISSIONS[role]) return
  const [[existing]] = await pool.query('SELECT id FROM admin_permissions WHERE user_id = ? LIMIT 1', [userId])
  if (existing) return
  const perms = Object.fromEntries(
    STAFF_PERMISSIONS.map((k) => [k, overrides?.[k] ?? DEFAULT_PERMISSIONS[role].includes(k)])
  )
  await pool.query(
    `INSERT INTO admin_permissions (user_id, ${STAFF_PERMISSIONS.join(', ')}, created_by)
     VALUES (?, ${STAFF_PERMISSIONS.map(() => '?').join(', ')}, ?)`,
    [userId, ...STAFF_PERMISSIONS.map((k) => (perms[k] ? 1 : 0)), createdBy]
  )
}

export const setPermissions = async (req, id, perms) => {
  const actor = req.user
  const target = await getUser(id)
  if (!target || target.deleted_at) throw fail(404, 'User not found')
  if (!DEFAULT_PERMISSIONS[target.role]) {
    throw fail(400, 'Permissions are set for Sub-Admins and Consultants; Admins and Super Admins have them all')
  }
  if (Number(target.id) === Number(actor.id) || !canManage(actor, target)) {
    throw await denied(req, 'permissions.update', target, "You can't change this person's permissions")
  }

  await ensurePermissions(target.id, target.role, actor.id)
  const [[before]] = await pool.query('SELECT * FROM admin_permissions WHERE user_id = ? LIMIT 1', [target.id])
  await pool.query(
    `UPDATE admin_permissions SET ${STAFF_PERMISSIONS.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`,
    [...STAFF_PERMISSIONS.map((k) => (perms[k] ? 1 : 0)), target.id]
  )
  const changes = STAFF_PERMISSIONS.filter((k) => Boolean(before?.[k]) !== Boolean(perms[k])).map((k) => ({
    permission: k,
    to: Boolean(perms[k]),
  }))
  await audit(req, { action: 'permissions.update', targetType: 'user', targetId: target.id, details: { changes } })
  return getMember(target.id)
}

export const setAllocation = async (req, id, body) => {
  const actor = req.user
  const target = await getUser(id)
  if (!target || target.deleted_at) throw fail(404, 'User not found')
  if (target.role !== 'consultant') throw fail(400, 'Lead allocation settings are for Consultants')
  if (!canManage(actor, target)) throw await denied(req, 'allocation.update', target, "You can't manage this consultant")

  const values = {
    accepting_leads: body.accepting_leads ? 1 : 0,
    paused_reason: body.accepting_leads ? null : body.paused_reason?.trim() || null,
    on_leave_from: body.on_leave_until && body.on_leave_from ? new Date(body.on_leave_from).toISOString().slice(0, 10) : null,
    on_leave_until: body.on_leave_until ? new Date(body.on_leave_until).toISOString().slice(0, 10) : null,
    daily_limit: body.daily_limit ?? null,
    open_limit: body.open_limit ?? null,
  }
  if (values.on_leave_from && values.on_leave_until && values.on_leave_from > values.on_leave_until) {
    throw fail(400, 'The leave start date must be on or before the end date')
  }
  const [[before]] = await pool.query('SELECT * FROM consultant_settings WHERE user_id = ?', [target.id])
  await pool.query(
    `INSERT INTO consultant_settings
       (user_id, accepting_leads, paused_reason, on_leave_from, on_leave_until, daily_limit, open_limit, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())
     ON DUPLICATE KEY UPDATE accepting_leads = VALUES(accepting_leads), paused_reason = VALUES(paused_reason),
       on_leave_from = VALUES(on_leave_from), on_leave_until = VALUES(on_leave_until), daily_limit = VALUES(daily_limit), open_limit = VALUES(open_limit),
       updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
    [target.id, values.accepting_leads, values.paused_reason, values.on_leave_from, values.on_leave_until, values.daily_limit, values.open_limit, actor.id]
  )
  const action =
    Boolean(before?.accepting_leads ?? 1) !== Boolean(values.accepting_leads)
      ? values.accepting_leads
        ? 'allocation.resume'
        : 'allocation.pause'
      : 'allocation.update'
  await audit(req, { action, targetType: 'user', targetId: target.id, details: values })
  return getMember(target.id)
}

/** One member with their privilege history (grants, revocations). */
export const getMember = async (id) => {
  const user = await getUser(id)
  if (!user || user.deleted_at || !STAFF_ROLES.includes(user.role)) throw fail(404, 'Team member not found')
  const [grants] = await pool.query(
    `SELECT g.id, g.permission_key, g.granted_at, g.revoked_at,
            gb.name AS granted_by, rb.name AS revoked_by
     FROM user_permission_grants g
     LEFT JOIN users gb ON gb.id = g.granted_by
     LEFT JOIN users rb ON rb.id = g.revoked_by
     WHERE g.user_id = ? ORDER BY g.id DESC`,
    [id]
  )
  const [[perms]] = await pool.query('SELECT * FROM admin_permissions WHERE user_id = ? LIMIT 1', [id])
  const [[alloc]] = await pool.query('SELECT * FROM consultant_settings WHERE user_id = ? LIMIT 1', [id])
  const { password, ...safe } = user
  return {
    ...safe,
    is_active: Boolean(user.is_active),
    grants,
    permissions: permissionsFor(user.role, perms),
    allocation: user.role === 'consultant' ? allocationFrom(alloc) : null,
  }
}

/** What the signed-in staff member may do (drives the Team page buttons). */
export const myCapabilities = async (actor) => {
  const roles = []
  for (const r of STAFF_ROLES) if (await canAssignRole(actor, r)) roles.push(r)
  return {
    role: actor.role,
    can_create_roles: roles,
    can_grant_privileges: actor.role === SUPER,
    can_view_audit: actor.role === SUPER || actor.role === 'admin',
    permission_keys: STAFF_PERMISSIONS,
    default_permissions: DEFAULT_PERMISSIONS,
  }
}

// ── Create (invite) ───────────────────────────────────────────────────────

export const createMember = async (req, { name, email, mobile, role, password, permissions: permissionOverrides }) => {
  const actor = req.user
  const action = role === SUPER ? 'super_admin.create' : 'user.create'
  if (!(await canAssignRole(actor, role))) {
    throw await denied(req, action, null, `You can't create ${ROLE_LABELS[role] ?? role} accounts`, {
      email,
      role,
    })
  }
  if (role === SUPER) await reauthenticate(actor, password)

  const normalized = String(email).trim().toLowerCase()
  const [[existing]] = await pool.query('SELECT id, deleted_at FROM users WHERE LOWER(email) = ? LIMIT 1', [
    normalized,
  ])
  if (existing) {
    await audit(req, { action, result: 'failed', details: { email: normalized, role, reason: 'duplicate email' } })
    throw fail(
      409,
      existing.deleted_at
        ? 'This email belongs to a deleted account — restore it from Users instead'
        : 'An account with this email already exists — change its role instead'
    )
  }

  const [result] = await pool.query(
    `INSERT INTO users (name, email, mobile, password, role, oauth_provider, is_verified, is_active)
     VALUES (?, ?, ?, NULL, ?, 'local', 1, 1)`,
    [String(name).trim(), normalized, mobile || null, role]
  )
  const id = result.insertId
  await ensurePermissions(id, role, actor.id, permissionOverrides)

  // Secure invitation: the person sets their own password (no password is emailed)
  const setUrl = await issuePasswordLink(id, INVITE_HOURS * 60)
  await sendStaffInviteJob({
    to: normalized,
    name,
    roleLabel: ROLE_LABELS[role],
    invitedBy: actor.name,
    setUrl,
    hours: INVITE_HOURS,
  })

  await audit(req, {
    action,
    targetType: 'user',
    targetId: id,
    details: {
      email: normalized,
      role,
      ...(role === SUPER && actor.role === 'admin' && { via_grant: PRIVILEGES.CREATE_SUPER_ADMIN }),
    },
  })
  if (role === SUPER) {
    await notifySuperAdmins(
      'A new Super Admin account was created',
      [`New Super Admin: ${name} (${normalized})`, `Created by: ${actor.name} (${ROLE_LABELS[actor.role]})`],
      actor.id
    )
  }
  return getMember(id)
}

/** Send a fresh invitation (set-password link) to someone who hasn't set a password yet. */
export const resendInvite = async (req, id) => {
  const target = await getUser(id)
  if (!target || target.deleted_at || !STAFF_ROLES.includes(target.role)) throw fail(404, 'Team member not found')
  if (!canManage(req.user, target)) throw await denied(req, 'user.invite_resend', target, "You can't manage this account")
  if (target.password) throw fail(409, 'This person has already set a password')
  const setUrl = await issuePasswordLink(target.id, INVITE_HOURS * 60)
  await sendStaffInviteJob({
    to: target.email,
    name: target.name,
    roleLabel: ROLE_LABELS[target.role],
    invitedBy: req.user.name,
    setUrl,
    hours: INVITE_HOURS,
  })
  await audit(req, { action: 'user.invite_resend', targetType: 'user', targetId: target.id })
  return { sent: true }
}

// ── Change role (promote / demote) ────────────────────────────────────────

export const changeRole = async (req, id, { role, password }) => {
  const actor = req.user
  const target = await getUser(id)
  if (!target || target.deleted_at) throw fail(404, 'User not found')
  if (target.role === role) throw fail(409, `This person is already ${ROLE_LABELS[role]}`)
  const action = role === SUPER ? 'super_admin.promote' : 'user.role_change'

  if (Number(target.id) === Number(actor.id)) {
    throw await denied(req, action, target, "You can't change your own role")
  }
  if (!canManage(actor, target) || !(await canAssignRole(actor, role))) {
    throw await denied(req, action, target, `You can't make this person ${ROLE_LABELS[role] ?? role}`, {
      from: target.role,
      to: role,
    })
  }
  if (target.role === SUPER && target.is_active && (await activeSuperAdmins()).length <= 1) {
    throw fail(409, "This is the last active Super Admin — promote someone else first")
  }
  if (role === SUPER || target.role === SUPER || role === 'admin' || target.role === 'admin') {
    await reauthenticate(actor, password)
  }

  await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, target.id])
  await ensurePermissions(target.id, role, actor.id)
  // A delegated privilege belongs to the Admin role: drop it when they change role
  if (target.role === 'admin') {
    await pool.query(
      `UPDATE user_permission_grants SET revoked_at = UTC_TIMESTAMP(), revoked_by = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
      [actor.id, target.id]
    )
  }
  await audit(req, { action, targetType: 'user', targetId: target.id, details: { from: target.role, to: role } })
  if (role === SUPER || target.role === SUPER) {
    await notifySuperAdmins(
      role === SUPER ? 'Someone was made a Super Admin' : 'A Super Admin was demoted',
      [
        `${target.name} (${target.email}): ${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}`,
        `Changed by: ${actor.name} (${ROLE_LABELS[actor.role]})`,
      ],
      actor.id
    )
  }
  return getMember(target.id)
}

// ── Activate / deactivate ─────────────────────────────────────────────────

export const setStatus = async (req, id, isActive) => {
  const actor = req.user
  const target = await getUser(id)
  if (!target || target.deleted_at) throw fail(404, 'User not found')
  const action = isActive ? 'user.activate' : 'user.deactivate'

  if (Number(target.id) === Number(actor.id)) throw await denied(req, action, target, "You can't change your own status")
  if (!canManage(actor, target)) throw await denied(req, action, target, "You can't manage this account")
  if (!isActive && target.role === SUPER && target.is_active && (await activeSuperAdmins()).length <= 1) {
    throw fail(409, "This is the last active Super Admin — it can't be deactivated")
  }

  await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, target.id])
  if (!isActive) await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [target.id]) // signed out
  await audit(req, { action, targetType: 'user', targetId: target.id, details: { role: target.role } })
  return getMember(target.id)
}

// ── Delete (soft): blocked for good, history kept ─────────────────────────

/** May `actor` delete `id`? Returns the target. The email must be typed to confirm. */
export const assertCanDelete = async (req, id, confirmEmail) => {
  const actor = req.user
  const target = await getUser(id)
  if (!target || target.deleted_at || !STAFF_ROLES.includes(target.role)) throw fail(404, 'Team member not found')
  if (Number(target.id) === Number(actor.id)) throw await denied(req, 'user.delete', target, "You can't delete your own account")
  if (!canManage(actor, target)) throw await denied(req, 'user.delete', target, "You can't delete this account")
  if (target.role === SUPER && (await activeSuperAdmins()).filter((u) => u.id !== target.id).length < 1) {
    throw fail(409, "This is the last active Super Admin — it can't be deleted")
  }
  if (String(confirmEmail ?? '').trim().toLowerCase() !== String(target.email).toLowerCase()) {
    throw fail(400, 'Type their email address exactly to confirm')
  }
  return target
}

/**
 * Remove a team member, the same way as Users → Delete: they can't sign in,
 * and disappear from the team, pickers and Round Robin. They can be restored
 * from Users → Deleted for 30 days (or erased there straight away); after
 * that their personal details are erased automatically.
 */
export const deleteMember = async (req, target) => {
  await pool.query(
    `UPDATE users SET deleted_at = UTC_TIMESTAMP(), deleted_by = ?, was_active = is_active, is_active = 0 WHERE id = ?`,
    [req.user.id, target.id]
  )
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = ?', [target.id])
  await pool.query('DELETE FROM distribution_pool_members WHERE user_id = ?', [target.id]).catch(() => {})
  await audit(req, { action: 'user.delete', targetType: 'user', targetId: target.id, details: { role: target.role, email: target.email } })
  return { id: target.id, deleted: true }
}

/** Guard for the older Users page status toggle: same rules as the Team page. */
export const assertCanSetStatus = async (actor, targetId, isActive) => {
  const target = await getUser(targetId)
  if (!target) return
  if (STAFF_ROLES.includes(target.role) && !canManage(actor, target)) {
    throw fail(403, "You can't change the status of this account")
  }
  if (!isActive && target.role === SUPER && target.is_active && (await activeSuperAdmins()).length <= 1) {
    throw fail(409, "This is the last active Super Admin — it can't be deactivated")
  }
}

// ── Delegated privilege: super_admin.create ───────────────────────────────

export const grantPrivilege = async (req, id, { password }) => {
  const actor = req.user
  const key = PRIVILEGES.CREATE_SUPER_ADMIN
  const target = await getUser(id)
  if (!target || target.deleted_at) throw fail(404, 'User not found')

  if (actor.role !== SUPER) throw await denied(req, 'privilege.grant', target, 'Only a Super Admin can grant this', { key })
  if (Number(target.id) === Number(actor.id)) throw await denied(req, 'privilege.grant', target, "You can't grant privileges to yourself", { key })
  if (target.role !== 'admin') throw fail(400, 'This privilege can only be given to an Admin')
  if (!target.is_active) throw fail(400, 'Activate this Admin first')
  if (await activeGrant(target.id, key)) throw fail(409, 'This Admin can already create Super Admins')
  await reauthenticate(actor, password)

  await pool.query('INSERT INTO user_permission_grants (user_id, permission_key, granted_by) VALUES (?, ?, ?)', [
    target.id,
    key,
    actor.id,
  ])
  await audit(req, { action: 'privilege.grant', targetType: 'user', targetId: target.id, details: { key } })
  await notifySuperAdmins(
    'An Admin may now create Super Admins',
    [`Admin: ${target.name} (${target.email})`, `Granted by: ${actor.name}`],
    actor.id
  )
  return getMember(target.id)
}

export const revokePrivilege = async (req, id, { password }) => {
  const actor = req.user
  const key = PRIVILEGES.CREATE_SUPER_ADMIN
  const target = await getUser(id)
  if (!target || target.deleted_at) throw fail(404, 'User not found')

  if (actor.role !== SUPER) throw await denied(req, 'privilege.revoke', target, 'Only a Super Admin can revoke this', { key })
  if (!(await activeGrant(target.id, key))) throw fail(409, "This Admin doesn't have this privilege")
  await reauthenticate(actor, password)

  // Takes effect immediately: checks read the grant on every request
  await pool.query(
    `UPDATE user_permission_grants SET revoked_at = UTC_TIMESTAMP(), revoked_by = ?
     WHERE user_id = ? AND permission_key = ? AND revoked_at IS NULL`,
    [actor.id, target.id, key]
  )
  await audit(req, { action: 'privilege.revoke', targetType: 'user', targetId: target.id, details: { key } })
  await notifySuperAdmins(
    "An Admin's Super Admin-creation privilege was revoked",
    [`Admin: ${target.name} (${target.email})`, `Revoked by: ${actor.name}`],
    actor.id
  )
  return getMember(target.id)
}
