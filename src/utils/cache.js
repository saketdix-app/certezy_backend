// src/utils/cache.js
import { client } from '../config/redis.js'

// ── Get from cache ─────────────────────────────────────────────────────────
const get = async (key) => {
  try {
    const data = await client.get(key)
    return data ? JSON.parse(data) : null
  } catch {
    return null // Redis down — gracefully skip cache
  }
}

// ── Set in cache ───────────────────────────────────────────────────────────
const set = async (key, value, ttlSeconds) => {
  try {
    await client.setEx(key, ttlSeconds, JSON.stringify(value))
  } catch {
    // Redis down — gracefully skip
  }
}

// ── Delete single key ──────────────────────────────────────────────────────
const del = async (key) => {
  try {
    await client.del(key)
  } catch {
    // Redis down — gracefully skip
  }
}

// ── Delete multiple keys by pattern (e.g. "courses:list:*") ───────────────
const delByPattern = async (pattern) => {
  try {
    const keys = await client.keys(pattern)
    if (keys.length) await client.del(keys)
  } catch {
    // Redis down — gracefully skip
  }
}

export { get, set, del, delByPattern }
