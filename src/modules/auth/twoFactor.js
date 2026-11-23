// src/modules/auth/twoFactor.js
// Two-step sign-in with a one-time code sent by email.
//   • Turned on per person (Profile → Security); Super Admins are asked to turn
//     it on after signing in.
//   • With it on, a correct password only starts a "challenge": a 6-digit code
//     is emailed and the session starts once the code is entered.
//   • Codes last 10 minutes, allow 5 tries, and can be re-sent (45 s apart, 5 times).
//   • Only a hash of the code is stored.

import crypto from 'node:crypto'
import { pool } from '../../config/db.js'
import env from '../../config/env.js'
import { sendLoginCodeMail } from '../../utils/mailer.js'

export const CODE_MINUTES = 10
const MAX_ATTEMPTS = 5
const MAX_SENDS = 5
const RESEND_SECONDS = 45

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })
const hashOf = (id, code) => crypto.createHmac('sha256', env.jwt.secret).update(`${id}:${code}`).digest('hex')
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

/** "yash@certezy.com" → "ya••@certezy.com" (shown on the code screen). */
export const maskEmail = (email = '') => {
  const [name, domain] = String(email).split('@')
  if (!domain) return email
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(2, name.length - 2))}@${domain}`
}

const mail = async (user, code, purpose) => {
  try {
    await sendLoginCodeMail(user.email, { name: user.name, code, purpose, minutes: CODE_MINUTES })
  } catch (err) {
    console.error('Login code email failed:', err.message)
    throw fail(502, "We couldn't send the code email right now. Try again in a minute.")
  }
}

/** Start a challenge (purpose 'login' or 'enable') and email the code. */
export const startChallenge = async (user, purpose = 'login') => {
  await pool.query('DELETE FROM login_challenges WHERE user_id = ? AND purpose = ?', [user.id, purpose])
  const id = crypto.randomBytes(24).toString('hex')
  const code = newCode()
  await pool.query(
    `INSERT INTO login_challenges (id, user_id, purpose, code_hash, expires_at, last_sent_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP() + INTERVAL ${CODE_MINUTES} MINUTE, UTC_TIMESTAMP())`,
    [id, user.id, purpose, hashOf(id, code)]
  )
  await mail(user, code, purpose)
  return { challenge: id, email_hint: maskEmail(user.email), expires_in: CODE_MINUTES * 60 }
}

const load = async (id, purpose) => {
  const [[row]] = await pool.query(
    `SELECT c.*, u.email, u.name, u.is_active, u.deleted_at,
            (c.expires_at <= UTC_TIMESTAMP()) AS expired,
            TIMESTAMPDIFF(SECOND, c.last_sent_at, UTC_TIMESTAMP()) AS since_sent
     FROM login_challenges c JOIN users u ON u.id = c.user_id
     WHERE c.id = ? AND c.purpose = ? LIMIT 1`,
    [String(id ?? ''), purpose]
  )
  if (!row || row.expired || !row.is_active || row.deleted_at) {
    if (row) await pool.query('DELETE FROM login_challenges WHERE id = ?', [row.id])
    throw fail(400, purpose === 'login' ? 'This code has expired. Sign in again.' : 'This code has expired. Start again.')
  }
  return row
}

export const resendChallenge = async (id, purpose = 'login') => {
  const row = await load(id, purpose)
  if (row.sends >= MAX_SENDS) throw fail(429, 'Too many codes sent. Sign in again in a few minutes.')
  if (row.since_sent < RESEND_SECONDS) throw fail(429, `Wait ${RESEND_SECONDS - row.since_sent} seconds before asking for a new code.`)
  const code = newCode()
  await pool.query(
    `UPDATE login_challenges SET code_hash = ?, attempts = 0, sends = sends + 1, last_sent_at = UTC_TIMESTAMP(),
            expires_at = UTC_TIMESTAMP() + INTERVAL ${CODE_MINUTES} MINUTE WHERE id = ?`,
    [hashOf(row.id, code), row.id]
  )
  await mail({ email: row.email, name: row.name }, code, purpose)
  return { challenge: row.id, email_hint: maskEmail(row.email), expires_in: CODE_MINUTES * 60 }
}

/** Check the code. Right → the challenge is used up and the user id returned. */
export const verifyChallenge = async (id, code, purpose = 'login') => {
  const row = await load(id, purpose)
  const given = Buffer.from(hashOf(row.id, String(code ?? '').replace(/\D/g, '')))
  const ok = given.length === 64 && crypto.timingSafeEqual(given, Buffer.from(row.code_hash))
  if (!ok) {
    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await pool.query('DELETE FROM login_challenges WHERE id = ?', [row.id])
      throw fail(401, purpose === 'login' ? 'Too many wrong codes. Sign in again.' : 'Too many wrong codes. Start again.')
    }
    await pool.query('UPDATE login_challenges SET attempts = ? WHERE id = ?', [attempts, row.id])
    throw fail(401, `That code isn't right. ${MAX_ATTEMPTS - attempts} ${MAX_ATTEMPTS - attempts === 1 ? 'try' : 'tries'} left.`)
  }
  await pool.query('DELETE FROM login_challenges WHERE id = ?', [row.id])
  return row.user_id
}
