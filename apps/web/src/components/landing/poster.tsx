// Reused from CommitPass `components/landing/poster.tsx` (baseline
// 542273df306a7e5887f1dfcabf1383e78930f579). Native CSS poster artwork only
// (no image/logo/font binaries); labelled sample in the landing flow.
// Provenance: docs/frontend-provenance.json.

type PosterKind = "run" | "dinner" | "build" | "clay" | "music" | "coffee";

export const posters: { kind: PosterKind; place: string; label: string }[] = [
  { kind: "run", place: "JAKARTA", label: "Sunday Slow Run" },
  { kind: "dinner", place: "AROUND THE TABLE", label: "Supper Club" },
  {
    kind: "build",
    place: "MAKE SOMETHING GOOD",
    label: "Builders After Hours",
  },
  { kind: "clay", place: "A LITTLE MESS IS GOOD", label: "Clay & Company" },
  {
    kind: "music",
    place: "GOOD PEOPLE. GOOD RECORDS.",
    label: "Listening Room",
  },
  {
    kind: "coffee",
    place: "LESS SCROLLING. MORE TALKING.",
    label: "Coffee & Conversations",
  },
];

export function Poster({
  kind,
  compact = false,
}: {
  kind: PosterKind;
  compact?: boolean;
}) {
  const item = posters.find((poster) => poster.kind === kind)!;
  return (
    <div
      className={`poster poster--${kind}${compact ? " poster--compact" : ""}`}
      aria-hidden="true"
    >
      <div className="poster-paper">
        <span className="poster-kicker">{item.place}</span>
        {kind === "run" && (
          <>
            <strong className="poster-title">
              SUNDAY
              <br />
              <i>SLOW</i>
              <br />
              RUN
            </strong>
            <svg className="run-lines" viewBox="0 0 240 120" fill="none">
              <path
                d="M-20 110C45-90 85 210 260 5M-20 127C45-73 85 227 260 22M-20 144C45-56 85 244 260 39M-20 161C45-39 85 261 260 56"
                stroke="currentColor"
                strokeWidth="7"
              />
            </svg>
            <span className="poster-note">YOUR PACE. YOUR PEOPLE.</span>
          </>
        )}
        {kind === "dinner" && (
          <>
            <strong className="poster-title">
              supper
              <br />
              <i>club.</i>
            </strong>
            <div className="plate">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
            <span className="poster-note">PULL UP A CHAIR.</span>
          </>
        )}
        {kind === "build" && (
          <>
            <span className="build-spark">✳</span>
            <strong className="poster-title">
              BUILDERS
              <br />
              AFTER
              <br />
              <i>HOURS</i>
            </strong>
            <span className="poster-note">IDEAS MEET THEIR PEOPLE ↗</span>
          </>
        )}
        {kind === "clay" && (
          <>
            <strong className="poster-title">
              clay &<br />
              <i>company</i>
            </strong>
            <svg className="vase" viewBox="0 0 150 160">
              <path
                d="M46 15h58l-9 44c2 18 37 29 34 61-2 26-28 29-54 29s-52-3-54-29c-3-32 32-43 34-61z"
                fill="currentColor"
              />
              <ellipse cx="75" cy="15" rx="29" ry="8" fill="#173e52" />
              <path
                d="M44 90q31 17 62 0M37 108q38 17 76 0M39 126q36 14 72 0"
                fill="none"
                stroke="#d8e8ed"
                strokeWidth="3"
              />
            </svg>
            <span className="poster-note">MAKE SOMETHING. MEET SOMEONE.</span>
          </>
        )}
        {kind === "music" && (
          <>
            <strong className="poster-title">
              The
              <br />
              <i>listening</i>
              <br />
              room.
            </strong>
            <div className="record">
              <span />
            </div>
            <span className="poster-note">BRING A RECORD. STAY A WHILE.</span>
          </>
        )}
        {kind === "coffee" && (
          <>
            <strong className="poster-title">
              coffee &<br />
              <i>
                conver-
                <br />
                sations.
              </i>
            </strong>
            <svg className="coffee-cup" viewBox="0 0 160 110">
              <path d="M31 30h89v40c0 35-89 35-89 0z" fill="currentColor" />
              <path
                d="M120 39c42-7 38 45 0 39"
                fill="none"
                stroke="currentColor"
                strokeWidth="10"
              />
              <ellipse cx="75" cy="30" rx="44" ry="12" fill="#dcf5fc" />
              <ellipse cx="75" cy="32" rx="34" ry="7" fill="#173e52" />
            </svg>
            <span className="poster-note">
              COME FOR THE COFFEE. STAY FOR THE COMPANY.
            </span>
          </>
        )}
      </div>
    </div>
  );
}