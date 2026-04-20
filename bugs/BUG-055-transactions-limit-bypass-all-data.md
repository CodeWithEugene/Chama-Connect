<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-055 — Pagination bypass: `?limit=99999` dumps ALL platform transactions in a single request

| Field | Value |
|---|---|
| Severity | High (amplifies BUG-030 — full cross-chama financial data dump with one request) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# Default (no limit) — returns 10 transactions
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/transactions
{"data": [...10 items...]}

# With limit=99999 — returns ALL 29 transactions across 7 chamas and 11 users
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/transactions?limit=99999
{"data": [...29 items...]}

# All 29 transactions belong to groups and users this account has NO relationship with:
# Unique groupIds: 7 distinct chama IDs
# Unique userIds: 11 distinct user IDs
# Including: LOAN transactions, EXPENSE transactions, FINE transactions, REPAYMENT records
```

The server accepts the caller-supplied `limit` parameter without capping it. While BUG-030 already established that the transaction list is not scoped to the authenticated user, the default 10-item page made it appear manageable. With `limit=99999`, an attacker can extract the entire platform transaction ledger in a single HTTP request.

Combined with BUG-030 (`GET /api/proxy/transactions` returns all chamas' data) this makes exfiltration trivially automatable with a one-liner:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://chamaconnect.io/api/proxy/transactions?limit=99999" \
  -o all_platform_transactions.json
```

The response includes full financial history: amounts, types (LOAN, EXPENSE, INCOME, FINE, REPAYMENT, CONTRIBUTION), approval states, M-Pesa phone numbers, receipt IDs, blockchain wallet addresses, and timestamps — for every chama on the platform.

## User impact

A single authenticated user (even the attacker's own test account) can download the entire financial history of every chama in one request. For chamas managing real member funds, this is a complete financial privacy breach.

## Root cause

The query handler applies the caller-provided `limit` directly to the Mongoose query without a server-side cap:

```ts
// server/controllers/transactions.ts (inferred)
const limit = parseInt(req.query.limit as string) || 10;
const txs = await Transaction.find({ ... })
  .limit(limit)   // no maximum cap enforced
  .sort({ createdAt: -1 });
```

## Proposed fix

```ts
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

export const listTransactions = asyncHandler(async (req, res) => {
  const me = req.user!.id;
  const isAdmin = req.user!.role?.name === 'SuperAdmin';

  // Server-enforced pagination cap
  const limit = Math.min(parseInt(req.query.limit as string) || DEFAULT_LIMIT, MAX_LIMIT);
  const page  = Math.max(parseInt(req.query.page  as string) || 1, 1);
  const skip  = (page - 1) * limit;

  // Scope to the caller's groups (see BUG-030 fix)
  const myGroupIds = await GroupMember.distinct('groupId', { userId: me, isActive: true });
  const groupFilter = isAdmin ? {} : { groupId: { $in: myGroupIds } };

  const [txs, total] = await Promise.all([
    Transaction.find(groupFilter).skip(skip).limit(limit).sort({ createdAt: -1 }).lean(),
    Transaction.countDocuments(groupFilter),
  ]);

  return res.json({
    status: 'success',
    message: 'Transactions retrieved successfully',
    data: txs,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});
```

## Verification

1. `GET /api/proxy/transactions?limit=99999` → returns at most 50 transactions.
2. `GET /api/proxy/transactions?limit=0` → returns 10 transactions (default).
3. `GET /api/proxy/transactions?limit=-1` → returns 10 (or 1) transactions (no negative limits).
4. Pagination works correctly with `page=2&limit=10`.
