// src/modules/payments/guestCheckout.service.js
// Buy a course without logging in first.
//
// Safety rule: a checkout form NEVER signs anyone in. Whoever types an email
// could otherwise get into that person's account. Instead:
//   • New email → an account is created (no password). After payment the
//     course is unlocked and a "set your password" link is emailed — proving
//     the buyer owns the address.
//   • Existing email → the course is added to that account (paying for
//     someone's course can't hurt them); they log in to start learning.
//   • The follow-up calls (verify / capture) are authorised by a short-lived
//     signed guest token tied to this payment and user — not a login.
//   • Discount links are personal, so they still need a login.
// The started checkout also becomes a CRM lead ("Checkout started"), so the
// existing abandoned-checkout reminder covers guests too.

import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import env from '../../config/env.js'
import { pool } from '../../config/db.js'
import { AppError } from '../../utils/http.js'
import { LEARNER_ROLES } from '../../constants.js'
import { findById as findUserById } from '../auth/auth.queries.js'
import { processEvent, recordEvent } from '../integrations/ingest.service.js'
import * as payments from './payments.service.js'

const TOKEN_KIND = 'guest_checkout'
const secret = () => `${env.jwt.secret}:${TOKEN_KIND}`

/** Find the buyer's account by email, or create one without a password. */
export const findOrCreateBuyer = async ({ name, email, phone }) => {
  const normalized = String(email).trim().toLowerCase()
  const [[existing]] = await pool.query(
    'SELECT id, name, email, role, is_active, deleted_at FROM users WHERE LOWER(email) = ? LIMIT 1',
    [normalized]
  )
  if (existing) {
    if (existing.deleted_at || !existing.is_active) {
      throw AppError.forbidden('This email can’t be used for checkout — please contact support')
    }
    if (!LEARNER_ROLES.includes(existing.role)) {
      throw AppError.forbidden('This email belongs to a staff account — log in to buy with it')
    }
    return { user: existing, isNew: false }
  }
  const [r] = await pool.query(
    `INSERT INTO users (name, email, mobile, password, role, oauth_provider, is_verified, is_active)
     VALUES (?, ?, ?, NULL, 'student', 'local', 0, 1)`,
    [String(name).trim().slice(0, 150), normalized, phone?.trim() || null]
  )
  return { user: { id: r.insertId, name: String(name).trim(), email: normalized, role: 'student' }, isNew: true }
}

const signGuestToken = (userId, paymentId) =>
  jwt.sign({ kind: TOKEN_KIND, uid: userId, pid: Number(paymentId), n: crypto.randomBytes(6).toString('hex') }, secret(), {
    expiresIn: '6h',
  })

/** Guest token → the buyer, after checking it is for this payment. */
const readGuestToken = async (token, paymentId) => {
  let claims
  try {
    claims = jwt.verify(String(token ?? ''), secret())
  } catch {
    throw AppError.forbidden('This checkout session has expired — please start the payment again')
  }
  if (claims.kind !== TOKEN_KIND || Number(claims.pid) !== Number(paymentId)) {
    throw AppError.forbidden('This checkout session doesn’t match the payment')
  }
  const user = await findUserById(claims.uid)
  if (!user) throw AppError.forbidden('This checkout session has expired — please start the payment again')
  return user
}

/** The started checkout becomes (or is added to) a CRM lead. Never blocks checkout. */
const recordCheckoutLead = async ({ name, email, phone }, course) => {
  try {
    const ref = `checkout-${crypto.randomUUID()}`
    const { id } = await recordEvent('website', ref, {
      lead: {
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
        phone: phone?.trim() || null,
        course_id: course.id,
        platform_lead_id: ref,
        source_meta: { form: 'Checkout started', page: `/checkout?course=${course.id}` },
        consent: { platform: 'website', note: 'Started checkout as a guest', at: new Date().toISOString() },
      },
    })
    await processEvent(id)
  } catch (err) {
    console.error('Checkout lead failed (checkout continues):', err.message)
  }
}

const startGuest = async (body) => {
  const { user, isNew } = await findOrCreateBuyer(body)
  return { user, account: isNew ? 'new' : 'existing' }
}

// "You are already enrolled" means something else to a guest
const forGuest = (err) => {
  if (err?.statusCode === 409 && /already enrolled/i.test(err.message)) {
    return AppError.conflict('This email already has this course — log in to start learning')
  }
  return err
}

export const guestRazorpayCreateOrder = async (body, region) => {
  const { user, account } = await startGuest(body)
  let order
  try {
    order = await payments.razorpayCreateOrder(user.id, { course_id: body.course_id }, region)
  } catch (err) {
    throw forGuest(err)
  }
  await recordCheckoutLead(body, { id: body.course_id })
  return { ...order, guest_token: signGuestToken(user.id, order.payment_id), account, email: user.email }
}

export const guestRazorpayVerify = async (body) => {
  const user = await readGuestToken(body.guest_token, body.payment_id)
  const result = await payments.razorpayVerify(user, body)
  return { ...result, email: user.email }
}

export const guestPaypalCreateOrder = async (body, region) => {
  const { user, account } = await startGuest(body)
  let order
  try {
    order = await payments.paypalCreateOrder(user.id, { course_id: body.course_id }, region)
  } catch (err) {
    throw forGuest(err)
  }
  await recordCheckoutLead(body, { id: body.course_id })
  return { ...order, guest_token: signGuestToken(user.id, order.payment_id), account, email: user.email }
}

export const guestPaypalCapture = async (body) => {
  const user = await readGuestToken(body.guest_token, body.payment_id)
  const result = await payments.paypalCapture(user, body)
  return { ...result, email: user.email }
}
