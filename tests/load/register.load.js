// tests/load/register.load.js

import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  vus: 50, // 50 virtual users
  duration: '20s', // 20 seconds
}

export default function () {
  const payload = JSON.stringify({
    name: `TestUser ${Math.floor(Math.random() * 99999)}`,
    email: `testuser${Math.floor(Math.random() * 99999)}@certezy.com`,
    password: 'Test@1234',
  })

  const params = {
    headers: { 'Content-Type': 'application/json' },
  }

  const res = http.post('http://localhost:5000/api/auth/register', payload, params)

  check(res, {
    'status is 201': (r) => r.status === 201,
    'response time < 1000ms': (r) => r.timings.duration < 1000,
  })

  sleep(1)
}
