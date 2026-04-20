<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-051 — `GET /api/proxy/roles/permissions` and `/roles/assign` return `500` (routing collision)

| Field | Value |
|---|---|
| Severity | Medium (availability + routing design) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
$ curl -sS -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/roles/permissions
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
# HTTP 500

$ curl -sS -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/roles/assign
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
# HTTP 500 (all methods — GET, PATCH)
```

Identical pattern to BUG-049 (`/api/proxy/groups/types`): the catch-all route `GET /roles/:id` is registered before the specific routes `GET /roles/permissions` and `GET /roles/assign`, so the string literals `"permissions"` and `"assign"` are passed as ObjectIds to `Role.findById()`, which throws a Mongoose `CastError`, producing a `500`.

This is also a **security concern**: the `/roles/permissions` and `/roles/assign` endpoints clearly exist (they crash rather than returning 404), meaning they are implemented in the backend. If they had proper role guards, those guards are being bypassed by the routing collision — an attacker who knows to probe these paths can crash the backend worker or, if the guard was inside the (unreachable) handler, bypass it entirely.

## Root cause

Route registration order in Express:

```ts
// server/routes/roles.ts
router.get('/roles/:id',          authenticate(), getRoleById);       // ← registered first
router.get('/roles/permissions',  authenticate(), getRolePermissions); // ← never reached
router.get('/roles/assign',       authenticate(), assignRole);         // ← never reached
```

## Proposed fix

Same pattern as BUG-049:

```ts
// server/routes/roles.ts  — more-specific routes BEFORE :id
router.get ('/roles/permissions', authenticate(), requireRole('SuperAdmin'), listPermissions);
router.post('/roles/assign',      authenticate(), requireRole('SuperAdmin'), assignRoleToUser);
router.get ('/roles/:id',         authenticate(), getRoleById);
router.patch('/roles/:id',        authenticate(), requireRole('SuperAdmin'), updateRole);
router.delete('/roles/:id',       authenticate(), requireRole('SuperAdmin'), deleteRole);
```

Also apply the ObjectId validation guard to `getRoleById` (same as BUG-049 fix):

```ts
if (!req.params.id.match(/^[a-f\d]{24}$/i)) return notFound(res, 'Role not found');
```

## Verification

1. `GET /api/proxy/roles/permissions` → `200` or `403 Forbidden` (never `500`).
2. `GET /api/proxy/roles/non_hex_string` → `404`.
3. `GET /api/proxy/roles/69c50c8a38f08070a83bd361` → still returns the role correctly.
