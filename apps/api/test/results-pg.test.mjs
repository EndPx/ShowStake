// Read-only integration regression against an existing local projection database.
// Set SHOWSTAKE_RESULTS_TEST_DATABASE_URL and SHOWSTAKE_RESULTS_TEST_EVENT_ID.
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PgStore } from '../dist/store/pg-store.js';
import { buildApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { makeDenyResolver } from '../dist/auth/rpc.js';

const url = process.env.SHOWSTAKE_RESULTS_TEST_DATABASE_URL;
const id = process.env.SHOWSTAKE_RESULTS_TEST_EVENT_ID;
test('results resolve UUID and chain ID consistently with event detail', { skip: !url || !id }, async () => {
  const pool = new pg.Pool({ connectionString: url, options: '-c role=showstake_api' });
  const store = new PgStore(pool);
  const config = loadConfig({ AUTH_DOMAIN: 'app.showstake.local', AUTH_NETWORK: 'testnet', COOKIE_SECURE: 'false' });
  const app = buildApp({ store, config, accessKeyVerifier: makeDenyResolver(config) });
  try {
    const detail = await app.inject({ method: 'GET', url: `/v1/events/${id}` });
    assert.equal(detail.statusCode, 200);
    const event = detail.json().data;
    assert.ok(event.chainEventId);
    for (const eventId of [id, event.chainEventId]) {
      const response = await app.inject({ method: 'GET', url: `/v1/events/${eventId}/results` });
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().data;
      assert.equal(result.eventId, event.id);
      assert.equal(result.chainEventId, event.chainEventId);
      assert.equal(result.state, event.state);
      assert.deepEqual(result.totals, event.totals);
      assert.equal(result.counts.activeRegistrations, event.registeredCount);
    }
    const missing = await app.inject({ method: 'GET', url: '/v1/events/no-such-event/results' });
    assert.equal(missing.statusCode, 404);
  } finally {
    await app.close();
    await pool.end();
  }
});
