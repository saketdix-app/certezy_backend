// src/modules/reviews/reviews.service.js

import * as queries from './reviews.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { checkEnrollment } from '../enrollments/enrollments.service.js'

// ── Submit review (student) ────────────────────────────────────────────────
const createReview = async (user_id, { course_id, rating, comment }) => {
  // Enrollment check — sirf enrolled student review de sakta hai
  const enrollment = await checkEnrollment(user_id, course_id)
  if (!enrollment) {
    const err = new Error('You must be enrolled to review this course')
    err.statusCode = 403
    throw err
  }

  // Already reviewed check
  const [existing] = await queries.getReviewByUserAndCourse(user_id, course_id)
  if (existing.length) {
    const err = new Error('You have already reviewed this course')
    err.statusCode = 409
    throw err
  }

  // Rating validation
  if (rating < 1 || rating > 5) {
    const err = new Error('Rating must be between 1 and 5')
    err.statusCode = 400
    throw err
  }

  // Review create karo
  const [result] = await queries.createReview({ user_id, course_id, rating, comment })
  const [rows] = await queries.getReviewById(result.insertId)

  // Course rating update karo
  await updateCourseRating(course_id)

  return rows[0]
}

// ── Get reviews by course (public) ────────────────────────────────────────
const getReviewsByCourseId = async (course_id) => {
  const [rows] = await queries.getReviewsByCourseId(course_id)
  const [stats] = await queries.getRatingStats(course_id)

  return {
    rating_avg: stats[0].rating_avg ?? 0,
    rating_count: stats[0].rating_count ?? 0,
    reviews: rows,
  }
}

// ── Update course rating (internal) ───────────────────────────────────────
const updateCourseRating = async (course_id) => {
  const [stats] = await queries.getRatingStats(course_id)
  await courseQueries.updateRating(course_id, {
    rating_avg: stats[0].rating_avg ?? 0,
    rating_count: stats[0].rating_count ?? 0,
  })
}

// ── Admin — get all reviews ────────────────────────────────────────────────
const getAllReviews = async ({ page = 1, limit = 20, is_approved } = {}) => {
  const offset = (page - 1) * limit

  const [rows] = await queries.getAllReviews({ limit, offset, is_approved })
  const [count] = await queries.countReviews({ is_approved })

  return {
    reviews: rows,
    pagination: {
      total: count[0].total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count[0].total / limit),
    },
  }
}

// ── Admin — approve/reject review ─────────────────────────────────────────
// ── Public — latest approved reviews for homepage testimonials ─────────────
const getFeaturedReviews = async ({ limit = 6 } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 20)
  const [rows] = await queries.getAllReviews({ limit: safeLimit, offset: 0, is_approved: 1 })
  return rows
}

const updateApprovalStatus = async (id, is_approved) => {
  const [rows] = await queries.getReviewById(id)
  if (!rows.length) {
    const err = new Error('Review not found')
    err.statusCode = 404
    throw err
  }

  await queries.updateApprovalStatus(id, is_approved)

  // Course rating recalculate karo
  await updateCourseRating(rows[0].course_id)

  const [updated] = await queries.getReviewById(id)
  return updated[0]
}

// ── Admin — delete review ──────────────────────────────────────────────────
const deleteReview = async (id) => {
  const [rows] = await queries.getReviewById(id)
  if (!rows.length) {
    const err = new Error('Review not found')
    err.statusCode = 404
    throw err
  }

  await queries.deleteReviewById(id)

  // Course rating recalculate karo
  await updateCourseRating(rows[0].course_id)
}

export {
  createReview,
  getReviewsByCourseId,
  getAllReviews,
  getFeaturedReviews,
  updateApprovalStatus,
  deleteReview,
}
