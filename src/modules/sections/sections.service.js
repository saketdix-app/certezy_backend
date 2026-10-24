// src/modules/sections/sections.service.js

import * as queries from './sections.queries.js'

// ── Get all sections by course_id ──────────────────────────────────────────
const getSectionsByCourseId = async (course_id) => {
  const [rows] = await queries.getSectionsByCourseId(course_id)
  return rows
}

// ── Get single section by ID ───────────────────────────────────────────────
const getSectionById = async (id) => {
  const [rows] = await queries.getSectionById(id)
  if (!rows.length) {
    const err = new Error('Section not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Create section ─────────────────────────────────────────────────────────
const createSection = async ({ course_id, title, order_num }) => {
  // Check course exists
  const [courseCheck] = await queries.checkCourseExists(course_id)
  if (!courseCheck.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }

  // Auto order_num agar nahi diya
  let finalOrderNum = order_num
  if (finalOrderNum === undefined || finalOrderNum === null) {
    const [maxOrder] = await queries.getMaxOrderNum(course_id)
    finalOrderNum = (maxOrder[0].max_order ?? 0) + 1
  }

  const [result] = await queries.createSection({ course_id, title, order_num: finalOrderNum })
  return await getSectionById(result.insertId)
}

// ── Update section ─────────────────────────────────────────────────────────
const updateSection = async (id, body) => {
  const current = await getSectionById(id)

  const title = body.title ?? current.title
  const order_num = body.order_num ?? current.order_num

  await queries.updateSection(id, { title, order_num })
  return await getSectionById(id)
}

// ── Delete section ─────────────────────────────────────────────────────────
const deleteSection = async (id) => {
  await getSectionById(id)

  // Block if has lessons
  const [lessons] = await queries.hasLessons(id)
  if (lessons.length) {
    const err = new Error('Cannot delete — section has lessons')
    err.statusCode = 400
    throw err
  }

  await queries.deleteSectionById(id)
}

export { getSectionsByCourseId, getSectionById, createSection, updateSection, deleteSection }
