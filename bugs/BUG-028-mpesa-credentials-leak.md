<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-028 — `/api/proxy/settings` returns full M-Pesa Daraja credentials to any authenticated user

| Field | Value |
|---|---|
| Severity | **Critical (secret exfiltration)** |
| Surface | API / secrets management |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

- URL: `GET https://chamaconnect.io/api/proxy/settings`
- Auth context: a freshly-signed-up regular `User` account (no chama membership, no elevated role).
- Response body (`status: 200`, 2 053 bytes) includes:

```json
{
  "mpesaC2bConsumerKey":         "drm11CDSDh3jXE5qKcb3rWnqQLh2T04QVumhlANLWob8dkQn",
  "mpesaC2bConsumerSecret":      "YeNGcC6ebvT3y4yVsDcMmk5MPpHmNVASC3IZxhjVj2Cx61vPpk5gkvBaA7R7FquW",
  "mpesaC2bLipaNaMpesaShortPass":"bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  "mpesaC2bShortCode":           "174379",
  "mpesaC2bEnvironment":         "sandbox",
  "mpesaC2bInitiatorName":       "Chama Connect App",
  "mpesaC2bCallbackUrl":         "https://chamaconnect.io/backend/api/v1/transactions/group-contribution/mobile-money-callback",
  "mpesaC2bConfirmationUrl":     "https://chamaconnect.io/backend/api/mpesa/c2b/confirmation",
  "mpesaC2bValidationUrl":       "https://chamaconnect.io/backend/api/mpesa/c2b/validation",

  "mpesaB2cConsumerKey":         "drm11CDSDh3jXE5qKcb3rWnqQLh2T04QVumhlANLWob8dkQn",
  "mpesaB2cConsumerSecret":      "YeNGcC6ebvT3y4yVsDcMmk5MPpHmNVASC3IZxhjVj2Cx61vPpk5gkvBaA7R7FquW",
  "mpesaB2cLipaNaMpesaShortPass":"bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
  ...
  "mpesaB2bConsumerKey":         "drm11CDSDh3jXE5qKcb3rWnqQLh2T04QVumhlANLWob8dkQn",
  "mpesaB2bConsumerSecret":      "YeNGcC6ebvT3y4yVsDcMmk5MPpHmNVASC3IZxhjVj2Cx61vPpk5gkvBaA7R7FquW"
}
```

- Reproduction:

```bash
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/settings \
  | jq '.data[0] | {mpesaC2bConsumerKey, mpesaC2bConsumerSecret, mpesaC2bLipaNaMpesaShortPass}'
```

Values match verbatim in every field I inspected. The same values are also echoed back in the successful `PUT` response (see BUG-027) and in the `POST` "App settings already exist" error payload — the backend leaks the secrets on three code paths.

## User impact

`ConsumerKey` + `ConsumerSecret` are how Safaricom Daraja authenticates the platform. Whoever owns them can:

- Mint a Daraja access token and **initiate STK pushes, B2C disbursements, or C2B simulations impersonating ChamaConnect**, charging any MSISDN up to the shortcode's daily limit.
- Submit arbitrary URL registrations (`/v1/registerurl`) and hijack callbacks for the production shortcode once the platform graduates from the sandbox `174379`.
- Use the `LipaNaMpesaShortPass` to sign `Password` fields for STK pushes without ever touching the ChamaConnect servers.

Even though the `Environment` is currently `sandbox` (so the shortcode/passkey correspond to Safaricom's public sandbox credentials, and in practice the leak today is the *pattern* rather than production funds), the moment the operator switches to production, every signed-in user receives the live keys in their browser. This is one form-submit away from payment theft on a real money product.

Secondary impact: the callback URLs expose the internal backend path `/backend/api/v1/...`, confirming BUG-033 (the backend is reachable directly).

## Root cause

The settings document is a singleton used by server-side integrations (Daraja SDK); the `GET /api/proxy/settings` handler serialises the entire row with no projection, and no role gate. The backend author probably intended the route to feed an **admin** settings page, but the same response is served to every authenticated caller.

## Proposed fix

1. Split the settings document in two:
   - **Public/tenant-level** policy fields (`loanFee`, `withDrawalFee`, `fineDelayPercentageIncrement`) — keep on `/settings`, read-only for non-admins.
   - **Infra secrets** (`mpesa*ConsumerKey`, `mpesa*ConsumerSecret`, `mpesa*LipaNaMpesaShortPass`, callback URLs) — **move to server-side environment variables** or a secrets store (Doppler, AWS Secrets Manager, Fly.io secrets). They are not policy; they are deployment configuration.

2. While the migration is pending, mask secrets on read and admin-gate the route:

```ts
// server/controllers/settings.ts
const MASK = '****';
const SENSITIVE = [
  'mpesaC2bConsumerKey','mpesaC2bConsumerSecret','mpesaC2bLipaNaMpesaShortPass','mpesaC2bInitiatorName',
  'mpesaB2cConsumerKey','mpesaB2cConsumerSecret','mpesaB2cLipaNaMpesaShortPass','mpesaB2cInitiatorName',
  'mpesaB2bConsumerKey','mpesaB2bConsumerSecret','mpesaB2bInitiatorName',
];

export const getSettings = asyncHandler(async (req, res) => {
  const row = await Settings.findOne();
  const isAdmin = req.user?.role?.name === 'SuperAdmin';
  const body = row?.toObject() ?? {};
  if (!isAdmin) for (const k of SENSITIVE) body[k] = MASK;
  return res.json({ status: 'success', message: 'Settings retrieved', data: [body] });
});
```

3. Rotate the current Daraja keys (even the sandbox ones) because they are now public in every PR/issue referencing this bug and every browser cache that has hit `/api/proxy/settings`.

## Verification

1. Sign in as a regular `User` → `GET /api/proxy/settings` → all M-Pesa credential fields are `****` (or, preferably, absent from the payload).
2. Sign in as `SuperAdmin` on the admin page → the real values are rendered only in the admin UI, never on the public API.
3. Search the repo: `rg 'mpesa.*Consumer(Key|Secret)'` should return only test fixtures and a single `process.env` reference.
4. Regression test in `/recon/tests/settings-secrets.spec.ts`.
