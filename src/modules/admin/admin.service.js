// src/modules/admin/admin.service.js

import * as queries from './admin.queries.js'
import { findById, findByEmail, createUser } from '../auth/auth.queries.js'
import bcrypt from 'bcryptjs'

// ── Get sub-admin permissions ──────────────────────────────────────────────
const getPermissions = async (user_id) => {
  const [rows] = await queries.getPermissionsByUserId(user_id)
  if (!rows.length) {
    const err = new Error('Permissions not found')
    err.statusCode = 404
    throw err
  }
  return rows[0]
}

// ── Create sub-admin permissions (admin ke liye) ───────────────────────────
const createPermissions = async (
  created_by,
  {
    user_id,
    can_manage_courses,
    can_manage_students,
    can_send_discounts,
    can_view_payments,
    can_manage_tests,
  }
) => {
  // User exists + sub_admin role check
  const user = await findById(user_id)
  if (!user) {
    const err = new Error('User not found')
    err.statusCode = 404
    throw err
  }

  if (user.role !== 'sub_admin') {
    const err = new Error('User is not a sub-admin')
    err.statusCode = 400
    throw err
  }

  // Already exists check
  const [existing] = await queries.getPermissionsByUserId(user_id)
  if (existing.length) {
    const err = new Error('Permissions already exist — use update instead')
    err.statusCode = 409
    throw err
  }

  await queries.createPermissions({
    user_id,
    can_manage_courses: can_manage_courses ?? 0,
    can_manage_students: can_manage_students ?? 0,
    can_send_discounts: can_send_discounts ?? 0,
    can_view_payments: can_view_payments ?? 0,
    can_manage_tests: can_manage_tests ?? 0,
    created_by,
  })

  return await getPermissions(user_id)
}

// ── Update sub-admin permissions ───────────────────────────────────────────
const updatePermissions = async (user_id, body) => {
  const current = await getPermissions(user_id)

  const can_manage_courses = body.can_manage_courses ?? current.can_manage_courses
  const can_manage_students = body.can_manage_students ?? current.can_manage_students
  const can_send_discounts = body.can_send_discounts ?? current.can_send_discounts
  const can_view_payments = body.can_view_payments ?? current.can_view_payments
  const can_manage_tests = body.can_manage_tests ?? current.can_manage_tests

  await queries.updatePermissions(user_id, {
    can_manage_courses,
    can_manage_students,
    can_send_discounts,
    can_view_payments,
    can_manage_tests,
  })

  return await getPermissions(user_id)
}

// ── Delete permissions (jab sub-admin delete ho) ───────────────────────────
const deletePermissions = async (user_id) => {
  await queries.deletePermissions(user_id)
}

// ── Create Sub-Admin Account + Permissions ─────────────────────────────────
const createSubAdmin = async (created_by, body) => {
  const {
    name,
    email,
    password,
    can_manage_courses,
    can_manage_students,
    can_send_discounts,
    can_view_payments,
    can_manage_tests,
  } = body

  const existing = await findByEmail(email)
  if (existing) {
    const err = new Error('Email already registered')
    err.statusCode = 409
    throw err
  }

  const hashedPassword = await bcrypt.hash(password, 12)
  const user_id = await createUser({ name, email, password: hashedPassword, role: 'sub_admin' })

  await queries.createPermissions({
    user_id,
    can_manage_courses: can_manage_courses ?? 0,
    can_manage_students: can_manage_students ?? 0,
    can_send_discounts: can_send_discounts ?? 0,
    can_view_payments: can_view_payments ?? 0,
    can_manage_tests: can_manage_tests ?? 0,
    created_by,
  })

  // Returning user auth obj merged with permissions
  const user = await findById(user_id)
  const permissions = await getPermissions(user_id)

  return { user, permissions }
}

// ── Get Dashboard Stats ───────────────────────────────────────────────────
const getDashboardStats = async () => {
  return await queries.getDashboardStats()
}

export {
  getPermissions,
  createPermissions,
  updatePermissions,
  deletePermissions,
  createSubAdmin,
  getDashboardStats,
}
