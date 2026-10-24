// src/modules/options/options.routes.js

import { Router } from 'express'
import * as controller from './options.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── PUBLIC ──────────────────────────────────────────────────
router.get('/question/:question_id', controller.getOptionsByQuestionId)

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.createOption),
  controller.createOption
)
router.post(
  '/bulk/create',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.bulkCreateOptions),
  controller.bulkCreateOptions
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.updateOption),
  controller.updateOption
)
router.delete('/delete/:id', authenticate, role('admin', 'sub_admin'), controller.deleteOption)

export default router
