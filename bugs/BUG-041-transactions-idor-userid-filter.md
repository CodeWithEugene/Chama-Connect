<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-041 — `GET /api/proxy/transactions` IDOR: `?userId=` filter returns another user's transactions; no pagination guard

| Field | Value |
|---|---|
| Severity | Critical (IDOR + data exposure, extends BUG-030) |
| Surface | API / authz |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

Auth context: regular `User` with ID `69ca9583185c4debc8e94dc5`, member of zero chamas.

**Pass another user's ID in `?userId=`:**

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    "https://chamaconnect.io/api/proxy/transactions?userId=69c50ee3a8a7e71e0cdeab36"

# count=10, ALL 10 transactions belong to the OTHER user:
# { "userId": "69c50ee3a8a7e71e0cdeab36", "amount": 1000, "groupId": "...", ... }
# My own userId (69ca9583185c4debc8e94dc5) does not appear in any result.
```

**Pass another chama's `?groupId=` (not a member):**

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    "https://chamaconnect.io/api/proxy/transactions?groupId=69c511e1a8a7e71e0cdeab38"

# count=10, transactions for Carl Group returned without any membership check
```

**Unbounded result set (no server-side pagination):**

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    "https://chamaconnect.io/api/proxy/transactions?limit=10000"

# returned=29, pagination=None, total=None
# Server ignores `limit` param and returns everything in one shot
```

## User impact

BUG-030 showed that `GET /api/proxy/transactions` without parameters returns all transactions for all chamas to any user. This bug adds two dimensions:

1. **Targeted IDOR via `?userId=`.** An attacker who discovers any user's MongoDB ObjectId (trivially available from the `group.members[].userId` leak in BUG-029, or from the `transactions[].userId` field in BUG-030) can retrieve that specific person's complete financial history — every contribution, loan, payout, and approval timestamp — without sharing a chama with them. On a platform for a country where 78% of the adult population uses M-Pesa, this is a comprehensive personal finance dossier obtained with a single `curl` command.

2. **Targeted IDOR via `?groupId=`.** Reinforces that non-members can fully read any chama's ledger. Combined with BUG-029 (member PII), an attacker now has the complete financial record linked to real names and phone numbers.

3. **No pagination.** The API dumps every transaction in one response — currently 29 records. On a production platform with thousands of chamas the same call will return megabytes of financial data in a single unthrottled request, enabling bulk harvest with one HTTP call per IP per 15-minute rate-limit window.

## Root cause

The transactions query applies `req.query` parameters directly to the Mongoose query without validating that:
- `req.query.userId === req.user.id` (or the caller is an admin).
- `req.query.groupId` is a group the caller belongs to.
- A `skip`/`limit` is enforced server-side regardless of query params.

## Proposed fix

```ts
// server/controllers/transactions.ts
export const listTransactions = asyncHandler(async (req, res) => {
  const me = req.user!.id;
  const isAdmin = req.user!.role?.name === 'SuperAdmin';

  // Scope userId to self unless admin
  const userId = isAdmin
    ? (req.query.userId as string | undefined)
    : me;

  // Scope groupId to groups the caller belongs to
  let groupFilter: string[] | undefined;
  if (req.query.groupId) {
    if (!isAdmin) {
      const membership = await GroupMember.exists({ groupId: req.query.groupId, userId: me, isActive: true });
      if (!membership) return forbidden(res, 'You are not a member of this chama');
    }
    groupFilter = [req.query.groupId as string];
  } else if (!isAdmin) {
    groupFilter = await GroupMember.distinct('groupId', { userId: me, isActive: true });
    if (!groupFilter.length) return res.json({ status: 'success', data: [], count: 0 });
  }

  const PAGE_SIZE = 50;
  const page = Math.max(1, Number(req.query.page) || 1);

  const q: FilterQuery<Transaction> = {};
  if (userId) q.userId = userId;
  if (groupFilter) q.groupId = { $in: groupFilter };

  const [data, total] = await Promise.all([
    Transaction.find(q).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    Transaction.countDocuments(q),
  ]);

  return res.json({ status: 'success', message: 'Transactions retrieved', data, count: data.length, total, page, pageSize: PAGE_SIZE });
});
```

## Verification

1. `?userId=<other>` as a non-admin → `403 Forbidden`.
2. `?groupId=<not-mine>` as a non-admin → `403 Forbidden`.
3. `?limit=10000` → maximum 50 records returned, `total` field accurate, `page`/`pageSize` present.
4. Admin can pass any `userId` or `groupId`.
5. Automated test in `/recon/tests/bola-transactions.spec.ts`.
