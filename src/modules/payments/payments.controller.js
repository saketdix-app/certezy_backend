// src/modules/payments/payments.controller.js

import * as service from './payments.service.js'
import { success } from '../../utils/response.js'

// ── POST /payments/razorpay/create-order ───────────────────────────────────
const razorpayCreateOrder = async (req, res, next) => {
  try {
    const result = await service.razorpayCreateOrder(req.user.id, req.body)
    return success(res, { statusCode: 201, message: 'Razorpay order created', data: result })
  } catch (err) {
    next(err)
  }
}

// ── POST /payments/razorpay/verify ─────────────────────────────────────────
const razorpayVerify = async (req, res, next) => {
  try {
    const result = await service.razorpayVerify(req.user, req.body)
    return success(res, { message: 'Payment verified', data: result })
  } catch (err) {
    next(err)
  }
}

// ── POST /payments/razorpay/webhook ────────────────────────────────────────
const razorpayWebhook = async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature']
    const result = await service.razorpayWebhook(req.rawBody, signature, req.body)
    return success(res, { message: 'Webhook received', data: result })
  } catch (err) {
    next(err)
  }
}

// ── POST /payments/paypal/create-order ────────────────────────────────────
const paypalCreateOrder = async (req, res, next) => {
  try {
    const result = await service.paypalCreateOrder(req.user.id, req.body)
    return success(res, { statusCode: 201, message: 'PayPal order created', data: result })
  } catch (err) {
    next(err)
  }
}

// ── POST /payments/paypal/capture ─────────────────────────────────────────
const paypalCapture = async (req, res, next) => {
  try {
    const result = await service.paypalCapture(req.user, req.body)
    return success(res, { message: 'Payment captured', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /payments/history ─────────────────────────────────────────────────
const getMyPayments = async (req, res, next) => {
  try {
    const payments = await service.getMyPayments(req.user.id)
    return success(res, { message: 'Payment history fetched', data: { payments } })
  } catch (err) {
    next(err)
  }
}

// ── GET /payments/admin/all ───────────────────────────────────────────────
const getAllPayments = async (req, res, next) => {
  try {
    const { page, limit, status } = req.query
    const result = await service.getAllPayments({ page, limit, status })
    return success(res, {
      message: 'Payments fetched',
      data: result.payments,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

// ── GET /payments/admin/revenue ───────────────────────────────────────────
const getRevenueStats = async (req, res, next) => {
  try {
    const data = await service.getRevenueStats()
    return success(res, { message: 'Revenue stats fetched', data })
  } catch (err) {
    next(err)
  }
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
