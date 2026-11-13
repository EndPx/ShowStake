import assert from "node:assert/strict";
import config from "../../next.config.ts";
import { GET } from "../app/api/backend-unavailable/route.ts";

const saved = { VERCEL: process.env.VERCEL, SHOWSTAKE_API_UPSTREAM_URL: process.env.SHOWSTAKE_API_UPSTREAM_URL };
async function destination() {
  const rules = await config.rewrites!();
  if (!Array.isArray(rules)) throw Error("Expected flat rewrites");
  return rules[0]?.destination;
}
try {
  delete process.env.VERCEL;
  delete process.env.SHOWSTAKE_API_UPSTREAM_URL;
  assert.equal(await destination(), "http://127.0.0.1:3001/v1/:path*");
  process.env.SHOWSTAKE_API_UPSTREAM_URL = "http://127.0.0.1:3002";
  assert.equal(await destination(), "http://127.0.0.1:3002/v1/:path*");
  process.env.VERCEL = "1";
  delete process.env.SHOWSTAKE_API_UPSTREAM_URL;
  assert.equal(await destination(), "/api/backend-unavailable");
  for (const value of ["http://127.0.0.1:3002", "https://localhost", "https://user:password@api.example.com", "https://api.example.com/path", "https://api.example.com?q=x"]) {
    process.env.SHOWSTAKE_API_UPSTREAM_URL = value;
    await assert.rejects(destination);
  }
  process.env.SHOWSTAKE_API_UPSTREAM_URL = "https://api.example.com";
  assert.equal(await destination(), "https://api.example.com/v1/:path*");
  const response = GET();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).meta.stale, true);
  console.log("PASS_LOCAL Vercel origin and unavailable API gates");
} finally {
  for (const key of ["VERCEL", "SHOWSTAKE_API_UPSTREAM_URL"] as const) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
}
