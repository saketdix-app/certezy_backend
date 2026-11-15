# Lead integrations — setup guide (2.0 Phase 7)

New leads from ads and forms arrive in the CRM automatically, go through the
same duplicate checks, and are shared out by Round Robin.

**Where the keys go:** a Super Admin pastes them into **Admin → Integrations**
(each card → *Keys*), confirms with their password, then presses *Test
connection* and switches the source on. Keys are encrypted in the database,
never shown again (only "Saved"), audit-logged by name, and the other Super
Admins get an email. No restart needed (the background worker picks changes
up within a minute).

The `.env` names below still work as a fallback; a key saved in the portal
takes priority, and removing it in the portal falls back to `.env`.
Optional: set `SECRETS_ENCRYPTION_KEY` (`openssl rand -base64 32`) in `.env`
before saving keys. Without it the encryption key is derived from
`JWT_SECRET`, so changing `JWT_SECRET` later means re-entering the keys.

## Website contact form
Already on. Every Contact Us message also becomes a lead (source: Website).

## Meta (Facebook & Instagram lead forms)
You need: a Facebook Page running lead-form ads, and admin access to a Meta
Business account.

1. **Create an app** — <https://developers.facebook.com/apps> → Create app →
   type **Business** → connect your Business account.
2. **App secret** — App settings → Basic → *App secret* → copy into
   `META_APP_SECRET`.
3. **Verify token** — make up a long random string (e.g. from a password
   manager) and put it in `META_VERIFY_TOKEN`. Restart the backend.
4. **Webhook** — in the app, add the **Webhooks** product → choose
   **Page** → *Subscribe to this object*:
   - Callback URL: `https://certezy.com/api/v1/webhooks/meta`
     (also shown on Admin → Integrations)
   - Verify token: the same string as `META_VERIFY_TOKEN`
   - Then subscribe to the **leadgen** field.
5. **Page access token** — create a System User in Business Settings with
   access to the Page and the app, generate a token with the permissions
   `leads_retrieval`, `pages_manage_metadata`, `pages_show_list`,
   `pages_read_engagement`, `ads_management` → `META_PAGE_ACCESS_TOKEN`.
   (System-user tokens don't expire; personal tokens do.)
6. **Subscribe the Page to the app** (once): Graph API Explorer →
   `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen` with the Page token.
7. **App review / Live mode** — `leads_retrieval` needs Advanced Access;
   switch the app to Live.
8. **Test** — <https://developers.facebook.com/tools/lead-ads-testing> →
   create a test lead → it appears in Admin → Leads within seconds and in
   Admin → Integrations → Recent imports.
9. In Admin → Integrations → Meta, map each **form ID** to its course.

## LinkedIn Lead Gen Forms
You need: a LinkedIn Campaign Manager ad account with lead-gen campaigns.

1. **Create an app** — <https://www.linkedin.com/developers/apps>, verified
   by your Company Page.
2. **Request access** to the **Lead Sync API** (Products tab). LinkedIn
   reviews this; it can take a few days.
3. **Client secret** — Auth tab → `LINKEDIN_CLIENT_SECRET`.
4. **Access token** — generate an OAuth token with `r_marketing_leadgen_automation`
   (and `r_ads`) for a user who can see the ad account →
   `LINKEDIN_ACCESS_TOKEN`. LinkedIn tokens last 60 days — set a reminder
   to refresh it (Admin → Integrations shows an error when it expires).
5. **Ad account ID** — Campaign Manager → the number in the account URL →
   `LINKEDIN_AD_ACCOUNT_ID`.
6. Restart the backend, switch LinkedIn on, press **Sync now**. After that it
   checks every 10 minutes.
7. Optional, faster: if LinkedIn enables lead notifications (webhooks) for
   your app, set the webhook URL to
   `https://certezy.com/api/v1/webhooks/linkedin`; each notification
   triggers an immediate sync.

LinkedIn's response format is versioned (`LINKEDIN_API_VERSION`, default
202411). The field mapping follows LinkedIn's documentation; check the first
real leads after connecting and tell the developer if any field is empty.

## WhatsApp (Cloud API) — 2.0 Phase 8
You need: a WhatsApp Business account on Meta's Cloud API with a phone number
(it can't be the number you use in the WhatsApp app at the same time), and
approved message templates for writing to people first.

1. In the same Meta app (or a new Business app), add the **WhatsApp** product
   and connect your WhatsApp Business account and phone number.
2. **Phone number ID** and **WhatsApp Business Account ID** — WhatsApp → API
   Setup → `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`.
3. **Token** — a System User token with `whatsapp_business_messaging` and
   `whatsapp_business_management` → `WHATSAPP_TOKEN`.
4. **Verify token** — any random string → `WHATSAPP_VERIFY_TOKEN`.
   (Webhooks are checked with the app secret: `META_APP_SECRET`, or
   `WHATSAPP_APP_SECRET` if WhatsApp uses a different app.) Restart.
5. **Webhook** — WhatsApp → Configuration → Callback URL
   `https://certezy.com/api/v1/webhooks/whatsapp`, the verify token, then
   subscribe to **messages**.
6. **Templates** — create and get approved (e.g. a follow-up and a payment
   reminder) in WhatsApp Manager. Only approved templates can be sent when
   the person hasn't written in the last 24 hours (WhatsApp's rule).
7. Switch WhatsApp on in Admin → Integrations. Messages from new numbers
   become leads (source WhatsApp); messages from existing leads appear on
   their WhatsApp thread, and the consultant is notified.

## Automations — 2.0 Phase 8
On by default; switch each off in Admin → Integrations → Automations.
- Paid sale → the lead moves to **Application** (if it was earlier).
- Course completed → the lead moves to **Course Done**.
- Checkout started but unpaid after 1 hour → the consultant is told once.
- Follow-up due within 15 minutes → the consultant is reminded once.

## When something goes wrong
- **Admin → Integrations** shows the last error per source and every
  import. Failed imports retry automatically 5 times (over ~15 minutes),
  then wait for **Retry**.
- A person who is already a lead is not duplicated — the new enquiry is added
  to their timeline and their consultant is notified.
- Leads with neither phone nor email are marked failed (nothing to contact).
