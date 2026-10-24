// src/modules/questions/questions.controller.js

import * as service from './questions.service.js'
import { success } from '../../utils/response.js'

const getQuestionsByTestId = async (req, res, next) => {
  try {
    const questions = await service.getQuestionsByTestId(req.params.test_id)
    return success(res, { message: 'Questions fetched', data: { questions } })
  } catch (err) {
    next(err)
  }
}

const getQuestionById = async (req, res, next) => {
  try {
    const question = await service.getQuestionById(req.params.id)
    return success(res, { message: 'Question fetched', data: { question } })
  } catch (err) {
    next(err)
  }
}

const createQuestion = async (req, res, next) => {
  try {
    const question = await service.createQuestion(req.body)
    return success(res, { statusCode: 201, message: 'Question created', data: { question } })
  } catch (err) {
    next(err)
  }
}

const updateQuestion = async (req, res, next) => {
  try {
    const question = await service.updateQuestion(req.params.id, req.body)
    return success(res, { message: 'Question updated', data: { question } })
  } catch (err) {
    next(err)
  }
}

const deleteQuestion = async (req, res, next) => {
  try {
    await service.deleteQuestion(req.params.id)
    return success(res, { message: 'Question deleted' })
  } catch (err) {
    next(err)
  }
}

export { getQuestionsByTestId, getQuestionById, createQuestion, updateQuestion, deleteQuestion }
