import type { ReactNode } from "react";
import { DM_Sans, DM_Serif_Display } from "next/font/google";
import { PlatformShell } from "@/components/shell/platform-shell";
import { WalletProvider } from "@/components/wallet/wallet-context";
import {EventThemeProvider} from '@/components/event/page-theme';
import "./platform.css";
import "./commitpass-editor.css";
import "./commitpass-events.css";
import "./commitpass-shell.css";
import './event-experience.css';
import './event-appearance.css';

// Match the user's CommitPass app typography without changing the landing page.
const sans = DM_Sans({ subsets: ["latin"], variable: "--font-commitpass-sans", display: "swap" });
const serif = DM_Serif_Display({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-commitpass-serif", display: "swap" });

export default function PlatformLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${sans.variable} ${serif.variable}`}><WalletProvider>
      <EventThemeProvider><PlatformShell>{children}</PlatformShell></EventThemeProvider>
    </WalletProvider></div>
  );
}
