// src/modules/questions/questions.service.js

import * as queries from './questions.queries.js'
import * as testQueries from '../tests/tests.queries.js'

// ── Get all questions by test_id ───────────────────────────────────────────
const getQuestionsByTestId = async (test_id) => {
  const [rows] = await queries.getQuestionsByTestId(test_id)

  // Raw rows ko structured format mein transform karo
  const questionsMap = new Map()

  for (const row of rows) {
    if (!questionsMap.has(row.id)) {
      questionsMap.set(row.id, {
        id: row.id,
        test_id: row.test_id,
        question: row.question,
        type: row.type,
        explanation: row.explanation,
        difficulty: row.difficulty,
        topic_tag: row.topic_tag,
        order_num: row.order_num,
        options: [],
      })
    }

    if (row.option_id) {
      questionsMap.get(row.id).options.push({
        id: row.option_id,
        option_text: row.option_text,
        order_num: row.option_order,
      })
    }
  }

  return [...questionsMap.values()]
}

// ── Get single question by ID ──────────────────────────────────────────────
const getQuestionById = async (id) => {
  const [rows] = await queries.getQuestionById(id)
  if (!rows.length) {
    const err = new Error('Question not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Create question ────────────────────────────────────────────────────────
const createQuestion = async ({ test_id, question, type, explanation, difficulty, topic_tag, order_num }) => {
  const [testCheck] = await queries.checkTestExists(test_id)
  if (!testCheck.length) {
    const err = new Error('Test not found or inactive')
    err.statusCode = 404
    throw err
  }

  // Auto order_num
  let finalOrderNum = order_num
  if (finalOrderNum === undefined || finalOrderNum === null) {
    const [maxOrder] = await queries.getMaxOrderNum(test_id)
    finalOrderNum = (maxOrder[0].max_order ?? 0) + 1
  }

  const [result] = await queries.createQuestion({
    test_id,
    question,
    type,
    explanation,
    difficulty,
    topic_tag,
    order_num: finalOrderNum,
  })

  // total_questions update karo
  await testQueries.updateTotalQuestions(test_id)

  return await getQuestionById(result.insertId)
}

// ── Update question ────────────────────────────────────────────────────────
const updateQuestion = async (id, body) => {
  const current = await getQuestionById(id)

  const question = body.question ?? current.question
  const type = body.type ?? current.type
  const explanation = body.explanation ?? current.explanation
  const difficulty = body.difficulty ?? current.difficulty
  const topic_tag = body.topic_tag ?? current.topic_tag
  const order_num = body.order_num ?? current.order_num

  await queries.updateQuestion(id, { question, type, explanation, difficulty, topic_tag, order_num })
  return await getQuestionById(id)
}

// ── Delete question ────────────────────────────────────────────────────────
const deleteQuestion = async (id) => {
  const current = await getQuestionById(id)
  await queries.deleteQuestionById(id)

  // total_questions update karo
  await testQueries.updateTotalQuestions(current.test_id)
}

export { getQuestionsByTestId, getQuestionById, createQuestion, updateQuestion, deleteQuestion }
