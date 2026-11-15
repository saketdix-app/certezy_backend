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
import { PRIVILEGES, STAFF_ROLES } from '../../constants.js'
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
    if (role === 'sub_admin' || role === 'consultant') return true
    // A disabled admin never gets here (is_active checked above)
    if (role === SUPER) return Boolean(await activeGrant(actor.id, PRIVILEGES.CREATE_SUPER_ADMIN))
  }
  return false
}

/** May `actor` change the role or status of `target` (as they are now)? */
const canManage = (actor, target) => {
  if (actor.role === SUPER) return true
  if (actor.role === 'admin') return ['sub_admin', 'consultant', 'student'].includes(target.role)
  return false
}

const reauthenticate = async (actor, password) => {
  const fresh = await getUser(actor.id)
  if (!fresh?.password) {
    throw fail(400, 'Set a password on your account (Profile → Password) before making this change')
  }
  if (!password || !(await bcrypt.compare(String(password), fresh.password))) {
    throw fail(401, 'Your password is incorrect')
  }
}

const notifySuperAdmins = async (title, lines, exceptId) => {
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
            g.granted_at AS sa_grant_at, gu.name AS sa_granted_by
     FROM users u
     LEFT JOIN user_permission_grants g
       ON g.user_id = u.id AND g.permission_key = ? AND g.revoked_at IS NULL
     LEFT JOIN users gu ON gu.id = g.granted_by
     WHERE ${where.join(' AND ')}
     ORDER BY FIELD(u.role, ${STAFF_ROLES.map(() => '?').join(', ')}), u.name`,
    [PRIVILEGES.CREATE_SUPER_ADMIN, ...values, ...STAFF_ROLES]
  )
  return rows.map((r) => ({
    ...r,
    is_active: Boolean(r.is_active),
    invite_pending: Boolean(r.invite_pending),
    can_create_super_admin: r.role === SUPER || Boolean(r.sa_grant_at),
    super_admin_grant: r.sa_grant_at ? { granted_at: r.sa_grant_at, granted_by: r.sa_granted_by } : null,
  }))
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
  const { password, ...safe } = user
  return { ...safe, is_active: Boolean(user.is_active), grants }
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
  }
}

// ── Create (invite) ───────────────────────────────────────────────────────

export const createMember = async (req, { name, email, mobile, role, password }) => {
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
