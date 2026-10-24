// src/modules/questions/questions.routes.js

import { Router } from 'express'
import * as controller from './questions.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── PUBLIC ──────────────────────────────────────────────────
router.get('/test/:test_id', controller.getQuestionsByTestId)
router.get('/:id', controller.getQuestionById)

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.createQuestion),
  controller.createQuestion
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.updateQuestion),
  controller.updateQuestion
)
router.delete('/delete/:id', authenticate, role('admin', 'sub_admin'), controller.deleteQuestion)

export default router
