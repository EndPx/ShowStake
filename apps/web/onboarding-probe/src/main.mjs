// DOM wiring for the T02 onboarding probe harness. All real logic lives in
// ./harness.mjs (imports @hot-labs/near-connect + near-api-js).

import {
  CANDIDATES,
  NEAR_AUTH_TESTNET,
  getState,
  selectCandidate,
  connectWallet,
  disconnectWallet,
  readAccount,
  signChallenge,
  verifyChallenge,
  resolveAccessKey,
  sameAccountAcrossSessions,
} from './harness.mjs';

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const resultEl = $('result');
const sameAccountEl = $('same-account');
const sessionTbody = $('session-table').querySelector('tbody');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

function showResult(obj) {
  resultEl.textContent = JSON.stringify(obj, null, 2);
}

function renderSessions() {
  const state = getState();
  sessionTbody.innerHTML = '';
  // Build cells with textContent (never innerHTML) so wallet-returned account /
  // public-key strings are inert text and cannot inject markup (Codex security
  // review requirement).
  const cell = (text, cls = '') => {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  };
  for (const s of state.sessions) {
    const tr = document.createElement('tr');
    tr.append(
      cell(String(s.seq)),
      cell(String(s.event)),
      cell(s.accountId ?? '—', 'mono'),
      cell(s.publicKey ?? '—', 'mono'),
      cell(String(s.at)),
    );
    sessionTbody.appendChild(tr);
  }
  const cmp = sameAccountAcrossSessions();
  if (cmp.ok) {
    sameAccountEl.textContent = `${cmp.code}: first=${cmp.first} last=${cmp.last}`;
    sameAccountEl.className = cmp.same ? 'ok' : 'bad';
    sameAccountEl.textContent += cmp.same ? ' (same account)' : ' (DIFFERENT account — account switch detected)';
  } else {
    sameAccountEl.textContent = 'connect twice (including after a disconnect) to compare';
    sameAccountEl.className = 'muted';
  }
  const acct = getState().accounts?.[0];
  $('btn-read').disabled = !acct;
  $('btn-sign').disabled = !acct;
  $('btn-verify').disabled = !getState().lastChallenge;
}

function renderCandidates() {
  const row = $('candidate-row');
  row.innerHTML = '';
  CANDIDATES.forEach((c) => {
    const label = document.createElement('label');
    label.style.marginRight = '14px';
    label.innerHTML = `<input type="radio" name="candidate" value="${c.id}" ${c.id === 'near-connect' ? 'checked' : ''}> ${c.label}`;
    label.querySelector('input').addEventListener('change', () => {
      selectCandidate(c.id);
      $('near-auth-panel').hidden = c.id !== 'near-auth';
      setStatus(c.id === 'near-connect' ? 'IDLE' : 'NOT_WIRED (documented/prepared; on-chain sign not invoked)');
      if (c.id !== 'near-connect') {
        $('btn-connect').disabled = true;
        $('btn-read').disabled = true;
        $('btn-sign').disabled = true;
        $('btn-verify').disabled = true;
      } else {
        $('btn-connect').disabled = false;
        renderSessions();
      }
    });
    row.appendChild(label);
  });
  renderNearAuthPanel();
}

function renderNearAuthPanel() {
  const a = NEAR_AUTH_TESTNET;
  const panel = $('near-auth-panel');
  panel.innerHTML = `
    <h2 style="margin-top:0">NEAR Auth (social/email — testnet)</h2>
    <div class="warn"><strong>Not wired for interactive connect.</strong>
    NEAR Auth message signing is ON-CHAIN: the harness would have to broadcast a
    <code>sign</code> transaction from a funded relayer account, which this probe is
    forbidden to do (no funded relayer, no human Auth0 approval, no spend
    authorization). Exact values are prepared below and recorded as NOT_RUN /
    BLOCKED_EXTERNAL.</div>
    <table>
      <tr><th>field</th><th>value</th></tr>
      <tr><td>network</td><td class="mono">${a.network}</td></tr>
      <tr><td>clientId (public dev)</td><td class="mono">${a.clientId}</td></tr>
      <tr><td>domain</td><td class="mono">${a.domain}</td></tr>
      <tr><td>signing audience</td><td class="mono">${a.signingAudience}</td></tr>
      <tr><td>fastAuth contract</td><td class="mono">${a.fastAuthContractId}</td></tr>
      <tr><td>MPC contract</td><td class="mono">${a.mpcContractId}</td></tr>
      <tr><td>RPC</td><td class="mono">${a.rpcUrl}</td></tr>
      <tr><td>sign contract</td><td class="mono">${a.signAction.contractId}</td></tr>
      <tr><td>sign method</td><td class="mono">${a.signAction.method}</td></tr>
      <tr><td>gas</td><td class="mono">${a.signAction.gas} (300 Tgas)</td></tr>
      <tr><td>attached deposit</td><td class="mono">${a.signAction.deposit} (1 yoctoNEAR)</td></tr>
      <tr><td>broadcasts?</td><td class="mono">${a.signAction.broadcasts} — MUST NOT run here</td></tr>
      <tr><td>approval boundary</td><td>${a.signAction.approvalBoundary}</td></tr>
    </table>
  `;
}

// --- action handlers --------------------------------------------------------

async function run(fn, label) {
  try {
    const r = await fn();
    showResult(r);
    setStatus(`${label}: ${r.code}`, r.ok ? 'ok' : (r.code === 'RPC_UNAVAILABLE' || r.code === 'SIGNING_UNSUPPORTED' ? 'warn' : 'bad'));
    renderSessions();
    return r;
  } catch (e) {
    const r = { ok: false, code: 'EXCEPTION', detail: String(e?.message ?? e) };
    showResult(r);
    setStatus(`${label}: ${r.code}`, 'bad');
    return r;
  }
}

$('btn-connect').addEventListener('click', () => run(connectWallet, 'connect'));
$('btn-read').addEventListener('click', async () => {
  const acct = getState().accounts?.[0];
  if (!acct) return;
  const r = await run(() => readAccount(acct.accountId), 'read account');
  // Also surface the key-ownership resolver view for transparency.
  const res = await run(() => resolveAccessKey(acct.accountId, acct.publicKey), 'resolve key');
  showResult({ read: r, resolveKey: res });
});
$('btn-sign').addEventListener('click', async () => {
  const acct = getState().accounts?.[0];
  if (!acct) return;
  await run(() => signChallenge(acct.accountId), 'sign');
});
$('btn-verify').addEventListener('click', () => run(verifyChallenge, 'verify'));
$('btn-disconnect').addEventListener('click', () => run(disconnectWallet, 'disconnect').then(renderSessions));
$('btn-reconnect').addEventListener('click', () => run(connectWallet, 'reconnect').then(renderSessions));

renderCandidates();
renderSessions();