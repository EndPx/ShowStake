use anyhow::{Result, ensure};
use base64::Engine;
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use serde_json::{Value, json};
use std::sync::Arc;

const LEAF_HASH: &str = "49a591ba26a4a23d05c01cc343779f1c66aa5da0384e3a663a37f4e5edb59b70";
const LEAF_HASH_BASE58: &str = "5xVC9cyZDeCJXpS8rhD4Hh3tNMBB4MNnvh5eYpW9y5Aw";
const POLICY: &str = "showstake-native-usdc-rhea-linked-withdraw-review/2";

async fn view(c: &Contract, m: &str, a: Value, n: &NetworkConfig) -> Result<Value> {
    eprintln!("VIEW {} {}", c.0, m);
    let v: near_api::types::Data<Value> = c.call_function(m, a).read_only().fetch_from(n).await?;
    Ok(v.data)
}
async fn call(
    c: &Contract,
    m: &str,
    a: Value,
    id: &AccountId,
    s: Arc<Signer>,
    n: &NetworkConfig,
    deposit: u128,
    gas: u64,
) -> Result<Value> {
    let result = c
        .call_function(m, a)
        .transaction()
        .gas(NearGas::from_tgas(gas))
        .deposit(NearToken::from_yoctonear(deposit))
        .with_signer(id.clone(), s)
        .send_to(n)
        .await?;
    let f = result
        .into_full()
        .ok_or_else(|| anyhow::anyhow!("nonfinal transaction"))?;
    Ok(
        json!({"success": f.is_success(), "gas_burnt": f.total_gas_burnt.as_gas(), "result": f.clone().json::<Value>().ok(), "receipts": format!("{:?}", f.receipt_outcomes())}),
    )
}
fn amount(v: &Value, key: &str) -> Result<u128> {
    Ok(v[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing {key}: {v}"))?
        .parse()?)
}

#[tokio::main]
async fn main() -> Result<()> {
    let leaf = std::fs::read(std::env::var("SHOWSTAKE_WASM")?)?;
    ensure!(leaf.len() == 235060, "wrong leaf length");
    let code = base64::engine::general_purpose::STANDARD.encode(&leaf);
    let factory = std::fs::read(std::env::var("FACTORY_WASM")?)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
    let n = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let s = Signer::from_secret_key(
        near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?,
    )?;
    for a in ["factory.sandbox", "organizer.sandbox", "other.sandbox"] {
        sandbox
            .create_account(a.parse()?)
            .initial_balance(NearToken::from_near(30))
            .send()
            .await?;
    }
    let fid: AccountId = "factory.sandbox".parse()?;
    let org: AccountId = "organizer.sandbox".parse()?;
    let other: AccountId = "other.sandbox".parse()?;
    let init = json!({"canonical_ft":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "network":"mainnet", "policy_version":POLICY, "provider_account":"contract.main.burrow.near", "provider_kind":"RHEA_MAINNET"});
    let deployed = Contract::deploy(fid.clone())
        .use_code(factory)
        .with_init_call("new", init)?
        .gas(NearGas::from_tgas(300))
        .with_signer(s.clone())
        .send_to(&n)
        .await?
        .into_full()
        .ok_or_else(|| anyhow::anyhow!("nonfinal deploy"))?;
    ensure!(deployed.is_success(), "factory deploy failed: {deployed:?}");
    let c = Contract(fid.clone());
    let factory_config = view(&c, "get_config", json!({}), &n).await?;
    ensure!(
        factory_config["schema_version"] == 2
            && factory_config["factory_policy_identity"] == "showstake-factory-d039-global-ready/2"
            && factory_config["leaf_code_sha256"] == LEAF_HASH
            && factory_config["leaf_code_len"] == 235060
            && factory_config["leaf_policy_version"] == POLICY,
        "wrong factory profile {factory_config}"
    );
    let byte_cost = amount(&factory_config, "storage_byte_cost")?;
    let mut evidence = Vec::new();
    let mut ids = Vec::new();
    for who in [&org, &other] {
        let before = Account(fid.clone()).view().fetch_from(&n).await?;
        let q = view(&c, "quote_provision", json!({"organizer":who}), &n).await?;
        let provision_gas = q["attached_gas_tgas"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("missing quote gas"))?;
        ensure!(
            provision_gas == 300 && factory_config["min_provision_gas_tgas"] == provision_gas,
            "unexpected provision gas: {q}"
        );
        let tx = call(
            &c,
            "provision",
            json!({"request_nonce":1, "code":code}),
            who,
            s.clone(),
            &n,
            amount(&q, "total")?,
            provision_gas,
        )
        .await?;
        eprintln!("PROVISION_RESULT {}", tx);
        let r = view(
            &c,
            "get_request",
            json!({"organizer":who, "request_nonce":1}),
            &n,
        )
        .await?;
        ensure!(
            tx["success"] == true && r["state"] == "Ready",
            "provision failed: {tx} {r}"
        );
        let child_id: AccountId = r["child_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing child"))?
            .parse()?;
        let child = Contract(child_id.clone());
        let config = view(&child, "get_config", json!({}), &n).await?;
        let control = view(&child, "get_rhea_control", json!({}), &n).await?;
        let event = view(&child, "get_event", json!({}), &n).await?;
        let account = Account(child_id.clone()).view().fetch_from(&n).await?;
        let keys = Account(child_id.clone()).list_keys().fetch_from(&n).await?;
        let keys_value = serde_json::to_value(&keys.data)?;
        ensure!(
            keys_value.as_array().map(|x| x.is_empty()) == Some(true),
            "child has keys {keys_value}"
        );
        ensure!(
            format!("{:?}", account.data).contains(LEAF_HASH_BASE58),
            "unexpected deployed leaf hash"
        );
        ensure!(
            config["organizer"] == who.as_str()
                && config["policy_version"] == POLICY
                && config["provider_kind"] == "RHEA_MAINNET"
                && control["paused"] == true
                && control["principal_cap"] == "0"
                && event.is_null(),
            "wrong child initialization: {config} {control} {event}"
        );
        let after = Account(fid.clone()).view().fetch_from(&n).await?;
        let growth = after
            .data
            .storage_usage
            .checked_sub(before.data.storage_usage)
            .ok_or_else(|| anyhow::anyhow!("storage fell"))?;
        ensure!(
            amount(&q, "registry_fee")? == u128::from(growth) * byte_cost,
            "quote does not match total Ready storage growth: {q}, growth {growth}"
        );
        ensure!(
            amount(&r, "registry_fee")? == amount(&q, "registry_fee")?,
            "request registry fee mismatch"
        );
        ids.push(child_id.to_string());
        evidence.push(json!({"organizer":who, "quote":q, "request":r, "transaction":tx, "factory_storage_before":before.data.storage_usage, "factory_storage_after":after.data.storage_usage, "factory_growth_bytes":growth, "child_account":account.data, "keys":keys_value, "config":config, "control":control, "event":event}));
    }
    let all = view(
        &c,
        "list_all_children",
        json!({"from_index":0,"limit":20}),
        &n,
    )
    .await?;
    let page0 = view(
        &c,
        "list_all_children",
        json!({"from_index":0,"limit":1}),
        &n,
    )
    .await?;
    let page1 = view(
        &c,
        "list_all_children",
        json!({"from_index":1,"limit":1}),
        &n,
    )
    .await?;
    let page2 = view(
        &c,
        "list_all_children",
        json!({"from_index":2,"limit":20}),
        &n,
    )
    .await?;
    ensure!(
        all.as_array().map(|x| x.len()) == Some(2)
            && all[0]["child_id"] == ids[0]
            && all[1]["child_id"] == ids[1]
            && page0[0] == all[0]
            && page1[0] == all[1]
            && page2.as_array().map(|x| x.is_empty()) == Some(true),
        "global pagination or order mismatch: {all} {page0} {page1} {page2}"
    );
    let replay_quote = view(&c, "quote_provision", json!({"organizer":org}), &n).await?;
    let replay_gas = replay_quote["attached_gas_tgas"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("missing replay gas"))?;
    ensure!(
        replay_gas == 300,
        "unexpected replay quote gas: {replay_quote}"
    );
    let replay = call(
        &c,
        "provision",
        json!({"request_nonce":1,"code":code}),
        &org,
        s.clone(),
        &n,
        0,
        replay_gas,
    )
    .await?;
    ensure!(
        replay["success"] == true
            && view(
                &c,
                "list_all_children",
                json!({"from_index":0,"limit":20}),
                &n
            )
            .await?
                == all,
        "replay changed global list"
    );
    let collision_id: AccountId = view(
        &c,
        "get_child_id",
        json!({"organizer":org,"request_nonce":2}),
        &n,
    )
    .await?
    .as_str()
    .ok_or_else(|| anyhow::anyhow!("missing collision id"))?
    .parse()?;
    sandbox
        .create_account(collision_id.as_str().parse()?)
        .initial_balance(NearToken::from_near(1))
        .send()
        .await?;
    let failed_before = Account(fid.clone()).view().fetch_from(&n).await?;
    let fq = view(&c, "quote_provision", json!({"organizer":org}), &n).await?;
    let failure_gas = fq["attached_gas_tgas"]
        .as_u64()
        .ok_or_else(|| anyhow::anyhow!("missing failed request gas"))?;
    ensure!(
        failure_gas == 300,
        "unexpected failed request quote gas: {fq}"
    );
    let failure = call(
        &c,
        "provision",
        json!({"request_nonce":2,"code":code}),
        &org,
        s.clone(),
        &n,
        amount(&fq, "total")?,
        failure_gas,
    )
    .await?;
    let failed = view(
        &c,
        "get_request",
        json!({"organizer":org,"request_nonce":2}),
        &n,
    )
    .await?;
    let failed_after = Account(fid.clone()).view().fetch_from(&n).await?;
    ensure!(
        failed["state"] == "Failed" && failed["refund_state"] == "Claimable",
        "collision not claimable: {failure} {failed}"
    );
    ensure!(
        view(
            &c,
            "list_all_children",
            json!({"from_index":0,"limit":20}),
            &n
        )
        .await?
            == all,
        "failed child entered global list"
    );
    let balance_before = Account(org.clone()).view().fetch_from(&n).await?;
    let refund = call(
        &c,
        "claim_failed_funding",
        json!({"request_nonce":2}),
        &org,
        s.clone(),
        &n,
        0,
        120,
    )
    .await?;
    let balance_after = Account(org.clone()).view().fetch_from(&n).await?;
    let refunded = view(
        &c,
        "get_request",
        json!({"organizer":org,"request_nonce":2}),
        &n,
    )
    .await?;
    ensure!(
        refund["success"] == true
            && refunded["refund_state"] == "Paid"
            && balance_after.data.amount.as_yoctonear() > balance_before.data.amount.as_yoctonear(),
        "refund failed {refund} {refunded}"
    );
    let duplicate = call(
        &c,
        "claim_failed_funding",
        json!({"request_nonce":2}),
        &org,
        s.clone(),
        &n,
        0,
        120,
    )
    .await?;
    ensure!(duplicate["success"] == false, "duplicate refund accepted");
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"status":"PASS_LOCAL", "scope":"Sandbox only; mainnet-labeled config, no public network or provider calls; collision is synthetic", "factory_config":factory_config, "successes":evidence, "global":all, "page0":page0, "page1":page1, "page2":page2, "replay":replay, "failed_quote":fq, "failed_transaction":failure, "failed_request":failed, "failed_factory_storage_before":failed_before.data.storage_usage, "failed_factory_storage_after":failed_after.data.storage_usage, "refund":refund, "refund_before":balance_before.data, "refund_after":balance_after.data, "refunded_request":refunded, "duplicate_refund":duplicate})
        )?
    );
    Ok(())
}
