// src/modules/options/options.queries.js

import { pool } from '../../config/db.js'

// ── Get all options by question_id ─────────────────────────────────────────
const getOptionsByQuestionId = (question_id) =>
  pool.query(
    'SELECT id, question_id, option_text, order_num FROM options WHERE question_id = ? ORDER BY order_num ASC',
    [question_id]
  )

// ── Get single option by ID ────────────────────────────────────────────────
const getOptionById = (id) => pool.query('SELECT * FROM options WHERE id = ? LIMIT 1', [id])

// ── Get correct options by question_id (for auto scoring) ─────────────────
const getCorrectOptions = (question_id) =>
  pool.query('SELECT id FROM options WHERE question_id = ? AND is_correct = 1', [question_id])

// ── Check question exists ──────────────────────────────────────────────────
const checkQuestionExists = (question_id) =>
  pool.query('SELECT id FROM questions WHERE id = ? LIMIT 1', [question_id])

// ── Create option ──────────────────────────────────────────────────────────
const createOption = ({ question_id, option_text, is_correct, order_num }) =>
  pool.query('INSERT INTO options (question_id, option_text, is_correct, order_num) VALUES (?, ?, ?, ?)', [
    question_id,
    option_text,
    is_correct ?? 0,
    order_num ?? 0,
  ])

// ── Bulk create options (for creating multiple options at once) ────────────
const bulkCreateOptions = (options) => {
  const values = options.map((o) => [o.question_id, o.option_text, o.is_correct ?? 0, o.order_num ?? 0])
  return pool.query('INSERT INTO options (question_id, option_text, is_correct, order_num) VALUES ?', [
    values,
  ])
}

// ── Update option ──────────────────────────────────────────────────────────
const updateOption = (id, { option_text, is_correct, order_num }) =>
  pool.query('UPDATE options SET option_text = ?, is_correct = ?, order_num = ? WHERE id = ?', [
    option_text,
    is_correct,
    order_num,
    id,
  ])

// ── Delete option ──────────────────────────────────────────────────────────
const deleteOptionById = (id) => pool.query('DELETE FROM options WHERE id = ?', [id])

// ── Delete all options by question_id ─────────────────────────────────────
const deleteOptionsByQuestionId = (question_id) =>
  pool.query('DELETE FROM options WHERE question_id = ?', [question_id])

export {
  getOptionsByQuestionId,
  getOptionById,
  getCorrectOptions,
  checkQuestionExists,
  createOption,
  bulkCreateOptions,
  updateOption,
  deleteOptionById,
  deleteOptionsByQuestionId,
}
