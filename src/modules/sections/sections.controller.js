// src/modules/sections/sections.controller.js

import * as service from './sections.service.js'
import { success } from '../../utils/response.js'

const getSectionsByCourseId = async (req, res, next) => {
  try {
    const sections = await service.getSectionsByCourseId(req.params.course_id)
    return success(res, { message: 'Sections fetched', data: { sections } })
  } catch (err) {
    next(err)
  }
}

const getSectionById = async (req, res, next) => {
  try {
    const section = await service.getSectionById(req.params.id)
    return success(res, { message: 'Section fetched', data: { section } })
  } catch (err) {
    next(err)
  }
}

const createSection = async (req, res, next) => {
  try {
    const section = await service.createSection(req.body)
    return success(res, { statusCode: 201, message: 'Section created', data: { section } })
  } catch (err) {
    next(err)
  }
}

const updateSection = async (req, res, next) => {
  try {
    const section = await service.updateSection(req.params.id, req.body)
    return success(res, { message: 'Section updated', data: { section } })
  } catch (err) {
    next(err)
  }
}

const deleteSection = async (req, res, next) => {
  try {
    await service.deleteSection(req.params.id)
    return success(res, { message: 'Section deleted' })
  } catch (err) {
    next(err)
  }
}

export { getSectionsByCourseId, getSectionById, createSection, updateSection, deleteSection }
