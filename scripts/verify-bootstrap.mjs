#!/usr/bin/env node
// Bootstrap verification (T00/T01 foundation).
// Checks the pinned toolchain and the presence of every foundation file/directory.
// Exits non-zero on any mismatch or missing file; it fails the build on drift.
import { readFile, access } from 'node:fs/promises';
import { execFileSync, execSync } from 'node:child_process';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// 1. Node engine: pinned to installed v24.18.0, declared ">=24.18.0 <25".
const node = process.version; // e.g. v24.18.0
const [maj, min] = node.slice(1).split('.').map(Number);
if (maj === 24 && min >= 18) console.log(`OK   node ${node} (satisfies >=24.18.0 <25)`);
else failures.push(`node engine mismatch: ${node} (expected >=24.18.0 <25)`);

// 2. pnpm exactly 10.21.0 (the exact packageManager pin).
// On Windows the standalone install exposes pnpm via a .CMD shim, so resolve through cmd.
let pnpm = '';
if (process.platform === 'win32') {
  try { pnpm = execSync('pnpm --version', { encoding: 'utf8' }).trim(); }
  catch { pnpm = ''; }
}
if (!pnpm) {
  try { pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(); }
  catch { pnpm = ''; }
}
if (pnpm === '10.21.0') console.log('OK   pnpm 10.21.0 (exact pin)');
else if (pnpm) failures.push(`pnpm mismatch: '${pnpm}' (expected exactly 10.21.0)`);
else failures.push('cannot determine pnpm version (no pnpm executable found)');

// 3. Root package.json pins.
let pkg;
try { pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')); }
catch { failures.push('package.json missing or unreadable'); pkg = {}; }
if (pkg.packageManager === 'pnpm@10.21.0') console.log('OK   packageManager pnpm@10.21.0');
else failures.push(`packageManager pin mismatch: ${String(pkg.packageManager)}`);
if (pkg.engines && pkg.engines.node === '>=24.18.0 <25') console.log('OK   engines.node >=24.18.0 <25');
else failures.push(`engines.node mismatch: ${JSON.stringify(pkg.engines && pkg.engines.node)}`);

// 4. Workspace manifest declares the module layout.
let wsYaml = '';
try { wsYaml = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'); }
catch { failures.push('pnpm-workspace.yaml missing or unreadable'); }
if (wsYaml.includes('"apps/*"') && wsYaml.includes('"packages/*"')) console.log('OK   pnpm-workspace.yaml apps/* + packages/*');
else if (wsYaml) failures.push('pnpm-workspace.yaml does not declare apps/* and packages/*');

// 5. Required foundation files (README placeholders + scripts + example env).
const required = [
  '.env.example', '.gitattributes',
  'apps/web/README.md', 'apps/api/README.md', 'apps/worker/README.md',
  'packages/domain/README.md', 'packages/api-contract/README.md',
  'packages/wallet-adapter/README.md', 'packages/intents-adapter/README.md',
  'packages/ui/README.md', 'contracts/showstake/README.md',
  'scripts/verify-packet.mjs', 'scripts/verify-bootstrap.mjs',
  'scripts/run-packet-verifier.mjs',
  'scripts/postgres-disposable/README.md',
  'scripts/postgres-disposable/setup.sh',
  'scripts/postgres-disposable/setup.ps1',
];
for (const rel of required) {
  try { await access(join(root, rel), constants.R_OK); }
  catch { failures.push(`missing foundation file: ${rel}`); }
}
if (!failures.length) console.log(`OK   ${required.length} foundation files/dirs present`);

// 6. Python availability is required only for the packet verifier wrapper; report it.
let python = null;
for (const c of ['python', 'py', 'python3']) {
  try { execFileSync(c, ['--version'], { stdio: 'ignore' }); python = c; break; } catch { /* try next */ }
}
console.log(python ? `INFO python available via '${python}' (needed by packet verifier)` : 'INFO python not found on PATH (packet verifier wrapper will report NOT_RUN)');

if (failures.length) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  console.error(`\n${failures.length} bootstrap check(s) failed`);
  process.exit(1);
}
console.log('\nPASS: bootstrap foundation verified.');