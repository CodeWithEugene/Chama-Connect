/**
 * POST /api/dev/simulate-c2b
 *
 * Generates a fake Daraja C2B confirmation and passes it through the real
 * reconciliation engine. Lets us demo end-to-end without live Daraja creds.
 *
 * Body (all fields optional):
 *   { msisdn?, amount?, billRef?, transId? }
 *
 * Enabled only when NODE_ENV !== 'production'.
 */

import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { reconcileC2B } from "@/lib/reconciliation/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "disabled in production" },
      { status: 403 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const ts = new Date();
  const fmt = (n: number) => n.toString().padStart(2, "0");
  const TransTime =
    ts.getFullYear().toString() +
    fmt(ts.getMonth() + 1) +
    fmt(ts.getDate()) +
    fmt(ts.getHours()) +
    fmt(ts.getMinutes()) +
    fmt(ts.getSeconds());
  const payload = {
    TransactionType: "Pay Bill",
    TransID: body.transId ?? `SIM${nanoid(8).toUpperCase()}`,
    TransTime,
    TransAmount: (body.amount ?? 500).toFixed(2),
    BusinessShortCode: process.env.DARAJA_BUSINESS_SHORTCODE ?? "174379",
    BillRefNumber: body.billRef ?? "ACME-202604",
    MSISDN: body.msisdn ?? "254711223344",
    FirstName: "Simulated",
    MiddleName: "",
    LastName: "Payer",
  };
  const raw = JSON.stringify(payload);
  const result = reconcileC2B(payload as any, raw);
  return NextResponse.json({ payload, result });
}
