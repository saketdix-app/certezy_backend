// src/modules/admin/admin.queries.js

import { STAFF_PERMISSIONS } from '../../constants.js'
import { pool } from '../../config/db.js'
import { istMonthStart } from '../../utils/ist.js'

// ── Get permissions by user_id ─────────────────────────────────────────────
const getPermissionsByUserId = (user_id) =>
  pool.query(`SELECT * FROM admin_permissions WHERE user_id = ? LIMIT 1`, [user_id])

// ── Create permissions ─────────────────────────────────────────────────────
// Any of STAFF_PERMISSIONS may be given; the rest default to 0
const createPermissions = ({ user_id, created_by, ...perms }) => {
  const keys = STAFF_PERMISSIONS
  return pool.query(
    `INSERT INTO admin_permissions (user_id, ${keys.join(', ')}, created_by)
     VALUES (?, ${keys.map(() => '?').join(', ')}, ?)`,
    [user_id, ...keys.map((k) => (perms[k] ? 1 : 0)), created_by ?? null]
  )
}

// ── Update permissions ─────────────────────────────────────────────────────
// Only the keys provided change (older forms send the original five)
const updatePermissions = (user_id, perms) => {
  const keys = STAFF_PERMISSIONS.filter((k) => perms[k] !== undefined)
  if (!keys.length) return Promise.resolve([{ affectedRows: 0 }])
  return pool.query(
    `UPDATE admin_permissions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`,
    [...keys.map((k) => (perms[k] ? 1 : 0)), user_id]
  )
}

// ── Delete permissions ─────────────────────────────────────────────────────
const deletePermissions = (user_id) =>
  pool.query(`DELETE FROM admin_permissions WHERE user_id = ?`, [user_id])

// ── Get dashboard stats ────────────────────────────────────────────────────
const getDashboardStats = async () => {
  const [userCount] = await pool.query(`SELECT COUNT(*) AS total FROM users`)
  const [activeUserCount] = await pool.query(`SELECT COUNT(*) AS total FROM users WHERE is_active = 1`)
  const [courseCount] = await pool.query(`SELECT COUNT(*) AS total FROM courses`)
  const [publishedCourseCount] = await pool.query(
    `SELECT COUNT(*) AS total FROM courses WHERE status = 'published'`
  )
  const [enrollmentCount] = await pool.query(`SELECT COUNT(*) AS total FROM enrollments`)
  // Revenue is not here: it is Super Admin only (GET /payments/admin/revenue).
  // Growth = what was added this India-time month (real numbers, not estimates)
  const monthStart = istMonthStart()
  const [[added]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS users,
            (SELECT COUNT(*) FROM courses WHERE status = 'published' AND created_at >= ?) AS courses`,
    [monthStart, monthStart]
  )
  const [pendingReviews] = await pool.query(`SELECT COUNT(*) AS total FROM reviews WHERE is_approved = 0`)
  const [pendingPayments] = await pool.query(
    `SELECT COUNT(*) AS total FROM payments WHERE status = 'pending'`
  )

  let recentEnrollments = []
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.user_id, e.course_id, e.enrolled_at,
              u.name AS student_name, c.title AS course_title
       FROM enrollments e
       JOIN users u ON u.id = e.user_id
       JOIN courses c ON c.id = e.course_id
       ORDER BY e.enrolled_at DESC
       LIMIT 5`
    )
    recentEnrollments = rows
  } catch {
    recentEnrollments = []
  }

  const totalUsers = Number(userCount[0]?.total || 0)
  const activeUsers = Number(activeUserCount[0]?.total || 0)
  const totalCourses = Number(courseCount[0]?.total || 0)
  const publishedCourses = Number(publishedCourseCount[0]?.total || 0)
  const totalEnrollments = Number(enrollmentCount[0]?.total || 0)
  const newUsers = Number(added?.users || 0)
  const newCourses = Number(added?.courses || 0)
  const pendingRev = Number(pendingReviews[0]?.total || 0)
  const pendingPay = Number(pendingPayments[0]?.total || 0)

  return {
    total_users: totalUsers,
    totalUsers,
    active_users: activeUsers,
    activeUsers,
    total_courses: totalCourses,
    totalCourses,
    published_courses: publishedCourses,
    publishedCourses,
    total_enrollments: totalEnrollments,
    totalEnrollments,
    pending_reviews: pendingRev,
    pendingReviews: pendingRev,
    pending_payments: pendingPay,
    pendingPayments: pendingPay,
    recent_enrollments: recentEnrollments,
    recentEnrollments,
    new_users_this_month: newUsers,
    newUsersThisMonth: newUsers,
    new_courses_this_month: newCourses,
    newCoursesThisMonth: newCourses,
  }
}

export { getPermissionsByUserId, createPermissions, updatePermissions, deletePermissions, getDashboardStats }
