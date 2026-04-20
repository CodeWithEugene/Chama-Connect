/**
 * Reconciliation engine.
 *
 * Given an incoming Daraja C2B confirmation, find the correct (chama, member, cycle)
 * triple with a confidence score in [0, 1]. Writes the match and a double-entry ledger
 * pair in a single transaction.
 *
 * Matching strategy (short-circuits on first high-confidence hit):
 *  1) BillRefNumber parses into <PREFIX>-<yyyymm>[-<userHint>]  → exact match, conf=1.0
 *  2) MSISDN matches exactly one active member of the chama pointed to by <PREFIX> → conf=0.9
 *  3) MSISDN matches exactly one active member across all chamas    → conf=0.75
 *  4) MSISDN matches a member who has prior payments to this chama  → conf=0.65
 *  5) Fallback: status=unmatched, kept for admin review            → conf=0
 *
 * Deterministic, idempotent, transactional. Safe to re-process any callback.
 */

import { nanoid } from "nanoid";
import { tx } from "../db/client";

export type C2BConfirmation = {
  TransactionType?: string;
  TransID: string;          // canonical idempotency key (e.g. "RFS7XYZ123")
  TransTime: string;        // yyyyMMddHHmmss
  TransAmount: string;      // e.g. "500.00"
  BusinessShortCode: string;
  BillRefNumber?: string;
  InvoiceNumber?: string;
  OrgAccountBalance?: string;
  ThirdPartyTransID?: string;
  MSISDN: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
};

export type ReconResult = {
  paymentId: string;
  status: "matched" | "unmatched" | "duplicate";
  chamaId: string | null;
  userId: string | null;
  cycleId: string | null;
  confidence: number;
  reason: string;
};

function parseAccountRef(raw: string | undefined | null) {
  if (!raw) return null;
  const parts = raw.trim().toUpperCase().split("-");
  if (parts.length < 2) return null;
  const [prefix, periodRaw, userHint] = parts;
  if (!prefix || !periodRaw) return null;
  // Accept 202604 or 2026-04 or 202604W17
  let period: string | null = null;
  if (/^\d{6}$/.test(periodRaw)) {
    period = `${periodRaw.slice(0, 4)}-${periodRaw.slice(4)}`;
  } else if (/^\d{4}\d{2}$/.test(periodRaw)) {
    period = `${periodRaw.slice(0, 4)}-${periodRaw.slice(4)}`;
  } else if (/^\d{4}-\d{2}$/.test(periodRaw)) {
    period = periodRaw;
  }
  return { prefix, period, userHint: userHint ?? null };
}

function normaliseMsisdn(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+254${digits.slice(1)}`;
  if (digits.startsWith("7") && digits.length === 9) return `+254${digits}`;
  if (raw.startsWith("+")) return raw;
  return null;
}

function toCents(amountStr: string): number {
  const n = Number(amountStr);
  if (!Number.isFinite(n)) throw new Error(`invalid amount: ${amountStr}`);
  return Math.round(n * 100);
}

export function reconcileC2B(
  payload: C2BConfirmation,
  raw: string
): ReconResult {
  return tx((db) => {
    // Idempotency: same TransID → return existing payment
    const existing = db
      .prepare<[string]>(
        `SELECT id, chama_id, user_id, cycle_id, match_confidence, match_reason, status
         FROM payments WHERE daraja_receipt = ?`
      )
      .get(payload.TransID) as any;
    if (existing) {
      return {
        paymentId: existing.id,
        status: "duplicate",
        chamaId: existing.chama_id,
        userId: existing.user_id,
        cycleId: existing.cycle_id,
        confidence: existing.match_confidence ?? 0,
        reason: existing.match_reason ?? "duplicate",
      };
    }

    const msisdn = normaliseMsisdn(payload.MSISDN);
    const amountCents = toCents(payload.TransAmount);
    const ref = parseAccountRef(payload.BillRefNumber);

    // Strategy 1 — exact parse of account reference
    let chamaId: string | null = null;
    let cycleId: string | null = null;
    let userId: string | null = null;
    let confidence = 0;
    let reason = "unmatched";

    if (ref) {
      const chama = db
        .prepare<[string, string]>(
          `SELECT id FROM chamas WHERE account_ref_prefix = ? OR code = ? LIMIT 1`
        )
        .get(ref.prefix, ref.prefix) as any;
      if (chama) {
        chamaId = chama.id;
        if (ref.period) {
          const cycle = db
            .prepare<[string, string]>(
              `SELECT id FROM contribution_cycles WHERE chama_id = ? AND period = ? LIMIT 1`
            )
            .get(chamaId!, ref.period) as any;
          if (cycle) cycleId = cycle.id;
        }
        if (ref.userHint) {
          const user = db
            .prepare<[string]>(
              `SELECT u.id FROM users u
               JOIN memberships m ON m.user_id = u.id
               WHERE m.chama_id = @chama AND substr(u.id, 1, 4) = @hint
               LIMIT 1`
            )
            .all({ chama: chamaId, hint: ref.userHint }) as any[];
          if (user.length === 1) userId = user[0].id;
        }
        if (!userId && msisdn) {
          const byMsisdn = db
            .prepare(
              `SELECT u.id FROM users u
               JOIN memberships m ON m.user_id = u.id
               WHERE m.chama_id = @chama AND u.msisdn = @msisdn
               LIMIT 1`
            )
            .get({ chama: chamaId, msisdn }) as any;
          if (byMsisdn) userId = byMsisdn.id;
        }
        confidence = userId ? 1.0 : 0.85;
        reason = userId
          ? "exact account-ref + msisdn match"
          : "account-ref match, member not resolved";
      }
    }

    // Strategy 2/3 — MSISDN-based fallbacks
    if (!userId && msisdn) {
      const matches = db
        .prepare(
          `SELECT u.id AS user_id, m.chama_id
           FROM users u JOIN memberships m ON m.user_id = u.id
           WHERE u.msisdn = ?`
        )
        .all(msisdn) as any[];
      if (matches.length === 1) {
        userId = matches[0].user_id;
        chamaId = chamaId ?? matches[0].chama_id;
        confidence = Math.max(confidence, 0.9);
        reason = "msisdn uniquely maps to one membership";
      } else if (matches.length > 1) {
        if (chamaId) {
          const inChama = matches.find((m: any) => m.chama_id === chamaId);
          if (inChama) {
            userId = inChama.user_id;
            confidence = Math.max(confidence, 0.9);
            reason = "msisdn matched multi-chama → disambiguated by account-ref chama";
          }
        }
        if (!userId) {
          // Prior-payment heuristic
          const prior = db
            .prepare(
              `SELECT user_id, chama_id, COUNT(*) AS n
               FROM payments
               WHERE msisdn = ? AND status = 'matched'
               GROUP BY user_id, chama_id
               ORDER BY n DESC LIMIT 1`
            )
            .get(msisdn) as any;
          if (prior) {
            userId = prior.user_id;
            chamaId = chamaId ?? prior.chama_id;
            confidence = Math.max(confidence, 0.65);
            reason = "msisdn + prior-payment heuristic";
          }
        }
      }
    }

    // If we have a chama but still no cycle, try the currently-open one
    if (chamaId && !cycleId) {
      const open = db
        .prepare(
          `SELECT id FROM contribution_cycles
           WHERE chama_id = ? AND datetime('now') BETWEEN opens_at AND closes_at
           LIMIT 1`
        )
        .get(chamaId) as any;
      if (open) cycleId = open.id;
    }

    const status: "matched" | "unmatched" = userId && chamaId ? "matched" : "unmatched";
    const paymentId = nanoid();
    db.prepare(
      `INSERT INTO payments (
         id, source, direction, status, msisdn, amount_cents, currency,
         daraja_receipt, account_ref, transaction_desc, raw_payload,
         chama_id, user_id, cycle_id, match_confidence, match_reason
       ) VALUES (
         @id, 'mpesa_c2b', 'credit', @status, @msisdn, @amount, 'KES',
         @receipt, @ref, @desc, @raw,
         @chamaId, @userId, @cycleId, @confidence, @reason
       )`
    ).run({
      id: paymentId,
      status,
      msisdn,
      amount: amountCents,
      receipt: payload.TransID,
      ref: payload.BillRefNumber ?? null,
      desc: payload.TransactionType ?? null,
      raw,
      chamaId,
      userId,
      cycleId,
      confidence,
      reason,
    });

    if (status === "matched") {
      // Double-entry: debit chama:cash, credit member:<uid>
      const entryInsert = db.prepare(
        `INSERT INTO ledger_entries (id, chama_id, payment_id, account, direction, amount_cents, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      entryInsert.run(
        nanoid(),
        chamaId,
        paymentId,
        `chama:${chamaId}:cash`,
        "debit",
        amountCents,
        `C2B ${payload.TransID}`
      );
      entryInsert.run(
        nanoid(),
        chamaId,
        paymentId,
        `member:${userId}`,
        "credit",
        amountCents,
        `Contribution ${payload.TransID}`
      );
    }

    db.prepare(
      `INSERT INTO audit_log (id, actor, action, subject_type, subject_id, metadata)
       VALUES (?, 'system', ?, 'payment', ?, ?)`
    ).run(
      nanoid(),
      status === "matched" ? "payment.matched" : "payment.unmatched",
      paymentId,
      JSON.stringify({ confidence, reason, amountCents })
    );

    return {
      paymentId,
      status,
      chamaId,
      userId,
      cycleId,
      confidence,
      reason,
    };
  });
}
