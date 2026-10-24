# 🎓 Certezy — Online Learning & Certification System

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-4.x-000000?style=for-the-badge&logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?style=for-the-badge&logo=mysql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-Cache-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-Auth-000000?style=for-the-badge&logo=jsonwebtokens&logoColor=white)

**A scalable, production-ready backend for an online learning platform.**
Courses · Practice Tests · Certifications · Subscriptions · Discount Links · Admin Panel

</div>

---

## 📌 Table of Contents

- [Overview](#-overview)
- [Tech Stack](#-tech-stack)
- [Features](#-features)
- [Folder Structure](#-folder-structure)
- [Database](#-database)
- [Getting Started](#-getting-started)
- [Environment Variables](#-environment-variables)
- [API Overview](#-api-overview)
- [Roles & Permissions](#-roles--permissions)
- [Auth Flow](#-auth-flow)
- [Discount Link Flow](#-discount-link-flow)
- [Payment Flow](#-payment-flow)
- [Caching Strategy](#-caching-strategy)
- [Security](#-security)
- [Scalability Plan](#-scalability-plan)
- [Code Rules](#-code-rules)

---

## 🧭 Overview

Certezy is a full-featured online learning and certification backend — similar to Whizlabs, Simplilearn, and CompTIA. It supports:

- Students purchasing and consuming courses
- Admins managing content, users, and sub-admins
- Practice tests with auto-scoring
- Auto-generated certificates on course completion
- Discount links sent via email for specific students
- Invoice emails after successful payment

---

## 🛠 Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js 20+ | Server |
| Framework | Express.js 4.x | REST API |
| Database | MySQL 8.0 | Primary data store |
| Cache | Redis | Performance |
| Auth | JWT + Refresh Tokens | Secure sessions |
| Password | bcrypt (12 rounds) | Hashing |
| Validation | Joi | Request validation |
| File Storage | AWS S3 | Videos, PDFs, avatars |
| Email | Nodemailer (SMTP) | Transactional emails |
| Payment | Razorpay / Stripe | Checkout |

---

## ✨ Features

### 👤 User Management
- Student self-registration
- Admin creates sub-admins with custom permissions
- Role-based access control (admin / sub_admin / student)
- First-login password change for sub-admins
- Profile management with avatar upload

### 📚 Course Management
- Categories with parent-child support
- Course CRUD with draft / published / archived status
- Sections and lessons (video / article / quiz)
- Free preview lessons (no login needed)
- Full-text search on courses

### 🎯 Practice Tests
- Multiple test types: practice, mock, diagnostic, final
- Question types: single choice, multiple choice, true/false
- Auto-scoring with explanations
- Attempt history and analytics

### 💳 Payments
- Course purchase (one-time)
- Subscription plans
- Discount link payments
- Auto invoice PDF generation + email

### 🎟️ Discount Links
- Admin sends a personalised discount link to a specific student
- Single-use + expiry time
- Auto-applies discount at checkout
- Invoice email after payment

### 🏆 Certificates
- Auto-generated when course is 100% completed + test passed
- Unique certificate number
- PDF stored on S3

### ⭐ Reviews & Ratings
- Students rate courses after enrollment
- Auto-update average rating on course

### 🔔 Notifications
- In-app notifications for every key event
- Enrollment, payment, certificate, test result, discount offer

---

## 🗂 Folder Structure

> Each module has **4 files** — routes, controller, service, queries.
> This keeps SQL completely separate from business logic.

```
backend/
│
├── src/
│   │
│   ├── config/
│   │   ├── db.js                      # MySQL connection pool
│   │   ├── redis.js                   # Redis client
│   │   └── env.js                     # Env variables validation
│   │
│   ├── middleware/
│   │   ├── auth.js                    # JWT access token verify
│   │   ├── role.js                    # Role guard (admin/sub_admin/student)
│   │   ├── permission.js              # Sub-admin permission check
│   │   ├── rateLimit.js               # Per-route rate limiting
│   │   ├── validate.js                # Joi schema validation
│   │   └── errorHandler.js            # Global error handler
│   │
│   ├── modules/
│   │   │
│   │   ├── auth/
│   │   │   ├── auth.routes.js         # Endpoints define karo
│   │   │   ├── auth.controller.js     # req/res handle karo
│   │   │   ├── auth.service.js        # Business logic
│   │   │   └── auth.queries.js        # Sirf SQL queries
│   │   │
│   │   ├── users/
│   │   │   ├── users.routes.js
│   │   │   ├── users.controller.js
│   │   │   ├── users.service.js
│   │   │   └── users.queries.js
│   │   │
│   │   ├── admin/
│   │   │   ├── admin.routes.js
│   │   │   ├── admin.controller.js
│   │   │   ├── admin.service.js
│   │   │   └── admin.queries.js
│   │   │
│   │   ├── categories/
│   │   │   ├── categories.routes.js
│   │   │   ├── categories.controller.js
│   │   │   ├── categories.service.js
│   │   │   └── categories.queries.js
│   │   │
│   │   ├── courses/
│   │   │   ├── courses.routes.js
│   │   │   ├── courses.controller.js
│   │   │   ├── courses.service.js
│   │   │   └── courses.queries.js
│   │   │
│   │   ├── sections/
│   │   │   ├── sections.routes.js
│   │   │   ├── sections.controller.js
│   │   │   ├── sections.service.js
│   │   │   └── sections.queries.js
│   │   │
│   │   ├── lessons/
│   │   │   ├── lessons.routes.js
│   │   │   ├── lessons.controller.js
│   │   │   ├── lessons.service.js
│   │   │   └── lessons.queries.js
│   │   │
│   │   ├── enrollments/
│   │   │   ├── enrollments.routes.js
│   │   │   ├── enrollments.controller.js
│   │   │   ├── enrollments.service.js
│   │   │   └── enrollments.queries.js
│   │   │
│   │   ├── progress/
│   │   │   ├── progress.routes.js
│   │   │   ├── progress.controller.js
│   │   │   ├── progress.service.js
│   │   │   └── progress.queries.js
│   │   │
│   │   ├── tests/
│   │   │   ├── tests.routes.js
│   │   │   ├── tests.controller.js
│   │   │   ├── tests.service.js
│   │   │   └── tests.queries.js
│   │   │
│   │   ├── attempts/
│   │   │   ├── attempts.routes.js
│   │   │   ├── attempts.controller.js
│   │   │   ├── attempts.service.js
│   │   │   └── attempts.queries.js
│   │   │
│   │   ├── plans/
│   │   │   ├── plans.routes.js
│   │   │   ├── plans.controller.js
│   │   │   ├── plans.service.js
│   │   │   └── plans.queries.js
│   │   │
│   │   ├── payments/
│   │   │   ├── payments.routes.js
│   │   │   ├── payments.controller.js
│   │   │   ├── payments.service.js
│   │   │   └── payments.queries.js
│   │   │
│   │   ├── discounts/
│   │   │   ├── discounts.routes.js
│   │   │   ├── discounts.controller.js
│   │   │   ├── discounts.service.js
│   │   │   └── discounts.queries.js
│   │   │
│   │   ├── certificates/
│   │   │   ├── certificates.routes.js
│   │   │   ├── certificates.controller.js
│   │   │   ├── certificates.service.js
│   │   │   └── certificates.queries.js
│   │   │
│   │   ├── reviews/
│   │   │   ├── reviews.routes.js
│   │   │   ├── reviews.controller.js
│   │   │   ├── reviews.service.js
│   │   │   └── reviews.queries.js
│   │   │
│   │   └── notifications/
│   │       ├── notifications.routes.js
│   │       ├── notifications.controller.js
│   │       ├── notifications.service.js
│   │       └── notifications.queries.js
│   │
│   ├── utils/
│   │   ├── response.js                # Standard API response format
│   │   ├── cache.js                   # Redis get/set/del helpers
│   │   ├── paginate.js                # Pagination helper
│   │   ├── mailer.js                  # Send email (Nodemailer)
│   │   ├── upload.js                  # AWS S3 upload helper
│   │   ├── token.js                   # JWT generate & verify
│   │   ├── invoice.js                 # Invoice PDF generator
│   │   └── generate.js                # UUID, cert number, random password
│   │
│   └── app.js                         # Express app + all routes register
│
├── .env
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## 📁 Each File Ka Role

```
auth.routes.js     →  Sirf endpoints define karo + middleware lagao
auth.controller.js →  Sirf req/res handle karo, service ko call karo
auth.service.js    →  Business logic — calculation, decisions, flow
auth.queries.js    →  Sirf SQL queries — koi logic nahi, sirf DB calls
```

**Example:**
```js
// auth.queries.js
const findUserByEmail = (email) =>
  db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);

// auth.service.js
const { findUserByEmail } = require('./auth.queries');
const user = await findUserByEmail(email);
// ab business logic karo...
```

---

## 🗄 Database

**Total Tables: 21**

| # | Table | Purpose |
|---|---|---|
| 1 | `users` | All roles — student, sub_admin, admin |
| 2 | `refresh_tokens` | JWT session management |
| 3 | `admin_permissions` | Sub-admin access control |
| 4 | `categories` | Course grouping (parent-child) |
| 5 | `courses` | All course data |
| 6 | `sections` | Course chapters |
| 7 | `lessons` | Video / article / quiz |
| 8 | `enrollments` | Student course enrollment |
| 9 | `lesson_progress` | Per-lesson watch tracking |
| 10 | `tests` | Practice / mock tests |
| 11 | `questions` | Test questions |
| 12 | `options` | Answer choices (A/B/C/D) |
| 13 | `test_attempts` | Attempt score + result |
| 14 | `attempt_answers` | Per-question answer record |
| 15 | `plans` | Subscription plan types |
| 16 | `subscriptions` | Active student subscription |
| 17 | `payments` | All transactions |
| 18 | `discount_links` | Personalised discount offers |
| 19 | `certificates` | Course completion certificates |
| 20 | `reviews` | Course ratings and comments |
| 21 | `notifications` | In-app alerts |
| 22 | `contacts` | User and guest contact queries |

**Import schema:**
```bash
mysql -u root -p your_database_name < schema.sql
```

---

## 🚀 Getting Started

```bash
# 1. Clone the repo
git clone https://github.com/saketdix-app/certezy_backend.git
cd certezy_backend

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your values

# 4. Import database schema
mysql -u root -p your_database_name < schema.sql

# 5. Start development server
npm run dev

# 6. Start production server
npm start
```

---

## ⚙️ Environment Variables

```env
# ── Server ─────────────────────────────
PORT=5000
NODE_ENV=development

# ── Database ───────────────────────────
DB_HOST=localhost
DB_PORT=3306
DB_NAME=certezy
DB_USER=root
DB_PASSWORD=yourpassword
DB_POOL_MIN=5
DB_POOL_MAX=50

# ── JWT ────────────────────────────────
JWT_SECRET=your_jwt_secret_key_here
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_SECRET=your_refresh_secret_here
REFRESH_TOKEN_EXPIRES_IN=7d

# ── Redis ──────────────────────────────
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# ── AWS S3 ─────────────────────────────
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-south-1
AWS_BUCKET_NAME=certezy-bucket

# ── Email ──────────────────────────────
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your_app_password
MAIL_FROM="Certezy <noreply@certezy.com>"

# ── Payment ────────────────────────────
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

# ── Frontend ───────────────────────────
FRONTEND_URL=http://localhost:5173
```

---

## 📡 API Overview

### Auth
```
POST   /api/v1/auth/register              Student registration
POST   /api/v1/auth/login                 Login (all roles)
POST   /api/v1/auth/refresh               Refresh access token
POST   /api/v1/auth/logout                Logout
POST   /api/v1/auth/change-password       First login password change
```

### Admin
```
POST   /api/v1/admin/sub-admins           Create sub-admin
GET    /api/v1/admin/sub-admins           List all sub-admins
PUT    /api/v1/admin/sub-admins/:id       Update permissions
DELETE /api/v1/admin/sub-admins/:id       Remove sub-admin
GET    /api/v1/admin/dashboard            Stats overview
```

### Courses
```
GET    /api/v1/courses                    List all (with filters + search)
GET    /api/v1/courses/:slug              Single course detail
POST   /api/v1/courses                    Create (admin)
PUT    /api/v1/courses/:id                Update (admin)
DELETE /api/v1/courses/:id                Delete (admin)
```

### Tests
```
GET    /api/v1/tests/:id                  Test detail + questions
POST   /api/v1/tests                      Create test (admin)
POST   /api/v1/tests/:id/attempts         Submit attempt
GET    /api/v1/tests/:id/attempts         My attempt history
```

### Payments
```
POST   /api/v1/payments/create-order      Create payment order
POST   /api/v1/payments/verify            Verify & confirm payment
POST   /api/v1/payments/webhook           Payment gateway webhook
GET    /api/v1/payments/history           My payment history
```

### Discounts
```
POST   /api/v1/discounts                  Create discount link (admin)
GET    /api/v1/discounts/verify/:token    Verify token before checkout
GET    /api/v1/discounts                  List all discount links (admin)
```

### Others
```
GET    /api/v1/enrollments                My enrolled courses
POST   /api/v1/progress                   Update lesson progress
GET    /api/v1/certificates               My certificates
POST   /api/v1/reviews                    Submit review
GET    /api/v1/notifications              My notifications
PUT    /api/v1/notifications/read         Mark as read
```

### Contact
```text
GET    /api/v1/contact                    List all messages (admin)
GET    /api/v1/contact/:id                Get specific message (admin)
POST   /api/v1/contact/create             Submit a new message
PUT    /api/v1/contact/:id/status         Update message status (admin)
```

---

## 👥 Roles & Permissions

| Action | Student | Sub-Admin | Admin |
|---|:---:|:---:|:---:|
| Register / Login | ✅ | ✅ | ✅ |
| Browse courses | ✅ | ✅ | ✅ |
| Purchase course | ✅ | — | — |
| Give test | ✅ | — | — |
| Write review | ✅ | — | — |
| Create course | ❌ | ⚙️ | ✅ |
| Manage students | ❌ | ⚙️ | ✅ |
| Send discount link | ❌ | ⚙️ | ✅ |
| View payments | ❌ | ⚙️ | ✅ |
| Create sub-admin | ❌ | ❌ | ✅ |
| Full dashboard | ❌ | ❌ | ✅ |

> ⚙️ = Only if admin has granted that permission

---

## 🔐 Auth Flow

```
REGISTER
Student fills form → POST /auth/register
→ Password bcrypt hash → Save in users table
→ Send verification email
→ User clicks link → is_verified = 1

LOGIN
POST /auth/login (email + password)
→ bcrypt compare
→ Generate Access Token (15m) + Refresh Token (7d)
→ Save refresh token in DB
→ Return both tokens

REFRESH
POST /auth/refresh (send refresh token)
→ Verify from DB + JWT
→ Issue new access token

LOGOUT
POST /auth/logout
→ Delete refresh token from DB
```

---

## 🎟️ Discount Link Flow

```
1. Admin → Dashboard → Select student + course
2. Set discount price + expiry hours
3. POST /api/v1/discounts → UUID token generated
4. Email sent to student:
   ──────────────────────────────────
   Special Offer for You!
   Course: AWS Solutions Architect
   Price: $500 → $299
   Valid for: 24 hours
   [Claim Offer] → /checkout?token=UUID
   ──────────────────────────────────
5. Student clicks link
6. GET /api/v1/discounts/verify/:token
   → Check: valid? not used? not expired?
   → Return course + discounted price
7. Student pays discounted amount
8. POST /api/v1/payments/verify
   → Mark token as used (is_used = 1)
   → Create enrollment
   → Generate invoice PDF → S3
   → Send invoice email to student
```

---

## 💳 Payment Flow

```
1. POST /api/v1/payments/create-order
   → Create order on Razorpay
   → Save as pending in payments table

2. Student completes payment on frontend

3. POST /api/v1/payments/verify
   → Verify payment signature
   → Update status → success
   → Create enrollment record
   → courses.enrolled_count + 1
   → Generate invoice PDF → email
   → Create notification

4. POST /api/v1/payments/webhook (backup)
   → Razorpay sends webhook on success
   → Same flow (idempotent check)
```

---

## ⚡ Caching Strategy

| Data | Cache Key | TTL |
|---|---|---|
| All categories | `categories:all` | 1 hour |
| Course list | `courses:list:p{page}` | 10 min |
| Single course | `course:slug:{slug}` | 15 min |
| User profile | `user:{id}:profile` | 5 min |
| Test + questions | `test:{id}:full` | 30 min |

**Invalidation Rules:**
- Course updated → delete `course:slug:*` + `courses:list:*`
- New enrollment → delete `user:{id}:profile`
- Category added → delete `categories:all`

---

## 🔒 Security

| Layer | Implementation |
|---|---|
| Password | bcrypt, 12 rounds |
| Auth | JWT (15m) + Refresh Token (7d) |
| Rate Limiting | Login: 5/min · API: 100/min |
| HTTP Headers | Helmet.js |
| CORS | Frontend URL only |
| SQL Injection | Parameterized queries only |
| Input Validation | Joi on all endpoints |
| Role Guard | Middleware on every protected route |
| Discount Links | Single-use + expiry enforced |

---

## 📈 Scalability Plan

| Users | Strategy |
|---|---|
| 0 – 1K | Single server + MySQL + Redis |
| 1K – 10K | MySQL Read Replica + Redis cluster |
| 10K – 50K | Load Balancer + Multiple Express instances |
| 50K – 100K | CDN for videos + Queue (BullMQ) for emails |
| 100K+ | Microservices split per domain |

---

## 📐 Code Rules (Must Follow)

**1. Always parameterized queries**
```js
// ❌ Wrong
db.query(`SELECT * FROM users WHERE email = '${email}'`);

// ✅ Correct
db.query('SELECT * FROM users WHERE email = ?', [email]);
```

**2. No N+1 queries — always JOIN**
```js
// ❌ Wrong
courses.forEach(c => db.query('SELECT ... WHERE course_id = ?', [c.id]));

// ✅ Correct
db.query(`
  SELECT c.*, COUNT(r.id) as review_count
  FROM courses c
  LEFT JOIN reviews r ON r.course_id = c.id
  GROUP BY c.id
`);
```

**3. Standard API response — always**
```js
// Success
res.json({ success: true, message: '...', data: {} });

// Error — via next(err)
next({ status: 404, message: 'Course not found' });
```

**4. 4-file module pattern — always**
```
routes.js      →  Endpoints + middleware
controller.js  →  req/res only
service.js     →  Business logic
queries.js     →  SQL only
```

---

## 📦 NPM Packages

```bash
npm install express mysql2 redis bcryptjs jsonwebtoken
npm install nodemailer multer @aws-sdk/client-s3
npm install joi express-rate-limit helmet cors
npm install uuid dotenv morgan razorpay
npm install --save-dev nodemon
```

---

<div align="center">

Built with ❤️ — Scalable · Secure · Production Ready

</div>
