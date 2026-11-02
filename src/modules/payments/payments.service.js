// src/modules/payments/payments.service.js

import Razorpay from 'razorpay'
import {
  Client,
  Environment,
  LogLevel,
  OrdersController,
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
} from '@paypal/paypal-server-sdk'
import axios from 'axios'
import crypto from 'crypto'
import env from '../../config/env.js'
import * as queries from './payments.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { createEnrollment } from '../enrollments/enrollments.service.js'
import { generateInvoice } from '../../utils/invoice.js'
import { generateInvoiceNumber } from '../../utils/generate.js'
import { sendInvoiceJob } from '../../jobs/emailQueue.js'
import { markDiscountUsed, verifyDiscountToken } from '../discounts/discounts.service.js'
import * as discountQueries from '../discounts/discounts.queries.js'
import { checkEnrollment } from '../enrollments/enrollments.service.js'
import { AppError } from '../../utils/http.js'
import { findById as findUserById } from '../auth/auth.queries.js'
import { isFreeCourse, resolveChargeAmount, resolveChargeAmountInr } from '../../utils/pricing.js'

// ─── Gateway Clients ──────────────────────────────────────────────────────
// Created on first use so the API still boots (and free courses still work)
// on environments without payment keys.

let razorpayClient = null
const getRazorpay = () => {
  if (!env.razorpay.keyId || !env.razorpay.keySecret) {
    throw new AppError('Razorpay is not configured on this server', 503)
  }
  razorpayClient ??= new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret })
  return razorpayClient
}

let ordersControllerInstance = null
const getPaypalOrders = () => {
  if (!env.paypal.clientId || !env.paypal.clientSecret) {
    throw new AppError('PayPal is not configured on this server', 503)
  }
  ordersControllerInstance ??= new OrdersController(
    new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: env.paypal.clientId,
        oAuthClientSecret: env.paypal.clientSecret,
      },
      environment: env.paypal.mode === 'live' ? Environment.Production : Environment.Sandbox,
      logging: {
        logLevel: env.isProd ? LogLevel.Warn : LogLevel.Info,
        logRequest: { logBody: !env.isProd },
        logResponse: { logHeaders: !env.isProd },
      },
    })
  )
  return ordersControllerInstance
}

const safeJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Readable reason from a PayPal SDK error (name — issue — description)
const paypalErrorDetail = (err) => {
  const body = err?.result ?? (typeof err?.body === 'string' ? safeJson(err.body) : err?.body)
  const issue = body?.details?.[0]
  return (
    [body?.name, issue?.issue, issue?.description || body?.message || err?.message]
      .filter(Boolean)
      .join(' — ') || 'unknown error'
  )
}

// ─── Admin: check both gateways' credentials (no money moves) ────────────
const checkGateways = async () => {
  const razorpay = {
    configured: Boolean(env.razorpay.keyId && env.razorpay.keySecret),
    mode: env.razorpay.keyId?.startsWith('rzp_live_') ? 'live' : env.razorpay.keyId ? 'test' : null,
    webhook_secret_set: Boolean(env.razorpay.webhookSecret),
    ok: false,
    error: null,
  }
  if (razorpay.configured) {
    try {
      await getRazorpay().orders.all({ count: 1 })
      razorpay.ok = true
    } catch (err) {
      razorpay.error = err?.error?.description || err?.message || 'Authentication failed'
    }
  } else {
    razorpay.error = 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set'
  }

  const paypal = {
    configured: Boolean(env.paypal.clientId && env.paypal.clientSecret),
    mode: env.paypal.mode === 'live' ? 'live' : 'sandbox',
    ok: false,
    error: null,
  }
  if (paypal.configured) {
    const base = paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
    try {
      await axios.post(`${base}/v1/oauth2/token`, 'grant_type=client_credentials', {
        auth: { username: env.paypal.clientId, password: env.paypal.clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      })
      paypal.ok = true
    } catch (err) {
      const d = err.response?.data
      paypal.error =
        d?.error === 'invalid_client'
          ? `Client ID / secret rejected by PayPal ${paypal.mode} — check the keys and PAYPAL_MODE (live keys need PAYPAL_MODE=live)`
          : d?.error_description || err.message
    }
  } else {
    paypal.error = 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set'
  }

  return {
    razorpay,
    paypal,
    paypal_return_url: `${env.frontendUrl}/payment/paypal/return`,
    razorpay_webhook_path: '/api/v1/payments/razorpay/webhook',
  }
}

// ─── Shared: what does this user pay for this course? ────────────────────
// The amount is ALWAYS computed here from the database. Anything the client
// sends about price is ignored — only a discount link id is accepted, and it
// is re-validated (owner, course, unused, not expired).
const prepareCheckout = async (user_id, { course_id, discount_link_id }) => {
  const [courseRows] = await courseQueries.getCourseById(course_id)
  const course = courseRows[0]
  if (!course || course.status !== 'published') throw AppError.notFound('Course')
  if (isFreeCourse(course))
    throw AppError.badRequest('This course is free — enrol directly, no payment needed')
  if (await checkEnrollment(user_id, course.id))
    throw AppError.conflict('You are already enrolled in this course')

  let discount = null
  if (discount_link_id) {
    const [rows] = await discountQueries.getDiscountById(discount_link_id)
    if (!rows.length) throw AppError.notFound('Discount link')
    discount = await verifyDiscountToken(rows[0].token, user_id) // throws if not usable
    if (Number(discount.course_id) !== Number(course.id)) {
      throw AppError.badRequest('This discount link is for a different course')
    }
  }

  return {
    course,
    discount,
    ...resolveChargeAmount(course, discount),
    inr: resolveChargeAmountInr(course, discount),
  }
}

const assertOwnPendingPayment = (payment, user_id) => {
  if (payment.user_id !== user_id) throw AppError.forbidden('This payment does not belong to you')
}

// Constant-time compare for HMAC signatures
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

// ─── Shared: after payment success ────────────────────────────────────────
const handlePaymentSuccess = async ({ payment_id, gateway_txn_id, user, courseTitle }) => {
  const invoiceNumber = generateInvoiceNumber()
  const payment = await getPaymentById(payment_id)

  // The money is already taken at this point: an invoice (S3) or email (queue)
  // problem must never stop the payment being recorded and the course unlocked.
  let invoice_url = null
  try {
    ;({ url: invoice_url } = await generateInvoice({
      invoiceNumber,
      studentName: user.name,
      studentEmail: user.email,
      courseTitle,
      amount: payment.amount,
      currency: payment.currency,
      transactionId: gateway_txn_id,
      date: new Date(),
    }))
  } catch (err) {
    console.error(`Invoice for payment ${payment_id} failed:`, err.message)
  }

  // Payment success mark karo
  await queries.markPaymentSuccess(payment_id, { gateway_txn_id, invoice_url })

  // Enrollment create karo
  await createEnrollment({
    user_id: payment.user_id,
    course_id: payment.course_id,
    payment_id: payment.id,
  })

  // Discount link use hua to mark karo
  if (payment.discount_link_id) {
    await markDiscountUsed(payment.discount_link_id, payment.user_id)
  }

  // Invoice email queue mein daalo
  try {
    await sendInvoiceJob({
      to: user.email,
      name: user.name,
      courseTitle,
      amount: payment.amount,
      invoiceUrl: invoice_url,
      transactionId: gateway_txn_id,
    })
  } catch (err) {
    console.error(`Invoice email for payment ${payment_id} failed:`, err.message)
  }

  return { invoice_url }
}

// ── Get payment by ID (internal) ───────────────────────────────────────────
const getPaymentById = async (id) => {
  const [rows] = await queries.getPaymentById(id)
  if (!rows.length) {
    const err = new Error('Payment not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ─────────────────────────────────────────────────────────────────────────
// RAZORPAY
// ─────────────────────────────────────────────────────────────────────────

const razorpayCreateOrder = async (user_id, body) => {
  // India: the course's rupee price (or the USD price converted), never a client amount
  const { course, inr } = await prepareCheckout(user_id, body)
  const { amount, original_amount } = inr

  const [result] = await queries.createPayment({
    user_id,
    course_id: course.id,
    amount,
    original_amount,
    currency: 'INR',
    method: 'razorpay',
    discount_link_id: body.discount_link_id ?? null,
  })

  let order
  try {
    order = await getRazorpay().orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `pay_${result.insertId}`,
      // Lets the webhook find our payment row
      notes: { payment_id: String(result.insertId), course_id: String(course.id), user_id: String(user_id) },
    })
  } catch (err) {
    await queries.markPaymentFailed(result.insertId)
    const detail = err?.error?.description || err?.message || 'unknown error'
    console.error('Razorpay create order failed:', detail)
    throw new AppError(`Razorpay could not start the payment: ${detail}`, 502)
  }

  return {
    payment_id: result.insertId,
    razorpay_order_id: order.id,
    amount,
    currency: 'INR',
    key_id: env.razorpay.keyId,
  }
}

const razorpayVerify = async (
  user,
  { payment_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
) => {
  const body = `${razorpay_order_id}|${razorpay_payment_id}`
  const expected = crypto
    .createHmac('sha256', env.razorpay.keySecret || '')
    .update(body)
    .digest('hex')

  if (!razorpay_signature || !safeEqual(expected, razorpay_signature)) {
    const err = new Error('Payment verification failed — invalid signature')
    err.statusCode = 400
    throw err
  }

  const [existing] = await queries.getPaymentByTxnId(razorpay_payment_id)
  if (existing.length) return { already_processed: true }

  const payment = await getPaymentById(payment_id)
  assertOwnPendingPayment(payment, user.id)
  if (payment.status === 'success') return { already_processed: true }
  const [courseRows] = await courseQueries.getCourseById(payment.course_id)

  const { invoice_url } = await handlePaymentSuccess({
    payment_id,
    gateway_txn_id: razorpay_payment_id,
    user,
    courseTitle: courseRows[0].title,
  })

  return { success: true, invoice_url }
}

// ─────────────────────────────────────────────────────────────────────────
// PAYPAL
// ─────────────────────────────────────────────────────────────────────────

const paypalCreateOrder = async (user_id, body) => {
  const { course, amount, original_amount } = await prepareCheckout(user_id, body)

  let order
  try {
    ;({ result: order } = await getPaypalOrders().createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            amount: { currencyCode: 'USD', value: Number(amount).toFixed(2) },
            description: course.title.slice(0, 127),
          },
        ],
        // Where PayPal sends the payer after approving / cancelling. Without a
        // return URL PayPal shows "Things don't appear to be working" after approval.
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: 'Certezy',
              returnUrl: `${env.frontendUrl}/payment/paypal/return`,
              cancelUrl: `${env.frontendUrl}/payment/paypal/cancel`,
              userAction: PaypalExperienceUserAction.PayNow,
              shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
            },
          },
        },
      },
      prefer: 'return=minimal',
    }))
  } catch (err) {
    console.error('PayPal create order failed:', paypalErrorDetail(err))
    throw new AppError(`PayPal could not start the payment: ${paypalErrorDetail(err)}`, 502)
  }

  // Approval link from PayPal itself, so it always matches sandbox / live
  const approve_url = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null

  const [result] = await queries.createPayment({
    user_id,
    course_id: course.id,
    amount,
    original_amount,
    currency: 'USD',
    method: 'paypal',
    discount_link_id: body.discount_link_id ?? null,
  })

  return {
    payment_id: result.insertId,
    paypal_order_id: order.id,
    approve_url,
    amount,
    currency: 'USD',
  }
}

const paypalCapture = async (user, { payment_id, paypal_order_id }) => {
  const [existing] = await queries.getPaymentByTxnId(paypal_order_id)
  if (existing.length) return { already_processed: true }

  assertOwnPendingPayment(await getPaymentById(payment_id), user.id)

  let captureData
  try {
    const { result } = await getPaypalOrders().captureOrder({
      id: paypal_order_id,
      prefer: 'return=minimal',
    })
    captureData = result
  } catch (err) {
    const detail = paypalErrorDetail(err)
    // Not approved (window closed / cancelled): leave it pending and say so plainly
    if (/ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/i.test(detail)) {
      throw new AppError('PayPal payment was not completed — the order was not approved', 400)
    }
    await queries.markPaymentFailed(payment_id)
    console.error('PayPal capture failed:', detail)
    throw new AppError(`PayPal payment capture failed: ${detail}`, 400)
  }

  if (captureData.status !== 'COMPLETED') {
    await queries.markPaymentFailed(payment_id)
    const err = new Error('PayPal payment not completed')
    err.statusCode = 400
    throw err
  }

  const payment = await getPaymentById(payment_id)
  const [courseRows] = await courseQueries.getCourseById(payment.course_id)

  const { invoice_url } = await handlePaymentSuccess({
    payment_id,
    gateway_txn_id: paypal_order_id,
    user,
    courseTitle: courseRows[0].title,
  })

  return { success: true, invoice_url }
}

// ─────────────────────────────────────────────────────────────────────────
// WEBHOOKS
// ─────────────────────────────────────────────────────────────────────────

const razorpayWebhook = async (rawBody, signature) => {
  if (!env.razorpay.webhookSecret) throw new AppError('Razorpay webhook secret not configured', 503)
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(typeof rawBody === 'string' ? rawBody : '')
  const expected = crypto.createHmac('sha256', env.razorpay.webhookSecret).update(raw).digest('hex')

  if (!signature || !safeEqual(expected, signature)) throw AppError.badRequest('Invalid webhook signature')

  const payload = JSON.parse(raw.toString('utf8'))

  if (payload.event === 'payment.captured') {
    const razorpay_payment_id = payload.payload.payment.entity.id

    const [existing] = await queries.getPaymentByTxnId(razorpay_payment_id)
    if (existing.length) return { already_processed: true }

    const payment_id = payload.payload.payment.entity.notes?.payment_id
    if (!payment_id) return { skipped: true }

    const payment = await getPaymentById(payment_id)
    if (payment.status === 'success') return { already_processed: true }
    const [courseRows] = await courseQueries.getCourseById(payment.course_id)

    await handlePaymentSuccess({
      payment_id,
      gateway_txn_id: razorpay_payment_id,
      user: (await findUserById(payment.user_id)) || { id: payment.user_id, name: '', email: '' },
      courseTitle: courseRows[0]?.title ?? '',
    })
  }

  return { received: true }
}

// ── Payment History (student) ──────────────────────────────────────────────
const getMyPayments = async (user_id) => {
  const [rows] = await queries.getPaymentsByUserId(user_id)
  return rows
}

// ── Admin — All Payments ───────────────────────────────────────────────────
const getAllPayments = async ({ page = 1, limit = 20, status } = {}) => {
  const offset = (page - 1) * limit

  const [rows] = await queries.getAllPayments({ limit, offset, status })
  const [count] = await queries.countPayments({ status })

  return {
    payments: rows,
    pagination: {
      total: count[0].total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count[0].total / limit),
    },
  }
}

// ── Admin — Revenue Stats ──────────────────────────────────────────────────
const getRevenueStats = async () => {
  return await queries.getRevenueStats()
}

export {
  checkGateways,
  razorpayCreateOrder,
  razorpayVerify,
  razorpayWebhook,
  paypalCreateOrder,
  paypalCapture,
  getMyPayments,
  getAllPayments,
  getRevenueStats,
}
