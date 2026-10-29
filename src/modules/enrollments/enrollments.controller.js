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

// ── POST /enrollments/free/:courseId — enrol in a free course ─────────────
const enrollFree = async (req, res, next) => {
  try {
    const result = await service.enrollFree(req.user.id, req.params.courseId)
    return success(res, {
      statusCode: result.already_enrolled ? 200 : 201,
      message: result.already_enrolled ? 'Already enrolled' : 'Enrolled successfully',
      data: result,
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

// ── POST /enrollments/admin/assign — assign courses free of cost ──────────
const assignCourses = async (req, res, next) => {
  try {
    const { user_id, course_ids, note } = req.body
    const result = await service.assignCourses({ user_id, course_ids, note, assigned_by: req.user.id })
    const n = result.assigned.length
    return success(res, {
      statusCode: n ? 201 : 200,
      message: n
        ? `${n} course${n > 1 ? 's' : ''} assigned to ${result.user.name}`
        : 'No new courses assigned',
      data: result,
    })
  } catch (err) {
    next(err)
  }
}

// ── GET /enrollments/admin/user/:userId — one user's courses ──────────────
const getUserEnrollments = async (req, res, next) => {
  try {
    const enrollments = await service.getUserEnrollments(req.params.userId)
    return success(res, { message: 'User enrollments fetched', data: { enrollments } })
  } catch (err) {
    next(err)
  }
}

// ── DELETE /enrollments/admin/:id — revoke a free enrollment ──────────────
const revokeEnrollment = async (req, res, next) => {
  try {
    const data = await service.revokeEnrollment(req.params.id)
    return success(res, { message: 'Course access revoked', data })
  } catch (err) {
    next(err)
  }
}

// ── GET /enrollments/admin/courses — courses that can be assigned ─────────
const getAssignableCourses = async (req, res, next) => {
  try {
    const courses = await service.getAssignableCourses({ search: req.query.search })
    return success(res, { message: 'Courses fetched', data: { courses } })
  } catch (err) {
    next(err)
  }
}

export {
  enrollFree,
  getMyEnrollments,
  checkEnrollment,
  getAllEnrollments,
  assignCourses,
  getUserEnrollments,
  revokeEnrollment,
  getAssignableCourses,
}
