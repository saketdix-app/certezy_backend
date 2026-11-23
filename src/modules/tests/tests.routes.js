// src/modules/tests/tests.routes.js

import { Router } from 'express'
import * as controller from './tests.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import permission from '../../middleware/permission.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── PUBLIC ──────────────────────────────────────────────────
router.get('/course/:course_id', controller.getTestsByCourseId)
// The full question list is staff-only (students get questions via /attempts/start)
router.get('/:id/full', authenticate, role('admin', 'sub_admin'), permission('can_manage_tests'), controller.getTestFull)
router.get('/:id', controller.getTestById)

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_tests'),
  validate(schemas.createTest),
  controller.createTest
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_tests'),
  validate(schemas.updateTest),
  controller.updateTest
)
router.delete(
  '/delete/:id',
  authenticate,
  role('admin', 'sub_admin'),
  permission('can_manage_tests'),
  controller.deleteTest
)

export default router
