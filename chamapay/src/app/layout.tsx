import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.PUBLIC_BASE_URL ?? "http://localhost:3100"
  ),
  title: {
    default: "ChamaPay — M-Pesa reconciliation for ChamaConnect",
    template: "%s | ChamaPay",
  },
  description:
    "Drop-in M-Pesa Daraja + USSD module for ChamaConnect: live contribution auto-reconciliation, loan payouts, on-chain receipts.",
  applicationName: "ChamaPay",
  openGraph: {
    type: "website",
    locale: "en_KE",
    siteName: "ChamaPay",
    title: "ChamaPay — M-Pesa reconciliation for ChamaConnect",
    description:
      "Live M-Pesa contribution auto-reconciliation, USSD access, and on-chain receipts for Kenyan chamas.",
  },
  twitter: {
    card: "summary",
    title: "ChamaPay",
    description: "M-Pesa reconciliation module for ChamaConnect",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
