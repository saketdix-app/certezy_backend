// src/modules/progress/progress.routes.js

import { Router } from 'express'
import * as controller from './progress.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { LEARNER_ROLES } from '../../constants.js'

const router = Router()

// ─── STUDENT ONLY ─────────────────────────────────────────────
router.post('/', authenticate, role(...LEARNER_ROLES), controller.updateLessonProgress)
router.get('/:courseId', authenticate, role(...LEARNER_ROLES), controller.getCourseProgress)

export default router
