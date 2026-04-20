<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-026 — `X-Powered-By` response header leaks the backend tech stack on every HTML response

| Field | Value |
|---|---|
| Severity | Low (security / info disclosure) |
| Surface | Every HTML response |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon |

## Evidence

HTML document response for `https://chamaconnect.io/` includes:

```
x-powered-by: Next.js
```

alongside other Next-specific fingerprints:

```
x-nextjs-cache
x-nextjs-prerender
x-nextjs-stale-time
```

Evidence: `recon/artifacts/2026-04-20T09-40-50-508Z/network/requests.json` — the root document headers.

## User impact

1. **Free reconnaissance for attackers.** Knowing the server is Next.js narrows the CVE list an attacker needs to test. Major advisory channels (GHSA, nvd.nist.gov) are organised by framework — publishing `Next.js` in a header means every published Next.js RCE/SSRF/cache-poisoning is a candidate probe without any fingerprinting work.
2. **Stack fingerprints in partner / auditor reports.** Pen-test reports typically flag `X-Powered-By` as a finding; showing this on a financial platform during a security review makes the report read worse than necessary.
3. **Inconsistent with the other Next-specific fingerprints**: `x-nextjs-cache` and friends are similar-tier leaks. If the site ever goes behind a bug-bounty program, all four will be filed as separate reports.

On its own this is not exploitable. It belongs alongside BUG-017 as part of tightening the platform's default security posture.

## Root cause

Next.js sets `X-Powered-By: Next.js` automatically. The fix is a single-line opt-out. The `x-nextjs-*` headers are added by Next.js's cache layer and also reach the browser because Cloudflare isn't stripping them.

## Proposed fix

```js
// next.config.mjs
export default {
  poweredByHeader: false,   // removes "X-Powered-By: Next.js"
  // ... other config
};
```

Strip the cache-diagnostic headers in a Next.js middleware or at the Cloudflare edge:

```ts
// middleware.ts
import { NextResponse } from "next/server";

export function middleware() {
  const res = NextResponse.next();
  for (const h of ["x-nextjs-cache", "x-nextjs-prerender", "x-nextjs-stale-time", "server"]) {
    res.headers.delete(h);
  }
  return res;
}

export const config = { matcher: "/:path*" };
```

Or — simpler — a Cloudflare Transform Rule that removes response headers matching `^x-(powered-by|nextjs-)` on `*.chamaconnect.io/*`.

## Verification

- `curl -sI https://chamaconnect.io/` → no `X-Powered-By` and no `x-nextjs-*` headers.
- Mozilla Observatory test result for `chamaconnect.io` improves the "Server Information Disclosure" line.
- Regression:

```bash
curl -sI https://chamaconnect.io/ | grep -iE '^x-(powered-by|nextjs-)'
# must return 0 lines
```
