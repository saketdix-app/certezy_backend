// src/modules/payments/payments.routes.js

import { Router } from 'express'
import * as controller from './payments.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { LEARNER_ROLES } from '../../constants.js'
import permission from '../../middleware/permission.js'
import express from 'express'
import { validate, schemas } from '../../middleware/validate.js'
import { guestCheckoutLimiter } from '../../middleware/rateLimit.js'

const router = Router()

// ─── GUEST CHECKOUT (no login; guest token authorises verify / capture) ───
router.post('/guest/razorpay/create-order', guestCheckoutLimiter, validate(schemas.guestCheckout), controller.guestRazorpayCreateOrder)
router.post('/guest/razorpay/verify', guestCheckoutLimiter, validate(schemas.guestRazorpayVerify), controller.guestRazorpayVerify)
router.post('/guest/paypal/create-order', guestCheckoutLimiter, validate(schemas.guestCheckout), controller.guestPaypalCreateOrder)
router.post('/guest/paypal/capture', guestCheckoutLimiter, validate(schemas.guestPaypalCapture), controller.guestPaypalCapture)

// ─── RAZORPAY ─────────────────────────────────────────────────
router.post('/razorpay/create-order', authenticate, role(...LEARNER_ROLES), controller.razorpayCreateOrder)
router.post('/razorpay/verify', authenticate, role(...LEARNER_ROLES), controller.razorpayVerify)

// Webhook — raw body chahiye signature verify ke liye
router.post('/razorpay/webhook', express.raw({ type: 'application/json' }), controller.razorpayWebhook)

// ─── PAYPAL ───────────────────────────────────────────────────
router.post('/paypal/create-order', authenticate, role(...LEARNER_ROLES), controller.paypalCreateOrder)
router.post('/paypal/capture', authenticate, role(...LEARNER_ROLES), controller.paypalCapture)

// ─── HISTORY & STATS ──────────────────────────────────────────
router.get('/history', authenticate, role(...LEARNER_ROLES), controller.getMyPayments)
router.get(
  '/admin/all',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_view_payments'),
  controller.getAllPayments
)
router.get(
  '/admin/gateways',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_view_payments'),
  controller.checkGateways
)
// Revenue totals: Super Admins only
router.get('/admin/revenue', authenticate, role('super_admin'), controller.getRevenueStats)

export default router
