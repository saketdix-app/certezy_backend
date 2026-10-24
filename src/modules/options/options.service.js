// src/modules/options/options.service.js

import * as queries from './options.queries.js'

// ── Get all options by question_id ─────────────────────────────────────────
const getOptionsByQuestionId = async (question_id) => {
  const [rows] = await queries.getOptionsByQuestionId(question_id)
  return rows
}

// ── Get single option by ID ────────────────────────────────────────────────
const getOptionById = async (id) => {
  const [rows] = await queries.getOptionById(id)
  if (!rows.length) {
    const err = new Error('Option not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Create single option ───────────────────────────────────────────────────
const createOption = async ({ question_id, option_text, is_correct, order_num }) => {
  const [questionCheck] = await queries.checkQuestionExists(question_id)
  if (!questionCheck.length) {
    const err = new Error('Question not found')
    err.statusCode = 404
    throw err
  }

  const [result] = await queries.createOption({ question_id, option_text, is_correct, order_num })
  return await getOptionById(result.insertId)
}

// ── Bulk create options ────────────────────────────────────────────────────
const bulkCreateOptions = async (question_id, options) => {
  const [questionCheck] = await queries.checkQuestionExists(question_id)
  if (!questionCheck.length) {
    const err = new Error('Question not found')
    err.statusCode = 404
    throw err
  }

  const formatted = options.map((o, i) => ({
    question_id,
    option_text: o.option_text,
    is_correct: o.is_correct ?? 0,
    order_num: o.order_num ?? i + 1,
  }))

  await queries.bulkCreateOptions(formatted)
  const [rows] = await queries.getOptionsByQuestionId(question_id)
  return rows
}

// ── Update option ──────────────────────────────────────────────────────────
const updateOption = async (id, body) => {
  const current = await getOptionById(id)

  const option_text = body.option_text ?? current.option_text
  const is_correct = body.is_correct ?? current.is_correct
  const order_num = body.order_num ?? current.order_num

  await queries.updateOption(id, { option_text, is_correct, order_num })
  return await getOptionById(id)
}

// ── Delete option ──────────────────────────────────────────────────────────
const deleteOption = async (id) => {
  await getOptionById(id)
  await queries.deleteOptionById(id)
}

export { getOptionsByQuestionId, getOptionById, createOption, bulkCreateOptions, updateOption, deleteOption }
