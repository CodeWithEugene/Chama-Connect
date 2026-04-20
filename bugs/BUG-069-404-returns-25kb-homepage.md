<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-069 — Every unmatched path returns a 25-KB HTML clone of the homepage (bandwidth + SEO + fingerprinting)

| Field | Value |
|---|---|
| Severity | Low |
| Surface | Public site / Cloudflare + Next.js config |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 01 |

## Evidence

Sampled from `recon/artifacts/audit-2026-04-20T11-27-52-385Z/01_static_exposure.json`. Every one of these paths — each of which a normal site would 404 with a few-hundred-byte placeholder — instead returns **26 186 bytes** of HTML:

| Path | Status | Content-Type | Size |
|---|---|---|---|
| `/.env`             | 404 | `text/html` | **26 186** |
| `/.git/HEAD`        | 404 | `text/html` | 26 186 |
| `/package.json`     | 404 | `text/html` | 26 186 |
| `/yarn.lock`        | 404 | `text/html` | 26 186 |
| `/next.config.js`   | 404 | `text/html` | 26 186 |
| `/next-env.d.ts`    | 404 | `text/html` | 26 186 |
| `/swagger`          | 404 | `text/html` | 26 186 |
| `/graphql`          | 404 | `text/html` | 26 186 |
| `/api/health`       | 404 | `text/html` | 26 186 |
| `/api/version`      | 404 | `text/html` | 26 186 |
| `/.well-known/security.txt` | 404 | `text/html` | 26 186 |

The 26-KB body is the same content served on `/` (logo, navigation, hero preload, OG metadata). Two supporting data points:

- `/_next/static/chunks/main.js.map` returns a different 404: `text/plain` `Not Found` at **9 bytes**. So the Cloudflare / Next layer *can* produce a small 404; it just doesn't for top-level paths.
- `/api/proxy/*` correctly returns a **75-byte** JSON 404: `{"status":"error","message":"Not Found","errors":[{"message":"Not Found"}]}`.

So there are three distinct 404 behaviours on the same domain:
- `/api/proxy/*`   → 75 B JSON (correct)
- `/_next/*.map`   → 9 B plain text
- everything else  → 26 KB HTML homepage-clone

## User impact

1. **Bandwidth amplification.** Every scanner, link-rot check, security scanner and lazy bot sending `GET /.env` to every site on the internet gets a 26-KB reply instead of a 200-byte one — a ~130× amplification. Against just one scanner hitting N common paths, ChamaConnect's egress bill balloons.
2. **SEO noise.** Google's crawler does not render 404 pages, but it will note that the 404 body is nearly identical to `/`, which looks like duplicate-content soft-404 behaviour. This dilutes the real homepage's ranking signal and is one of Google Search Console's loudest warnings.
3. **Fingerprinting surprise.** The default Next.js 404 behaviour is a ~300-byte page; 26 KB matching the homepage is unusual enough to be a strong fingerprint (someone scanning the internet for Next.js sites with `notFound` returning the homepage will find ChamaConnect quickly). Minor in isolation, but combined with BUG-026 (`X-Powered-By: Next.js`) it identifies the stack precisely.
4. **Inconsistent UX for API consumers.** A partner integrator calling `/api/health` expecting JSON 404 gets back 26 KB of HTML. Their error-handling blows up. `/api/*` outside the `/api/proxy/*` subtree is inconsistent with the rest of the API surface.

## Root cause

The site's root `app/not-found.tsx` renders the full marketing page (probably reusing the `<Home />` component to show a "brand" not-found), and Next.js serves that same component for **all** unmatched paths — including `/api/*` paths on the Next side (not the proxy side).

## Proposed fix

1. **Small, explicit `not-found.tsx`:**

   ```tsx
   // app/not-found.tsx
   import Link from "next/link";
   export default function NotFound() {
     return (
       <main className="min-h-screen grid place-items-center p-8">
         <section className="text-center">
           <h1 className="text-5xl font-bold">404</h1>
           <p className="mt-2 text-muted-foreground">Page not found.</p>
           <Link href="/" className="mt-4 inline-block underline">Back to ChamaConnect</Link>
         </section>
       </main>
     );
   }
   ```

   Keeps branded UX but collapses the body to < 2 KB.

2. **JSON 404 for `/api/*` on the Next side.** A catch-all `app/api/[...path]/route.ts` that returns:

   ```ts
   export const GET = () => new Response(
     JSON.stringify({ status: "error", message: "Not Found" }),
     { status: 404, headers: { "content-type": "application/json" }}
   );
   ```

   so API clients see JSON, not HTML.

3. **Edge rule** at Cloudflare that rejects `/.env`, `/.git/*`, `/package.json`, `/yarn.lock`, etc. with a 444 "No Response" — they have no legitimate reason to be requested; dropping them without a body is the cheapest correct answer.

4. **soft-404 SEO:** add `<meta name="robots" content="noindex">` to the 404 page so Google Search Console marks them as proper 404s, not soft-404s.

## Verification

- `curl -o /dev/null -s -w "%{size_download}\n" https://chamaconnect.io/some-path` → < 2048 bytes.
- `curl -H 'accept: application/json' https://chamaconnect.io/api/unknown` → JSON 404 body.
- `curl https://chamaconnect.io/.env` → Cloudflare-level 444 / no body.
- Google Search Console "soft 404" count drops to zero.
