// src/modules/reviews/reviews.controller.js

import * as service from './reviews.service.js'
import { success } from '../../utils/response.js'
import { asyncHandler } from '../../utils/http.js'

// POST /reviews — submit review (student)
const createReview = asyncHandler(async (req, res) => {
  const review = await service.createReview(req.user.id, req.body)
  return success(res, {
    statusCode: 201,
    message: review.is_approved
      ? 'Thanks! Your rating is live.'
      : 'Thanks! Your review will appear once approved.',
    data: { review },
  })
})

// PUT /reviews/course/:courseId/mine — edit my review (student)
const updateMyReview = asyncHandler(async (req, res) => {
  const review = await service.updateMyReview(req.user.id, req.params.courseId, req.body)
  return success(res, { message: 'Review updated', data: { review } })
})

// GET /reviews/course/:courseId/mine — my review incl. pending (student)
const getMyReview = asyncHandler(async (req, res) => {
  const review = await service.getMyReview(req.user.id, req.params.courseId)
  return success(res, { message: review ? 'Review found' : 'No review yet', data: { review } })
})

// GET /reviews/:courseId?page&limit&rating — approved reviews + stats (public)
const getReviewsByCourseId = asyncHandler(async (req, res) => {
  const result = await service.getReviewsByCourseId(req.params.courseId, req.query)
  return success(res, { message: 'Reviews fetched', data: result })
})

// GET /reviews/featured — homepage testimonials (public)
const getFeaturedReviews = asyncHandler(async (req, res) => {
  const reviews = await service.getFeaturedReviews({ limit: req.query.limit })
  return success(res, { message: 'Featured reviews fetched', data: reviews })
})

// GET /reviews/admin/all?page&limit&is_approved&course_id (admin)
const getAllReviews = asyncHandler(async (req, res) => {
  const result = await service.getAllReviews(req.query)
  return success(res, { message: 'Reviews fetched', data: result.reviews, pagination: result.pagination })
})

// GET /reviews/admin/pending?limit (admin)
const getPendingReviews = asyncHandler(async (req, res) => {
  const result = await service.getAllReviews({ page: 1, limit: req.query.limit || 10, is_approved: 0 })
  return success(res, {
    message: 'Pending reviews fetched',
    data: result.reviews,
    pagination: result.pagination,
  })
})

// PUT /reviews/:id/approval { is_approved } (admin)
const updateApprovalStatus = asyncHandler(async (req, res) => {
  const review = await service.updateApprovalStatus(req.params.id, req.body.is_approved)
  return success(res, { message: 'Review updated', data: { review } })
})

// DELETE /reviews/:id (admin)
const deleteReview = asyncHandler(async (req, res) => {
  await service.deleteReview(req.params.id)
  return success(res, { message: 'Review deleted' })
})

export {
  createReview,
  updateMyReview,
  getMyReview,
  getReviewsByCourseId,
  getAllReviews,
  getFeaturedReviews,
  getPendingReviews,
  updateApprovalStatus,
  deleteReview,
}
