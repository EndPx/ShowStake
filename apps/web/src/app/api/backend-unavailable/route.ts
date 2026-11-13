// Public FE deployment may precede the API; never proxy to Vercel's loopback.
function unavailable() {
  return Response.json({
    data: null,
    error: { code: "BACKEND_UNAVAILABLE", message: "The hosted ShowStake API is not configured. Login and indexed event reads are unavailable." },
    meta: { network: process.env.NEXT_PUBLIC_SHOWSTAKE_NETWORK || "testnet", observedAt: new Date().toISOString(), stale: true },
  }, { status: 503, headers: { "Cache-Control": "no-store" } });
}
export const GET = unavailable;
export const POST = unavailable;
