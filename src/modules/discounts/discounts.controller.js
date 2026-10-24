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

// ── GET /discounts/verify/:token — verify token (student) ─────────────────
const verifyDiscountToken = async (req, res, next) => {
  try {
    const result = await service.verifyDiscountToken(req.params.token, req.user.id)
    return success(res, { message: 'Discount link valid', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /discounts — all discount links (admin) ────────────────────────────
const getAllDiscounts = async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const result = await service.getAllDiscounts({ page, limit })
    return success(res, {
      message: 'Discount links fetched',
      data: result.discounts,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

export { createDiscountLink, verifyDiscountToken, getAllDiscounts }
