// src/modules/progress/progress.service.js

import * as queries from './progress.queries.js'
import * as lessonQueries from '../lessons/lessons.queries.js'
import * as enrollmentService from '../enrollments/enrollments.service.js'

// ── Update lesson progress ─────────────────────────────────────────────────
const updateLessonProgress = async (user_id, lesson_id, { is_completed, watch_time }) => {
  // Lesson exists check
  const [lessonRows] = await lessonQueries.getLessonById(lesson_id)
  if (!lessonRows.length) {
    const err = new Error('Lesson not found')
    err.statusCode = 404
    throw err
  }
  const lesson = lessonRows[0]

  // Section se course_id nikalo
  const [sectionRows] = await lessonQueries.getCourseIdBySectionId(lesson.section_id)
  const course_id = sectionRows[0].course_id

  // Enrollment check
  const enrollment = await enrollmentService.checkEnrollment(user_id, course_id)
  if (!enrollment) {
    const err = new Error('You are not enrolled in this course')
    err.statusCode = 403
    throw err
  }

  // Upsert lesson progress
  await queries.upsertLessonProgress(user_id, lesson_id, { is_completed, watch_time })

  // Course ka overall progress recalculate karo
  const [metaRows] = await lessonQueries.getCourseMeta(course_id)
  const [completedRows] = await queries.countCompletedLessons(user_id, course_id)

  const total_lessons = metaRows[0].total_lessons
  const completed = completedRows[0].completed

  const progress = total_lessons > 0 ? Math.floor((completed / total_lessons) * 100) : 0

  // Enrollment progress update karo
  await enrollmentService.updateProgress(user_id, course_id, progress)

  return {
    lesson_id,
    course_id,
    is_completed: !!is_completed,
    watch_time: watch_time ?? 0,
    overall_progress: progress,
  }
}

// ── Get course progress (all lessons status) ───────────────────────────────
const getCourseProgress = async (user_id, course_id) => {
  // Enrollment check
  const enrollment = await enrollmentService.checkEnrollment(user_id, course_id)
  if (!enrollment) {
    const err = new Error('You are not enrolled in this course')
    err.statusCode = 403
    throw err
  }

  const [rows] = await queries.getCourseProgress(user_id, course_id)
  const [metaRows] = await lessonQueries.getCourseMeta(course_id)
  const [completedRows] = await queries.countCompletedLessons(user_id, course_id)

  const total_lessons = metaRows[0].total_lessons
  const completed = completedRows[0].completed

  const progress = total_lessons > 0 ? Math.floor((completed / total_lessons) * 100) : 0

  return {
    course_id,
    total_lessons,
    completed_lessons: completed,
    overall_progress: progress,
    lessons: rows,
  }
}

export { updateLessonProgress, getCourseProgress }
