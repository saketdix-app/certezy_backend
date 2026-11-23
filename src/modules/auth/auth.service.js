// src/modules/auth/auth.service.js

import bcrypt from 'bcryptjs'
import { isOwnUploadUrl } from '../../utils/upload.js'
import * as queries from './auth.queries.js'
import tokenUtil from '../../utils/token.js'
import { sendWelcomeJob } from '../../jobs/emailQueue.js'
import { purgeDateFor, isDeleted } from './userDeletion.js'
import { pool } from '../../config/db.js'
import { IDLE_MINUTES, MOBILE_SESSION_DAYS, STAFF_PERMISSIONS } from '../../constants.js'
import { startChallenge, verifyChallenge } from './twoFactor.js'
const BCRYPT_ROUNDS = 12

const register = async ({ name, email, password }) => {
  const existing = await queries.findByEmail(email)
  if (existing?.deleted_at) {
    const err = new Error('This email belongs to a deleted account. Contact support to restore it.')
    err.statusCode = 409
    throw err
  }
  if (existing) {
    const err = new Error('Email already registered')
    err.statusCode = 409
    throw err
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const userId = await queries.createUser({ name, email, password: hashedPassword })
  const user = await queries.findById(userId)

  sendWelcomeJob({ to: email, name })?.catch?.((e) =>
    console.warn('[AUTH] Welcome email queue notice:', e?.message)
  ) // fire and forget
  return user
}

const login = async ({ email, password }, { client = null } = {}) => {
  const user = await queries.findByEmail(email)
  if (!user) {
    const err = new Error('Invalid email or password')
    err.statusCode = 401
    throw err
  }

  if (user.deleted_at) {
    const err = new Error('This account has been deleted. Contact support to restore it.')
    err.statusCode = 403
    throw err
  }
  if (!user.is_active) {
    const err = new Error('Account is deactivated. Contact admin.')
    err.statusCode = 403
    throw err
  }

  // Google/GitHub accounts have no password until they set one (Forgot password)
  if (!user.password) {
    const provider = user.oauth_provider === 'github' ? 'GitHub' : 'Google'
    const err = new Error(
      `This account signs in with ${provider}. Use "Continue with ${provider}", or "Forgot password?" to set a password.`
    )
    err.statusCode = 400
    throw err
  }

  const isMatch = await bcrypt.compare(password, user.password)
  if (!isMatch) {
    const err = new Error('Invalid email or password')
    err.statusCode = 401
    throw err
  }

  // Two-step sign-in on: email a code; the session starts once it is entered
  if (user.two_factor_enabled) {
    return { two_factor_required: true, ...(await startChallenge(user, 'login')) }
  }
  return startSession(user, client)
}

/** Password (and code, if two-step is on) checked: issue the session. */
const startSession = async (user, client = null) => {
  const tokens = await generateTokens(user, null, client)
  return {
    user: await withAccess(sanitizeUser(user)),
    ...tokens,
    isFirstLogin: user.is_first_login === 1,
  }
}

/** Second step of sign-in: the emailed code. */
const verifyLogin = async ({ challenge, code }, { client = null } = {}) => {
  const userId = await verifyChallenge(challenge, code, 'login')
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId])
  if (!user || !user.is_active || user.deleted_at) {
    const err = new Error('Account is deactivated. Contact admin.')
    err.statusCode = 403
    throw err
  }
  return startSession(user, client)
}

/** Minutes without activity before a session ends: Super Admins 15, everyone else 60. */
const idleLimitSeconds = (role) => (IDLE_MINUTES[role] ?? IDLE_MINUTES.default) * 60

/** What the app needs to show the right menus: two-step status and Sub-Admin permissions. */
const withAccess = async (user) => {
  if (!user) return user
  const out = { ...user, two_factor_enabled: Boolean(user.two_factor_enabled) }
  if (user.role === 'sub_admin') {
    const [[row]] = await pool.query('SELECT * FROM admin_permissions WHERE user_id = ? LIMIT 1', [user.id])
    out.permissions = Object.fromEntries(STAFF_PERMISSIONS.map((k) => [k, Boolean(row?.[k])]))
  }
  out.idle_minutes = IDLE_MINUTES[user.role] ?? IDLE_MINUTES.default
  return out
}

const refresh = async (refreshToken) => {
  if (!refreshToken) {
    const err = new Error('Refresh token required')
    err.statusCode = 401
    throw err
  }

  const tokenRecord = await queries.findRefreshToken(refreshToken)
  if (!tokenRecord) {
    const err = new Error('Invalid or expired refresh token')
    err.statusCode = 401
    throw err
  }

  try {
    tokenUtil.verifyRefreshToken(refreshToken)
  } catch {
    await queries.deleteRefreshToken(refreshToken)
    const err = new Error('Refresh token expired')
    err.statusCode = 401
    throw err
  }

  if (!tokenRecord.is_active) {
    const err = new Error('Account is deactivated')
    err.statusCode = 403
    throw err
  }

  // No activity for too long: the session is over (the Team app always stays signed in)
  const appSession = tokenRecord.client === 'mobile'
  if (!appSession && Number(tokenRecord.idle_seconds) > idleLimitSeconds(tokenRecord.role)) {
    await queries.deleteRefreshToken(refreshToken)
    const err = new Error(`You were signed out after ${idleLimitSeconds(tokenRecord.role) / 60} minutes without activity`)
    err.statusCode = 401
    err.publicCode = 'SESSION_IDLE'
    throw err
  }

  // Same session, new tokens (the row keeps its id and last activity)
  const user = await queries.findById(tokenRecord.user_id)
  return { ...(await generateTokens(user, tokenRecord.id, tokenRecord.client)), client: tokenRecord.client ?? null }
}

const logout = async (refreshToken) => {
  if (refreshToken) {
    await queries.deleteRefreshToken(refreshToken)
  }
}

const changePassword = async ({ userId, currentPassword, newPassword }) => {
  const userBasic = await queries.findById(userId)
  const user = await queries.findByEmail(userBasic.email)
  if (!user.password) {
    const err = new Error(
      'Your account has no password yet. Use "Forgot password?" on the sign-in page to set one.'
    )
    err.statusCode = 400
    throw err
  }

  const isMatch = await bcrypt.compare(currentPassword, user.password)
  if (!isMatch) {
    const err = new Error('Current password is incorrect')
    err.statusCode = 400
    throw err
  }

  const isSame = await bcrypt.compare(newPassword, user.password)
  if (isSame) {
    const err = new Error('New password must be different from current password')
    err.statusCode = 400
    throw err
  }

  const hashed = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
  await queries.updatePassword(userId, hashed)
  await queries.deleteAllRefreshTokens(userId)
}

const oauthLogin = async (user) => {
  if (await isDeleted(user.id)) {
    const err = new Error('This account has been deleted. Contact support to restore it.')
    err.statusCode = 403
    throw err
  }
  // Blocked accounts can't sign in with Google / GitHub either
  if (user.is_active === 0 || user.is_active === false) {
    const err = new Error('Account is deactivated. Contact admin.')
    err.statusCode = 403
    throw err
  }
  // Two-step sign-in on: Google / GitHub proves who it is, then the emailed code
  // is still needed — no session until it's entered (same as email + password)
  const [[tf]] = await pool.query('SELECT id, name, email, two_factor_enabled FROM users WHERE id = ? LIMIT 1', [user.id])
  if (tf?.two_factor_enabled) {
    return { two_factor_required: true, ...(await startChallenge(tf, 'login')) }
  }
  const tokens = await generateTokens(user)
  return {
    user: await withAccess(sanitizeUser(user)),
    ...tokens,
    isFirstLogin: false,
  }
}

// ── Get all users (admin) ──────────────────────────────────────────────────
const getAllUsers = async ({ page = 1, limit = 20, role, search, deleted = false, status } = {}) => {
  const offset = (page - 1) * limit

  const [rows] = await queries.getAllUsers({ limit, offset, role, search, deleted, status })
  const [count] = await queries.countUsers({ role, search, deleted, status })

  return {
    users: deleted ? rows.map((u) => ({ ...u, restore_until: purgeDateFor(u.deleted_at) })) : rows,
    pagination: {
      total: count[0].total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count[0].total / limit),
    },
  }
}

// ── Update user status (admin) ─────────────────────────────────────────────
const updateUserStatus = async (id, is_active) => {
  const user = await queries.findById(id)
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }

  if (await isDeleted(id)) {
    const err = new Error('This user is deleted — restore them first')
    err.statusCode = 409
    throw err
  }

  await queries.updateUserStatus(id, is_active)
  return await queries.findById(id)
}

// International mobile numbers in E.164 form: "+" + country code + number,
// 8–15 digits in all (e.g. +919893596975, +15123730152)
const normalizeMobile = (value) => {
  if (value == null || String(value).trim() === '') return null
  const digits = String(value).replace(/[\s\-().]/g, '')
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) {
    const err = new Error('Enter a valid mobile number with country code, e.g. +91 98765 43210')
    err.statusCode = 400
    throw err
  }
  return digits
}

const updateProfile = async (userId, { name, mobile, gender, avatar }) => {
  const cleanName = String(name ?? '').trim()
  if (cleanName.length < 2) {
    const err = new Error('Please enter your full name')
    err.statusCode = 400
    throw err
  }
  await queries.updateProfile(userId, {
    name: cleanName,
    mobile: normalizeMobile(mobile),
    gender: gender || null,
  })

  // Photo: only a file uploaded to our own avatars folder, or null to remove it
  if (avatar !== undefined) {
    if (avatar !== null && !isOwnUploadUrl(avatar, 'avatars')) {
      const err = new Error('Upload the photo with the Upload Photo button')
      err.statusCode = 400
      throw err
    }
    await queries.updateAvatar(userId, avatar)
  }
  const user = await queries.findById(userId)
  return { user }
}

//get by id
const getById = async (id) => {
  const user = await queries.findById(id)
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }
  return user
}

// ─── HELPERS ─────────────────────────────────────────────────

/**
 * A session = one refresh_tokens row. The access token carries its id (sid) so
 * every request can check and record activity (idle sign-out); refreshing keeps
 * the same session row.
 */
const generateTokens = async (user, sessionId = null, client = null) => {
  // The Team app keeps a long session that renews on every refresh (MOBILE_SESSION_DAYS)
  const mobile = client === 'mobile'
  const refreshToken = tokenUtil.generateRefreshToken(
    { id: user.id, role: user.role },
    mobile ? `${MOBILE_SESSION_DAYS}d` : undefined
  )
  const expiresAt = tokenUtil.getRefreshTokenExpiry(mobile ? MOBILE_SESSION_DAYS : 7)
  let sid = sessionId
  if (sid) await queries.rotateRefreshToken(sid, { token: refreshToken, expiresAt })
  else sid = await queries.saveRefreshToken({ userId: user.id, token: refreshToken, expiresAt, client: mobile ? 'mobile' : null })
  const accessToken = tokenUtil.generateAccessToken({ id: user.id, role: user.role, sid })
  return { accessToken, refreshToken }
}

// ── Two-step sign-in settings (Profile → Security) ─────────────────────────

/** Send a code to confirm turning two-step sign-in on. */
const startTwoFactorSetup = async (actor) => {
  const [[u]] = await pool.query('SELECT id, name, email, two_factor_enabled FROM users WHERE id = ?', [actor.id])
  if (u.two_factor_enabled) {
    const err = new Error('Two-step sign-in is already on')
    err.statusCode = 409
    throw err
  }
  return startChallenge(u, 'enable')
}

const enableTwoFactor = async (actor, { challenge, code }) => {
  const userId = await verifyChallenge(challenge, code, 'enable')
  if (Number(userId) !== Number(actor.id)) {
    const err = new Error('This code is for another account')
    err.statusCode = 403
    throw err
  }
  await pool.query('UPDATE users SET two_factor_enabled = 1, two_factor_enabled_at = UTC_TIMESTAMP() WHERE id = ?', [actor.id])
  return { two_factor_enabled: true }
}

const disableTwoFactor = async (actor, { password }) => {
  const [[u]] = await pool.query('SELECT password FROM users WHERE id = ?', [actor.id])
  if (!u?.password || !(await bcrypt.compare(String(password ?? ''), u.password))) {
    const err = new Error('Your password is incorrect')
    err.statusCode = 401
    throw err
  }
  await pool.query('UPDATE users SET two_factor_enabled = 0, two_factor_enabled_at = NULL WHERE id = ?', [actor.id])
  return { two_factor_enabled: false }
}

const sanitizeUser = (user) => {
  const { password, oauth_id, ...safeUser } = user
  return safeUser
}

export {
  register,
  login,
  verifyLogin,
  withAccess,
  idleLimitSeconds,
  startTwoFactorSetup,
  enableTwoFactor,
  disableTwoFactor,
  refresh,
  logout,
  changePassword,
  oauthLogin,
  getAllUsers,
  updateUserStatus,
  updateProfile,
  getById,
}
