<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-037 — Authorization failures consistently return `HTTP 400 Bad Request` instead of `403 Forbidden`

| Field | Value |
|---|---|
| Severity | Medium (REST semantics + defence-in-depth signal) |
| Surface | API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

Five separate routes return `400` for what are clearly authorisation, not validation, failures:

```bash
# PATCH a group I don't own
$ curl -i -X PATCH -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    -d '{"name":"x"}' https://chamaconnect.io/api/proxy/groups/69c511e1a8a7e71e0cdeab38
HTTP/2 400
{"status":"error","message":"You can only update your own chama"}

# DELETE a group I don't own
$ curl -i -X DELETE -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/groups/69c511e1a8a7e71e0cdeab38
HTTP/2 400
{"status":"error","message":"Only the group creator or admin can close the group"}

# DELETE another user
$ curl -i -X DELETE -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/users/69c50ee3a8a7e71e0cdeab36
HTTP/2 400
{"status":"error","message":"Only admins can delete users"}

# DELETE yourself via /current-user
$ curl -i -X DELETE -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/users/current-user
HTTP/2 400
{"status":"error","message":"Only admins can delete users"}

# Sign-in with wrong password (credentials failure — should be 401)
$ curl -i -X POST -H 'content-type: application/json' \
    -d '{"email":"…","password":"WRONG"}' https://chamaconnect.io/api/proxy/users/signin
HTTP/2 400
{"status":"error","message":"Incorrect password"}
```

Correct status codes per RFC 7231 / 9110:

| Situation | Correct status |
|---|---|
| Caller is unauthenticated | `401 Unauthorized` (+ `WWW-Authenticate`) |
| Caller is authenticated but not allowed to do this | `403 Forbidden` |
| Caller's payload is malformed / fails validation | `400 Bad Request` |
| Caller's credentials are wrong | `401 Unauthorized` |

## User impact

Three concrete problems:

1. **Hides authz misconfigurations from the client.** A front-end error boundary can't distinguish "the server is broken" (`400`) from "you're not allowed to do this" (`403`). The user sees a red toast instead of a "You need chairperson approval for this" inline explanation.
2. **Hides authz issues from WAFs / monitoring.** WAF rules like "if >10 403s/minute from one IP, challenge" silently miss enumeration attempts because they're buried in the 400 bucket.
3. **Inconsistent with the rest of the product.** `/api/proxy/users/current-user` already returns `401` when unauthenticated, so the code knows how to use non-400 errors — the rule just isn't applied to authz failures.

It also interacts with BUG-031 (signin enumeration) — because wrong-password and unknown-email both come back as `400`, timing is the only differential left for unified responses.

## Root cause

The codebase uses a single `badRequest(res, message)` helper for all non-successful cases (grep: `res.status(400)`). Rolling authz into the same helper was convenient; it is not correct.

## Proposed fix

Add two small helpers and migrate the route handlers:

```ts
// server/utils/http.ts
export const unauthorized = (res, m = 'Unauthorized')      => res.status(401).json({ status: 'error', message: m, errors: [{ message: m }] });
export const forbidden    = (res, m = 'Forbidden')         => res.status(403).json({ status: 'error', message: m, errors: [{ message: m }] });
export const badRequest   = (res, m = 'Invalid request')   => res.status(400).json({ status: 'error', message: m, errors: [{ message: m }] });
export const notFound     = (res, m = 'Not found')         => res.status(404).json({ status: 'error', message: m, errors: [{ message: m }] });
export const conflict     = (res, m = 'Conflict')          => res.status(409).json({ status: 'error', message: m, errors: [{ message: m }] });
```

Migration map:

| Current | New |
|---|---|
| `"Not authorized"` | `unauthorized()` |
| `"Incorrect password"` / `"Invalid email or phone number"` | `unauthorized()` with the unified message from BUG-031 |
| `"You can only update your own chama"` | `forbidden()` |
| `"Only the group creator or admin can close the group"` | `forbidden()` |
| `"Only admins can delete users"` | `forbidden()` |
| `"App settings already exist"` | `conflict()` |

Keep `400` strictly for validator output (`"Invalid value"` with a `field` name).

## Verification

1. Every route in the routing audit returns the table's expected status.
2. Regression test in `/recon/tests/http-status-codes.spec.ts` that iterates the matrix.
3. Grep: `rg "status\(400\)" server/` — results are only `validator.handle()` call-sites.
