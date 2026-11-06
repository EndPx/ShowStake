#!/usr/bin/env node
// OpenAPI baseline verification (read-only): parse + pinned-schema validate +
// reference-resolution check + route/inventory/permission assertions + the
// SEMANTIC u128 money ceiling (not just the OpenAPI regex).
//
// Dependencies are exact-pinned devDependencies: js-yaml and
// openapi-schema-validator. Exits non-zero on any defect.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMoneyString, U128_MAX } from '../packages/domain/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = join(root, 'packages', 'api-contract', 'openapi.yaml');

const yamlMod = await import('js-yaml');
const yaml = yamlMod.default ?? yamlMod;

const svMod = await import('openapi-schema-validator');
const OpenAPISchemaValidator = svMod.default?.default ?? svMod.default ?? svMod;

const raw = await readFile(SPEC_PATH, 'utf8');
const spec = yaml.load(raw);

const failures = [];
function check(cond, label) {
  if (cond) console.log(`OK   ${label}`);
  else { console.error(`FAIL ${label}`); failures.push(label); }
}

// 1. Pinned OpenAPI 3.0.3 schema validation.
try {
  const validator = new OpenAPISchemaValidator({ version: 3 }); // pinned schema
  const res = validator.validate(spec);
  const errors = res && (res.errors ?? []).length ? res.errors : [];
  check(errors.length === 0, `openapi-schema-validator: no errors${errors.length ? ` (first: ${JSON.stringify(errors[0]).slice(0, 300)})` : ''}`);
} catch (e) {
  check(false, `openapi-schema-validator threw: ${e.message}`);
}

// 2. Every local $ref resolves to a real path (reference check).
const refTargets = new Set();
function collectRefs(node, path) {
  if (Array.isArray(node)) { node.forEach((n, i) => collectRefs(n, `${path}/${i}`)); return; }
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) refTargets.add(node.$ref);
    for (const k of Object.keys(node)) collectRefs(node[k], `${path}/${k}`);
  }
}
collectRefs(spec, '#');
let refOk = true;
for (const ref of [...refTargets].sort()) {
  const here = ref === '#' ? spec : ref.slice(2).split('/').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), spec);
  if (here === undefined) { refOk = false; check(false, `$ref resolves: ${ref}`); }
}
if (refOk) check(true, `all ${refTargets.size} local $ref targets resolve`);

// 3. Route inventory — derived from the explicit reviewed inventory
//    (packages/api-contract/routes.json), which mirrors the packet architecture
//    docs/planning/showstake-v2/02-ARCHITECTURE.md 'API contract' table plus the
//    reviewed delta (/auth/privy, /events/drafts, /events/{eventId}/publish-intent).
//    This is NOT a hardcoded list that matches an incomplete spec: a missing or
//    extra route fails the check.
const ROUTES_PATH = join(root, 'packages', 'api-contract', 'routes.json');
const inventory = JSON.parse(await readFile(ROUTES_PATH, 'utf8'));
const EXPECTED_ROUTES = Array.isArray(inventory.routes) ? inventory.routes : [];
const PUBLIC = new Set(Array.isArray(inventory.public) ? inventory.public : []);
const HOST_ONLY = Array.isArray(inventory.host_only) ? inventory.host_only : [];

check(EXPECTED_ROUTES.length > 0, `route inventory non-empty (${EXPECTED_ROUTES.length} routes from routes.json)`);

// Normalize spec into a map of METHOD path -> operation so a route is matched by
// BOTH its path and its HTTP method (an inventory route with the wrong method is
// missing, not "present").
const paths = Object.keys(spec.paths ?? {});
const specOps = new Map();
for (const p of paths) {
  for (const m of Object.keys(spec.paths[p])) specOps.set(`${m.toUpperCase()} ${p}`, spec.paths[p][m]);
}
const missingRoutes = EXPECTED_ROUTES.filter((r) => !specOps.has(`${r.method.toUpperCase()} ${r.path}`));
check(missingRoutes.length === 0,
  `route inventory complete (${EXPECTED_ROUTES.length} routes; none missing)${missingRoutes.length ? ` missing=${missingRoutes.map((r) => `${r.method} ${r.path}`).join(',')}` : ''}`);

// No undeclared path/method may exist in the spec (no extras beyond the inventory).
const extra = [];
for (const p of paths) {
  for (const m of Object.keys(spec.paths[p])) {
    const key = `${m.toUpperCase()} ${p}`;
    if (!EXPECTED_ROUTES.some((r) => `${r.method.toUpperCase()} ${r.path}` === key)) extra.push(`${m} ${p}`);
  }
}
check(extra.length === 0, `no unexpected extra routes (${specOps.size} total, 0 extra)${extra.length ? ` extra=${extra.join(',')}` : ''}`);

// 4. Permissions: public model is `security: []`, everything else session cookie.
for (const p of paths) {
  for (const method of Object.keys(spec.paths[p])) {
    const op = spec.paths[p][method];
    const sec = op.security !== undefined ? op.security : spec.security;
    if (PUBLIC.has(p)) {
      check(Array.isArray(sec) && sec.length === 0, `${method.toUpperCase()} ${p}: public (security: [])`);
    } else {
      check(Array.isArray(sec) && sec.some((s) => s && 'sessionCookie' in s),
        `${method.toUpperCase()} ${p}: requires session cookie`);
    }
  }
}

// 5. Host-only routes must specify 403 (participant must not pass).
for (const p of HOST_ONLY) {
  const op = spec.paths[p]?.post ?? spec.paths[p]?.get;
  check(!!op && op.responses && op.responses['403'] !== undefined, `${p}: host-only route declares 403 (participant blocked)`);
}

// 6. Money schema: string + structural pattern (ceiling is semantic below).
const money = spec.components?.schemas?.Money;
check(!!money && money.type === 'string' && money.pattern === '^(0|[1-9][0-9]*)$', 'Money is a canonical base-10 string');
const ENVELOPES_WITH_MONEY = ['Event', 'FundingAttempt', 'QuoteEnvelope', 'ClaimListEnvelope', 'FundingAttemptRequest', 'DraftRequest'];
for (const name of ENVELOPES_WITH_MONEY) {
  check(JSON.stringify(spec.components.schemas[name] ?? {}).includes('Money'), `Money referenced by ${name}`);
}

// 7. SEMANTIC u128 ceiling: proved by the domain validator, not the regex alone.
check(isMoneyString(U128_MAX.toString()) === true, 'u128 max (2^128-1) string is valid money');
check(isMoneyString((U128_MAX + 1n).toString()) === false, '2^128 string is rejected (semantic overflow)');
check(isMoneyString('0005') === false, 'leading zeros rejected (semantic)');
check(isMoneyString(5000000) === false, 'JS number rejected (semantic)');

if (failures.length) {
  console.error(`\n${failures.length} OpenAPI check(s) failed`);
  process.exit(1);
}
console.log('\nPASS: OpenAPI baseline validated (pinned schema + $ref + route inventory + permissions + semantic u128).');
process.exit(0);