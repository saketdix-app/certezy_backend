// src/modules/auth/passwordReset.js
// "Forgot password" flow:
//   1. requestPasswordReset(email) — emails a one-time link, valid for 1 hour.
//      Google/GitHub accounts use the same link to set a password, so they can
//      sign in either way afterwards.
//      Always answers the same way, so nobody can find out which emails have
//      an account.
//   2. resetPassword(token, password) — sets the new password, uses up the
//      link and signs the account out everywhere.
// Only a SHA-256 hash of the token is stored; the link itself is in the email.

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { pool } from '../../config/db.js'
import env from '../../config/env.js'
import * as queries from './auth.queries.js'
import { sendPasswordResetJob } from '../../jobs/emailQueue.js'

const TOKEN_TTL_MINUTES = 60
const BCRYPT_ROUNDS = 12

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex')
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

export const requestPasswordReset = async (rawEmail) => {
  const email = String(rawEmail ?? '')
    .trim()
    .toLowerCase()
  const user = email ? await queries.findByEmail(email) : null
  // Unknown, deactivated or deleted accounts get no email (and the same answer)
  if (!user || !user.is_active || user.deleted_at) return

  const token = crypto.randomBytes(32).toString('hex')
  // One live link at a time: older unused links stop working
  await pool.query(
    'UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL',
    [user.id]
  )
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)`,
    [user.id, hashToken(token), TOKEN_TTL_MINUTES]
  )
  await sendPasswordResetJob({
    to: user.email,
    name: user.name,
    resetUrl: `${env.frontendUrl}/reset-password?token=${token}`,
    minutes: TOKEN_TTL_MINUTES,
    // Google/GitHub accounts without a password are setting one, not resetting
    provider: user.password ? undefined : user.oauth_provider,
  })
}

const findValidReset = async (token) => {
  if (!/^[a-f0-9]{64}$/.test(String(token ?? ''))) return null
  const [rows] = await pool.query(
    `SELECT id, user_id FROM password_resets
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [hashToken(token)]
  )
  return rows[0] ?? null
}

/** For the reset page: is this link still usable? */
export const checkResetToken = async (token) => Boolean(await findValidReset(token))

export const resetPassword = async (token, password) => {
  const reset = await findValidReset(token)
  if (!reset) throw fail(400, 'This reset link is invalid or has expired. Request a new one.')

  const user = await queries.findById(reset.user_id)
  if (!user || !user.is_active) throw fail(400, 'This account cannot be reset. Contact support.')

  const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS)
  await queries.updatePassword(user.id, hashed)
  await pool.query(
    'UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL',
    [user.id]
  )
  await queries.deleteAllRefreshTokens(user.id) // signed out on every device
  return { email: user.email }
}
