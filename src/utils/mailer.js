// src/utils/mailer.js

import nodemailer from 'nodemailer'
import env from '../config/env.js'

const transporter = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.port === 465,
  auth: {
    user: env.smtp.user,
    pass: env.smtp.pass,
  },
})

// Startup pe connection verify karo
transporter.verify((err) => {
  if (err) console.error('Mailer connection failed:', err.message)
  else console.log(' Mailer ready')
})

// ─── CORE SEND ───────────────────────────────────────────────
const sendMail = async ({ to, subject, html }) => {
  await transporter.sendMail({
    from: env.smtp.from,
    to,
    subject,
    html,
  })
}

// ─── TEMPLATES ───────────────────────────────────────────────

// 1. Welcome mail — register ke baad
const sendWelcomeMail = (to, name) => {
  return sendMail({
    to,
    subject: `Welcome to ${env.appName}! 🎓`,
    html: `
      <h2>Welcome, ${name}!</h2>
      <p>Your account has been created successfully.</p>
      <p>Start learning today — explore our courses.</p>
      <br/>
      <a href="${env.frontendUrl}/courses">Browse Courses</a>
    `,
  })
}

// 2. Discount link mail — admin bhejega (registered student or any email)
const sendDiscountMail = (
  to,
  { name, courseTitle, originalPrice, discountPrice, discountPct, token, offerUrl, expiresAt }
) => {
  const link = offerUrl || `${env.frontendUrl}/offer/${token}`
  const pct = discountPct ? `${Math.round(discountPct)}% off` : 'Special price'
  return sendMail({
    to,
    subject: `${pct}: ${courseTitle} — your Certezy offer`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <div style="background:#0f2545;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
          <p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd">Certezy E-Learning</p>
          <h2 style="margin:6px 0 0;font-size:22px">${name ? `Hi ${name}, ` : ''}you have a special offer</h2>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:0;padding:24px;border-radius:0 0 12px 12px">
          <p style="margin:0 0 6px;font-size:15px"><b>${courseTitle}</b></p>
          <p style="margin:0 0 16px;font-size:15px">
            <span style="text-decoration:line-through;color:#94a3b8">$${originalPrice}</span>
            &nbsp;<span style="font-size:22px;font-weight:bold;color:#2563eb">$${discountPrice}</span>
            &nbsp;<span style="color:#16a34a;font-weight:bold">${pct}</span>
          </p>
          <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">Claim offer &amp; pay</a>
          <p style="margin:18px 0 0;font-size:13px;color:#64748b">
            Valid until ${new Date(expiresAt).toUTCString()}. Sign in or create your account with
            <b>${to}</b> to use this offer — it works only for this email address.
          </p>
          <p style="margin:12px 0 0;font-size:12px;color:#94a3b8">If the button doesn't work, open: ${link}</p>
        </div>
      </div>
    `,
  })
}

// 3. Invoice mail — payment ke baad
const sendInvoiceMail = (to, { name, courseTitle, amount, invoiceUrl, transactionId }) => {
  return sendMail({
    to,
    subject: `Invoice — ${courseTitle} ✅`,
    html: `
      <h2>Payment Successful!</h2>
      <p>Hi ${name}, thank you for your purchase.</p>
      <p><b>Course:</b> ${courseTitle}</p>
      <p><b>Amount Paid:</b> $${amount}</p>
      <p><b>Transaction ID:</b> ${transactionId}</p>
      <br/>
      <a href="${invoiceUrl}">Download Invoice</a>
    `,
  })
}

// 4. Sub-admin credentials mail — admin ne banaya
const sendSubAdminCredsMail = (to, { name, password }) => {
  return sendMail({
    to,
    subject: 'Your Admin Account is Ready 🔐',
    html: `
      <h2>Hi ${name}!</h2>
      <p>Your sub-admin account has been created.</p>
      <p><b>Email:</b> ${to}</p>
      <p><b>Password:</b> ${password}</p>
      <br/>
      <a href="${env.frontendUrl}/login">Login Here</a>
      <br/><br/>
      <small>Please change your password after first login.</small>
    `,
  })
}

// 5. Course assigned free by an admin
const escapeHtml = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

const sendCourseAssignedMail = (to, { name, courseTitles = [] }) => {
  const list = courseTitles.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
  const many = courseTitles.length > 1
  return sendMail({
    to,
    subject: `You've been given free access to ${many ? 'new courses' : 'a new course'} on ${env.appName}`,
    html: `
      <h2>Hi ${escapeHtml(name)},</h2>
      <p>Good news! You now have free access to the following ${many ? 'courses' : 'course'}:</p>
      <ul>${list}</ul>
      <p>${many ? 'They are' : 'It is'} ready for you under <strong>My Courses</strong> — no payment needed.</p>
      <br/>
      <a href="${env.frontendUrl}/student/my-courses">Start learning</a>
      <br/><br/>
      <small>Questions? Contact us at ${env.supportEmail}.</small>
    `,
  })
}

export { sendWelcomeMail, sendDiscountMail, sendInvoiceMail, sendSubAdminCredsMail, sendCourseAssignedMail }
