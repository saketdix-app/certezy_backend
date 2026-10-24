// src/modules/payments/payments.routes.js

import { Router } from 'express'
import * as controller from './payments.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import permission from '../../middleware/permission.js'
import express from 'express'

const router = Router()

// ─── RAZORPAY ─────────────────────────────────────────────────
router.post('/razorpay/create-order', authenticate, role('student'), controller.razorpayCreateOrder)
router.post('/razorpay/verify', authenticate, role('student'), controller.razorpayVerify)

// Webhook — raw body chahiye signature verify ke liye
router.post('/razorpay/webhook', express.raw({ type: 'application/json' }), controller.razorpayWebhook)

// ─── PAYPAL ───────────────────────────────────────────────────
router.post('/paypal/create-order', authenticate, role('student'), controller.paypalCreateOrder)
router.post('/paypal/capture', authenticate, role('student'), controller.paypalCapture)

// ─── HISTORY & STATS ──────────────────────────────────────────
router.get('/history', authenticate, role('student'), controller.getMyPayments)
router.get(
  '/admin/all',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_view_payments'),
  controller.getAllPayments
)
router.get(
  '/admin/revenue',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_view_payments'),
  controller.getRevenueStats
)

export default router
