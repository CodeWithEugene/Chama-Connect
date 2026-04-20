<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-011 — Notifications page tries to connect to `ws://localhost:3080` in production

| Field | Value |
|---|---|
| Severity | Critical |
| Surface | Real-time notifications / production config |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon (console logs) |

## Evidence

On `/admin/dashboard/notifications`, the browser console shows:

```
WebSocket connection to 'ws://localhost:3080/socket.io/?EIO=4&transport=websocket' failed:
  Error in connection establishment: net::ERR_CONNECTION_REFUSED
```

Captured at `recon/artifacts/2026-04-20T08-22-01-022Z/console.json` (2 occurrences in one page load).

This is not a CSP or network issue — the client literally has `ws://localhost:3080` baked into its JS bundle because someone shipped a `.env.development` value to production.

## User impact

**Real-time notifications are broken for every single user.** The notifications tab loads its initial snapshot via HTTP (`GET /api/proxy/notifications`) but then tries to connect a socket for push updates to a URL that only exists on a developer's laptop.

Concretely this means:
- A chama treasurer never sees "Alice contributed KES 500" until they refresh the page.
- A borrower never sees "your loan was approved" until they re-navigate.
- `unreadCount` on the bell icon is stale forever — the whole notification system is reduced to manual polling.

Given the product narrative ("Real-Time Tracking / auto-reminders / real-time notifications" on the features page), this is a critical MVP-polish gap: the marketing claim is literally contradicted by the console.

Secondary impact: a user on HTTPS connecting a `ws://` (non-TLS) socket would be a mixed-content error even if the URL was correct. So the fix needs to be `wss://`, not `ws://`.

## Root cause

Client env variable used at build time hasn't been set for prod:

```ts
// somewhere in the socket client
const url = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3080";
io(url, { transports: ["websocket"] });
```

...and `NEXT_PUBLIC_WS_URL` is not defined on the Vercel/Netlify/whatever deploy.

## Proposed fix

1. Add the variable to the production env:

```
NEXT_PUBLIC_WS_URL=wss://chamaconnect.io
```

(or point to the socket service's actual host — e.g. `wss://realtime.chamaconnect.io`).

2. Harden the client to refuse the localhost fallback in production:

```ts
const rawUrl = process.env.NEXT_PUBLIC_WS_URL;
if (!rawUrl) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_WS_URL must be set in production");
  }
  console.warn("No NEXT_PUBLIC_WS_URL set — falling back to localhost:3080");
}
const url = rawUrl ?? "ws://localhost:3080";
```

This converts "silent failure in prod" into "loud failure in CI", which is the right trade-off.

3. Add a one-liner smoke test to CI:

```ts
test("no localhost URLs in production bundle", () => {
  const bundle = fs.readFileSync(".next/static/**/*.js", "utf8");
  expect(bundle).not.toMatch(/ws:\/\/localhost/);
});
```

## Verification

- Open `/admin/dashboard/notifications` in prod → no `ERR_CONNECTION_REFUSED` in console; socket goes to `wss://chamaconnect.io`.
- `curl` the JS bundle → no `localhost:3080` substring.
- Contribute a payment in ChamaPay → the notification bell on ChamaConnect ticks up within ≤ 1 s.
