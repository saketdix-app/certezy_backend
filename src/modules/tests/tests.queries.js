// src/modules/tests/tests.queries.js

import { pool } from '../../config/db.js'

// ── Get all tests by course_id ─────────────────────────────────────────────
const getTestsByCourseId = (course_id) =>
  pool.query(
    `SELECT id, course_id,  title, type, duration, total_questions, pass_percentage, status, created_at
     FROM tests
     WHERE course_id = ? AND status = 'active'
     ORDER BY created_at ASC`,
    [course_id]
  )

// ── Get single test by ID ──────────────────────────────────────────────────
const getTestById = (id) => pool.query(`SELECT * FROM tests WHERE id = ? LIMIT 1`, [id])

// ── Get test with all questions and options ────────────────────────────────
const getTestFull = (id) =>
  pool.query(
    `SELECT
       t.id AS test_id, t.title, t.type, t.duration, t.total_questions,
       t.pass_percentage, t.status,
       q.id AS question_id, q.question, q.type AS question_type,
       q.explanation, q.difficulty, q.topic_tag, q.order_num AS question_order,
       o.id AS option_id, o.option_text, o.is_correct, o.order_num AS option_order
     FROM tests t
     LEFT JOIN questions q ON q.test_id = t.id
     LEFT JOIN options o ON o.question_id = q.id
     WHERE t.id = ?
     ORDER BY q.order_num ASC, o.order_num ASC`,
    [id]
  )

// ── Check course exists ────────────────────────────────────────────────────
const checkCourseExists = (course_id) =>
  pool.query("SELECT id FROM courses WHERE id = ? AND status != 'archived' LIMIT 1", [course_id])

// ── Create test ────────────────────────────────────────────────────────────
const createTest = ({ course_id, title, type, duration, pass_percentage, status }) =>
  pool.query(
    `INSERT INTO tests (course_id,  title, type, duration, pass_percentage, status)
     VALUES (?, ?, ?, ?,  ?, ?)`,
    [course_id, title, type ?? 'practice', duration ?? 60, pass_percentage ?? 70, status ?? 'active']
  )

// ── Update test ────────────────────────────────────────────────────────────
const updateTest = (id, { title, type, duration, pass_percentage, status }) =>
  pool.query(
    `UPDATE tests SET title = ?, type = ?, duration = ?, pass_percentage = ?, status = ?
     WHERE id = ?`,
    [title, type, duration, pass_percentage, status, id]
  )

// ── Delete test ────────────────────────────────────────────────────────────
// Removes the test with everything that belongs to it — students' attempts and
// their answers, questions and options — in one transaction, so it also works
// on databases whose foreign keys don't cascade.
const deleteTestById = async (id) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      'DELETE aa FROM attempt_answers aa JOIN test_attempts ta ON ta.id = aa.attempt_id WHERE ta.test_id = ?',
      [id]
    )
    await conn.query(
      'DELETE aa FROM attempt_answers aa JOIN questions q ON q.id = aa.question_id WHERE q.test_id = ?',
      [id]
    )
    await conn.query('DELETE FROM test_attempts WHERE test_id = ?', [id])
    await conn.query('DELETE o FROM options o JOIN questions q ON q.id = o.question_id WHERE q.test_id = ?', [
      id,
    ])
    await conn.query('DELETE FROM questions WHERE test_id = ?', [id])
    await conn.query('DELETE FROM tests WHERE id = ?', [id])
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

// ── Update total_questions count ───────────────────────────────────────────
const updateTotalQuestions = (test_id) =>
  pool.query(
    'UPDATE tests SET total_questions = (SELECT COUNT(*) FROM questions WHERE test_id = ?) WHERE id = ?',
    [test_id, test_id]
  )

export {
  getTestsByCourseId,
  getTestById,
  getTestFull,
  checkCourseExists,
  createTest,
  updateTest,
  deleteTestById,
  updateTotalQuestions,
}
