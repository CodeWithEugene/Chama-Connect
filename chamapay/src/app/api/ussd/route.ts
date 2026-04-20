/**
 * Africa's Talking USSD handler.
 *
 * Africa's Talking POSTs form-urlencoded fields:
 *   sessionId, serviceCode, phoneNumber, text
 *
 * `text` is the full history joined with '*'. Examples:
 *   ""          → top-level menu
 *   "1"         → user picked option 1
 *   "1*500"     → user picked option 1, then typed 500
 *
 * Reply MUST start with `CON ` to keep the session open or `END ` to terminate.
 * Keep every screen under 182 characters.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { DarajaClient, buildAccountRef } from "@/lib/daraja/client";
import { nanoid } from "nanoid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normaliseMsisdn(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+254${digits.slice(1)}`;
  return `+${digits}`;
}

function respond(text: string, contentType = "text/plain"): Response {
  return new Response(text, { headers: { "content-type": contentType } });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const phoneNumber = String(form.get("phoneNumber") ?? "");
  const text = String(form.get("text") ?? "");
  const sessionId = String(form.get("sessionId") ?? "");
  const msisdn = normaliseMsisdn(phoneNumber);

  const db = getDb();
  const membership = db
    .prepare(
      `SELECT u.id AS user_id, u.full_name, c.id AS chama_id, c.code, c.name, c.paybill, c.contribution_cents, c.account_ref_prefix
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN chamas c ON c.id = m.chama_id
       WHERE u.msisdn = ?
       LIMIT 1`
    )
    .get(msisdn) as any;

  if (!membership) {
    return respond(
      `END You are not registered with any chama on ChamaPay.\nPhone: ${msisdn}\nCall +254-714-731-015 to join.`
    );
  }

  const steps = text === "" ? [] : text.split("*");
  const top = steps[0];

  // Top-level menu
  if (steps.length === 0) {
    return respond(
      `CON ChamaPay — ${membership.name}\n1. My balance\n2. Contribute\n3. Request loan\n4. Recent payments\n5. Exit`
    );
  }

  if (top === "1") {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(p.amount_cents), 0) AS total
         FROM payments p
         WHERE p.chama_id = ? AND p.user_id = ? AND p.status = 'matched'`
      )
      .get(membership.chama_id, membership.user_id) as any;
    const total = (row?.total ?? 0) / 100;
    const expected = membership.contribution_cents / 100;
    return respond(
      `END Hi ${membership.full_name?.split(" ")[0] ?? "member"}.\nContributed this cycle: KES ${total.toLocaleString()}.\nExpected: KES ${expected.toLocaleString()}.`
    );
  }

  if (top === "2") {
    // 2 → ask amount → trigger STK
    if (steps.length === 1) {
      const expected = membership.contribution_cents / 100;
      return respond(
        `CON Contribute to ${membership.name}.\nEnter amount (KES) or 0 to use ${expected.toLocaleString()}:`
      );
    }
    if (steps.length === 2) {
      const typed = Number(steps[1]);
      const amount =
        Number.isFinite(typed) && typed > 0
          ? Math.round(typed)
          : Math.round(membership.contribution_cents / 100);
      const period = new Date().toISOString().slice(0, 7);
      const ref = buildAccountRef(membership.account_ref_prefix, period);
      try {
        const daraja = DarajaClient.fromEnv();
        const r = await daraja.stkPush({
          msisdn: phoneNumber.replace(/\D/g, ""),
          amount,
          accountReference: ref,
          transactionDesc: `USSD ${membership.code}`,
        });
        db.prepare(
          `INSERT INTO payments (
             id, source, direction, status, msisdn, amount_cents, currency,
             daraja_merchant_request_id, daraja_checkout_request_id,
             account_ref, transaction_desc, raw_payload,
             chama_id, user_id, match_confidence, match_reason
           ) VALUES (
             ?, 'mpesa_stk', 'credit', 'pending', ?, ?, 'KES',
             ?, ?, ?, ?, ?, ?, ?, 0, 'ussd initiated'
           )`
        ).run(
          nanoid(),
          msisdn,
          amount * 100,
          r.MerchantRequestID,
          r.CheckoutRequestID,
          ref,
          "USSD STK",
          JSON.stringify(r),
          membership.chama_id,
          membership.user_id
        );
        return respond(
          `END Sent M-Pesa prompt to ${phoneNumber}.\nKES ${amount.toLocaleString()} to paybill ${membership.paybill}, ref ${ref}. Enter PIN to confirm.`
        );
      } catch (e) {
        return respond(
          `END Could not start STK: ${(e as Error).message}.\nTry paying to paybill ${membership.paybill}, ref ${ref}.`
        );
      }
    }
  }

  if (top === "3") {
    if (steps.length === 1) {
      return respond(
        `CON Request a loan from ${membership.name}.\nEnter amount (KES):`
      );
    }
    const amount = Number(steps[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      return respond(`END Invalid amount.`);
    }
    const loanId = nanoid();
    db.prepare(
      `INSERT INTO loans (id, chama_id, borrower_id, principal_cents, interest_bps, term_months, status)
       VALUES (?, ?, ?, ?, 500, 3, 'requested')`
    ).run(loanId, membership.chama_id, membership.user_id, Math.round(amount * 100));
    return respond(
      `END Loan request submitted: KES ${amount.toLocaleString()} × 3 months @ 5%.\nTreasurer will review. Ref ${loanId.slice(0, 6)}.`
    );
  }

  if (top === "4") {
    const rows = db
      .prepare(
        `SELECT amount_cents, created_at FROM payments
         WHERE user_id = ? AND chama_id = ? AND status = 'matched'
         ORDER BY created_at DESC LIMIT 5`
      )
      .all(membership.user_id, membership.chama_id) as any[];
    if (!rows.length) return respond(`END No matched payments yet.`);
    const lines = rows
      .map(
        (r) =>
          `${r.created_at.slice(5, 10)} KES ${(r.amount_cents / 100).toLocaleString()}`
      )
      .join("\n");
    return respond(`END Last payments:\n${lines}`);
  }

  if (top === "5") {
    return respond(`END Asante.`);
  }

  return respond(`END Unknown option.`);
}
