// src/modules/courses/courses.controller.js

import * as service from './courses.service.js'
import { success } from '../../utils/response.js'
import { asyncHandler } from '../../utils/http.js'

// GET /courses?page&limit&status&category_id|category(slug)&level&is_featured&pricing&search&sortBy&sortOrder
const getAllCourses = asyncHandler(async (req, res) => {
  const result = await service.getAllCourses(req.query)
  return success(res, { message: 'Courses fetched', data: result.courses, pagination: result.pagination })
})

const getCourseBySlug = asyncHandler(async (req, res) => {
  const course = await service.getCourseBySlug(req.params.slug)
  return success(res, { message: 'Course fetched', data: { course } })
})

const createCourse = asyncHandler(async (req, res) => {
  const course = await service.createCourse(req.body, req.user.id)
  return success(res, { statusCode: 201, message: 'Course created', data: { course } })
})

const updateCourse = asyncHandler(async (req, res) => {
  const course = await service.updateCourse(req.params.id, req.body)
  return success(res, { message: 'Course updated', data: { course } })
})

const deleteCourse = asyncHandler(async (req, res) => {
  await service.deleteCourse(req.params.id)
  return success(res, { message: 'Course deleted' })
})

export { getAllCourses, getCourseBySlug, createCourse, updateCourse, deleteCourse }
