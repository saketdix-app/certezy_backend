// src/middleware/permission.js

import * as adminQueries from '../modules/admin/admin.queries.js'

// Usage: permission('can_manage_courses')
const permission = (permissionKey) => {
  return async (req, res, next) => {
    try {
      // Sirf sub_admin ke liye check hoga
      // Admin ko saari permissions hain by default
      if (req.user.role === 'admin') return next()

      const [rows] = await adminQueries.getPermissionsByUserId(req.user.id)

      if (!rows.length) {
        const err = new Error('No permissions assigned to this sub-admin')
        err.statusCode = 403
        return next(err)
      }

      if (!rows[0][permissionKey]) {
        const err = new Error(`Access denied — missing permission: ${permissionKey}`)
        err.statusCode = 403
        return next(err)
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

export default permission
