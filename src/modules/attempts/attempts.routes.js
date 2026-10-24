// src/modules/attempts/attempts.routes.js

import { Router } from 'express'
import * as controller from './attempts.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'

const router = Router()

// ise dekna h enrollment wala krne ke badd

// ─── STUDENT ONLY ─────────────────────────────────────────────
router.post('/:testId/start', authenticate, role('student'), controller.startAttempt)
router.post('/submit', authenticate, role('student'), controller.submitAttempt)
router.get('/:testId/history', authenticate, role('student'), controller.getAttemptHistory)
router.get('/:attemptId/detail', authenticate, role('student'), controller.getAttemptDetail)

export default router
