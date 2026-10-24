// src/modules/options/options.controller.js

import * as service from './options.service.js'
import { success } from '../../utils/response.js'

const getOptionsByQuestionId = async (req, res, next) => {
  try {
    const options = await service.getOptionsByQuestionId(req.params.question_id)
    return success(res, { message: 'Options fetched', data: { options } })
  } catch (err) {
    next(err)
  }
}

const createOption = async (req, res, next) => {
  try {
    const option = await service.createOption(req.body)
    return success(res, { statusCode: 201, message: 'Option created', data: { option } })
  } catch (err) {
    next(err)
  }
}

const bulkCreateOptions = async (req, res, next) => {
  try {
    const { question_id, options } = req.body
    const result = await service.bulkCreateOptions(question_id, options)
    return success(res, { statusCode: 201, message: 'Options created', data: { options: result } })
  } catch (err) {
    next(err)
  }
}

const updateOption = async (req, res, next) => {
  try {
    const option = await service.updateOption(req.params.id, req.body)
    return success(res, { message: 'Option updated', data: { option } })
  } catch (err) {
    next(err)
  }
}

const deleteOption = async (req, res, next) => {
  try {
    await service.deleteOption(req.params.id)
    return success(res, { message: 'Option deleted' })
  } catch (err) {
    next(err)
  }
}

export { getOptionsByQuestionId, createOption, bulkCreateOptions, updateOption, deleteOption }
