// src/modules/auth/auth.service.js

import bcrypt from 'bcryptjs'
import { isOwnUploadUrl } from '../../utils/upload.js'
import * as queries from './auth.queries.js'
import tokenUtil from '../../utils/token.js'
import { sendWelcomeJob } from '../../jobs/emailQueue.js'
import { purgeDateFor, isDeleted } from './userDeletion.js'
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

const login = async ({ email, password }) => {
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

  if (user.oauth_provider !== 'local' || !user.password) {
    const err = new Error(`Please sign in with ${user.oauth_provider}`)
    err.statusCode = 400
    throw err
  }

  const isMatch = await bcrypt.compare(password, user.password)
  if (!isMatch) {
    const err = new Error('Invalid email or password')
    err.statusCode = 401
    throw err
  }

  const tokens = await generateTokens(user)

  return {
    user: sanitizeUser(user),
    ...tokens,
    isFirstLogin: user.is_first_login === 1,
  }
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

  await queries.deleteRefreshToken(refreshToken)
  const user = await queries.findById(tokenRecord.user_id)
  const tokens = await generateTokens(user)
  return tokens
}

const logout = async (refreshToken) => {
  if (refreshToken) {
    await queries.deleteRefreshToken(refreshToken)
  }
}

const changePassword = async ({ userId, currentPassword, newPassword }) => {
  const userBasic = await queries.findById(userId)
  const user = await queries.findByEmail(userBasic.email)

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
  const tokens = await generateTokens(user)
  return {
    user: sanitizeUser(user),
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
// 8–15 digits in all (e.g. +919893596975, +18665589561)
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

const generateTokens = async (user) => {
  const payload = { id: user.id, role: user.role }

  const accessToken = tokenUtil.generateAccessToken(payload)
  const refreshToken = tokenUtil.generateRefreshToken(payload)
  const expiresAt = tokenUtil.getRefreshTokenExpiry()

  await queries.saveRefreshToken({ userId: user.id, token: refreshToken, expiresAt })
  return { accessToken, refreshToken }
}

const sanitizeUser = (user) => {
  const { password, oauth_id, ...safeUser } = user
  return safeUser
}

export {
  register,
  login,
  refresh,
  logout,
  changePassword,
  oauthLogin,
  getAllUsers,
  updateUserStatus,
  updateProfile,
  getById,
}
