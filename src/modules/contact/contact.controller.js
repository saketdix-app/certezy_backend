// src/modules/contact/contact.controller.js

import * as service from './contact.service.js'
import { success } from '../../utils/response.js'

// ── POST /api/v1/contact ───────────────────────────────────────
// Public + logged in dono use kar sakte hain
const submit = async (req, res, next) => {
  try {
    const { name, email, phone, subject, message } = req.body

    // Logged in user ka user_id — guest ke liye null
    const user_id = req.user?.id || null

    // Logged in user ke liye name + email auto use karo
    const contactName = user_id ? req.user.name : name
    const contactEmail = user_id ? req.user.email : email

    const contact = await service.submit({
      user_id,
      name: contactName,
      email: contactEmail,
      phone,
      subject,
      message,
    })

    return success(res, {
      statusCode: 201,
      message: "Message sent successfully. We'll get back to you soon.",
      data: { contact },
    })
  } catch (err) {
    next(err)
  }
}

// ── GET /api/v1/contact (admin) ────────────────────────────────
const getAll = async (req, res, next) => {
  try {
    const { page, limit, status, search } = req.query
    const result = await service.getAll({ page, limit, status, search })

    return success(res, {
      message: 'Contacts fetched',
      data: result.contacts,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

// ── GET /api/v1/contact/:id (admin) ───────────────────────────
const getById = async (req, res, next) => {
  try {
    const contact = await service.getById(req.params.id)
    return success(res, { message: 'Contact fetched', data: { contact } })
  } catch (err) {
    next(err)
  }
}

// ── PUT /api/v1/contact/:id/status (admin) ────────────────────
const updateStatus = async (req, res, next) => {
  try {
    const contact = await service.updateStatus(req.params.id, req.body.status)
    return success(res, { message: 'Status updated', data: { contact } })
  } catch (err) {
    next(err)
  }
}

export { submit, getAll, getById, updateStatus }
