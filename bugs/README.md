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
| [BUG-004](./BUG-004-broken-email-obfuscator.md) | Contact page renders literal `[email protected]` instead of an email address | Medium | Public site / UX | Open |
| [BUG-005](./BUG-005-no-mfa-on-login.md) | Login has no 2FA, no phone OTP, no social login — for a money platform | High | Auth / security | Open |
| [BUG-006](./BUG-006-register-country-default.md) | Register country selector defaults to `International` despite Kenya focus | Low | UX / signup conversion | Open |
| [BUG-007](./BUG-007-no-mpesa-integration.md) | M-Pesa integration marked "Coming Soon" — the #1 Kenyan chama requirement | Critical | Core product / revenue | Open → fixed by ChamaPay module |
| [BUG-008](./BUG-008-signin-says-user-created.md) | `POST /users/signin` returns `"message": "User Created"` on every login | High | Auth / API | Open |
| [BUG-009](./BUG-009-merrry-typo-group-types.md) | `MERRRY_GO_AROUND` typo (triple-R, wrong phrase) in both group-types endpoints and the Create Chama dropdown | High | UI + API + data | Open |
| [BUG-010](./BUG-010-duplicate-group-types-endpoints.md) | Two different `group-types` endpoints with inconsistent (swapped) schemas | High | API / data integrity | Open |
| [BUG-011](./BUG-011-websocket-localhost-hardcoded.md) | Notifications page tries to open `ws://localhost:3080` in production — real-time notifications broken | Critical | Real-time / prod config | Open |
| [BUG-012](./BUG-012-get-all-groups-failed-to-fetch.md) | `/admin/chamas` throws `TypeError: Failed to fetch` and shows "create your first chama" on network errors | High | Dashboard / reliability | Open |
| [BUG-013](./BUG-013-jwt-in-response-body.md) | Signin returns the raw JWT in the response body (also in httpOnly cookie) — XSS-to-takeover path | High (security) | Auth / API | Open |
| [BUG-014](./BUG-014-hydration-error-contact.md) | `/contact` throws React error #418 (hydration mismatch) | Medium | Public site | Open |
| [BUG-015](./BUG-015-roles-have-no-permissions.md) | Every role record has `permissions: []` — authz likely enforced by role name only | High (authz) | Backend | Open |

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
