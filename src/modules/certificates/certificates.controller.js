// src/modules/certificates/certificates.controller.js

import * as service from './certificates.service.js'
import { success } from '../../utils/response.js'

// ── GET /certificates — my certificates (student) ─────────────────────────
const getMyCertificates = async (req, res, next) => {
  try {
    const certificates = await service.getMyCertificates(req.user.id)
    return success(res, { message: 'Certificates fetched', data: { certificates } })
  } catch (err) {
    next(err)
  }
}

// ── POST /certificates/issue — admin manually issue ───────────────────────
const adminIssueCertificate = async (req, res, next) => {
  try {
    const cert = await service.adminIssueCertificate(req.user.id, req.body)
    return success(res, { statusCode: 201, message: 'Certificate issued', data: { certificate: cert } })
  } catch (err) {
    next(err)
  }
}

// ── GET /certificates/admin/all — all certificates (admin) ────────────────
const getAllCertificates = async (req, res, next) => {
  try {
    const { page, limit } = req.query
    const result = await service.getAllCertificates({ page, limit })
    return success(res, {
      message: 'Certificates fetched',
      data: result.certificates,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

export { getMyCertificates, adminIssueCertificate, getAllCertificates }
