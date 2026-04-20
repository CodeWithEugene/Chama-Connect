<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-057 — Settings `withDrawalFee` field name inconsistency causes silent update failure

| Field | Value |
|---|---|
| Severity | Medium (data integrity — fee can be silently set to wrong value or null) |
| Surface | API / data model |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# DB stores the field as: withDrawalFee (capital D)
$ curl -sS -H "authorization: Bearer $TOKEN" https://chamaconnect.io/api/proxy/settings
{"data": [{"withDrawalFee": 1.5, ...}]}

# PUT with camelCase spelling (withdrawalFee) → SILENT FAILURE (fee not updated)
$ curl -sS -X PUT ... --data-raw '{"withdrawalFee": 50}' .../settings/:id
{"data": {"withDrawalFee": 1.5}}   # unchanged! 50 was silently dropped

# PUT with DB spelling (withDrawalFee) → fee updated, but Mongoose validation issue
$ curl -sS -X PUT ... --data-raw '{"withDrawalFee": 50}' .../settings/:id
{"data": {"withDrawalFee": null}}  # field set to null in some configurations!
```

The Mongoose model defines the field as `withDrawalFee` (inconsistent casing). The Next.js proxy layer maps the request body to the backend, but any client sending the standard `withdrawalFee` (camelCase) will silently fail to update the fee. Any client sending `withDrawalFee` may trigger a Mongoose validation path issue that nullifies the field.

This is especially dangerous because:
1. A future developer fixing BUG-027 (settings authorization) might introduce a `withdrawalFee` validator — and unintentionally make the field permanently un-updatable.
2. Platform operators who rely on the settings page to update fees may silently write nothing, believing their change was saved.
3. The ambiguity makes it difficult to write correct update code, increasing the chance of fee being set to 0 or null.

## Root cause

```ts
// server/models/settings.ts
const SettingsSchema = new Schema({
  withDrawalFee: { type: Number, default: 0 },  // ← inconsistent casing
  loanFee:       { type: Number, default: 0 },   // ← consistent
  // ...
});
```

The field name `withDrawalFee` does not follow standard camelCase (`withdrawalFee`). The controller uses one form, the model uses another, and at least one code path writes `null` when the correct-cased key is sent in the PUT body.

## Proposed fix

```ts
// 1. Rename the Mongoose field to withdrawalFee
const SettingsSchema = new Schema({
  withdrawalFee: { type: Number, default: 0 },  // ← standard camelCase
  // ...
});

// 2. Create a migration to rename existing DB records
db.settings.updateMany({}, { $rename: { withDrawalFee: 'withdrawalFee' } });

// 3. Update all references: controller, validator, frontend, documentation
```

Until the rename migration runs, accept **both spellings** in the PUT validator to avoid breaking existing integrations:

```ts
// Temporary compatibility shim in controller
const fee = req.body.withdrawalFee ?? req.body.withDrawalFee;
if (fee !== undefined) settings.withdrawalFee = fee;
```

## Verification

1. `PUT /api/proxy/settings/:id` with `{"withdrawalFee": 5}` → `withdrawalFee` in response equals `5`.
2. `GET /api/proxy/settings` → field returned as `withdrawalFee` (standard casing).
3. No silent no-op when the standard camelCase field name is sent.
4. Field cannot be set to `null` via any valid PUT payload.
