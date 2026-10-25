// src/modules/upload/upload.service.js

import { v4 as uuidv4 } from 'uuid'
import slugify from 'slugify'
import env from '../../config/env.js'
import { generatePresignedUrl, checkStorage } from '../../utils/upload.js'

const MB = 1024 * 1024

// What admins may upload, per kind. Sizes are checked against the size the
// browser declares (this endpoint is admin-only).
const UPLOAD_RULES = {
  image: {
    folder: 'images',
    maxSize: 10 * MB,
    types: {
      'image/jpeg': ['jpg', 'jpeg'],
      'image/png': ['png'],
      'image/webp': ['webp'],
      'image/gif': ['gif'],
      'image/svg+xml': ['svg'],
    },
  },
  video: {
    folder: 'videos',
    maxSize: 5 * 1024 * MB, // single-PUT limit on S3
    types: {
      'video/mp4': ['mp4', 'm4v'],
      'video/webm': ['webm'],
      'video/quicktime': ['mov'],
    },
  },
  document: {
    folder: 'documents',
    maxSize: 50 * MB,
    types: {
      'application/pdf': ['pdf'],
      'application/zip': ['zip'],
      'application/x-zip-compressed': ['zip'],
      'text/plain': ['txt'],
    },
  },
}

const badRequest = (message) => {
  const err = new Error(message)
  err.statusCode = 400
  return err
}

const kindForType = (fileType) => Object.keys(UPLOAD_RULES).find((kind) => UPLOAD_RULES[kind].types[fileType])

// ── Generate pre-signed URL ───────────────────────────────────────────────
const getPresignedUrl = async ({ fileName, fileType, fileSize, kind, isPublic = true }) => {
  const resolvedKind = kind || kindForType(fileType)
  const rules = UPLOAD_RULES[resolvedKind]

  if (!rules || !rules.types[fileType]) {
    throw badRequest(`File type "${fileType}" is not allowed${kind ? ` for ${kind} uploads` : ''}.`)
  }
  if (fileSize && fileSize > rules.maxSize) {
    throw badRequest(
      `File is too large. Maximum for ${resolvedKind} is ${Math.round(rules.maxSize / MB)} MB.`
    )
  }

  const allowedExts = rules.types[fileType]
  const rawExt = (fileName.includes('.') ? fileName.split('.').pop() : '').toLowerCase()
  const ext = allowedExts.includes(rawExt) ? rawExt : allowedExts[0]

  const baseName = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName
  const cleanName = slugify(baseName, { lower: true, strict: true }).slice(0, 60) || 'file'

  const now = new Date()
  const datePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  const key = `${env.s3.uploadPrefix}/${rules.folder}/${datePath}/${uuidv4()}-${cleanName}.${ext}`

  const expiresIn = 900 // 15 minutes — large videos need time to start
  const { signedUrl, fileUrl, headers } = await generatePresignedUrl({
    key,
    mimeType: fileType,
    isPublic,
    expiresIn,
  })

  return {
    uploadUrl: signedUrl,
    signedUrl, // backward compatibility with older frontend builds
    fileUrl,
    key,
    kind: resolvedKind,
    headers,
    expiresIn,
  }
}

// ── Limits for the admin UI ───────────────────────────────────────────────
const getRules = () =>
  Object.fromEntries(
    Object.entries(UPLOAD_RULES).map(([kind, r]) => [
      kind,
      { maxSize: r.maxSize, types: Object.keys(r.types) },
    ])
  )

const getStatus = async () => ({ ...(await checkStorage()), rules: getRules() })

export { getPresignedUrl, getStatus, UPLOAD_RULES }
