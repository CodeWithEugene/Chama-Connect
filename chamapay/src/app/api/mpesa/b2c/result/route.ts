import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const db = getDb();
  db.prepare(
    `INSERT INTO daraja_callbacks (id, kind, payload, http_headers)
     VALUES (?, 'b2c_result', ?, ?)`
  ).run(
    nanoid(),
    raw,
    JSON.stringify(Object.fromEntries(req.headers.entries()))
  );

  try {
    const parsed = JSON.parse(raw);
    const result = parsed?.Result;
    if (!result) return NextResponse.json({ ResultCode: 0 });
    const rc = result.ResultCode;
    const txId = result.TransactionID as string | undefined;
    const conversation = result.ConversationID as string | undefined;

    if (rc === 0 && txId) {
      db.prepare(
        `UPDATE payments SET daraja_receipt = ?, status = 'matched'
         WHERE daraja_checkout_request_id = ? AND daraja_receipt IS NULL AND source = 'mpesa_b2c'`
      ).run(txId, conversation ?? "");
    }
  } catch (e) {
    db.prepare(
      `UPDATE daraja_callbacks SET error = ? WHERE payload = ? AND kind = 'b2c_result'`
    ).run((e as Error).message, raw);
  }
  return NextResponse.json({ ResultCode: 0 });
}
