// verify:t08-frontend — bounded CommitPass-reuse frontend slice acceptance.
//
// Meaningful, dependency-free checks:
//  1. behavioral: actual display-time / money / event helpers (imported via
//     Node's native TS type-stripping — Node >= 24, same files the app ships)
//  2. static: no residual legacy chain/provider imports or private config
//  3. static: required empty/loading/error + timezone + reduced-motion + focus
//     states are present, and provenance is recorded
//
// Run from the repo root: `node scripts/verify-t08-frontend.mjs`

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("../apps/web/", import.meta.url));

let passed = 0;
let failed = 0;
const failures = [];
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}
function bad(name, detail) {
  failed += 1;
  failures.push(name);
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail);
}

// ---- 1. behavioral tests over the actual shipped helpers -------------------
const { utcOffset, displayTime, clockLabel } = await import(
  "../apps/web/src/lib/display-time.ts"
);
const { formatUnits, isAtomicString, splitAtomic } = await import(
  "../apps/web/src/lib/money.ts"
);
const events = await import("../apps/web/src/lib/events.ts");

const jan = new Date("2024-01-15T00:00:00Z");
assert("timezone: Asia/Jakarta offset", utcOffset(jan, "Asia/Jakarta") === "UTC+07:00", utcOffset(jan, "Asia/Jakarta"));
assert("timezone: UTC is zero", utcOffset(jan, "UTC") === "UTC+00:00", utcOffset(jan, "UTC"));
assert("timezone: display 24h in Jakarta", displayTime(new Date("2024-01-15T12:00:00Z"), "Asia/Jakarta") === "19:00", displayTime(new Date("2024-01-15T12:00:00Z"), "Asia/Jakarta"));
assert("timezone: clockLabel carries offset", clockLabel(jan, "Asia/Jakarta").endsWith("UTC+07:00"), clockLabel(jan, "Asia/Jakarta"));

assert("money: whole amount trims", formatUnits("5000000", 6, "USDC") === "5 USDC", formatUnits("5000000", 6, "USDC"));
assert("money: fraction", formatUnits("1250000", 6) === "1.25", formatUnits("1250000", 6));
assert("money: zero is exact", formatUnits("0", 6) === "0", formatUnits("0", 6));
assert("money: non-string -> Unavailable", formatUnits("abc", 6) === "Unavailable", formatUnits("abc", 6));
assert("money: leading zeros -> Unavailable", formatUnits("0005", 6) === "Unavailable", formatUnits("0005", 6));
assert("money: negative -> Unavailable", formatUnits("-1", 6) === "Unavailable", formatUnits("-1", 6));
assert("money: canonical predicate", isAtomicString("5000000") && !isAtomicString("5.0") && !isAtomicString("-1"), "isAtomicString");

const U128_MAX = "340282366920938463463374607431768211455";
const U128_MAX_PLUS_ONE = "340282366920938463463374607431768211456";
assert("money: u128 max accepted", isAtomicString(U128_MAX), "2^128-1");
assert("money: u128 max+1 rejected", !isAtomicString(U128_MAX_PLUS_ONE), "2^128");
assert("money: 40 digits rejected", !isAtomicString("1" + "0".repeat(39)), "10^39");
assert("money: max formats exactly", formatUnits(U128_MAX, 0) === U128_MAX, formatUnits(U128_MAX, 0));
assert("money: overflow format Unavailable", formatUnits(U128_MAX_PLUS_ONE, 0) === "Unavailable", formatUnits(U128_MAX_PLUS_ONE, 0));
assert("money: overflow split null", splitAtomic(U128_MAX_PLUS_ONE, 0) === null, "overflow split");
assert("money: max split exact whole", splitAtomic("1000000", 6)?.whole === "1" && splitAtomic("1000000", 6)?.fraction === "000000", "split");
assert("money: missing decimals Unavailable", formatUnits("10", undefined) === "Unavailable", "undefined decimals");

assert("events: status PUBLISHED", events.statusLabel("PUBLISHED") === "Published", events.statusLabel("PUBLISHED"));
assert("events: status SETTLED", events.statusLabel("SETTLED") === "Event ended", events.statusLabel("SETTLED"));
assert("events: status CANCELLED", events.statusLabel("CANCELLED") === "Cancelled", events.statusLabel("CANCELLED"));
{
  const ev = {
    times: { regOpen: "2024-01-15T00:00:00Z", regClose: "2024-01-16T00:00:00Z" },
    state: "PUBLISHED",
  };
  assert("events: registration open mid-window", events.registrationOpen(ev, Date.parse("2024-01-15T12:00:00Z")) === true, "mid-window");
  assert("events: registration closed after", events.registrationOpen(ev, Date.parse("2024-01-16T00:00:01Z")) === false, "after close");
  assert("events: registration open at exact open", events.registrationOpen(ev, Date.parse("2024-01-15T00:00:00Z")) === true, "exact open");
  assert("events: registration closed at exact close", events.registrationOpen(ev, Date.parse("2024-01-16T00:00:00Z")) === false, "exact close");
  assert("events: registration closed before open", events.registrationOpen(ev, Date.parse("2024-01-14T23:59:59Z")) === false, "before open");
}
{
  const win = { times: { regOpen: "2024-01-15T00:00:00Z", regClose: "2024-01-16T00:00:00Z" } };
  const mid = Date.parse("2024-01-15T12:00:00Z");
  const cxl = { ...win, state: "CANCELLED", capacity: 10, participantCount: 3 };
  const set = { ...win, state: "SETTLED", capacity: 10, participantCount: 3 };
  assert("events: cancelled neutral label", events.availabilityLabel(cxl, mid) === "Cancelled", events.availabilityLabel(cxl, mid));
  assert("events: settled neutral label", events.availabilityLabel(set, mid) === "Event ended", events.availabilityLabel(set, mid));
  assert("events: published before open neutral", events.availabilityLabel({ ...win, state: "PUBLISHED" }, Date.parse("2024-01-14T23:59:59Z")) === "Published", "before open");
  assert("events: published after close neutral", events.availabilityLabel({ ...win, state: "PUBLISHED" }, Date.parse("2024-01-16T00:00:00Z")) === "Published", "after close");
  assert("events: unknown count Unavailable", events.availabilityLabel({ ...win, state: "PUBLISHED", capacity: 10 }, mid) === "Unavailable", "no participantCount");
  assert("events: NaN count Unavailable", events.availabilityLabel({ ...win, state: "PUBLISHED", capacity: 10, participantCount: Number.NaN }, mid) === "Unavailable", "NaN");
  assert("events: full label", events.availabilityLabel({ ...win, state: "PUBLISHED", capacity: 10, participantCount: 10 }, mid) === "Full", "full");
  assert("events: spots left", events.availabilityLabel({ ...win, state: "PUBLISHED", capacity: 10, participantCount: 3 }, mid) === "7 spots left", "spots left");
  assert("events: single spot", events.availabilityLabel({ ...win, state: "PUBLISHED", capacity: 10, participantCount: 9 }, mid) === "1 spot left", "one spot");
}
assert("events: settled is past", events.isPastEvent({ state: "SETTLED", times: { checkinClose: "2099-01-01T00:00:00Z" } }, Date.now()) === true, "settled");

// ---- 2. static: collect source files --------------------------------------
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "onboarding-probe" || entry === "dist" || entry === ".next") continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}
const files = [...walk(webDir)].filter((f) => {
  const e = extname(f);
  return [".ts", ".tsx", ".css", ".mjs", ".mts", ".js"].includes(e);
});
assert("static: found sources", files.length > 5, `${files.length} files`);

const sourceText = files
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

// legacy provider / chain imports must be absent (attribution comments allowed)
for (const token of ["@privy-io", 'from "@commitpass', 'from "viem"', "res.cloudinary.com", "NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "depositedToYield", "protocolRevenue", "testnetGasSponsorship"]) {
  const hit = sourceText.includes(token);
  assert(`no legacy token: ${token}`, !hit, token);
}
// The full CommitPass app reuse now includes its typography. next/font bundles
// these at build time; it is not an EVM/provider runtime dependency.
const appLayout = readFileSync(new URL("../apps/web/src/app/(platform)/layout.tsx", import.meta.url), "utf8");
assert("CommitPass app typography remains scoped", appLayout.includes('DM_Sans') && appLayout.includes('DM_Serif_Display') && appLayout.includes('--font-commitpass-sans'));

// package manifest: pin compatible deps, no EVM/Privy/QR/scan deps
const pkg = JSON.parse(readFileSync(new URL("../apps/web/package.json", import.meta.url), "utf8"));
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
for (const banned of ["viem", "@privy-io/react-auth", "@yudiel/react-qr-scanner", "@zxing/browser", "qrcode"]) {
  assert(`package: no ${banned}`, !(banned in deps), banned);
}
for (const required of ["next", "react", "react-dom", "lucide-react", "typescript"]) {
  assert(`package: has ${required}`, required in deps, required);
}
assert("package: next pinned 15.x", deps.next === "15.5.26", deps.next);
assert("package: react pinned 19.1.9", deps.react === "19.1.9", deps.react);

// required states / behaviours present
assert("has timezone helper", sourceText.includes("utcOffset") && sourceText.includes("displayTime"), "display-time");
assert("has Unavailable amount fallback", sourceText.includes("Unavailable"), "amount");
assert("has CatalogUnavailable (honest empty)", sourceText.includes("CatalogUnavailable"), "catalog");
assert("has LoadError/retry", sourceText.includes("LoadError"), "error");
assert("has LoadingEvents skeleton", sourceText.includes("LoadingEvents"), "loading");

const cssText = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");
assert("css: prefers-reduced-motion", cssText.includes("prefers-reduced-motion"), "reduced-motion");
assert("css: focus-visible", cssText.includes("focus-visible"), "focus");
assert("css: skip-link", cssText.includes("skip-link"), "skip link");

// ---- 3. provenance --------------------------------------------------------
const provPath = new URL("../docs/frontend-provenance.json", import.meta.url);
assert("provenance: frontend-provenance.json exists", existsSync(provPath), "docs/frontend-provenance.json");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.error("Failed:", failures.join(", "));
  process.exit(1);
}
console.log("verify:t08-frontend OK");
