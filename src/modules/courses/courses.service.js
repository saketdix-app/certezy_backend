// src/modules/courses/courses.service.js

import slugify from 'slugify'
import * as queries from './courses.queries.js'
import * as cache from '../../utils/cache.js'

const CACHE_TTL_LIST = 60 * 10 // 10 min
const CACHE_TTL_SINGLE = 60 * 15 // 15 min

// ── Get all courses (filters + pagination + sorting) ───────────────────────
const getAllCourses = async ({
  page = 1,
  limit = 12,
  status,
  category_id,
  level,
  is_featured,
  search,
  sortBy = 'created_at',
  sortOrder = 'DESC',
} = {}) => {
  const offset = (page - 1) * limit
  const cacheKey = `courses:list:p${page}:l${limit}:s${status}:c${category_id}:lv${level}:f${is_featured}:q${search}:sb${sortBy}:so${sortOrder}`

  const cached = await cache.get(cacheKey)
  if (cached) return cached

  const [rows] = await queries.getAllCourses({
    limit,
    offset,
    status,
    category_id,
    level,
    is_featured,
    search,
    sortBy,
    sortOrder,
  })
  const [count] = await queries.countCourses({ status, category_id, level, is_featured, search })

  const total = count[0].total
  const result = {
    courses: rows,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    },
  }

  await cache.set(cacheKey, result, CACHE_TTL_LIST)
  return result
}

// ── Get single course by slug ──────────────────────────────────────────────
const getCourseBySlug = async (slug) => {
  const cacheKey = `course:slug:${slug}`

  const cached = await cache.get(cacheKey)
  if (cached) return cached

  const [rows] = await queries.getCourseBySlug(slug)
  if (!rows.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }

  await cache.set(cacheKey, rows[0], CACHE_TTL_SINGLE)
  return rows[0]
}

// ── Get single course by ID (internal use) ────────────────────────────────
const getCourseById = async (id) => {
  const [rows] = await queries.getCourseById(id)
  if (!rows.length) {
    const err = new Error('Course not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Create course ──────────────────────────────────────────────────────────
const createCourse = async (body, createdBy) => {
  const {
    title,
    slug,
    description,
    short_desc,
    category_id,
    thumbnail,
    preview_video,
    price,
    level,
    language,
    status,
    is_featured,
    requirements,
    what_you_learn,
    certificate_eligible,
  } = body

  const finalSlug = slug
    ? slugify(slug, { lower: true, strict: true })
    : slugify(title, { lower: true, strict: true })

  const [slugCheck] = await queries.checkSlugExists(finalSlug)
  if (slugCheck.length) {
    const err = new Error('Slug already exists — use a different title or slug')
    err.statusCode = 409
    throw err
  }

  const [catCheck] = await queries.checkCategoryExists(category_id)
  if (!catCheck.length) {
    const err = new Error('Category not found or inactive')
    err.statusCode = 400
    throw err
  }

  const [result] = await queries.createCourse({
    title,
    slug: finalSlug,
    description,
    short_desc,
    category_id,
    thumbnail,
    preview_video,
    price,
    level,
    language,
    status,
    is_featured,
    requirements,
    what_you_learn,
    certificate_eligible,
    created_by: createdBy,
  })

  const course = await getCourseById(result.insertId)
  await cache.delByPattern('courses:list:*')
  return course
}

// ── Update course ──────────────────────────────────────────────────────────
const updateCourse = async (id, body) => {
  const current = await getCourseById(id)

  const title = body.title ?? current.title
  const slug = body.slug ?? current.slug
  const description = body.description ?? current.description
  const short_desc = body.short_desc ?? current.short_desc
  const category_id = body.category_id ?? current.category_id
  const thumbnail = body.thumbnail ?? current.thumbnail
  const preview_video = body.preview_video ?? current.preview_video
  const price = body.price ?? current.price
  const level = body.level ?? current.level
  const language = body.language ?? current.language
  const status = body.status ?? current.status
  const is_featured = body.is_featured ?? current.is_featured
  const requirements = body.requirements ?? current.requirements
  const what_you_learn = body.what_you_learn ?? current.what_you_learn
  const certificate_eligible = body.certificate_eligible ?? current.certificate_eligible

  const finalSlug = slugify(slug, { lower: true, strict: true })
  if (finalSlug !== current.slug) {
    const [slugCheck] = await queries.checkSlugExists(finalSlug, id)
    if (slugCheck.length) {
      const err = new Error('Slug already exists — use a different slug')
      err.statusCode = 409
      throw err
    }
  }

  if (category_id !== current.category_id) {
    const [catCheck] = await queries.checkCategoryExists(category_id)
    if (!catCheck.length) {
      const err = new Error('Category not found or inactive')
      err.statusCode = 400
      throw err
    }
  }

  await queries.updateCourse(id, {
    title,
    slug: finalSlug,
    description,
    short_desc,
    category_id,
    thumbnail,
    preview_video,
    price,
    level,
    language,
    status,
    is_featured,
    requirements,
    what_you_learn,
    certificate_eligible,
  })

  await cache.delByPattern('courses:list:*')
  await cache.del(`course:slug:${current.slug}`)
  if (finalSlug !== current.slug) await cache.del(`course:slug:${finalSlug}`)

  return await getCourseById(id)
}

// ── Delete course (soft delete → archived) ─────────────────────────────────
const deleteCourse = async (id) => {
  const current = await getCourseById(id)

  const [enrollments] = await queries.hasEnrollments(id)
  if (enrollments.length) {
    const err = new Error('Cannot delete — course has active enrollments')
    err.statusCode = 400
    throw err
  }

  await queries.deleteCourseById(id)
  await cache.delByPattern('courses:list:*')
  await cache.del(`course:slug:${current.slug}`)
}

export { getAllCourses, getCourseBySlug, getCourseById, createCourse, updateCourse, deleteCourse }
