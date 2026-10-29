# Bulk CSV import

Admins can create or update courses, curriculum and quizzes from CSV files
(**Admin → Bulk Import**), or load ready-made AWS / Azure certification courses.

## Order

1. **Courses** — `courses.csv`
2. **Sections & Lessons** — `curriculum.csv` (references `course_slug`)
3. **Quizzes & Questions** — `quizzes.csv` (references `course_slug`)

Download a sample of each from the admin page (or `GET /api/v1/imports/templates/<type>.csv`).
The admin page also shows a column guide.

## Rules

- First row is the header (case-insensitive). Extra columns are ignored.
- Every row is validated first. If **any** row has a problem, nothing is written
  and you get a list of `{ row, column, message }` (row numbers match Excel).
- Valid files are written in one database transaction (all-or-nothing).
- **Check file (preview)** = dry run: shows what would be created/updated, saves nothing.
- Re-importing updates instead of duplicating:
  courses by `slug`, sections by title within the course, lessons by title within
  the section, quizzes by title within the course, questions by text within the quiz.
- Yes/no columns accept `yes/no/true/false/1/0`. List columns (`what_you_learn`,
  `requirements`) separate items with `|`.
- `duration_minutes` is in minutes (stored as seconds, like lessons created in the admin).

### Pricing (`courses.csv`)

| pricing_type | price | original_price | Result |
|---|---|---|---|
| `free` | (ignored) | (ignored) | Free course — students enrol instantly, no checkout |
| `paid` | `149` | empty | Paid, $149 |
| `paid` | `149` | `199` | Discounted: $149 ~~$199~~ 25% off |

`original_price` must be higher than `price`. Prices are USD (Razorpay converts to INR at checkout).

### Lesson types (`curriculum.csv`)

| lesson_type | content |
|---|---|
| `video` | S3 URL, MP4/WebM URL, or YouTube / Vimeo / Loom / Google Drive link |
| `text` | Plain text, Markdown-ish text or HTML (sanitised when shown) |
| `pdf` | PDF URL (S3 or public) |
| `link` | Any URL — opened in a new tab |
| `embed` | Google Slides/Docs, Figma, CodePen, Loom… (shown in an iframe) |
| `audio` | MP3 / M4A / OGG URL |
| `quiz` | Quiz title (or test id) from the same course |

### Question types (`quizzes.csv`)

| question_type | options | correct_answers |
|---|---|---|
| `single` | `option_a`…`option_f` (≥ 2) | exactly one letter, e.g. `B` |
| `multiple` (MCQ) | `option_a`…`option_f` (≥ 2) | one or more, e.g. `A,C` |
| `true_false` | none | `TRUE` or `FALSE` |

When a question is re-imported with unchanged options, option ids are kept so past
attempt results stay intact.

## Standard AWS / Azure packs

`seeds/standard/<pack>/{courses,curriculum,quizzes}.csv` + `packs.json`:

| Pack | Exam |
|---|---|
| `aws-cloud-practitioner` | CLF-C02 |
| `aws-solutions-architect-associate` | SAA-C03 |
| `azure-fundamentals` | AZ-900 |
| `azure-administrator` | AZ-104 |

Import from the admin page, or from the server:

```bash
npm run seed:standard                       # all packs
npm run seed:standard -- azure-fundamentals # one pack
```

Packs import as **draft + free**. Review the content, add a thumbnail, set the
price and publish. Exam domains/weights follow the official exam guides; check
them before publishing because AWS and Microsoft update exams periodically.

## API

```
GET  /api/v1/imports/templates              list types + column docs        (admin, sub-admin)
GET  /api/v1/imports/templates/:type.csv    sample CSV
POST /api/v1/imports/:type                  { csv, dry_run, create_missing_categories }
GET  /api/v1/imports/standard               bundled packs
POST /api/v1/imports/standard/:packId       import a pack
```

Sub-admins need `can_manage_courses` (courses, curriculum, packs) or
`can_manage_tests` (quizzes).
