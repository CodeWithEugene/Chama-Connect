<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-014 — React hydration error (#418) on `/contact`

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Public site / contact page |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon (page error) |

## Evidence

During `/contact` load, the page throws an uncaught React error:

```
Minified React error #418; visit https://react.dev/errors/418
```

React error #418 = **"Text content does not match server-rendered HTML"** — a hydration mismatch between SSR output and client render.

Captured in `recon/artifacts/2026-04-20T08-22-01-022Z/errors.json`.

## User impact

1. React aborts hydration, tears down the SSR tree, and re-renders from scratch on the client. Visible as a flash/re-layout on page load.
2. Any client-only interactivity on `/contact` (live chat widget, form validation) is delayed by the remount.
3. Pollutes Sentry / error-tracking dashboards with a recurring error that's easy to fix.

Combined with BUG-004 (the `[email protected]` literal in the same page's markup), `/contact` has the highest bug-density of any public route on the site.

## Root cause (probable)

The most common causes are:
1. A `Date.now()` / `Math.random()` / `new Date().toLocaleString()` rendered inline — server value ≠ client value.
2. An obfuscation script that replaces the `[email protected]` text on the client after SSR (Cloudflare email-protection), producing different text client-side vs server-side.
3. A timezone-sensitive value ("Office hours: 9am–5pm EAT") being formatted with `toLocaleTimeString(undefined, ...)` without a server-locked locale.

Given BUG-004 (the `[email protected]` literal is visible), cause #2 is the most likely — Cloudflare's obfuscator rewrites the DOM after hydration, but something on this page is reading that DOM during render and causing the mismatch.

## Proposed fix

1. If a piece of content is genuinely client-only, wrap it in a `"use client"` + `useEffect` so SSR produces a stable placeholder:

```tsx
"use client";
import { useEffect, useState } from "react";
export function ContactEmail({ email }: { email: string }) {
  const [obfuscated, setObfuscated] = useState("…");
  useEffect(() => setObfuscated(email), [email]);
  return <a href={`mailto:${email}`}>{obfuscated}</a>;
}
```

2. Disable Cloudflare email obfuscation for `/contact` (Dashboard → Scrape Shield → Email Address Obfuscation → Page Rule to off for that URL). Fixes BUG-004 simultaneously.

3. Add a Playwright regression:

```ts
test("/contact has no hydration errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/contact");
  await page.waitForLoadState("networkidle");
  expect(errors.filter((e) => e.includes("418"))).toHaveLength(0);
});
```

## Verification

- Open `/contact` in an incognito tab with the React DevTools console open → no #418 error.
- Click the email link → email client opens with `support@muiaa.com` pre-filled.
