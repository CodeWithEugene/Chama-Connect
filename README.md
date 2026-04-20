<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# ChamaConnect Hackathon Submission — ChamaPay

**Entry for:** MUIAA Ltd × Salamander Community — ChamaConnect Virtual Hackathon  
**Theme:** Reimagining Digital Chamas for the Future  
**Deadline:** Friday, 2026-04-24 at 23:59 EAT  
**Entrant:** Eugene Mutembei (`eugenegabriel.ke@gmail.com`) & Sidney Muriuki (`sidneybarakamuriuki1@gmail.com`)

> **What we built:** an M-Pesa-native contribution auto-reconciliation module that closes the single biggest gap [chamaconnect.io](https://chamaconnect.io) has today — the feature its own features page marks **"Coming Soon."** Drop-in Next.js, double-entry ledger, idempotent Daraja callbacks, USSD access for feature phones, on-chain anchoring of daily settlements.

---

## Repository layout

```
Chama-Connect/
├── README.md                   ← you are here
├── CONTRIBUTING.md             ← how to contribute, PR checks, bug workflow
├── LICENSE
├── .env                        ← login creds to chamaconnect.io (gitignored)
├── .env.example                ← root env template (recon)
│
├── recon/                      ← Playwright recon of the live platform
│   ├── tests/explore.spec.ts   ← logs in, crawls dashboard, records every XHR
│   └── artifacts/<timestamp>/  ← screenshots, HTML, network logs per run
│
├── bugs/                       ← bug register (evidence + root cause + fix)
│   ├── README.md               ← index + severity scale
│   ├── _template.md            ← filing template
│   └── BUG-NNN-*.md            ← one file per bug (001–043 today)
│
├── chamapay/                   ← the deliverable (standalone Next.js app)
│   ├── src/
│   │   ├── app/                ← Next.js App Router: UI + API routes
│   │   │   ├── chamas/[code]/  ← live dashboard
│   │   │   └── api/mpesa/...   ← Daraja webhooks
│   │   ├── lib/
│   │   │   ├── daraja/         ← STK Push, C2B register, B2C, TxStatus
│   │   │   ├── reconciliation/ ← deterministic matching engine + tests
│   │   │   ├── anchor/         ← Merkle tree + Base Sepolia anchor CLI
│   │   │   ├── sms/            ← async outbox
│   │   │   └── db/             ← SQLite schema, migrate, seed
│   │   └── ...
│   ├── var/chamapay.sqlite     ← local DB (created by migrate)
│   └── .env.example
│
└── docs/
    ├── TECHNICAL-PROPOSAL.md   ← judges' technical write-up
    ├── DEMO.md                 ← 90-second demo script
    └── Anchor.sol              ← reference on-chain contract
```

## Quick start — see it run in 90 seconds

```bash
git clone <this-repo>
cd Chama-Connect/chamapay
cp .env.example .env.local       # Daraja creds optional for local demo
npm install
npm run db:migrate && npm run db:seed
npm run dev                      # http://localhost:3100
```

Open [http://localhost:3100/chamas/ACME](http://localhost:3100/chamas/ACME).

Step-by-step narration for judges: [docs/DEMO.md](docs/DEMO.md).

In another shell, fire a simulated M-Pesa payment through the real reconciliation engine:

```bash
curl -X POST http://localhost:3100/api/dev/simulate-c2b \
     -H 'content-type: application/json' \
     -d '{"msisdn":"254711223344","amount":500,"billRef":"ACME-202604"}'
```

The dashboard updates within a few seconds; the payment shows as **matched at 100% confidence** to member *Brian Otieno* for cycle `2026-04`.

Run the test suite:

```bash
npm test
# 6 reconciliation tests: exact match, idempotency, MSISDN fallback,
# unmatched path, double-entry balance, mixed-format period parsing.
```

## The headline bug we are solving (BUG-007)

From [chamaconnect.io/features](https://chamaconnect.io/features):

> **M-pesa Blockchain Integration** — M-pesa and bank integration (**Coming Soon**) will enable seamless deposits, withdrawals, and loan repayments.

In Kenya, ~99% of chama money moves on M-Pesa. Without reconciliation, every chama admin still reads their M-Pesa SMS inbox line-by-line and types amounts into the platform manually — which is exactly the mechanism behind [FSD Kenya's documented 13% chama embezzlement rate](https://www.money254.co.ke/post/chama-revolution-what-successful-chamas-know-do-why-many-fail).

We built the fix in this repo. See [docs/TECHNICAL-PROPOSAL.md](docs/TECHNICAL-PROPOSAL.md) for the full write-up.

## Bugs identified on the live site (chamaconnect.io)

Each row links to a standalone report (evidence, impact, root cause, proposed fix, verification). The canonical index and filing workflow live in [bugs/README.md](bugs/README.md).

| ID | Title | Severity | Status |
|:---:|---|:---:|:---:|
| [BUG-001](bugs/BUG-001-default-nextjs-metadata.md) | Every public page ships with default Next.js boilerplate `<title>` + `<meta description>` | High | Open |
| [BUG-002](bugs/BUG-002-broken-footer-links.md) | Footer `Features`, `Pricing`, `Resources`, `Blog`, `Community`, `Events` all point to `#` | Medium | Open |
| [BUG-003](bugs/BUG-003-inconsistent-contact-phone.md) | Contact page phone number does not match footer / hackathon-brief contact number | Medium | Open |
| [BUG-004](bugs/BUG-004-broken-email-obfuscator.md) | Contact page renders literal `[email protected]` instead of an email address | Medium | Fixed (2026-04-20) |
| [BUG-005](bugs/BUG-005-no-mfa-on-login.md) | Login has no 2FA, no phone OTP, no social login — for a money platform | High | Open |
| [BUG-006](bugs/BUG-006-register-country-default.md) | Register country selector defaults to `International` despite Kenya focus | Low | Open |
| [BUG-007](bugs/BUG-007-no-mpesa-integration.md) | M-Pesa integration marked "Coming Soon" — the #1 Kenyan chama requirement | Critical | Open → fixed by ChamaPay module |
| [BUG-008](bugs/BUG-008-signin-says-user-created.md) | `POST /users/signin` returns `"message": "User Created"` on every login | High | Open |
| [BUG-009](bugs/BUG-009-merrry-typo-group-types.md) | `MERRRY_GO_AROUND` typo (triple-R, wrong phrase) in group-types endpoints and Create Chama dropdown | High | Open |
| [BUG-010](bugs/BUG-010-duplicate-group-types-endpoints.md) | Two different `group-types` endpoints with inconsistent (swapped) schemas | High | Open |
| [BUG-011](bugs/BUG-011-websocket-localhost-hardcoded.md) | Notifications page opens `ws://localhost:3080` in production — real-time notifications broken | Critical | Open |
| [BUG-012](bugs/BUG-012-get-all-groups-failed-to-fetch.md) | `/admin/chamas` throws `TypeError: Failed to fetch` and shows "create your first chama" on network errors | High | Open |
| [BUG-013](bugs/BUG-013-jwt-in-response-body.md) | Signin returns the raw JWT in the response body (also in httpOnly cookie) — XSS-to-takeover path | High | Open |
| [BUG-014](bugs/BUG-014-hydration-error-contact.md) | `/contact` throws React error #418 (hydration mismatch) | Medium | Open (not reproduced 2026-04-20) |
| [BUG-015](bugs/BUG-015-roles-have-no-permissions.md) | Every role record has `permissions: []` — authz likely enforced by role name only | High | Open |
| [BUG-016](bugs/BUG-016-jwt-has-no-expiration.md) | Signin JWT has no `exp`/`nbf`/`jti`/`iss`/`aud` — tokens never expire, can't be revoked | Critical | Open |
| [BUG-017](bugs/BUG-017-missing-security-headers.md) | No `Content-Security-Policy`; HTML documents ship without HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy | High | Open |
| [BUG-018](bugs/BUG-018-weak-signin-rate-limit.md) | Signin rate limit is 1000 req / 15 min per IP, no per-account lockout — brute-force viable | High | Open |
| [BUG-019](bugs/BUG-019-auth-token-401-on-public-pages.md) | `/api/auth/token` returns **401** on every public page load (should be 200 with `{token:null}`) | Medium | Open |
| [BUG-020](bugs/BUG-020-double-space-current-user-message.md) | `/api/proxy/users/current-user` message says `"Successfully  retrieved logged in user"` (double space) | Low | Open |
| [BUG-021](bugs/BUG-021-roles-endpoint-missing-permissions.md) | `/api/proxy/roles` omits `permissions`; `/users/current-user.role` includes `permissions:[]` — same resource, two shapes | Medium | Open |
| [BUG-022](bugs/BUG-022-login-form-missing-name-autocomplete.md) | Login form inputs have no `name` and no `autocomplete` — password managers break, WCAG 1.3.5 fails | Medium | Open |
| [BUG-023](bugs/BUG-023-contact-form-unlabeled-inputs.md) | `/contact` "Send Us a Message" inputs have no `name`, no `id`, no `aria-label` | Medium | Open |
| [BUG-024](bugs/BUG-024-multiple-h1-on-public-pages.md) | `/about` has 3 `<h1>` tags; `/contact` and `/faqs` each have 2 — SEO + a11y | Low | Open |
| [BUG-025](bugs/BUG-025-admin-pages-create-next-app-title.md) | Every admin/dashboard page ships with `<title>Create Next App</title>` — tab labels unusable | Medium | Open |
| [BUG-026](bugs/BUG-026-x-powered-by-leaks-stack.md) | `X-Powered-By: Next.js` + `x-nextjs-*` headers leak backend stack on every HTML response | Low | Open |
| [BUG-027](bugs/BUG-027-settings-writable-by-any-user.md) | **Any authenticated `User` can `PUT /api/proxy/settings/:id` — platform-wide fees and likely M-Pesa callback URLs are attacker-controlled** | **Critical** | Open |
| [BUG-028](bugs/BUG-028-mpesa-credentials-leak.md) | **`GET /api/proxy/settings` returns M-Pesa Daraja `ConsumerKey` / `ConsumerSecret` / `LipaNaMpesaShortPass` to every signed-in user** | **Critical** | Open |
| [BUG-029](bugs/BUG-029-bola-groups-by-id.md) | **BOLA: `GET /api/proxy/groups/:id` returns any chama's full data + members' PII (names, emails, phones) to any authenticated user** | **Critical** | Open |
| [BUG-030](bugs/BUG-030-bola-transactions-list.md) | **BOLA: `GET /api/proxy/transactions` returns every chama's transactions (amounts, approvals, crypto hashes) to every signed-in user** | **Critical** | Open |
| [BUG-031](bugs/BUG-031-signin-account-enumeration.md) | Signin reveals which emails/phones are registered (differential error + size + timing) | High | Open |
| [BUG-032](bugs/BUG-032-signup-email-enumeration.md) | Signup leaks registration status via `"Error creating user…"` on existing emails | High | Open |
| [BUG-033](bugs/BUG-033-backend-directly-exposed.md) | Internal backend reachable from the internet at `/backend/api/v1/*` — doubles attack surface | High | Open |
| [BUG-034](bugs/BUG-034-password-reset-no-rate-limit.md) | `/api/proxy/users/request-password-reset` has no per-account rate limit — mail bombing + SMS cost attack | High | Open |
| [BUG-035](bugs/BUG-035-permissions-endpoint-wrong.md) | `GET /api/proxy/permissions` returns `201 Created` with a role-list payload (routing + status bug) | Medium | Open |
| [BUG-036](bugs/BUG-036-notifications-all-500.md) | `GET /api/proxy/notifications/all` returns `500 Internal Server Error` on every call | Medium | Open |
| [BUG-037](bugs/BUG-037-authz-returns-400-not-403.md) | Authorization failures return `400 Bad Request` instead of `401`/`403` across signin + group + user endpoints | Medium | Open |
| [BUG-038](bugs/BUG-038-signup-contradictory-fields.md) | Signup response contradictory status fields (`isActive:false` + `accountStatus:"ACTIVE"` + `activatedAt` populated) | Medium | Open |
| [BUG-039](bugs/BUG-039-nosql-object-inputs-crash-signin.md) | Signin/password-reset accept MongoDB operator objects → `500` crash (latent NoSQL injection) | High | Open |
| [BUG-040](bugs/BUG-040-roles-crud-by-any-user.md) | **Any `User` can `POST /api/proxy/roles` (create roles) + `PATCH /api/proxy/roles/:id` (rename `SuperAdmin`)** | **Critical** | Open |
| [BUG-041](bugs/BUG-041-transactions-idor-userid-filter.md) | **`GET /api/proxy/transactions?userId=<victim>` returns that user's full financial history (IDOR); no pagination** | **Critical** | Open |
| [BUG-042](bugs/BUG-042-group-delete-leaks-mpesa-keys.md) | **`DELETE /api/proxy/groups/:id` response embeds full M-Pesa Daraja credentials in `GroupSettings`** | **Critical** | Open |
| [BUG-043](bugs/BUG-043-notifications-post-500.md) | `POST /api/proxy/notifications` returns `500` on every call; no role guard | Medium | Open |

**Severity (short):** Critical → core job blocked **or** security-critical data exposure/modification; High → trust, security, or major product surface; Medium → clear UX or consistency break; Low → polish / conversion nits.

## Reproducing the authenticated recon

Login creds live in `./.env` at the repo root (gitignored). Copy from [.env.example](.env.example). The Playwright recon logs in, crawls every authenticated route, screenshots each, records every XHR, and dumps JSON to `recon/artifacts/<timestamp>/`:

```bash
cd recon
npm install
npx playwright install chromium
npm test
```

Every run produces:

- `screenshots/` — full-page screenshots of every route visited  
- `html/` — full rendered HTML of every route  
- `network/requests.json` — every XHR / fetch / document with request + response body  
- `summary.json` — one-line overview  

Large artifact trees stay gitignored; retain representative runs for submission evidence if needed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup in `chamapay/` and `recon/`, commands to run before a PR (`lint`, `typecheck`, `test`, `build`), and how to file new bugs under `bugs/`.

## License

MIT. See [LICENSE](LICENSE).
