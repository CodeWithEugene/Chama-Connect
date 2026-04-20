<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-032 — Signup enumerates registered emails via differential error message

| Field | Value |
|---|---|
| Severity | High (account enumeration) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

- URL: `POST https://chamaconnect.io/api/proxy/users/signup`

```bash
# Existing email — same payload I would send as a legitimate new user.
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signup \
    -H 'content-type: application/json' \
    --data-raw '{"firstName":"T","lastName":"U","email":"eugenegabriel.ke@gmail.com","phone":"+254711111111","password":"StrongPass123!","confirmPassword":"StrongPass123!"}'
{"status":"error","message":"Error creating user. Please use different credentials.","errors":[{"message":"Error creating user. Please use different credentials."}]}

# Unused email → signup succeeds (or returns a validation-specific error).
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signup \
    -H 'content-type: application/json' \
    --data-raw '{"firstName":"T","lastName":"U","email":"brand_new_'$RANDOM'@example.com","phone":"+2547444'$RANDOM'7","password":"StrongPass123!","confirmPassword":"StrongPass123!"}'
{"message":"User Created","status":"success","data":{ ... }}
```

The two responses differ by status (`error` vs `success`), by message content, and by body size. By iterating candidate emails (or phone numbers — the same signal fires for unique-phone collisions) an attacker confirms which addresses have accounts without ever having to log in.

Note: `POST /api/proxy/users/request-password-reset` was already hardened (same "If an account with that email exists…" string for both cases), which is the correct pattern — signup must match.

## User impact

Identical to BUG-031 but via a second vector. Because signup endpoints are usually *not* rate-limited per-account (BUG-018 already shows the site's rate limit is generous), an attacker can test tens of thousands of emails per hour. Once confirmed, they feed the list into credential stuffing (BUG-005 — no MFA) or targeted phishing. Same Kenyan DPA 2019 concern.

## Root cause

`signupController` surfaces the database's unique-index violation as a distinct human-readable error (`Error creating user. Please use different credentials.`). The legitimate alternative is to accept the request, write the record (or no-op it for existing emails) and *always* respond "If this is a new account, you'll receive a verification email shortly" — the response is identical regardless of collision.

## Proposed fix

```ts
// server/controllers/auth.ts  (signup)
try {
  const user = await User.create(payload);
  await sendActivationEmail(user);
} catch (err) {
  if (err.code === 11000 /* duplicate key */) {
    await sendAlreadyRegisteredNotice(email); // "Someone tried to sign up with your email"
  } else {
    throw err;
  }
}

return res.status(202).json({
  status: 'success',
  message: 'If this is a new account, check your inbox to finish signing up.',
  data: null,
});
```

Secondary: the error message "Error creating user. Please use different credentials." is also unhelpful for legitimate users (it doesn't tell them *which* credential was taken). The unified response above solves both problems.

Apply the same treatment to:

- `POST /api/proxy/users/signup` (email + phone + ID number collisions).
- `POST /api/proxy/users/activate` / resend-activation.
- Any "check if username available" probe if/when one is added.

## Verification

1. Post the same body twice with a freshly generated email — first response identical to second response; timing indistinguishable.
2. Post with a known-registered email — response identical to an unused email.
3. Automated test in `/recon/tests/signup-enumeration.spec.ts`.
