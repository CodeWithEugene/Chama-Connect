<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-050 — Stored XSS: group name accepts raw HTML / `<script>` tags without sanitization

| Field | Value |
|---|---|
| Severity | High (stored XSS — any group admin can attack members and platform operators) |
| Surface | API — group creation / editing |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# Create a chama with a <script> payload as the name
$ curl -sS -X POST -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"name":"<script>alert(\"XSS\")</script>","description":"d","type":"OTHERS",...}' \
    https://chamaconnect.io/api/proxy/groups
{"message":"Created group successfully with 1 members","data":{"id":"69e602cf3e9a7937fd3ca4fd",...}}

# The raw tag is stored and returned in subsequent GET /groups responses:
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/groups | grep name
... "name":"<script>alert(\"XSS\")</script>" ...

# Group list API response still contains the literal <script> tag:
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/groups | grep -c 'script>'
1  # raw <script> tag in JSON response
```

The backend stores the input verbatim in MongoDB and returns it without any HTML-entity encoding or stripping. While the Next.js/React frontend likely auto-escapes `{group.name}` in JSX expressions, the following attack surfaces remain exploitable:

1. **Any component using `dangerouslySetInnerHTML`** — React has no compile-time guardrails; one misuse is enough.
2. **Server-Side Rendering (SSR)** — if the name is interpolated into a meta tag (`<meta name="og:title" content={group.name}>`) without escaping, the `content` attribute can be broken out of.
3. **Email / SMS notifications** — if group names are embedded in HTML emails sent by the platform (e.g. "You have been added to *[group name]*"), a stored `<script>` tag executes in the victim's email client.
4. **PDF export / invoice generation** — PDF generators (Puppeteer, wkhtmltopdf, WeasyPrint) that receive HTML from the DB will execute injected scripts.
5. **Admin panel** — if an admin dashboard uses a legacy or non-React rendering layer (EJS, Handlebars, plain `innerHTML`) the payload runs in every admin browser that loads the group list.
6. **Future integrations** — any third-party service that consumes the groups API (mobile apps, webhooks, analytics pipelines) and renders the name without escaping.

The attack is persistent: the payload survives across all subsequent GET requests and every downstream consumer.

## User impact

A malicious group creator (or a victim of BUG-027/040 privilege escalation) can:
- Inject JavaScript into every chama member's browser session.
- Steal auth tokens, manipulate transactions, or perform account takeover at scale.
- Target platform admins who view the group management dashboard.

## Root cause

No HTML sanitization middleware on the group create/update handlers. The validation layer only checks field types and lengths, not content safety.

## Proposed fix

**Layer 1 — Input sanitization in the controller** (escape or strip HTML before writing to DB):

```ts
import DOMPurify from 'isomorphic-dompurify';   // or sanitize-html

// server/controllers/groups.ts
export const createGroup = asyncHandler(async (req, res) => {
  const name = DOMPurify.sanitize(req.body.name, { ALLOWED_TAGS: [] });  // plain text only
  const description = DOMPurify.sanitize(req.body.description, { ALLOWED_TAGS: [] });
  // ...
});
```

**Layer 2 — Output encoding** — whenever a user-supplied string is placed in HTML context:

```ts
// utility
export const escHtml = (s: string) =>
  s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
   .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
```

**Layer 3 — Content Security Policy** (defence-in-depth, already partially in place per headers audit — BUG-017). Add:

```
Content-Security-Policy: script-src 'self' 'nonce-<per-request-nonce>';
```

## Verification

1. Create a group with `name: "<script>alert(1)</script>"` → stored name should be `&lt;script&gt;alert(1)&lt;/script&gt;` or rejected entirely.
2. Group list response contains no literal `<` or `>` characters in the `name` field.
3. Open the group detail page in a browser — no alert box appears.
4. Regression test in `/recon/tests/stored-xss.spec.ts`.
