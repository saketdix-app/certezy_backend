// src/modules/categories/categories.queries.js

import { pool } from '../../config/db.js'

// ── Fetch all active categories ordered by sort_order ──────────────────────
const getAllCategories = () =>
  pool.query(
    `SELECT
       c.id, c.name, c.slug, c.description, c.icon,
       c.parent_id, c.is_active, c.sort_order,
       p.name AS parent_name
     FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.is_active = 1
     ORDER BY c.sort_order ASC, c.name ASC`
  )

// ── Fetch single category by ID ────────────────────────────────────────────
const getCategoryById = (id) =>
  pool.query(
    `SELECT
       c.id, c.name, c.slug, c.description, c.icon,
       c.parent_id, c.is_active, c.sort_order,
       p.name AS parent_name
     FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.id = ?
     LIMIT 1`,
    [id]
  )

// ── Fetch single category by slug ──────────────────────────────────────────
const getCategoryBySlug = (slug) =>
  pool.query(
    `SELECT
       c.id, c.name, c.slug, c.description, c.icon,
       c.parent_id, c.is_active, c.sort_order,
       p.name AS parent_name
     FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE c.slug = ?
     LIMIT 1`,
    [slug]
  )

// ── Check if slug already exists (for create & update) ────────────────────
const checkSlugExists = (slug, excludeId = null) => {
  if (excludeId) {
    return pool.query('SELECT id FROM categories WHERE slug = ? AND id != ? LIMIT 1', [slug, excludeId])
  }
  return pool.query('SELECT id FROM categories WHERE slug = ? LIMIT 1', [slug])
}

// ── Check if parent_id is valid (not itself, must exist) ──────────────────
const checkParentExists = (parentId) =>
  pool.query('SELECT id FROM categories WHERE id = ? AND is_active = 1 LIMIT 1', [parentId])

// ── Create new category ────────────────────────────────────────────────────
const createCategory = ({ name, slug, description, icon, parent_id, sort_order }) =>
  pool.query(
    `INSERT INTO categories (name, slug, description, icon, parent_id, sort_order)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, slug, description ?? null, icon ?? null, parent_id ?? null, sort_order ?? 0]
  )

// ── Update category ────────────────────────────────────────────────────────
const updateCategory = (id, { name, slug, description, icon, parent_id, is_active, sort_order }) =>
  pool.query(
    `UPDATE categories
     SET name = ?, slug = ?, description = ?, icon = ?,
         parent_id = ?, is_active = ?, sort_order = ?
     WHERE id = ?`,
    [name, slug, description ?? null, icon ?? null, parent_id ?? null, is_active, sort_order, id]
  )

// ── Soft delete — set is_active = 0 ───────────────────────────────────────
const deleteCategoryById = (id) => pool.query('UPDATE categories SET is_active = 0 WHERE id = ?', [id])

// ── Check if category has active child categories ─────────────────────────
const hasChildren = (id) =>
  pool.query('SELECT id FROM categories WHERE parent_id = ? AND is_active = 1 LIMIT 1', [id])

// ── Check if category has courses assigned ────────────────────────────────
const hasCourses = (id) => pool.query('SELECT id FROM courses WHERE category_id = ? LIMIT 1', [id])

export {
  getAllCategories,
  getCategoryById,
  getCategoryBySlug,
  checkSlugExists,
  checkParentExists,
  createCategory,
  updateCategory,
  deleteCategoryById,
  hasChildren,
  hasCourses,
}
