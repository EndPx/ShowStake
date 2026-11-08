import type { ReactNode } from "react";
import { PlatformShell } from "@/components/shell/platform-shell";
import { WalletProvider } from "@/components/wallet/wallet-context";
import "./platform.css";

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <PlatformShell>{children}</PlatformShell>
    </WalletProvider>
  );
}