// src/modules/imports/imports.queries.js
// SQL used by the CSV importer. Every function takes a connection so the
// whole import runs inside a single transaction.

// ── Categories ────────────────────────────────────────────────────────────
export const findCategory = async (conn, nameOrSlug, slug) => {
  const [rows] = await conn.query(
    'SELECT id, is_active FROM categories WHERE slug = ? OR LOWER(name) = LOWER(?) ORDER BY is_active DESC LIMIT 1',
    [slug, nameOrSlug]
  )
  return rows[0] || null
}

export const createCategory = async (conn, { name, slug }) => {
  const [r] = await conn.query('INSERT INTO categories (name, slug, sort_order) VALUES (?, ?, 0)', [
    name,
    slug,
  ])
  return r.insertId
}

export const reactivateCategory = (conn, id) =>
  conn.query('UPDATE categories SET is_active = 1 WHERE id = ?', [id])

// ── Courses ───────────────────────────────────────────────────────────────
export const findCourseBySlug = async (conn, slug) => {
  const [rows] = await conn.query('SELECT id, slug FROM courses WHERE slug = ? LIMIT 1', [slug])
  return rows[0] || null
}

const COURSE_COLUMNS = [
  'title',
  'description',
  'short_desc',
  'category_id',
  'thumbnail',
  'preview_video',
  'price',
  'original_price',
  'pricing_type',
  'level',
  'language',
  'status',
  'is_featured',
  'requirements',
  'what_you_learn',
  'certificate_eligible',
]

export const insertCourse = async (conn, course) => {
  const cols = ['slug', 'created_by', ...COURSE_COLUMNS]
  const [r] = await conn.query(
    `INSERT INTO courses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => course[c] ?? null)
  )
  return r.insertId
}

// Only columns present in the CSV row are updated (undefined = keep)
export const updateCourse = (conn, id, course) => {
  const cols = COURSE_COLUMNS.filter((c) => course[c] !== undefined)
  if (!cols.length) return null
  return conn.query(`UPDATE courses SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => course[c]),
    id,
  ])
}

// ── Sections ──────────────────────────────────────────────────────────────
export const findSection = async (conn, course_id, title) => {
  const [rows] = await conn.query('SELECT id FROM sections WHERE course_id = ? AND title = ? LIMIT 1', [
    course_id,
    title,
  ])
  return rows[0] || null
}

export const maxSectionOrder = async (conn, course_id) => {
  const [rows] = await conn.query(
    'SELECT COALESCE(MAX(order_num), 0) AS m FROM sections WHERE course_id = ?',
    [course_id]
  )
  return Number(rows[0].m)
}

export const insertSection = async (conn, { course_id, title, order_num }) => {
  const [r] = await conn.query('INSERT INTO sections (course_id, title, order_num) VALUES (?, ?, ?)', [
    course_id,
    title,
    order_num,
  ])
  return r.insertId
}

export const updateSectionOrder = (conn, id, order_num) =>
  conn.query('UPDATE sections SET order_num = ? WHERE id = ?', [order_num, id])

// ── Lessons ───────────────────────────────────────────────────────────────
export const findLesson = async (conn, section_id, title) => {
  const [rows] = await conn.query(
    'SELECT id, order_num FROM lessons WHERE section_id = ? AND title = ? LIMIT 1',
    [section_id, title]
  )
  return rows[0] || null
}

export const maxLessonOrder = async (conn, section_id) => {
  const [rows] = await conn.query(
    'SELECT COALESCE(MAX(order_num), 0) AS m FROM lessons WHERE section_id = ?',
    [section_id]
  )
  return Number(rows[0].m)
}

export const insertLesson = async (conn, l) => {
  const [r] = await conn.query(
    `INSERT INTO lessons (section_id, title, type, content, duration, order_num, is_free)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [l.section_id, l.title, l.type, l.content, l.duration, l.order_num, l.is_free]
  )
  return r.insertId
}

export const updateLesson = (conn, id, l) =>
  conn.query(
    'UPDATE lessons SET type = ?, content = ?, duration = ?, order_num = ?, is_free = ? WHERE id = ?',
    [l.type, l.content, l.duration, l.order_num, l.is_free, id]
  )

export const refreshCourseMeta = (conn, course_id) =>
  conn.query(
    `UPDATE courses c
     JOIN (
       SELECT COUNT(l.id) AS total_lessons, COALESCE(SUM(l.duration), 0) AS total_duration
       FROM lessons l JOIN sections s ON s.id = l.section_id
       WHERE s.course_id = ?
     ) m
     SET c.total_lessons = m.total_lessons, c.total_duration = m.total_duration
     WHERE c.id = ?`,
    [course_id, course_id]
  )

// ── Tests (quizzes) ───────────────────────────────────────────────────────
export const findTest = async (conn, course_id, title) => {
  const [rows] = await conn.query('SELECT id FROM tests WHERE course_id = ? AND title = ? LIMIT 1', [
    course_id,
    title,
  ])
  return rows[0] || null
}

export const insertTest = async (conn, t) => {
  const [r] = await conn.query(
    `INSERT INTO tests (course_id, title, type, duration, pass_percentage, status)
     VALUES (?, ?, ?, ?, ?, 'active')`,
    [t.course_id, t.title, t.type, t.duration, t.pass_percentage]
  )
  return r.insertId
}

export const updateTest = (conn, id, t) =>
  conn.query('UPDATE tests SET type = ?, duration = ?, pass_percentage = ? WHERE id = ?', [
    t.type,
    t.duration,
    t.pass_percentage,
    id,
  ])

export const refreshTotalQuestions = (conn, test_id) =>
  conn.query(
    'UPDATE tests SET total_questions = (SELECT COUNT(*) FROM questions WHERE test_id = ?) WHERE id = ?',
    [test_id, test_id]
  )

// ── Questions + options ───────────────────────────────────────────────────
export const findQuestion = async (conn, test_id, question) => {
  const [rows] = await conn.query('SELECT id FROM questions WHERE test_id = ? AND question = ? LIMIT 1', [
    test_id,
    question,
  ])
  return rows[0] || null
}

export const maxQuestionOrder = async (conn, test_id) => {
  const [rows] = await conn.query(
    'SELECT COALESCE(MAX(order_num), 0) AS m FROM questions WHERE test_id = ?',
    [test_id]
  )
  return Number(rows[0].m)
}

export const insertQuestion = async (conn, q) => {
  const [r] = await conn.query(
    `INSERT INTO questions (test_id, question, type, explanation, difficulty, topic_tag, order_num)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [q.test_id, q.question, q.type, q.explanation, q.difficulty, q.topic_tag, q.order_num]
  )
  return r.insertId
}

export const updateQuestion = (conn, id, q) =>
  conn.query('UPDATE questions SET type = ?, explanation = ?, difficulty = ?, topic_tag = ? WHERE id = ?', [
    q.type,
    q.explanation,
    q.difficulty,
    q.topic_tag,
    id,
  ])

export const replaceOptions = async (conn, question_id, options) => {
  await conn.query('DELETE FROM options WHERE question_id = ?', [question_id])
  await conn.query('INSERT INTO options (question_id, option_text, is_correct, order_num) VALUES ?', [
    options.map((o, i) => [question_id, o.text, o.correct ? 1 : 0, i + 1]),
  ])
}
