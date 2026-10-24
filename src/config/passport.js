// src/config/passport.js

import passport from 'passport'
import { Strategy as GoogleStrategy } from 'passport-google-oauth20'
import { Strategy as GitHubStrategy } from 'passport-github2'
import env from './env.js'
import { pool } from './db.js'

// ─── GOOGLE STRATEGY ─────────────────────────────────────────
passport.use(
  new GoogleStrategy(
    {
      clientID: env.google.clientId,
      clientSecret: env.google.clientSecret,
      callbackURL: env.google.callbackUrl,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value
        const avatar = profile.photos?.[0]?.value

        if (!email) {
          return done(null, false, { message: 'Google account mein email nahi mila' })
        }

        const user = await findOrCreateOAuthUser({
          provider: 'google',
          providerId: profile.id,
          name: profile.displayName,
          email,
          avatar,
        })

        return done(null, user)
      } catch (err) {
        return done(err, false)
      }
    }
  )
)

// ─── GITHUB STRATEGY ─────────────────────────────────────────
passport.use(
  new GitHubStrategy(
    {
      clientID: env.github.clientId,
      clientSecret: env.github.clientSecret,
      callbackURL: env.github.callbackUrl,
      scope: ['user:email'],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value
        const avatar = profile.photos?.[0]?.value

        if (!email) {
          return done(null, false, { message: 'GitHub account mein email nahi mila — email public karo' })
        }

        const user = await findOrCreateOAuthUser({
          provider: 'github',
          providerId: String(profile.id),
          name: profile.displayName || profile.username,
          email,
          avatar,
        })

        return done(null, user)
      } catch (err) {
        return done(err, false)
      }
    }
  )
)

// ─── HELPER ──────────────────────────────────────────────────
const findOrCreateOAuthUser = async ({ provider, providerId, name, email, avatar }) => {
  const conn = await pool.getConnection() // ✅ db → pool

  try {
    await conn.beginTransaction()

    const [oauthRows] = await conn.query(
      `SELECT u.* FROM oauth_accounts oa
       JOIN users u ON u.id = oa.user_id
       WHERE oa.provider = ? AND oa.provider_id = ?
       LIMIT 1`,
      [provider, providerId]
    )

    if (oauthRows.length > 0) {
      await conn.commit()
      return { ...oauthRows[0], isNewUser: false }
    }

    const [emailRows] = await conn.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email])

    let userId
    let isNewUser = false

    if (emailRows.length > 0) {
      userId = emailRows[0].id
    } else {
      const [result] = await conn.query(
        `INSERT INTO users (name, email, avatar, oauth_provider, oauth_id, is_verified, is_first_login)
         VALUES (?, ?, ?, ?, ?, 1, 0)`,
        [name, email, avatar, provider, providerId]
      )
      userId = result.insertId
      isNewUser = true
    }

    await conn.query('INSERT INTO oauth_accounts (user_id, provider, provider_id) VALUES (?, ?, ?)', [
      userId,
      provider,
      providerId,
    ])

    const [userRows] = await conn.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId])

    await conn.commit()
    return { ...userRows[0], isNewUser }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release() // ✅ connection pool ko wapas karo
  }
}

export default passport
