/**
 * Daraja STK Push callback.
 *
 * Payload shape (success):
 * {
 *   "Body": {
 *     "stkCallback": {
 *       "MerchantRequestID": "...",
 *       "CheckoutRequestID": "...",
 *       "ResultCode": 0,
 *       "ResultDesc": "The service request is processed successfully.",
 *       "CallbackMetadata": {
 *         "Item": [
 *           { "Name": "Amount", "Value": 500 },
 *           { "Name": "MpesaReceiptNumber", "Value": "RFS7XYZ..." },
 *           { "Name": "TransactionDate", "Value": 20260420123456 },
 *           { "Name": "PhoneNumber", "Value": 254712345678 }
 *         ]
 *       }
 *     }
 *   }
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db/client";
import { reconcileC2B } from "@/lib/reconciliation/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StkItem = { Name: string; Value: string | number };

function toC2BShape(raw: any, accountRef: string | null) {
  const cb = raw?.Body?.stkCallback;
  if (!cb) return null;
  const items: StkItem[] = cb.CallbackMetadata?.Item ?? [];
  const pick = (n: string) =>
    items.find((i) => i.Name === n)?.Value;
  const amount = Number(pick("Amount") ?? 0);
  const receipt = String(pick("MpesaReceiptNumber") ?? "");
  const phone = String(pick("PhoneNumber") ?? "");
  const date = String(pick("TransactionDate") ?? "");
  if (!receipt) return null;
  return {
    TransactionType: "CustomerPayBillOnline",
    TransID: receipt,
    TransTime: date,
    TransAmount: amount.toFixed(2),
    BusinessShortCode: String(process.env.DARAJA_BUSINESS_SHORTCODE ?? ""),
    BillRefNumber: accountRef ?? undefined,
    MSISDN: phone,
  };
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const db = getDb();
  db.prepare(
    `INSERT INTO daraja_callbacks (id, kind, payload, http_headers)
     VALUES (?, 'stk_callback', ?, ?)`
  ).run(
    nanoid(),
    raw,
    JSON.stringify(Object.fromEntries(req.headers.entries()))
  );

  try {
    const parsed = JSON.parse(raw);
    const cb = parsed?.Body?.stkCallback;
    if (cb?.ResultCode !== 0) {
      // Non-zero → user cancelled or timed out. Nothing to reconcile.
      return NextResponse.json({
        ResultCode: 0,
        ResultDesc: "acknowledged",
      });
    }

    // Find the pending STK row by CheckoutRequestID to recover the account ref
    const pending = db
      .prepare(
        `SELECT account_ref FROM payments WHERE daraja_checkout_request_id = ? LIMIT 1`
      )
      .get(cb.CheckoutRequestID) as any;

    const c2b = toC2BShape(parsed, pending?.account_ref ?? null);
    if (c2b) reconcileC2B(c2b as any, raw);

    // Update pending row, if any, with the final receipt number
    if (pending && c2b) {
      db.prepare(
        `UPDATE payments SET daraja_receipt = ?, status = 'matched'
         WHERE daraja_checkout_request_id = ? AND daraja_receipt IS NULL`
      ).run(c2b.TransID, cb.CheckoutRequestID);
    }
  } catch (e) {
    db.prepare(
      `UPDATE daraja_callbacks SET error = ? WHERE payload = ? AND kind = 'stk_callback'`
    ).run((e as Error).message, raw);
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: "acknowledged" });
}
