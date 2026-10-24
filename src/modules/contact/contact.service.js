// src/modules/contact/contact.service.js

import * as queries from './contact.queries.js'

// ── Submit contact form ────────────────────────────────────────
const submit = async ({ user_id, name, email, phone, subject, message }) => {
  // Basic validation
  if (!name?.trim()) {
    const err = new Error('Name is required')
    err.statusCode = 400
    throw err
  }
  if (!email?.trim() || !/\S+@\S+\.\S+/.test(email)) {
    const err = new Error('Valid email is required')
    err.statusCode = 400
    throw err
  }
  if (!subject?.trim()) {
    const err = new Error('Subject is required')
    err.statusCode = 400
    throw err
  }
  if (!message?.trim()) {
    const err = new Error('Message is required')
    err.statusCode = 400
    throw err
  }
  if (message.trim().length < 10) {
    const err = new Error('Message must be at least 10 characters')
    err.statusCode = 400
    throw err
  }

  const id = await queries.createContact({ user_id, name, email, phone, subject, message })
  const contact = await queries.findById(id)
  return contact
}

// ── Get all (admin) ────────────────────────────────────────────
const getAll = async ({ page = 1, limit = 20, status, search } = {}) => {
  const offset = (page - 1) * limit
  const [rows] = await queries.getAll({ limit, offset, status, search })
  const [count] = await queries.countAll({ status, search })

  return {
    contacts: rows,
    pagination: {
      total: count[0].total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(count[0].total / limit),
    },
  }
}

// ── Get single (admin) ─────────────────────────────────────────
const getById = async (id) => {
  const contact = await queries.findById(id)
  if (!contact) {
    const err = new Error('Contact not found')
    err.statusCode = 404
    throw err
  }
  return contact
}

// ── Update status (admin) ──────────────────────────────────────
const updateStatus = async (id, status) => {
  const allowed = ['new', 'read', 'resolved']
  if (!allowed.includes(status)) {
    const err = new Error(`Status must be one of: ${allowed.join(', ')}`)
    err.statusCode = 400
    throw err
  }

  await queries.updateStatus(id, status)
  return await getById(id)
}

export { submit, getAll, getById, updateStatus }
