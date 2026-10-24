// src/modules/questions/questions.queries.js

import { pool } from '../../config/db.js'

// ── Get all questions by test_id (with options) ────────────────────────────
const getQuestionsByTestId = (test_id) =>
  pool.query(
    `SELECT
       q.id, q.test_id, q.question, q.type, q.explanation,
       q.difficulty, q.topic_tag, q.order_num,
       o.id AS option_id, o.option_text, o.order_num AS option_order
     FROM questions q
     LEFT JOIN options o ON o.question_id = q.id
     WHERE q.test_id = ?
     ORDER BY q.order_num ASC, o.order_num ASC`,
    [test_id]
  )

// ── Get single question by ID ──────────────────────────────────────────────
const getQuestionById = (id) => pool.query('SELECT * FROM questions WHERE id = ? LIMIT 1', [id])

// ── Get max order_num for a test ───────────────────────────────────────────
const getMaxOrderNum = (test_id) =>
  pool.query('SELECT MAX(order_num) AS max_order FROM questions WHERE test_id = ?', [test_id])

// ── Check test exists ──────────────────────────────────────────────────────
const checkTestExists = (test_id) =>
  pool.query("SELECT id FROM tests WHERE id = ? AND status = 'active' LIMIT 1", [test_id])

// ── Create question ────────────────────────────────────────────────────────
const createQuestion = ({ test_id, question, type, explanation, difficulty, topic_tag, order_num }) =>
  pool.query(
    `INSERT INTO questions (test_id, question, type, explanation, difficulty, topic_tag, order_num)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      test_id,
      question,
      type ?? 'single',
      explanation ?? null,
      difficulty ?? 'medium',
      topic_tag ?? null,
      order_num,
    ]
  )

// ── Update question ────────────────────────────────────────────────────────
const updateQuestion = (id, { question, type, explanation, difficulty, topic_tag, order_num }) =>
  pool.query(
    `UPDATE questions SET question = ?, type = ?, explanation = ?, difficulty = ?, topic_tag = ?, order_num = ?
     WHERE id = ?`,
    [question, type, explanation, difficulty, topic_tag, order_num, id]
  )

// ── Delete question ────────────────────────────────────────────────────────
const deleteQuestionById = (id) => pool.query('DELETE FROM questions WHERE id = ?', [id])

export {
  getQuestionsByTestId,
  getQuestionById,
  getMaxOrderNum,
  checkTestExists,
  createQuestion,
  updateQuestion,
  deleteQuestionById,
}
