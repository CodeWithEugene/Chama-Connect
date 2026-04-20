import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { reconcileC2B, C2BConfirmation } from "./engine";
import { getDb, closeDb } from "../db/client";
import { nanoid } from "nanoid";

function makeC2B(overrides: Partial<C2BConfirmation> = {}): C2BConfirmation {
  return {
    TransactionType: "Pay Bill",
    TransID: `TX${nanoid(6).toUpperCase()}`,
    TransTime: "20260420120000",
    TransAmount: "500.00",
    BusinessShortCode: "174379",
    BillRefNumber: "ACME-202604",
    MSISDN: "254711223344",
    FirstName: "Test",
    ...overrides,
  };
}

function setupSchema() {
  const db = getDb();
  const sql = fs.readFileSync(
    path.resolve(__dirname, "../db/schema.sql"),
    "utf8"
  );
  db.exec(sql);
}

function seedOneChama() {
  const db = getDb();
  const chamaId = nanoid();
  db.prepare(
    `INSERT INTO chamas (id, code, name, paybill, account_ref_prefix, contribution_cents) VALUES (?, 'ACME', 'Acme', '174379', 'ACME', 50000)`
  ).run(chamaId);

  const alice = nanoid();
  db.prepare(
    `INSERT INTO users (id, msisdn, full_name) VALUES (?, '+254711223344', 'Alice')`
  ).run(alice);
  db.prepare(
    `INSERT INTO memberships (id, chama_id, user_id) VALUES (?, ?, ?)`
  ).run(nanoid(), chamaId, alice);

  const bob = nanoid();
  db.prepare(
    `INSERT INTO users (id, msisdn, full_name) VALUES (?, '+254722334455', 'Bob')`
  ).run(bob);
  db.prepare(
    `INSERT INTO memberships (id, chama_id, user_id) VALUES (?, ?, ?)`
  ).run(nanoid(), chamaId, bob);

  // Open cycle 2026-04
  db.prepare(
    `INSERT INTO contribution_cycles (id, chama_id, period, opens_at, closes_at, expected_cents) VALUES (?, ?, '2026-04', '2026-04-01T00:00:00Z', '2026-12-31T23:59:59Z', 50000)`
  ).run(nanoid(), chamaId);

  return { chamaId, alice, bob };
}

describe("reconcileC2B", () => {
  beforeEach(() => {
    const tmp = path.join(
      os.tmpdir(),
      `chamapay-test-${nanoid(6)}.sqlite`
    );
    process.env.DATABASE_URL = `file:${tmp}`;
    closeDb();
    setupSchema();
  });

  it("matches exact account-ref + msisdn with confidence 1.0", () => {
    const { chamaId, alice } = seedOneChama();
    const payload = makeC2B({
      MSISDN: "254711223344",
      BillRefNumber: "ACME-202604",
    });
    const r = reconcileC2B(payload, JSON.stringify(payload));
    expect(r.status).toBe("matched");
    expect(r.chamaId).toBe(chamaId);
    expect(r.userId).toBe(alice);
    expect(r.confidence).toBe(1.0);
  });

  it("is idempotent — same TransID twice returns duplicate", () => {
    seedOneChama();
    const p = makeC2B();
    const a = reconcileC2B(p, JSON.stringify(p));
    const b = reconcileC2B(p, JSON.stringify(p));
    expect(a.status).toBe("matched");
    expect(b.status).toBe("duplicate");
    expect(b.paymentId).toBe(a.paymentId);
  });

  it("matches by MSISDN alone when account-ref is missing", () => {
    const { chamaId, alice } = seedOneChama();
    const p = makeC2B({ BillRefNumber: undefined, MSISDN: "0711223344" });
    const r = reconcileC2B(p, JSON.stringify(p));
    expect(r.status).toBe("matched");
    expect(r.chamaId).toBe(chamaId);
    expect(r.userId).toBe(alice);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("marks unmatched when MSISDN belongs to nobody", () => {
    seedOneChama();
    const p = makeC2B({ MSISDN: "254799999999", BillRefNumber: "XYZ-202604" });
    const r = reconcileC2B(p, JSON.stringify(p));
    expect(r.status).toBe("unmatched");
    expect(r.userId).toBeNull();
  });

  it("writes balanced double-entry ledger rows on match", () => {
    const { chamaId } = seedOneChama();
    const p = makeC2B();
    reconcileC2B(p, JSON.stringify(p));
    const rows = getDb()
      .prepare(
        `SELECT direction, amount_cents FROM ledger_entries WHERE chama_id = ?`
      )
      .all(chamaId) as any[];
    expect(rows).toHaveLength(2);
    const debits = rows
      .filter((r) => r.direction === "debit")
      .reduce((a, r) => a + r.amount_cents, 0);
    const credits = rows
      .filter((r) => r.direction === "credit")
      .reduce((a, r) => a + r.amount_cents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(50000);
  });

  it("accepts period in 202604, 2026-04, and 2026-W17 formats without crashing", () => {
    seedOneChama();
    for (const period of ["202604", "2026-04", "2026-W17-ALICE"]) {
      const p = makeC2B({ BillRefNumber: `ACME-${period}` });
      const r = reconcileC2B(p, JSON.stringify(p));
      expect(r.status === "matched" || r.status === "unmatched").toBe(true);
    }
  });
});
