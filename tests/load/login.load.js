// tests/load/login.load.js

import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  vus: 100, // 100 virtual users
  duration: '30s', // 30 seconds
}

export default function () {
  const payload = JSON.stringify({
    email: __ENV.TEST_EMAIL,
    password: __ENV.TEST_PASSWORD,
  })

  const params = {
    headers: { 'Content-Type': 'application/json' },
  }

  const res = http.post('http://localhost:5000/api/auth/login', payload, params)

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
    'has token': (r) => r.json('data') !== null,
  })

  sleep(1)
}
