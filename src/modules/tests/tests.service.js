// src/modules/tests/tests.service.js

import * as queries from './tests.queries.js'

// ── Get all tests by course_id ─────────────────────────────────────────────
const getTestsByCourseId = async (course_id) => {
  const [rows] = await queries.getTestsByCourseId(course_id)
  return rows
}

// ── Get single test by ID ──────────────────────────────────────────────────
const getTestById = async (id) => {
  const [rows] = await queries.getTestById(id)
  if (!rows.length) {
    const err = new Error('Test not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Get test with all questions and options ────────────────────────────────
const getTestFull = async (id) => {
  await getTestById(id) // existence check

  const [rows] = await queries.getTestFull(id)
  if (!rows.length) return { test: null, questions: [] }

  // Raw rows ko structured format mein transform karo
  const test = {
    id: rows[0].test_id,
    title: rows[0].title,
    type: rows[0].type,
    duration: rows[0].duration,
    total_questions: rows[0].total_questions,
    pass_percentage: rows[0].pass_percentage,
    status: rows[0].status,
    questions: [],
  }

  const questionsMap = new Map()

  for (const row of rows) {
    if (!row.question_id) continue

    if (!questionsMap.has(row.question_id)) {
      questionsMap.set(row.question_id, {
        id: row.question_id,
        question: row.question,
        type: row.question_type,
        difficulty: row.difficulty,
        topic_tag: row.topic_tag,
        order_num: row.question_order,
        options: [],
      })
    }

    if (row.option_id) {
      questionsMap.get(row.question_id).options.push({
        id: row.option_id,
        option_text: row.option_text,
        order_num: row.option_order,
        // is_correct student ko nahi dikhega — attempts mein check hoga
      })
    }
  }

  test.questions = [...questionsMap.values()]
  return test
}

// ── Create test ────────────────────────────────────────────────────────────
const createTest = async ({ course_id, title, type, duration, pass_percentage, status }) => {
  const [courseCheck] = await queries.checkCourseExists(course_id)
  if (!courseCheck.length) {
    const err = new Error('Course not found or archived')
    err.statusCode = 404
    throw err
  }

  const [result] = await queries.createTest({ course_id, title, type, duration, pass_percentage, status })
  return await getTestById(result.insertId)
}

// ── Update test ────────────────────────────────────────────────────────────
const updateTest = async (id, body) => {
  const current = await getTestById(id)

  const title = body.title ?? current.title
  const type = body.type ?? current.type
  const duration = body.duration ?? current.duration
  const pass_percentage = body.pass_percentage ?? current.pass_percentage
  const status = body.status ?? current.status

  await queries.updateTest(id, { title, type, duration, pass_percentage, status })
  return await getTestById(id)
}

// ── Delete test ────────────────────────────────────────────────────────────
const deleteTest = async (id) => {
  await getTestById(id)
  await queries.deleteTestById(id)
}

export { getTestsByCourseId, getTestById, getTestFull, createTest, updateTest, deleteTest }
