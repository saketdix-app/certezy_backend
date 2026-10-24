// src/utils/upload.js

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import env from '../config/env.js'

// ─── S3 CLIENT SETUP ─────────────────────────────────────────────────────
// Migrated to exact AWS S3 infrastructure
const s3 = new S3Client({
  region: env.s3.region,
  credentials: {
    accessKeyId: env.s3.accessKey,
    secretAccessKey: env.s3.secretKey,
  },
})

// ── Upload file to S3 ───────────────────────────────────────────────
const uploadFile = async ({ buffer, key, mimeType, isPublic = true }) => {
  const command = new PutObjectCommand({
    Bucket: env.s3.bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ACL: isPublic ? 'public-read' : 'private',
  })

  await s3.send(command)

  // AWS S3 public URL format
  const url = `https://${env.s3.bucket}.s3.${env.s3.region}.amazonaws.com/${key}`

  return url
}

const deleteFile = async (key) => {
  const command = new DeleteObjectCommand({
    Bucket: env.s3.bucket,
    Key: key,
  })

  await s3.send(command)
}

// ── Generate Pre-Signed URL for Frontend Upload ────────────────────────────
const generatePresignedUrl = async ({ key, mimeType, isPublic = true, expiresIn = 300 }) => {
  const command = new PutObjectCommand({
    Bucket: env.s3.bucket,
    Key: key,
    ContentType: mimeType,
    ACL: isPublic ? 'public-read' : 'private',
  })

  // Generate URL that expires in 5 minutes
  const signedUrl = await getSignedUrl(s3, command, { expiresIn })

  // Public AWS S3 URL where file will be accessible after upload
  const fileUrl = `https://${env.s3.bucket}.s3.${env.s3.region}.amazonaws.com/${key}`

  return { signedUrl, fileUrl }
}

export { uploadFile, deleteFile, generatePresignedUrl }
