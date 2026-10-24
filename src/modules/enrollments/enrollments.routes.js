// src/modules/enrollments/enrollments.routes.js

import { Router } from 'express'
import * as controller from './enrollments.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'

const router = Router()

// ─── ADMIN / SUB-ADMIN ────────────────────────────────────────
router.get('/admin/all', authenticate, role('admin', 'sub_admin'), controller.getAllEnrollments)

// ─── STUDENT ──────────────────────────────────────────────────
router.get('/', authenticate, role('student'), controller.getMyEnrollments)
router.get('/:courseId', authenticate, role('student'), controller.checkEnrollment)

export default router
