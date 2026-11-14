// ShowStake platform shell (navigation + footer). Adapted from CommitPass
// `platform-shell.tsx` / `platform-runtime.tsx` but WITHOUT the auth/account
// runtime: no Privy, no session, no EVM. Scrolled-header behaviour preserved.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, Compass, Plus } from "lucide-react";
import { Brand } from "@/components/landing/brand";
import { WalletMenu } from "@/components/wallet/wallet-menu";
import { NETWORK } from "@/lib/config";

export function PlatformShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="platform platform--commitpass">
      <a className="skip-link" href="#workspace-main">Skip to content</a>
      <header className={`workspace-header${scrolled ? " is-scrolled" : ""}`}>
        <Brand href="/discover" />
        <nav aria-label="Primary">
          <Link
            href="/discover"
            className={pathname === "/discover" ? "active" : undefined}
            aria-current={pathname === "/discover" ? "page" : undefined}
          >
            <Compass size={17} aria-hidden="true" /><span>Discover</span>
          </Link>
          <Link
            href="/events"
            className={pathname?.startsWith("/events") ? "active" : undefined}
            aria-current={pathname?.startsWith("/events") ? "page" : undefined}
          >
            <CalendarDays size={17} aria-hidden="true" /><span>Events</span>
          </Link>
        </nav>
        <div className="workspace-header-actions">
          <WalletMenu />
          <Link className="workspace-create-link" href="/events/new" aria-label="Create event">
            <Plus className="workspace-create-icon" size={16} aria-hidden="true" />
            <span className="workspace-create-label">Create event</span>
          </Link>
        </div>
      </header>
      {NETWORK === "testnet" && <div className="workspace-network-note" role="note">NEAR testnet · Mock USDC · Zero-yield MockEarn · No real funds</div>}
      {children}
      <footer className="workspace-footer">
        <Brand compact href="/" />
        <div className="workspace-footer-meta">
          <span>ShowStake · NEAR {NETWORK}{NETWORK === "testnet" ? " · Mock USDC" : ""}</span>
          <nav aria-label="More pages"><Link href="/funding">Funding</Link>{" / "}<Link href="/earn">Earn</Link></nav>
        </div>
      </footer>
    </div>
  );
}
