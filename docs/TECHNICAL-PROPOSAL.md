<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# ChamaPay — Technical Proposal

**Event:** MUIAA Ltd × Salamander Community — ChamaConnect Virtual Hackathon
**Theme:** Reimagining Digital Chamas for the Future
**Deadline:** 2026-04-24 · **Submitted by:** Eugene Mutembei

---

## 1. The problem we chose

[chamaconnect.io](https://chamaconnect.io) is a strong MVP. Its features page, its pricing, and its team page all read like a platform that has thought carefully about the Kenyan chama space. But on that same features page, the platform's authors have written the single most consequential line on the whole site:

> **M-pesa and bank integration (Coming Soon) will enable seamless deposits, withdrawals, and loan repayments.**

In Kenya, that is not a *"Coming Soon"* — that is the product. ~99% of chama money moves through M-Pesa. Without M-Pesa reconciliation, every other ChamaConnect feature (contribution tracking, loan management, reports, dashboards) still requires a treasurer to manually type M-Pesa statement lines into the system. That manual step is exactly the mechanism behind the ~13% embezzlement rate FSD Kenya reports across Kenyan chamas: the treasurer, not the protocol, is the source of truth for what arrived.

Close that one gap and ChamaConnect becomes the product its marketing already describes. That is what ChamaPay does.

## 2. What we built

**ChamaPay** is a drop-in Next.js 15 module that fits ChamaConnect's existing stack (Next 15 / React 19 / TypeScript / Tailwind / dark-default) and adds three capabilities:

### 2.1 M-Pesa Daraja auto-reconciliation (core)

- **STK Push** from the web UI and from USSD — member taps a button / dials a menu and their handset rings for M-Pesa PIN.
- **C2B Paybill confirmation** — when a member pays from their own M-Pesa app, Safaricom POSTs the confirmation to our webhook, which runs a deterministic matching engine to resolve the correct `(chama, member, cycle)` triple and writes a double-entry ledger pair in a single transaction.
- **B2C payouts** — loan disbursements go directly from the chama paybill to the borrower's phone.
- **Transaction Status fallback** — a 2-minute sweeper queries Daraja whenever a callback never arrived (mobile network outages are common).
- **Idempotency** — every row is keyed on the Daraja `TransactionID` so a replayed callback never double-credits.
- **Admin review queue** — anything the engine cannot match with ≥ 0.65 confidence lands in a dedicated queue, never the main ledger.

### 2.2 USSD access via Africa's Talking (stretch)

A `*384*12345#` menu that mirrors the web UI for feature-phone members: balance, contribute (initiates STK), request loan, recent payments. In Kenya this is not a nice-to-have — millions of chama members are on feature phones, and the platform's current web-only stance excludes them.

### 2.3 On-chain receipts (stretch)

Every night, we compute a Merkle root over that day's matched contributions and anchor it to Base Sepolia (swap to Polygon / Base mainnet with one env var change). Each member's contribution receipt includes a verification URL: feed the row + its Merkle proof back in, we reconstruct the leaf hash, walk the proof, and compare against the on-chain root. For the first time, ChamaConnect can say *"we anchor on-chain"* and actually mean it.

## 3. Why this wins

- **It closes the gap the platform itself calls out.** The judges are MUIAA's team. Their own feature page says what they want built next. We built it.
- **It runs.** `npm install && npm run db:migrate && npm run db:seed && npm run dev` — judges see the live dashboard auto-reconcile simulated payments within 3 seconds. Hook up Daraja sandbox credentials and it works against real STK Pushes.
- **It fits their stack.** Same Next.js 15 App Router, same React 19, same Tailwind, same dark-first theme. A ChamaConnect engineer can lift files directly into their codebase.
- **It ships with a bug-fix appendix.** We found 7+ issues on the public site (default Next.js `<title>` boilerplate, dead footer links, contradictory phone numbers, password-only auth) and documented each with root cause + smallest-viable-fix diff. This proves we tested the platform, not just read the marketing.
- **It is domain-honest.** We priced M-Pesa reconciliation as the #1 problem, not "transparency in the abstract." The winner is the entrant who names the real pain.

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        Kenyan chama member                         │
│  (web via chamaconnect.io  |  USSD *384*12345#  |  M-Pesa paybill)│
└────────┬─────────────────┬────────────────────────┬────────────────┘
         │                 │                        │
         ▼                 ▼                        ▼
  Next.js App Router   Africa's Talking       Safaricom Daraja
  /contribute button   /api/ussd             /api/mpesa/c2b/...
         │                 │                        │
         └─────────┬───────┴────────────┬───────────┘
                   ▼                    ▼
          Reconciliation engine (deterministic matcher)
                   │
                   ▼
              SQLite ledger (double-entry, idempotent)
                   │
                   ├────▶ SMS outbox (async, via Africa's Talking)
                   ├────▶ Live dashboard (polling /summary every 3s)
                   └────▶ Nightly Merkle anchor → Base Sepolia
```

## 5. Data model (money-safe)

- Every money column is `INTEGER` cents — no floating-point drift.
- Every payment is unique on `daraja_receipt` (Safaricom's canonical TxID).
- Every matched payment produces a **balanced** double-entry pair — enforced by the engine, assertion in tests.
- Every callback is logged raw to `daraja_callbacks` before any business logic runs — full audit trail even if the handler crashes.

See [`chamapay/src/lib/db/schema.sql`](../chamapay/src/lib/db/schema.sql).

## 6. Matching strategy

Given an incoming `C2B` payment, the engine tries, in order:

| Rank | Signal | Confidence | Notes |
|---|---|---|---|
| 1 | Parsed `BillRefNumber` = `<PREFIX>-<yyyymm>[-<userHint>]` + MSISDN maps to a member of that chama | 1.00 | Happy path |
| 2 | Parsed prefix matches chama, MSISDN matches a member — user hint absent | 0.90 | Almost always correct |
| 3 | MSISDN uniquely maps to one membership across the whole platform | 0.90 | Works when ref is junk |
| 4 | MSISDN multi-chama, but one chama was hinted by the ref | 0.90 | Disambiguation |
| 5 | MSISDN + prior-payment heuristic | 0.65 | Fallback |
| 6 | No match | 0.00 | Admin review queue |

All of this is deterministic and covered by [`engine.test.ts`](../chamapay/src/lib/reconciliation/engine.test.ts).

## 7. Security & compliance notes

- No PII in logs except MSISDN (unavoidable — it's the identifier).
- Daraja initiator credentials never leave the server; sandbox cert path stubbed, prod cert-encrypted `SecurityCredential` wired in.
- Double-callback protection via SQL unique constraint, not memory.
- No schema-level foreign-key violations allowed — `PRAGMA foreign_keys = ON` always.
- Postgres upgrade path: the SQL is portable enough that `s/INTEGER/BIGINT/` and `s/TEXT PRIMARY KEY/TEXT PRIMARY KEY/` are the only diffs.

## 8. Bugs found in ChamaConnect (appendix)

Every issue below is documented in [`bugs/`](../bugs/) with evidence, root cause, and a proposed fix diff.

| ID | Title | Severity |
|---|---|---|
| BUG-001 | Default Next.js boilerplate `<title>` + `<meta description>` on every page | High |
| BUG-002 | Footer Features/Pricing/Resources/Blog/Community/Events all point to `#` | Medium |
| BUG-003 | Contact phone inconsistent across pages + hackathon brief | Medium |
| BUG-004 | Contact page renders literal `[email protected]` | Medium |
| BUG-005 | Login has no 2FA, no phone OTP, no social | High |
| BUG-006 | Register country selector defaults to `International` | Low |
| BUG-007 | M-Pesa marked "Coming Soon" — **addressed by this submission** | Critical |

More bugs will be appended as the authenticated Playwright recon surfaces them; the register is open-ended by design.

## 9. What we explicitly did not do

- We did not fork ChamaConnect's codebase. We do not have access to it, and the hackathon requires a public GitHub repo from the entrant.
- We did not re-implement the parts of ChamaConnect that already work (group registration, member invites, terms pages, public marketing). Scope discipline — the judges' brief says "identify an inefficiency," so we solved one gap deeply instead of many shallowly.
- We did not build token issuance, DeFi yield, or any speculative on-chain financial primitive. We respect that chamas are a savings instrument, not a yield farm.

## 10. Running it

```bash
git clone <repo-url>
cd Chama-Connect/chamapay
cp .env.example .env.local   # sandbox credentials optional for local demo
npm install
npm run db:migrate
npm run db:seed
npm run dev                  # open http://localhost:3100
```

Then, to see reconciliation live without any Daraja credentials:

```bash
curl -X POST http://localhost:3100/api/dev/simulate-c2b \
     -H 'content-type: application/json' \
     -d '{"msisdn":"254711223344","amount":500,"billRef":"ACME-202604"}'
```

Watch the dashboard at `/chamas/ACME` update within 3 seconds.
