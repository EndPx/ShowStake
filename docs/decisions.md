# Decisions

2026-11-06 D001: ShowStake v2 packet is authoritative, preserved byte-for-byte. No v1 transfer semantics.
2026-11-06 D002 (additional operational default): GitHub owner is authenticated EndPx; create ShowStake private because visibility unspecified. Source push remains separately gated.
2026-11-06 D003 (additional operational default): sequential single executor while interfaces are unfrozen; no changes to Keyfolio capacity/config or services.
2026-11-06 D004: runtime agent identifier dsh is discovered from installed Orca agent definition; it launches dsh-tui . using the user's dsh-tui profile. Config selects gater/deepseek-v4.1-flash-1017-v2. No fallback provider/model permitted.
2026-11-06 D005: all packet defaults retained; no canonical network/FT/address or sponsorship chosen without evidence. PostgreSQL must use an isolated disposable instance, never an existing service DB.
