/**
 * POST /api/chamas/:code/contribute
 *
 * Trigger an STK Push for the current open cycle of the named chama.
 * Body: { msisdn: "+2547...", amount?: number }
 *
 * Returns the Daraja response plus a local payment id that the client can
 * poll until the STK callback lands.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db/client";
import { DarajaClient, buildAccountRef } from "@/lib/daraja/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  msisdn: z.string().min(10),
  amount: z.number().int().positive().optional(),
});

function msisdnFor254(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 9) return `254${digits}`;
  return digits;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { code: string } }
) {
  const { code } = params;
  const db = getDb();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { msisdn, amount } = parsed.data;

  const chama = db
    .prepare(`SELECT * FROM chamas WHERE code = ? LIMIT 1`)
    .get(code.toUpperCase()) as any;
  if (!chama) {
    return NextResponse.json({ error: "chama not found" }, { status: 404 });
  }

  const open = db
    .prepare(
      `SELECT * FROM contribution_cycles
       WHERE chama_id = ? AND datetime('now') BETWEEN opens_at AND closes_at
       LIMIT 1`
    )
    .get(chama.id) as any;

  const accountRef = buildAccountRef(
    chama.account_ref_prefix,
    open?.period ?? new Date().toISOString().slice(0, 7)
  );
  const amountKes = amount ?? Math.round(chama.contribution_cents / 100);

  let daraja;
  try {
    daraja = DarajaClient.fromEnv();
  } catch (e) {
    return NextResponse.json(
      {
        error: "Daraja not configured",
        hint: "Fill DARAJA_* values in .env.local to run live STK Push",
        details: (e as Error).message,
      },
      { status: 503 }
    );
  }

  try {
    const resp = await daraja.stkPush({
      msisdn: msisdnFor254(msisdn),
      amount: amountKes,
      accountReference: accountRef,
      transactionDesc: `Chama ${chama.code}`,
    });

    // Record a pending row so the STK callback can find us
    const paymentId = nanoid();
    db.prepare(
      `INSERT INTO payments (
         id, source, direction, status, msisdn, amount_cents, currency,
         daraja_merchant_request_id, daraja_checkout_request_id,
         account_ref, transaction_desc, raw_payload,
         chama_id, cycle_id, match_confidence, match_reason
       ) VALUES (
         ?, 'mpesa_stk', 'credit', 'pending', ?, ?, 'KES',
         ?, ?, ?, ?, ?, ?, ?, 0, 'pending stk push'
       )`
    ).run(
      paymentId,
      `+${msisdnFor254(msisdn)}`,
      amountKes * 100,
      resp.MerchantRequestID,
      resp.CheckoutRequestID,
      accountRef,
      `STK ${chama.code}`,
      JSON.stringify(resp),
      chama.id,
      open?.id ?? null
    );

    return NextResponse.json({ paymentId, accountRef, daraja: resp });
  } catch (e: any) {
    return NextResponse.json(
      {
        error: "stk_push_failed",
        details: e?.response?.data ?? e.message,
      },
      { status: 502 }
    );
  }
}
