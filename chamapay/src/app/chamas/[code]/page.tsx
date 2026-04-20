import Link from "next/link";
import { DashboardClient } from "./dashboard-client";

export default function ChamaPage({
  params,
}: {
  params: { code: string };
}) {
  const { code } = params;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <nav className="mb-6 text-sm text-neutral-400">
        <Link href="/" className="hover:text-neutral-200">
          ← ChamaPay
        </Link>
        <span className="mx-2">/</span>
        <span>chamas</span>
        <span className="mx-2">/</span>
        <span className="text-neutral-200">{code.toUpperCase()}</span>
      </nav>
      <DashboardClient code={code.toUpperCase()} />
    </main>
  );
}
