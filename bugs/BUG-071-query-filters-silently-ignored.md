<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-071 — `?from`, `?to`, `?since`, `?createdAt` filters are silently ignored across the API (full dataset returned every time)

| Field | Value |
|---|---|
| Severity | High |
| Surface | API / data model / dashboard correctness |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 28 |
| CWE | CWE-20 (Improper Input Validation), CWE-1290 (Incorrect Decision in Security-relevant Context) |

## Evidence

Full capture: `recon/artifacts/audit2-2026-04-20T12-04-52-213Z/28_date_edges.json`. Ten very different date-shaped values were fed into four filter parameters and every single response was **byte-for-byte identical to the unfiltered call**:

| Endpoint | Filter | Values tested | Outcome |
|---|---|---|---|
| `/api/proxy/transactions` | `?from=…` | leap-day, non-leap-day `2023-02-29`, `1970-01-01`, `9999-12-31`, DST-skip, DST-fold, `not-a-date`, `'; DROP TABLE users; --`, `2026-13-40T25:61:61Z`, empty | **200** — same record set each time |
| `/api/proxy/transactions` | `?to=…` | ↑ | ↑ |
| `/api/proxy/notifications` | `?since=…` | ↑ | ↑ |
| `/api/proxy/groups` | `?createdAt=…` | ↑ | ↑ |

All 40 responses start with the identical prefix (e.g. `"data":[{"id":"69c51e30a8a7e71e0cdeab56",…`) — the first record in the underlying collection, returned regardless of the value of the query parameter. Invalid dates don't 400; SQL-injection strings don't 500; valid-but-future dates don't narrow the set. The parameter might as well not exist.

## User impact

Four interacting harms:

1. **Dashboard correctness is a lie.** The `/admin/dashboard` widgets ("Total Contributions", "Income Analysis", "Expense Analysis", "Recent Transactions" on the Recent-Activity panel — see `recon/artifacts/deep-2026-04-20T10-38-10-932Z/screenshots/01_dashboard_landing.png`) each compute their figures by fetching transactions **with an intended date filter**. If the filter is ignored, those figures are for the **entire lifetime of the account**, not for the period the user thinks they are seeing. A treasurer reading "Total Contributions this month" on the dashboard may see last year's number plus this year's.
2. **Performance amplifier for BOLA (BUG-030) + limit bypass (BUG-055).** Every page that nominally filters by date is really pulling down the entire collection. A user whose chama has 10 000 transactions is shipped all 10 000 for every widget render. Combined with BUG-030's lack of membership check, an authenticated attacker gets the full cross-chama transaction history from any endpoint regardless of the filter it advertises.
3. **Silent audit-log forgery.** Any audit / compliance report that exports "transactions between X and Y" will contain **all** transactions, not just those in range. An ODPC audit that spot-checks a single report against the DB will notice the discrepancy and conclude the platform is mis-reporting.
4. **Inability to paginate.** Combined with BUG-055 (no server-side pagination cap), the only way to narrow the dataset on the wire is the `?limit` parameter — which only bounds the response size, not the data the user sees. Users who need the "last 30 days" view simply cannot get it.

This is almost certainly the same *class* of bug as BUG-028/BUG-030/BUG-041/BUG-055 — write once, ignore forever. The filter params were added to the controller signature and the dashboard UI, but never plumbed into the DB query.

## Root cause

Handler looks roughly like:

```ts
// controllers/transactions.ts (likely shape)
async function list(req, res) {
  const { from, to, userId, groupId } = req.query;
  // TODO: apply filters
  const rows = await Transaction.find({ /* empty */ }).lean();
  return res.json({ status: "success", data: rows });
}
```

`from` and `to` are destructured but never passed to `Transaction.find()`. Same for `since` on notifications and `createdAt` on groups. Because the query just returns everything, there's no crash path to trip the static-analyser.

## Proposed fix

Plumb the date filters properly and **validate input** (return 400 on garbage instead of ignoring):

```ts
import { z } from "zod";

const ListQuery = z.object({
  from:  z.coerce.date().optional(),
  to:    z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
}).refine(
  q => !q.from || !q.to || q.from <= q.to,
  "`from` must be before or equal to `to`"
);

async function list(req, res) {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ status: "error", errors: parsed.error.issues });

  const q: Record<string, unknown> = { userId: req.user.id };
  if (parsed.data.from || parsed.data.to) {
    q.createdAt = {
      ...(parsed.data.from ? { $gte: parsed.data.from } : {}),
      ...(parsed.data.to   ? { $lte: parsed.data.to   } : {}),
    };
  }
  const rows = await Transaction
    .find(q)
    .sort({ createdAt: -1 })
    .skip(parsed.data.offset)
    .limit(parsed.data.limit)
    .lean();
  const total = await Transaction.countDocuments(q);
  return res.json({
    status: "success",
    data: rows,
    pagination: { total, limit: parsed.data.limit, offset: parsed.data.offset },
  });
}
```

Ship the same pattern on `/notifications` and `/groups`. Add a regression test that asserts the dataset **shrinks** for a narrower window.

## Verification

- `/api/proxy/transactions?from=2026-04-01` → only 2026-04 records returned.
- `/api/proxy/transactions?from=not-a-date` → 400 (not 200).
- `/api/proxy/transactions?from=2026-04-10&to=2026-04-01` → 400 "from must be before or equal to to".
- Dashboard "Recent Transactions" panel shows only records from the picked range.
