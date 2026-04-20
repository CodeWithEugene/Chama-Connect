/**
 * SMS outbox. Writes queued rows; a worker (or the Africa's Talking client)
 * drains them. Keeping sends async avoids blocking Daraja's 5-second ACK SLA.
 */

import { nanoid } from "nanoid";
import { getDb } from "../db/client";

export function queueSms(msisdn: string, body: string): string {
  const id = nanoid();
  getDb()
    .prepare(
      `INSERT INTO sms_outbox (id, msisdn, body) VALUES (?, ?, ?)`
    )
    .run(id, msisdn, body.slice(0, 480));
  return id;
}
