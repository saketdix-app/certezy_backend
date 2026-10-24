// src/config/redis.js

import { createClient } from 'redis'
import env from './env.js'

const client = createClient({
  socket: {
    host: env.redis.host,
    port: env.redis.port,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('❌ Redis max retries reached')
        return new Error('Redis max retries')
      }
      return Math.min(retries * 100, 3000)
    },
  },
  ...(env.redis.password && { password: env.redis.password }),
})

client.on('connect', () => console.log('✅ Redis connected successfully'))
client.on('error', (err) => console.error('⚠️  Redis error:', err.message))

const connectRedis = async () => {
  try {
    await client.connect()
  } catch (err) {
    console.error('⚠️  Redis connection failed — caching disabled:', err.message)
  }
}

export { client, connectRedis }
