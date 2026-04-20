<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-059 — OTP Records Accumulate Without Invalidation on New Request

| Field | Value |
|---|---|
| Severity | High |
| Surface | API → `POST /api/proxy/users/request-password-reset` |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual API probe |

## Evidence

Each call to `POST /api/proxy/users/request-password-reset` creates a **new** OTP record without invalidating any previously generated OTPs. After 34 password-reset requests for the same account, all 34 OTP records remain valid simultaneously:

```bash
# Before: 33 OTP records in otpMessages
curl -X POST -H 'content-type: application/json' \
  --data '{"email":"victim@example.com"}' \
  https://chamaconnect.io/api/proxy/users/request-password-reset
# "If an account with that email exists, you will receive a reset password link"

# After: 34 OTP records — previous ones NOT invalidated
# Current-user now shows: [
#   { "token": "566372", "isExpired": "2026-04-21T10:04:56Z" },
#   { "token": "747987", "isExpired": "2026-04-21T10:07:19Z" },
#   ... (32 more, all still valid)
#   { "token": "687232", "isExpired": "2026-04-21T11:12:00Z" }
# ]
```

The `isExpired` field is a **timestamp up to which the OTP is valid**, not a boolean. All 34 OTPs expire approximately 24 hours after creation, so they all remain usable simultaneously.

**Impact when combined with BUG-058 (plaintext OTP exposure):** An attacker with a stolen JWT can read ALL 34 live OTPs and choose any one of them to reset the password, dramatically increasing the attack surface compared to a single-OTP-at-a-time system.

**Impact on OTP brute force (BUG-047):** Even if per-OTP rate limiting were implemented, the existence of 34 simultaneous valid OTPs means an attacker could rotate to the next valid OTP every time one is rate-limited.

## User impact

A chama member who requests multiple password-reset emails (e.g., because the first email was slow to arrive) inadvertently creates a growing collection of valid reset tokens. If any token is intercepted — through email compromise, API exposure (BUG-058), or social engineering — the attacker has dozens of working reset codes available, not just the latest one. This extends the window of account takeover risk from the lifetime of one OTP to the combined lifetime of all accumulated OTPs.

## Root cause

The `requestPasswordReset` handler creates a new OTP record each time it is called but never deletes or marks as expired the previous OTPs for the same user and the same message type. A correct implementation should invalidate all previous unredeemed OTPs of the same type before creating a new one.

## Proposed fix

```typescript
// passwordResetController.ts
export const requestPasswordReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email: email?.toLowerCase() });

  if (user) {
    // Invalidate all previous unexpired OTPs of this type before creating a new one
    await OtpMessage.deleteMany({
      userId: user.id,
      messageType: 'OtpPasswordReset',
      isExpired: { $gt: new Date() },
    });

    const otp = generateSixDigitOtp();
    const expiry = new Date(Date.now() + OTP_VALIDITY_MS); // e.g., 10 minutes
    await OtpMessage.create({
      userId: user.id,
      token: await bcrypt.hash(otp, 10), // hash before storage (BUG-058 fix)
      messageType: 'OtpPasswordReset',
      isExpired: expiry,
    });

    await sendPasswordResetEmail(user.email, otp);
  }

  // Always return the same response regardless of whether user exists
  return res.json({ status: 'success', message: 'If an account with that email exists, you will receive a reset password link' });
});
```

## Verification

1. Request two consecutive password resets for the same email.
2. Call `GET /api/proxy/users/current-user`.
3. Confirm that `otpMessages` contains **exactly one** active OTP (the most recently generated one).
4. Confirm that attempting to use the first OTP after requesting the second fails with an appropriate error.
