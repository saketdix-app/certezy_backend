// src/modules/upload/upload.controller.js

import * as service from './upload.service.js'
import { success } from '../../utils/response.js'

// ── POST /upload/presigned-url ─────────────────────────────────────────
const getPresignedUrl = async (req, res, next) => {
  try {
    const data = await service.getPresignedUrl(req.body)
    return success(res, { statusCode: 201, message: 'Presigned URL generated successfully', data })
  } catch (err) {
    next(err)
  }
}

// ── GET /upload/status ─────────────────────────────────────────────────
// Lets an admin confirm S3 is reachable without uploading anything.
const getStatus = async (req, res, next) => {
  try {
    const data = await service.getStatus()
    return success(res, { message: data.ok ? 'Storage OK' : 'Storage not reachable', data })
  } catch (err) {
    next(err)
  }
}

export { getPresignedUrl, getStatus }
