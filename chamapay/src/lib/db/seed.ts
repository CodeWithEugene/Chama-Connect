import { nanoid } from "nanoid";
import { getDb, tx } from "./client";

// Idempotent demo seed: wipes + re-inserts. Safe to re-run.
function run() {
  const db = getDb();

  tx(() => {
    for (const table of [
      "audit_log",
      "anchors",
      "sms_outbox",
      "daraja_callbacks",
      "loans",
      "ledger_entries",
      "payments",
      "contribution_cycles",
      "memberships",
      "chamas",
      "users",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    const chama = {
      id: nanoid(),
      code: "ACME",
      name: "Acme Savers Chama",
      paybill: "174379", // Daraja sandbox shortcode
      account_ref_prefix: "ACME",
      contribution_cents: 500_00, // KES 500.00
      cycle: "monthly",
      late_fee_cents: 50_00,
    };
    db.prepare(
      `INSERT INTO chamas (id, code, name, paybill, account_ref_prefix, contribution_cents, cycle, late_fee_cents)
       VALUES (@id, @code, @name, @paybill, @account_ref_prefix, @contribution_cents, @cycle, @late_fee_cents)`
    ).run(chama);

    const members = [
      { msisdn: "+254708374149", full_name: "Alice Wanjiru", role: "chair" },
      { msisdn: "+254711223344", full_name: "Brian Otieno", role: "treasurer" },
      { msisdn: "+254722334455", full_name: "Caroline Mutua", role: "member" },
      { msisdn: "+254733445566", full_name: "David Kiptoo", role: "member" },
      { msisdn: "+254744556677", full_name: "Esther Njoki", role: "member" },
    ];
    const insertUser = db.prepare(
      `INSERT INTO users (id, msisdn, full_name, role) VALUES (?, ?, ?, ?)`
    );
    const insertMembership = db.prepare(
      `INSERT INTO memberships (id, chama_id, user_id, role) VALUES (?, ?, ?, ?)`
    );
    for (const m of members) {
      const uid = nanoid();
      insertUser.run(uid, m.msisdn, m.full_name, m.role);
      insertMembership.run(nanoid(), chama.id, uid, m.role);
    }

    // Open cycle for April 2026
    const cycle = {
      id: nanoid(),
      chama_id: chama.id,
      period: "2026-04",
      opens_at: "2026-04-01T00:00:00Z",
      closes_at: "2026-04-30T23:59:59Z",
      expected_cents: chama.contribution_cents,
    };
    db.prepare(
      `INSERT INTO contribution_cycles (id, chama_id, period, opens_at, closes_at, expected_cents)
       VALUES (@id, @chama_id, @period, @opens_at, @closes_at, @expected_cents)`
    ).run(cycle);

    console.log(
      `[seed] chama=${chama.code} (${chama.id}) members=${members.length} cycle=${cycle.period}`
    );
  });
}

run();
