<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-019 — `/api/auth/token` returns 401 on every public page load — should be 200 with `{token:null}`

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | API contract / DX / public site reliability signals |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — console errors |

## Evidence

Every public page fires a background request to `GET /api/auth/token`. On an unauthenticated browser, every single call returns **HTTP 401** with body `{"token":null}`:

```
401	https://chamaconnect.io/ (from=/ )
401	https://chamaconnect.io/features
401	https://chamaconnect.io/pricing
401	https://chamaconnect.io/faqs
401	https://chamaconnect.io/contact
401	https://chamaconnect.io/onboard-chama  (2x)
401	https://chamaconnect.io/get-started    (2x)
```

Browser console shows a red error line on every one of those pages:

```
Failed to load resource: the server responded with a status of 401 ()
  at https://chamaconnect.io/api/auth/token
```

Evidence files: `recon/artifacts/2026-04-20T09-40-50-508Z/console.json`, `.../network/requests.json`.

## User impact

1. **Every public page in the product has a red error in DevTools on load.** First impression for any developer evaluating ChamaConnect for a partnership integration is "the site is broken". This is the loudest signal that visitors tell us about first.
2. **Browser extensions (Sentry, LogRocket, Datadog RUM) flag 401s as errors.** The Datadog RUM, Sentry, and any third-party observability on the site will surface a 401-per-pageview metric that never drops to zero — drowning real incidents in noise.
3. **Semantic misuse of 401:** HTTP 401 means *"you attempted authentication and it failed"*. A user asking "am I logged in?" and getting 401 violates the spec — the correct answer is **200 OK + `{"token":null}`** or **204 No Content**. The current behavior causes well-behaved client code (React Query, SWR, Axios interceptors) to fire retry logic, error toasts, or forced sign-out flows.
4. **Wasted network call** — the endpoint runs on every public pageview even though public pages don't need it. That is one extra TLS round-trip per SSR hydration for a known-null result.
5. **Masks the real unauth-session attacks** — a SIEM watching for 401 rates on auth endpoints cannot distinguish "user has no session yet" from "attacker is brute-forcing". This is a defender's blind spot.

## Root cause

The client-side auth provider fetches the current token on mount of every page, and the server-side handler treats "no cookie present" as an auth failure:

```ts
// Probable: app/api/auth/token/route.ts
export async function GET(req: Request) {
  const session = await getServerSession(req);
  if (!session) return new Response(JSON.stringify({ token: null }), { status: 401 });
  return new Response(JSON.stringify({ token: session.token }), { status: 200 });
}
```

and

```tsx
// app/providers/AuthProvider.tsx — mounts on every page
useEffect(() => { fetch("/api/auth/token").then(r => r.json()).then(setToken); }, []);
```

## Proposed fix

1. **Return 200 (or 204) for "no session".** 401 is reserved for *failed* authentication, not *absent* authentication.

```ts
// app/api/auth/token/route.ts
export async function GET(req: Request) {
  const session = await getServerSession(req);
  return Response.json({ token: session?.token ?? null }, { status: 200 });
}
```

2. **Gate the fetch client-side** so public pages don't call the endpoint at all:

```tsx
// app/providers/AuthProvider.tsx
const pathname = usePathname();
const needsToken = pathname.startsWith("/admin") || pathname.startsWith("/app");
useEffect(() => {
  if (!needsToken) return;
  fetch("/api/auth/token").then(...);
}, [needsToken]);
```

3. **Set `Cache-Control: private, no-store`** on the response so Cloudflare never caches a stale token between users.

## Verification

- `curl -i https://chamaconnect.io/api/auth/token` with no cookies → `200 OK` with `{"token":null}`.
- `curl -i https://chamaconnect.io/api/auth/token` with a valid session cookie → `200 OK` with the token (and `Cache-Control: private, no-store`).
- Open `/`, `/features`, `/pricing`, `/about`, `/faqs`, `/contact`, `/community`, `/get-started`, `/onboard-chama` in an incognito tab — DevTools console shows zero 401 errors.
- Playwright regression:

```ts
test("public pages do not spam 401s", async ({ page }) => {
  const errors: string[] = [];
  page.on("response", r => { if (r.status() === 401) errors.push(r.url()); });
  for (const p of ["/", "/features", "/pricing", "/about", "/faqs", "/contact"]) {
    await page.goto(p, { waitUntil: "networkidle" });
  }
  expect(errors).toEqual([]);
});
```
