// src/modules/lessons/lessons.service.js

import * as queries from './lessons.queries.js'
import * as courseQueries from '../courses/courses.queries.js'

// ── Get all lessons by section_id ──────────────────────────────────────────
const getLessonsBySectionId = async (section_id) => {
  const [rows] = await queries.getLessonsBySectionId(section_id)
  return rows
}

// ── Get single lesson by ID ────────────────────────────────────────────────
const getLessonById = async (id) => {
  const [rows] = await queries.getLessonById(id)
  if (!rows.length) {
    const err = new Error('Lesson not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Get free preview lessons by course_id ─────────────────────────────────
const getFreeLessonsByCourseId = async (course_id) => {
  const [rows] = await queries.getFreeLessonsByCourseId(course_id)
  return rows
}

// ── Create lesson ──────────────────────────────────────────────────────────
const createLesson = async ({ section_id, title, type, content, duration, order_num, is_free }) => {
  // Check section exists
  const [sectionCheck] = await queries.checkSectionExists(section_id)
  if (!sectionCheck.length) {
    const err = new Error('Section not found')
    err.statusCode = 404
    throw err
  }

  // Auto order_num agar nahi diya
  let finalOrderNum = order_num
  if (finalOrderNum === undefined || finalOrderNum === null) {
    const [maxOrder] = await queries.getMaxOrderNum(section_id)
    finalOrderNum = (maxOrder[0].max_order ?? 0) + 1
  }

  const [result] = await queries.createLesson({
    section_id,
    title,
    type,
    content,
    duration,
    order_num: finalOrderNum,
    is_free,
  })

  // Course meta update karo
  await updateCourseMeta(section_id)

  return await getLessonById(result.insertId)
}

// ── Update lesson ──────────────────────────────────────────────────────────
const updateLesson = async (id, body) => {
  const current = await getLessonById(id)

  const title = body.title ?? current.title
  const type = body.type ?? current.type
  const content = body.content ?? current.content
  const duration = body.duration ?? current.duration
  const order_num = body.order_num ?? current.order_num
  const is_free = body.is_free ?? current.is_free

  await queries.updateLesson(id, { title, type, content, duration, order_num, is_free })

  // Course meta update karo
  await updateCourseMeta(current.section_id)

  return await getLessonById(id)
}

// ── Delete lesson ──────────────────────────────────────────────────────────
const deleteLesson = async (id) => {
  const current = await getLessonById(id)

  await queries.deleteLessonById(id)

  // Course meta update karo
  await updateCourseMeta(current.section_id)
}

// ─── HELPER — update course total_lessons & total_duration ────────────────
const updateCourseMeta = async (section_id) => {
  const [sectionRows] = await queries.getCourseIdBySectionId(section_id)
  if (!sectionRows.length) return

  const course_id = sectionRows[0].course_id
  const [meta] = await queries.getCourseMeta(course_id)

  await courseQueries.updateCourseMeta(course_id, {
    total_lessons: meta[0].total_lessons,
    total_duration: meta[0].total_duration,
  })
}

export {
  getLessonsBySectionId,
  getLessonById,
  getFreeLessonsByCourseId,
  createLesson,
  updateLesson,
  deleteLesson,
}
