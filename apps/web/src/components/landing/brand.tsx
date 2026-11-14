import Image from "next/image";
import Link from 'next/link';

// Shared CommitPass brand-link structure with ShowStake's own existing artwork.

export function Brand({
  compact = false,
  href = "#top",
}: {
  compact?: boolean;
  href?: string;
}) {
  return (
    <Link
      className={`brand${compact ? " brand--compact" : ""}`}
      href={href}
      aria-label="ShowStake home"
    >
      <Image className="brand-wordmark" src="/brand/showstake-logo-v1.png" width={2172} height={724} alt="ShowStake" sizes={compact ? "140px" : "170px"} priority={!compact} />
      <img className="brand-symbol" src="/brand/showstake-mark.svg" width={36} height={36} alt="" aria-hidden="true" />
    </Link>
  );
}
