<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-034 — `/api/proxy/users/request-password-reset` has no per-account rate limit (mail-bombing + OTP brute-force prep)

| Field | Value |
|---|---|
| Severity | High |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

I fired 30 back-to-back requests for the same victim address from a single IP:

```bash
$ for i in $(seq 1 30); do
    curl -sS -o /dev/null -w 'status=%{http_code}\n' \
      -X POST https://chamaconnect.io/api/proxy/users/request-password-reset \
      -H 'content-type: application/json' \
      --data-raw '{"email":"eugenegabriel.ke@gmail.com"}' ;
  done
status=200
status=200
status=200
...   # 30×200, zero slowdown, zero lockout, zero captcha
```

- Per-IP rate limit header: `ratelimit-limit: 1000`, `ratelimit-policy: 1000;w=900` (same as the signin endpoint — 1000 requests / 15 minutes).
- **No per-account / per-email rate limit.** The victim (my own account) received one email per request — 30 "Reset your ChamaConnect password" messages in <20 seconds.
- The response body is correctly generic (`"If an account with that email exists, you will receive a reset password link"` — good, no enumeration), but the side effect (email delivery) is uncapped.

The same endpoint also accepts `{"phone":"+254..."}` payloads (evidence is the behaviour of sibling endpoints; not re-tested to avoid sending actual SMS to real people) — if unchecked, SMS floods cost ChamaConnect ~0.80 KES per send on Safaricom, making this a **direct revenue attack** too.

## User impact

Three distinct harms:

1. **Mail bombing a target.** An attacker fires 10 000 reset requests at `victim@gmail.com`. The victim's inbox is flooded, legitimate reset emails become invisible (buried in 10 000 duplicates), and the domain `chamaconnect.io` is tagged as a spam source by Gmail/Outlook — which will then throttle *every* ChamaConnect transactional email, including verification codes and STK-push receipts. Classic "reputation DoS".

2. **SMS flooding + cost attack.** If the endpoint also sends an OTP via SMS on the phone path, an attacker can run up thousands of KES of SMS costs against ChamaConnect's Africa's Talking / Twilio bill in minutes.

3. **OTP brute-force staging.** The sibling endpoint `POST /api/proxy/users/password-reset` rejects with `"You must provide your otp message/token sent to email or sms"`. If the OTP is numeric and short (4–6 digits), and an attacker can trigger 10 000 reset requests for themselves to study timing/format, they can then race the verification endpoint. A rate-limited issuance would make that far harder.

## Root cause

The endpoint is mounted behind only the global 1000 req / 15 min per-IP bucket (shared with all other routes). There is no per-email counter (e.g. "max 3 reset emails per address per hour") and no global anti-abuse throttle on the email provider.

## Proposed fix

Add a layered rate-limit policy specifically for reset-request issuance:

```ts
// server/middleware/rate-limits.ts
export const resetRequestLimiter = rateLimit({
  keyGenerator: (req) => `reset:${String(req.body?.email || req.body?.phone || req.ip).toLowerCase()}`,
  windowMs: 60 * 60_000,       // 1 hour
  max: 3,                      // 3 emails / sms per account / hour
  standardHeaders: true,
  message: { status: 'error', message: 'Too many reset requests. Try again later.' },
});

export const resetRequestIpLimiter = rateLimit({
  keyGenerator: (req) => `reset-ip:${req.ip}`,
  windowMs: 10 * 60_000,
  max: 20,                     // at most 20 distinct reset requests / 10 min / IP
});
```

```ts
// routes/users.ts
router.post(
  '/users/request-password-reset',
  resetRequestIpLimiter,
  resetRequestLimiter,
  authController.requestPasswordReset,
);
```

Supporting controls:

- Return the same generic response **after the rate-limit fires** so that the limit itself isn't an enumeration channel.
- Invalidate any already-outstanding token when a new one is issued (so the *first* of the rapid-fire requests is the one that works, and the rest are noops that don't send email).
- Make the password-reset OTP 8+ digits, with its own verification-side rate limiter (5 attempts / 15 min per token, hard-fail after 10 lifetime attempts).
- Disable SMS delivery when the phone number has triggered >5 resets in a rolling 24 hours (capped cost).

## Verification

1. Fire 4 reset requests in one hour for the same email → first 3 return `200`, 4th returns `200` with the same body but **no email is actually sent** (rate-limited silently).
2. Receipt-count test on the email provider: 30 requests in 10 minutes → exactly 3 delivered.
3. Attempt the verification endpoint 6 times with wrong OTP → 6th response is `429 Too Many Attempts`.
4. Automated test in `/recon/tests/reset-rate-limit.spec.ts`.
