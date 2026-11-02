// src/modules/enrollments/enrollments.routes.js

import { Router } from 'express'
import * as controller from './enrollments.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { LEARNER_ROLES } from '../../constants.js'
import permission from '../../middleware/permission.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

// ─── ADMIN / SUB-ADMIN ────────────────────────────────────────
const isAdmin = [authenticate, role('admin', 'sub_admin')]
router.get('/admin/all', ...isAdmin, controller.getAllEnrollments)
router.get('/admin/stats', ...isAdmin, controller.getEnrollmentStats)
router.get('/admin/export', ...isAdmin, controller.exportEnrollments)

// Free course assignment — admins, and sub-admins with "manage students"
const canAssign = [authenticate, role('admin', 'sub_admin'), permission('can_manage_students')]
router.get('/admin/courses', ...canAssign, controller.getAssignableCourses)
router.get('/admin/user/:userId', ...canAssign, controller.getUserEnrollments)
router.post('/admin/assign', ...canAssign, validate(schemas.assignCourses), controller.assignCourses)
router.delete('/admin/:id', ...canAssign, controller.revokeEnrollment)

// ─── STUDENT ──────────────────────────────────────────────────
router.get('/', authenticate, role(...LEARNER_ROLES), controller.getMyEnrollments)
router.post('/free/:courseId', authenticate, role(...LEARNER_ROLES), controller.enrollFree)
router.get('/:courseId', authenticate, role(...LEARNER_ROLES), controller.checkEnrollment)

export default router
