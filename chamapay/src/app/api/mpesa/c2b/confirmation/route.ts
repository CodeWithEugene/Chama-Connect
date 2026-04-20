/**
 * Daraja C2B Confirmation webhook.
 *
 * Safaricom POSTs here once a paybill payment has been fully cleared. We:
 *  1. Persist the raw callback for audit.
 *  2. Run the reconciliation engine → match payment to (chama, member, cycle).
 *  3. Write a double-entry ledger pair on match.
 *  4. Respond with the Safaricom-expected ack shape IMMEDIATELY (< 5s SLA).
 *
 * Under no circumstances do we let an exception propagate: a 500 here causes
 * Safaricom to retry and can result in duplicate credits if we're not careful.
 * Idempotency is enforced at the engine (unique constraint on daraja_receipt).
 */

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db/client";
import { reconcileC2B, C2BConfirmation } from "@/lib/reconciliation/engine";
import { queueSms } from "@/lib/sms/outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFARICOM_ACK = {
  ResultCode: 0,
  ResultDesc: "Confirmation received successfully",
};

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const db = getDb();

  db.prepare(
    `INSERT INTO daraja_callbacks (id, kind, payload, http_headers)
     VALUES (?, 'c2b_confirmation', ?, ?)`
  ).run(
    nanoid(),
    raw,
    JSON.stringify(Object.fromEntries(req.headers.entries()))
  );

  let parsed: C2BConfirmation;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Still ACK — we don't want Safaricom retry storms; we'll inspect in daraja_callbacks.
    return NextResponse.json(SAFARICOM_ACK);
  }

  try {
    const result = reconcileC2B(parsed, raw);

    if (result.status === "matched" && result.userId) {
      const user = db
        .prepare("SELECT msisdn, full_name FROM users WHERE id = ?")
        .get(result.userId) as any;
      if (user?.msisdn) {
        queueSms(
          user.msisdn,
          `Thanks ${user.full_name?.split(" ")[0] ?? ""}! KES ${Number(parsed.TransAmount).toLocaleString()} contribution received (ref ${parsed.TransID}). Chamapay/ChamaConnect.`
        );
      }
    }
  } catch (e) {
    // Log and still ACK — a crashed handler must not retry-loop Safaricom.
    db.prepare(
      `UPDATE daraja_callbacks SET error = ? WHERE payload = ? AND kind = 'c2b_confirmation'`
    ).run((e as Error).message, raw);
  }

  return NextResponse.json(SAFARICOM_ACK);
}
