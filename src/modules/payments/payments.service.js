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
import { markDiscountUsed } from '../discounts/discounts.service.js'

// ─── Gateway Clients ──────────────────────────────────────────────────────

const razorpay = new Razorpay({
  key_id: env.razorpay.keyId,
  key_secret: env.razorpay.keySecret,
})

const paypalClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: env.paypal.clientId,
    oAuthClientSecret: env.paypal.clientSecret,
  },
  environment: env.paypal.mode === 'live' ? Environment.Production : Environment.Sandbox,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: { logBody: true },
    logResponse: { logHeaders: true },
  },
})

const ordersController = new OrdersController(paypalClient)

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

const razorpayCreateOrder = async (user_id, { course_id, discount_link_id, discounted_amount }) => {
  const [courseRows] = await courseQueries.getCourseById(course_id)
  if (!courseRows.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }
  const course = courseRows[0]

  const original_amount = course.price
  const usdAmount = discounted_amount ?? course.price
  const amount = await convertUSDtoINR(usdAmount)

  const order = await razorpay.orders.create({
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt: `receipt_${Date.now()}`,
  })

  const [result] = await queries.createPayment({
    user_id,
    course_id,
    amount,
    original_amount,
    currency: 'INR',
    method: 'razorpay',
    discount_link_id: discount_link_id ?? null,
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
  const expected = crypto.createHmac('sha256', env.razorpay.keySecret).update(body).digest('hex')

  if (expected !== razorpay_signature) {
    const err = new Error('Payment verification failed — invalid signature')
    err.statusCode = 400
    throw err
  }

  const [existing] = await queries.getPaymentByTxnId(razorpay_payment_id)
  if (existing.length) return { already_processed: true }

  const payment = await getPaymentById(payment_id)
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

const paypalCreateOrder = async (user_id, { course_id, discount_link_id, discounted_amount }) => {
  const [courseRows] = await courseQueries.getCourseById(course_id)
  if (!courseRows.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }
  const course = courseRows[0]

  const original_amount = course.price
  const amount = discounted_amount ?? course.price

  const { result: order } = await ordersController.createOrder({
    body: {
      intent: CheckoutPaymentIntent.Capture,
      purchaseUnits: [
        {
          amount: {
            currencyCode: 'USD',
            value: String(Number(amount).toFixed(2)),
          },
          description: course.title,
        },
      ],
    },
    prefer: 'return=minimal',
  })

  const [result] = await queries.createPayment({
    user_id,
    course_id,
    amount,
    original_amount,
    currency: 'USD',
    method: 'paypal',
    discount_link_id: discount_link_id ?? null,
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

  let captureData
  try {
    const { result } = await ordersController.captureOrder({
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

const razorpayWebhook = async (rawBody, signature, payload) => {
  const expected = crypto.createHmac('sha256', env.razorpay.webhookSecret).update(rawBody).digest('hex')

  if (expected !== signature) {
    const err = new Error('Invalid webhook signature')
    err.statusCode = 400
    throw err
  }

  if (payload.event === 'payment.captured') {
    const razorpay_payment_id = payload.payload.payment.entity.id

    const [existing] = await queries.getPaymentByTxnId(razorpay_payment_id)
    if (existing.length) return { already_processed: true }

    const payment_id = payload.payload.payment.entity.notes?.payment_id
    if (!payment_id) return { skipped: true }

    const payment = await getPaymentById(payment_id)
    const [courseRows] = await courseQueries.getCourseById(payment.course_id)

    await handlePaymentSuccess({
      payment_id,
      gateway_txn_id: razorpay_payment_id,
      user: { id: payment.user_id, name: '', email: '' },
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
