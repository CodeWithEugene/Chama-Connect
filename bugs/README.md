<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# ChamaConnect Bug Register

This directory is the authoritative log of issues discovered on [chamaconnect.io](https://chamaconnect.io) during the MUIAA x Salamander ChamaConnect Virtual Hackathon (deadline **2026-04-24**).

Each issue lives in its own file as `BUG-NNN-slug.md` and contains:

1. **Evidence** — where we observed it (URL, screenshot path, request/response if applicable).
2. **Severity** — Critical / High / Medium / Low.
3. **User impact** — what breaks for a real chama admin or member.
4. **Root cause** — what in the code is likely wrong.
5. **Proposed fix** — the smallest diff that resolves it, with code.
6. **Verification** — how to prove the fix works.

Update this index when a new bug is filed.

## Index

| ID | Title | Severity | Surface | Status |
|---|---|---|---|---|
| [BUG-001](./BUG-001-default-nextjs-metadata.md) | Every public page ships with default Next.js boilerplate `<title>` + `<meta description>` | High | Public site / SEO | Open |
| [BUG-002](./BUG-002-broken-footer-links.md) | Footer `Features`, `Pricing`, `Resources`, `Blog`, `Community`, `Events` all point to `#` | Medium | Public site / UX | Open |
| [BUG-003](./BUG-003-inconsistent-contact-phone.md) | Contact page phone number does not match footer / hackathon-brief contact number | Medium | Public site / trust | Open |
| [BUG-004](./BUG-004-broken-email-obfuscator.md) | Contact page renders literal `[email protected]` instead of an email address | Medium | Public site / UX | Fixed (2026-04-20) |
| [BUG-005](./BUG-005-no-mfa-on-login.md) | Login has no 2FA, no phone OTP, no social login — for a money platform | High | Auth / security | Open |
| [BUG-006](./BUG-006-register-country-default.md) | Register country selector defaults to `International` despite Kenya focus | Low | UX / signup conversion | Open |
| [BUG-007](./BUG-007-no-mpesa-integration.md) | M-Pesa integration marked "Coming Soon" — the #1 Kenyan chama requirement | Critical | Core product / revenue | Open → fixed by ChamaPay module |
| [BUG-008](./BUG-008-signin-says-user-created.md) | `POST /users/signin` returns `"message": "User Created"` on every login | High | Auth / API | Open |
| [BUG-009](./BUG-009-merrry-typo-group-types.md) | `MERRRY_GO_AROUND` typo (triple-R, wrong phrase) in both group-types endpoints and the Create Chama dropdown | High | UI + API + data | Open |
| [BUG-010](./BUG-010-duplicate-group-types-endpoints.md) | Two different `group-types` endpoints with inconsistent (swapped) schemas | High | API / data integrity | Open |
| [BUG-011](./BUG-011-websocket-localhost-hardcoded.md) | Notifications page tries to open `ws://localhost:3080` in production — real-time notifications broken | Critical | Real-time / prod config | Open |
| [BUG-012](./BUG-012-get-all-groups-failed-to-fetch.md) | `/admin/chamas` throws `TypeError: Failed to fetch` and shows "create your first chama" on network errors | High | Dashboard / reliability | Open |
| [BUG-013](./BUG-013-jwt-in-response-body.md) | Signin returns the raw JWT in the response body (also in httpOnly cookie) — XSS-to-takeover path | High (security) | Auth / API | Open |
| [BUG-014](./BUG-014-hydration-error-contact.md) | `/contact` throws React error #418 (hydration mismatch) | Medium | Public site | Open (not reproduced 2026-04-20) |
| [BUG-015](./BUG-015-roles-have-no-permissions.md) | Every role record has `permissions: []` — authz likely enforced by role name only | High (authz) | Backend | Open |
| [BUG-016](./BUG-016-jwt-has-no-expiration.md) | Signin JWT has no `exp`/`nbf`/`jti`/`iss`/`aud` — tokens never expire, can't be revoked | Critical (security) | Auth / API | Open |
| [BUG-017](./BUG-017-missing-security-headers.md) | No `Content-Security-Policy`; HTML documents missing HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy | High (security) | Every HTML response | Open |
| [BUG-018](./BUG-018-weak-signin-rate-limit.md) | Signin rate limit is 1000 req / 15 min per IP, no per-account lockout — brute-force viable | High (security) | Auth / API | Open |
| [BUG-019](./BUG-019-auth-token-401-on-public-pages.md) | `/api/auth/token` returns **401** on every public page load (should be 200 with `{token:null}`) | Medium | Public site / API | Open |
| [BUG-020](./BUG-020-double-space-current-user-message.md) | `/api/proxy/users/current-user` returns message `"Successfully  retrieved logged in user"` (double space) | Low | API / copy | Open |
| [BUG-021](./BUG-021-roles-endpoint-missing-permissions.md) | `/api/proxy/roles` omits `permissions`; `/users/current-user.role` includes `permissions:[]` — same resource, two shapes | Medium | API contract | Open |
| [BUG-022](./BUG-022-login-form-missing-name-autocomplete.md) | Login form inputs have no `name` and no `autocomplete` — password managers break, WCAG 1.3.5 fails | Medium | Auth / UX / a11y | Open |
| [BUG-023](./BUG-023-contact-form-unlabeled-inputs.md) | `/contact` "Send Us a Message" inputs have no `name`, no `id`, no `aria-label` | Medium | Public site / a11y | Open |
| [BUG-024](./BUG-024-multiple-h1-on-public-pages.md) | `/about` has 3 `<h1>` tags; `/contact` and `/faqs` each have 2 — SEO + a11y | Low | Public site / SEO | Open |
| [BUG-025](./BUG-025-admin-pages-create-next-app-title.md) | Every admin/dashboard page ships with `<title>Create Next App</title>` | Medium | Admin / UX | Open |
| [BUG-026](./BUG-026-x-powered-by-leaks-stack.md) | `X-Powered-By: Next.js` + `x-nextjs-*` headers leak backend stack on every HTML response | Low (security) | Every HTML response | Open |
| [BUG-027](./BUG-027-settings-writable-by-any-user.md) | **Any authenticated `User` can `PUT /api/proxy/settings/:id` — platform-wide `loanFee`, `withDrawalFee`, `fineDelayPercentageIncrement` (and likely M-Pesa callback URLs) are attacker-controlled** | **Critical** | API / authz | Open |
| [BUG-028](./BUG-028-mpesa-credentials-leak.md) | **`GET /api/proxy/settings` returns M-Pesa Daraja `ConsumerKey` / `ConsumerSecret` / `LipaNaMpesaShortPass` + all C2B/B2C/B2B callback URLs to every signed-in user** | **Critical** | API / secrets | Open |
| [BUG-029](./BUG-029-bola-groups-by-id.md) | **BOLA: `GET /api/proxy/groups/:id` returns any chama's full data (members' names, emails, phones, blockchain address, schedule) to any authenticated user** | **Critical** | API / authz / PII | Open |
| [BUG-030](./BUG-030-bola-transactions-list.md) | **BOLA: `GET /api/proxy/transactions` returns every chama's transactions (amounts, approvals, crypto hashes) to every signed-in user** | **Critical** | API / authz | Open |
| [BUG-031](./BUG-031-signin-account-enumeration.md) | Signin reveals which emails/phones are registered (`"Incorrect password"` vs `"Invalid email or phone number"` + 22-byte size + ~500 ms timing delta) | High (security) | Auth / API | Open |
| [BUG-032](./BUG-032-signup-email-enumeration.md) | Signup leaks registration status via differential error (`"Error creating user…"` fires only on already-registered email) | High (security) | Auth / API | Open |
| [BUG-033](./BUG-033-backend-directly-exposed.md) | Internal backend reachable from the internet at `/backend/api/v1/*` — doubles the attack surface and bypasses any future proxy-layer mitigations | High (security) | Infrastructure | Open |
| [BUG-034](./BUG-034-password-reset-no-rate-limit.md) | `/api/proxy/users/request-password-reset` has no per-account rate limit — enables mail bombing, SMS-cost attack, and OTP brute-force prep | High | Auth / API | Open |
| [BUG-035](./BUG-035-permissions-endpoint-wrong.md) | `GET /api/proxy/permissions` returns `201 Created` with an empty role-list payload (routing bug + status-code misuse) | Medium | API | Open |
| [BUG-036](./BUG-036-notifications-all-500.md) | `GET /api/proxy/notifications/all` returns `500 Internal Server Error` on every call | Medium | API / stability | Open |
| [BUG-037](./BUG-037-authz-returns-400-not-403.md) | Authorization failures return `400 Bad Request` (should be `401`/`403`) across signin, group PATCH/DELETE, user DELETE | Medium | API / REST semantics | Open |
| [BUG-038](./BUG-038-signup-contradictory-fields.md) | Signup response contains contradictory status fields (`isActive:false` + `accountStatus:"ACTIVE"` + `activatedAt` populated) | Medium | Data model | Open |
| [BUG-039](./BUG-039-nosql-object-inputs-crash-signin.md) | Signin/password-reset accept object-valued `email`/`password` (MongoDB operators) and return `500` — latent NoSQL injection surface | High | Auth / API | Open |
| [BUG-040](./BUG-040-roles-crud-by-any-user.md) | **Any authenticated `User` can `POST /api/proxy/roles` (create roles) and `PATCH /api/proxy/roles/:id` (rename/modify ANY role, including `SuperAdmin`)** | **Critical** | API / authz | Open |
| [BUG-041](./BUG-041-transactions-idor-userid-filter.md) | **`GET /api/proxy/transactions?userId=<other>` returns another user's full transaction history (IDOR); no server-side pagination** | **Critical** | API / authz | Open |
| [BUG-042](./BUG-042-group-delete-leaks-mpesa-keys.md) | **`DELETE /api/proxy/groups/:id` response embeds full M-Pesa Daraja credentials in `GroupSettings` — a second exfiltration path independent of BUG-028** | **Critical** | API / secrets | Open |
| [BUG-043](./BUG-043-notifications-post-500.md) | `POST /api/proxy/notifications` returns `500 Internal Server Error` on every call; no role guard means any user could reach the broken create-notification handler | Medium | API / stability | Open |
| [BUG-044](./BUG-044-path-traversal-api-routes.md) | **Path traversal: `GET /api/proxy/groups/../settings` resolves to `/api/proxy/settings`, bypassing route guards — all 10+ cross-path combinations confirmed working including M-Pesa credential exfiltration** | **Critical** | API / routing | Open |
| [BUG-045](./BUG-045-cors-localhost-credentialed.md) | CORS misconfiguration: `localhost:3000` receives `Access-Control-Allow-Origin: http://localhost:3000, https://chamaconnect.io` + duplicate `ACAC: true, true` — any localhost JS context can make credentialed cross-origin requests | High | API / headers | Open |
| [BUG-046](./BUG-046-no-server-side-token-revocation.md) | JWT not invalidated on logout: `DELETE /api/auth/session` clears the cookie but the Bearer token remains valid indefinitely (confirmed `200` after "logout") — no revocation mechanism exists | High | Auth / session management | Open |
| [BUG-047](./BUG-047-otp-brute-force-no-lockout.md) | Password-reset OTP brute force: 15+ attempts accepted without lockout or `429`, combined with BUG-034 (no reset rate limit) enables full account takeover | High | Auth / API | Open |
| [BUG-048](./BUG-048-approve-null-ref-undefined-role.md) | Transaction approval endpoint leaks internal state: `"Only undefined can approve this transaction"` (null dereference); rejection endpoint returns `500` even when reason is provided | Medium | API / stability | Open |
| [BUG-049](./BUG-049-groups-types-routing-500.md) | `GET /api/proxy/groups/types` and `/groups/group-types` return `500` — routing collision where `"types"` is passed as a Mongoose ObjectId | Medium | API / routing | Open |
| [BUG-050](./BUG-050-stored-xss-group-name.md) | Stored XSS: group name accepts raw HTML including `<script>` tags without any sanitization — payload persists in DB, returned in API responses, exploitable in email/PDF/SSR contexts | High | API / input validation | Open |
| [BUG-051](./BUG-051-roles-routing-collision-500.md) | `GET /api/proxy/roles/permissions` and `/roles/assign` return `500` — same routing collision pattern as BUG-049 | Medium | API / routing | Open |
| [BUG-052](./BUG-052-notifications-routing-500.md) | `GET /api/proxy/notifications/mark-all-read`, `/clear`, `/all` return `500` (routing collision + unimplemented handler); `clear` broken on all methods | Medium | API / routing | Open |
| [BUG-053](./BUG-053-bola-group-member-role-patch.md) | **BOLA: `PATCH /api/proxy/groups/:id/members/:memberId` — any authenticated user can change the role of ANY member in ANY chama (confirmed on multiple real members)** | **Critical** | API / authz | Open |
| [BUG-054](./BUG-054-mpesa-callback-no-auth.md) | **M-Pesa STK callback endpoint publicly accessible with no auth, no IP allowlist, no Safaricom signature — forged success callbacks accepted, enabling fake contribution credits** | **Critical** | API / M-Pesa / financial | Open |
| [BUG-055](./BUG-055-transactions-limit-bypass-all-data.md) | `?limit=99999` dumps all 29 platform transactions from 7 chamas and 11 users in one request — no server-side pagination cap (amplifies BUG-030) | High | API | Open |
| [BUG-056](./BUG-056-nan-infinity-crashes-api.md) | `NaN` / `Infinity` / `-Infinity` in any numeric field crashes the handler with `500 Internal Server Error` — DoS viable | Medium | API / input validation | Open |
| [BUG-057](./BUG-057-withdrawal-fee-field-name-inconsistency.md) | `withDrawalFee` (capital D) field name inconsistency causes silent update failure; sending the canonical name via PUT can null the field | Medium | API / data model | Open |

## Severity scale

- **Critical** — a real user cannot achieve the core job of the product (e.g. collecting contributions).
- **High** — core trust/security/SEO issue visible to everyone.
- **Medium** — noticeable inconsistency or dead UX.
- **Low** — cosmetic / polish.

## Workflow

1. Discover a bug (manual or via `/recon` Playwright run).
2. Create `BUG-NNN-slug.md` using [`_template.md`](./_template.md).
3. Add a row to the table above.
4. Write a failing test (if feasible) in `/recon/tests`.
5. Ship the fix in `/chamapay` (or as a patch in `/bugs/patches/BUG-NNN.patch`).
6. Flip status to **Fixed** and link the PR / commit.
