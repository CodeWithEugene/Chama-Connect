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
├── .env                        ← login creds to chamaconnect.io (gitignored)
├── .env.example                ← root env template
│
├── recon/                      ← Playwright recon of the live platform
│   ├── tests/explore.spec.ts   ← logs in, crawls dashboard, records every XHR
│   └── artifacts/<timestamp>/  ← screenshots, HTML, network logs per run
│
├── bugs/                       ← bug register (evidence + root cause + fix)
│   ├── README.md               ← index of all tracked issues
│   ├── _template.md            ← filing template
│   └── BUG-NNN-*.md            ← one file per bug
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
    ├── TECHNICAL-PROPOSAL.md   ← the 2-page judges' proposal
    ├── Anchor.sol              ← reference on-chain contract
    └── ARCHITECTURE.md         ← diagrams + data flow
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

In another shell, fire a simulated M-Pesa payment through the real reconciliation engine:

```bash
curl -X POST http://localhost:3100/api/dev/simulate-c2b \
     -H 'content-type: application/json' \
     -d '{"msisdn":"254711223344","amount":500,"billRef":"ACME-202604"}'
```

The dashboard updates within 3 seconds; the payment shows as **matched at 100% confidence** to member *Brian Otieno* for cycle `2026-04`.

Run the test suite:

```bash
npm test
# 6 reconciliation tests pass: exact match, idempotency, MSISDN fallback,
# unmatched path, double-entry balance, mixed-format period parsing.
```

## The headline bug we are solving (BUG-007)

From [chamaconnect.io/features](https://chamaconnect.io/features):

> **M-pesa Blockchain Integration** — M-pesa and bank integration (**Coming Soon**) will enable seamless deposits, withdrawals, and loan repayments.

In Kenya, ~99% of chama money moves on M-Pesa. Without reconciliation, every chama admin still reads their M-Pesa SMS inbox line-by-line and types amounts into the platform manually — which is exactly the mechanism behind [FSD Kenya's documented 13% chama embezzlement rate](https://www.money254.co.ke/post/chama-revolution-what-successful-chamas-know-do-why-many-fail).

We built the fix. See [docs/TECHNICAL-PROPOSAL.md](docs/TECHNICAL-PROPOSAL.md) for the full write-up.

## Other bugs we found on the live site

See [bugs/README.md](bugs/README.md) for the full, up-to-date register. Highlights:

- **BUG-001** — every public page ships with `<title>Create Next App</title>` (default Next.js boilerplate). Kills SEO and WhatsApp/social link previews.
- **BUG-002** — Footer links `Features / Pricing / Resources / Blog / Community / Events` all point to `#`.
- **BUG-003** — contact phone number is inconsistent across the site and the hackathon brief (three different numbers).
- **BUG-004** — `/contact` page renders literal `[email protected]` (broken Cloudflare obfuscator).
- **BUG-005** — login lacks phone-OTP / 2FA / social sign-in *exposed in UI* (server-side `requires2FA` flag exists but no flow to trigger it).
- **BUG-006** — register country selector defaults to `International` despite Kenya-first product.
- **Typo** — group-types API returns `MERRRY_GO_AROUND` (triple R, plus "around" instead of "round").

Each bug has a dedicated file with evidence, root cause, and a minimum-viable fix diff.

## Reproducing the authenticated recon

Login creds live in `./.env` (gitignored). The Playwright recon logs in, crawls every authenticated route, screenshots each, records every XHR, and dumps JSON to `recon/artifacts/<timestamp>/`:

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

We ship these artifacts with the submission so judges can verify our bug claims independently.

## License

MIT. See [LICENSE](LICENSE).
