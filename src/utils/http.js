// src/utils/http.js
// Standard error type + controller helpers shared by every module.
//
//   throw new AppError('Course not found', 404)
//   throw AppError.notFound('Course')
//   router.get('/', asyncHandler(async (req, res) => success(res, { data })))

export class AppError extends Error {
  constructor(message, statusCode = 500, errors = undefined) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    if (errors) this.errors = errors
  }

  static badRequest(message, errors) {
    return new AppError(message, 400, errors)
  }

  static forbidden(message = 'Access denied') {
    return new AppError(message, 403)
  }

  static notFound(what = 'Resource') {
    return new AppError(`${what} not found`, 404)
  }

  static conflict(message) {
    return new AppError(message, 409)
  }

  static unprocessable(message, errors) {
    return new AppError(message, 422, errors)
  }
}

/** Wrap an async controller so rejected promises reach the error handler. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

/** Parse pagination query params safely (page ≥ 1, 1 ≤ limit ≤ max). */
export const parsePaging = ({ page, limit } = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const p = Math.max(parseInt(page, 10) || 1, 1)
  const l = Math.min(Math.max(parseInt(limit, 10) || defaultLimit, 1), maxLimit)
  return { page: p, limit: l, offset: (p - 1) * l }
}

export const buildPagination = ({ total, page, limit }) => ({
  total: Number(total),
  page: Number(page),
  limit: Number(limit),
  totalPages: Math.ceil(Number(total) / Number(limit)),
})
