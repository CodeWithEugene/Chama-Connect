<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-066 — Signin accepts ≥ 100 KB request bodies with no size limit (bandwidth / DoS amplifier)

| Field | Value |
|---|---|
| Severity | Medium |
| Surface | Auth / infrastructure |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright audit probe 10 |
| CWE | CWE-400 (Uncontrolled Resource Consumption) |

## Evidence

`POST /api/proxy/users/signin` with `{ email: "a@b.c", password: "x".repeat(N) }`. Full capture: `recon/artifacts/audit-2026-04-20T11-27-52-385Z/10_large_payload.json`.

| Body size | Status | Response time |
|---|---|---|
|    1 KB | 400 (parses, returns "Invalid email") |  327 ms |
|   10 KB | 400 (parses)                         |  373 ms |
|  100 KB | 400 (parses)                         |  660 ms |

The server parses every body we sent all the way through to the Zod/Mongoose validator (confirmed by the **"Invalid email or phone number"** response, which only fires after parse + schema validation). At **100 KB** the server still happily runs bcrypt-length-checks over the supplied password candidate. No 413 Payload Too Large was returned. We capped the probe at 100 KB to avoid being a bad neighbour on a shared production box — the ceiling is almost certainly much higher.

## User impact

Signin is un-authenticated, so it is the best-amortised endpoint to attack from a cost-per-request standpoint. Three concrete harms:

1. **Bandwidth DoS.** A single attacker with 100 Mbps can fire ~125 × 100-KB signins per second, each consuming CPU for JSON parse + schema validate + possibly bcrypt. Cloudflare's bot-management and rate limits help at the edge but the origin still pays for the bodies that pass through.
2. **Compatibility cover for brute force.** Because BUG-018 (weak rate limit) lets 1000 requests / 15 min / IP through, a single IP can push ~600 MB of signin bodies in a quarter-hour. A botnet of a few hundred nodes can shove through tens of GBs.
3. **Log bloat.** Many backends log request bodies on error (for debugging); a 100-KB password field ends up in CloudWatch / Loki / ELK on every failed attempt. Storage fills up, log-based alarms generate, and the `password` field itself is now at rest in many more systems than necessary.

Most security-aware fintech APIs cap unauth endpoints at 1–8 KB (GitHub: 1 MB total, 8 KB on login-ish paths; Stripe: 16 KB on API; Cloudflare Workers default: 100 KB).

## Root cause

No `express.json({ limit: "8kb" })` (or equivalent) on the auth router. The global default of `body-parser` is 100 KB, matching what we see.

## Proposed fix

1. **Tight per-endpoint body limit** on all unauthenticated POST endpoints:

   ```ts
   // server/middleware/bodyLimit.ts
   import express from "express";
   export const tinyBody = express.json({ limit: "4kb" });

   authRouter.post("/signin",                 tinyBody, signinHandler);
   authRouter.post("/signup",                 tinyBody, signupHandler);
   authRouter.post("/request-password-reset", tinyBody, resetHandler);
   authRouter.post("/verify-otp",             tinyBody, otpHandler);
   ```

2. **Slightly looser limit** for authenticated endpoints that accept free-text (group descriptions, chat messages): 32–64 KB.

3. **Cloudflare Rule** (belt-and-suspenders): block requests > 100 KB to `/api/proxy/users/*` at the edge, so origin never sees oversized bodies even if the app layer misbehaves.

4. **Password length cap** at 128 chars in the validator (already recommended by BUG-064) — bounds bcrypt work regardless of body size.

## Verification

- `POST /signin` with 10-KB password → 413 `Payload too large`.
- `POST /signin` with valid ~200-byte payload → same 200/400 behaviour as before.
- Load test: 1000 × 100-KB signin attempts per IP → all blocked at the edge, origin CPU steady.
