// src/modules/courses/courses.service.js

import slugify from 'slugify'
import * as queries from './courses.queries.js'
import * as cache from '../../utils/cache.js'
import { AppError, parsePaging, buildPagination } from '../../utils/http.js'
import { withPricing, withPricingAll } from '../../utils/pricing.js'

const CACHE_TTL_LIST = 60 * 10 // 10 min
const CACHE_TTL_SINGLE = 60 * 15 // 15 min

export const toSlug = (value) => slugify(String(value || ''), { lower: true, strict: true })

/** Drop every cached view of a course (call after anything that changes it). */
export const invalidateCourseCache = async (...slugs) => {
  await cache.delByPattern('courses:list:*')
  await Promise.all(slugs.filter(Boolean).map((slug) => cache.del(`course:slug:${slug}`)))
}

/**
 * Normalise the pricing trio so the DB never holds contradictory values:
 *   free  → price 0, no list price
 *   paid  → price > 0; original_price kept only when it is above price
 */
export const normalisePricing = ({ pricing_type, price, original_price }) => {
  const type = pricing_type || (Number(price) > 0 ? 'paid' : 'free')
  if (type === 'free') return { pricing_type: 'free', price: 0, original_price: null }

  const p = Number(price)
  if (!(p > 0)) throw AppError.badRequest('A paid course needs a price greater than 0')
  const o = original_price === '' || original_price == null ? null : Number(original_price)
  if (o != null && o <= p) {
    throw AppError.badRequest('Original price must be higher than the selling price (or left empty)')
  }
  return { pricing_type: 'paid', price: p, original_price: o }
}

// ── Get all courses (filters + pagination + sorting) ───────────────────────
const getAllCourses = async (query = {}) => {
  const { page, limit, offset } = parsePaging(query, { defaultLimit: 12, maxLimit: 100 })
  const {
    status,
    category_id,
    level,
    is_featured,
    search,
    pricing,
    sortBy = 'created_at',
    sortOrder = 'DESC',
  } = query
  // category slug: ?category=… (older links use ?category_slug=…)
  const category = query.category || query.category_slug || undefined
  const filters = { status, category_id, category, level, is_featured, search, pricing }

  const cacheKey = `courses:list:${JSON.stringify({ page, limit, ...filters, sortBy, sortOrder })}`
  const cached = await cache.get(cacheKey)
  if (cached) return cached

  const [rows] = await queries.getAllCourses({ limit, offset, sortBy, sortOrder, ...filters })
  const [count] = await queries.countCourses(filters)

  const result = {
    courses: withPricingAll(rows),
    pagination: buildPagination({ total: count[0].total, page, limit }),
  }

  await cache.set(cacheKey, result, CACHE_TTL_LIST)
  return result
}

// ── Get single course by slug (numeric ids are accepted too) ───────────────
const getCourseBySlug = async (slugOrId) => {
  const cacheKey = `course:slug:${slugOrId}`
  const cached = await cache.get(cacheKey)
  if (cached) return cached

  let [rows] = await queries.getCourseBySlug(slugOrId)
  if (!rows.length && /^\d+$/.test(String(slugOrId))) [rows] = await queries.getCourseById(slugOrId)
  if (!rows.length) throw AppError.notFound('Course')

  const course = withPricing(rows[0])
  await cache.set(cacheKey, course, CACHE_TTL_SINGLE)
  return course
}

// ── Get single course by ID (internal use) ────────────────────────────────
const getCourseById = async (id) => {
  const [rows] = await queries.getCourseById(id)
  if (!rows.length) throw AppError.notFound('Course')
  return withPricing(rows[0])
}

const assertCategory = async (category_id) => {
  const [catCheck] = await queries.checkCategoryExists(category_id)
  if (!catCheck.length) throw AppError.badRequest('Category not found or inactive')
}

// ── Create course ──────────────────────────────────────────────────────────
const createCourse = async (body, createdBy) => {
  const finalSlug = toSlug(body.slug || body.title)

  const [slugCheck] = await queries.checkSlugExists(finalSlug)
  if (slugCheck.length) throw AppError.conflict('Slug already exists — use a different title or slug')

  await assertCategory(body.category_id)

  const [result] = await queries.createCourse({
    ...body,
    ...normalisePricing(body),
    slug: finalSlug,
    created_by: createdBy,
  })

  await invalidateCourseCache()
  return getCourseById(result.insertId)
}

// ── Update course ──────────────────────────────────────────────────────────
const updateCourse = async (id, body) => {
  const current = await getCourseById(id)

  // undefined → keep current value
  const pick = (key) => (body[key] !== undefined ? body[key] : current[key])
  // Media can be cleared from the admin UI: null/'' removes it
  const media = (key) => (body[key] !== undefined ? body[key] || null : current[key])

  const finalSlug = toSlug(pick('slug'))
  if (finalSlug !== current.slug) {
    const [slugCheck] = await queries.checkSlugExists(finalSlug, id)
    if (slugCheck.length) throw AppError.conflict('Slug already exists — use a different slug')
  }

  const category_id = pick('category_id')
  if (category_id !== current.category_id) await assertCategory(category_id)

  // Switching to "paid" without sending a price must not silently keep price 0
  const pricing = normalisePricing({
    pricing_type: pick('pricing_type'),
    price: pick('price'),
    original_price: body.original_price !== undefined ? body.original_price : current.original_price,
  })

  await queries.updateCourse(id, {
    title: pick('title'),
    slug: finalSlug,
    description: pick('description'),
    short_desc: pick('short_desc'),
    category_id,
    thumbnail: media('thumbnail'),
    preview_video: media('preview_video'),
    ...pricing,
    level: pick('level'),
    language: pick('language'),
    status: pick('status'),
    is_featured: pick('is_featured'),
    requirements: pick('requirements'),
    what_you_learn: pick('what_you_learn'),
    certificate_eligible: pick('certificate_eligible'),
  })

  await invalidateCourseCache(current.slug, finalSlug, String(id))
  return getCourseById(id)
}

// ── Delete course (soft delete → archived) ─────────────────────────────────
const deleteCourse = async (id) => {
  const current = await getCourseById(id)

  const [enrollments] = await queries.hasEnrollments(id)
  if (enrollments.length) throw AppError.badRequest('Cannot delete — course has active enrollments')

  await queries.deleteCourseById(id)
  await invalidateCourseCache(current.slug, String(id))
}

export { getAllCourses, getCourseBySlug, getCourseById, createCourse, updateCourse, deleteCourse }
