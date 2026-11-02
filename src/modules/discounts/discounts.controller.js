// src/modules/discounts/discounts.controller.js

import * as service from './discounts.service.js'
import { success } from '../../utils/response.js'

// ── POST /discounts — create discount link (admin) ─────────────────────────
const createDiscountLink = async (req, res, next) => {
  try {
    const result = await service.createDiscountLink(req.user.id, req.body)
    return success(res, { statusCode: 201, message: 'Discount link created', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /discounts/offer/:token — public offer details (landing page) ──────
const getOffer = async (req, res, next) => {
  try {
    const offer = await service.getOffer(req.params.token)
    return success(res, { message: 'Offer fetched', data: offer })
  } catch (err) {
    next(err)
  }
}

// ── GET /discounts/verify/:token — verify token (student) ─────────────────
const verifyDiscountToken = async (req, res, next) => {
  try {
    const result = await service.verifyDiscountToken(req.params.token, req.user.id)
    return success(res, { message: 'Discount link valid', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /discounts — sent links (admin) ?search &status &course_id &page ──
const getAllDiscounts = async (req, res, next) => {
  try {
    const result = await service.getAllDiscounts(req.query)
    return success(res, {
      message: 'Discount links fetched',
      data: { discounts: result.discounts, stats: result.stats },
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

// ── POST /discounts/:id/resend — email the same link again (admin) ────────
const resendDiscount = async (req, res, next) => {
  try {
    const data = await service.resendDiscount(req.params.id, req.body ?? {})
    return success(res, { message: `Offer sent again to ${data.sent_to}`, data })
  } catch (err) {
    next(err)
  }
}

export { createDiscountLink, verifyDiscountToken, getAllDiscounts, getOffer, resendDiscount }
