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
const sendMail = async ({ to, subject, html, replyTo }) => {
  await transporter.sendMail({
    from: env.smtp.from,
    to,
    subject,
    html,
    ...(replyTo && { replyTo }),
  })
}

// Text typed by people goes into HTML emails escaped, with line breaks kept
const escapeHtml = (s = '') =>
  String(s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
    .replace(/\r?\n/g, '<br>')

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

const inr = (n) => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })

// 2. Discount link mail — admin bhejega (registered student or any email)
const sendDiscountMail = (
  to,
  {
    name,
    courseTitle,
    originalPrice,
    discountPrice,
    originalPriceInr,
    discountPriceInr,
    discountPct,
    token,
    offerUrl,
    expiresAt,
  }
) => {
  const link = offerUrl || `${env.frontendUrl}/offer/${token}`
  const pct = discountPct ? `${Math.round(discountPct)}% off` : 'Special price'
  return sendMail({
    to,
    subject: `${pct}: ${courseTitle} — your CERTEZY offer`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <div style="background:#0f2545;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
          <p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd">CERTEZY E-LEARNING PVT LTD</p>
          <h2 style="margin:6px 0 0;font-size:22px">${name ? `Hi ${name}, ` : ''}you have a special offer</h2>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:0;padding:24px;border-radius:0 0 12px 12px">
          <p style="margin:0 0 6px;font-size:15px"><b>${courseTitle}</b></p>
          <p style="margin:0 0 16px;font-size:15px">
            <span style="text-decoration:line-through;color:#94a3b8">$${originalPrice}</span>
            &nbsp;<span style="font-size:22px;font-weight:bold;color:#2563eb">$${discountPrice}</span>
            &nbsp;<span style="color:#16a34a;font-weight:bold">${pct}</span>
          </p>
          ${
            discountPriceInr != null
              ? `<p style="margin:-8px 0 16px;font-size:14px;color:#334155">In India:
                 <span style="text-decoration:line-through;color:#94a3b8">₹${inr(originalPriceInr)}</span>
                 &nbsp;<b style="color:#2563eb">₹${inr(discountPriceInr)}</b></p>`
              : ''
          }
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

// Reply to a contact-form message. Their answer goes to the support inbox.
const sendContactReplyMail = (to, { name, subject, originalMessage, receivedAt, reply, adminName }) =>
  sendMail({
    to,
    replyTo: env.supportEmail,
    subject: `Re: ${subject || 'Your message'} — CERTEZY`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        <div style="font-size:15px">${escapeHtml(reply)}</div>
        <p style="margin-top:20px">Best regards,<br>${escapeHtml(adminName || 'The CERTEZY team')}<br>
          <span style="color:#64748b">CERTEZY E-LEARNING PVT LTD · ${env.supportEmail}</span></p>
        <div style="margin-top:24px;padding:12px 16px;border-left:3px solid #cbd5e1;color:#64748b;font-size:13px">
          <p style="margin:0 0 6px">Your message${
            receivedAt ? ` of ${new Date(receivedAt).toUTCString().replace(/ GMT$/, ' UTC')}` : ''
          }:</p>
          <div>${escapeHtml(originalMessage)}</div>
        </div>
        <p style="font-size:12px;color:#94a3b8;margin-top:16px">You can reply to this email to continue the conversation.</p>
      </div>
    `,
  })

// Forgot password: reset link, or for social accounts how they sign in
const sendPasswordResetMail = (to, { name, resetUrl, minutes = 60, provider }) => {
  const providerName = provider === 'github' ? 'GitHub' : 'Google'
  // provider + link: a Google/GitHub account setting its first password
  const setting = Boolean(provider && resetUrl)
  const body = resetUrl
    ? `
        <p>${
          setting
            ? `Your CERTEZY account signs in with ${providerName}. Use the button below to also set a password, so you can sign in with your email and password too.`
            : 'We received a request to reset the password for your CERTEZY account.'
        }</p>
        <p style="margin:22px 0">
          <a href="${resetUrl}" style="display:inline-block;background:#3282B8;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${setting ? 'Set my password' : 'Reset my password'}</a>
        </p>
        <p style="font-size:13px;color:#64748b">The link works once and expires in ${minutes} minutes.
          If you didn't ask for this, ignore this email — your password stays the same.</p>
        <p style="font-size:12px;color:#94a3b8">If the button doesn't work, open: ${resetUrl}</p>`
    : `
        <p>We received a request to reset the password for your CERTEZY account.</p>
        <p>Your account signs in with <b>${providerName}</b>, so there is no CERTEZY password to reset.
          Go to <a href="${env.frontendUrl}/login">${env.frontendUrl.replace(/^https?:\/\//, '')}/login</a>
          and choose <b>Continue with ${providerName}</b>.</p>
        <p style="font-size:13px;color:#64748b">If you didn't ask for this, you can ignore this email.</p>`
  return sendMail({
    to,
    subject: 'Reset your CERTEZY password',
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        ${body}
        <p style="margin-top:20px">— CERTEZY E-LEARNING PVT LTD</p>
      </div>
    `,
  })
}

// 2.0 staff invitation: set a password to activate the account (no password is emailed)
const sendStaffInviteMail = (to, { name, roleLabel, invitedBy, setUrl, hours = 72 }) =>
  sendMail({
    to,
    subject: `You've been invited to CERTEZY as ${roleLabel}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        <p>${escapeHtml(invitedBy || 'A CERTEZY administrator')} has created a <b>${escapeHtml(roleLabel)}</b>
          account for you on CERTEZY. Set your password to activate it.</p>
        <p style="margin:22px 0">
          <a href="${setUrl}" style="display:inline-block;background:#3282B8;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">Set my password</a>
        </p>
        <p style="font-size:13px;color:#64748b">The link works once and expires in ${hours} hours. If you weren't
          expecting this, ignore this email or reply to let us know.</p>
        <p style="font-size:12px;color:#94a3b8">If the button doesn't work, open: ${setUrl}</p>
        <p style="margin-top:20px">— CERTEZY E-LEARNING PVT LTD</p>
      </div>
    `,
  })

// 2.0 security notice to Super Admins (new Super Admin, privilege granted/revoked)
const sendSecurityNoticeMail = (to, { name, title, lines = [] }) =>
  sendMail({
    to,
    subject: `CERTEZY security notice: ${title}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        <p><b>${escapeHtml(title)}</b></p>
        <ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
        <p style="font-size:13px;color:#64748b">You're receiving this because you are a CERTEZY Super Admin.
          Review it in Admin → Team → Audit log. If this wasn't expected, revoke the access right away.</p>
      </div>
    `,
  })

// Two-step sign-in: the one-time code (sent straight away, not queued)
const sendLoginCodeMail = (to, { name, code, purpose = 'login', minutes = 10 }) =>
  sendMail({
    to,
    subject: purpose === 'login' ? `${code} is your CERTEZY sign-in code` : `${code} is your CERTEZY verification code`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        <p>${purpose === 'login' ? 'Use this code to finish signing in to CERTEZY:' : 'Use this code to turn on two-step sign-in for your CERTEZY account:'}</p>
        <p style="font-size:30px;font-weight:bold;letter-spacing:8px;color:#1e3f5e;margin:18px 0">${escapeHtml(code)}</p>
        <p style="font-size:13px;color:#5b6b7b">It works for ${minutes} minutes. Never share it — CERTEZY staff will never ask for it.<br>
          If you didn't try to sign in, change your password straight away.</p>
      </div>
    `,
  })

// Bought a course without an account (guest checkout): set a password to start
const sendAccountReadyMail = (to, { name, courseTitle, setUrl, days = 7 }) =>
  sendMail({
    to,
    replyTo: env.supportEmail,
    subject: `Your course is ready — set your CERTEZY password`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        <p>Thanks for your purchase. <b>${escapeHtml(courseTitle)}</b> is now in your CERTEZY account.</p>
        <p>Set a password to sign in and start learning:</p>
        <p><a href="${setUrl}" style="background:#236a9e;color:#ffffff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Set my password</a></p>
        <p style="font-size:13px;color:#5e6e85">This link works for ${days} days. After that, use “Forgot password” on the sign-in page with this email.<br>
          Your receipt is in a separate email. Questions? Reply to this email.</p>
      </div>
    `,
  })

// Course syllabus, sent when someone asks for it on the course page
const sendSyllabusMail = (to, { name, courseTitle, courseUrl, sections = [] }) =>
  sendMail({
    to,
    replyTo: env.supportEmail,
    subject: `Your ${courseTitle} syllabus — CERTEZY`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;line-height:1.6">
        <p>Hi ${escapeHtml(name || 'there')},</p>
        <p>Here is the syllabus for <b>${escapeHtml(courseTitle)}</b>.</p>
        ${sections
          .map(
            (s, i) => `
          <p style="margin:16px 0 4px;font-weight:bold;color:#1b5582">${i + 1}. ${escapeHtml(s.title)}</p>
          <ul style="margin:0;padding-left:20px;color:#334155">${s.lessons.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`
          )
          .join('')}
        <p style="margin-top:24px"><a href="${courseUrl}" style="background:#236a9e;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">View the course</a></p>
        <p style="font-size:13px;color:#5e6e85">Questions? Reply to this email and an advisor will help you.<br>
          CERTEZY E-LEARNING PVT LTD · ${env.supportEmail}</p>
      </div>
    `,
  })

export {
  sendAccountReadyMail,
  sendSyllabusMail,
  sendStaffInviteMail,
  sendSecurityNoticeMail,
  sendPasswordResetMail,
  sendWelcomeMail,
  sendDiscountMail,
  sendInvoiceMail,
  sendSubAdminCredsMail,
  sendCourseAssignedMail,
  sendContactReplyMail,
  sendLoginCodeMail,
}
