// src/modules/progress/progress.routes.js

import { Router } from 'express'
import * as controller from './progress.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'

const router = Router()

// ─── STUDENT ONLY ─────────────────────────────────────────────
router.post('/', authenticate, role('student'), controller.updateLessonProgress)
router.get('/:courseId', authenticate, role('student'), controller.getCourseProgress)

export default router
