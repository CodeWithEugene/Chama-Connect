<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-042 — `DELETE /api/proxy/groups/:id` response embeds full M-Pesa credentials in `GroupSettings`

| Field | Value |
|---|---|
| Severity | Critical (secret exfiltration — second leak vector, extends BUG-028) |
| Surface | API / secrets management |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

After creating a test group (which any user can do — BUG-029/030), issuing `DELETE /api/proxy/groups/:id` returns the full group document including an embedded `GroupSettings` array. That array contains the same Daraja credentials as BUG-028:

```json
{
  "message": "Group closed successfully",
  "data": {
    "id": "69e5fe713e9a7937fd3ca4e5",
    ...
    "GroupSettings": [
      {
        "id":                      "69e5fe713e9a7937fd3ca4e6",
        "mpesaC2bConsumerKey":     "drm11CDSDh3jXE5qKcb3rWnqQLh2T04QVumhlANLWob8dkQn",
        "mpesaC2bConsumerSecret":  "YeNGcC6ebvT3y4yVsDcMmk5MPpHmNVASC3IZxhjVj2Cx61vPpk5gkvBaA7R7FquW",
        "mpesaC2bLipaNaMpesaShortPass": "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
        "mpesaC2bShortCode":       "174379",
        "mpesaC2bCallbackUrl":     "https://chamaconnect.io/backend/api/v1/transactions/group-contribution/mobile-money-callback",
        "mpesaC2bConfirmationUrl": "https://chamaconnect.io/backend/api/mpesa/c2b/confirmation",
        "mpesaC2bValidationUrl":   "https://chamaconnect.io/backend/api/mpesa/c2b/validation",
        "mpesaB2cConsumerKey":     "drm11CDSDh3jXE5qKcb3rWnqQLh2T04QVumhlANLWob8dkQn",
        "mpesaB2cConsumerSecret":  "YeNGcC6ebvT3y4yVsDcMmk5MPpHmNVASC3IZxhjVj2Cx61vPpk5gkvBaA7R7FquW",
        "mpesaB2cLipaNaMpesaShortPass": "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919",
        ...same for B2B...
      }
    ]
  }
}
```

The same leak likely exists in `GET /api/proxy/groups/:id` (the `GroupSettings` sub-document is populated alongside members — needs confirmation once membership check is added per BUG-029 fix).

An attacker does not need to be a member of an existing chama. They can:

1. `POST /api/proxy/groups` with any payload to create their own group (anyone can do this, requires no admin approval).
2. Immediately `DELETE` it.
3. Extract the M-Pesa credentials from the `DELETE` response body.

Total time: two HTTP requests. No rate limit. No admin oversight.

## User impact

Identical to BUG-028 — full Daraja credential exfiltration — but via a completely separate code path that would survive an incomplete fix of BUG-028 (e.g. masking `/api/proxy/settings` but forgetting `GroupSettings` in the groups response). Together, BUG-028 + BUG-042 mean the credentials are served across at least **three code paths**: `GET /settings`, `POST /settings` (error body), and `DELETE /groups/:id`.

## Root cause

The `GroupSettings` model copies platform-level M-Pesa keys into a per-group table (likely a seeded defaults table). The group controller populates `GroupSettings` in the response serialiser without filtering sensitive keys. This is the same root cause as BUG-028 but in a different controller.

## Proposed fix

1. **Immediate:** add a `select` projection to exclude sensitive fields from the `GroupSettings` populate:

```ts
// server/controllers/groups.ts — anywhere GroupSettings is populated
Group.findById(id)
  .populate({
    path: 'GroupSettings',
    select: '-mpesaC2bConsumerKey -mpesaC2bConsumerSecret -mpesaC2bLipaNaMpesaShortPass '
          + '-mpesaB2cConsumerKey -mpesaB2cConsumerSecret -mpesaB2cLipaNaMpesaShortPass '
          + '-mpesaB2bConsumerKey -mpesaB2bConsumerSecret -mpesaB2bInitiatorName '
          + '-mpesaC2bInitiatorName -mpesaC2bCallbackUrl -mpesaC2bConfirmationUrl '
          + '-mpesaC2bValidationUrl -mpesaB2cCallbackUrl -mpesaB2bCallbackUrl',
  })
```

2. **Long-term:** the same fix recommended in BUG-028 — move all M-Pesa credentials to server-side environment variables. They should never exist in any DB row (platform or group), so this populate path cannot leak them.

3. Audit every `populate()` call in the codebase for any `Settings`/`GroupSettings`/`Config` relation and add the same projection.

## Verification

1. Create a group, `DELETE` it → response body contains `GroupSettings: [{}]` with all credential fields absent (or `GroupSettings` not populated at all).
2. `GET /api/proxy/groups/:id` as a member → same: `GroupSettings` present but credential fields missing.
3. `rg 'mpesaC2bConsumerKey' server/' — results are only the Mongoose schema definition and env var mapping; no response serialiser or `populate().select()` includes it.
4. Automated test in `/recon/tests/settings-secrets.spec.ts`.
