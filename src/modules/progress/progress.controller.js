// src/modules/progress/progress.controller.js

import * as service from './progress.service.js'
import { success } from '../../utils/response.js'

// ── POST /progress — update lesson progress ────────────────────────────────
const updateLessonProgress = async (req, res, next) => {
  try {
    const { lesson_id, is_completed, watch_time } = req.body
    const result = await service.updateLessonProgress(req.user.id, lesson_id, { is_completed, watch_time })
    return success(res, { message: 'Progress updated', data: result })
  } catch (err) {
    next(err)
  }
}

// ── GET /progress/:courseId — get full course progress ────────────────────
const getCourseProgress = async (req, res, next) => {
  try {
    const result = await service.getCourseProgress(req.user.id, req.params.courseId)
    return success(res, { message: 'Progress fetched', data: result })
  } catch (err) {
    next(err)
  }
}

export { updateLessonProgress, getCourseProgress }
