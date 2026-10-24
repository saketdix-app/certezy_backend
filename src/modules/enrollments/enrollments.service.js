// src/modules/enrollments/enrollments.service.js

import * as queries from './enrollments.queries.js'
import * as courseQueries from '../courses/courses.queries.js'

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
const createEnrollment = async ({ user_id, course_id, payment_id }) => {
  // Already enrolled check
  const existing = await checkEnrollment(user_id, course_id)
  if (existing) {
    const err = new Error('Student already enrolled in this course')
    err.statusCode = 409
    throw err
  }

  // Course exists check
  const [courseCheck] = await courseQueries.checkCourseExists(course_id)
  if (!courseCheck.length) {
    const err = new Error('Course not found or archived')
    err.statusCode = 404
    throw err
  }

  // Create enrollment
  const [result] = await queries.createEnrollment({ user_id, course_id, payment_id })

  // Increment enrolled_count on course
  await courseQueries.incrementEnrolledCount(course_id)

  // Return new enrollment
  const [rows] = await queries.getEnrollmentById(result.insertId)
  return rows[0]
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

export { getMyEnrollments, checkEnrollment, createEnrollment, updateProgress, getAllEnrollments }
