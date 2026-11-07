// LOCAL product integration runner — real receipt/balance evidence only.
//
// NOT production settlement, NOT testnet/mainnet evidence. This binary starts
// a temporary NEAR Sandbox 2.14.0, deploys the existing test FT fixture and
// the reviewed ShowStake product Wasm, and drives the actual FT resolver path.
//
// The reviewed artifact is one-event-per-contract with an immutable organizer
// fixed in `new(organizer, canonical_ft, network, policy_version)`. Distinct
// events therefore use distinct contract instances; all state is per instance.
//
// This intentionally reuses the sandbox-probe harness dependency pins,
// isolated toolchain/target and `run-harness-owned.sh` supervisor instead of
// introducing new infrastructure.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::anyhow;
use base64::Engine;
use borsh::{BorshDeserialize, BorshSerialize};
use near_api::types::transaction::result::{
    ExecutionFinalResult, ExecutionOutcome, TransactionResult,
};
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::sandbox::patch::{FetchData, StateRecord};
use serde::{Deserialize, Serialize};

const SANDBOX_VERSION: &str = "2.14.0";
const DEPOSIT: u128 = 100;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;
/// D036 published policy identity (final commit, no voluntary withdrawal or
/// rejoin). The contract rejects the earlier `showstake-v2/1` label.
const POLICY_IDENTITY: &str = "showstake-v2-d036/1";

const EVENT_OPEN: &str = "evt-open";
const EVENT_OPEN2: &str = "evt-open-2";
const EVENT_CLOSED: &str = "evt-closed";
const EVENT_LIFE: &str = "evt-life";
const EVENT_HISTORY: &str = "evt-history";
const EVENT_TIMEOUT: &str = "evt-timeout";
const EVENT_FAIL: &str = "evt-fail";
const EVENT_DEADLINE: &str = "evt-deadline";

/// Exact Borsh mirror of the contract's stored `Event` for the bounded
/// Sandbox time jump. 24h of sandbox fast-forward is too slow on this host,
/// so the runner shortens only the stored `finalize_deadline` to
/// `checkin_close + 20s`, then uses the real sandbox clock/fast-forward to
/// cross it. Unit tests prove the real `checkin_close + 24h` derivation and
/// exact boundary; this Sandbox leg proves nonzero-principal timeout + claim
/// receipts/balances on a real Published event.
#[derive(BorshDeserialize, BorshSerialize, Debug)]
struct EventStorageMirror {
    event_id: String,
    organizer: String,
    rules_hash: String,
    deposit: u128,
    capacity: u32,
    reg_open: u64,
    reg_close: u64,
    cancel_cutoff: u64,
    checkin_open: u64,
    checkin_close: u64,
    finalize_deadline: u64,
    policy_version: String,
    state: u8,
    active_registrations: u32,
    total_registrations: u64,
    accepted_principal: u128,
    created_at: u64,
}

#[derive(Serialize)]
struct Evidence {
    schema: &'static str,
    label: &'static str,
    run_id: String,
    status: String,
    error: Option<String>,
    sandbox: SandboxEvidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    deadline_sandbox: Option<SandboxEvidence>,
    accounts: BTreeMap<String, String>,
    contracts: BTreeMap<String, String>,
    wasm: WasmEvidence,
    clock_ms: u64,
    event_rules: serde_json::Value,
    transactions: Vec<TxEvidence>,
    snapshots: Vec<Snapshot>,
    checks: Vec<Check>,
    limits: Vec<&'static str>,
}

#[derive(Serialize, Default, Debug)]
struct SandboxEvidence {
    version: String,
    rpc_addr: String,
    home_dir: String,
    fixture_only: bool,
    public_network_calls: bool,
}

#[derive(Serialize, Default, Debug)]
struct WasmEvidence {
    showstake_path: String,
    showstake_bytes: u64,
    showstake_sha256: String,
    ft_fixture_path: String,
    ft_fixture_bytes: u64,
    ft_fixture_sha256: String,
}

#[derive(Serialize, Clone, Debug)]
struct Check {
    id: String,
    description: String,
    passed: bool,
    detail: String,
}

#[derive(Serialize, Clone, Debug)]
struct OutcomeSummary {
    executor_id: String,
    success: bool,
    failure: bool,
    gas_burnt: u64,
    receipt_ids: Vec<String>,
    logs: Vec<String>,
    failure_detail: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
struct TxEvidence {
    label: String,
    note: String,
    tx_hash: String,
    top_level_success: bool,
    top_level_failure: bool,
    top_level_failure_detail: Option<String>,
    total_gas_burnt: u64,
    transaction_outcome: OutcomeSummary,
    receipts: Vec<OutcomeSummary>,
    return_json: Option<serde_json::Value>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
struct Snapshot {
    label: String,
    owner_a_a: String,
    owner_b_b: String,
    alice_a: String,
    bob_a: String,
    carol_a: String,
    dave_a: String,
    frank_a: String,
    alice_b: String,
    bob_b: String,
    open_stake_a: String,
    open2_stake_a: String,
    closed_stake_a: String,
    life_stake_a: String,
    timeout_stake_a: String,
    fail_stake_a: String,
    open_stake_b: String,
    ft_a_total: String,
    ft_b_total: String,
    organizer_credit_open: String,
    alice_credit_open: String,
    bob_credit_open: String,
    carol_credit_open: String,
    dave_credit_open: String,
    organizer_credit_open2: String,
    alice_credit_open2: String,
    dave_credit_open2: String,
    open_active: u32,
    open_total: u64,
    open_accepted: String,
    open_list: u32,
    open2_active: u32,
    open2_total: u64,
    open2_accepted: String,
    open2_list: u32,
    closed_active: u32,
    closed_total: u64,
    closed_list: u32,
    pass_owner: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ConfigJson {
    organizer: String,
    canonical_ft: String,
    network: String,
    policy_version: String,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
struct EventViewJson {
    event_id: String,
    organizer: String,
    canonical_ft: String,
    rules_hash: String,
    deposit: String,
    capacity: u32,
    reg_open: u64,
    reg_close: u64,
    cancel_cutoff: u64,
    checkin_open: u64,
    checkin_close: u64,
    finalize_deadline: u64,
    policy_version: String,
    state: String,
    phase: String,
    active_registrations: u32,
    total_registrations: u64,
    withdrawn_registrations: u64,
    accepted_principal: String,
    created_at: u64,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
struct ClaimViewJson {
    registration_id: String,
    event_id: String,
    beneficiary: String,
    amount: String,
    payout_state: String,
    pending_payout_id: Option<String>,
    paid_amount: String,
    withdrawn_at: u64,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
struct EventTotalsJson {
    event_id: String,
    state: String,
    registrations: u64,
    active_registrations: u32,
    withdrawn_registrations: u64,
    accepted_principal: String,
    paid: String,
    pending: String,
    liability: String,
}

#[allow(dead_code)]
#[derive(Clone, Deserialize, Debug)]
struct RegistrationJson {
    registration_id: String,
    event_id: String,
    pass_id: String,
    participant: String,
    beneficiary: String,
    commitment_id: String,
    amount: String,
    event_sequence: u64,
    registration_status: String,
    attendance_status: String,
    financial_status: String,
    registered_at: u64,
}

#[allow(dead_code)]
#[derive(Deserialize, Debug)]
struct PassJson {
    pass_id: String,
    event_id: String,
    registration_id: String,
    owner: String,
    issued_at: u64,
    registration_status: String,
    attendance_status: String,
    financial_status: String,
    policy_version: String,
}

struct Env {
    ft_a: Contract,
    ft_b: Contract,
    open_stake: Contract,
    open2_stake: Contract,
    closed_stake: Contract,
    open_id: AccountId,
    open2_id: AccountId,
    closed_id: AccountId,
    life_id: AccountId,
    timeout_id: AccountId,
    fail_id: AccountId,
    organizer: AccountId,
    alice: AccountId,
    bob: AccountId,
    carol: AccountId,
    dave: AccountId,
    frank: AccountId,
    owner_a: AccountId,
    owner_b: AccountId,
    network: NetworkConfig,
}

fn summary(outcome: &ExecutionOutcome) -> OutcomeSummary {
    OutcomeSummary {
        executor_id: outcome.executor_id.to_string(),
        success: outcome.is_success(),
        failure: outcome.is_failure(),
        gas_burnt: outcome.gas_burnt.as_gas(),
        receipt_ids: outcome.receipt_ids.iter().map(ToString::to_string).collect(),
        logs: outcome.logs.clone(),
        failure_detail: outcome
            .clone()
            .into_result()
            .err()
            .map(|error| format!("{error:?}")),
    }
}

fn capture(label: &str, result: &TransactionResult, note: &str) -> anyhow::Result<TxEvidence> {
    let full: ExecutionFinalResult = result
        .clone()
        .into_full()
        .ok_or_else(|| anyhow!("transaction result was pending, not final"))?;
    Ok(TxEvidence {
        label: label.to_string(),
        note: note.to_string(),
        tx_hash: full.outcome().transaction_hash.to_string(),
        top_level_success: full.is_success(),
        top_level_failure: full.is_failure(),
        top_level_failure_detail: full
            .clone()
            .into_result()
            .err()
            .map(|error| format!("{error}")),
        total_gas_burnt: full.total_gas_burnt.as_gas(),
        transaction_outcome: summary(full.outcome()),
        receipts: full.receipt_outcomes().iter().map(summary).collect(),
        return_json: full.json::<serde_json::Value>().ok(),
    })
}

async fn create_account(sandbox: &near_sandbox::Sandbox, name: &str) -> anyhow::Result<AccountId> {
    let account_id: AccountId = name.parse()?;
    sandbox
        .create_account(account_id.as_str().parse()?)
        .initial_balance(NearToken::from_near(25))
        .send()
        .await?;
    Ok(account_id)
}

async fn view<T: serde::de::DeserializeOwned + Send + Sync>(
    contract: &Contract,
    method: &str,
    args: serde_json::Value,
    network: &NetworkConfig,
) -> anyhow::Result<T> {
    let data: near_api::types::Data<T> = contract
        .call_function(method, args)
        .read_only()
        .fetch_from(network)
        .await?;
    Ok(data.data)
}

async fn try_view<T: serde::de::DeserializeOwned + Send + Sync>(
    contract: &Contract,
    method: &str,
    args: serde_json::Value,
    network: &NetworkConfig,
) -> Result<T, String> {
    view::<T>(contract, method, args, network)
        .await
        .map_err(|error| format!("{error:#}"))
}

async fn ft_balance(env: &Env, ft: &Contract, account: &AccountId) -> anyhow::Result<String> {
    view::<String>(
        ft,
        "ft_balance_of",
        serde_json::json!({"account_id": account}),
        &env.network,
    )
    .await
}

async fn credit(env: &Env, stake: &Contract, account: &AccountId) -> anyhow::Result<String> {
    view::<String>(
        stake,
        "storage_balance_of",
        serde_json::json!({"account_id": account}),
        &env.network,
    )
    .await
}

async fn event_view(
    env: &Env,
    stake: &Contract,
    event_id: &str,
) -> anyhow::Result<EventViewJson> {
    view::<EventViewJson>(
        stake,
        "get_event",
        serde_json::json!({"event_id": event_id}),
        &env.network,
    )
    .await
}

async fn registration_list(
    env: &Env,
    stake: &Contract,
    event_id: &str,
    from: u64,
    limit: u32,
) -> anyhow::Result<Vec<RegistrationJson>> {
    view::<Vec<RegistrationJson>>(
        stake,
        "list_event_registrations",
        serde_json::json!({"event_id": event_id, "from": from, "limit": limit}),
        &env.network,
    )
    .await
}

/// Snapshots can run before the first publish on an instance. `list_events`
/// is the non-panicking single-event view: it returns zero entries before
/// publish and one entry afterwards, so snapshots never call `get_event` on a
/// missing event (which traps at the Wasm level).
async fn single_event_or_none(
    env: &Env,
    stake: &Contract,
) -> anyhow::Result<Option<EventViewJson>> {
    let events = view::<Vec<EventViewJson>>(
        stake,
        "list_events",
        serde_json::json!({"from": 0u64, "limit": 10u32}),
        &env.network,
    )
    .await?;
    Ok(events.into_iter().next())
}

async fn claim_view(
    env: &Env,
    stake: &Contract,
    registration_id: &str,
) -> anyhow::Result<ClaimViewJson> {
    view::<ClaimViewJson>(
        stake,
        "get_claim",
        serde_json::json!({"registration_id": registration_id}),
        &env.network,
    )
    .await
}

async fn event_totals(
    env: &Env,
    stake: &Contract,
    event_id: &str,
) -> anyhow::Result<EventTotalsJson> {
    view::<EventTotalsJson>(
        stake,
        "get_event_totals",
        serde_json::json!({"event_id": event_id}),
        &env.network,
    )
    .await
}

async fn instance_escrow(env: &Env, stake: &Contract) -> anyhow::Result<String> {
    view::<String>(
        stake,
        "get_escrow_principal",
        serde_json::json!({}),
        &env.network,
    )
    .await
}

async fn lifecycle_state(
    env: &Env,
    stake: &Contract,
    event_id: &str,
    registration_ids: &[String],
) -> anyhow::Result<serde_json::Value> {
    let event = view::<EventViewJson>(
        stake,
        "get_event",
        serde_json::json!({"event_id": event_id}),
        &env.network,
    )
    .await?;
    let totals = event_totals(env, stake, event_id).await?;
    let escrow = instance_escrow(env, stake).await?;
    let mut claims = Vec::new();
    for registration_id in registration_ids {
        claims.push(claim_view(env, stake, registration_id).await?);
    }
    Ok(serde_json::json!({
        "event": event,
        "totals": totals,
        "escrow": escrow,
        "claims": claims,
    }))
}

#[allow(clippy::too_many_arguments)]
async fn call(
    contract: &Contract,
    method: &str,
    args: serde_json::Value,
    signer_id: &AccountId,
    signer: Arc<Signer>,
    network: &NetworkConfig,
    deposit: NearToken,
    gas: NearGas,
    label: &str,
    note: &str,
) -> anyhow::Result<TxEvidence> {
    let result = contract
        .call_function(method, args)
        .transaction()
        .gas(gas)
        .deposit(deposit)
        .with_signer(signer_id.clone(), signer)
        .send_to(network)
        .await?;
    capture(label, &result, note)
}

#[allow(clippy::too_many_arguments)]
async fn deploy(
    contract_id: &AccountId,
    wasm: &Path,
    init_method: &str,
    init_args: serde_json::Value,
    signer: Arc<Signer>,
    network: &NetworkConfig,
    label: &str,
    note: &str,
) -> anyhow::Result<TxEvidence> {
    let code = std::fs::read(wasm)?;
    let result = Contract::deploy(contract_id.clone())
        .use_code(code)
        .with_init_call(init_method, init_args)?
        .gas(NearGas::from_tgas(300))
        .with_signer(signer)
        .send_to(network)
        .await?;
    capture(label, &result, note)
}

fn check(
    checks: &mut Vec<Check>,
    id: &str,
    description: impl Into<String>,
    passed: bool,
    detail: impl Into<String>,
) {
    checks.push(Check {
        id: id.to_string(),
        description: description.into(),
        passed,
        detail: detail.into(),
    });
}

fn same_state(left: &Snapshot, right: &Snapshot) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    left.label.clear();
    right.label.clear();
    left == right
}

fn has_receipt_success(evidence: &TxEvidence, executor: &AccountId) -> bool {
    evidence
        .receipts
        .iter()
        .any(|receipt| receipt.executor_id == executor.to_string() && receipt.success)
}

fn has_receipt_failure(evidence: &TxEvidence, executor: &AccountId) -> bool {
    evidence
        .receipts
        .iter()
        .any(|receipt| receipt.executor_id == executor.to_string() && receipt.failure)
}

fn receipt_log_contains(evidence: &TxEvidence, executor: &AccountId, needle: &str) -> bool {
    evidence.receipts.iter().any(|receipt| {
        receipt.executor_id == executor.to_string()
            && receipt.logs.iter().any(|log| log.contains(needle))
    })
}

fn receipt_gas(evidence: &TxEvidence, executor: &AccountId) -> Option<u64> {
    evidence
        .receipts
        .iter()
        .find(|receipt| receipt.executor_id == executor.to_string())
        .map(|receipt| receipt.gas_burnt)
}

/// Shorten only the stored `finalize_deadline` for the bounded Sandbox
/// timeout leg. The value stays after `checkin_close`, preserving the event's
/// time ordering; the real clock is then advanced across it.
async fn patch_event_deadline(
    sandbox: &near_sandbox::Sandbox,
    stake_id: &AccountId,
    event_id: &str,
    deadline: u64,
) -> anyhow::Result<()> {
    let fetched = sandbox
        .patch_state(stake_id.as_str().parse()?)
        .fetch_from(&sandbox.rpc_addr, FetchData::new().storage())
        .await?;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut expected_key = b"ev".to_vec();
    expected_key.extend_from_slice(&(event_id.len() as u32).to_le_bytes());
    expected_key.extend_from_slice(event_id.as_bytes());
    for record in fetched.state.iter() {
        let StateRecord::Data {
            data_key_base64,
            value_base64,
            ..
        } = record
        else {
            continue;
        };
        let key = engine.decode(data_key_base64)?;
        if key != expected_key {
            continue;
        }
        let mut event = EventStorageMirror::try_from_slice(&engine.decode(value_base64)?)?;
        event.finalize_deadline = deadline;
        let value = borsh::to_vec(&event)?;
        sandbox
            .patch_state(stake_id.as_str().parse()?)
            .storage(engine.encode(&expected_key), engine.encode(&value))
            .send()
            .await?;
        return Ok(());
    }
    anyhow::bail!("event storage key not found for {event_id}")
}

fn parse_u128(value: &str) -> u128 {
    value.parse().unwrap_or_else(|_| panic!("not a u128: {value}"))
}

fn returned_u128(tx: &TxEvidence) -> Option<u128> {
    tx.return_json
        .as_ref()
        .and_then(|value| value.as_str())
        .and_then(|value| value.parse().ok())
}

fn event_rules(
    rules_hash: &str,
    capacity: u32,
    reg_open: u64,
    reg_close: u64,
    checkin_close: u64,
) -> serde_json::Value {
    serde_json::json!({
        "rules_hash": rules_hash,
        "deposit": DEPOSIT.to_string(),
        "capacity": capacity,
        "reg_open": reg_open,
        "reg_close": reg_close,
        "cancel_cutoff": reg_close,
        "checkin_open": reg_close,
        "checkin_close": checkin_close,
    })
}

fn commit_msg(event_id: &str, commitment_id: &str) -> String {
    format!(
        r#"{{"version":1,"event_id":"{event_id}","commitment_id":"{commitment_id}"}}"#
    )
}

async fn snapshot(env: &Env, label: &str) -> anyhow::Result<Snapshot> {
    let open = single_event_or_none(env, &env.open_stake).await?;
    let open2 = single_event_or_none(env, &env.open2_stake).await?;
    let closed = single_event_or_none(env, &env.closed_stake).await?;
    let open_registrations = match &open {
        Some(event) => registration_list(env, &env.open_stake, &event.event_id, 0, 50).await?,
        None => Vec::new(),
    };
    let open2_registrations = match &open2 {
        Some(event) => registration_list(env, &env.open2_stake, &event.event_id, 0, 50).await?,
        None => Vec::new(),
    };
    let closed_registrations = match &closed {
        Some(event) => registration_list(env, &env.closed_stake, &event.event_id, 0, 50).await?,
        None => Vec::new(),
    };
    let pass_owner = match open_registrations.first() {
        Some(registration) => {
            let pass = view::<PassJson>(
                &env.open_stake,
                "get_pass",
                serde_json::json!({"pass_id": registration.pass_id}),
                &env.network,
            )
            .await?;
            Some(pass.owner)
        }
        None => None,
    };

    Ok(Snapshot {
        label: label.to_string(),
        owner_a_a: ft_balance(env, &env.ft_a, &env.owner_a).await?,
        owner_b_b: ft_balance(env, &env.ft_b, &env.owner_b).await?,
        alice_a: ft_balance(env, &env.ft_a, &env.alice).await?,
        bob_a: ft_balance(env, &env.ft_a, &env.bob).await?,
        carol_a: ft_balance(env, &env.ft_a, &env.carol).await?,
        dave_a: ft_balance(env, &env.ft_a, &env.dave).await?,
        frank_a: ft_balance(env, &env.ft_a, &env.frank).await?,
        alice_b: ft_balance(env, &env.ft_b, &env.alice).await?,
        bob_b: ft_balance(env, &env.ft_b, &env.bob).await?,
        open_stake_a: ft_balance(env, &env.ft_a, &env.open_id).await?,
        open2_stake_a: ft_balance(env, &env.ft_a, &env.open2_id).await?,
        closed_stake_a: ft_balance(env, &env.ft_a, &env.closed_id).await?,
        life_stake_a: ft_balance(env, &env.ft_a, &env.life_id).await?,
        timeout_stake_a: ft_balance(env, &env.ft_a, &env.timeout_id).await?,
        fail_stake_a: ft_balance(env, &env.ft_a, &env.fail_id).await?,
        open_stake_b: ft_balance(env, &env.ft_b, &env.open_id).await?,
        ft_a_total: view::<String>(
            &env.ft_a,
            "ft_total_supply",
            serde_json::json!({}),
            &env.network,
        )
        .await?,
        ft_b_total: view::<String>(
            &env.ft_b,
            "ft_total_supply",
            serde_json::json!({}),
            &env.network,
        )
        .await?,
        organizer_credit_open: credit(env, &env.open_stake, &env.organizer).await?,
        alice_credit_open: credit(env, &env.open_stake, &env.alice).await?,
        bob_credit_open: credit(env, &env.open_stake, &env.bob).await?,
        carol_credit_open: credit(env, &env.open_stake, &env.carol).await?,
        dave_credit_open: credit(env, &env.open_stake, &env.dave).await?,
        organizer_credit_open2: credit(env, &env.open2_stake, &env.organizer).await?,
        alice_credit_open2: credit(env, &env.open2_stake, &env.alice).await?,
        dave_credit_open2: credit(env, &env.open2_stake, &env.dave).await?,
        open_active: open.as_ref().map_or(0, |event| event.active_registrations),
        open_total: open.as_ref().map_or(0, |event| event.total_registrations),
        open_accepted: open
            .as_ref()
            .map_or_else(|| "0".to_string(), |event| event.accepted_principal.clone()),
        open_list: open_registrations.len() as u32,
        open2_active: open2.as_ref().map_or(0, |event| event.active_registrations),
        open2_total: open2.as_ref().map_or(0, |event| event.total_registrations),
        open2_accepted: open2
            .as_ref()
            .map_or_else(|| "0".to_string(), |event| event.accepted_principal.clone()),
        open2_list: open2_registrations.len() as u32,
        closed_active: closed.as_ref().map_or(0, |event| event.active_registrations),
        closed_total: closed.as_ref().map_or(0, |event| event.total_registrations),
        closed_list: closed_registrations.len() as u32,
        pass_owner,
    })
}

fn refund_preserved(
    checks: &mut Vec<Check>,
    prefix: &str,
    before: &Snapshot,
    after: &Snapshot,
    tx: &TxEvidence,
    stake_id: &AccountId,
    reason: &str,
) {
    check(
        checks,
        &format!("{prefix}_no_state_change"),
        "invalid deposit changed no balance, credit, count, escrow or pass",
        same_state(before, after),
        format!("before={before:?} after={after:?}"),
    );
    check(
        checks,
        &format!("{prefix}_tx_completed"),
        "ft_transfer_call completed through the real FT resolver",
        tx.top_level_success,
        format!(
            "{} tx={}",
            tx.tx_hash,
            tx.top_level_failure_detail.clone().unwrap_or_default()
        ),
    );
    check(
        checks,
        &format!("{prefix}_receiver_receipt"),
        "ShowStake ft_on_transfer receipt succeeded and returned the unused amount",
        has_receipt_success(tx, stake_id),
        format!("{tx:?}"),
    );
    check(
        checks,
        &format!("{prefix}_reject_reason"),
        format!("ShowStake logged the expected rejection reason {reason}"),
        receipt_log_contains(tx, stake_id, &format!("SHOWSTAKE_REJECT reason={reason}")),
        format!("{tx:?}"),
    );
}

async fn run_case(evidence: &mut Evidence, ft_wasm: &Path, showstake_wasm: &Path) -> anyhow::Result<()> {
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_version(SANDBOX_VERSION).await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    evidence.sandbox = SandboxEvidence {
        version: SANDBOX_VERSION.to_string(),
        rpc_addr: sandbox.rpc_addr.clone(),
        home_dir: sandbox.home_dir.path().display().to_string(),
        fixture_only: true,
        public_network_calls: false,
    };

    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;

    let organizer = create_account(&sandbox, "organizer.sandbox").await?;
    let alice = create_account(&sandbox, "alice.sandbox").await?;
    let bob = create_account(&sandbox, "bob.sandbox").await?;
    let carol = create_account(&sandbox, "carol.sandbox").await?;
    let dave = create_account(&sandbox, "dave.sandbox").await?;
    let frank = create_account(&sandbox, "frank.sandbox").await?;
    let owner_a = create_account(&sandbox, "owner-a.sandbox").await?;
    let owner_b = create_account(&sandbox, "owner-b.sandbox").await?;
    let ft_a_id = create_account(&sandbox, "ft-a.sandbox").await?;
    let ft_b_id = create_account(&sandbox, "ft-b.sandbox").await?;
    let open_id = create_account(&sandbox, "showstake-open.sandbox").await?;
    let open2_id = create_account(&sandbox, "showstake-open2.sandbox").await?;
    let closed_id = create_account(&sandbox, "showstake-closed.sandbox").await?;
    let life_id = create_account(&sandbox, "showstake-life.sandbox").await?;
    let history_id = create_account(&sandbox, "showstake-history.sandbox").await?;
    let timeout_id = create_account(&sandbox, "showstake-timeout.sandbox").await?;
    let fail_id = create_account(&sandbox, "showstake-fail.sandbox").await?;

    evidence.accounts = BTreeMap::from([
        ("organizer".to_string(), organizer.to_string()),
        ("alice".to_string(), alice.to_string()),
        ("bob".to_string(), bob.to_string()),
        ("carol".to_string(), carol.to_string()),
        ("dave".to_string(), dave.to_string()),
        ("frank".to_string(), frank.to_string()),
        ("owner_a".to_string(), owner_a.to_string()),
        ("owner_b".to_string(), owner_b.to_string()),
    ]);
    evidence.contracts = BTreeMap::from([
        ("canonical_ft_a".to_string(), ft_a_id.to_string()),
        ("wrong_ft_b".to_string(), ft_b_id.to_string()),
        ("showstake_open".to_string(), open_id.to_string()),
        ("showstake_open2".to_string(), open2_id.to_string()),
        ("showstake_closed".to_string(), closed_id.to_string()),
        ("showstake_life".to_string(), life_id.to_string()),
        ("showstake_history".to_string(), history_id.to_string()),
        ("showstake_timeout".to_string(), timeout_id.to_string()),
        ("showstake_fail".to_string(), fail_id.to_string()),
    ]);

    let ft_a = Contract(ft_a_id.clone());
    let ft_b = Contract(ft_b_id.clone());
    let open_stake = Contract(open_id.clone());
    let open2_stake = Contract(open2_id.clone());
    let closed_stake = Contract(closed_id.clone());
    let life_stake = Contract(life_id.clone());
    let history_stake = Contract(history_id.clone());
    let timeout_stake = Contract(timeout_id.clone());
    let fail_stake = Contract(fail_id.clone());
    let env = Env {
        ft_a: ft_a.clone(),
        ft_b: ft_b.clone(),
        open_stake: open_stake.clone(),
        open2_stake: open2_stake.clone(),
        closed_stake: closed_stake.clone(),
        open_id: open_id.clone(),
        open2_id: open2_id.clone(),
        closed_id: closed_id.clone(),
        life_id: life_id.clone(),
        timeout_id: timeout_id.clone(),
        fail_id: fail_id.clone(),
        organizer: organizer.clone(),
        alice: alice.clone(),
        bob: bob.clone(),
        carol: carol.clone(),
        dave: dave.clone(),
        frank: frank.clone(),
        owner_a: owner_a.clone(),
        owner_b: owner_b.clone(),
        network: network.clone(),
    };

    // ---------------------------------------------------------------- deploy
    let metadata_a = serde_json::json!({
        "spec": "ft-1.0.0", "name": "Sandbox FT A", "symbol": "SFT-A",
        "icon": null, "reference": null, "reference_hash": null, "decimals": 0
    });
    let metadata_b = serde_json::json!({
        "spec": "ft-1.0.0", "name": "Sandbox FT B", "symbol": "SFT-B",
        "icon": null, "reference": null, "reference_hash": null, "decimals": 0
    });
    let init_args = |stake_ft: &AccountId| {
        serde_json::json!({
            "organizer": organizer,
            "canonical_ft": stake_ft,
            "network": "sandbox-local",
            "policy_version": POLICY_IDENTITY,
        })
    };
    for tx in [
        deploy(
            &ft_a_id,
            ft_wasm,
            "new",
            serde_json::json!({"owner_id": owner_a, "total_supply": "1000000", "metadata": metadata_a}),
            signer.clone(),
            &network,
            "deploy_ft_a",
            "existing NEP-141 test fixture (canonical FT)",
        )
        .await?,
        deploy(
            &ft_b_id,
            ft_wasm,
            "new",
            serde_json::json!({"owner_id": owner_b, "total_supply": "1000000", "metadata": metadata_b}),
            signer.clone(),
            &network,
            "deploy_ft_b",
            "existing NEP-141 test fixture (wrong-token fixture)",
        )
        .await?,
        deploy(
            &open_id,
            showstake_wasm,
            "new",
            init_args(&ft_a_id),
            signer.clone(),
            &network,
            "deploy_showstake_open",
            "ShowStake instance for evt-open + evt-closed rejection + pass coverage",
        )
        .await?,
        deploy(
            &open2_id,
            showstake_wasm,
            "new",
            init_args(&ft_a_id),
            signer.clone(),
            &network,
            "deploy_showstake_open2",
            "separate ShowStake instance for a second event",
        )
        .await?,
        deploy(
            &closed_id,
            showstake_wasm,
            "new",
            init_args(&ft_a_id),
            signer.clone(),
            &network,
            "deploy_showstake_closed",
            "separate ShowStake instance for an already-closed event",
        )
        .await?,
        deploy(
            &life_id,
            showstake_wasm,
            "new",
            init_args(&ft_a_id),
            signer.clone(),
            &network,
            "deploy_showstake_life",
            "lifecycle instance: cancel and claim at capacity 3",
        )
        .await?,
        deploy(
            &history_id,
            showstake_wasm,
            "new",
            init_args(&ft_b_id),
            signer.clone(),
            &network,
            "deploy_showstake_history",
            "capacity-200 instance for max-capacity cancellation gas and claims",
        )
        .await?,
        deploy(
            &timeout_id,
            showstake_wasm,
            "new",
            init_args(&ft_a_id),
            signer.clone(),
            &network,
            "deploy_showstake_timeout",
            "lifecycle instance: permissionless timeout refund-only",
        )
        .await?,
        deploy(
            &fail_id,
            showstake_wasm,
            "new",
            init_args(&ft_a_id),
            signer.clone(),
            &network,
            "deploy_showstake_fail",
            "lifecycle instance: failed FT payout restoration and retry",
        )
        .await?,
    ] {
        check(
            &mut evidence.checks,
            &format!("{}_success", tx.label),
            "deployment transaction succeeds",
            tx.top_level_success,
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }

    for (label, stake, stake_id) in [
        ("config_open", &open_stake, &open_id),
        ("config_open2", &open2_stake, &open2_id),
        ("config_closed", &closed_stake, &closed_id),
        ("config_life", &life_stake, &life_id),
        ("config_timeout", &timeout_stake, &timeout_id),
        ("config_fail", &fail_stake, &fail_id),
    ] {
        let config = view::<ConfigJson>(stake, "get_config", serde_json::json!({}), &network).await?;
        check(
            &mut evidence.checks,
            &format!("{label}_immutable"),
            "each instance has the exact organizer, canonical FT and labels",
            config.organizer == organizer.to_string()
                && config.canonical_ft == ft_a_id.to_string()
                && config.network == "sandbox-local"
                && config.policy_version == POLICY_IDENTITY,
            format!("stake={stake_id} {config:?}"),
        );
    }
    let history_config =
        view::<ConfigJson>(&history_stake, "get_config", serde_json::json!({}), &network).await?;
    check(
        &mut evidence.checks,
        "config_history_immutable",
        "history instance has the exact organizer, canonical FT B and labels",
        history_config.organizer == organizer.to_string()
            && history_config.canonical_ft == ft_b_id.to_string()
            && history_config.network == "sandbox-local"
            && history_config.policy_version == POLICY_IDENTITY,
        format!("stake={history_id} {history_config:?}"),
    );
    let clock_ms = view::<u64>(
        &open_stake,
        "get_block_timestamp_ms",
        serde_json::json!({}),
        &network,
    )
    .await?;
    evidence.clock_ms = clock_ms;

    // -------------------------------------------------------- FT registration
    for (label, ft, target, note) in [
        ("ft_a_storage_open", &ft_a, &open_id, "register open instance on canonical FT"),
        ("ft_a_storage_open2", &ft_a, &open2_id, "register second instance on canonical FT"),
        ("ft_a_storage_closed", &ft_a, &closed_id, "register closed instance on canonical FT"),
        ("ft_a_storage_life", &ft_a, &life_id, "register lifecycle instance on canonical FT"),
        ("ft_a_storage_timeout", &ft_a, &timeout_id, "register timeout instance on canonical FT"),
        ("ft_a_storage_fail", &ft_a, &fail_id, "register failed-payout instance on canonical FT"),
        ("ft_b_storage_open", &ft_b, &open_id, "register open instance on wrong-token FT"),
        ("ft_a_storage_alice", &ft_a, &alice, "register alice on canonical FT"),
        ("ft_a_storage_bob", &ft_a, &bob, "register bob on canonical FT"),
        ("ft_a_storage_carol", &ft_a, &carol, "register carol on canonical FT"),
        ("ft_a_storage_dave", &ft_a, &dave, "register dave on canonical FT"),
        ("ft_a_storage_frank", &ft_a, &frank, "register frank on canonical FT"),
        ("ft_b_storage_alice", &ft_b, &alice, "register alice on wrong-token FT"),
        ("ft_b_storage_bob", &ft_b, &bob, "register bob on wrong-token FT"),
        ("ft_b_storage_history", &ft_b, &history_id, "register history instance on FT B"),
        ("ft_b_storage_owner_b", &ft_b, &owner_b, "register owner B on FT B"),
    ] {
        let tx = call(
            ft,
            "storage_deposit",
            serde_json::json!({"account_id": target, "registration_only": true}),
            &organizer,
            signer.clone(),
            &network,
            NearToken::from_millinear(10),
            NearGas::from_tgas(30),
            label,
            note,
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("{label}_success"),
            "test-only FT storage registration succeeds",
            tx.top_level_success,
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }

    // --------------------------------------------------------------- funding
    for (label, ft, owner, target, amount, note) in [
        ("fund_alice_a", &ft_a, &owner_a, &alice, "1000", "owner A -> alice 1000 SFT-A"),
        ("fund_bob_a", &ft_a, &owner_a, &bob, "1000", "owner A -> bob 1000 SFT-A"),
        ("fund_carol_a", &ft_a, &owner_a, &carol, "1000", "owner A -> carol 1000 SFT-A"),
        ("fund_dave_a", &ft_a, &owner_a, &dave, "1000", "owner A -> dave 1000 SFT-A"),
        ("fund_frank_a", &ft_a, &owner_a, &frank, "100", "owner A -> frank 100 SFT-A (zero after commit)"),
        ("fund_alice_b", &ft_b, &owner_b, &alice, "1000", "owner B -> alice 1000 SFT-B"),
        ("fund_bob_b", &ft_b, &owner_b, &bob, "1000", "owner B -> bob 1000 SFT-B"),
    ] {
        let tx = call(
            ft,
            "ft_transfer",
            serde_json::json!({"receiver_id": target, "amount": amount, "memo": null}),
            owner,
            signer.clone(),
            &network,
            NearToken::from_yoctonear(1),
            NearGas::from_tgas(30),
            label,
            note,
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("{label}_success"),
            "test-only FT funding succeeds",
            tx.top_level_success,
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }

    // ---------------------------------------- participant prepaid storage
    let prepay = NearToken::from_millinear(500);
    let topup = NearToken::from_millinear(100);
    let mut alice_initial_credit = 0u128;
    for (label, stake, account, amount, note) in [
        ("storage_deposit_alice", &open_stake, &alice, prepay, "alice prepays 0.5 NEAR storage credit"),
        ("storage_deposit_bob", &open_stake, &bob, prepay, "bob prepays 0.5 NEAR storage credit"),
        ("storage_deposit_carol", &open_stake, &carol, prepay, "carol prepays 0.5 NEAR storage credit"),
        ("storage_deposit_dave_open2", &open2_stake, &dave, prepay, "dave prepays 0.5 NEAR on the second instance"),
        ("storage_deposit_alice_life", &life_stake, &alice, prepay, "alice prepays on the lifecycle instance"),
        ("storage_deposit_bob_life", &life_stake, &bob, prepay, "bob prepays on the lifecycle instance"),
        ("storage_deposit_alice_timeout", &timeout_stake, &alice, prepay, "alice prepays on the timeout instance"),
        ("storage_deposit_bob_history", &history_stake, &bob, prepay, "bob prepays on the capacity-200 maxcap instance"),
        ("storage_deposit_frank_fail", &fail_stake, &frank, prepay, "frank prepays on the failed-payout instance"),
    ] {
        let tx = call(
            stake,
            "storage_deposit",
            serde_json::json!({"account_id": null}),
            account,
            signer.clone(),
            &network,
            amount,
            NearGas::from_tgas(30),
            label,
            note,
        )
        .await?;
        let returned = returned_u128(&tx);
        check(
            &mut evidence.checks,
            &format!("{label}_success"),
            "explicit native storage prepayment succeeds",
            tx.top_level_success,
            tx.tx_hash.clone(),
        );
        if label == "storage_deposit_alice" {
            alice_initial_credit = returned.unwrap_or(0);
            check(
                &mut evidence.checks,
                "storage_deposit_alice_net_of_entry",
                "a new credit entry is charged from the attached deposit; credit is 0 < returned < attached",
                returned.map_or(false, |value| value > 0 && value < amount.as_yoctonear()),
                format!("attached={} returned={returned:?}", amount.as_yoctonear()),
            );
        }
        evidence.transactions.push(tx);
    }

    // Existing-entry top-up: exact full credit, measured zero new growth.
    let tx = call(
        &open_stake,
        "storage_deposit",
        serde_json::json!({"account_id": null}),
        &alice,
        signer.clone(),
        &network,
        topup,
        NearGas::from_tgas(30),
        "storage_deposit_alice_topup",
        "alice tops up an existing credit entry",
    )
    .await?;
    let alice_credit_after_topup = parse_u128(&credit(&env, &open_stake, &alice).await?);
    check(
        &mut evidence.checks,
        "storage_deposit_alice_topup_exact",
        "existing-entry top-up credits the full attached amount (no second entry charge)",
        tx.top_level_success
            && alice_credit_after_topup == alice_initial_credit + topup.as_yoctonear(),
        format!("initial={alice_initial_credit} topup={} after={alice_credit_after_topup}", topup.as_yoctonear()),
    );
    evidence.transactions.push(tx);

    // 1 yoctoNEAR new prepay must fail and leave no credit entry.
    let tx = call(
        &open_stake,
        "storage_deposit",
        serde_json::json!({"account_id": null}),
        &dave,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(30),
        "storage_deposit_dave_one_yocto",
        "1 yoctoNEAR must not buy a new credit entry",
    )
    .await?;
    let dave_credit_after_reject = credit(&env, &open_stake, &dave).await?;
    check(
        &mut evidence.checks,
        "storage_deposit_one_yocto_rejected",
        "1 yoctoNEAR new prepay fails and leaves no credit",
        tx.top_level_failure
            && has_receipt_failure(&tx, &open_id)
            && dave_credit_after_reject == "0",
        format!("tx={tx:?} dave_credit={dave_credit_after_reject}"),
    );
    evidence.transactions.push(tx);

    let tx = call(
        &open_stake,
        "storage_deposit",
        serde_json::json!({"account_id": null}),
        &dave,
        signer.clone(),
        &network,
        prepay,
        NearGas::from_tgas(30),
        "storage_deposit_dave_after_reject",
        "dave prepays after the rejected 1 yoctoNEAR attempt",
    )
    .await?;
    check(
        &mut evidence.checks,
        "storage_deposit_dave_after_reject_success",
        "an adequate new prepay succeeds after the atomic 1 yoctoNEAR rejection",
        tx.top_level_success
            && returned_u128(&tx).map_or(false, |value| value > 0),
        tx.tx_hash.clone(),
    );
    evidence.transactions.push(tx);

    // --------------------------------------------------------------- publish
    let open_rules = event_rules(
        "local-rules-open-v1",
        3,
        clock_ms - 60_000,
        clock_ms + HOUR_MS,
        clock_ms + 2 * HOUR_MS,
    );
    let open2_rules = event_rules(
        "local-rules-open2-v1",
        2,
        clock_ms - 60_000,
        clock_ms + HOUR_MS,
        clock_ms + 2 * HOUR_MS,
    );
    let closed_rules = event_rules(
        "local-rules-closed-v1",
        2,
        clock_ms - 3 * HOUR_MS,
        clock_ms - 2 * HOUR_MS,
        clock_ms - HOUR_MS,
    );
    let life_rules = event_rules(
        "local-rules-life-v1",
        3,
        clock_ms - 60_000,
        clock_ms + HOUR_MS,
        clock_ms + 2 * HOUR_MS,
    );
    // Capacity 200, no voluntary withdrawal/rejoin: total registrations are
    // bounded by capacity and cancellation/timeout must stay O(1).
    let history_rules = event_rules(
        "local-rules-maxcap-v1",
        200,
        clock_ms - 60_000,
        clock_ms + HOUR_MS,
        clock_ms + 2 * HOUR_MS,
    );
    // Past-deadline zero-registration instance remains the permissionless
    // activation check. A separate Sandbox with a 5s block time proves the
    // real timeout path with nonzero deposited principal and claim.
    // Exact deadline-1/at-deadline is covered by the unit suite.
    let timeout_rules = event_rules(
        "local-rules-timeout-v1",
        2,
        clock_ms - 30 * HOUR_MS,
        clock_ms - 29 * HOUR_MS,
        clock_ms - 28 * HOUR_MS,
    );
    let fail_rules = event_rules(
        "local-rules-fail-v1",
        2,
        clock_ms - 60_000,
        clock_ms + 2 * HOUR_MS,
        clock_ms + 3 * HOUR_MS,
    );
    evidence.event_rules = serde_json::json!({
        "open": open_rules,
        "open2": open2_rules,
        "closed": closed_rules,
        "life": life_rules,
        "history": history_rules,
        "timeout": timeout_rules,
        "fail": fail_rules,
        "expected_finalize_deadline_ms": clock_ms + 2 * HOUR_MS + DAY_MS,
        "instances": {
            "open": open_id,
            "open2": open2_id,
            "closed": closed_id,
            "life": life_id,
            "history": history_id,
            "timeout": timeout_id,
            "fail": fail_id,
        }
    });

    // Unauthorized publisher must be denied before the instance has an event.
    let before = snapshot(&env, "before_unauthorized_publish").await?;
    let tx = call(
        &open2_stake,
        "publish_event",
        serde_json::json!({"event_id": EVENT_OPEN2, "rules": open2_rules}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_near(1),
        NearGas::from_tgas(100),
        "publish_unauthorized",
        "only the immutable organizer may publish",
    )
    .await?;
    let after = snapshot(&env, "after_unauthorized_publish").await?;
    check(
        &mut evidence.checks,
        "publish_unauthorized_fails",
        "non-organizer publish fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &open2_id),
        format!("{tx:?}"),
    );
    check(
        &mut evidence.checks,
        "publish_unauthorized_no_state",
        "denied unauthorized publish changed no event, credit or balance",
        same_state(&before, &after),
        format!("before={before:?} after={after:?}"),
    );
    evidence.snapshots.push(after.clone());
    evidence.transactions.push(tx);

    // Configured organizer publishes each separate instance.
    for (label, stake, event_id, rules, note) in [
        ("publish_open", &open_stake, EVENT_OPEN, open_rules.clone(), "publish evt-open on its own instance"),
        ("publish_open2", &open2_stake, EVENT_OPEN2, open2_rules.clone(), "publish evt-open-2 on its own instance"),
        ("publish_closed", &closed_stake, EVENT_CLOSED, closed_rules.clone(), "publish already-closed evt-closed on its own instance"),
        ("publish_life", &life_stake, EVENT_LIFE, life_rules.clone(), "publish lifecycle event on its own instance"),
        ("publish_history", &history_stake, EVENT_HISTORY, history_rules.clone(), "publish capacity-200 cancellation event on its own instance"),
        ("publish_timeout", &timeout_stake, EVENT_TIMEOUT, timeout_rules.clone(), "publish timeout event on its own instance"),
        ("publish_fail", &fail_stake, EVENT_FAIL, fail_rules.clone(), "publish failed-payout event on its own instance"),
    ] {
        let tx = call(
            stake,
            "publish_event",
            serde_json::json!({"event_id": event_id, "rules": rules}),
            &organizer,
            signer.clone(),
            &network,
            NearToken::from_near(1),
            NearGas::from_tgas(100),
            label,
            note,
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("{label}_success"),
            "organizer event publish succeeds",
            tx.top_level_success,
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }

    let open_event = event_view(&env, &open_stake, EVENT_OPEN).await?;
    check(
        &mut evidence.checks,
        "open_event_rules",
        "organizer is the configured account; immutable rules are exact",
        open_event.organizer == organizer.to_string()
            && open_event.canonical_ft == ft_a_id.to_string()
            && open_event.deposit == DEPOSIT.to_string()
            && open_event.capacity == 3
            && open_event.rules_hash == "local-rules-open-v1"
            && open_event.state == "Published"
            && open_event.phase == "RegistrationOpen"
            && open_event.policy_version == POLICY_IDENTITY,
        format!("{open_event:?}"),
    );
    check(
        &mut evidence.checks,
        "open_event_deadline",
        "finalize_deadline is checkin_close + 24h with checked arithmetic",
        open_event.finalize_deadline == clock_ms + 2 * HOUR_MS + DAY_MS,
        format!("deadline={} expected={}", open_event.finalize_deadline, clock_ms + 2 * HOUR_MS + DAY_MS),
    );

    // One event per contract: a second publish of a distinct id must fail and
    // leave event state and the organizer credit unchanged.
    let before = snapshot(&env, "before_second_publish").await?;
    let tx = call(
        &open_stake,
        "publish_event",
        serde_json::json!({"event_id": "evt-open-second", "rules": open_rules.clone()}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_near(1),
        NearGas::from_tgas(100),
        "publish_second_event",
        "a contract instance must host exactly one event",
    )
    .await?;
    let after = snapshot(&env, "after_second_publish").await?;
    check(
        &mut evidence.checks,
        "publish_second_event_fails",
        "second publish fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &open_id),
        format!("{tx:?}"),
    );
    check(
        &mut evidence.checks,
        "publish_second_event_no_state",
        "second publish changed no event, credit or balance",
        same_state(&before, &after),
        format!("before={before:?} after={after:?}"),
    );
    check(
        &mut evidence.checks,
        "publish_second_event_not_stored",
        "the second event id does not exist",
        try_view::<EventViewJson>(
            &open_stake,
            "get_event",
            serde_json::json!({"event_id": "evt-open-second"}),
            &network,
        )
        .await
        .is_err(),
        "get_event(evt-open-second) returned an error",
    );
    evidence.snapshots.push(after.clone());
    evidence.transactions.push(tx);

    for (label, stake, event_id) in [
        ("open", &open_stake, EVENT_OPEN),
        ("open2", &open2_stake, EVENT_OPEN2),
        ("closed", &closed_stake, EVENT_CLOSED),
    ] {
        let events = view::<Vec<EventViewJson>>(
            stake,
            "list_events",
            serde_json::json!({"from": 0u64, "limit": 10u32}),
            &network,
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("list_events_{label}_single"),
            "each contract instance lists exactly its one published event",
            events.len() == 1 && events[0].event_id == event_id,
            format!("{events:?}"),
        );
    }

    let initial = snapshot(&env, "initial").await?;
    evidence.snapshots.push(initial.clone());
    check(
        &mut evidence.checks,
        "initial_balances",
        "participants hold 1000 SFT-A, alice/bob hold 1000 SFT-B, escrow empty",
        initial.alice_a == "1000"
            && initial.bob_a == "1000"
            && initial.carol_a == "1000"
            && initial.dave_a == "1000"
            && initial.alice_b == "1000"
            && initial.bob_b == "1000"
            && initial.open_stake_a == "0"
            && initial.open2_stake_a == "0"
            && initial.closed_stake_a == "0"
            && initial.open_stake_b == "0"
            && initial.open_active == 0
            && initial.open_list == 0,
        format!("{initial:?}"),
    );

    // ------------------------------------------------ accepted registration
    let before = snapshot(&env, "before_alice").await?;
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": open_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_OPEN, "alice-c1"),
        }),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "alice_commit_exact",
        "canonical FT, exact D, valid message, prepaid storage",
    )
    .await?;
    let after_alice = snapshot(&env, "after_alice").await?;
    evidence.snapshots.push(after_alice.clone());
    check(
        &mut evidence.checks,
        "alice_ft_debit",
        "alice FT A balance decreased by exactly D",
        parse_u128(&after_alice.alice_a) + DEPOSIT == parse_u128(&before.alice_a),
        format!("before={} after={}", before.alice_a, after_alice.alice_a),
    );
    check(
        &mut evidence.checks,
        "alice_escrow_credit",
        "ShowStake FT A balance and escrow increased by exactly D",
        parse_u128(&after_alice.open_stake_a) == parse_u128(&before.open_stake_a) + DEPOSIT
            && after_alice.open_accepted == DEPOSIT.to_string(),
        format!(
            "showstake={} accepted={}",
            after_alice.open_stake_a, after_alice.open_accepted
        ),
    );
    check(
        &mut evidence.checks,
        "alice_counts",
        "event count/list report one active registration and exact principal",
        after_alice.open_active == 1
            && after_alice.open_total == 1
            && after_alice.open_accepted == DEPOSIT.to_string()
            && after_alice.open_list == 1,
        format!("{after_alice:?}"),
    );
    check(
        &mut evidence.checks,
        "alice_storage_charged",
        "registration consumed measured prepaid storage credit",
        parse_u128(&after_alice.alice_credit_open) < parse_u128(&before.alice_credit_open),
        format!("before={} after={}", before.alice_credit_open, after_alice.alice_credit_open),
    );
    check(
        &mut evidence.checks,
        "alice_tx_receipts",
        "FT transfer and ShowStake receiver receipts both succeeded",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &open_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let list = registration_list(&env, &open_stake, EVENT_OPEN, 0, 50).await?;
    let alice_registration = list
        .first()
        .ok_or_else(|| anyhow!("accepted deposit produced no registration"))?;
    let alice_pass = view::<PassJson>(
        &open_stake,
        "get_pass",
        serde_json::json!({"pass_id": alice_registration.pass_id}),
        &network,
    )
    .await?;
    let alice_registration_view = view::<RegistrationJson>(
        &open_stake,
        "get_registration",
        serde_json::json!({"registration_id": alice_registration.registration_id}),
        &network,
    )
    .await?;
    check(
        &mut evidence.checks,
        "alice_registration_view",
        "registration binds participant=beneficiary=FT sender and exact commitment",
        alice_registration_view.participant == alice.to_string()
            && alice_registration_view.beneficiary == alice.to_string()
            && alice_registration_view.commitment_id == "alice-c1"
            && alice_registration_view.amount == DEPOSIT.to_string()
            && alice_registration_view.event_id == EVENT_OPEN
            && alice_registration_view.event_sequence == 0
            && alice_registration_view.registration_status == "Active"
            && alice_registration_view.attendance_status == "NotMarked"
            && alice_registration_view.financial_status == "Committed",
        format!("{alice_registration_view:?}"),
    );
    check(
        &mut evidence.checks,
        "alice_pass_view",
        "pass is account-bound to the sender; owner=beneficiary; no transfer surface",
        alice_pass.owner == alice.to_string()
            && alice_pass.event_id == EVENT_OPEN
            && alice_pass.registration_id == alice_registration_view.registration_id
            && alice_pass.registration_status == "Active"
            && alice_pass.attendance_status == "NotMarked"
            && alice_pass.financial_status == "Committed"
            && alice_pass.policy_version == POLICY_IDENTITY,
        format!("{alice_pass:?}"),
    );

    // Bob is the second pass on the same instance (many passes per event).
    let before = snapshot(&env, "before_bob").await?;
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": open_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_OPEN, "bob-c1"),
        }),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "bob_commit_exact",
        "second valid pass on the same event instance",
    )
    .await?;
    let after_bob = snapshot(&env, "after_bob").await?;
    evidence.snapshots.push(after_bob.clone());
    check(
        &mut evidence.checks,
        "bob_balances_and_counts",
        "bob-100 / open instance +100 / active=2 / list=2",
        parse_u128(&after_bob.bob_a) + DEPOSIT == parse_u128(&before.bob_a)
            && parse_u128(&after_bob.open_stake_a) == parse_u128(&before.open_stake_a) + DEPOSIT
            && after_bob.open_accepted == (2 * DEPOSIT).to_string()
            && after_bob.open_active == 2
            && after_bob.open_total == 2
            && after_bob.open_list == 2,
        format!("{after_bob:?}"),
    );
    check(
        &mut evidence.checks,
        "bob_tx_receipts",
        "bob FT transfer and ShowStake receiver receipts both succeeded",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &open_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    // -------------------------------------- invalid deposits: no state rights
    let before = after_bob.clone();
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": open_id,
            "amount": (DEPOSIT - 1).to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_OPEN, "carol-wrong-amount"),
        }),
        &carol,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "carol_wrong_amount",
        "amount D-1 must return the full unused amount",
    )
    .await?;
    let after = snapshot(&env, "after_wrong_amount").await?;
    refund_preserved(
        &mut evidence.checks,
        "wrong_amount",
        &before,
        &after,
        &tx,
        &open_id,
        "WRONG_AMOUNT",
    );
    evidence.snapshots.push(after.clone());
    evidence.transactions.push(tx);

    let before = after.clone();
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": open_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_OPEN, "alice-c2"),
        }),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "alice_duplicate_deposit",
        "one lifetime registration per account/event must refund",
    )
    .await?;
    let after = snapshot(&env, "after_duplicate_deposit").await?;
    refund_preserved(
        &mut evidence.checks,
        "duplicate_deposit",
        &before,
        &after,
        &tx,
        &open_id,
        "ACCOUNT_ALREADY_REGISTERED",
    );
    evidence.snapshots.push(after.clone());
    evidence.transactions.push(tx);

    // Wrong token (FT B) with an otherwise valid deposit.
    let before = after.clone();
    let tx = call(
        &ft_b,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": open_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_OPEN, "bob-wrong-token"),
        }),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "bob_wrong_token",
        "non-canonical FT predecessor must return the full unused amount",
    )
    .await?;
    let after = snapshot(&env, "after_wrong_token").await?;
    refund_preserved(
        &mut evidence.checks,
        "wrong_token",
        &before,
        &after,
        &tx,
        &open_id,
        "WRONG_FT",
    );
    check(
        &mut evidence.checks,
        "wrong_token_resolver_refund",
        "wrong-token FT B resolver restored bob and left ShowStake B at zero",
        after.bob_b == before.bob_b
            && after.open_stake_b == "0"
            && after.ft_b_total == before.ft_b_total,
        format!("before={} after={}", before.bob_b, after.bob_b),
    );
    evidence.snapshots.push(after.clone());
    evidence.transactions.push(tx);

    // Closed registration phase on a separate instance.
    let before = after.clone();
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": closed_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_CLOSED, "alice-closed"),
        }),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "alice_phase_closed",
        "closed registration window must refund",
    )
    .await?;
    let after = snapshot(&env, "after_phase_closed").await?;
    refund_preserved(
        &mut evidence.checks,
        "phase_closed",
        &before,
        &after,
        &tx,
        &closed_id,
        "PHASE_CLOSED",
    );
    check(
        &mut evidence.checks,
        "phase_closed_separate_instance",
        "the closed event lives on its own instance and accepted no deposit",
        after.closed_active == 0 && after.closed_total == 0 && after.closed_stake_a == "0",
        format!("{after:?}"),
    );
    evidence.snapshots.push(after.clone());
    evidence.transactions.push(tx);

    // Positive deposit/pass on the separate second-event instance.
    let before = after.clone();
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": open2_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_OPEN2, "dave-c1"),
        }),
        &dave,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "dave_commit_open2",
        "positive pass on a separate contract instance",
    )
    .await?;
    let after_dave = snapshot(&env, "after_dave").await?;
    evidence.snapshots.push(after_dave.clone());
    check(
        &mut evidence.checks,
        "dave_balances_and_counts",
        "dave-100 / second instance +100 / accepted=100 / one pass",
        parse_u128(&after_dave.dave_a) + DEPOSIT == parse_u128(&before.dave_a)
            && parse_u128(&after_dave.open2_stake_a)
                == parse_u128(&before.open2_stake_a) + DEPOSIT
            && after_dave.open2_accepted == DEPOSIT.to_string()
            && after_dave.open2_active == 1
            && after_dave.open2_total == 1
            && after_dave.open2_list == 1,
        format!("{after_dave:?}"),
    );
    check(
        &mut evidence.checks,
        "dave_tx_receipts",
        "dave FT transfer and second-instance receiver receipts both succeeded",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &open2_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    // ------------------------------------------------- non-transferable pass
    let pass_id = alice_pass.pass_id.clone();
    let denials: [(&str, &str, serde_json::Value, u128, &str); 5] = [
        (
            "deny_nft_transfer",
            "nft_transfer",
            serde_json::json!({
                "receiver_id": bob,
                "token_id": pass_id,
                "approval_id": null,
                "memo": null
            }),
            1,
            "ordinary pass transfer must be rejected",
        ),
        (
            "deny_nft_transfer_call",
            "nft_transfer_call",
            serde_json::json!({
                "receiver_id": bob,
                "token_id": pass_id,
                "approval_id": null,
                "memo": null,
                "msg": "give"
            }),
            1,
            "transfer_call must be rejected",
        ),
        (
            "deny_nft_approve",
            "nft_approve",
            serde_json::json!({
                "account_id": bob,
                "token_id": pass_id,
                "msg": null
            }),
            1,
            "approval surface must be rejected",
        ),
        (
            "deny_admin_reassign",
            "admin_reassign_pass",
            serde_json::json!({
                "pass_id": pass_id,
                "new_owner": bob
            }),
            0,
            "admin reassignment must be rejected",
        ),
        (
            "deny_burn",
            "burn",
            serde_json::json!({"token_id": pass_id}),
            1,
            "burn must be rejected (financial rights must not be destroyed)",
        ),
    ];
    for (label, method, args, attached, note) in denials {
        let before = snapshot(&env, &format!("before_{label}")).await?;
        let tx = call(
            &open_stake,
            method,
            args,
            &alice,
            signer.clone(),
            &network,
            NearToken::from_yoctonear(attached),
            NearGas::from_tgas(30),
            label,
            note,
        )
        .await?;
        let after = snapshot(&env, &format!("after_{label}")).await?;
        check(
            &mut evidence.checks,
            &format!("{label}_fails"),
            "pass operation fails on the contract receipt (release Wasm trap)",
            tx.top_level_failure && has_receipt_failure(&tx, &open_id),
            format!("{tx:?}"),
        );
        check(
            &mut evidence.checks,
            &format!("{label}_state_unchanged"),
            "rejected pass operation changed no balance, credit, count or owner",
            same_state(&before, &after),
            format!("before={before:?} after={after:?}"),
        );
        evidence.snapshots.push(after);
        evidence.transactions.push(tx);
    }

    // -------------------------------------------------------------- views
    let final_snap = snapshot(&env, "final").await?;
    evidence.snapshots.push(final_snap.clone());
    let accepted_total = 3 * DEPOSIT; // alice+bob on open, dave on open2
    check(
        &mut evidence.checks,
        "final_escrow_and_holdings",
        "accepted principal equals canonical FT holdings across instances and total supply is conserved",
        parse_u128(&final_snap.open_stake_a) + parse_u128(&final_snap.open2_stake_a)
            == accepted_total
            && parse_u128(&final_snap.open_stake_a) == 2 * DEPOSIT
            && parse_u128(&final_snap.open2_stake_a) == DEPOSIT
            && final_snap.closed_stake_a == "0"
            && final_snap.open_stake_b == "0"
            && final_snap.ft_a_total == "1000000"
            && final_snap.ft_b_total == "1000000"
            && parse_u128(&final_snap.owner_a_a)
                + parse_u128(&final_snap.alice_a)
                + parse_u128(&final_snap.bob_a)
                + parse_u128(&final_snap.carol_a)
                + parse_u128(&final_snap.dave_a)
                + parse_u128(&final_snap.frank_a)
                + parse_u128(&final_snap.open_stake_a)
                + parse_u128(&final_snap.open2_stake_a)
                + parse_u128(&final_snap.closed_stake_a)
                + parse_u128(&final_snap.life_stake_a)
                + parse_u128(&final_snap.timeout_stake_a)
                + parse_u128(&final_snap.fail_stake_a)
                == parse_u128(&final_snap.ft_a_total),
        format!("{final_snap:?}"),
    );
    check(
        &mut evidence.checks,
        "final_counts",
        "three accepted passes across separate instances; rejected deposits counted nowhere",
        final_snap.open_active == 2
            && final_snap.open_total == 2
            && final_snap.open_list == 2
            && final_snap.open2_active == 1
            && final_snap.open2_total == 1
            && final_snap.open2_list == 1
            && final_snap.closed_active == 0
            && final_snap.closed_total == 0
            && final_snap.pass_owner.as_deref() == Some(alice.to_string().as_str()),
        format!("{final_snap:?}"),
    );
    check(
        &mut evidence.checks,
        "final_storage_credits",
        "only accepted registrations consumed prepaid credit; rejected paths consumed none",
        parse_u128(&final_snap.alice_credit_open) < parse_u128(&initial.alice_credit_open)
            && parse_u128(&final_snap.bob_credit_open) < parse_u128(&initial.bob_credit_open)
            && final_snap.carol_credit_open == initial.carol_credit_open
            && parse_u128(&final_snap.dave_credit_open) > 0
            && parse_u128(&final_snap.dave_credit_open2) > 0
            && final_snap.alice_credit_open2 == initial.alice_credit_open2,
        format!("{final_snap:?}"),
    );

    let open_final = event_view(&env, &open_stake, EVENT_OPEN).await?;
    check(
        &mut evidence.checks,
        "final_open_event_view",
        "final open event view keeps immutable organizer/rules and exact onchain counts",
        open_final.organizer == organizer.to_string()
            && open_final.reg_open == clock_ms - 60_000
            && open_final.reg_close == clock_ms + HOUR_MS
            && open_final.cancel_cutoff == open_final.reg_close
            && open_final.checkin_open == open_final.cancel_cutoff
            && open_final.checkin_close == clock_ms + 2 * HOUR_MS
            && open_final.finalize_deadline == clock_ms + 2 * HOUR_MS + DAY_MS
            && open_final.active_registrations == 2
            && open_final.total_registrations == 2
            && open_final.accepted_principal == (2 * DEPOSIT).to_string(),
        format!("{open_final:?}"),
    );

    let first = registration_list(&env, &open_stake, EVENT_OPEN, 0, 1).await?;
    let second = registration_list(&env, &open_stake, EVENT_OPEN, 1, 1).await?;
    let beyond = registration_list(&env, &open_stake, EVENT_OPEN, 2, 10).await?;
    check(
        &mut evidence.checks,
        "list_registrations_bounded",
        "registration list is bounded and ordered by immutable event sequence",
        first.len() == 1
            && second.len() == 1
            && beyond.is_empty()
            && first[0].participant == alice.to_string()
            && second[0].participant == bob.to_string()
            && first[0].event_sequence == 0
            && second[0].event_sequence == 1
            && try_view::<Vec<RegistrationJson>>(
                &open_stake,
                "list_event_registrations",
                serde_json::json!({"event_id": EVENT_OPEN, "from": 0u64, "limit": 0u32}),
                &network,
            )
            .await
            .is_err(),
        format!("first={first:?} second={second:?} beyond={beyond:?}"),
    );

    let bob_registration = view::<RegistrationJson>(
        &open_stake,
        "get_registration",
        serde_json::json!({"registration_id": second[0].registration_id}),
        &network,
    )
    .await?;
    let bob_pass = view::<PassJson>(
        &open_stake,
        "get_pass",
        serde_json::json!({"pass_id": bob_registration.pass_id}),
        &network,
    )
    .await?;
    check(
        &mut evidence.checks,
        "bob_pass_owner",
        "second pass owner/beneficiary remains bob",
        bob_registration.participant == bob.to_string()
            && bob_registration.beneficiary == bob.to_string()
            && bob_pass.owner == bob.to_string()
            && bob_pass.pass_id == bob_registration.pass_id,
        format!("registration={bob_registration:?} pass={bob_pass:?}"),
    );

    // ----------------- lifecycle: cancel / no voluntary withdrawal / claim
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": life_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_LIFE, "alice-life"),
        }),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "alice_life_commit",
        "lifecycle event registration",
    )
    .await?;
    check(
        &mut evidence.checks,
        "alice_life_commit_receipts",
        "lifecycle registration used real FT and receiver receipts",
        tx.top_level_success && has_receipt_success(&tx, &ft_a_id) && has_receipt_success(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": life_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_LIFE, "bob-life"),
        }),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "bob_life_commit",
        "second lifecycle registration",
    )
    .await?;
    check(
        &mut evidence.checks,
        "bob_life_commit_receipts",
        "second lifecycle registration used real FT and receiver receipts",
        tx.top_level_success && has_receipt_success(&tx, &ft_a_id) && has_receipt_success(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let life_list = registration_list(&env, &life_stake, EVENT_LIFE, 0, 50).await?;
    let alice_life = life_list
        .iter()
        .find(|registration| registration.participant == alice.to_string())
        .ok_or_else(|| anyhow!("alice lifecycle registration missing"))?
        .clone();
    let bob_life = life_list
        .iter()
        .find(|registration| registration.participant == bob.to_string())
        .ok_or_else(|| anyhow!("bob lifecycle registration missing"))?
        .clone();
    let life_before_allocation = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;

    // Wrong beneficiary before any claimable allocation: rejected unchanged.
    let tx = call(
        &life_stake,
        "claim",
        serde_json::json!({"registration_id": alice_life.registration_id}),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(150),
        "wrong_beneficiary_claim_before_cancel",
        "claim receiver must be the immutable beneficiary",
    )
    .await?;
    check(
        &mut evidence.checks,
        "wrong_beneficiary_claim_before_cancel_fails",
        "wrong-beneficiary claim fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &life_id),
        format!("{tx:?}"),
    );
    let life_after_wrong_beneficiary = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    check(
        &mut evidence.checks,
        "wrong_beneficiary_claim_before_cancel_no_state",
        "wrong-beneficiary claim changed no claim, total or balance",
        life_before_allocation == life_after_wrong_beneficiary,
        format!("before={life_before_allocation} after={life_after_wrong_beneficiary}"),
    );
    evidence.transactions.push(tx);

    // D036: voluntary withdrawal is removed; the route traps before mutation.
    let tx = call(
        &life_stake,
        "withdraw_registration",
        serde_json::json!({"registration_id": alice_life.registration_id}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(60),
        "voluntary_withdrawal_disabled",
        "withdraw_registration must trap before any state mutation",
    )
    .await?;
    check(
        &mut evidence.checks,
        "voluntary_withdrawal_disabled_fails",
        "voluntary withdrawal fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &life_id),
        format!("{tx:?}"),
    );
    let life_after_withdraw_denial = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    check(
        &mut evidence.checks,
        "voluntary_withdrawal_disabled_no_state",
        "disabled withdrawal changed no event, claim, total or balance",
        life_before_allocation == life_after_withdraw_denial,
        format!("before={life_before_allocation} after={life_after_withdraw_denial}"),
    );
    evidence.transactions.push(tx);

    // One lifetime accepted registration per account/event: no rejoin.
    let alice_before_duplicate = ft_balance(&env, &ft_a, &alice).await?;
    let life_before_duplicate = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": life_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_LIFE, "alice-second"),
        }),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "lifetime_duplicate_registration",
        "a second registration for the same account/event must be refunded",
    )
    .await?;
    let life_after_duplicate = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    check(
        &mut evidence.checks,
        "lifetime_duplicate_registration_refunded",
        "duplicate lifetime registration is rejected by the receiver and returns the full amount",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &life_id)
            && receipt_log_contains(&tx, &life_id, "ACCOUNT_ALREADY_REGISTERED")
            && life_before_duplicate == life_after_duplicate
            && ft_balance(&env, &ft_a, &alice).await? == alice_before_duplicate,
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let life_before_unauthorized_cancel = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    let tx = call(
        &life_stake,
        "cancel_event",
        serde_json::json!({"event_id": EVENT_LIFE}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "unauthorized_life_cancel",
        "only the organizer may cancel",
    )
    .await?;
    check(
        &mut evidence.checks,
        "unauthorized_life_cancel_fails",
        "non-organizer cancellation fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &life_id),
        format!("{tx:?}"),
    );
    let life_after_unauthorized_cancel = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    check(
        &mut evidence.checks,
        "unauthorized_life_cancel_no_state",
        "denied cancellation changed no event, claim, total or balance",
        life_before_unauthorized_cancel == life_after_unauthorized_cancel,
        format!("before={life_before_unauthorized_cancel} after={life_after_unauthorized_cancel}"),
    );
    evidence.transactions.push(tx);

    // Organizer cancellation before settlement; O(1) terminal activation.
    let tx = call(
        &life_stake,
        "cancel_event",
        serde_json::json!({"event_id": EVENT_LIFE}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(200),
        "organizer_cancel_life",
        "organizer cancellation before settlement",
    )
    .await?;
    check(
        &mut evidence.checks,
        "organizer_cancel_life_succeeds",
        "organizer cancellation succeeds",
        tx.top_level_success && has_receipt_success(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let life_event = event_view(&env, &life_stake, EVENT_LIFE).await?;
    let life_totals = event_totals(&env, &life_stake, EVENT_LIFE).await?;
    check(
        &mut evidence.checks,
        "cancel_sets_cancelled_and_full_liability",
        "cancellation sets CANCELLED and every registration is claimable at full D",
        life_event.state == "Cancelled"
            && life_event.phase == "Cancelled"
            && life_totals.accepted_principal == (2 * DEPOSIT).to_string()
            && life_totals.paid == "0"
            && life_totals.pending == "0"
            && life_totals.liability == (2 * DEPOSIT).to_string()
            && instance_escrow(&env, &life_stake).await? == (2 * DEPOSIT).to_string(),
        format!("event={life_event:?} totals={life_totals:?}"),
    );
    for registration_id in [&alice_life.registration_id, &bob_life.registration_id] {
        let claim = claim_view(&env, &life_stake, registration_id).await?;
        check(
            &mut evidence.checks,
            &format!("cancel_claimable_{registration_id}"),
            "cancellation makes this registration claimable at full D",
            claim.amount == DEPOSIT.to_string()
                && claim.payout_state == "Claimable"
                && claim.paid_amount == "0",
            format!("{claim:?}"),
        );
    }

    // First claim pays the immutable beneficiary through the real FT.
    let alice_before_claim = ft_balance(&env, &ft_a, &alice).await?;
    let life_before_claim = ft_balance(&env, &ft_a, &life_id).await?;
    let tx = call(
        &life_stake,
        "claim",
        serde_json::json!({"registration_id": alice_life.registration_id}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(100),
        "alice_claim_life",
        "claim at the documented 100 Tgas minimum",
    )
    .await?;
    check(
        &mut evidence.checks,
        "alice_claim_life_receipts",
        "claim produced successful FT transfer and payout callback receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let alice_paid = claim_view(&env, &life_stake, &alice_life.registration_id).await?;
    let life_after_alice = event_totals(&env, &life_stake, EVENT_LIFE).await?;
    check(
        &mut evidence.checks,
        "alice_claim_life_paid_once",
        "claim paid exactly D to alice and moved liability to paid",
        alice_paid.payout_state == "Paid"
            && alice_paid.paid_amount == DEPOSIT.to_string()
            && parse_u128(&ft_balance(&env, &ft_a, &alice).await?)
                == parse_u128(&alice_before_claim) + DEPOSIT
            && parse_u128(&ft_balance(&env, &ft_a, &life_id).await?) + DEPOSIT
                == parse_u128(&life_before_claim)
            && life_after_alice.paid == DEPOSIT.to_string()
            && life_after_alice.pending == "0"
            && life_after_alice.liability == DEPOSIT.to_string()
            && instance_escrow(&env, &life_stake).await? == DEPOSIT.to_string(),
        format!("claim={alice_paid:?} totals={life_after_alice:?}"),
    );

    // Overlapping/double claim and spoofed callback must not pay twice.
    let life_before_double = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    let tx = call(
        &life_stake,
        "claim",
        serde_json::json!({"registration_id": alice_life.registration_id}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(150),
        "alice_double_claim_life",
        "already-paid registration cannot claim again",
    )
    .await?;
    check(
        &mut evidence.checks,
        "double_claim_fails",
        "double claim fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let life_after_double = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    check(
        &mut evidence.checks,
        "double_claim_no_state",
        "double claim changed no claim, total or balance",
        life_before_double == life_after_double,
        format!("before={life_before_double} after={life_after_double}"),
    );
    let old_payout_id = format!("pay-{}-1", alice_life.registration_id);
    let tx = call(
        &life_stake,
        "on_payout_result",
        serde_json::json!({"payout_id": old_payout_id}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(60),
        "spoofed_payout_callback",
        "private callback cannot be called by a participant",
    )
    .await?;
    check(
        &mut evidence.checks,
        "spoofed_payout_callback_fails",
        "spoofed payout callback fails on the contract receipt",
        tx.top_level_failure && has_receipt_failure(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let life_after_spoof = lifecycle_state(
        &env,
        &life_stake,
        EVENT_LIFE,
        &[alice_life.registration_id.clone(), bob_life.registration_id.clone()],
    )
    .await?;
    check(
        &mut evidence.checks,
        "spoofed_payout_callback_no_state",
        "spoofed callback changed no claim, total or balance",
        life_after_double == life_after_spoof,
        format!("before={life_after_double} after={life_after_spoof}"),
    );

    // Claim bob's remaining registration.
    let bob_before_claim = ft_balance(&env, &ft_a, &bob).await?;
    let tx = call(
        &life_stake,
        "claim",
        serde_json::json!({"registration_id": bob_life.registration_id}),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(100),
        "bob_claim_life",
        "claim remaining liability at 100 Tgas",
    )
    .await?;
    check(
        &mut evidence.checks,
        "bob_claim_life_receipts",
        "claim produced successful FT transfer and payout callback receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &life_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let bob_paid = claim_view(&env, &life_stake, &bob_life.registration_id).await?;
    check(
        &mut evidence.checks,
        "bob_claim_life_paid",
        "claim paid exactly D to bob",
        bob_paid.payout_state == "Paid"
            && bob_paid.paid_amount == DEPOSIT.to_string()
            && parse_u128(&ft_balance(&env, &ft_a, &bob).await?)
                == parse_u128(&bob_before_claim) + DEPOSIT,
        format!("{bob_paid:?}"),
    );
    let final_life = event_totals(&env, &life_stake, EVENT_LIFE).await?;
    check(
        &mut evidence.checks,
        "life_conservation",
        "all accepted principal is paid, escrow is zero and no claim remains pending",
        final_life.accepted_principal == (2 * DEPOSIT).to_string()
            && final_life.paid == (2 * DEPOSIT).to_string()
            && final_life.pending == "0"
            && final_life.liability == "0"
            && instance_escrow(&env, &life_stake).await? == "0"
            && ft_balance(&env, &ft_a, &life_id).await? == "0",
        format!("{final_life:?}"),
    );

    // ------------------------- lifecycle: failed FT payout restoration + retry
    let tx = call(
        &ft_a,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": fail_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_FAIL, "frank-c1"),
        }),
        &frank,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "frank_fail_commit",
        "frank commits exactly his 100 FT; balance becomes zero",
    )
    .await?;
    check(
        &mut evidence.checks,
        "frank_fail_commit_receipts",
        "frank commit used real FT and receiver receipts",
        tx.top_level_success && has_receipt_success(&tx, &ft_a_id) && has_receipt_success(&tx, &fail_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    check(
        &mut evidence.checks,
        "frank_zero_ft_after_commit",
        "frank FT balance is zero and the fail instance holds exactly D",
        ft_balance(&env, &ft_a, &frank).await? == "0"
            && ft_balance(&env, &ft_a, &fail_id).await? == DEPOSIT.to_string(),
        format!(
            "frank={} stake={}",
            ft_balance(&env, &ft_a, &frank).await?,
            ft_balance(&env, &ft_a, &fail_id).await?
        ),
    );
    let frank_list = registration_list(&env, &fail_stake, EVENT_FAIL, 0, 50).await?;
    let frank_registration = frank_list
        .iter()
        .find(|registration| registration.participant == frank.to_string())
        .ok_or_else(|| anyhow!("frank registration missing"))?
        .clone();
    let tx = call(
        &fail_stake,
        "cancel_event",
        serde_json::json!({"event_id": EVENT_FAIL}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "frank_fail_event_cancel",
        "cancel the failed-payout event so frank becomes claimable",
    )
    .await?;
    check(
        &mut evidence.checks,
        "frank_fail_event_cancel_succeeds",
        "failed-payout event cancellation succeeds",
        tx.top_level_success && has_receipt_success(&tx, &fail_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let supply_before_unregister = view::<String>(
        &ft_a,
        "ft_total_supply",
        serde_json::json!({}),
        &network,
    )
    .await?;
    let tx = call(
        &ft_a,
        "storage_unregister",
        serde_json::json!({"force": null}),
        &frank,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(30),
        "frank_unregister_ft_storage",
        "remove the beneficiary FT storage before claim to force payout failure",
    )
    .await?;
    check(
        &mut evidence.checks,
        "frank_unregister_ft_storage_succeeds",
        "frank FT storage unregistration succeeds with zero balance",
        tx.top_level_success
            && ft_balance(&env, &ft_a, &frank).await? == "0"
            && view::<String>(&ft_a, "ft_total_supply", serde_json::json!({}), &network).await?
                == supply_before_unregister,
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let tx = call(
        &fail_stake,
        "claim",
        serde_json::json!({"registration_id": frank_registration.registration_id}),
        &frank,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(100),
        "frank_claim_failed_transfer",
        "FT transfer fails at the documented 100 Tgas claim minimum because beneficiary storage is gone",
    )
    .await?;
    check(
        &mut evidence.checks,
        "frank_failed_payout_receipts",
        "FT transfer failed while the ShowStake callback receipt restored the claim",
        has_receipt_failure(&tx, &ft_a_id) && has_receipt_success(&tx, &fail_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let frank_restored = claim_view(&env, &fail_stake, &frank_registration.registration_id).await?;
    let fail_totals_after_failure = event_totals(&env, &fail_stake, EVENT_FAIL).await?;
    check(
        &mut evidence.checks,
        "failed_payout_restores_claim",
        "failed payout restores the full claimable D without changing registration status",
        frank_restored.payout_state == "Claimable"
            && frank_restored.paid_amount == "0"
            && frank_restored.pending_payout_id.is_none()
            && view::<RegistrationJson>(
                &fail_stake,
                "get_registration",
                serde_json::json!({"registration_id": frank_registration.registration_id}),
                &network,
            )
            .await?
            .registration_status
                == "Active"
            && fail_totals_after_failure.paid == "0"
            && fail_totals_after_failure.pending == "0"
            && fail_totals_after_failure.liability == DEPOSIT.to_string()
            && instance_escrow(&env, &fail_stake).await? == DEPOSIT.to_string()
            && ft_balance(&env, &ft_a, &fail_id).await? == DEPOSIT.to_string(),
        format!("claim={frank_restored:?} totals={fail_totals_after_failure:?}"),
    );

    let tx = call(
        &ft_a,
        "storage_deposit",
        serde_json::json!({"account_id": frank, "registration_only": true}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_millinear(10),
        NearGas::from_tgas(30),
        "frank_restore_ft_storage",
        "re-register beneficiary FT storage before retry",
    )
    .await?;
    check(
        &mut evidence.checks,
        "frank_restore_ft_storage_succeeds",
        "beneficiary FT storage is restored",
        tx.top_level_success,
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let tx = call(
        &fail_stake,
        "claim",
        serde_json::json!({"registration_id": frank_registration.registration_id}),
        &frank,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(150),
        "frank_claim_retry",
        "retry after FT storage restoration",
    )
    .await?;
    check(
        &mut evidence.checks,
        "frank_retry_receipts",
        "retry produced successful FT transfer and payout callback receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_a_id)
            && has_receipt_success(&tx, &fail_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let frank_paid = claim_view(&env, &fail_stake, &frank_registration.registration_id).await?;
    let fail_totals_final = event_totals(&env, &fail_stake, EVENT_FAIL).await?;
    check(
        &mut evidence.checks,
        "failed_payout_retry_pays_once",
        "retry pays exactly D, leaves zero escrow and conserves accepted principal",
        frank_paid.payout_state == "Paid"
            && frank_paid.paid_amount == DEPOSIT.to_string()
            && ft_balance(&env, &ft_a, &frank).await? == DEPOSIT.to_string()
            && ft_balance(&env, &ft_a, &fail_id).await? == "0"
            && fail_totals_final.paid == DEPOSIT.to_string()
            && fail_totals_final.pending == "0"
            && fail_totals_final.liability == "0"
            && instance_escrow(&env, &fail_stake).await? == "0",
        format!("claim={frank_paid:?} totals={fail_totals_final:?}"),
    );


    // --------------------------------- lifecycle: permissionless timeout refund-only
    // The timeout event has a past finalize_deadline and no registrations, so
    // this proves permissionless activation without a multi-hour fast-forward.
    // Exact deadline-1/at-deadline and timeout-claim semantics are covered by
    // the 49-test unit suite.
    let timeout_event_before = event_view(&env, &timeout_stake, EVENT_TIMEOUT).await?;
    let timeout_clock = view::<u64>(
        &timeout_stake,
        "get_block_timestamp_ms",
        serde_json::json!({}),
        &network,
    )
    .await?;
    check(
        &mut evidence.checks,
        "timeout_event_is_past_deadline",
        "timeout instance is still Published and its finalize_deadline is already past",
        timeout_event_before.state == "Published"
            && timeout_clock >= timeout_event_before.finalize_deadline,
        format!("now={timeout_clock} event={timeout_event_before:?}"),
    );
    let timeout_before = lifecycle_state(&env, &timeout_stake, EVENT_TIMEOUT, &[]).await?;
    let tx = call(
        &timeout_stake,
        "activate_timeout_refund",
        serde_json::json!({"event_id": EVENT_TIMEOUT}),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "permissionless_timeout_refund",
        "any account may activate refund-only at/after finalize_deadline",
    )
    .await?;
    check(
        &mut evidence.checks,
        "permissionless_timeout_refund_succeeds",
        "permissionless refund-only activation succeeds on the contract receipt",
        tx.top_level_success && has_receipt_success(&tx, &timeout_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let timeout_event_after = event_view(&env, &timeout_stake, EVENT_TIMEOUT).await?;
    let timeout_totals = event_totals(&env, &timeout_stake, EVENT_TIMEOUT).await?;
    check(
        &mut evidence.checks,
        "timeout_refund_only_state",
        "REFUND_ONLY is terminal, zero-liability and remains on the separate instance",
        timeout_event_after.state == "RefundOnly"
            && timeout_event_after.phase == "RefundOnly"
            && timeout_totals.accepted_principal == "0"
            && timeout_totals.paid == "0"
            && timeout_totals.pending == "0"
            && timeout_totals.liability == "0"
            && instance_escrow(&env, &timeout_stake).await? == "0"
            && ft_balance(&env, &ft_a, &timeout_id).await? == "0",
        format!("event={timeout_event_after:?} totals={timeout_totals:?}"),
    );
    let timeout_after = lifecycle_state(&env, &timeout_stake, EVENT_TIMEOUT, &[]).await?;
    check(
        &mut evidence.checks,
        "timeout_refund_only_changed_state",
        "successful activation changed the event state from Published to RefundOnly",
        timeout_before != timeout_after,
        format!("before={timeout_before} after={timeout_after}"),
    );
    let tx = call(
        &timeout_stake,
        "activate_timeout_refund",
        serde_json::json!({"event_id": EVENT_TIMEOUT}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "timeout_double_activation",
        "refund-only cannot be activated twice",
    )
    .await?;
    check(
        &mut evidence.checks,
        "timeout_double_activation_fails",
        "second refund-only activation fails",
        tx.top_level_failure && has_receipt_failure(&tx, &timeout_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let tx = call(
        &timeout_stake,
        "cancel_event",
        serde_json::json!({"event_id": EVENT_TIMEOUT}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "cancel_after_refund_only",
        "cancellation after refund-only must fail",
    )
    .await?;
    check(
        &mut evidence.checks,
        "cancel_after_refund_only_fails",
        "organizer cancellation after REFUND_ONLY fails",
        tx.top_level_failure && has_receipt_failure(&tx, &timeout_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let timeout_after_failures = lifecycle_state(&env, &timeout_stake, EVENT_TIMEOUT, &[]).await?;
    check(
        &mut evidence.checks,
        "timeout_failed_calls_no_state",
        "denied double activation and cancellation changed no event or totals",
        timeout_after == timeout_after_failures,
        format!("before={timeout_after} after={timeout_after_failures}"),
    );

    // -------------------------- final all-instance conservation / solvency
    let final_all = snapshot(&env, "final_all").await?;
    evidence.snapshots.push(final_all.clone());
    let open_totals = event_totals(&env, &open_stake, EVENT_OPEN).await?;
    let open2_totals = event_totals(&env, &open2_stake, EVENT_OPEN2).await?;
    let life_final = event_totals(&env, &life_stake, EVENT_LIFE).await?;
    let fail_final = event_totals(&env, &fail_stake, EVENT_FAIL).await?;
    let timeout_final = event_totals(&env, &timeout_stake, EVENT_TIMEOUT).await?;
    let totals_conserve = |totals: &EventTotalsJson| {
        parse_u128(&totals.accepted_principal)
            == parse_u128(&totals.paid) + parse_u128(&totals.pending) + parse_u128(&totals.liability)
    };
    check(
        &mut evidence.checks,
        "final_all_totals_conserve",
        "every instance satisfies accepted = paid + pending + liability",
        totals_conserve(&open_totals)
            && totals_conserve(&open2_totals)
            && totals_conserve(&life_final)
            && totals_conserve(&fail_final)
            && totals_conserve(&timeout_final),
        format!(
            "open={open_totals:?} open2={open2_totals:?} life={life_final:?} fail={fail_final:?} timeout={timeout_final:?}"
        ),
    );
    check(
        &mut evidence.checks,
        "final_all_escrow_equals_liability_plus_pending",
        "each instance holds exactly pending + outstanding liability",
        parse_u128(&instance_escrow(&env, &open_stake).await?)
            == parse_u128(&open_totals.pending) + parse_u128(&open_totals.liability)
            && parse_u128(&instance_escrow(&env, &open2_stake).await?)
                == parse_u128(&open2_totals.pending) + parse_u128(&open2_totals.liability)
            && parse_u128(&instance_escrow(&env, &life_stake).await?)
                == parse_u128(&life_final.pending) + parse_u128(&life_final.liability)
            && parse_u128(&instance_escrow(&env, &fail_stake).await?)
                == parse_u128(&fail_final.pending) + parse_u128(&fail_final.liability)
            && parse_u128(&instance_escrow(&env, &timeout_stake).await?)
                == parse_u128(&timeout_final.pending) + parse_u128(&timeout_final.liability),
        "escrow equals pending + liability per instance",
    );
    let all_ft_holders_total = parse_u128(&final_all.owner_a_a)
        + parse_u128(&final_all.alice_a)
        + parse_u128(&final_all.bob_a)
        + parse_u128(&final_all.carol_a)
        + parse_u128(&final_all.dave_a)
        + parse_u128(&final_all.frank_a)
        + parse_u128(&final_all.open_stake_a)
        + parse_u128(&final_all.open2_stake_a)
        + parse_u128(&final_all.closed_stake_a)
        + parse_u128(&final_all.life_stake_a)
        + parse_u128(&final_all.timeout_stake_a)
        + parse_u128(&final_all.fail_stake_a);
    check(
        &mut evidence.checks,
        "final_all_ft_supply_conserved",
        "sum of every FT A holder equals immutable total supply",
        all_ft_holders_total == parse_u128(&final_all.ft_a_total)
            && final_all.ft_a_total == "1000000",
        format!("holders={all_ft_holders_total} total={}", final_all.ft_a_total),
    );

    // --------------------- max-capacity cancellation (200 registrations)
    let tx = call(
        &ft_b,
        "ft_transfer",
        serde_json::json!({
            "receiver_id": history_id,
            "amount": (DEPOSIT * 199).to_string(),
            "memo": null,
        }),
        &owner_b,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(30),
        "maxcap_bulk_funding",
        "fund the maxcap instance with 199 synthetic registration principals",
    )
    .await?;
    check(
        &mut evidence.checks,
        "maxcap_bulk_funding_receipt",
        "maxcap bulk FT funding succeeds",
        tx.top_level_success && has_receipt_success(&tx, &ft_b_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let tx = call(
        &ft_b,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": history_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_HISTORY, "maxcap-real"),
        }),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "maxcap_real_registration",
        "real FT deposit for the maxcap claim beneficiary",
    )
    .await?;
    check(
        &mut evidence.checks,
        "maxcap_real_registration_receipts",
        "maxcap real registration used FT and receiver receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_b_id)
            && has_receipt_success(&tx, &history_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let fake_count = 199u32;
    for index in 0..fake_count {
        let fake: AccountId = format!("maxcap-p{index:03}.sandbox").parse()?;
        let tx = call(
            &history_stake,
            "storage_deposit",
            serde_json::json!({"account_id": fake}),
            &organizer,
            signer.clone(),
            &network,
            NearToken::from_millinear(20),
            NearGas::from_tgas(30),
            &format!("maxcap_prepay_{index}"),
            "prepay synthetic maxcap registration storage",
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("maxcap_prepay_{index}_success"),
            "synthetic maxcap storage prepay succeeds",
            tx.top_level_success && returned_u128(&tx).is_some(),
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);

        let tx = call(
            &history_stake,
            "ft_on_transfer",
            serde_json::json!({
                "sender_id": fake,
                "amount": DEPOSIT.to_string(),
                "msg": commit_msg(EVENT_HISTORY, &format!("maxcap-{index}")),
            }),
            &ft_b_id,
            signer.clone(),
            &network,
            NearToken::from_yoctonear(0),
            NearGas::from_tgas(60),
            &format!("maxcap_register_{index}"),
            "synthetic canonical-FT receiver registration at max capacity",
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("maxcap_register_{index}_success"),
            "synthetic maxcap registration succeeds",
            tx.top_level_success && has_receipt_success(&tx, &history_id),
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }
    let history_event = event_view(&env, &history_stake, EVENT_HISTORY).await?;
    check(
        &mut evidence.checks,
        "maxcap_counts_before_cancel",
        "capacity 200 is reached with total registrations bounded by capacity",
        history_event.active_registrations == 200
            && history_event.total_registrations == 200
            && history_event.withdrawn_registrations == 0,
        format!("{history_event:?}"),
    );

    let tx = call(
        &history_stake,
        "cancel_event",
        serde_json::json!({"event_id": EVENT_HISTORY}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(200),
        "organizer_cancel_maxcap",
        "cancel a full 200-registration event",
    )
    .await?;
    check(
        &mut evidence.checks,
        "maxcap_cancel_success",
        "cancellation succeeds at capacity 200",
        tx.top_level_success && has_receipt_success(&tx, &history_id),
        format!("{tx:?}"),
    );
    let history_cancel_gas = receipt_gas(&tx, &history_id).unwrap_or(u64::MAX);
    let life_cancel_gas = evidence
        .transactions
        .iter()
        .find(|candidate| candidate.label == "organizer_cancel_life")
        .and_then(|candidate| receipt_gas(candidate, &life_id))
        .unwrap_or(u64::MAX);
    check(
        &mut evidence.checks,
        "maxcap_cancel_o1_gas",
        "cancel gas at 200 registrations stays near the 2-registration cancel and below 3 Tgas",
        history_cancel_gas <= 3_000_000_000_000
            && history_cancel_gas <= life_cancel_gas.saturating_add(1_000_000_000_000),
        format!("maxcap_gas={history_cancel_gas} life_gas={life_cancel_gas}"),
    );
    evidence.transactions.push(tx);

    let history_totals = event_totals(&env, &history_stake, EVENT_HISTORY).await?;
    check(
        &mut evidence.checks,
        "maxcap_cancel_conservation",
        "cancellation preserves accepted principal and full liability at capacity 200",
        history_totals.accepted_principal == (DEPOSIT * 200).to_string()
            && history_totals.paid == "0"
            && history_totals.pending == "0"
            && history_totals.liability == history_totals.accepted_principal
            && instance_escrow(&env, &history_stake).await? == history_totals.accepted_principal
            && ft_balance(&env, &ft_b, &history_id).await? == history_totals.accepted_principal,
        format!("{history_totals:?}"),
    );
    let bob_before_claim = ft_balance(&env, &ft_b, &bob).await?;
    let stake_before_claim = ft_balance(&env, &ft_b, &history_id).await?;
    let tx = call(
        &history_stake,
        "claim",
        serde_json::json!({"registration_id": "reg-0"}),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(100),
        "maxcap_claim",
        "claim at capacity 200 at the documented 100 Tgas minimum",
    )
    .await?;
    check(
        &mut evidence.checks,
        "maxcap_claim_receipts",
        "maxcap claim produced successful FT transfer and payout callback receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_b_id)
            && has_receipt_success(&tx, &history_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let claim = claim_view(&env, &history_stake, "reg-0").await?;
    let history_final = event_totals(&env, &history_stake, EVENT_HISTORY).await?;
    check(
        &mut evidence.checks,
        "maxcap_claim_paid_once",
        "maxcap claim pays exactly D and leaves the remaining 199 liabilities conserved",
        claim.payout_state == "Paid"
            && claim.paid_amount == DEPOSIT.to_string()
            && parse_u128(&ft_balance(&env, &ft_b, &bob).await?)
                == parse_u128(&bob_before_claim) + DEPOSIT
            && parse_u128(&ft_balance(&env, &ft_b, &history_id).await?) + DEPOSIT
                == parse_u128(&stake_before_claim)
            && history_final.accepted_principal == (DEPOSIT * 200).to_string()
            && history_final.paid == DEPOSIT.to_string()
            && history_final.pending == "0"
            && history_final.liability == (DEPOSIT * 199).to_string()
            && instance_escrow(&env, &history_stake).await? == history_final.liability,
        format!("claim={claim:?} totals={history_final:?}"),
    );
    let history_holder_sum = parse_u128(&ft_balance(&env, &ft_b, &owner_b).await?)
        + parse_u128(&ft_balance(&env, &ft_b, &alice).await?)
        + parse_u128(&ft_balance(&env, &ft_b, &bob).await?)
        + parse_u128(&ft_balance(&env, &ft_b, &history_id).await?);
    check(
        &mut evidence.checks,
        "maxcap_ft_b_supply_conserved",
        "maxcap FT B holders sum to the immutable total supply",
        history_holder_sum == 1_000_000
            && ft_balance(&env, &ft_b, &history_id).await? == (DEPOSIT * 199).to_string()
            && ft_balance(&env, &ft_b, &bob).await? == "1000",
        format!(
            "sum={history_holder_sum} owner_b={} history={} alice_b={} bob_b={}",
            ft_balance(&env, &ft_b, &owner_b).await?,
            ft_balance(&env, &ft_b, &history_id).await?,
            ft_balance(&env, &ft_b, &alice).await?,
            ft_balance(&env, &ft_b, &bob).await?,
        ),
    );

    run_deadline_case(evidence, ft_wasm, showstake_wasm).await?;

    Ok(())
}

/// Real timeout path on a second, time-configured Sandbox: capacity-1 event,
/// nonzero deposited principal, permissionless refund-only after the real
/// `checkin_close + 24h` deadline, then a beneficiary claim through the
/// canonical FT and private callback. A 5s block interval keeps the
/// fast-forward to ~17.5k blocks while the main default-time Sandbox keeps
/// the 156-check suite fast.
async fn run_deadline_case(
    evidence: &mut Evidence,
    ft_wasm: &Path,
    showstake_wasm: &Path,
) -> anyhow::Result<()> {
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_version(SANDBOX_VERSION).await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    evidence.deadline_sandbox = Some(SandboxEvidence {
        version: SANDBOX_VERSION.to_string(),
        rpc_addr: sandbox.rpc_addr.clone(),
        home_dir: sandbox.home_dir.path().display().to_string(),
        fixture_only: true,
        public_network_calls: false,
    });

    let signer = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;
    let organizer = create_account(&sandbox, "deadline-organizer.sandbox").await?;
    let alice = create_account(&sandbox, "deadline-alice.sandbox").await?;
    let bob = create_account(&sandbox, "deadline-bob.sandbox").await?;
    let owner = create_account(&sandbox, "deadline-owner.sandbox").await?;
    let ft_id = create_account(&sandbox, "deadline-ft.sandbox").await?;
    let stake_id = create_account(&sandbox, "deadline-showstake.sandbox").await?;
    evidence.accounts.extend([
        ("deadline_organizer".to_string(), organizer.to_string()),
        ("deadline_alice".to_string(), alice.to_string()),
        ("deadline_bob".to_string(), bob.to_string()),
        ("deadline_owner".to_string(), owner.to_string()),
    ]);
    evidence.contracts.extend([
        ("deadline_ft".to_string(), ft_id.to_string()),
        ("deadline_showstake".to_string(), stake_id.to_string()),
    ]);

    let ft = Contract(ft_id.clone());
    let stake = Contract(stake_id.clone());
    let env = Env {
        ft_a: ft.clone(),
        ft_b: ft.clone(),
        open_stake: stake.clone(),
        open2_stake: stake.clone(),
        closed_stake: stake.clone(),
        open_id: stake_id.clone(),
        open2_id: stake_id.clone(),
        closed_id: stake_id.clone(),
        life_id: stake_id.clone(),
        timeout_id: stake_id.clone(),
        fail_id: stake_id.clone(),
        organizer: organizer.clone(),
        alice: alice.clone(),
        bob: bob.clone(),
        carol: organizer.clone(),
        dave: organizer.clone(),
        frank: organizer.clone(),
        owner_a: owner.clone(),
        owner_b: owner.clone(),
        network: network.clone(),
    };
    let metadata = serde_json::json!({
        "spec": "ft-1.0.0", "name": "Sandbox FT Deadline", "symbol": "SFT-D",
        "icon": null, "reference": null, "reference_hash": null, "decimals": 0
    });
    let tx = deploy(
        &ft_id,
        ft_wasm,
        "new",
        serde_json::json!({"owner_id": owner, "total_supply": "1000000", "metadata": metadata}),
        signer.clone(),
        &network,
        "deploy_deadline_ft",
        "deadline Sandbox canonical FT fixture",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deploy_deadline_ft_success",
        "deadline Sandbox FT deploy succeeds",
        tx.top_level_success,
        tx.tx_hash.clone(),
    );
    evidence.transactions.push(tx);
    let tx = deploy(
        &stake_id,
        showstake_wasm,
        "new",
        serde_json::json!({
            "organizer": organizer,
            "canonical_ft": ft_id,
            "network": "sandbox-local",
            "policy_version": POLICY_IDENTITY,
        }),
        signer.clone(),
        &network,
        "deploy_deadline_showstake",
        "deadline showstake instance with a 5s block-time Sandbox",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deploy_deadline_showstake_success",
        "deadline ShowStake deploy succeeds",
        tx.top_level_success,
        tx.tx_hash.clone(),
    );
    evidence.transactions.push(tx);

    for (label, target) in [
        ("deadline_ft_storage_stake", stake_id.clone()),
        ("deadline_ft_storage_alice", alice.clone()),
        ("deadline_ft_storage_owner", owner.clone()),
    ] {
        let tx = call(
            &ft,
            "storage_deposit",
            serde_json::json!({"account_id": target, "registration_only": true}),
            &organizer,
            signer.clone(),
            &network,
            NearToken::from_millinear(10),
            NearGas::from_tgas(30),
            label,
            "register deadline FT storage",
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("{label}_success"),
            "deadline FT storage registration succeeds",
            tx.top_level_success,
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }
    let tx = call(
        &ft,
        "ft_transfer",
        serde_json::json!({"receiver_id": alice, "amount": "100", "memo": null}),
        &owner,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(30),
        "deadline_fund_alice",
        "fund alice with exactly D on the deadline Sandbox",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_fund_alice_success",
        "deadline funding succeeds",
        tx.top_level_success,
        tx.tx_hash.clone(),
    );
    evidence.transactions.push(tx);
    let tx = call(
        &stake,
        "storage_deposit",
        serde_json::json!({"account_id": null}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_millinear(500),
        NearGas::from_tgas(30),
        "deadline_storage_alice",
        "alice prepays registration storage on the deadline instance",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_storage_alice_success",
        "deadline native storage prepay succeeds",
        tx.top_level_success && returned_u128(&tx).is_some(),
        tx.tx_hash.clone(),
    );
    evidence.transactions.push(tx);
    let tx = call(
        &ft,
        "ft_transfer",
        serde_json::json!({
            "receiver_id": stake_id,
            "amount": (DEPOSIT * 199).to_string(),
            "memo": null,
        }),
        &owner,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(30),
        "deadline_bulk_funding",
        "fund the deadline instance with 199 synthetic registration principals",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_bulk_funding_receipt",
        "deadline bulk FT funding succeeds",
        tx.top_level_success && has_receipt_success(&tx, &ft_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let clock = view::<u64>(
        &stake,
        "get_block_timestamp_ms",
        serde_json::json!({}),
        &network,
    )
    .await?;
    let deadline_rules = event_rules(
        "local-rules-deadline-v1",
        200,
        clock - 60_000,
        clock + 900_000,
        clock + 901_000,
    );
    let tx = call(
        &stake,
        "publish_event",
        serde_json::json!({"event_id": EVENT_DEADLINE, "rules": deadline_rules.clone()}),
        &organizer,
        signer.clone(),
        &network,
        NearToken::from_near(1),
        NearGas::from_tgas(100),
        "publish_deadline",
        "publish a real-deadline event with nonzero principal",
    )
    .await?;
    check(
        &mut evidence.checks,
        "publish_deadline_success",
        "deadline event publish succeeds",
        tx.top_level_success,
        tx.tx_hash.clone(),
    );
    evidence.transactions.push(tx);
    if let Some(rules) = evidence.event_rules.as_object_mut() {
        rules.insert("deadline".to_string(), deadline_rules);
    }

    let original_event = event_view(&env, &stake, EVENT_DEADLINE).await?;
    let original_deadline = original_event.finalize_deadline;
    let mut now = view::<u64>(
        &stake,
        "get_block_timestamp_ms",
        serde_json::json!({}),
        &network,
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_original_definition",
        "published finalize_deadline is checkin_close + 24h and still in the future",
        original_deadline == original_event.checkin_close + DAY_MS
            && original_deadline > now,
        format!(
            "now={now} checkin_close={} deadline={original_deadline}",
            original_event.checkin_close
        ),
    );

    // Sandbox fast-forward cannot cover 24h on this host within the run
    // budget. Keep the event time ordering and shorten only the stored
    // finalize_deadline to checkin_close + 20s; then use the real clock and
    // sandbox_fast_forward to cross it. The +24h derivation and exact
    // boundary are unit-tested.
    let patched_deadline = original_event
        .checkin_close
        .checked_add(20_000)
        .ok_or_else(|| anyhow!("deadline overflow"))?;
    patch_event_deadline(&sandbox, &stake_id, EVENT_DEADLINE, patched_deadline).await?;
    let event = event_view(&env, &stake, EVENT_DEADLINE).await?;
    check(
        &mut evidence.checks,
        "deadline_patched_for_bounded_sandbox",
        "stored deadline is shortened to checkin_close + 20s while preserving time ordering",
        event.finalize_deadline == patched_deadline
            && patched_deadline > event.checkin_close
            && patched_deadline < original_deadline
            && event.state == "Published",
        format!(
            "checkin_close={} patched={} original={} now={now}",
            event.checkin_close, event.finalize_deadline, original_deadline
        ),
    );

    let tx = call(
        &ft,
        "ft_transfer_call",
        serde_json::json!({
            "receiver_id": stake_id,
            "amount": DEPOSIT.to_string(),
            "memo": null,
            "msg": commit_msg(EVENT_DEADLINE, "deadline-c1"),
        }),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(120),
        "deadline_commit",
        "real nonzero deposit on the deadline instance",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_commit_receipts",
        "deadline registration used real FT and receiver receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_id)
            && has_receipt_success(&tx, &stake_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let fake_count = 199u32;
    for index in 0..fake_count {
        let fake: AccountId = format!("deadline-p{index:03}.sandbox").parse()?;
        let tx = call(
            &stake,
            "storage_deposit",
            serde_json::json!({"account_id": fake}),
            &organizer,
            signer.clone(),
            &network,
            NearToken::from_millinear(20),
            NearGas::from_tgas(30),
            &format!("deadline_prepay_{index}"),
            "prepay synthetic deadline registration storage",
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("deadline_prepay_{index}_success"),
            "synthetic deadline storage prepay succeeds",
            tx.top_level_success && returned_u128(&tx).is_some(),
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);

        let tx = call(
            &stake,
            "ft_on_transfer",
            serde_json::json!({
                "sender_id": fake,
                "amount": DEPOSIT.to_string(),
                "msg": commit_msg(EVENT_DEADLINE, &format!("deadline-{index}")),
            }),
            &ft_id,
            signer.clone(),
            &network,
            NearToken::from_yoctonear(0),
            NearGas::from_tgas(60),
            &format!("deadline_register_{index}"),
            "synthetic canonical-FT receiver registration at capacity 200",
        )
        .await?;
        check(
            &mut evidence.checks,
            &format!("deadline_register_{index}_success"),
            "synthetic deadline registration succeeds",
            tx.top_level_success && has_receipt_success(&tx, &stake_id),
            tx.tx_hash.clone(),
        );
        evidence.transactions.push(tx);
    }
    let deadline_event = event_view(&env, &stake, EVENT_DEADLINE).await?;
    check(
        &mut evidence.checks,
        "deadline_capacity_200",
        "deadline event reaches capacity 200 with one real and 199 synthetic registrations",
        deadline_event.active_registrations == 200
            && deadline_event.total_registrations == 200
            && deadline_event.withdrawn_registrations == 0,
        format!("{deadline_event:?}"),
    );

    now = view::<u64>(
        &stake,
        "get_block_timestamp_ms",
        serde_json::json!({}),
        &network,
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_principal_held",
        "deadline instance holds 200D of principal and alice holds zero",
        ft_balance(&env, &ft, &stake_id).await? == (DEPOSIT * 200).to_string()
            && ft_balance(&env, &ft, &alice).await? == "0",
        "deadline principal snapshot",
    );

    let tx = call(
        &stake,
        "activate_timeout_refund",
        serde_json::json!({"event_id": EVENT_DEADLINE}),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "deadline_early_activation",
        "before the stored deadline, permissionless activation must fail",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_early_activation_fails",
        "permissionless timeout activation fails before the stored deadline",
        tx.top_level_failure && has_receipt_failure(&tx, &stake_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);

    let mut fast_forward_attempts = 0u32;
    let initial_now = now;
    let mut fast_forward_trace = Vec::new();
    while now < patched_deadline && fast_forward_attempts < 8 {
        let before_now = now;
        let blocks = (((patched_deadline - now) / 300) + 50).min(500);
        let started = std::time::Instant::now();
        sandbox.fast_forward(blocks).await?;
        now = view::<u64>(
            &stake,
            "get_block_timestamp_ms",
            serde_json::json!({}),
            &network,
        )
        .await?;
        fast_forward_attempts += 1;
        fast_forward_trace.push(format!(
            "attempt={fast_forward_attempts} blocks={blocks} before={before_now} after={now} elapsed_ms={}",
            started.elapsed().as_millis()
        ));
    }
    check(
        &mut evidence.checks,
        "deadline_fast_forward_progress",
        "Sandbox fast-forward advanced real block time toward and across the stored deadline",
        fast_forward_attempts > 0 && now > initial_now,
        format!(
            "initial={initial_now} final={now} deadline={patched_deadline} attempts={fast_forward_attempts} trace={}",
            fast_forward_trace.join("; ")
        ),
    );
    check(
        &mut evidence.checks,
        "deadline_clock_reached_deadline",
        "real Sandbox clock is at/after the stored deadline before activation",
        now >= patched_deadline,
        format!(
            "now={now} deadline={patched_deadline} attempts={fast_forward_attempts}"
        ),
    );

    let tx = call(
        &stake,
        "activate_timeout_refund",
        serde_json::json!({"event_id": EVENT_DEADLINE}),
        &bob,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(0),
        NearGas::from_tgas(100),
        "deadline_permissionless_timeout",
        "any account activates refund-only after the real deadline",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_permissionless_timeout_succeeds",
        "permissionless timeout activation succeeds on the real deadline instance",
        tx.top_level_success && has_receipt_success(&tx, &stake_id),
        format!("{tx:?}"),
    );
    let timeout_gas = receipt_gas(&tx, &stake_id).unwrap_or(u64::MAX);
    check(
        &mut evidence.checks,
        "deadline_timeout_o1_gas",
        "timeout activation at capacity 200 stays O(1) and below 3 Tgas",
        timeout_gas <= 3_000_000_000_000,
        format!("gas={timeout_gas}"),
    );
    evidence.transactions.push(tx);
    let event = event_view(&env, &stake, EVENT_DEADLINE).await?;
    let claim = claim_view(&env, &stake, "reg-0").await?;
    let totals = event_totals(&env, &stake, EVENT_DEADLINE).await?;
    check(
        &mut evidence.checks,
        "deadline_timeout_refund_only",
        "real-deadline event is RefundOnly with every registration claimable at D",
        event.state == "RefundOnly"
            && event.phase == "RefundOnly"
            && event.active_registrations == 200
            && claim.amount == DEPOSIT.to_string()
            && claim.payout_state == "Claimable"
            && totals.accepted_principal == (DEPOSIT * 200).to_string()
            && totals.paid == "0"
            && totals.pending == "0"
            && totals.liability == (DEPOSIT * 200).to_string()
            && instance_escrow(&env, &stake).await? == (DEPOSIT * 200).to_string(),
        format!("event={event:?} claim={claim:?} totals={totals:?}"),
    );

    let alice_before_claim = ft_balance(&env, &ft, &alice).await?;
    let stake_before_claim = ft_balance(&env, &ft, &stake_id).await?;
    let tx = call(
        &stake,
        "claim",
        serde_json::json!({"registration_id": "reg-0"}),
        &alice,
        signer.clone(),
        &network,
        NearToken::from_yoctonear(1),
        NearGas::from_tgas(100),
        "deadline_claim",
        "claim the deposited principal at the 100 Tgas minimum",
    )
    .await?;
    check(
        &mut evidence.checks,
        "deadline_claim_receipts",
        "deadline claim produced successful FT transfer and payout callback receipts",
        tx.top_level_success
            && has_receipt_success(&tx, &ft_id)
            && has_receipt_success(&tx, &stake_id),
        format!("{tx:?}"),
    );
    evidence.transactions.push(tx);
    let claim = claim_view(&env, &stake, "reg-0").await?;
    let totals = event_totals(&env, &stake, EVENT_DEADLINE).await?;
    check(
        &mut evidence.checks,
        "deadline_claim_paid_once",
        "deadline claim pays exactly D and leaves 199D liability conserved at capacity 200",
        claim.payout_state == "Paid"
            && claim.paid_amount == DEPOSIT.to_string()
            && parse_u128(&ft_balance(&env, &ft, &alice).await?)
                == parse_u128(&alice_before_claim) + DEPOSIT
            && parse_u128(&ft_balance(&env, &ft, &stake_id).await?) + DEPOSIT
                == parse_u128(&stake_before_claim)
            && totals.accepted_principal == (DEPOSIT * 200).to_string()
            && totals.paid == DEPOSIT.to_string()
            && totals.pending == "0"
            && totals.liability == (DEPOSIT * 199).to_string()
            && instance_escrow(&env, &stake).await? == (DEPOSIT * 199).to_string()
            && ft_balance(&env, &ft, &stake_id).await? == (DEPOSIT * 199).to_string(),
        format!("claim={claim:?} totals={totals:?}"),
    );
    let deadline_holders = parse_u128(&ft_balance(&env, &ft, &owner).await?)
        + parse_u128(&ft_balance(&env, &ft, &alice).await?)
        + parse_u128(&ft_balance(&env, &ft, &stake_id).await?);
    check(
        &mut evidence.checks,
        "deadline_ft_supply_conserved",
        "deadline FT holders sum to the immutable total supply",
        deadline_holders == 1_000_000
            && ft_balance(&env, &ft, &owner).await? == "980000"
            && ft_balance(&env, &ft, &alice).await? == "100"
            && ft_balance(&env, &ft, &stake_id).await? == (DEPOSIT * 199).to_string(),
        format!("sum={deadline_holders}"),
    );

    Ok(())
}

#[tokio::main]
async fn main() {
    let run_id = std::env::var("RUN_ID").unwrap_or_else(|_| "local-run".to_string());
    let evidence_out = PathBuf::from(
        std::env::var("EVIDENCE_OUT").expect("EVIDENCE_OUT must point to the run evidence JSON"),
    );
    let ft_wasm = PathBuf::from(std::env::var("FT_WASM").expect("FT_WASM must point to ft fixture wasm"));
    let showstake_wasm = PathBuf::from(
        std::env::var("SHOWSTAKE_WASM").expect("SHOWSTAKE_WASM must point to product wasm"),
    );

    let mut evidence = Evidence {
        schema: "showstake.product-runner/1.1.0",
        label: "LOCAL PRODUCT SLICE ONLY — real sandbox receipts/balances, not production/testnet settlement",
        run_id: run_id.clone(),
        status: "INCOMPLETE".to_string(),
        error: None,
        sandbox: SandboxEvidence::default(),
        deadline_sandbox: None,
        accounts: BTreeMap::new(),
        contracts: BTreeMap::new(),
        wasm: WasmEvidence {
            showstake_path: showstake_wasm.display().to_string(),
            showstake_bytes: std::fs::metadata(&showstake_wasm).map(|m| m.len()).unwrap_or(0),
            showstake_sha256: std::env::var("SHOWSTAKE_WASM_SHA256").unwrap_or_default(),
            ft_fixture_path: ft_wasm.display().to_string(),
            ft_fixture_bytes: std::fs::metadata(&ft_wasm).map(|m| m.len()).unwrap_or(0),
            ft_fixture_sha256: std::env::var("FT_WASM_SHA256").unwrap_or_default(),
        },
        clock_ms: 0,
        event_rules: serde_json::json!({}),
        transactions: Vec::new(),
        snapshots: Vec::new(),
        checks: Vec::new(),
        limits: vec![
            "Local synthetic NEAR Sandbox only; no testnet/mainnet, faucet, public deployment, wallet or real asset.",
            "Reviewed artifact is one event per contract instance; distinct events are separate instances.",
            "Implemented product slice: publish, native storage prepay, canonical-FT registration/pass, one lifetime registration per account/event (no voluntary withdrawal or rejoin), organizer cancellation, permissionless timeout refund-only, and exactly-once beneficiary claims via private FT callback.",
            "Attendance, finalization, settlement/redistribution and factory are NOT implemented in this slice.",
            "Timeout is proved twice: zero-registration activation on the default Sandbox, and a capacity-200 event with a real nonzero deposit -> shortened stored deadline (checkin_close + 20s via sandbox_patch_state) -> real fast-forward over it -> permissionless refund-only -> claim; the +24h derivation and exact deadline-1/at-deadline are unit-tested.",
            "Capacity 200 is the total-registration bound on a clean instance: no withdrawal frees seats and a second registration by the same account/event is rejected.",
            "The max-capacity Sandbox instances use one real FT registration plus 199 bulk-funded synthetic canonical-FT receiver registrations to measure 200-registration cancel/timeout activation gas; the claimed registration uses real FT and balances.",
            "Pass is custom and account-bound; no NEP-171/NEP-393 conformance is claimed.",
            "Cancellation and timeout activation are O(1) and measured at 200 registrations; settlement/redistribution max-200 gas remains NOT_RUN.",
            "Voluntary withdrawal traps before mutation; legacy states without the schema marker fail closed and require a clean instance.",
            "Invalid deposits rely on real FT resolver refund receipts and restored balances; no in-memory model is evidence.",
            "Teardown is limited to this run's PGID + pinned near-sandbox binary and run-owned --home.",
        ],
    };

    let result = run_case(&mut evidence, &ft_wasm, &showstake_wasm).await;
    if let Err(error) = result {
        evidence.error = Some(format!("{error:#}"));
    }
    if evidence.error.is_none()
        && evidence.checks.iter().all(|check| check.passed)
        && !evidence.checks.is_empty()
        && !evidence.transactions.is_empty()
    {
        evidence.status = "PASS_LOCAL".to_string();
    } else {
        evidence.status = "FAILED".to_string();
    }

    if let Some(parent) = evidence_out.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!("could not create evidence directory: {error}");
        }
    }
    match serde_json::to_vec_pretty(&evidence) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(&evidence_out, bytes) {
                eprintln!("could not write evidence: {error}");
                std::process::exit(2);
            }
        }
        Err(error) => {
            eprintln!("could not serialize evidence: {error}");
            std::process::exit(2);
        }
    }

    println!("SHOWSTAKE_PRODUCT_STATUS {}", evidence.status);
    println!("RUN_ID {run_id}");
    println!(
        "TRANSACTIONS {}/{} top-level-success, checks {}/{}",
        evidence.transactions.iter().filter(|tx| tx.top_level_success).count(),
        evidence.transactions.len(),
        evidence.checks.iter().filter(|check| check.passed).count(),
        evidence.checks.len()
    );
    if let Some(error) = &evidence.error {
        println!("ERROR {error}");
    }
    if evidence.status != "PASS_LOCAL" {
        for check in evidence.checks.iter().filter(|check| !check.passed) {
            println!("FAILED_CHECK {}: {} ({})", check.id, check.description, check.detail);
        }
        std::process::exit(1);
    }
}
