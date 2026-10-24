// src/utils/response.js

const success = (res, { message = 'Success', data = null, statusCode = 200, pagination = null } = {}) => {
  const response = { success: true, message }
  if (data !== null) response.data = data
  if (pagination) response.pagination = pagination
  return res.status(statusCode).json(response)
}

const error = (res, { message = 'Something went wrong', statusCode = 500, errors = null } = {}) => {
  const response = { success: false, message }
  if (errors) response.errors = errors
  return res.status(statusCode).json(response)
}

export { success, error }
