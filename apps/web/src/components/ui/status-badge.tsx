// ShowStake StatusBadge — event lifecycle label (packages/domain EVENT_STATES).
import { statusLabel } from "@/lib/events";
import type { EventState } from "@/lib/types";

export function StatusBadge({ state }: { state: EventState }) {
  return <span className="plan-badge">{statusLabel(state)}</span>;
}