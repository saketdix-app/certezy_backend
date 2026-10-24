// src/modules/tests/tests.controller.js

import * as service from './tests.service.js'
import { success } from '../../utils/response.js'

const getTestsByCourseId = async (req, res, next) => {
  try {
    const tests = await service.getTestsByCourseId(req.params.course_id)
    return success(res, { message: 'Tests fetched', data: { tests } })
  } catch (err) {
    next(err)
  }
}

const getTestById = async (req, res, next) => {
  try {
    const test = await service.getTestById(req.params.id)
    return success(res, { message: 'Test fetched', data: { test } })
  } catch (err) {
    next(err)
  }
}

const getTestFull = async (req, res, next) => {
  try {
    const test = await service.getTestFull(req.params.id)
    return success(res, { message: 'Test fetched', data: { test } })
  } catch (err) {
    next(err)
  }
}

const createTest = async (req, res, next) => {
  try {
    const test = await service.createTest(req.body)
    return success(res, { statusCode: 201, message: 'Test created', data: { test } })
  } catch (err) {
    next(err)
  }
}

const updateTest = async (req, res, next) => {
  try {
    const test = await service.updateTest(req.params.id, req.body)
    return success(res, { message: 'Test updated', data: { test } })
  } catch (err) {
    next(err)
  }
}

const deleteTest = async (req, res, next) => {
  try {
    await service.deleteTest(req.params.id)
    return success(res, { message: 'Test deleted' })
  } catch (err) {
    next(err)
  }
}

export { getTestsByCourseId, getTestById, getTestFull, createTest, updateTest, deleteTest }
