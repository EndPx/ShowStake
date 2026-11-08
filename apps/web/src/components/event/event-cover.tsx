// Adapted from CommitPass `components/events/event-cover.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Cloudinary `coverImageUrl` and the
// remote brand-media manifest are removed (no remote media/manifest copy); this
// renders only the native CSS poster art, labelled sample. Provenance:
// docs/frontend-provenance.json.

export function EventCover({
  title,
  small = false,
}: {
  title?: string;
  small?: boolean;
}) {
  return (
    <div className={`event-cover${small ? " event-cover--small" : ""}`}>
      <div className="event-cover-art" aria-hidden="true">
        <span>GOOD PEOPLE. GOOD PLANS.</span>
        <svg viewBox="0 0 200 200" fill="none">
          <path
            d="M100 10v180M10 100h180M36 36l128 128M36 164 164 36"
            stroke="currentColor"
            strokeWidth="18"
          />
          <circle cx="100" cy="100" r="34" fill="var(--cover-paper)" />
        </svg>
        <strong>{title?.trim() || "Your next\ngood idea."}</strong>
        <span>LET’S SHOW UP.</span>
      </div>
    </div>
  );
}