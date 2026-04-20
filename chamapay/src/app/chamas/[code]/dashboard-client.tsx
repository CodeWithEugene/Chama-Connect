"use client";

import { useEffect, useState } from "react";

type Member = {
  id: string;
  msisdn: string;
  full_name: string;
  role: string;
  contributed_cents: number;
};

type Payment = {
  id: string;
  status: string;
  msisdn: string | null;
  amount_cents: number;
  daraja_receipt: string | null;
  account_ref: string | null;
  match_confidence: number | null;
  match_reason: string | null;
  created_at: string;
  member_name: string | null;
  source: string;
};

type Summary = {
  chama: {
    id: string;
    code: string;
    name: string;
    paybill: string;
    contribution_cents: number;
  };
  cycle: { period: string; expected_cents: number } | null;
  members: Member[];
  payments: Payment[];
  unmatched: Payment[];
  totals: {
    expectedCents: number;
    contributedCents: number;
    memberCount: number;
  };
};

const fmt = (cents: number) =>
  `KES ${(cents / 100).toLocaleString("en-KE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

export function DashboardClient({ code }: { code: string }) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [contribMsisdn, setContribMsisdn] = useState("");
  const [contribStatus, setContribStatus] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetch(`/api/chamas/${code}/summary`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as Summary;
      setData(j);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3_000);
    return () => clearInterval(id);
  }, [code]);

  async function requestStk() {
    if (!contribMsisdn) return;
    setContribStatus("sending…");
    const res = await fetch(`/api/chamas/${code}/contribute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msisdn: contribMsisdn }),
    });
    const j = await res.json();
    if (!res.ok) {
      setContribStatus(`error: ${JSON.stringify(j.error ?? j)}`);
    } else {
      setContribStatus(
        `STK sent · ref ${j.accountRef} · checkout ${j.daraja?.CheckoutRequestID ?? ""}`
      );
    }
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-900 bg-red-950/30 p-4 text-red-300">
        Failed to load dashboard for chama <b>{code}</b>: {error}
      </div>
    );
  }
  if (!data) {
    return <div className="text-neutral-400">Loading…</div>;
  }

  const progressPct = data.totals.expectedCents
    ? Math.min(
        100,
        Math.round(
          (data.totals.contributedCents / data.totals.expectedCents) * 100
        )
      )
    : 0;

  return (
    <div className="space-y-8">
      <header>
        <div className="mb-1 text-xs uppercase tracking-widest text-brand-500">
          Paybill {data.chama.paybill} · Cycle {data.cycle?.period ?? "none"}
        </div>
        <h1 className="text-3xl font-bold">{data.chama.name}</h1>
        <p className="text-sm text-neutral-400">
          Per-member expected: {fmt(data.chama.contribution_cents)} ·{" "}
          {data.totals.memberCount} members
        </p>
      </header>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">
            Cycle progress{" "}
            <span className="text-brand-500">{progressPct}%</span>
          </h2>
          <div className="text-sm text-neutral-400">
            {fmt(data.totals.contributedCents)} of{" "}
            {fmt(data.totals.expectedCents)}
          </div>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full bg-brand-600 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </section>

      <section className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="mb-3 text-lg font-semibold">Trigger STK Push</h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={contribMsisdn}
            onChange={(e) => setContribMsisdn(e.target.value)}
            placeholder="+254712345678"
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
          />
          <button
            onClick={requestStk}
            disabled={!contribMsisdn}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-50"
          >
            Send STK prompt
          </button>
        </div>
        {contribStatus && (
          <p className="mt-3 text-xs text-neutral-400">{contribStatus}</p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Members</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Phone</th>
                <th className="px-4 py-2 text-left">Role</th>
                <th className="px-4 py-2 text-right">Contributed</th>
                <th className="px-4 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => {
                const paid = m.contributed_cents >= data.chama.contribution_cents;
                return (
                  <tr
                    key={m.id}
                    className="border-t border-neutral-800"
                  >
                    <td className="px-4 py-2">{m.full_name}</td>
                    <td className="px-4 py-2 font-mono text-xs">{m.msisdn}</td>
                    <td className="px-4 py-2 text-neutral-400">{m.role}</td>
                    <td className="px-4 py-2 text-right">
                      {fmt(m.contributed_cents)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span
                        className={
                          paid
                            ? "rounded bg-brand-600/30 px-2 py-0.5 text-xs text-brand-500"
                            : "rounded bg-amber-800/40 px-2 py-0.5 text-xs text-amber-400"
                        }
                      >
                        {paid ? "paid" : "pending"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">
          Recent payments
          <span className="ml-2 text-xs text-neutral-500">(auto-refreshes every 3s)</span>
        </h2>
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-900 text-neutral-400">
              <tr>
                <th className="px-4 py-2 text-left">When</th>
                <th className="px-4 py-2 text-left">Source</th>
                <th className="px-4 py-2 text-left">Member</th>
                <th className="px-4 py-2 text-left">Phone</th>
                <th className="px-4 py-2 text-left">Ref</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-right">Confidence</th>
                <th className="px-4 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.payments.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-neutral-500" colSpan={8}>
                    No payments yet — trigger an STK above or paybill the sandbox shortcode.
                  </td>
                </tr>
              )}
              {data.payments.map((p) => (
                <tr key={p.id} className="border-t border-neutral-800">
                  <td className="px-4 py-2 text-xs text-neutral-400">
                    {new Date(p.created_at).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2 text-xs text-neutral-400">
                    {p.source}
                  </td>
                  <td className="px-4 py-2">
                    {p.member_name ?? (
                      <span className="text-neutral-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {p.msisdn ?? "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {p.account_ref ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {fmt(p.amount_cents)}
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-neutral-400">
                    {p.match_confidence != null
                      ? `${Math.round(p.match_confidence * 100)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <span
                      className={
                        p.status === "matched"
                          ? "rounded bg-brand-600/30 px-2 py-0.5 text-xs text-brand-500"
                          : p.status === "unmatched"
                            ? "rounded bg-red-900/40 px-2 py-0.5 text-xs text-red-400"
                            : "rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400"
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {data.unmatched.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-amber-400">
            Admin review queue ({data.unmatched.length})
          </h2>
          <div className="overflow-hidden rounded-lg border border-amber-900/40 bg-amber-950/20">
            <table className="min-w-full text-sm">
              <thead className="bg-amber-950/40 text-amber-300/80">
                <tr>
                  <th className="px-4 py-2 text-left">Phone</th>
                  <th className="px-4 py-2 text-left">Ref</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                  <th className="px-4 py-2 text-left">Receipt</th>
                  <th className="px-4 py-2 text-left">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.unmatched.map((p) => (
                  <tr key={p.id} className="border-t border-amber-900/30">
                    <td className="px-4 py-2 font-mono text-xs">{p.msisdn}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {p.account_ref ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {fmt(p.amount_cents)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {p.daraja_receipt ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-xs text-amber-200/80">
                      {p.match_reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
