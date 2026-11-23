// src/modules/questions/questions.routes.js

import { Router } from 'express'
import * as controller from './questions.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import permission from '../../middleware/permission.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── STAFF ONLY: the question bank is paid exam content ───────
router.get('/test/:test_id', authenticate, role('admin', 'sub_admin'), permission('can_manage_tests'), controller.getQuestionsByTestId)
router.get('/:id', authenticate, role('admin', 'sub_admin'), permission('can_manage_tests'), controller.getQuestionById)

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_tests'),
  validate(schemas.createQuestion),
  controller.createQuestion
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_tests'),
  validate(schemas.updateQuestion),
  controller.updateQuestion
)
router.delete('/delete/:id', authenticate, role('admin', 'sub_admin'), permission('can_manage_tests'), controller.deleteQuestion)

export default router
