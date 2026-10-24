// src/modules/sections/sections.queries.js

import { pool } from '../../config/db.js'

// ── Get all sections by course_id ──────────────────────────────────────────
const getSectionsByCourseId = (course_id) =>
  pool.query(
    `SELECT id, course_id, title, order_num, created_at, updated_at
     FROM sections
     WHERE course_id = ?
     ORDER BY order_num ASC`,
    [course_id]
  )

// ── Get single section by ID ───────────────────────────────────────────────
const getSectionById = (id) =>
  pool.query(
    `SELECT id, course_id, title, order_num, created_at, updated_at
     FROM sections
     WHERE id = ?
     LIMIT 1`,
    [id]
  )

// ── Check if course exists ─────────────────────────────────────────────────
const checkCourseExists = (course_id) =>
  pool.query('SELECT id FROM courses WHERE id = ? LIMIT 1', [course_id])

// ── Get max order_num for a course (for auto order) ───────────────────────
const getMaxOrderNum = (course_id) =>
  pool.query('SELECT MAX(order_num) AS max_order FROM sections WHERE course_id = ?', [course_id])

// ── Create section ─────────────────────────────────────────────────────────
const createSection = ({ course_id, title, order_num }) =>
  pool.query('INSERT INTO sections (course_id, title, order_num) VALUES (?, ?, ?)', [
    course_id,
    title,
    order_num,
  ])

// ── Update section ─────────────────────────────────────────────────────────
const updateSection = (id, { title, order_num }) =>
  pool.query('UPDATE sections SET title = ?, order_num = ? WHERE id = ?', [title, order_num, id])

// ── Delete section ─────────────────────────────────────────────────────────
const deleteSectionById = (id) => pool.query('DELETE FROM sections WHERE id = ?', [id])

// ── Check if section has lessons ───────────────────────────────────────────
const hasLessons = (id) => pool.query('SELECT id FROM lessons WHERE section_id = ? LIMIT 1', [id])

export {
  getSectionsByCourseId,
  getSectionById,
  checkCourseExists,
  getMaxOrderNum,
  createSection,
  updateSection,
  deleteSectionById,
  hasLessons,
}
