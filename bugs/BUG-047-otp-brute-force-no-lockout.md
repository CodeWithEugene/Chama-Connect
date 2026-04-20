<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-047 — Password-reset OTP verification has no rate limit or lockout (brute-force viable)

| Field | Value |
|---|---|
| Severity | High (OTP brute force — full account takeover) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# 15 consecutive OTP guesses — ZERO rate limiting, ZERO lockout:
for i in $(seq 1 15); do
  curl -sS -X POST https://chamaconnect.io/api/proxy/users/password-reset \
    -H 'content-type: application/json' \
    --data-raw "{\"email\":\"victim@example.com\",\"otp\":\"$(printf '%06d' $i)\",\"newPassword\":\"Pwned123!\",\"confirmPassword\":\"Pwned123!\"}"
done
# Every response: {"status":"error","message":"Invalid or expired verification code"}
# No 429, no Retry-After, no account lock
```

The correct field name is `otp` (confirmed by differential: the `token` field triggers "You must provide your otp message/token sent to email or sms", but `otp` triggers "Invalid or expired verification code" — meaning the OTP is being checked). The `ratelimit-remaining` header tracks the global IP bucket (1000/15min), not per-token or per-account.

No information was obtained from the existing error message about how many characters the OTP is. The error message "Invalid or expired verification code" is consistent for both wrong AND expired tokens — good for avoiding oracle attacks but irrelevant to brute force since there is no limit.

If the OTP is a 6-digit numeric code (1,000,000 possibilities) with no lockout:
- At 1000 req/15min (global rate limit) = 4000/hour per IP.
- With 10 rotating IPs: 40,000/hour, full 6-digit space exhausted in ~25 hours.
- If the OTP is 4 digits (10,000 possibilities): exhausted in <15 minutes from a single IP.

## User impact

A targeted attacker who knows a victim's email (trivial — from BUG-031/032 enumeration, from the transactions/members data in BUG-029/030) can:

1. Trigger a password reset for the victim (`POST /api/proxy/users/request-password-reset`).
2. Immediately start brute-forcing the OTP.
3. On success, set a new password and take full control of the victim's chama account — including approving/rejecting transactions, reading M-Pesa history, and (via BUG-040) modifying platform roles.

The BUG-034 finding (no rate limit on the *issuance* side either) means the attacker can also keep requesting fresh OTPs to reset the expiry window while brute-forcing, turning a time-limited attack into an unlimited one.

## Root cause

The `POST /api/proxy/users/password-reset` handler validates the OTP against the DB but has no per-token or per-account attempt counter. The global IP rate limit is the only throttle, and it is far too permissive for an authentication step.

## Proposed fix

```ts
// server/controllers/auth.ts
const MAX_OTP_ATTEMPTS = 5;
const OTP_WINDOW_MS = 15 * 60_000;

export const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;
  const cacheKey = `otp_attempts:${email.toLowerCase()}`;

  const attempts = Number(await redis.get(cacheKey) ?? 0);
  if (attempts >= MAX_OTP_ATTEMPTS) {
    return res.status(429).json({
      status: 'error',
      message: 'Too many attempts. Request a new reset code.',
    });
  }

  const record = await PasswordResetToken.findOne({ email: email.toLowerCase() });
  if (!record || record.otp !== otp || record.expiresAt < new Date()) {
    await redis.incr(cacheKey);
    await redis.pexpire(cacheKey, OTP_WINDOW_MS);
    return badRequest(res, 'Invalid or expired verification code');
  }

  // Delete the token so it can't be reused
  await record.deleteOne();
  await redis.del(cacheKey);

  const user = await User.findOne({ email: email.toLowerCase() });
  user!.password = await bcrypt.hash(newPassword, 12);
  await user!.save();

  // Invalidate all existing tokens (see BUG-046)
  await revokeAllTokensForUser(user!.id);

  return res.json({ status: 'success', message: 'Password changed successfully' });
});
```

Supporting changes:
- Make the OTP at least 8 alphanumeric characters (space = 36^8 ≈ 2.8 trillion vs 10^6 for 6-digit numeric).
- Set OTP expiry to 10 minutes; lock the account for 30 minutes after 5 failed attempts.
- Ensure `POST /api/proxy/users/request-password-reset` deletes any outstanding OTP before issuing a new one, so the attacker cannot accumulate multiple valid codes.

## Verification

1. Request reset → try 6 wrong OTPs → 6th attempt returns `429 Too many attempts`.
2. Request a new reset → the old OTP is invalidated and no longer works.
3. Correct OTP on 1st attempt → password changed, old OTP deleted, user re-login required.
4. Regression test in `/recon/tests/otp-rate-limit.spec.ts`.
