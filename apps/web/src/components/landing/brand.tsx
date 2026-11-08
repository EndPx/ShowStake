// Adapted from CommitPass `components/landing/brand.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). The PNG logo mark is NOT imported
// (no asset/logo rights); ShowStake uses a native text wordmark instead.

export function Brand({
  compact = false,
  href = "#top",
}: {
  compact?: boolean;
  href?: string;
}) {
  return (
    <a
      className={`brand${compact ? " brand--compact" : ""}`}
      href={href}
      aria-label="ShowStake home"
    >
      <span>
        ShowStake<span className="brand-period">.</span>
      </span>
    </a>
  );
}