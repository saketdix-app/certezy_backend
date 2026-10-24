// src/modules/lessons/lessons.controller.js

import * as service from './lessons.service.js'
import { success } from '../../utils/response.js'

const getLessonsBySectionId = async (req, res, next) => {
  try {
    const lessons = await service.getLessonsBySectionId(req.params.section_id)
    return success(res, { message: 'Lessons fetched', data: { lessons } })
  } catch (err) {
    next(err)
  }
}

const getLessonById = async (req, res, next) => {
  try {
    const lesson = await service.getLessonById(req.params.id)
    return success(res, { message: 'Lesson fetched', data: { lesson } })
  } catch (err) {
    next(err)
  }
}

const getFreeLessonsByCourseId = async (req, res, next) => {
  try {
    const lessons = await service.getFreeLessonsByCourseId(req.params.course_id)
    return success(res, { message: 'Free lessons fetched', data: { lessons } })
  } catch (err) {
    next(err)
  }
}

const createLesson = async (req, res, next) => {
  try {
    const lesson = await service.createLesson(req.body)
    return success(res, { statusCode: 201, message: 'Lesson created', data: { lesson } })
  } catch (err) {
    next(err)
  }
}

const updateLesson = async (req, res, next) => {
  try {
    const lesson = await service.updateLesson(req.params.id, req.body)
    return success(res, { message: 'Lesson updated', data: { lesson } })
  } catch (err) {
    next(err)
  }
}

const deleteLesson = async (req, res, next) => {
  try {
    await service.deleteLesson(req.params.id)
    return success(res, { message: 'Lesson deleted' })
  } catch (err) {
    next(err)
  }
}

export {
  getLessonsBySectionId,
  getLessonById,
  getFreeLessonsByCourseId,
  createLesson,
  updateLesson,
  deleteLesson,
}
