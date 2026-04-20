<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-070 — `/api/proxy/users/signin` accepts `application/x-www-form-urlencoded` and `multipart/form-data` bodies

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Auth / API content-type handling |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 03 |
| CWE | CWE-352 (Cross-Site Request Forgery) — amplifier for other endpoints |

## Evidence

Full capture: `recon/artifacts/audit-2026-04-20T11-27-52-385Z/03_content_type_bypass.json`. Sending an equivalent signin payload under five different `Content-Type` headers:

| Content-Type                                | Status | Parsed? | Server response |
|---|---|---|---|
| `application/json`                          | 400 | ✓ | `Invalid email or phone number` |
| `application/json;charset=utf-8`            | 400 | ✓ | `Invalid email or phone number` |
| **`application/x-www-form-urlencoded`**     | 400 | **✓** | `Invalid email or phone number` |
| `multipart/form-data; boundary=----X`       | 400 | ✗ | `Please provide your password / email or phone` (body not parsed) |
| `text/plain`                                | 400 | ✗ | `Please provide your password / email or phone` (body not parsed) |
| *(no Content-Type header)*                  | 400 | ✗ | `Please provide your password / email or phone` (body not parsed) |

The signin handler accepts at least **JSON and form-urlencoded**. Both are parsed into the same `{email, password}` object.

## User impact

`application/x-www-form-urlencoded` is a "simple request" under the CORS spec, meaning browsers send it cross-origin **without a preflight `OPTIONS` check**. So a malicious page on `evil.example` can submit:

```html
<form action="https://chamaconnect.io/api/proxy/users/signin" method="POST">
  <input name="email"    value="victim@…"/>
  <input name="password" value="<guess>"/>
  <input type="submit"/>
</form>
<script>document.forms[0].submit()</script>
```

The victim's browser sends the request and the server processes it. For **signin** specifically the direct harm is muted — the response is unreadable cross-origin (no `Access-Control-Allow-Origin` in the reply), and the cookie is `SameSite=Strict`. But the same *content-type permissiveness* is the CSRF amplifier that matters here:

1. **Blind credential-stuffing.** An attacker-controlled page that an ad network lands on a million browsers can submit one guess per visit to `/signin`. Each attempt is indistinguishable from an anonymous IPv4 hit, defeating a naïve per-IP rate limit (BUG-018) by spreading across real users' IPs. No preflight means no OPTIONS traffic to rate-limit on.
2. **Accelerator for other CSRF bugs.** If any other `/api/proxy/*` mutation endpoint also accepts form-urlencoded (BUG-053 — changing group member roles; BUG-027 — writing settings), those become browser-exploitable CSRFs even if `SameSite=Strict` is set on the session cookie, because the session cookie for same-site POSTs from iframes / top-level-nav initiated by `<form>` submission does get attached. We did not systematically test every endpoint for this, so **extend the probe** to prove or disprove it for each mutation handler.
3. **Parser confusion.** `application/x-www-form-urlencoded` has no type for structured data; `email[$ne]=null` becomes `{email: {$ne: null}}` in some frameworks (NoSQL-injection vector) even when the JSON parser would reject it. Related to BUG-039.

## Root cause

The Express app has both `express.json()` and `express.urlencoded({ extended: true })` middleware globally installed. This is the default template in most Express scaffolds, but unnecessary here: every intended frontend call is JSON.

## Proposed fix

1. **Restrict signin (and every other `/api/proxy/*` route) to `application/json` only.**

   ```ts
   // middleware/jsonOnly.ts
   export function jsonOnly(req, res, next) {
     const ct = (req.headers["content-type"] || "").split(";")[0].trim();
     if (ct !== "application/json") {
       return res.status(415).json({ status: "error", message: "Unsupported Media Type" });
     }
     next();
   }

   app.use("/api/proxy", jsonOnly, express.json({ limit: "8kb" }));
   // and remove the global `express.urlencoded(...)` line.
   ```

2. **On the reverse-proxy layer (Cloudflare / Next.js route handler)** strip any non-`application/json` request to `/api/proxy/*` with a 415.

3. **Systematic sweep** to confirm no mutation endpoint still relies on form-urlencoded; extend `tests/audit-extended.spec.ts` probe 03 to run across every known endpoint in the API inventory.

## Verification

- `POST /signin  Content-Type: application/x-www-form-urlencoded` → 415 `Unsupported Media Type`.
- `POST /signin  Content-Type: application/json  body={"email":…,"password":…}` → unchanged.
- Security test: a script that enumerates every `/api/proxy/*` endpoint and confirms all non-JSON Content-Types get 415.
