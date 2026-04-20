<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-035 — `GET /api/proxy/permissions` returns `201 Created` with a role-list payload (routing bug)

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
$ curl -sS -i -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/permissions
HTTP/2 201
content-type: application/json; charset=utf-8
...
{"message":"Role lists","status":"success","data":[],"count":0}
```

Three problems in one response:

1. **HTTP `201 Created`** on a `GET` request — the status code is reserved for successful creations (`POST` / `PUT` that created a new resource). A plain `GET` must respond `200 OK`.
2. **Message is `"Role lists"`** — the payload shape (`data`, `count`, message text) is the response envelope of `GET /api/proxy/roles`, not `GET /api/proxy/permissions`. The two routes share a handler (or the permissions route is silently proxied to the roles controller).
3. **`data: []` despite permissions clearly existing in the backend** — the product already has roles named `SuperAdmin`, `Treasurer`, `Secretary`, `Chairperson`, `Member`, `User`, and the permission strings they must enforce. Returning an empty list here means the admin UI that drives per-role permission editing has no backing data.

## User impact

This ties back to BUG-015 (every role has `permissions: []`). If the `/permissions` endpoint is what the admin UI fetches to render the per-role permission matrix, the matrix is always empty — no admin can *actually* grant or revoke permissions. The entire authorisation model is effectively "role name == permission", which is exactly what BOLAs like BUG-027 / 029 / 030 exploit.

Downstream, any client that depends on HTTP semantics (API SDK generators, caching layers, retry logic) will misbehave: `201` responses trigger "resource was just created" handlers in many frameworks, caching proxies won't cache (incorrectly), and retries may double-post.

## Root cause

Most likely the Next.js route `/api/proxy/permissions/route.ts` re-exports the handler from `/api/proxy/roles/route.ts` but also re-uses its `201` creation status (copy-paste drift). Alternatively the backend never defined a `GET /permissions` route and a catch-all rewrote it to `/roles` without touching the response.

## Proposed fix

1. Add a dedicated handler that actually enumerates permissions:

```ts
// server/controllers/permissions.ts
export const listPermissions = asyncHandler(async (req, res) => {
  const isAdmin = req.user?.role?.name === 'SuperAdmin';
  if (!isAdmin) return forbidden(res);
  const perms = await Permission.find({}).lean();
  return res.status(200).json({
    status: 'success',
    message: 'Permissions retrieved',
    data: perms,
    count: perms.length,
  });
});
```

2. Wire it into the router so `/api/proxy/permissions` is no longer shadowed by the roles handler.

3. Audit every other route for wrong status codes — I've seen `GET /api/proxy/permissions → 201` here, and the platform has a separate pattern of returning `400` where `403` is correct (see BUG-037). Do a single audit pass.

## Verification

1. `curl -i https://chamaconnect.io/api/proxy/permissions` → `HTTP/2 200`, `message: "Permissions retrieved"`, `data: [...]` non-empty after seeding, list includes entries like `group.read`, `transaction.approve`, `settings.write`.
2. As a regular `User` → `403 Forbidden`.
3. Snapshot test in `/recon/tests/permissions-endpoint.spec.ts`.
