// src/middleware/errorHandler.js

import env from '../config/env.js'

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500
  let message = err.message || 'Internal Server Error'

  // MySQL errors
  if (err.code === 'ER_DUP_ENTRY') {
    statusCode = 409
    message = 'Duplicate entry — record already exists'
  }

  if (err.code === 'ER_NO_REFERENCED_ROW_2') {
    statusCode = 400
    message = 'Referenced record does not exist'
  }

  // Unexpected errors (database, code bugs) are logged below, not shown to
  // visitors. Errors the code raises on purpose (with a statusCode, e.g. a
  // payment gateway's reason) keep their message.
  if (!err.statusCode && statusCode >= 500 && env.isProd) {
    message = 'Something went wrong on our side. Please try again in a moment.'
  }

  const response = {
    success: false,
    message,
    ...(err.errors && { errors: err.errors }), // validation errors
    ...(env.isProd ? {} : { stack: err.stack }),
  }

  if (statusCode >= 500) {
    console.error(`[${new Date().toISOString()}] ERROR:`, err)
  }

  return res.status(statusCode).json(response)
}

export default errorHandler
