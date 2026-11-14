//! Local Sandbox capacity proof. No registration or financial state is patched.
use std::sync::Arc;
use anyhow::{ensure, Result};
use base64::Engine;
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_api::types::transaction::result::{ExecutionFinalResult, ValueOrReceiptId};
use serde_json::{json, Value};

async fn view(c: &Contract, method: &str, args: Value, n: &NetworkConfig) -> Result<Value> {
    let v: near_api::types::Data<Value> = c.call_function(method, args).read_only().fetch_from(n).await?;
    Ok(v.data)
}
async fn call(c: &Contract, method: &str, args: Value, id: &AccountId, s: Arc<Signer>, n: &NetworkConfig, deposit: u128) -> Result<ExecutionFinalResult> {
    let f = c.call_function(method, args).transaction().gas(NearGas::from_tgas(300)).deposit(NearToken::from_yoctonear(deposit)).with_signer(id.clone(), s).send_to(n).await?.into_full().ok_or_else(|| anyhow::anyhow!("nonfinal transaction"))?;
    ensure!(f.is_success() && f.receipt_failures().is_empty(), "{method} failed: {:?}", f.receipt_failures());
    Ok(f)
}
async fn deploy(id: AccountId, code: Vec<u8>, args: Value, s: Arc<Signer>, n: &NetworkConfig) -> Result<()> {
    let f = Contract::deploy(id).use_code(code).with_init_call("new", args)?.gas(NearGas::from_tgas(300)).with_signer(s).send_to(n).await?.into_full().ok_or_else(|| anyhow::anyhow!("nonfinal deploy"))?;
    ensure!(f.is_success() && f.receipt_failures().is_empty(), "deploy/init failed: {:?}", f.receipt_failures());
    Ok(())
}
fn graph(f: &ExecutionFinalResult) -> Value {
    let rows: Vec<Value> = f.receipt_outcomes().iter().map(|o| {
        let boolean = match o.clone().into_result() { Ok(ValueOrReceiptId::Value(v)) => v.json::<bool>().ok(), _ => None };
        json!({"id":o.transaction_hash.to_string(),"executor":o.executor_id.to_string(),"success":o.is_success(),"failure":o.is_failure(),"bool":boolean,"gas_burnt":o.gas_burnt.as_gas(),"children":o.receipt_ids.iter().map(ToString::to_string).collect::<Vec<_>>()})
    }).collect();
    let root = f.outcomes().first().map(|o| o.transaction_hash.to_string());
    json!({"transaction_outcome_id":root,"receipts":rows})
}
async fn advance(sb: &near_sandbox::Sandbox, c: &Contract, n: &NetworkConfig, target: u64) -> Result<()> {
    for _ in 0..100 {
        let now = view(c,"get_block_timestamp_ms",json!({}),n).await?.as_u64().ok_or_else(|| anyhow::anyhow!("invalid clock"))?;
        if now >= target { println!("Clock reached: now={now}, target={target}"); return Ok(()); }
        let blocks = (((target-now)/300)+50).min(500);
        println!("Advancing Sandbox clock: now={now}, target={target}, blocks={blocks}");
        sb.fast_forward(blocks).await?;
        let after = view(c,"get_block_timestamp_ms",json!({}),n).await?.as_u64().ok_or_else(|| anyhow::anyhow!("invalid clock"))?;
        println!("Sandbox clock after advance: now={after}, delta_ms={}", after.saturating_sub(now));
    }
    anyhow::bail!("sandbox time not reached")
}
fn atomic(v: &Value, field: &str) -> Result<u128> {
    Ok(v[field].as_str().ok_or_else(|| anyhow::anyhow!("missing {field}: {v}"))?.parse()?)
}
#[tokio::main]
async fn main() -> Result<()> {
    let provider_code = std::fs::read(std::env::var("MOCK_EARN_WASM")?)?;
    let ft_code = std::fs::read(std::env::var("FT_WASM")?)?;
    let leaf = std::fs::read(std::env::var("LINKED_WASM")?)?;
    let factory_code = std::fs::read(std::env::var("FACTORY_WASM")?)?;
    let evidence_dir = std::env::var("EVIDENCE_DIR")?;
    let code = base64::engine::general_purpose::STANDARD.encode(&leaf);
    let sb = near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
    let n = NetworkConfig::from_rpc_url("sandbox", sb.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let owner: AccountId = "owner.testnet".parse()?;
    let org: AccountId = "host.testnet".parse()?;
    let fid: AccountId = "factory.testnet".parse()?;
    let pid: AccountId = "mock-earn.testnet".parse()?;
    let tid: AccountId = "usdc.testnet".parse()?;
    let users: Vec<AccountId> = (0..200).map(|i| format!("user{i}.testnet").parse().unwrap()).collect();
    for id in [&owner, &org, &fid, &pid, &tid].into_iter().chain(users.iter()) {
        sb.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(80)).send().await?;
    }
    deploy(tid.clone(),ft_code,json!({"owner_id":owner,"total_supply":"400000000","metadata":{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"USDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}}),signer.clone(),&n).await?;
    deploy(pid.clone(),provider_code,json!({"token":tid,"controller":owner}),signer.clone(),&n).await?;
    deploy(fid.clone(),factory_code,json!({"canonical_ft":tid,"network":"testnet","policy_version":"showstake-native-usdc-event/1","provider_account":pid,"provider_kind":"MOCK_TESTNET"}),signer.clone(),&n).await?;
    let ft = Contract(tid.clone());
    let factory = Contract(fid.clone());
    for id in [&pid].into_iter().chain(users.iter()) {
        call(&ft,"storage_deposit",json!({"account_id":id}),&owner,signer.clone(),&n,10_000_000_000_000_000_000_000).await?;
    }
    let url = &sb.rpc_addr;
    ensure!(url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"), "non-loopback sandbox");
    let block: Value = reqwest::Client::new().post(url).json(&json!({"jsonrpc":"2.0","id":"clock","method":"block","params":{"finality":"final"}})).send().await?.error_for_status()?.json().await?;
    let start = block["result"]["header"]["timestamp_nanosec"].as_str().ok_or_else(|| anyhow::anyhow!("missing clock"))?.parse::<u64>()? / 1_000_000;
    // A deliberately synthetic, generous window; fast-forward uses real Sandbox blocks.
    let close = start + 900_000;
    let end = close + 300_000;
    let rules = json!({"event_id":"capacity","title":"Capacity","location":"Sandbox","rules_text":"Local capacity proof","finalize_deadline":end+86_400_000u64,"deposit":"2000000","capacity":200,"reg_open":start,"reg_close":close,"checkin_open":close,"checkin_close":end});
    let q = view(&factory,"quote_provision_event",json!({"organizer":org,"request_nonce":1,"rules":rules}),&n).await?;
    let funding = atomic(&q,"total")?;
    call(&factory,"provision_event",json!({"request_nonce":1,"rules":rules,"code":code}),&org,signer.clone(),&n,funding).await?;
    let request = view(&factory,"get_request",json!({"organizer":org,"request_nonce":1}),&n).await?;
    ensure!(request["state"] == "Ready", "factory child not ready: {request}");
    let eid: AccountId = request["child_id"].as_str().ok_or_else(|| anyhow::anyhow!("missing child"))?.parse()?;
    let escrow = Contract(eid.clone());
    call(&ft,"storage_deposit",json!({"account_id":eid}),&org,signer.clone(),&n,10_000_000_000_000_000_000_000).await?;
    let mut first = Value::Null;
    let mut last = Value::Null;
    for (i, user) in users.iter().enumerate() {
        call(&ft,"ft_transfer",json!({"receiver_id":user,"amount":"2000000"}),&owner,signer.clone(),&n,1).await?;
        let msg = json!({"version":1,"event_id":"capacity","commitment_id":format!("c{i}")}).to_string();
        let tx = call(&ft,"ft_transfer_call",json!({"receiver_id":eid,"amount":"2000000","msg":msg}),user,signer.clone(),&n,1).await?;
        let deposit_graph = if i == 0 || i == 199 { Some(graph(&tx)) } else { None };
        ensure!(tx.json::<String>()? == "2000000", "deposit {i} refunded");
        if i == 0 { first = deposit_graph.unwrap(); } else if i == 199 { last = deposit_graph.unwrap(); }
        if (i+1)%25 == 0 { println!("Committed {} of 200 registrations",i+1); }
    }
    let event = view(&escrow,"get_event",json!({}),&n).await?;
    ensure!(event["total_registrations"] == 200 && atomic(&event,"accepted_principal")? == 400_000_000, "unexpected registration totals: {event}");
    println!("Checking all 200 registration and pass views");
    for (i,user) in users.iter().enumerate() {
        let reg = view(&escrow,"get_registration",json!({"registration_id":format!("capacity-reg-{i}")}),&n).await?;
        ensure!(reg["participant"] == user.as_str() && reg["amount"] == "2000000", "registration {i} mismatch");
        let pass = view(&escrow,"get_pass",json!({"pass_id":reg["pass_id"]}),&n).await?;
        ensure!(pass["owner"] == user.as_str() && pass["registration_id"] == format!("capacity-reg-{i}"), "pass {i} mismatch");
        if (i+1)%25 == 0 { println!("Checked {} of 200 registrations and passes",i+1); }
    }
    println!("Registration views complete; advancing to close={close}");
    advance(&sb,&escrow,&n,close).await?;
    call(&escrow,"close_registration",json!({}),&org,signer.clone(),&n,0).await?;
    println!("Registration closed; supplying Mock Earn");
    let supply = call(&escrow,"trigger_earn_supply",json!({}),&org,signer.clone(),&n,0).await?;
    ensure!(view(&escrow,"get_event",json!({}),&n).await?["earn_state"] == "Supplied", "supply not reconciled");
    for i in 0..100 {
        call(&escrow,"mark_attendance",json!({"registration_id":format!("capacity-reg-{i}"),"attended":true}),&org,signer.clone(),&n,0).await?;
        if (i+1)%25 == 0 { println!("Marked {} of 100 attendees",i+1); }
    }
    println!("Attendance marked; advancing to checkin close={end}");
    advance(&sb,&escrow,&n,end).await?;
    println!("Finalizing 200 registrations");
    let finalized = call(&escrow,"finalize_attendance",json!({}),&org,signer.clone(),&n,0).await?;
    println!("Finalized; redeeming Mock Earn");
    let redeemed = call(&escrow,"trigger_earn_redeem",json!({}),&org,signer.clone(),&n,0).await?;
    ensure!(view(&escrow,"get_event",json!({}),&n).await?["earn_state"] == "Redeemed", "redemption not reconciled");
    println!("Redeemed; settling 200 registrations");
    let settled = call(&escrow,"settle",json!({}),&org,signer.clone(),&n,0).await?;
    println!("Settled; checking all 200 allocations");
    let mut total = 0u128;
    for i in 0..200 {
        let reg = view(&escrow,"get_registration",json!({"registration_id":format!("capacity-reg-{i}")}),&n).await?;
        let amount = atomic(&reg,"claim_amount")?;
        ensure!(amount == if i < 100 { 4_000_000 } else { 0 }, "allocation {i}: {amount}");
        total = total.checked_add(amount).ok_or_else(|| anyhow::anyhow!("allocation overflow"))?;
        if (i+1)%25 == 0 { println!("Checked {} of 200 allocations",i+1); }
    }
    let event = view(&escrow,"get_event",json!({}),&n).await?;
    let storage = view(&escrow,"get_storage_state",json!({}),&n).await?;
    let balance = view(&ft,"ft_balance_of",json!({"account_id":eid}),&n).await?;
    ensure!(total == 400_000_000 && balance == "400000000" && event["phase"] == "Settled", "liability or escrow balance mismatch");
    ensure!(atomic(&storage,"account_balance_yocto")? >= atomic(&storage,"storage_cost_yocto")?, "child storage underfunded");
    std::fs::create_dir_all(&evidence_dir)?;
    let result = json!({"status":"PASS_LOCAL","scope":"synthetic Sandbox 2.14, factory-event leaf, mock Earn and mock USDC; no live-chain proof","clock":"synthetic event windows advanced using Sandbox blocks","factory_quote":q,"child_id":eid,"registrations":200,"passes":200,"attendees":100,"attendee_allocation_atomic":"4000000","no_show_allocation_atomic":"0","computed_claim_liability_atomic":total.to_string(),"escrow_ft_balance_atomic":balance,"event":event,"storage":storage,"graphs":{"first_deposit":first,"last_deposit":last,"supply":graph(&supply),"finalize":graph(&finalized),"redeem":graph(&redeemed),"settle":graph(&settled)}});
    std::fs::write(std::path::Path::new(&evidence_dir).join("factory-event-capacity.json"),serde_json::to_vec_pretty(&result)?)?;
    println!("PASS_LOCAL: 200 registrations, 400 USDC allocated; evidence saved");
    Ok(())
}
