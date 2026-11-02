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
    const { page, limit, search } = req.query
    const result = await service.getAllCertificates({ page, limit, search })
    return success(res, {
      message: 'Certificates fetched',
      data: result.certificates,
      pagination: result.pagination,
    })
  } catch (err) {
    next(err)
  }
}

// ── POST /certificates/claim/:courseId — my certificate for a finished course
const claimCertificate = async (req, res, next) => {
  try {
    const certificate = await service.claimCertificate(req.user.id, Number(req.params.courseId))
    return success(res, { message: 'Certificate ready', data: { certificate } })
  } catch (err) {
    next(err)
  }
}

// ── GET /certificates/verify/:certificateNo — public verification ──────────
const verifyCertificate = async (req, res, next) => {
  try {
    const certificate = await service.verifyCertificate(req.params.certificateNo)
    return success(res, { message: 'Certificate is valid', data: { certificate } })
  } catch (err) {
    next(err)
  }
}

// ── DELETE /certificates/:id — revoke (admin) ─────────────────────────────
const revokeCertificate = async (req, res, next) => {
  try {
    const data = await service.revokeCertificate(req.params.id)
    return success(res, { message: `Certificate ${data.certificate_no} revoked`, data })
  } catch (err) {
    next(err)
  }
}

export {
  getMyCertificates,
  claimCertificate,
  verifyCertificate,
  adminIssueCertificate,
  getAllCertificates,
  revokeCertificate,
}
