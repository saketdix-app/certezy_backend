// src/modules/reviews/reviews.controller.js

import * as service from './reviews.service.js'
import { success } from '../../utils/response.js'

// ── POST /reviews — submit review (student) ────────────────────────────────
const createReview = async (req, res, next) => {
  try {
    const review = await service.createReview(req.user.id, req.body)
    return success(res, { statusCode: 201, message: 'Review submitted', data: { review } })
  } catch (err) {
    next(err)
  }
}

// ── GET /reviews/:courseId — get course reviews (public) ───────────────────
const getReviewsByCourseId = async (req, res, next) => {
  try {
    const result = await service.getReviewsByCourseId(req.params.courseId)
    return success(res, { message: 'Reviews fetched', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /reviews/admin/all — all reviews (admin) ───────────────────────────
const getFeaturedReviews = async (req, res, next) => {
  try {
    const reviews = await service.getFeaturedReviews({ limit: req.query.limit })
    return success(res, { message: 'Featured reviews fetched', data: reviews })
  } catch (err) {
    next(err)
  }
}

const getAllReviews = async (req, res, next) => {
  try {
    const { page, limit, is_approved } = req.query
    const result = await service.getAllReviews({ page, limit, is_approved })
    return success(res, {
      message: 'Reviews fetched',
      data: result.reviews,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

// ── PUT /reviews/:id/approval — approve/reject (admin) ────────────────────
const updateApprovalStatus = async (req, res, next) => {
  try {
    const review = await service.updateApprovalStatus(req.params.id, req.body.is_approved)
    return success(res, { message: 'Review updated', data: { review } })
  } catch (err) {
    next(err)
  }
}

// ── DELETE /reviews/:id — delete review (admin) ────────────────────────────
const deleteReview = async (req, res, next) => {
  try {
    await service.deleteReview(req.params.id)
    return success(res, { message: 'Review deleted' })
  } catch (err) {
    next(err)
  }
}

// ── GET /reviews/admin/pending — pending reviews (admin) ───────────────────
const getPendingReviews = async (req, res, next) => {
  try {
    const { limit = 10 } = req.query
    const result = await service.getAllReviews({ page: 1, limit, is_approved: 0 })
    return success(res, {
      message: 'Pending reviews fetched',
      data: result.reviews,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

export {
  createReview,
  getReviewsByCourseId,
  getAllReviews,
  getFeaturedReviews,
  getPendingReviews,
  updateApprovalStatus,
  deleteReview,
}
