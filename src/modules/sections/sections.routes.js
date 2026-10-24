// src/modules/sections/sections.routes.js

import { Router } from 'express'
import * as controller from './sections.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── PUBLIC ──────────────────────────────────────────────────
router.get('/course/:course_id', controller.getSectionsByCourseId)
router.get('/:id', controller.getSectionById)

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.createSection),
  controller.createSection
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.updateSection),
  controller.updateSection
)
router.delete('/delete/:id', authenticate, role('admin', 'sub_admin'), controller.deleteSection)

export default router
