// src/modules/lessons/lessons.routes.js

import { Router } from 'express'
import * as controller from './lessons.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── PUBLIC ──────────────────────────────────────────────────
router.get('/section/:section_id', controller.getLessonsBySectionId)
router.get('/free/course/:course_id', controller.getFreeLessonsByCourseId)
router.get('/:id', controller.getLessonById)

// ─── ADMIN / SUB-ADMIN ONLY ───────────────────────────────────
router.post(
  '/create',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.createLesson),
  controller.createLesson
)
router.put(
  '/update/:id',
  authenticate,
  role('admin', 'sub_admin'),
  validate(schemas.updateLesson),
  controller.updateLesson
)
router.delete('/delete/:id', authenticate, role('admin', 'sub_admin'), controller.deleteLesson)

export default router
