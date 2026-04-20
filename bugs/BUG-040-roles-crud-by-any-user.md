<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-040 — Any authenticated `User` can create, rename, and modify platform roles (including `SuperAdmin`)

| Field | Value |
|---|---|
| Severity | **Critical (privilege escalation via role tampering)** |
| Surface | API / authz |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

Auth context: freshly-signed-up regular `User` account, role `"User"`, `isSuperadmin: false`.

**Create a new role:**

```bash
$ curl -sS -X POST -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"name":"SuperAdmin2","permissions":["*"]}' \
    https://chamaconnect.io/api/proxy/roles
{"message":"User Created","status":"success","data":{"id":"69e5fe4b3e9a7937fd3ca4e4","name":"SuperAdmin2",...}}
# HTTP 200
```

**Rename the real `SuperAdmin` role to `"MyRole"` (renaming the highest-privilege role in the system):**

```bash
$ curl -sS -X PATCH -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"name":"MyRole"}' \
    https://chamaconnect.io/api/proxy/roles/69c50c8a38f08070a83bd361
{"message":"Role updated","status":"success","data":{"id":"69c50c8a38f08070a83bd361","name":"MyRole",...}}
# HTTP 200
```

Role was immediately restored by reverting the `PATCH`. The ghost `SuperAdmin2` role is still present in the role list because `DELETE /api/proxy/roles/:id` returns `404`.

## User impact

This is a **platform-wide authorization takeover surface** with two exploit paths:

1. **Role rename → auth bypass.** Middleware that checks `req.user?.role?.name === 'SuperAdmin'` relies on the name being immutable. An attacker who renames `SuperAdmin` to `SuperAdmin_DISABLED` instantly revokes all superadmin access across the platform (DoS). Alternatively, rename `User` to `SuperAdmin` so that the attacker's existing token passes every `requireRole('SuperAdmin')` check at the next page load (privilege escalation without re-login, subject to whether the JWT caches the name string vs. only the `roleId`).

2. **Create ghost roles.** An attacker can flood the role list with hundreds of decoy roles, polluting the admin UI and making it impossible to audit the legitimate role structure. In combination with the missing `DELETE` route, the garbage is permanent.

3. **JWT payload contains `role.name`** (confirmed: `"role":{"id":"...","name":"User"}` embedded in every token). If any middleware trusts the in-token `role.name` string instead of re-fetching from DB, a user who signs up after the attacker has renamed `User → SuperAdmin` will get a token with `role.name = "SuperAdmin"` — direct privilege escalation without touching the DB.

## Root cause

`POST /api/proxy/roles` and `PATCH /api/proxy/roles/:id` are mounted behind `authenticate()` only. No `requireSuperadmin()` / `requireRole('SuperAdmin')` guard was added. Any valid JWT caller can reach the handler.

## Proposed fix

```ts
// server/routes/roles.ts
router.get('/roles', authenticate(), rolesController.list);
router.get('/roles/:id', authenticate(), rolesController.getById);

// All write operations: superadmin-only
router.post(  '/roles',    authenticate(), requireRole('SuperAdmin'), rolesController.create);
router.patch( '/roles/:id', authenticate(), requireRole('SuperAdmin'), rolesController.update);
router.delete('/roles/:id', authenticate(), requireRole('SuperAdmin'), rolesController.delete);  // currently 404 — implement the delete handler too
```

Additionally:
- Seed roles as a fixed, immutable enum at startup and block any request that would rename `SuperAdmin`, `User`, `Treasurer`, `Secretary`, `Chairperson`, `Member`, `ChamaAdmin` — these are system roles.
- Stop embedding `role.name` in the JWT payload; embed only `roleId`. Re-fetch the live role record for name-based middleware checks so stale JWT strings can't be abused.

## Verification

1. As a regular `User`: `POST /api/proxy/roles` → `403 Forbidden`.
2. As a regular `User`: `PATCH /api/proxy/roles/69c50c8a38f08070a83bd361` → `403 Forbidden`.
3. As `SuperAdmin`: both succeed.
4. Attempt to rename `SuperAdmin` → system roles validator rejects with `400 Cannot rename a system role`.
5. Regression test in `/recon/tests/roles-authz.spec.ts`.
