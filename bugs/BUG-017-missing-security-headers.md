<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-017 — No Content-Security-Policy, and HTML responses ship without HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy

| Field | Value |
|---|---|
| Severity | High (security) |
| Surface | Public site / every HTML response |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — inspected response headers across 283 requests |

## Evidence

Across **every captured response** (documents + 11 API endpoints, 283 requests total) in `recon/artifacts/2026-04-20T09-40-50-508Z/network/requests.json`:

```bash
# No CSP header on a single response, anywhere
jq '[.[] | select(.responseHeaders["content-security-policy"] != null)] | length'
→ 0
```

Security-related headers observed on any response, anywhere on the site:

```
strict-transport-security    # (present only on API responses)
x-content-type-options       # (present only on API responses)
x-frame-options              # (present only on API responses)
x-xss-protection             # (present only on API responses; value "0")
```

The **HTML document response** for `https://chamaconnect.io/` (the response the browser hydrates) ships with none of those. Its full `keys[]`:

```
alt-svc, cache-control, cf-cache-status, cf-ray, content-encoding, content-type,
date, nel, report-to, server, server-timing, vary,
x-nextjs-cache, x-nextjs-prerender, x-nextjs-stale-time, x-powered-by
```

No `content-security-policy`. No `strict-transport-security`. No `x-frame-options`. No `x-content-type-options`. No `referrer-policy`. No `permissions-policy`.

## User impact

This is a defense-in-depth bug, but it multiplies every other security bug on the site:

1. **Clickjacking** — `/admin/dashboard`, `/admin/chamas/create`, `/admin/chamas/[id]/settings` can be `<iframe>`-embedded by any attacker site, which can then overlay invisible UI and trick a logged-in chama treasurer into clicking "Approve Payout" or "Delete Chama".
2. **No CSP means XSS is uncontained.** Combined with BUG-013 (JWT in response body) and BUG-016 (never-expiring JWT), any single reflected or stored XSS on a contact form, profile bio, or chama description hands the attacker a permanent credential for the victim's account.
3. **No HSTS on the document response** means a user visiting `http://chamaconnect.io` from a hotel wifi is downgrade-attackable on first visit. (Cloudflare will often add HSTS at the edge; this evidence shows it is not consistently present on the document response in the current configuration.)
4. **No Referrer-Policy** means when a logged-in user clicks an external link, the full path (e.g. `/admin/chamas/<mongoid>/loans/<loanid>`) leaks into the third-party's access log via the `Referer` header.
5. **`x-xss-protection: 0`** is modern best practice, but it only appears on API responses — HTML documents don't even set it.
6. **Missing `Permissions-Policy`** — the site could lock down camera/microphone/geolocation but opts for the browser default ("allowed"), which exposes a bigger surface than needed.
7. **`x-powered-by` header is present** — minor info disclosure revealing the tech stack (Next.js) and handing attackers pre-targeted CVE lists.

A Kenyan money platform failing these is hard to defend to an ODPC auditor.

## Root cause

Headers are not set in `next.config.mjs` (or middleware), and the reverse proxy (Cloudflare) is not configured to add them to HTML responses — only API responses happen to have partial ones, likely because the backend framework sets them itself.

## Proposed fix

Add a Next.js middleware (or `headers()` export in `next.config.mjs`) that applies strict headers to every HTML document response:

```ts
// next.config.mjs
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://chamaconnect.io https://cdn.cloudflare.com",
  "connect-src 'self' wss://chamaconnect.io https://api.chamaconnect.io",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join("; ");

export default {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  poweredByHeader: false,
};
```

Then run a CSP **report-only** rollout for 1–2 weeks using `Content-Security-Policy-Report-Only` + `report-uri` so you can find legitimate third-party inline scripts before enforcing.

## Verification

```bash
curl -sI https://chamaconnect.io/ | grep -iE 'content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy'
# must show all six
```

- `curl -sI https://chamaconnect.io/ | grep -i x-powered-by` → no match.
- `<iframe src="https://chamaconnect.io/admin/dashboard">` on an attacker page → refuses to render.
- Mozilla Observatory score goes from F → A.
- Security regression test:

```ts
test("every public route sets core security headers", async ({ request }) => {
  for (const path of ["/", "/features", "/pricing", "/about", "/faqs", "/contact", "/get-started"]) {
    const r = await request.get(path);
    const h = r.headers();
    expect(h["content-security-policy"]).toBeTruthy();
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["x-frame-options"] ?? h["content-security-policy"]).toMatch(/frame-ancestors|DENY|SAMEORIGIN/i);
    expect(h["x-content-type-options"]).toBe("nosniff");
  }
});
```
