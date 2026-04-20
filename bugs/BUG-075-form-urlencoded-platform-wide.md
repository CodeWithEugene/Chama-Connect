<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-075 — **Every** `/api/proxy/*` mutation endpoint accepts `application/x-www-form-urlencoded` and `multipart/form-data` — full CSRF surface (supersedes / escalates BUG-070)

| Field | Value |
|---|---|
| Severity | **High** (escalation of BUG-070's Medium) |
| Surface | API / Content-Type handling / CSRF |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 32 |
| Supersedes | BUG-070 (scope: signin only) — this bug covers the full mutation surface |
| CWE | CWE-352 (CSRF), CWE-436 (Interpretation Conflict) |

## Evidence

Full capture: `recon/artifacts/audit3-2026-04-20T12-20-24-471Z/32_form_urlencoded_mutations.json`. Every mutation endpoint was probed with three Content-Types; the response shape proves the server parsed each one.

| Endpoint | Method | `application/x-www-form-urlencoded` | `multipart/form-data` | `application/json` |
|---|---|---|---|---|
| `/api/proxy/users/update-profile` | PATCH | 400 *"Invalid value, field: email"* + *"You must provide your email address"* — **body parsed** | 400 *"Please provide your First Name / Last Name"* — **parser didn't find fields** (but endpoint accepted the request) | 400 *"Invalid value, field: email"* — same as form-urlencoded |
| `/api/proxy/users/current-user-update-password` | PATCH | 400 *"Please provide your password / confirm password"* — **body parsed** | 400 *"Please provide your password / confirm password"* — body parsed | 400 *"Please provide your password / confirm password"* — body parsed |
| `/api/proxy/groups` | POST | 400 *"Group name is required / description is required / members must be non-empty"* — **body parsed** | 400 *"Group name is required / description is required / members must be non-empty"* — body parsed | 400 *"Group name is required / description is required / members must be non-empty"* — body parsed |
| `/api/proxy/roles` | POST | 400 *"Error creating role. Please  role exists."* — body parsed, rejects duplicate | 400 *"Error creating role..."* — body parsed | 400 *"Error creating role..."* — body parsed |
| `/api/proxy/settings/…` | PUT | 400 *"Invalid value, fineDelayPercentageIncrement / withdrawalFee"* — body parsed | 400 *"Invalid value, fineDelayPercentageIncrement / loanFee / withdrawalFee"* — body parsed | 400 *"Invalid value, fineDelayPercentageIncrement / withdrawalFee"* — body parsed |

Two things are confirmed simultaneously:

1. **Every mutation endpoint accepts form-urlencoded** — evidence: the field-level validation errors are the same across all three content types on `/update-password`, `/groups`, `/roles`, and `/settings`. Only the value-parser differs in one edge case (`/update-profile` multipart doesn't reach the JSON validator shape, but still returns a 400 from the body-parse layer rather than 415).
2. **No endpoint returns 415 Unsupported Media Type** for any of the three content types. The server is `content-type`-permissive, not `content-type`-strict.

BUG-070 caught this only on `/users/signin`. The full mutation-endpoint sweep now makes it clear this is a **platform-wide middleware default**, not a per-route oversight.

## User impact

`application/x-www-form-urlencoded` and `multipart/form-data` are **both "simple requests"** in the CORS spec, which means browsers send them **cross-origin without a preflight `OPTIONS` check**. Combined with several other filed bugs, the consequences are:

| Depends on | Then a malicious page on `evil.example` can… |
|---|---|
| SameSite=Strict on `auth_token` (confirmed present) | NOT steal a logged-in victim's session directly — the cookie won't be sent on top-level form submits from cross-site pages (Strict is strong). |
| BUG-067 (session endpoint accepts arbitrary JWT) + form-urlencoded on `/api/auth/session` if confirmed | Force-log the victim into an attacker's account (session fixation). Still needs a separate test to confirm `/api/auth/session` *also* accepts form-urlencoded. |
| BUG-050 (stored XSS in group name) — which runs as same-origin JS | Bypass CORS preflight entirely since now the "evil" origin is the target's own. The form-urlencoded acceptance is no help there, but isn't hurtful either. |
| A single OWASP A05 misconfiguration that changes the cookie to `SameSite=Lax` in the future | Full cross-site CSRF on every mutation endpoint listed above. Changing chama settings, creating roles, patching member roles (BUG-053) — all weaponised by a single HTML `<form>` submission. |

The last row is the most important. SameSite=Strict is doing a lot of work here. The moment anyone relaxes it — to fix a real pain-point like "users land on a marketing page that links back to the dashboard and have to log in again" — the whole CSRF surface instantly opens up because the server-side content-type check is missing. That's a bug whose severity depends on adjacent config; we should fix it independently so the platform's security does not rely on a single cookie flag.

Additional second-order harm independent of CORS:

- **Parser confusion** (CWE-436). Different frameworks parse form-urlencoded differently. `email[$ne]=x` becomes `{email: {$ne: "x"}}` under `qs` (Express default), which is exactly the shape NoSQL-injection needs (see BUG-039). Rejecting form-urlencoded closes that whole class of attack at once.
- **Validator-message inconsistency** (visible above). The same PATCH returns different error bodies for the same missing fields depending on Content-Type. Clients written to parse one may break on another.

## Root cause

Stock Express bootstrap:

```ts
// server/app.ts — typical template
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(multer().any());      // or similar for multipart
```

With no Content-Type gate in front of route handlers, each parser picks up whatever matches, and the handler sees the `req.body` that resulted. Nothing in the controller knows (or cares) which parser ran.

## Proposed fix

Single middleware applied to the `/api/proxy/*` subtree:

```ts
// middleware/jsonOnly.ts
export function jsonOnly(req, res, next) {
  const ct = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") {
    return res.status(415).json({
      status: "error",
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "This endpoint only accepts application/json",
    });
  }
  next();
}

app.use("/api/proxy", jsonOnly, express.json({ limit: "8kb" }));
```

And remove `express.urlencoded` + `multer` from the `/api/proxy` mount point entirely. Keep them on any dedicated **upload** route (`/users/update-profile-picture`) — those genuinely need `multipart/form-data` — but gate *those* with their own narrow middleware so `multipart/form-data` is only valid on explicit upload routes.

In addition, add a **Cloudflare rule** that rejects non-JSON bodies to `/api/proxy/*` at the edge. Belt and suspenders, so any future mis-plumbed middleware can't reopen this surface.

## Verification

- `curl -X POST -H 'Content-Type: application/x-www-form-urlencoded' --data 'x=y' https://chamaconnect.io/api/proxy/groups` → **415**.
- `curl -X POST -H 'Content-Type: multipart/form-data; boundary=x' --data '-' https://chamaconnect.io/api/proxy/users/update-profile` → **415**.
- Existing JSON-only clients (dashboard, mobile) keep working unchanged.
- Playwright regression `probe 32` re-run: every non-JSON row returns **415** instead of 400.
- Curl audit: `GET /api/proxy/users/signin -H 'Content-Type: text/plain'` → no change in behaviour (idempotent GETs are unaffected); `POST` with `text/plain` body → 415.
