// src/modules/payments/payments.service.js

import Razorpay from 'razorpay'
import {
  Client,
  Environment,
  LogLevel,
  OrdersController,
  CheckoutPaymentIntent,
} from '@paypal/paypal-server-sdk'
import crypto from 'crypto'
import env from '../../config/env.js'
import * as queries from './payments.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { createEnrollment } from '../enrollments/enrollments.service.js'
import { generateInvoice } from '../../utils/invoice.js'
import { generateInvoiceNumber } from '../../utils/generate.js'
import { convertUSDtoINR } from '../../utils/currency.js'
import { sendInvoiceJob } from '../../jobs/emailQueue.js'
import { markDiscountUsed, verifyDiscountToken } from '../discounts/discounts.service.js'
import * as discountQueries from '../discounts/discounts.queries.js'
import { checkEnrollment } from '../enrollments/enrollments.service.js'
import { AppError } from '../../utils/http.js'
import { findById as findUserById } from '../auth/auth.queries.js'
import { isFreeCourse, resolveChargeAmount } from '../../utils/pricing.js'

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

  return { course, discount, ...resolveChargeAmount(course, discount) }
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

  const { url: invoice_url } = await generateInvoice({
    invoiceNumber,
    studentName: user.name,
    studentEmail: user.email,
    courseTitle,
    amount: payment.amount,
    currency: payment.currency,
    transactionId: gateway_txn_id,
    date: new Date(),
  })

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
    await markDiscountUsed(payment.discount_link_id)
  }

  // Invoice email queue mein daalo
  await sendInvoiceJob({
    to: user.email,
    name: user.name,
    courseTitle,
    amount: payment.amount,
    invoiceUrl: invoice_url,
    transactionId: gateway_txn_id,
  })

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
  const { course, amount: usdAmount, original_amount } = await prepareCheckout(user_id, body)
  const amount = await convertUSDtoINR(usdAmount)

  const [result] = await queries.createPayment({
    user_id,
    course_id: course.id,
    amount,
    original_amount,
    currency: 'INR',
    method: 'razorpay',
    discount_link_id: body.discount_link_id ?? null,
  })

  const order = await getRazorpay().orders.create({
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt: `pay_${result.insertId}`,
    // Lets the webhook find our payment row
    notes: { payment_id: String(result.insertId), course_id: String(course.id), user_id: String(user_id) },
  })

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

  const { result: order } = await getPaypalOrders().createOrder({
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          amount: { currencyCode: 'USD', value: Number(amount).toFixed(2) },
          description: course.title.slice(0, 127),
        },
      ],
    },
    prefer: 'return=minimal',
  })

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
    await queries.markPaymentFailed(payment_id)
    const error = new Error('PayPal payment capture failed')
    error.statusCode = 400
    throw error
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
  razorpayCreateOrder,
  razorpayVerify,
  razorpayWebhook,
  paypalCreateOrder,
  paypalCapture,
  getMyPayments,
  getAllPayments,
  getRevenueStats,
}
