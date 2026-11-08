// ShowStake Amount primitive — exact atomic money presentation. Never renders
// "0" or a float for an unknown/invalid amount; unknown is "Unavailable".
import { formatUnits } from "@/lib/money";

export function Amount({
  value,
  decimals,
  symbol,
  approx = false,
}: {
  /** Canonical unsigned-128 base-10 string (OpenAPI `Money`). */
  value: string;
  /** Asset decimals; unknown/missing renders "Unavailable", never an implicit 0. */
  decimals?: number;
  symbol?: string;
  approx?: boolean;
}) {
  const text = formatUnits(value, decimals, symbol);
  return (
    <span className="amount" title={text}>
      {approx && text !== "Unavailable" ? "≈" : ""}
      {text}
    </span>
  );
}

export const UNAVAILABLE = "Unavailable";