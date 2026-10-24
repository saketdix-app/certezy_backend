// server.js — process entry point

import env from './src/config/env.js'
import testConnection, { pool } from './src/config/db.js'
import { connectRedis, client as redisClient } from './src/config/redis.js'
import './src/jobs/emailWorker.js'
import app from './src/app.js'

const start = async () => {
  await testConnection()
  await connectRedis()

  const server = app.listen(env.PORT, () => {
    console.log(`\n🚀 ${env.appName} API running on port ${env.PORT} [${env.NODE_ENV}]\n`)
  })

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down gracefully`)
    server.close(async () => {
      await Promise.allSettled([pool.end(), redisClient.isOpen && redisClient.quit()])
      process.exit(0)
    })
    // Force exit if connections don't close in time
    setTimeout(() => process.exit(1), 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

start().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
