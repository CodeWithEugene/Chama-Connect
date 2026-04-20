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
