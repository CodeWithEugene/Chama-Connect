<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-018 — Signin rate limit is 1000 requests per 15 minutes with no per-account lockout — brute-force is viable

| Field | Value |
|---|---|
| Severity | High (security) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Playwright recon — read `RateLimit-*` headers off `/api/proxy/users/signin` |

## Evidence

Response headers on `POST /api/proxy/users/signin`:

```
ratelimit-policy: 1000;w=900
ratelimit-limit: 1000
ratelimit-remaining: 979
ratelimit-reset: 208
```

Captured at `recon/artifacts/2026-04-20T09-40-50-508Z/network/requests.json`.

`1000;w=900` is the standard IETF draft-06 encoding for **"1000 requests per 900-second window"** — i.e. **1000 signin attempts every 15 minutes from the same client**. Combined with the absence of other signals (no `x-account-lockout`, no `retry-after` after 10 failures, no CAPTCHA), this is the only protection against brute force.

## User impact

1. **Online brute force is trivially achievable.** A single IP can try **4,000 passwords per hour** (16× the 250-per-hour floor NIST SP 800-63B considers acceptable for online attacks). A botnet of 50 residential IPs can try **200,000 passwords per hour** against the same account — enough to crack any 8-character password from the rockyou.txt top-N list within minutes.
2. **No account-level lockout** means the attacker never triggers a "too many attempts on this account" response. They just spread attempts across the full 1000/15min budget per IP.
3. **No CAPTCHA, no device fingerprint, no risk-based challenge.** A script with stolen email dumps (there are hundreds of Kenyan credential dumps on breach markets) can credential-stuff the platform at line rate.
4. **Combined with BUG-005 (no MFA exposed)** and **BUG-016 (never-expiring JWTs)**: one successful guess = one permanent takeover.
5. **Reputation/legal:** under Kenya's Data Protection Act 2019, failing to implement "reasonable" authentication safeguards is an enforcement trigger. 1000/15min with no account-scoped protection is unlikely to be considered reasonable.

## Root cause

Only an IP-scoped rate-limit middleware is in place (probably `express-rate-limit` or `@upstash/ratelimit` with a single shared bucket). There is no per-account counter, no exponential backoff, and no progressive challenge (delay, CAPTCHA, MFA demand).

## Proposed fix

1. **Tighten IP bucket** for signin specifically — 10 attempts per 10 minutes is already loose:

```ts
export const signinIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});
```

2. **Add an account-scoped counter** (Redis key `login:fail:<email>`):

```ts
const failed = await redis.incr(`login:fail:${email}`);
await redis.expire(`login:fail:${email}`, 900);
if (failed > 5) {
  return res.status(429).json({ message: "Too many failed attempts. Try again in 15 minutes or reset your password." });
}
// ... on success
await redis.del(`login:fail:${email}`);
```

3. **Exponential backoff on the client response**: delay the 401 response itself by `2^attempts * 100ms` (max 2s) so scripted attackers get slower as they keep missing.

4. **CAPTCHA (Cloudflare Turnstile or hCaptcha) after 3 failures** on either dimension (per-IP or per-account).

5. **Alert on abuse**: every time `failed` crosses 10 for any account, emit an event to a WAF / SIEM so the IP can be Cloudflare-rule-blocked.

6. **Notify the account owner** by email on the 5th failure — "we saw 5 bad attempts on your ChamaConnect account".

## Verification

```bash
# Script 100 bad logins in 60 seconds:
for i in $(seq 1 100); do
  curl -sS -o /dev/null -w "%{http_code}\n" \
    -X POST https://chamaconnect.io/api/proxy/users/signin \
    -H 'content-type: application/json' \
    -d '{"email":"victim@example.com","password":"wrong-'"$i"'"}'
done | sort | uniq -c
```

Expected after fix:

- First 5 → `401`.
- `6..`  → `429` with `Retry-After: <seconds>`.
- After the window, further attempts on that email are still rate-limited regardless of source IP.
- Email to the victim after 5 failures.
- `ratelimit-limit` on signin drops from 1000 to ≤ 10 per window.
