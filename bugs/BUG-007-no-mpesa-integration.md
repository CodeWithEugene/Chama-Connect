<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-007 — M-Pesa integration marked "Coming Soon" (the #1 Kenyan chama requirement)

| Field | Value |
|---|---|
| Severity | Critical |
| Surface | Core product / revenue |
| Status | Open → **addressed by the `chamapay/` module in this repo** |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl of `/features`) |

## Evidence

From `/tmp/cc_features.html`:

> **M-pesa Blockchain Integration** — M-pesa and bank integration (**Coming Soon**) will enable seamless deposits, withdrawals, and loan repayments.

The entire rest of the product — contribution tracking, loan management, reports, dashboards — is meaningless without it, because in Kenya ~99% of chama money moves through M-Pesa (Paybill / Till / Pochi la Biashara / Send Money).

## User impact

Today, a chama admin using ChamaConnect still has to:

1. Receive M-Pesa messages on their personal phone as money arrives.
2. Manually copy each line into the ChamaConnect dashboard, matching phone numbers to member names.
3. Reconcile end-of-month against the downloaded M-Pesa statement PDF.
4. Chase defaulters by reading their own M-Pesa inbox line-by-line.

This is the same manual workflow that paper-based chamas have — ChamaConnect adds no value over a paper notebook until this is built. It also re-opens the exact fraud vector the platform's marketing claims to eliminate: a treasurer can under-report what arrived or pocket the difference, because the ledger is not actually linked to the source of truth.

FSD Kenya reports theft/embezzlement at 13% of chamas — the mechanism is almost always treasurer discretion over cash-to-ledger reconciliation.

## Root cause

Daraja integration (Safaricom's public API for M-Pesa) was scoped but not built for MVP. The team is blockchain-leaning and appears to have prioritised the on-chain ledger narrative first.

## Proposed fix — ChamaPay (this repo's `chamapay/` module)

A drop-in Next.js API + worker that adds:

1. **STK Push** — member taps "Contribute" → their phone rings M-Pesa PIN prompt → money arrives in the chama Paybill → ledger updates.
2. **C2B Paybill callback** — when a member pays from their own M-Pesa app (no app touch required), the `/api/mpesa/c2b/confirmation` webhook matches the payment to the right member by MSISDN and the right cycle by the account reference (`CHAMA-<groupCode>-<yyyymm>`).
3. **Reconciliation engine** — deterministic matcher with confidence scores; unmatched payments land in an admin review queue.
4. **B2C payouts** — loan disbursements go out directly to the borrower's phone; guarantor holds and automated interest accrual are handled server-side.
5. **Transaction Status fallback** — polls Daraja when a callback is missed (network/outage safety).
6. **Idempotent ledger writes** keyed by Daraja `TransactionID` so a double-callback never double-credits.
7. **SMS receipts** to both member and admin on every successful contribution.

Architecture and API contract are in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md). Implementation lives under [`chamapay/apps/web/app/api/mpesa/`](../chamapay/apps/web/app/api/mpesa/) and [`chamapay/packages/reconciliation/`](../chamapay/packages/reconciliation/).

## Verification

End-to-end demo (runs against Daraja sandbox):

1. Admin creates a chama with Paybill `174379` (sandbox) and account prefix `DEMO`.
2. Member Alice `+2547...` pays KSh 500 with reference `DEMO-ACME-202604` via STK Push.
3. Dashboard updates within ≤ 3s showing Alice's contribution for April 2026.
4. Admin triggers B2C payout of KSh 10,000 to Bob; Daraja sandbox confirms; ledger reflects debit.
5. Kill the callback endpoint; repeat; `TransactionStatusQuery` job reconciles the orphaned payment within 2 min.
6. Re-play the same callback: ledger unchanged (idempotency).

Metrics we'll claim in the submission:

- Time to reconcile 100 monthly contributions: **0s manual** (vs ~30 min today).
- Fraud surface (treasurer discretion): **eliminated** (ledger = Daraja truth).
- Defaulter notification latency: **< 1 min** (vs end-of-month today).
