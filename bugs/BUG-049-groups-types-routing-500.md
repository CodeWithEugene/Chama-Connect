<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-049 — `GET /api/proxy/groups/types` returns `500 Internal Server Error` (routing/ObjectId collision)

| Field | Value |
|---|---|
| Severity | Medium (availability + routing design) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/groups/types
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
# HTTP 500

$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/groups/group-types
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
# HTTP 500
```

Both `/api/proxy/groups/types` and `/api/proxy/groups/group-types` crash the server. The most likely cause: the backend router matches `GET /groups/:id` before it can match `GET /groups/types`, so the string `"types"` is passed to `Group.findById("types")` — Mongoose throws a `CastError: Cast to ObjectId failed for value "types"` — and the global error handler converts this to a `500` instead of catching and returning `404`.

This is a companion to BUG-009 (the `MERRRY_GO_AROUND` typo in group-types) and BUG-010 (duplicate endpoints). The group-types data is meant to populate the "Create Chama" type selector and appears to have been refactored but with this routing collision left unresolved.

## User impact

Any code path that calls `/api/proxy/groups/types` (e.g. a future refactor that consolidates the two inconsistent group-types endpoints from BUG-010) will crash the backend worker. This is also an availability concern: an attacker can fire 1000 requests to this path (within the global rate limit) and produce 1000 Mongoose `CastError` stack traces in the server logs, degrading observability and potentially consuming worker-thread time.

## Root cause

Route registration order issue in Express:

```ts
// server/routes/groups.ts
router.get('/groups/:id', authenticate(), getGroupById);   // matches BEFORE:
router.get('/groups/types', authenticate(), getGroupTypes); // never reached
```

Express routes are matched in registration order. If `GET /groups/:id` is registered first, the literal path `/groups/types` is captured by `:id` and never reaches the `getGroupTypes` handler. The fix is to place more-specific routes before wildcard routes.

## Proposed fix

```ts
// server/routes/groups.ts  — order matters in Express
router.get('/groups/types',        authenticate(), getGroupTypes);   // ← first
router.get('/groups/group-types',  authenticate(), getGroupTypes);   // ← alias (or redirect to /types)
router.get('/groups/:id',          authenticate(), getGroupById);    // ← after specific routes
```

Additionally, add a `CastError` guard in the `getGroupById` handler as a safety net:

```ts
export const getGroupById = asyncHandler(async (req, res) => {
  if (!req.params.id.match(/^[a-f\d]{24}$/i)) return notFound(res, 'Chama not found');
  const group = await Group.findById(req.params.id);
  if (!group) return notFound(res);
  // ...
});
```

## Verification

1. `GET /api/proxy/groups/types` → `200` with the list of group types.
2. `GET /api/proxy/groups/non_hex_string` → `404` (not `500`).
3. `GET /api/proxy/groups/69c511e1a8a7e71e0cdeab38` → still works correctly.
4. Regression test in `/recon/tests/groups-routing.spec.ts`.
