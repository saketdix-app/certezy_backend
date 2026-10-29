// src/modules/reviews/reviews.service.js
//
// Ratings flow
//   1. An enrolled student rates a course 1–5★ (+ optional comment).
//   2. The review is live immediately when REVIEW_AUTO_APPROVE=true, otherwise
//      it waits for an admin (the student sees it as "pending" meanwhile).
//   3. Every change (create, edit, approve, reject, delete) recalculates the
//      course's rating_avg / rating_count and clears the course caches, so
//      cards and detail pages show the new numbers straight away.

import env from '../../config/env.js'
import * as queries from './reviews.queries.js'
import * as courseQueries from '../courses/courses.queries.js'
import { checkEnrollment } from '../enrollments/enrollments.service.js'
import { getCourseBySlug, invalidateCourseCache } from '../courses/courses.service.js'
import { AppError, parsePaging, buildPagination } from '../../utils/http.js'

// Reviews may be fetched by course id or slug
const resolveCourse = async (courseIdOrSlug) => {
  const course = await getCourseBySlug(courseIdOrSlug)
  return course
}

const formatStats = (row = {}) => ({
  rating_avg: Number(row.rating_avg || 0),
  rating_count: Number(row.rating_count || 0),
  distribution: {
    5: Number(row.r5 || 0),
    4: Number(row.r4 || 0),
    3: Number(row.r3 || 0),
    2: Number(row.r2 || 0),
    1: Number(row.r1 || 0),
  },
})

// ── Recalculate course rating (internal) ──────────────────────────────────
const updateCourseRating = async (course_id) => {
  const [stats] = await queries.getRatingStats(course_id)
  const { rating_avg, rating_count } = formatStats(stats[0])
  await courseQueries.updateRating(course_id, { rating_avg, rating_count })

  const [rows] = await courseQueries.getCourseById(course_id)
  await invalidateCourseCache(rows[0]?.slug, String(course_id))
}

// ── Submit review (student) ────────────────────────────────────────────────
const createReview = async (user_id, { course_id, rating, comment }) => {
  const enrollment = await checkEnrollment(user_id, course_id)
  if (!enrollment) throw AppError.forbidden('You must be enrolled to review this course')

  const [existing] = await queries.getReviewByUserAndCourse(user_id, course_id)
  if (existing.length)
    throw AppError.conflict('You have already reviewed this course — edit your review instead')

  const is_approved = env.reviews.autoApprove
  const [result] = await queries.createReview({ user_id, course_id, rating, comment, is_approved })
  if (is_approved) await updateCourseRating(course_id)

  const [rows] = await queries.getReviewById(result.insertId)
  return rows[0]
}

// ── Edit my review (student) ──────────────────────────────────────────────
const updateMyReview = async (user_id, courseIdOrSlug, { rating, comment }) => {
  const { id: course_id } = await resolveCourse(courseIdOrSlug)
  const [rows] = await queries.getReviewByUserAndCourse(user_id, course_id)
  if (!rows.length) throw AppError.notFound('Review')

  const is_approved = env.reviews.autoApprove
  await queries.updateReview(rows[0].id, { rating, comment, is_approved })
  await updateCourseRating(course_id)

  const [updated] = await queries.getReviewById(rows[0].id)
  return updated[0]
}

// ── My review for a course (student) — includes pending reviews ───────────
const getMyReview = async (user_id, courseIdOrSlug) => {
  const course = await resolveCourse(courseIdOrSlug)
  const [rows] = await queries.getReviewByUserAndCourse(user_id, course.id)
  return rows[0] ?? null
}

// ── Reviews + stats of a course (public) ──────────────────────────────────
const getReviewsByCourseId = async (courseIdOrSlug, query = {}) => {
  const course = await resolveCourse(courseIdOrSlug)
  const { page, limit, offset } = parsePaging(query, { defaultLimit: 10, maxLimit: 50 })
  const rating = [1, 2, 3, 4, 5].includes(Number(query.rating)) ? Number(query.rating) : undefined

  const [rows] = await queries.getReviewsByCourseId(course.id, { limit, offset, rating })
  const [stats] = await queries.getRatingStats(course.id)
  const summary = formatStats(stats[0])
  const filteredTotal = rating ? summary.distribution[rating] : summary.rating_count

  return {
    course_id: course.id,
    ...summary,
    reviews: rows,
    pagination: buildPagination({ total: filteredTotal, page, limit }),
  }
}

// ── Admin — get all reviews ────────────────────────────────────────────────
const getAllReviews = async (query = {}) => {
  const { page, limit, offset } = parsePaging(query)
  const filters = { is_approved: query.is_approved, course_id: query.course_id }

  const [rows] = await queries.getAllReviews({ limit, offset, ...filters })
  const [count] = await queries.countReviews(filters)

  return { reviews: rows, pagination: buildPagination({ total: count[0].total, page, limit }) }
}

// ── Public — latest approved reviews for homepage testimonials ─────────────
const getFeaturedReviews = async ({ limit = 6 } = {}) => {
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 20)
  const [rows] = await queries.getAllReviews({ limit: safeLimit, offset: 0, is_approved: 1 })
  return rows
}

// ── Admin — approve/reject review ─────────────────────────────────────────
const updateApprovalStatus = async (id, is_approved) => {
  const [rows] = await queries.getReviewById(id)
  if (!rows.length) throw AppError.notFound('Review')

  await queries.updateApprovalStatus(id, is_approved)
  await updateCourseRating(rows[0].course_id)

  const [updated] = await queries.getReviewById(id)
  return updated[0]
}

// ── Admin — delete review ──────────────────────────────────────────────────
const deleteReview = async (id) => {
  const [rows] = await queries.getReviewById(id)
  if (!rows.length) throw AppError.notFound('Review')

  await queries.deleteReviewById(id)
  await updateCourseRating(rows[0].course_id)
}

export {
  createReview,
  updateMyReview,
  getMyReview,
  getReviewsByCourseId,
  getAllReviews,
  getFeaturedReviews,
  updateApprovalStatus,
  deleteReview,
  updateCourseRating,
}
