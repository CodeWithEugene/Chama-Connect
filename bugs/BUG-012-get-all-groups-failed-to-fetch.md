<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-012 — `/admin/chamas` raises `TypeError: Failed to fetch` and never retries

| Field | Value |
|---|---|
| Severity | High |
| Surface | Dashboard / reliability |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon (console errors) |

## Evidence

On `/admin/chamas`, two console errors fire on load:

```
Get All Groups Error: TypeError: Failed to fetch
  at window.fetch (/_next/static/chunks/5c407928b5841955.js:177:8289)
  at /_next/static/chunks/c3db1fc7b835d7fa.js:1:1458
```

The same recon run's network log **shows a successful `GET /api/proxy/groups` 200**. So the fetch does *eventually* work — the error indicates an earlier fetch that threw (double mount? race against token?) and the error is swallowed to console instead of retried.

## User impact

On flaky Kenyan networks this is the most common failure mode — an inflight fetch is cancelled by a Wi-Fi → 4G handoff or a DNS hiccup. When it fails, the user's "My Chamas" page renders an empty state indistinguishable from "you haven't created any chamas yet." That means a real chama treasurer is shown the **Create Your First Chama** CTA on a page where they already have 3 chamas.

This is exactly the class of bug that makes Kenyan founders cancel subscriptions — "the platform forgot my group" is reported as data loss, not a network glitch.

## Root cause

The "Get All Groups" code path throws, gets caught by a top-level `console.error`, and the hook's state stays at `{ groups: [], loading: false }`. There's no retry loop and no distinction between "zero results" and "request failed."

## Proposed fix

1. Distinguish the three states:

```ts
type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error; retryAt?: number };
```

2. Retry with exponential backoff (3 attempts, 500ms / 1.5s / 4s):

```ts
async function fetchWithRetry(url: string, init?: RequestInit, attempts = 3) {
  let last: Error | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, init);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      last = e as Error;
      await new Promise((r) => setTimeout(r, 500 * 3 ** i));
    }
  }
  throw last;
}
```

3. Render a distinct error UI (not empty state):

```tsx
{state.status === "error" && (
  <ErrorCard
    title="Couldn't load your chamas"
    detail={state.error.message}
    onRetry={reload}
  />
)}
```

4. Don't confuse "zero results" with "failed request" in the `Create Your First Chama` banner.

## Verification

- Throttle network to "Slow 3G" in DevTools → `/admin/chamas` shows loading spinner, then (on recovery) the list; never a false "Create Your First Chama" banner.
- Block `/api/proxy/groups` in DevTools → page shows an error card with a Retry button.
- Add a Playwright test that blocks the URL and asserts the retry UI.
