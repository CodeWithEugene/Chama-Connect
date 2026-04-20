/**
 * GET /api/chamas/:code/summary
 *
 * Returns the dashboard payload: chama meta, current cycle, every member with
 * contributed/expected/status, plus the most recent payments. This is the
 * single call the live dashboard polls.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { code: string } }
) {
  const { code } = params;
  const db = getDb();
  const chama = db
    .prepare(`SELECT * FROM chamas WHERE code = ? LIMIT 1`)
    .get(code.toUpperCase()) as any;
  if (!chama) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cycle = db
    .prepare(
      `SELECT * FROM contribution_cycles
       WHERE chama_id = ? AND datetime('now') BETWEEN opens_at AND closes_at
       ORDER BY opens_at DESC LIMIT 1`
    )
    .get(chama.id) as any;

  const members = db
    .prepare(
      `SELECT u.id, u.msisdn, u.full_name, m.role,
              COALESCE(SUM(CASE WHEN p.status = 'matched' AND p.cycle_id = @cycleId THEN p.amount_cents ELSE 0 END), 0) AS contributed_cents
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN payments p ON p.user_id = u.id AND p.chama_id = @chamaId
       WHERE m.chama_id = @chamaId
       GROUP BY u.id
       ORDER BY u.full_name`
    )
    .all({ chamaId: chama.id, cycleId: cycle?.id ?? null }) as any[];

  const payments = db
    .prepare(
      `SELECT p.id, p.status, p.msisdn, p.amount_cents, p.daraja_receipt,
              p.account_ref, p.match_confidence, p.match_reason,
              p.created_at, u.full_name AS member_name, p.source
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       WHERE p.chama_id = ?
       ORDER BY p.created_at DESC
       LIMIT 50`
    )
    .all(chama.id);

  const unmatched = db
    .prepare(
      `SELECT id, msisdn, amount_cents, daraja_receipt, account_ref,
              match_confidence, match_reason, raw_payload, created_at
       FROM payments
       WHERE status = 'unmatched' AND (chama_id = ? OR chama_id IS NULL)
       ORDER BY created_at DESC LIMIT 20`
    )
    .all(chama.id);

  const totals = {
    expectedCents: (cycle?.expected_cents ?? 0) * members.length,
    contributedCents: members.reduce(
      (a, m) => a + (m.contributed_cents ?? 0),
      0
    ),
    memberCount: members.length,
  };

  return NextResponse.json({
    chama,
    cycle,
    members,
    payments,
    unmatched,
    totals,
  });
}
