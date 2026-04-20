<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-048 — Transaction approval endpoint leaks internal state: `"Only undefined can approve this transaction"`

| Field | Value |
|---|---|
| Severity | Medium (information leak + null-dereference crash → 500) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
$ curl -sS -X POST -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{}' \
    https://chamaconnect.io/api/proxy/transactions/69c51e30a8a7e71e0cdeab56/approve
{"message":"Only undefined can approve this transaction","status":"error","data":null}
```

The string `"Only undefined can approve this transaction"` is a server-side template that reads a role name from the transaction's expected approver and inserts it into the message. The word `undefined` means the approver-role lookup returned `undefined` instead of a string like `"Treasurer"` or `"Secretary"` — a JavaScript null-dereference that survived into the response body.

Additionally the same route returns `HTTP 500` in some calls (observed as `500` in earlier full-body captures), suggesting it crashes outright for certain transaction states.

The rejection endpoint also has a related crash:
```bash
$ curl -sS -X POST -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"rejectionReason":"Test"}' \
    https://chamaconnect.io/api/proxy/transactions/69c51e30a8a7e71e0cdeab56/reject
{"message":"Rejection reason is required","status":"error","data":null}
# HTTP 500 — rejection reason was provided, yet error says it wasn't; 500 instead of 400
```

## User impact

Two issues:

1. **Information disclosure.** The error message template with `undefined` exposes internal code logic (the controller calls `requiredRole?.name` and doesn't guard undefined). This tells attackers that the approval is role-gated and invites further probing of role manipulation (BUG-040).

2. **Crash / availability.** The approval endpoint is core to the product — chama members submit contributions, and treasurers / secretaries must approve them. Any uncaught exception in this path silently prevents legitimate approvals, leaving transactions stuck in `PENDING` state. Users see a generic error with no actionable feedback.

## Root cause

```ts
// server/controllers/transactions.ts (inferred)
const requiredApprover = tx.nextApprovalRole;  // possibly null/undefined for completed or edge-case txs
return badRequest(res, `Only ${requiredApprover.name} can approve this transaction`);
//                                              ^^^^— crashes if requiredApprover is null/undefined
```

The rejection handler has a mirrored bug: it validates `req.body.rejectionReason` but the validation runs _after_ some DB query that throws, so a 500 escapes before the 400 validation response.

## Proposed fix

```ts
// server/controllers/transactions.ts
export const approveTransaction = asyncHandler(async (req, res) => {
  const tx = await Transaction.findById(req.params.id).populate('nextApprovalRole');
  if (!tx) return notFound(res);

  const requiredRole = tx.nextApprovalRole;
  const callerRole   = req.user?.role?.name;

  if (!requiredRole) {
    // Transaction has no pending approval step (already fully approved or rejected)
    return badRequest(res, 'This transaction does not require further approval');
  }

  if (callerRole !== requiredRole.name) {
    return forbidden(res, `Only the ${requiredRole.name} can approve this transaction`);
  }

  // ... perform approval ...
});

export const rejectTransaction = asyncHandler(async (req, res) => {
  const { rejectionReason } = req.body;
  if (!rejectionReason?.trim()) return badRequest(res, 'Rejection reason is required'); // 400, not 500
  // ... perform rejection ...
});
```

Return `403 Forbidden` (not `400` — see BUG-037) when the role check fails. The caller was authenticated; they just lack the right role.

## Verification

1. `POST /transactions/:id/approve` as a non-approver role → `403 "Only the Treasurer can approve this transaction"` (never `"undefined"`).
2. `POST /transactions/:id/approve` on a fully-approved transaction → `400 "This transaction does not require further approval"`.
3. `POST /transactions/:id/reject` without body → `400 "Rejection reason is required"` (not `500`).
4. Grep: `rg 'Only undefined'` → zero results in server code.
