<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-056 — `NaN` / `Infinity` in numeric fields crashes API handlers with `500 Internal Server Error`

| Field | Value |
|---|---|
| Severity | Medium (availability — DoS on any numeric-field endpoint) |
| Surface | API / input validation |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

```bash
# NaN in transaction amount → 500
$ curl -sS -X POST https://chamaconnect.io/api/proxy/transactions \
    -H "authorization: Bearer $USER_TOKEN" -H 'content-type: application/json' \
    --data-raw '{"groupId":"...","transactionType":"CONTRIBUTION","amount":NaN,...}'
{"status":"error","message":"Internal Server Error","errors":[{"message":"Internal Server Error"}]}
# HTTP 500

# Infinity and -Infinity also crash:
# amount: Infinity → 500
# amount: -Infinity → 500

# Any numeric field with NaN crashes the handler:
# narration: NaN → 500
# transactionType: NaN → 500
# method: NaN → 500
# description: NaN → 500
```

JSON technically permits `NaN` and `Infinity` as bare tokens (they are valid JavaScript literals), but these are not valid JSON values per RFC 8259. However, many JSON parsers (including Node.js `JSON.parse`) accept them as input. When the parsed `NaN` / `Infinity` value reaches Mongoose's `Number` field validator, it either stores as `NaN` (which MongoDB cannot handle) or throws a validation error that the global error handler fails to catch cleanly, producing a `500`.

An attacker can use this to cause sustained `500` responses on any endpoint that accepts numeric fields — effectively a targeted DoS. The logs will be flooded with stack traces, obscuring legitimate errors and degrading observability.

## User impact

- Targeted DoS: fire 1000 requests per 15 minutes (global rate limit) against any numeric-field endpoint, generating 1000 server errors and stack traces.
- Any automated retry logic in the frontend would amplify the load.
- Obscures real errors in monitoring tools.

## Root cause

No type coercion or `isFinite` validation before the payload reaches Mongoose. Express's `express.json()` middleware accepts `NaN` tokens (Node.js JSON.parse quirk), and the controller trusts the value without checking.

## Proposed fix

```ts
// server/validators/transaction.ts
import { body } from 'express-validator';

export const createTransactionValidator = [
  body('amount')
    .exists().withMessage('Amount is required')
    .isFloat({ min: 0.01 })  // rejects NaN, Infinity, 0, negatives
    .withMessage('Amount must be a positive number'),
  body('transactionType')
    .isString().notEmpty(),
  body('narration').optional().isString(),
  // ...
];

// Alternative: global request sanitiser
app.use((req, res, next) => {
  const sanitise = (v: unknown): unknown => {
    if (typeof v === 'number' && !isFinite(v)) return null;
    if (Array.isArray(v)) return v.map(sanitise);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, sanitise(val)])
      );
    }
    return v;
  };
  req.body = sanitise(req.body);
  next();
});
```

## Verification

1. `POST /api/proxy/transactions` with `amount: NaN` → `400 Bad Request` (not `500`).
2. `POST /api/proxy/transactions` with `amount: Infinity` → `400 Bad Request`.
3. `POST /api/proxy/transactions` with `amount: -Infinity` → `400 Bad Request`.
4. `POST /api/proxy/transactions` with `amount: 0` → `400 Bad Request` (below minimum).
5. `POST /api/proxy/transactions` with `amount: 100` → normal flow (not affected by the fix).
