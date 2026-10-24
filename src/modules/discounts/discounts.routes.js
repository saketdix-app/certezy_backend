// src/modules/discounts/discounts.routes.js

import { Router } from 'express'
import * as controller from './discounts.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import permission from '../../middleware/permission.js'

const router = Router()

// ─── ADMIN ────────────────────────────────────────────────────
router.post(
  '/',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_send_discounts'),
  controller.createDiscountLink
)
router.get('/', authenticate, role('admin', 'sub_admin'), controller.getAllDiscounts)

// ─── STUDENT ──────────────────────────────────────────────────
router.get('/verify/:token', authenticate, role('student'), controller.verifyDiscountToken)

export default router
