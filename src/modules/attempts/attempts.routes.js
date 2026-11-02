// src/modules/attempts/attempts.routes.js

import { Router } from 'express'
import * as controller from './attempts.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { LEARNER_ROLES } from '../../constants.js'

const router = Router()

// ise dekna h enrollment wala krne ke badd

// ─── STUDENT ONLY ─────────────────────────────────────────────
router.post('/:testId/start', authenticate, role(...LEARNER_ROLES), controller.startAttempt)
router.post('/submit', authenticate, role(...LEARNER_ROLES), controller.submitAttempt)
router.get('/:testId/history', authenticate, role(...LEARNER_ROLES), controller.getAttemptHistory)
router.get('/:attemptId/detail', authenticate, role(...LEARNER_ROLES), controller.getAttemptDetail)

export default router
