// src/modules/lessons/lessons.queries.js

import { pool } from '../../config/db.js'

// ── Get all lessons by section_id ──────────────────────────────────────────
const getLessonsBySectionId = (section_id) =>
  pool.query(
    `SELECT id, section_id, title, type, duration, order_num, is_free, created_at, updated_at
     FROM lessons
     WHERE section_id = ?
     ORDER BY order_num ASC`,
    [section_id]
  )

// ── Get single lesson by ID ────────────────────────────────────────────────
const getLessonById = (id) =>
  pool.query(
    `SELECT id, section_id, title, type, content, duration, order_num, is_free, created_at, updated_at
     FROM lessons
     WHERE id = ?
     LIMIT 1`,
    [id]
  )

// ── Get free preview lessons by course_id (no login needed) ───────────────
const getFreeLessonsByCourseId = (course_id) =>
  pool.query(
    `SELECT l.id, l.section_id, l.title, l.type, l.content, l.duration, l.order_num
     FROM lessons l
     INNER JOIN sections s ON s.id = l.section_id
     WHERE s.course_id = ? AND l.is_free = 1
     ORDER BY l.order_num ASC`,
    [course_id]
  )

// ── Check section exists ───────────────────────────────────────────────────
const checkSectionExists = (section_id) =>
  pool.query('SELECT id FROM sections WHERE id = ? LIMIT 1', [section_id])

// ── Get max order_num for a section ───────────────────────────────────────
const getMaxOrderNum = (section_id) =>
  pool.query('SELECT MAX(order_num) AS max_order FROM lessons WHERE section_id = ?', [section_id])

// ── Create lesson ──────────────────────────────────────────────────────────
const createLesson = ({ section_id, title, type, content, duration, order_num, is_free }) =>
  pool.query(
    `INSERT INTO lessons (section_id, title, type, content, duration, order_num, is_free)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [section_id, title, type ?? 'video', content ?? null, duration ?? 0, order_num, is_free ?? 0]
  )

// ── Update lesson ──────────────────────────────────────────────────────────
const updateLesson = (id, { title, type, content, duration, order_num, is_free }) =>
  pool.query(
    `UPDATE lessons
     SET title = ?, type = ?, content = ?, duration = ?, order_num = ?, is_free = ?
     WHERE id = ?`,
    [title, type, content, duration, order_num, is_free, id]
  )

// ── Delete lesson ──────────────────────────────────────────────────────────
const deleteLessonById = (id) => pool.query('DELETE FROM lessons WHERE id = ?', [id])

// ── Get total lessons + duration for a course (for updateCourseMeta) ──────
const getCourseMeta = (course_id) =>
  pool.query(
    `SELECT COUNT(l.id) AS total_lessons, COALESCE(SUM(l.duration), 0) AS total_duration
     FROM lessons l
     INNER JOIN sections s ON s.id = l.section_id
     WHERE s.course_id = ?`,
    [course_id]
  )

// ── Get course_id from section_id (for updateCourseMeta) ──────────────────
const getCourseIdBySectionId = (section_id) =>
  pool.query('SELECT course_id FROM sections WHERE id = ? LIMIT 1', [section_id])

export {
  getLessonsBySectionId,
  getLessonById,
  getFreeLessonsByCourseId,
  checkSectionExists,
  getMaxOrderNum,
  createLesson,
  updateLesson,
  deleteLessonById,
  getCourseMeta,
  getCourseIdBySectionId,
}
