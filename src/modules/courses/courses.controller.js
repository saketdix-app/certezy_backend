// src/modules/courses/courses.controller.js

import * as service from './courses.service.js'
import { success } from '../../utils/response.js'

const getAllCourses = async (req, res, next) => {
  try {
    const { page, limit, status, category_id, level, is_featured, search, sortBy, sortOrder } = req.query

    const result = await service.getAllCourses({
      page,
      limit,
      status,
      category_id,
      level,
      is_featured,
      search,
      sortBy,
      sortOrder,
    })

    return success(res, { message: 'Courses fetched', data: result.courses, pagination: result.pagination })
  } catch (err) {
    next(err)
  }
}

const getCourseBySlug = async (req, res, next) => {
  try {
    const course = await service.getCourseBySlug(req.params.slug)
    return success(res, { message: 'Course fetched', data: { course } })
  } catch (err) {
    next(err)
  }
}

const createCourse = async (req, res, next) => {
  try {
    const course = await service.createCourse(req.body, req.user.id)
    return success(res, { statusCode: 201, message: 'Course created', data: { course } })
  } catch (err) {
    next(err)
  }
}

const updateCourse = async (req, res, next) => {
  try {
    const course = await service.updateCourse(req.params.id, req.body)
    return success(res, { message: 'Course updated', data: { course } })
  } catch (err) {
    next(err)
  }
}

const deleteCourse = async (req, res, next) => {
  try {
    await service.deleteCourse(req.params.id)
    return success(res, { message: 'Course deleted' })
  } catch (err) {
    next(err)
  }
}

export { getAllCourses, getCourseBySlug, createCourse, updateCourse, deleteCourse }
