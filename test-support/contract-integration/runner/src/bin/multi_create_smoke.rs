//! LOCAL only: actual frozen legacy Wasm -> empty-state migration -> two organizers.
use anyhow::{ensure, Result};
use near_api::{Account, AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_api::types::transaction::result::ExecutionFinalResult;
use serde_json::{json, Value};
use std::sync::Arc;

async fn view(c: &Contract, method: &str, args: Value, n: &NetworkConfig) -> Result<Value> {
    let result: near_api::types::Data<Value> = c.call_function(method, args).read_only().fetch_from(n).await?;
    Ok(result.data)
}
async fn call(c: &Contract, method: &str, args: Value, who: &AccountId, signer: Arc<Signer>, n: &NetworkConfig, deposit: u128) -> Result<ExecutionFinalResult> {
    c.call_function(method, args).transaction().gas(NearGas::from_tgas(300))
        .deposit(NearToken::from_yoctonear(deposit)).with_signer(who.clone(), signer).send_to(n).await?
        .into_full().ok_or_else(|| anyhow::anyhow!("nonfinal transaction"))
}
fn proof(f: &ExecutionFinalResult) -> Value {
    json!({"success": f.is_success(), "gas_burnt": f.total_gas_burnt.as_gas(),
        "receipts": f.outcomes().iter().map(|r| json!({"id":r.transaction_hash.to_string(),
            "executor":r.executor_id.to_string(),"success":r.is_success(),"failure":r.is_failure(),
            "logs":r.logs,"children":r.receipt_ids.iter().map(ToString::to_string).collect::<Vec<_>>()})).collect::<Vec<_>>()})
}
#[tokio::main]
async fn main() -> Result<()> {
    let old_code = std::fs::read(std::env::var("LEGACY_WASM")?)?;
    let new_code = std::fs::read(std::env::var("MULTI_WASM")?)?;
    ensure!(old_code.len() == 224939, "wrong legacy artifact");
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let escrow: AccountId = "showstake-mainnet-escrow-endpx-2026.near".parse()?;
    let alice: AccountId = "alice.near".parse()?;
    let bob: AccountId = "bob.near".parse()?;
    for id in [&escrow, &alice, &bob] {
        sandbox.create_account(id.as_str().parse()?).initial_balance(NearToken::from_millinear(if id == &escrow { 2300 } else { 1000 })).send().await?;
    }
    let init = json!({"organizer":alice,"provider_account":"contract.main.burrow.near",
        "canonical_ft":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        "token_symbol":"USDC","token_name":"USD Coin","token_decimals":6,"provider_kind":"RHEA_MAINNET"});
    let deployed = Contract::deploy(escrow.clone()).use_code(old_code).with_init_call("new", init)?
        .gas(NearGas::from_tgas(10)).with_signer(signer.clone()).send_to(&network).await?
        .into_full().ok_or_else(|| anyhow::anyhow!("legacy deploy nonfinal"))?;
    ensure!(deployed.is_success() && deployed.receipt_failures().is_empty(), "legacy deploy failed {:?}",deployed.receipt_failures());
    let contract = Contract(escrow.clone());
    ensure!(view(&contract,"get_event",json!({}),&network).await?.is_null(),"legacy not empty");
    let before = Account(escrow.clone()).view().fetch_from(&network).await?;
    let migrated = Contract::deploy(escrow.clone()).use_code(new_code)
        .with_init_call("migrate_empty_legacy",json!({}))?.gas(NearGas::from_tgas(10))
        .with_signer(signer.clone()).send_to(&network).await?.into_full()
        .ok_or_else(|| anyhow::anyhow!("migration nonfinal"))?;
    ensure!(migrated.is_success() && migrated.receipt_failures().is_empty(),"migration failed {:?}",migrated.receipt_failures());
    let config = view(&contract,"get_config",json!({}),&network).await?;
    ensure!(config["policy_version"]=="showstake-native-usdc-multievent/1" && config["provider_enabled"]==false && config.get("organizer").is_none(),"wrong shared config");
    ensure!(view(&contract,"list_events",json!({"from_index":0,"limit":20}),&network).await?==json!([]),"migration created events");
    let after = Account(escrow.clone()).view().fetch_from(&network).await?;
    let now = view(&contract,"get_block_timestamp_ms",json!({}),&network).await?.as_u64().ok_or_else(||anyhow::anyhow!("clock missing"))?;
    let mut creations = Vec::new();
    for (who,event_id) in [(&alice,"mainnet-create-a"),(&bob,"mainnet-create-b")] {
        let rules=json!({"event_id":event_id,"title":"ShowStake mainnet event","location":"Online",
            "rules_text":"Deposit 2 USDC. Attendees share the pool. Funding remains unavailable until Earn is accepted.",
            "finalize_deadline":now+3_600_000u64+86_400_000u64,"deposit":"2000000","capacity":5,
            "reg_open":now,"reg_close":now+600_000u64,"checkin_open":now+900_000u64,"checkin_close":now+3_600_000u64});
        let quote=view(&contract,"quote_create_event",json!({"rules":rules,"organizer":who}),&network).await?;
        let amount: u128=quote.as_str().ok_or_else(||anyhow::anyhow!("quote not string"))?.parse()?;
        let wallet_before=Account(who.clone()).view().fetch_from(&network).await?;
        let f=call(&contract,"create_event",json!({"rules":rules}),who,signer.clone(),&network,amount).await?;
        ensure!(f.is_success()&&f.receipt_failures().is_empty(),"create failed {:?}",f.receipt_failures());
        let event=view(&contract,"get_event",json!({"event_id":event_id}),&network).await?;
        ensure!(event["organizer"]==who.as_str()&&event["event_id"]==event_id&&event["accepted_principal"]=="0", "event identity mismatch");
        let duplicate=call(&contract,"create_event",json!({"rules":rules}),who,signer.clone(),&network,amount).await?;
        ensure!(duplicate.is_failure(),"duplicate accepted");
        let wallet_after=Account(who.clone()).view().fetch_from(&network).await?;
        creations.push(json!({"organizer":who,"quote_atomic":quote,"event":event,"create":proof(&f),
            "duplicate":proof(&duplicate),"wallet_before":wallet_before.data,"wallet_after":wallet_after.data}));
    }
    let forbidden=call(&contract,"cancel_event",json!({"event_id":"mainnet-create-a"}),&bob,signer.clone(),&network,0).await?;
    ensure!(forbidden.is_failure(),"foreign organizer cancelled event");
    let page=view(&contract,"list_events",json!({"from_index":0,"limit":20}),&network).await?;
    ensure!(page.as_array().is_some_and(|x|x.len()==2),"missing multi-event list");
    let reset=call(&contract,"migrate_empty_legacy",json!({}),&escrow,signer.clone(),&network,0).await?;
    ensure!(reset.is_failure(),"nonempty shared state reset accepted");
    ensure!(view(&contract,"list_events",json!({"from_index":0,"limit":20}),&network).await?==page,"events changed on refused reset");
    println!("{}",serde_json::to_string_pretty(&json!({"status":"PASS_LOCAL","scope":"Actual legacy03076 Wasm migration and two native organizer creates in local Sandbox only",
        "config":config,"before_migration":before.data,"after_migration":after.data,"migration":proof(&migrated),
        "creations":creations,"foreign_cancel":proof(&forbidden),"reset_denied":proof(&reset),
        "events":page,"accounting":view(&contract,"get_accounting",json!({}),&network).await?,"provider_calls":0,"public_network_transactions":0}))?);
    Ok(())
}
