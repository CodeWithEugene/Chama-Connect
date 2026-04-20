import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  getDb()
    .prepare(
      `INSERT INTO daraja_callbacks (id, kind, payload, http_headers)
       VALUES (?, 'timeout', ?, ?)`
    )
    .run(
      nanoid(),
      raw,
      JSON.stringify(Object.fromEntries(req.headers.entries()))
    );
  return NextResponse.json({ ResultCode: 0 });
}
