// ShowStake platform shell (navigation + footer). Adapted from CommitPass
// `platform-shell.tsx` / `platform-runtime.tsx` but WITHOUT the auth/account
// runtime: no Privy, no session, no EVM. Scrolled-header behaviour preserved.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Brand } from "@/components/landing/brand";
import { WalletMenu } from "@/components/wallet/wallet-menu";

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
    <div className="platform">
      <header className={`workspace-header${scrolled ? " is-scrolled" : ""}`}>
        <Brand />
        <nav aria-label="Primary">
          <Link
            href="/discover"
            className={pathname === "/discover" ? "active" : undefined}
          >
            Discover
          </Link>
          <Link
            href="/events"
            className={pathname?.startsWith("/events") ? "active" : undefined}
          >
            Events
          </Link>
        </nav>
        <div className="workspace-header-actions">
          <WalletMenu />
          <a className="button button--small" href="/events/new" aria-label="Create event">
            <Plus className="workspace-create-icon" size={16} aria-hidden="true" />
            <span className="workspace-create-label">Create event</span>
          </a>
        </div>
      </header>
      {children}
      <footer className="workspace-footer">
        <Brand compact />
        <div className="workspace-footer-meta">
          <span>ShowStake · NEAR-centered event commitments</span>
        </div>
      </footer>
    </div>
  );
}