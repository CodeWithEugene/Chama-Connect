/**
 * Reconciliation retry CLI — sweeps orphan STK rows (pending > 2 min with no
 * callback) and queries Daraja's TransactionStatus endpoint to close the loop.
 *
 * Runs as a one-shot `npm run reconcile` or as a cron every 2 min.
 */

import { getDb } from "../db/client";
import { DarajaClient } from "../daraja/client";

async function main() {
  const db = getDb();
  const stale = db
    .prepare(
      `SELECT id, daraja_checkout_request_id, daraja_merchant_request_id
       FROM payments
       WHERE source = 'mpesa_stk' AND status = 'pending'
         AND created_at < datetime('now', '-2 minutes')
       LIMIT 50`
    )
    .all() as any[];

  if (stale.length === 0) {
    console.log("[reconcile] no stale STK rows");
    return;
  }

  let daraja: DarajaClient;
  try {
    daraja = DarajaClient.fromEnv();
  } catch (e) {
    console.log(`[reconcile] Daraja not configured → ${(e as Error).message}`);
    return;
  }

  for (const row of stale) {
    try {
      const txId = row.daraja_checkout_request_id;
      if (!txId) continue;
      console.log(`[reconcile] polling status for ${row.id} (${txId})`);
      await daraja.transactionStatus({ transactionId: txId });
      // Daraja replies asynchronously via ResultURL — handled by /api/mpesa/status/result
    } catch (e) {
      console.warn(`[reconcile] ${row.id}: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
