// src/utils/upload.js
// Thin wrapper around AWS S3 used for admin uploads, certificates and invoices.

import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import env from '../config/env.js'

const { s3: cfg } = env

let client = null

const isConfigured = () => Boolean(cfg.bucket)

const storageNotConfigured = () => {
  const err = new Error('File storage is not configured. Set AWS_BUCKET_NAME on the server.')
  err.statusCode = 503
  return err
}

// Lazily created so the API still boots when S3 isn't configured.
const getClient = () => {
  if (!isConfigured()) throw storageNotConfigured()
  if (!client) {
    client = new S3Client({
      region: cfg.region,
      // Newer SDKs add a CRC32 checksum of the (empty) body to pre-signed PUT
      // URLs, which makes S3 reject the browser's real upload. Only send
      // checksums when an operation requires them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // Static keys only when provided; otherwise the default provider chain
      // (EC2 instance role etc.) is used.
      ...(cfg.accessKey &&
        cfg.secretKey && {
          credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
        }),
    })
  }
  return client
}

const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/')

/** Public URL a stored object is served from (CloudFront/custom domain or S3). */
const publicUrlFor = (key) => {
  const base = cfg.publicUrl || `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`
  return `${base}/${encodeKey(key)}`
}

const aclFor = (isPublic) => (cfg.useAcl ? { ACL: isPublic ? 'public-read' : 'private' } : {})

// ── Server-side upload (certificates, invoices) ───────────────────────────
const uploadFile = async ({ buffer, key, mimeType, isPublic = true, cacheControl }) => {
  await getClient().send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ...(cacheControl && { CacheControl: cacheControl }),
      ...aclFor(isPublic),
    })
  )
  return publicUrlFor(key)
}

const deleteFile = async (key) => {
  await getClient().send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))
}

// ── Pre-signed PUT URL for direct browser → S3 upload ─────────────────────
// The browser must send exactly the returned `headers` with the PUT.
const generatePresignedUrl = async ({ key, mimeType, isPublic = true, expiresIn = 900 }) => {
  const cacheControl = 'public, max-age=31536000, immutable' // keys are unique per upload
  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: mimeType,
    CacheControl: cacheControl,
    ...aclFor(isPublic),
  })

  const signedUrl = await getSignedUrl(getClient(), command, { expiresIn })

  return {
    signedUrl,
    fileUrl: publicUrlFor(key),
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': cacheControl,
      ...(cfg.useAcl && { 'x-amz-acl': isPublic ? 'public-read' : 'private' }),
    },
  }
}

// ── Connectivity check for the admin status endpoint ──────────────────────
const checkStorage = async () => {
  const info = {
    configured: isConfigured(),
    bucket: cfg.bucket || null,
    region: cfg.region,
    publicBaseUrl: isConfigured() ? publicUrlFor('').replace(/\/$/, '') : null,
    credentials: cfg.accessKey ? 'access-key' : 'default-chain (instance role)',
    acl: cfg.useAcl,
  }
  if (!info.configured) return { ...info, ok: false, error: 'AWS_BUCKET_NAME is not set' }

  try {
    await getClient().send(new HeadBucketCommand({ Bucket: cfg.bucket }))
    return { ...info, ok: true }
  } catch (err) {
    return { ...info, ok: false, error: err.name || err.message }
  }
}

export { uploadFile, deleteFile, generatePresignedUrl, publicUrlFor, checkStorage, isConfigured }
