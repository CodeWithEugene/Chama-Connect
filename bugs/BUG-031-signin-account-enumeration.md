<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-031 — Signin reveals whether an account exists (differential error + response-size side channel)

| Field | Value |
|---|---|
| Severity | High (account enumeration) |
| Surface | Auth / API |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

- URL: `POST https://chamaconnect.io/api/proxy/users/signin`

Two back-to-back requests with the **same** wrong password:

```bash
# Known account (mine)
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signin \
    -H 'content-type: application/json' \
    --data-raw '{"email":"eugenegabriel.ke@gmail.com","password":"WRONG"}'
{"status":"error","message":"Incorrect password","errors":[{"message":"Incorrect password"}]}
# size=93

# Email that is not registered
$ curl -sS -X POST https://chamaconnect.io/api/proxy/users/signin \
    -H 'content-type: application/json' \
    --data-raw '{"email":"totallyfake@xyz.com","password":"WRONG"}'
{"status":"error","message":"Invalid email or phone number","errors":[{"message":"Invalid email or phone number"}]}
# size=115
```

- HTTP status is 400 in both cases, but:
  - **Message is different** (`Incorrect password` vs `Invalid email or phone number`).
  - **Content-Length is different** (93 vs 115 bytes) — measurable even if the message were identical.
- Timing side channel observed across 3 pairs: valid-email responses took 0.50–1.00 s, invalid-email responses 0.42–0.52 s (password hash comparison only runs on a real user record).
- No per-account lockout and a 1000 req / 15 min per-IP limit (see BUG-018), so an attacker can enumerate ~4 000 email addresses / hour / IP. Kenya has 60+ million phone numbers; the attacker can iterate `+25470xxxxxxx` against this endpoint to harvest every registered phone on the platform.

## User impact

Account enumeration is the **first step** in credential-stuffing and targeted phishing campaigns. Once an attacker confirms an address is registered on ChamaConnect they can:

- Fire tailored SMS/email phishing that references "your chama on ChamaConnect" (social-engineering that is far more effective than cold phishing).
- Replay credentials leaked in other breaches (HaveIBeenPwned says >800 M Kenyan-resident credentials are circulating) against only the accounts that are known to exist here — multiplying the success rate by 10–50×.
- Build a list of every user by iterating the Kenyan phone range, which amplifies BUG-029 (once you know a user is here, you can find their chama via other BOLA endpoints).

Combined with **BUG-018** (permissive rate limit) and **BUG-005** (no MFA), enumeration plus credential stuffing is a straight line from "attacker has a breach corpus" to "attacker is logged into Kenyan chama accounts".

## Root cause

The signin controller short-circuits:

```ts
const user = await User.findOne({ email }).select('+password');
if (!user) return badRequest(res, 'Invalid email or phone number');
const ok = await bcrypt.compare(password, user.password);
if (!ok)  return badRequest(res, 'Incorrect password');
```

Two code paths produce two distinct responses (and two different wall-clock times, because `bcrypt.compare` only runs on the valid-email path).

## Proposed fix

Return a single, uniform error for both cases, always at the same cost:

```ts
// server/controllers/auth.ts
const GENERIC = 'Invalid email, phone number or password';
const DUMMY_HASH = '$2b$12$0000000000000000000000000000000000000000000000000000';

export const signin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+password');
  const hash = user?.password ?? DUMMY_HASH;
  const ok  = await bcrypt.compare(password, hash); // always runs
  if (!user || !ok) return unauthorized(res, GENERIC); // always 401, identical shape
  ...
});
```

Also:

1. Return `401 Unauthorized`, not `400 Bad Request`, for credential failures (REST semantics).
2. Normalise the response body to always be `{"status":"error","message":"Invalid email, phone number or password","errors":[{"message":"Invalid email, phone number or password"}]}` regardless of which check failed — so `Content-Length` is identical.
3. Apply the same uniformity to the **phone-number** signin path and to the activation / resend-verification endpoints.
4. Tighten per-account rate limits once BUG-018 is addressed.

## Verification

1. `curl` signin with three pairs (known-email/wrong-password, unknown-email/wrong-password, known-phone/wrong-password). Response body, status code, and `Content-Length` must match byte-for-byte.
2. Measure `time_total` over 10 000 requests; the 50/90/99th percentile must be indistinguishable between pairs (±10 ms).
3. Regression test in `/recon/tests/auth-enumeration.spec.ts`.
