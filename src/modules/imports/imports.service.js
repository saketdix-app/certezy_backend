// src/modules/imports/imports.service.js
//
// Bulk CSV import for courses, curriculum (sections + lessons) and quizzes.
//
//   1. parse    — CSV text → objects keyed by lower-cased header
//   2. validate — every row is checked; all problems are reported together
//                 with their row number, and nothing is written if any exist
//   3. apply    — all rows are written in ONE transaction (all-or-nothing).
//                 With dry_run the transaction is rolled back, so the preview
//                 shows exactly what would be created / updated.

import { parse } from 'csv-parse/sync'
import { pool } from '../../config/db.js'
import * as q from './imports.queries.js'
import { TEMPLATES } from './imports.templates.js'
import { AppError } from '../../utils/http.js'
import { toSlug, invalidateCourseCache, normalisePricing } from '../courses/courses.service.js'
import {
  LESSON_TYPES,
  COURSE_LEVELS,
  COURSE_STATUSES,
  PRICING_TYPES,
  TEST_TYPES,
  QUESTION_TYPES,
  DIFFICULTIES,
} from '../../constants.js'

const MAX_ROWS = 5000
const OPTION_COLUMNS = ['option_a', 'option_b', 'option_c', 'option_d', 'option_e', 'option_f']
const LETTERS = 'ABCDEF'

// ── Parsing helpers ───────────────────────────────────────────────────────
const parseCsv = (csv) => {
  try {
    return parse(csv, {
      bom: true,
      columns: (header) => header.map((h) => String(h).trim().toLowerCase().replace(/\s+/g, '_')),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    })
  } catch (err) {
    throw AppError.badRequest(`Could not read the CSV file: ${err.message}`)
  }
}

const str = (v) => (v == null ? '' : String(v).trim())
const has = (row, key) => key in row && str(row[key]) !== ''

const parseBool = (v, fallback) => {
  const s = str(v).toLowerCase()
  if (s === '') return fallback
  if (['yes', 'y', 'true', '1'].includes(s)) return 1
  if (['no', 'n', 'false', '0'].includes(s)) return 0
  return undefined // invalid
}

const parseIntOr = (v, fallback) => {
  const s = str(v)
  if (s === '') return fallback
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN
}

const parseMoney = (v) => {
  const s = str(v).replace(/[$,₹\s]/g, '')
  if (s === '') return null
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN
}

const toList = (v) =>
  str(v)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n')

/** Collect validation problems for a single row. */
const rowErrors = () => {
  const list = []
  return {
    list,
    add: (column, message) => list.push({ column, message }),
    oneOf: (row, column, allowed) => {
      if (has(row, column) && !allowed.includes(str(row[column]).toLowerCase())) {
        list.push({ column, message: `must be one of: ${allowed.join(', ')}` })
      }
    },
  }
}

const checkHeader = (type, rows) => {
  const required = TEMPLATES[type].columns.filter((c) => c.required).map((c) => c.name)
  const present = rows.length ? Object.keys(rows[0]) : []
  const missing = required.filter((c) => !present.includes(c))
  if (missing.length) {
    throw AppError.unprocessable(
      `Missing required column(s): ${missing.join(', ')}. Download the sample CSV for the correct format.`,
      missing.map((column) => ({ row: 1, column, message: 'required column is missing' }))
    )
  }
}

// ── Row validators: return { value, errors } ──────────────────────────────
const validateCourseRow = (row) => {
  const e = rowErrors()
  const title = str(row.title)
  if (title.length < 3 || title.length > 200) e.add('title', 'is required (3–200 characters)')
  if (!str(row.category)) e.add('category', 'is required')
  const slug = toSlug(str(row.slug) || title)
  if (!slug) e.add('slug', 'could not be generated — add letters or numbers to the title')
  if (str(row.short_desc).length > 500) e.add('short_desc', 'must be 500 characters or fewer')

  e.oneOf(row, 'pricing_type', PRICING_TYPES)
  e.oneOf(row, 'level', COURSE_LEVELS)
  e.oneOf(row, 'status', COURSE_STATUSES)

  const price = parseMoney(row.price)
  const original_price = parseMoney(row.original_price)
  if (Number.isNaN(price)) e.add('price', 'must be a number like 49 or 49.99')
  if (Number.isNaN(original_price)) e.add('original_price', 'must be a number like 99 or 99.99')

  let pricing = null
  if (!Number.isNaN(price) && !Number.isNaN(original_price)) {
    try {
      pricing = normalisePricing({
        pricing_type: str(row.pricing_type).toLowerCase() || undefined,
        price: price ?? 0,
        original_price,
      })
    } catch (err) {
      e.add('price', err.message)
    }
  }

  const is_featured = parseBool(row.is_featured, undefined)
  const certificate_eligible = parseBool(row.certificate_eligible, undefined)
  if (has(row, 'is_featured') && is_featured === undefined) e.add('is_featured', 'use yes or no')
  if (has(row, 'certificate_eligible') && certificate_eligible === undefined) {
    e.add('certificate_eligible', 'use yes or no')
  }
  for (const col of ['thumbnail', 'preview_video']) {
    if (str(row[col]).length > 500) e.add(col, 'URL is too long (max 500)')
  }

  // Only columns that are present (and not blank) overwrite existing values
  const opt = (col, val) => (has(row, col) ? val : undefined)
  return {
    errors: e.list,
    value: {
      slug,
      title,
      category: str(row.category),
      short_desc: opt('short_desc', str(row.short_desc)),
      description: opt('description', str(row.description)),
      ...(pricing || {}),
      level: opt('level', str(row.level).toLowerCase()),
      language: opt('language', str(row.language)),
      status: opt('status', str(row.status).toLowerCase()),
      is_featured,
      certificate_eligible,
      thumbnail: opt('thumbnail', str(row.thumbnail)),
      preview_video: opt('preview_video', str(row.preview_video)),
      what_you_learn: opt('what_you_learn', toList(row.what_you_learn)),
      requirements: opt('requirements', toList(row.requirements)),
    },
  }
}

const URL_TYPES = ['link', 'embed']
const validateCurriculumRow = (row) => {
  const e = rowErrors()
  const course_slug = toSlug(row.course_slug)
  if (!course_slug) e.add('course_slug', 'is required')
  const section_title = str(row.section_title)
  if (section_title.length < 2 || section_title.length > 200)
    e.add('section_title', 'is required (2–200 chars)')
  const lesson_title = str(row.lesson_title)
  if (lesson_title.length < 2 || lesson_title.length > 200) e.add('lesson_title', 'is required (2–200 chars)')

  let type = str(row.lesson_type).toLowerCase()
  if (type === 'article') type = 'text'
  if (!LESSON_TYPES.includes(type)) e.add('lesson_type', `must be one of: ${LESSON_TYPES.join(', ')}`)

  const content = str(row.content)
  if (type && type !== 'text' && !content) e.add('content', `is required for ${type} lessons`)
  if (URL_TYPES.includes(type) && content && !/^https?:\/\//i.test(content)) {
    e.add('content', 'must be a full URL starting with http:// or https://')
  }

  const duration = parseIntOr(row.duration_minutes, 0)
  if (Number.isNaN(duration)) e.add('duration_minutes', 'must be a whole number of minutes')
  const section_order = parseIntOr(row.section_order, null)
  if (Number.isNaN(section_order)) e.add('section_order', 'must be a whole number')
  const lesson_order = parseIntOr(row.lesson_order, null)
  if (Number.isNaN(lesson_order)) e.add('lesson_order', 'must be a whole number')
  const is_free = parseBool(row.is_free_preview, 0)
  if (is_free === undefined) e.add('is_free_preview', 'use yes or no')

  return {
    errors: e.list,
    value: {
      course_slug,
      section_title,
      section_order,
      lesson_title,
      type,
      content,
      duration: duration * 60, // CSV is in minutes; lessons.duration is stored in seconds
      lesson_order,
      is_free,
    },
  }
}

const validateQuizRow = (row) => {
  const e = rowErrors()
  const course_slug = toSlug(row.course_slug)
  if (!course_slug) e.add('course_slug', 'is required')
  const quiz_title = str(row.quiz_title)
  if (quiz_title.length < 2 || quiz_title.length > 200) e.add('quiz_title', 'is required (2–200 chars)')
  const question = str(row.question)
  if (!question) e.add('question', 'is required')

  e.oneOf(row, 'quiz_type', TEST_TYPES)
  e.oneOf(row, 'difficulty', DIFFICULTIES)

  const qtypeRaw = str(row.question_type).toLowerCase().replace(/[\s-]/g, '_')
  const qtype =
    {
      mcq: 'multiple',
      multi: 'multiple',
      truefalse: 'true_false',
      tf: 'true_false',
      true_false: 'true_false',
    }[qtypeRaw] || qtypeRaw
  if (!QUESTION_TYPES.includes(qtype)) e.add('question_type', `must be one of: ${QUESTION_TYPES.join(', ')}`)

  const duration = parseIntOr(row.quiz_duration_minutes, 60)
  if (Number.isNaN(duration) || duration < 1) e.add('quiz_duration_minutes', 'must be a whole number ≥ 1')
  const pass = parseIntOr(row.pass_percentage, 70)
  if (Number.isNaN(pass) || pass < 1 || pass > 100) e.add('pass_percentage', 'must be between 1 and 100')

  const answer = str(row.correct_answers).toUpperCase()
  let options = []

  if (qtype === 'true_false') {
    const truth = ['TRUE', 'T', 'A'].includes(answer)
      ? true
      : ['FALSE', 'F', 'B'].includes(answer)
        ? false
        : null
    if (truth === null) e.add('correct_answers', 'use TRUE or FALSE for true_false questions')
    options = [
      { text: 'True', correct: truth === true },
      { text: 'False', correct: truth === false },
    ]
  } else if (QUESTION_TYPES.includes(qtype)) {
    // Keep option letters stable: option_c is always "C" even if option_b is empty
    const lettered = OPTION_COLUMNS.map((col, i) => ({ letter: LETTERS[i], text: str(row[col]) })).filter(
      (o) => o.text
    )
    if (lettered.length < 2) e.add('option_a', 'at least two options (option_a, option_b…) are required')

    const picked = [...new Set(answer.split(/[\s,;|/]+/).filter(Boolean))]
    const invalid = picked.filter((l) => !lettered.some((o) => o.letter === l))
    if (!picked.length) e.add('correct_answers', 'is required (e.g. A, or A,C)')
    else if (invalid.length)
      e.add('correct_answers', `refers to empty or unknown option(s): ${invalid.join(', ')}`)
    else if (qtype === 'single' && picked.length !== 1) {
      e.add(
        'correct_answers',
        'single-choice questions need exactly one correct option (use "multiple" for MCQ)'
      )
    }
    options = lettered.map((o) => ({ text: o.text, correct: picked.includes(o.letter) }))
  }

  return {
    errors: e.list,
    value: {
      course_slug,
      quiz_title,
      quiz_type: str(row.quiz_type).toLowerCase() || 'practice',
      duration,
      pass_percentage: pass,
      question,
      type: qtype,
      options,
      explanation: str(row.explanation) || null,
      difficulty: str(row.difficulty).toLowerCase() || 'medium',
      topic_tag: str(row.topic_tag).slice(0, 100) || null,
    },
  }
}

const VALIDATORS = { courses: validateCourseRow, curriculum: validateCurriculumRow, quizzes: validateQuizRow }

// ── Appliers: write validated rows using one connection ───────────────────
const newSummary = () => ({ created: {}, updated: {} })
const bump = (summary, kind, entity) => {
  summary[kind][entity] = (summary[kind][entity] || 0) + 1
}

const courseIdBySlug = async (conn, slug, cache) => {
  if (cache.has(slug)) return cache.get(slug)
  const course = await q.findCourseBySlug(conn, slug)
  cache.set(slug, course?.id ?? null)
  return course?.id ?? null
}

const applyCourses = async (conn, rows, ctx) => {
  const categoryCache = new Map()
  for (const { line, value } of rows) {
    // Category: match by slug or name; create when allowed
    const catSlug = toSlug(value.category)
    let category_id = categoryCache.get(catSlug)
    if (!category_id) {
      const cat = await q.findCategory(conn, value.category, catSlug)
      if (cat) {
        if (!cat.is_active) await q.reactivateCategory(conn, cat.id)
        category_id = cat.id
      } else if (ctx.options.create_missing_categories) {
        category_id = await q.createCategory(conn, { name: value.category, slug: catSlug })
        bump(ctx.summary, 'created', 'categories')
      } else {
        ctx.errors.push({
          row: line,
          column: 'category',
          message: `category "${value.category}" does not exist`,
        })
        continue
      }
      categoryCache.set(catSlug, category_id)
    }

    const existing = await q.findCourseBySlug(conn, value.slug)
    const data = { ...value, category_id }
    if (existing) {
      await q.updateCourse(conn, existing.id, data)
      bump(ctx.summary, 'updated', 'courses')
    } else {
      await q.insertCourse(conn, {
        ...data,
        level: data.level || 'beginner',
        language: data.language || 'English',
        status: data.status || 'draft',
        is_featured: data.is_featured ?? 0,
        certificate_eligible: data.certificate_eligible ?? 1,
        created_by: ctx.userId,
      })
      bump(ctx.summary, 'created', 'courses')
    }
    ctx.touchedSlugs.add(value.slug)
  }
}

const applyCurriculum = async (conn, rows, ctx) => {
  const courseCache = new Map()
  const sectionCache = new Map() // `${course_id}:${title}` → id
  const lessonCounter = new Map() // section_id → next order

  for (const { line, value } of rows) {
    const course_id = await courseIdBySlug(conn, value.course_slug, courseCache)
    if (!course_id) {
      ctx.errors.push({
        row: line,
        column: 'course_slug',
        message: `no course with slug "${value.course_slug}"`,
      })
      continue
    }

    const key = `${course_id}:${value.section_title}`
    let section_id = sectionCache.get(key)
    if (!section_id) {
      const found = await q.findSection(conn, course_id, value.section_title)
      if (found) {
        section_id = found.id
        if (value.section_order != null) await q.updateSectionOrder(conn, section_id, value.section_order)
      } else {
        const order = value.section_order ?? (await q.maxSectionOrder(conn, course_id)) + 1
        section_id = await q.insertSection(conn, { course_id, title: value.section_title, order_num: order })
        bump(ctx.summary, 'created', 'sections')
      }
      sectionCache.set(key, section_id)
    }

    if (!lessonCounter.has(section_id))
      lessonCounter.set(section_id, (await q.maxLessonOrder(conn, section_id)) + 1)

    const lesson = {
      section_id,
      title: value.lesson_title,
      type: value.type,
      content: value.content || null,
      duration: value.duration,
      is_free: value.is_free,
    }
    const found = await q.findLesson(conn, section_id, value.lesson_title)
    if (found) {
      await q.updateLesson(conn, found.id, { ...lesson, order_num: value.lesson_order ?? found.order_num })
      bump(ctx.summary, 'updated', 'lessons')
    } else {
      const order = value.lesson_order ?? lessonCounter.get(section_id)
      lessonCounter.set(section_id, Math.max(lessonCounter.get(section_id), order + 1))
      await q.insertLesson(conn, { ...lesson, order_num: order })
      bump(ctx.summary, 'created', 'lessons')
    }
    ctx.touchedCourses.add(course_id)
  }
}

const sameOptions = (a, b) =>
  a.length === b.length &&
  a.every((o, i) => o.text === b[i].option_text && Boolean(o.correct) === Boolean(b[i].is_correct))

const applyQuizzes = async (conn, rows, ctx) => {
  const courseCache = new Map()
  const testCache = new Map()

  for (const { line, value } of rows) {
    const course_id = await courseIdBySlug(conn, value.course_slug, courseCache)
    if (!course_id) {
      ctx.errors.push({
        row: line,
        column: 'course_slug',
        message: `no course with slug "${value.course_slug}"`,
      })
      continue
    }

    const key = `${course_id}:${value.quiz_title}`
    let test_id = testCache.get(key)
    if (!test_id) {
      const t = {
        course_id,
        title: value.quiz_title,
        type: value.quiz_type,
        duration: value.duration,
        pass_percentage: value.pass_percentage,
      }
      const found = await q.findTest(conn, course_id, value.quiz_title)
      if (found) {
        test_id = found.id
        await q.updateTest(conn, test_id, t)
        bump(ctx.summary, 'updated', 'quizzes')
      } else {
        test_id = await q.insertTest(conn, t)
        bump(ctx.summary, 'created', 'quizzes')
      }
      testCache.set(key, test_id)
    }

    const question = {
      test_id,
      question: value.question,
      type: value.type,
      explanation: value.explanation,
      difficulty: value.difficulty,
      topic_tag: value.topic_tag,
    }
    const found = await q.findQuestion(conn, test_id, value.question)
    if (found) {
      await q.updateQuestion(conn, found.id, question)
      // Keep option ids (and therefore past attempt answers) when nothing changed
      const [current] = await conn.query(
        'SELECT option_text, is_correct FROM options WHERE question_id = ? ORDER BY order_num, id',
        [found.id]
      )
      if (!sameOptions(value.options, current)) await q.replaceOptions(conn, found.id, value.options)
      bump(ctx.summary, 'updated', 'questions')
    } else {
      const order_num = (await q.maxQuestionOrder(conn, test_id)) + 1
      const id = await q.insertQuestion(conn, { ...question, order_num })
      await q.replaceOptions(conn, id, value.options)
      bump(ctx.summary, 'created', 'questions')
    }
    ctx.touchedTests.add(test_id)
  }
}

const APPLIERS = { courses: applyCourses, curriculum: applyCurriculum, quizzes: applyQuizzes }

// ── Public API ────────────────────────────────────────────────────────────
/**
 * Import one CSV.
 * @returns {{ type, dry_run, rows, summary, errors }}
 * @throws AppError 422 with `errors: [{ row, column, message }]` when any row is invalid
 */
export const runImport = async (type, { csv, dry_run = false, create_missing_categories = true }, userId) => {
  if (!VALIDATORS[type]) throw AppError.notFound('Import type')

  const records = parseCsv(csv)
  if (!records.length) throw AppError.badRequest('The CSV has a header but no data rows')
  if (records.length > MAX_ROWS) throw AppError.badRequest(`Too many rows (max ${MAX_ROWS} per file)`)
  checkHeader(type, records)

  // 1. Validate every row (line numbers match what the admin sees in Excel)
  const errors = []
  const valid = []
  records.forEach((record, i) => {
    const line = i + 2 // +1 header, +1 one-based
    const { value, errors: rowErrs } = VALIDATORS[type](record)
    if (rowErrs.length) rowErrs.forEach((err) => errors.push({ row: line, ...err }))
    else valid.push({ line, value })
  })

  // Same course slug twice in one courses file is almost always a mistake
  if (type === 'courses') {
    const seen = new Map()
    for (const { line, value } of valid) {
      if (seen.has(value.slug)) {
        errors.push({
          row: line,
          column: 'slug',
          message: `duplicate of row ${seen.get(value.slug)} ("${value.slug}")`,
        })
      } else seen.set(value.slug, line)
    }
  }
  if (errors.length)
    throw AppError.unprocessable(`${errors.length} problem(s) found — nothing was imported`, errors)

  // 2. Apply in a single transaction
  const ctx = {
    userId,
    options: { create_missing_categories },
    summary: newSummary(),
    errors: [],
    touchedSlugs: new Set(),
    touchedCourses: new Set(),
    touchedTests: new Set(),
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await APPLIERS[type](conn, valid, ctx)

    if (ctx.errors.length) {
      await conn.rollback()
      throw AppError.unprocessable(`${ctx.errors.length} problem(s) found — nothing was imported`, ctx.errors)
    }

    for (const course_id of ctx.touchedCourses) await q.refreshCourseMeta(conn, course_id)
    for (const test_id of ctx.touchedTests) await q.refreshTotalQuestions(conn, test_id)

    if (dry_run) await conn.rollback()
    else await conn.commit()
  } catch (err) {
    await conn.rollback().catch(() => {})
    if (err.code === 'WARN_DATA_TRUNCATED' || err.code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD') {
      throw AppError.badRequest(
        `A value is not accepted by the database (${err.sqlMessage}). Restart the API so it can apply pending migrations.`
      )
    }
    throw err
  } finally {
    conn.release()
  }

  if (!dry_run) await invalidateCourseCache(...ctx.touchedSlugs)

  return { type, dry_run, rows: records.length, summary: ctx.summary, errors: [] }
}
