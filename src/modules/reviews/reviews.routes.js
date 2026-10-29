// src/modules/reviews/reviews.routes.js

import { Router } from 'express'
import Joi from 'joi'
import * as controller from './reviews.controller.js'
import authenticate from '../../middleware/auth.js'
import role from '../../middleware/role.js'
import { validate, schemas } from '../../middleware/validate.js'

const router = Router()

const approvalSchema = Joi.object({ is_approved: Joi.number().integer().valid(0, 1).required() })

// ─── ADMIN ────────────────────────────────────────────────────
router.get('/admin/all', authenticate, role('admin', 'sub_admin'), controller.getAllReviews)
router.get('/admin/pending', authenticate, role('admin', 'sub_admin'), controller.getPendingReviews)
router.put(
  '/:id/approval',
  authenticate,
  role('admin', 'sub_admin'),
  validate(approvalSchema),
  controller.updateApprovalStatus
)
router.delete('/:id', authenticate, role('admin'), controller.deleteReview)

// ─── STUDENT ──────────────────────────────────────────────────
router.post('/', authenticate, role('student'), validate(schemas.createReview), controller.createReview)
router.get('/course/:courseId/mine', authenticate, role('student'), controller.getMyReview)
router.put(
  '/course/:courseId/mine',
  authenticate,
  role('student'),
  validate(schemas.updateReview),
  controller.updateMyReview
)

// ─── PUBLIC ───────────────────────────────────────────────────
// NOTE: '/featured' must be registered before '/:courseId'
router.get('/featured', controller.getFeaturedReviews)
router.get('/:courseId', controller.getReviewsByCourseId) // id or slug

export default router
