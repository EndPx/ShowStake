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
use near_api::types::transaction::result::{
    ExecutionFinalResult, ExecutionOutcome, TransactionResult,
};
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use serde::{Deserialize, Serialize};

const SANDBOX_VERSION: &str = "2.14.0";
const DEPOSIT: u128 = 100;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;

const EVENT_OPEN: &str = "evt-open";
const EVENT_OPEN2: &str = "evt-open-2";
const EVENT_CLOSED: &str = "evt-closed";

#[derive(Serialize)]
struct Evidence {
    schema: &'static str,
    label: &'static str,
    run_id: String,
    status: String,
    error: Option<String>,
    sandbox: SandboxEvidence,
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
    alice_b: String,
    bob_b: String,
    open_stake_a: String,
    open2_stake_a: String,
    closed_stake_a: String,
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
#[derive(Deserialize, Debug)]
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
    accepted_principal: String,
    created_at: u64,
}

#[allow(dead_code)]
#[derive(Deserialize, Debug)]
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
    organizer: AccountId,
    alice: AccountId,
    bob: AccountId,
    carol: AccountId,
    dave: AccountId,
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
        alice_b: ft_balance(env, &env.ft_b, &env.alice).await?,
        bob_b: ft_balance(env, &env.ft_b, &env.bob).await?,
        open_stake_a: ft_balance(env, &env.ft_a, &env.open_id).await?,
        open2_stake_a: ft_balance(env, &env.ft_a, &env.open2_id).await?,
        closed_stake_a: ft_balance(env, &env.ft_a, &env.closed_id).await?,
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
    let owner_a = create_account(&sandbox, "owner-a.sandbox").await?;
    let owner_b = create_account(&sandbox, "owner-b.sandbox").await?;
    let ft_a_id = create_account(&sandbox, "ft-a.sandbox").await?;
    let ft_b_id = create_account(&sandbox, "ft-b.sandbox").await?;
    let open_id = create_account(&sandbox, "showstake-open.sandbox").await?;
    let open2_id = create_account(&sandbox, "showstake-open2.sandbox").await?;
    let closed_id = create_account(&sandbox, "showstake-closed.sandbox").await?;

    evidence.accounts = BTreeMap::from([
        ("organizer".to_string(), organizer.to_string()),
        ("alice".to_string(), alice.to_string()),
        ("bob".to_string(), bob.to_string()),
        ("carol".to_string(), carol.to_string()),
        ("dave".to_string(), dave.to_string()),
        ("owner_a".to_string(), owner_a.to_string()),
        ("owner_b".to_string(), owner_b.to_string()),
    ]);
    evidence.contracts = BTreeMap::from([
        ("canonical_ft_a".to_string(), ft_a_id.to_string()),
        ("wrong_ft_b".to_string(), ft_b_id.to_string()),
        ("showstake_open".to_string(), open_id.to_string()),
        ("showstake_open2".to_string(), open2_id.to_string()),
        ("showstake_closed".to_string(), closed_id.to_string()),
    ]);

    let ft_a = Contract(ft_a_id.clone());
    let ft_b = Contract(ft_b_id.clone());
    let open_stake = Contract(open_id.clone());
    let open2_stake = Contract(open2_id.clone());
    let closed_stake = Contract(closed_id.clone());
    let env = Env {
        ft_a: ft_a.clone(),
        ft_b: ft_b.clone(),
        open_stake: open_stake.clone(),
        open2_stake: open2_stake.clone(),
        closed_stake: closed_stake.clone(),
        open_id: open_id.clone(),
        open2_id: open2_id.clone(),
        closed_id: closed_id.clone(),
        organizer: organizer.clone(),
        alice: alice.clone(),
        bob: bob.clone(),
        carol: carol.clone(),
        dave: dave.clone(),
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
            "policy_version": "showstake-v2/1",
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
    ] {
        let config = view::<ConfigJson>(stake, "get_config", serde_json::json!({}), &network).await?;
        check(
            &mut evidence.checks,
            &format!("{label}_immutable"),
            "each instance has the exact organizer, canonical FT and labels",
            config.organizer == organizer.to_string()
                && config.canonical_ft == ft_a_id.to_string()
                && config.network == "sandbox-local"
                && config.policy_version == "showstake-v2/1",
            format!("stake={stake_id} {config:?}"),
        );
    }
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
        ("ft_b_storage_open", &ft_b, &open_id, "register open instance on wrong-token FT"),
        ("ft_a_storage_alice", &ft_a, &alice, "register alice on canonical FT"),
        ("ft_a_storage_bob", &ft_a, &bob, "register bob on canonical FT"),
        ("ft_a_storage_carol", &ft_a, &carol, "register carol on canonical FT"),
        ("ft_a_storage_dave", &ft_a, &dave, "register dave on canonical FT"),
        ("ft_b_storage_alice", &ft_b, &alice, "register alice on wrong-token FT"),
        ("ft_b_storage_bob", &ft_b, &bob, "register bob on wrong-token FT"),
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
    for (label, ft, owner, target, note) in [
        ("fund_alice_a", &ft_a, &owner_a, &alice, "owner A -> alice 1000 SFT-A"),
        ("fund_bob_a", &ft_a, &owner_a, &bob, "owner A -> bob 1000 SFT-A"),
        ("fund_carol_a", &ft_a, &owner_a, &carol, "owner A -> carol 1000 SFT-A"),
        ("fund_dave_a", &ft_a, &owner_a, &dave, "owner A -> dave 1000 SFT-A"),
        ("fund_alice_b", &ft_b, &owner_b, &alice, "owner B -> alice 1000 SFT-B"),
        ("fund_bob_b", &ft_b, &owner_b, &bob, "owner B -> bob 1000 SFT-B"),
    ] {
        let tx = call(
            ft,
            "ft_transfer",
            serde_json::json!({"receiver_id": target, "amount": "1000", "memo": null}),
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
    evidence.event_rules = serde_json::json!({
        "open": open_rules,
        "open2": open2_rules,
        "closed": closed_rules,
        "expected_finalize_deadline_ms": clock_ms + 2 * HOUR_MS + DAY_MS,
        "instances": {
            "open": open_id,
            "open2": open2_id,
            "closed": closed_id,
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
            && open_event.policy_version == "showstake-v2/1",
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
            && alice_pass.policy_version == "showstake-v2/1",
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
        "one active registration per account/event must refund",
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
        "ACTIVE_REGISTRATION",
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
                + parse_u128(&final_snap.open_stake_a)
                + parse_u128(&final_snap.open2_stake_a)
                + parse_u128(&final_snap.closed_stake_a)
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
            "Product slice is immutable organizer + publish_event + native storage prepay + ft_on_transfer registration/pass + views + transfer denial.",
            "Withdrawal, cancellation, settlement, attendance, claims and factory are NOT implemented in this slice.",
            "Pass is custom and account-bound; no NEP-171/NEP-393 conformance is claimed.",
            "Gas is recorded for observation only; max-200 G09 is NOT measured or passed.",
            "Invalid deposits rely on real FT resolver refund receipts and restored balances; no in-memory model is evidence.",
            "Teardown is limited to this run's PGID + pinned near-sandbox binary + run-owned --home.",
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
