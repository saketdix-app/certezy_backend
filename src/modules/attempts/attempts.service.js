// src/modules/attempts/attempts.service.js

import * as queries from './attempts.queries.js'
import * as testQueries from '../tests/tests.queries.js'
import * as optionQueries from '../options/options.queries.js'
import * as questionService from '../questions/questions.service.js'
import { checkEnrollment } from '../enrollments/enrollments.service.js'
import { autoIssueOnCompletion } from '../certificates/certificates.service.js'

// ── Start attempt ──────────────────────────────────────────────────────────
const startAttempt = async (user_id, test_id) => {
  // Test exists check
  const [testRows] = await testQueries.getTestById(test_id)
  if (!testRows.length) {
    const err = new Error('Test not found')
    err.statusCode = 404
    throw err
  }
  const test = testRows[0]

  // Enrollment check — student enrolled hai is course mein?
  const enrollment = await checkEnrollment(user_id, test.course_id)
  if (!enrollment) {
    const err = new Error('You are not enrolled in this course')
    err.statusCode = 403
    throw err
  }

  // Attempt number calculate karo
  const [countRows] = await queries.getAttemptCount(user_id, test_id)
  const attempt_number = (countRows[0].total ?? 0) + 1

  // Attempt create karo
  const [result] = await queries.createAttempt({ user_id, test_id, attempt_number })
  const [attemptRows] = await queries.getAttemptById(result.insertId)
  const attempt = attemptRows[0]

  // Questions fetch karo — is_correct nahi dikhega student ko
  const questions = await questionService.getQuestionsByTestId(test_id)

  return {
    attempt_id: attempt.id,
    attempt_number: attempt.attempt_number,
    started_at: attempt.started_at,
    test: {
      id: test.id,
      title: test.title,
      duration: test.duration,
      total_questions: test.total_questions,
      pass_percentage: test.pass_percentage,
    },
    questions,
  }
}

// ── Submit attempt ─────────────────────────────────────────────────────────
const submitAttempt = async (user_id, { attempt_id, answers }) => {
  // Attempt exists + belongs to user check
  const [attemptRows] = await queries.getAttemptById(attempt_id)
  if (!attemptRows.length) {
    const err = new Error('Attempt not found')
    err.statusCode = 404
    throw err
  }

  const attempt = attemptRows[0]

  if (attempt.user_id !== user_id) {
    const err = new Error('Unauthorized')
    err.statusCode = 403
    throw err
  }

  // Already submitted check
  if (attempt.completed_at) {
    const err = new Error('Attempt already submitted')
    err.statusCode = 409
    throw err
  }

  // Test fetch karo pass_percentage ke liye
  const [testRows] = await testQueries.getTestById(attempt.test_id)
  const test = testRows[0]

  // ── Auto Scoring ───────────────────────────────────────────────────────
  const total_marks = answers.length
  let obtained_marks = 0
  const processedAnswers = []

  for (const ans of answers) {
    const { question_id, selected_opts } = ans

    // Correct options DB se fetch karo
    const [correctRows] = await optionQueries.getCorrectOptions(question_id)
    const correctIds = correctRows.map((r) => r.id).sort()

    // selected_opts sort karke compare karo
    const selectedIds = (selected_opts ?? []).slice().sort()

    const is_correct =
      correctIds.length > 0 &&
      selectedIds.length === correctIds.length &&
      selectedIds.every((id, i) => id === correctIds[i])
        ? 1
        : 0

    if (is_correct) obtained_marks++

    processedAnswers.push({
      attempt_id,
      question_id,
      selected_opts: JSON.stringify(selected_opts ?? []),
      is_correct,
    })
  }

  // Score percentage
  const score = total_marks > 0 ? parseFloat(((obtained_marks / total_marks) * 100).toFixed(2)) : 0

  const is_passed = score >= test.pass_percentage ? 1 : 0

  // Time taken — started_at se ab tak (seconds)
  const time_taken = Math.floor((Date.now() - new Date(attempt.started_at).getTime()) / 1000)

  // Attempt answers save karo
  await queries.insertAttemptAnswers(processedAnswers)

  // Attempt complete karo
  await queries.completeAttempt(attempt_id, {
    score,
    total_marks,
    obtained_marks,
    time_taken,
    is_passed,
  })

  // Passing a final test may finish the course → certificate
  const certificate =
    is_passed && test.type === 'final' ? await autoIssueOnCompletion(user_id, test.course_id) : null

  return {
    attempt_id,
    score,
    total_marks,
    obtained_marks,
    time_taken,
    is_passed: !!is_passed,
    pass_percentage: test.pass_percentage,
    certificate,
  }
}

// ── Get attempt history ────────────────────────────────────────────────────
const getAttemptHistory = async (user_id, test_id) => {
  const [rows] = await queries.getAttemptsByUserAndTest(user_id, test_id)
  return rows
}

// ── Get single attempt detail (with answers + explanations) ───────────────
const getAttemptDetail = async (user_id, attempt_id) => {
  const [attemptRows] = await queries.getAttemptById(attempt_id)
  if (!attemptRows.length) {
    const err = new Error('Attempt not found')
    err.statusCode = 404
    throw err
  }

  const attempt = attemptRows[0]

  if (attempt.user_id !== user_id) {
    const err = new Error('Unauthorized')
    err.statusCode = 403
    throw err
  }

  // Attempt complete nahi hua to detail nahi milegi
  if (!attempt.completed_at) {
    const err = new Error('Attempt not yet submitted')
    err.statusCode = 400
    throw err
  }

  // Answers with explanation fetch karo
  const [rows] = await queries.getAttemptAnswers(attempt_id)

  // Transform — question wise group karo
  const questionsMap = new Map()

  for (const row of rows) {
    if (!questionsMap.has(row.question_id)) {
      questionsMap.set(row.question_id, {
        question_id: row.question_id,
        question: row.question,
        type: row.type,
        explanation: row.explanation,
        is_correct: !!row.is_correct,
        selected_opts: JSON.parse(row.selected_opts ?? '[]'),
        options: [],
      })
    }

    if (row.option_id) {
      questionsMap.get(row.question_id).options.push({
        id: row.option_id,
        option_text: row.option_text,
        is_correct: !!row.option_correct,
        order_num: row.order_num,
      })
    }
  }

  return {
    attempt_id: attempt.id,
    attempt_number: attempt.attempt_number,
    score: attempt.score,
    total_marks: attempt.total_marks,
    obtained_marks: attempt.obtained_marks,
    time_taken: attempt.time_taken,
    is_passed: !!attempt.is_passed,
    started_at: attempt.started_at,
    completed_at: attempt.completed_at,
    questions: [...questionsMap.values()],
  }
}

export { startAttempt, submitAttempt, getAttemptHistory, getAttemptDetail }
