<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-030 — BOLA: `GET /api/proxy/transactions` returns every chama's transactions to every signed-in user

| Field | Value |
|---|---|
| Severity | **Critical (Broken Object-Level Authorization, OWASP API1)** |
| Surface | API / authz |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

- URL: `GET https://chamaconnect.io/api/proxy/transactions`
- Auth context: a freshly-signed-up regular `User`, member of **zero** chamas.

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/transactions \
  | jq '{count: (.data|length),
         groupIds: (.data | map(.groupId) | unique),
         sample: .data[0]}'
{
  "count": 10,
  "groupIds": ["69c511e1a8a7e71e0cdeab38","69c52706a8a7e71e0cdeab82"],
  "sample": {
    "id": "69c51e30a8a7e71e0cdeab56",
    "groupId": "69c511e1a8a7e71e0cdeab38",
    "userId": "69c50ee3a8a7e71e0cdeab36",
    "amount": 1000,
    "transactionType": "CONTRIBUTION",
    "status": "COMPLETED",
    "cryptoWallet": "0x08a23b78BC3D082134D0e716e9453519fAAe1C8E",
    "cryptoTransactionId": "0x29c2fbf224e3a0d4bc3fc040ed3e8e7dedb4b61b23c3e99d2d64746f301a26ac",
    "treasurerApproval": true,
    "treasurerApprovalDate": "2026-03-26T12:03:00.445Z",
    "secretaryApproval": true,
    "chairpersonApproval": false,
    "payments": [ { "userId": "...", "amount": 1000, "method": "CASH", "status": "PENDING" } ],
    "group": { "name": "Carl Group", "type": "OTHERS", ... }
  }
}
```

Every transaction document is returned with:

- The full embedded `group` object (same over-sharing as BUG-029).
- Contributor `userId`, amounts, approval chain timestamps.
- On-chain crypto wallet address and transaction hash.
- Phone / transaction IDs for any M-Pesa payments (`mpesaPhone`, `mpesaTransactionId`, `mpesaCheckOutId` — blank in the sample but populated once real money flows).

No `?groupId=` filter is enforced server-side; no `userId === req.user.id` check exists. A member-of-nothing account gets everyone's ledger.

## User impact

This is the ledger of the product. Every audited contribution, crypto transfer, and pending M-Pesa push is visible to any attacker with a throwaway email. Specifically:

- **Financial surveillance** — an attacker can build a watch-list of the wealthiest chamas (filter by sum of `amount`) and time attacks to maturity payouts.
- **Correlation with BUG-029** — each transaction includes `userId` + `groupId`, which plug directly into `/api/proxy/groups/:id` (BOLA) to recover the member's full name, email, and phone. Net effect: an attacker can turn a single signup into a complete transactional profile of **every chama member in Kenya on the platform**.
- **On-chain targeting** — the `cryptoTransactionId` is a Polygon/Base/Sepolia (from the addresses) tx hash. Attackers can trace the treasury address, run Etherscan enrichment, and target the wallet with phishing or extortion.
- **Kenyan DPA 2019 / GDPR Article 5(1)(f)** — confidentiality of processing is lost the moment the first attacker runs `curl`.

This and BUG-029 together are the highest-priority item to fix before any production launch; they are a textbook OWASP API Security Top-10 #1 (Broken Object Level Authorization) finding.

## Root cause

`getTransactions` queries `Transaction.find({})` unconditionally. The list was probably intended to show "my transactions" but filtering on `req.user.id` was never added. Combined with BUG-015 (`permissions: []` on every role), there is nothing else to prevent this from returning.

## Proposed fix

```ts
// server/controllers/transactions.ts
export const listTransactions = asyncHandler(async (req, res) => {
  const me = req.user!.id;
  const myGroupIds = await GroupMember.distinct('groupId', { userId: me, isActive: true });

  // Caller can pass ?groupId=..., but only if they belong to that group.
  const groupFilter = req.query.groupId
    ? (myGroupIds.includes(String(req.query.groupId)) ? [req.query.groupId] : [])
    : myGroupIds;

  if (!groupFilter.length) return res.json({ status: 'success', data: [], count: 0 });

  const txs = await Transaction.find({ groupId: { $in: groupFilter } })
    .limit(50).sort({ createdAt: -1 }).lean();

  return res.json({ status: 'success', message: 'Transactions retrieved', data: txs, count: txs.length });
});
```

Also:

- Add a hard default page size (50) + `cursor` pagination.
- Redact `cryptoWallet`, `cryptoTransactionId`, `mpesaPhone`, `mpesaTransactionId` for non-officer roles.
- Log every unfiltered find in staging for a release so the absence of a filter is obvious in dashboards.

## Verification

1. Fresh account with no chama → `GET /api/proxy/transactions` → `count: 0`.
2. Same account joins chama A → only chama A's transactions appear.
3. `?groupId=<chama-B>` (not a member) → `403` or empty list, never chama B's data.
4. Automated test in `/recon/tests/bola-transactions.spec.ts`.
