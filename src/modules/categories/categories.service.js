// src/modules/categories/categories.service.js

import slugify from 'slugify'
import * as queries from './categories.queries.js'
import * as cache from '../../utils/cache.js'

const CACHE_KEY = 'categories:all'
const CACHE_TTL = 60 * 60 // 1 hour

// ── Get all active categories — nested parent → children ──────────────────
const getAllCategories = async () => {
  // Check cache first
  const cached = await cache.get(CACHE_KEY)
  if (cached) return cached

  // DB se fetch karo — flat list
  const [rows] = await queries.getAllCategories()

  // Flat list → nested structure
  // Parent categories (parent_id = null) + unke children
  const parents = rows.filter((row) => row.parent_id === null)
  const children = rows.filter((row) => row.parent_id !== null)

  const nested = parents.map((parent) => ({
    ...parent,
    children: children.filter((child) => child.parent_id === parent.id),
  }))

  // Cache mein save karo
  await cache.set(CACHE_KEY, nested, CACHE_TTL)

  return nested
}

// ── Get single category by ID ──────────────────────────────────────────────
const getCategoryById = async (id) => {
  const [rows] = await queries.getCategoryById(id)
  if (!rows.length) {
    const err = new Error('Category not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Get single category by slug ────────────────────────────────────────────
const getCategoryBySlug = async (slug) => {
  const [rows] = await queries.getCategoryBySlug(slug)
  if (!rows.length) {
    const err = new Error('Category not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Create new category ────────────────────────────────────────────────────
const createCategory = async ({ name, slug, description, icon, parent_id, sort_order }) => {
  const finalSlug = slug
    ? slugify(slug, { lower: true, strict: true })
    : slugify(name, { lower: true, strict: true })

  const [slugCheck] = await queries.checkSlugExists(finalSlug)
  if (slugCheck.length) {
    const err = new Error('Slug already exists — use a different name or slug')
    err.statusCode = 409
    throw err
  }

  if (parent_id) {
    const [parentCheck] = await queries.checkParentExists(parent_id)
    if (!parentCheck.length) {
      const err = new Error('Parent category not found or inactive')
      err.statusCode = 400
      throw err
    }
  }

  const [result] = await queries.createCategory({
    name,
    slug: finalSlug,
    description,
    icon,
    parent_id,
    sort_order,
  })
  const [rows] = await queries.getCategoryById(result.insertId)

  await cache.del(CACHE_KEY) // cache invalidate

  return rows[0]
}

// ── Update category ────────────────────────────────────────────────────────
const updateCategory = async (id, body) => {
  const [existing] = await queries.getCategoryById(id)
  if (!existing.length) {
    const err = new Error('Category not found')
    err.statusCode = 404
    throw err
  }

  const current = existing[0]

  const name = body.name ?? current.name
  const slug = body.slug ?? current.slug
  const description = body.description ?? current.description
  const icon = body.icon ?? current.icon
  const parent_id = body.parent_id !== undefined ? body.parent_id : current.parent_id
  const is_active = body.is_active ?? current.is_active
  const sort_order = body.sort_order ?? current.sort_order

  const finalSlug = slugify(slug, { lower: true, strict: true })
  if (finalSlug !== current.slug) {
    const [slugCheck] = await queries.checkSlugExists(finalSlug, id)
    if (slugCheck.length) {
      const err = new Error('Slug already exists — use a different slug')
      err.statusCode = 409
      throw err
    }
  }

  if (parent_id && parent_id !== current.parent_id) {
    if (parent_id === id) {
      const err = new Error('Category cannot be its own parent')
      err.statusCode = 400
      throw err
    }
    const [parentCheck] = await queries.checkParentExists(parent_id)
    if (!parentCheck.length) {
      const err = new Error('Parent category not found or inactive')
      err.statusCode = 400
      throw err
    }
  }

  await queries.updateCategory(id, {
    name,
    slug: finalSlug,
    description,
    icon,
    parent_id,
    is_active,
    sort_order,
  })

  await cache.del(CACHE_KEY) // cache invalidate

  const [rows] = await queries.getCategoryById(id)
  return rows[0]
}

// ── Delete category (soft delete) ─────────────────────────────────────────
const deleteCategory = async (id) => {
  const [existing] = await queries.getCategoryById(id)
  if (!existing.length) {
    const err = new Error('Category not found')
    err.statusCode = 404
    throw err
  }

  const [children] = await queries.hasChildren(id)
  if (children.length) {
    const err = new Error('Cannot delete — category has active child categories')
    err.statusCode = 400
    throw err
  }

  const [courses] = await queries.hasCourses(id)
  if (courses.length) {
    const err = new Error('Cannot delete — category has courses assigned to it')
    err.statusCode = 400
    throw err
  }

  await queries.deleteCategoryById(id)

  await cache.del(CACHE_KEY) // cache invalidate
}

export {
  getAllCategories,
  getCategoryById,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
}
