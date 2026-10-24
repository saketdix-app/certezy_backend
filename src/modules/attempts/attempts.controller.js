// src/modules/attempts/attempts.controller.js

import * as service from './attempts.service.js'
import { success } from '../../utils/response.js'

// ── POST /attempts/start ───────────────────────────────────────────────────
const startAttempt = async (req, res, next) => {
  try {
    console.log(req.user)
    const result = await service.startAttempt(req.user.id, req.params.testId)
    return success(res, { statusCode: 201, message: 'Attempt started', data: result })
  } catch (err) {
    next(err)
  }
}

// ── POST /attempts/submit ──────────────────────────────────────────────────
const submitAttempt = async (req, res, next) => {
  try {
    const result = await service.submitAttempt(req.user.id, req.body)
    return success(res, { message: 'Attempt submitted', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /attempts/:testId/history ─────────────────────────────────────────
const getAttemptHistory = async (req, res, next) => {
  try {
    const attempts = await service.getAttemptHistory(req.user.id, req.params.testId)
    return success(res, { message: 'Attempt history fetched', data: { attempts } })
  } catch (err) {
    next(err)
  }
}

// ── GET /attempts/:attemptId/detail ───────────────────────────────────────
const getAttemptDetail = async (req, res, next) => {
  try {
    const detail = await service.getAttemptDetail(req.user.id, req.params.attemptId)
    return success(res, { message: 'Attempt detail fetched', data: detail })
  } catch (err) {
    next(err)
  }
}

export { startAttempt, submitAttempt, getAttemptHistory, getAttemptDetail }
