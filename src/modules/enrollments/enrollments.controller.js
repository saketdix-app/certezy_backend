// src/modules/enrollments/enrollments.controller.js

import * as service from './enrollments.service.js'
import { success } from '../../utils/response.js'

// ── GET /enrollments — my enrolled courses ─────────────────────────────────
const getMyEnrollments = async (req, res, next) => {
  try {
    const enrollments = await service.getMyEnrollments(req.user.id)
    return success(res, { message: 'Enrollments fetched', data: { enrollments } })
  } catch (err) {
    next(err)
  }
}

// ── GET /enrollments/:courseId — am I enrolled? ────────────────────────────
const checkEnrollment = async (req, res, next) => {
  try {
    const enrollment = await service.checkEnrollment(req.user.id, req.params.courseId)
    return success(res, {
      message: enrollment ? 'Enrolled' : 'Not enrolled',
      data: { enrolled: !!enrollment, enrollment: enrollment ?? null },
    })
  } catch (err) {
    next(err)
  }
}

// ── GET /admin/enrollments — all enrollments (admin) ──────────────────────
const getAllEnrollments = async (req, res, next) => {
  try {
    const { page, limit, course_id, user_id } = req.query
    const result = await service.getAllEnrollments({ page, limit, course_id, user_id })
    return success(res, {
      message: 'Enrollments fetched',
      data: result.enrollments,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

export { getMyEnrollments, checkEnrollment, getAllEnrollments }
