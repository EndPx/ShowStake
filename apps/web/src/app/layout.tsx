import type { Metadata, Viewport } from "next";
import "./globals.css";

// Inter is specified in tokens.css as the first family with a system fallback;
// no font binary is imported or bundled in this slice (no next/font download).
const title = "ShowStake — Stake your spot. Show up.";

export const metadata: Metadata = {
  title,
  icons: {
    icon: { url: "/brand/showstake-mark.svg", type: "image/svg+xml" },
    shortcut: "/brand/showstake-mark.svg",
  },
  description:
    "ShowStake is a NEAR-centered event commitment product: fund a NEAR account, commit a fixed deposit, get an account-bound pass, then check in, settle and claim.",
  openGraph: {
    title,
    description:
      "Stake your spot. Show up. Meaningful attendance commitments for community meetups and workshops.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
