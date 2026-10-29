// src/modules/enrollments/enrollments.service.js

import * as queries from './enrollments.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import * as authQueries from '../auth/auth.queries.js'
import { sendCourseAssignedJob } from '../../jobs/emailQueue.js'
import { AppError } from '../../utils/http.js'
import { isFreeCourse } from '../../utils/pricing.js'
import { ENROLLMENT_SOURCES } from '../../constants.js'
import { invalidateCourseCache } from '../courses/courses.service.js'

const httpError = (message, statusCode) => new AppError(message, statusCode)

// ── Get my enrolled courses (student) ─────────────────────────────────────
const getMyEnrollments = async (user_id) => {
  const [rows] = await queries.getEnrollmentsByUserId(user_id)
  return rows
}

// ── Check if student is enrolled in a course ──────────────────────────────
const checkEnrollment = async (user_id, course_id) => {
  const [rows] = await queries.getEnrollment(user_id, course_id)
  return rows.length ? rows[0] : null
}

// ── Create enrollment — called internally by payment service ──────────────
const createEnrollment = async ({ user_id, course_id, payment_id, source = ENROLLMENT_SOURCES.PURCHASE }) => {
  const existing = await checkEnrollment(user_id, course_id)
  if (existing) throw AppError.conflict('Student already enrolled in this course')

  const [courseCheck] = await courseQueries.checkCourseExists(course_id)
  if (!courseCheck.length) throw AppError.notFound('Course')

  const [result] = await queries.createEnrollment({ user_id, course_id, payment_id, source })

  await courseQueries.incrementEnrolledCount(course_id)
  await invalidateCourseCache()

  // Return new enrollment
  const [rows] = await queries.getEnrollmentById(result.insertId)
  return rows[0]
}

// ── Student — enrol in a free course (no checkout) ────────────────────────
const enrollFree = async (user_id, course_id) => {
  const [rows] = await courseQueries.getCourseById(course_id)
  const course = rows[0]
  if (!course || course.status !== 'published') throw AppError.notFound('Course')
  if (!isFreeCourse(course))
    throw AppError.badRequest('This course is paid — please complete checkout to enrol')

  const existing = await checkEnrollment(user_id, course_id)
  if (existing) return { enrollment: existing, already_enrolled: true }

  const enrollment = await createEnrollment({ user_id, course_id, source: ENROLLMENT_SOURCES.FREE })
  return { enrollment, already_enrolled: false }
}

// ── Update progress (called by progress service) ───────────────────────────
const updateProgress = async (user_id, course_id, progress) => {
  // Must be enrolled
  const enrollment = await checkEnrollment(user_id, course_id)
  if (!enrollment) {
    const err = new Error('Enrollment not found')
    err.statusCode = 404
    throw err
  }

  // If 100% — mark completed
  if (progress >= 100) {
    await queries.markCompleted(user_id, course_id)
  } else {
    await queries.updateProgress(user_id, course_id, progress)
  }

  return await checkEnrollment(user_id, course_id)
}

// ── Admin — get all enrollments ────────────────────────────────────────────
const getAllEnrollments = async ({ page = 1, limit = 20, course_id, user_id } = {}) => {
  const offset = (page - 1) * limit

  const [rows] = await queries.getAllEnrollments({ limit, offset, course_id, user_id })
  const [count] = await queries.countEnrollments({ course_id, user_id })

  const total = count[0].total

  return {
    enrollments: rows,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    },
  }
}

// ── Admin — assign courses free of cost (₹0, no payment) ──────────────────
// Returns which courses were assigned and which were skipped (and why).
const assignCourses = async ({ user_id, course_ids, note, assigned_by }) => {
  const user = await authQueries.findById(user_id)
  if (!user) throw httpError('User not found', 404)
  if (user.role !== 'student') throw httpError('Courses can only be assigned to student accounts', 400)
  if (!user.is_active) throw httpError('This user account is deactivated', 400)

  const uniqueIds = [...new Set(course_ids.map(Number))]
  const assigned = []
  const skipped = []

  for (const course_id of uniqueIds) {
    const [courseRows] = await courseQueries.checkCourseExists(course_id)
    if (!courseRows.length) {
      skipped.push({ course_id, reason: 'Course not found or archived' })
      continue
    }
    if (await checkEnrollment(user_id, course_id)) {
      skipped.push({ course_id, reason: 'Already enrolled' })
      continue
    }
    try {
      const [result] = await queries.createAssignedEnrollment({ user_id, course_id, assigned_by, note })
      await courseQueries.incrementEnrolledCount(course_id)
      await invalidateCourseCache()
      assigned.push({ course_id, enrollment_id: result.insertId })
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        skipped.push({ course_id, reason: 'Already enrolled' })
        continue
      }
      if (err.code === 'ER_BAD_FIELD_ERROR' || err.code === 'ER_BAD_NULL_ERROR') {
        throw httpError(
          'Database is not ready for free assignments yet. Restart the backend so it can apply its migration.',
          500
        )
      }
      throw err
    }
  }

  // Notify the student (best effort — never blocks the assignment)
  if (assigned.length) {
    const enrollments = await getUserEnrollments(user_id)
    const titles = enrollments
      .filter((e) => assigned.some((a) => a.course_id === e.course_id))
      .map((e) => e.course_title)
    sendCourseAssignedJob({ to: user.email, name: user.name, courseTitles: titles }).catch((err) =>
      console.error('Course-assigned email not queued:', err.message)
    )
  }

  return { user: { id: user.id, name: user.name, email: user.email }, assigned, skipped }
}

// ── Admin — a user's enrollments, with how each was granted ───────────────
const getUserEnrollments = async (user_id) => {
  const [rows] = await queries.getUserEnrollmentsDetailed(user_id)
  return rows
}

// ── Admin — revoke a free (admin-assigned) enrollment ─────────────────────
const revokeEnrollment = async (enrollment_id) => {
  const [rows] = await queries.getEnrollmentById(enrollment_id)
  const enrollment = rows[0]
  if (!enrollment) throw httpError('Enrollment not found', 404)
  if (enrollment.source !== 'admin') {
    throw httpError(
      'Only free (admin-assigned) enrollments can be revoked here. Paid enrollments need a refund.',
      400
    )
  }

  await queries.deleteEnrollmentById(enrollment_id)
  await courseQueries.decrementEnrolledCount(enrollment.course_id)
  await invalidateCourseCache()
  return { id: enrollment.id, user_id: enrollment.user_id, course_id: enrollment.course_id }
}

// ── Admin — courses available for assignment ──────────────────────────────
const getAssignableCourses = async ({ search } = {}) => {
  const [rows] = await queries.getAssignableCourses({ search })
  return rows
}

export {
  getMyEnrollments,
  checkEnrollment,
  createEnrollment,
  enrollFree,
  updateProgress,
  getAllEnrollments,
  assignCourses,
  getUserEnrollments,
  revokeEnrollment,
  getAssignableCourses,
}
