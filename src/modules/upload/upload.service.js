// src/modules/upload/upload.service.js

import { generatePresignedUrl } from '../../utils/upload.js'
import { v4 as uuidv4 } from 'uuid'
import slugify from 'slugify'

// ── Generate Presigned URL ────────────────────────────────────────────────
const getPresignedUrl = async ({ fileName, fileType, isPublic = true }) => {
  // Sanitize the file name to prevent weird S3 Path issues
  const rawName = fileName.split('.').slice(0, -1).join('.') || fileName
  const ext = fileName.split('.').pop()

  const cleanName = slugify(rawName, { lower: true, strict: true })

  // Generating a secure unique key combining timestamp and UUID
  const uniqueKey = `uploads/${Date.now()}-${uuidv4().slice(0, 8)}-${cleanName}.${ext}`

  // Call the S3 helper
  const { signedUrl, fileUrl } = await generatePresignedUrl({
    key: uniqueKey,
    mimeType: fileType,
    isPublic,
    expiresIn: 300, // 5 minutes validity
  })

  return {
    signedUrl,
    fileUrl,
    key: uniqueKey,
    expiresIn: 300,
  }
}

export { getPresignedUrl }
