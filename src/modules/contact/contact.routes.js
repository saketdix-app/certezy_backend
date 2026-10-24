// src/modules/contact/contact.routes.js

import { Router } from 'express'
import * as controller from './contact.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ── PUBLIC + LOGGED IN ────────────────────────────────────────
// authenticate optional — logged in ho toh user_id link hoga, nahi toh guest
router.post(
  '/create',
  (req, res, next) => {
    // Optional auth — fail hone pe bhi continue karo
    authenticate(req, res, (err) => next())
  },
  controller.submit
)

// ── ADMIN ONLY ─────────────────────────────────────────────────
router.get('/', authenticate, role('admin', 'sub_admin'), controller.getAll)

router.get('/:id', authenticate, role('admin', 'sub_admin'), controller.getById)

router.put('/:id/status', authenticate, role('admin', 'sub_admin'), controller.updateStatus)

export default router
