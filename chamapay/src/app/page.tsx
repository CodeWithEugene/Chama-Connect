import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-20">
      <div className="mb-2 text-xs uppercase tracking-widest text-brand-500">
        Built for ChamaConnect · Hackathon submission
      </div>
      <h1 className="mb-4 text-4xl font-bold md:text-5xl">
        ChamaPay — M-Pesa-native auto-reconciliation for chamas
      </h1>
      <p className="mb-8 text-lg text-neutral-300">
        Drop-in module for <a className="text-brand-500 underline" href="https://chamaconnect.io">chamaconnect.io</a> that
        closes the platform&apos;s #1 gap: linking M-Pesa paybill deposits to the
        right chama member and cycle in real time — no manual reconciliation, no
        treasurer discretion, no leakage.
      </p>
      <div className="flex flex-col gap-4 sm:flex-row">
        <Link
          href="/chamas/ACME"
          className="rounded-md bg-brand-600 px-6 py-3 text-center font-semibold text-white hover:bg-brand-500"
        >
          Open demo dashboard (ACME)
        </Link>
        <a
          href="https://github.com/"
          className="rounded-md border border-neutral-700 px-6 py-3 text-center font-semibold text-neutral-200 hover:bg-neutral-900"
        >
          View source
        </a>
      </div>
      <section className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Card
          title="M-Pesa Daraja"
          body="STK Push, C2B Paybill, B2C Payouts, Transaction Status fallback. Idempotent, double-entry ledger."
        />
        <Card
          title="USSD *384#"
          body="Feature-phone access via Africa's Talking: balance, contribute, request loan, vote."
        />
        <Card
          title="On-chain receipts"
          body="Nightly Merkle root of settled contributions anchored to Base Sepolia — every member gets a verifiable receipt URL."
        />
      </section>
    </main>
  );
}

function Card({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-5">
      <h3 className="mb-2 text-lg font-semibold text-brand-500">{title}</h3>
      <p className="text-sm text-neutral-300">{body}</p>
    </div>
  );
}
