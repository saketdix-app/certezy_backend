// src/modules/progress/progress.queries.js

import { pool } from '../../config/db.js'

// ── Get lesson progress by user + lesson ───────────────────────────────────
const getLessonProgress = (user_id, lesson_id) =>
  pool.query(
    `SELECT * FROM lesson_progress
     WHERE user_id = ? AND lesson_id = ? LIMIT 1`,
    [user_id, lesson_id]
  )

// ── Get all progress for a user in a course ────────────────────────────────
const getCourseProgress = (user_id, course_id) =>
  pool.query(
    `SELECT lp.lesson_id, lp.is_completed, lp.watch_time, lp.last_watched
     FROM lesson_progress lp
     JOIN lessons l  ON l.id = lp.lesson_id
     JOIN sections s ON s.id = l.section_id
     WHERE lp.user_id = ? AND s.course_id = ?`,
    [user_id, course_id]
  )

// ── Count completed lessons for a user in a course ─────────────────────────
const countCompletedLessons = (user_id, course_id) =>
  pool.query(
    `SELECT COUNT(*) AS completed
     FROM lesson_progress lp
     JOIN lessons l  ON l.id = lp.lesson_id
     JOIN sections s ON s.id = l.section_id
     WHERE lp.user_id = ? AND s.course_id = ? AND lp.is_completed = 1`,
    [user_id, course_id]
  )

// ── Upsert lesson progress ─────────────────────────────────────────────────
const upsertLessonProgress = (user_id, lesson_id, { is_completed, watch_time }) =>
  pool.query(
    `INSERT INTO lesson_progress (user_id, lesson_id, is_completed, watch_time)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       is_completed = VALUES(is_completed),
       watch_time   = VALUES(watch_time)`,
    [user_id, lesson_id, is_completed ?? 0, watch_time ?? 0]
  )

export { getLessonProgress, getCourseProgress, countCompletedLessons, upsertLessonProgress }
