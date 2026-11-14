//! LOCAL Sandbox only: public Rhea Wasm and freshly pinned factory/leaf candidates.
//! Financial state is not patched. A fixture recipient unregisters FT storage to
//! induce a payout failure; factory-created children remain keyless.
use std::sync::{Arc, OnceLock, atomic::{AtomicUsize, Ordering}};
static SANDBOX_RPC: OnceLock<String> = OnceLock::new();
static EVIDENCE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);
use base64::Engine;
use anyhow::{ensure,Result};
use near_api::{AccountId,Contract,NearGas,NearToken,NetworkConfig,Signer};
use near_api::types::transaction::result::{ExecutionFinalResult,ValueOrReceiptId};
use serde_json::{json,Value};
fn evidence_dir() -> Option<&'static str> {
    static DIR: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| std::env::var("EVIDENCE_DIR").ok().map(|base| {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock before epoch").as_nanos();
        let path = std::path::Path::new(&base).join(format!("factory-event-{}-{nanos}", std::process::id()));
        eprintln!("Sandbox evidence directory: {}", path.display());
        path.to_string_lossy().into_owned()
    })).as_deref()
}
const TOKEN:&str="17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const PROVIDER:&str="contract.main.burrow.near";
async fn view(c:&Contract,m:&str,a:Value,n:&NetworkConfig)->Result<Value>{let v:near_api::types::Data<Value>=c.call_function(m,a).read_only().fetch_from(n).await?;Ok(v.data)}
async fn call(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,deposit:u128)->Result<ExecutionFinalResult>{
 let f=c.call_function(m,a).transaction().gas(NearGas::from_tgas(300)).deposit(NearToken::from_yoctonear(deposit)).with_signer(id.clone(),s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?;
 if let Some(dir)=evidence_dir() {
  let sequence=EVIDENCE_SEQUENCE.fetch_add(1,Ordering::SeqCst);
  let rpc=SANDBOX_RPC.get().ok_or_else(||anyhow::anyhow!("sandbox RPC unavailable"))?;
  let raw=graph(rpc,&f,id).await?;
  save(&dir,&format!("{sequence:04}-{m}-graph.json"),&raw)?;
  save(&dir,&format!("{sequence:04}-{m}-summary.json"),&json!({"method":m,"signer":id,"contract":c.0,"deposit":deposit.to_string(),"success":f.is_success(),"receipts":receipts(&f)}))?;
 }
 Ok(f)
}
async fn must(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,deposit:u128)->Result<ExecutionFinalResult>{let f=call(c,m,a,id,s,n,deposit).await?;ensure!(f.is_success()&&f.receipt_failures().is_empty(),"{} failed: {:?}",m,f.receipt_failures());Ok(f)}
async fn deploy(id:AccountId,code:Vec<u8>,args:Value,s:Arc<Signer>,n:&NetworkConfig)->Result<()> {let f=Contract::deploy(id).use_code(code).with_init_call("new",args)?.gas(NearGas::from_tgas(300)).with_signer(s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?;ensure!(f.is_success(),"deploy/init failed: {:?}",f.receipt_failures());Ok(())}
fn receipts(f:&ExecutionFinalResult)->Vec<Value>{f.receipt_outcomes().iter().map(|o|{let boolean=match o.clone().into_result(){Ok(ValueOrReceiptId::Value(v))=>v.json::<bool>().ok(),_=>None};json!({"id":o.transaction_hash.to_string(),"executor":o.executor_id.to_string(),"success":o.is_success(),"failure":o.is_failure(),"bool":boolean,"gas_burnt":o.gas_burnt.as_gas(),"children":o.receipt_ids.iter().map(ToString::to_string).collect::<Vec<_>>()})}).collect()}
fn provider_bool(f:&ExecutionFinalResult,v:bool)->bool{f.receipt_outcomes().iter().filter(|o|o.executor_id.as_str()==PROVIDER).any(|o|match o.clone().into_result(){Ok(ValueOrReceiptId::Value(x))=>x.json::<bool>().ok()==Some(v),_=>false})}
async fn bal(ft:&Contract,id:&AccountId,n:&NetworkConfig)->Result<u128>{Ok(view(ft,"ft_balance_of",json!({"account_id":id}),n).await?.as_str().ok_or_else(||anyhow::anyhow!("invalid balance"))?.parse()?)}
async fn advance(sb:&near_sandbox::Sandbox,c:&Contract,n:&NetworkConfig,target:u64)->Result<()> {for _ in 0..12{let now=view(c,"get_block_timestamp_ms",json!({}),n).await?.as_u64().ok_or_else(||anyhow::anyhow!("invalid clock"))?;if now>=target{return Ok(());}sb.fast_forward((((target-now)/300)+50).min(500)).await?;}anyhow::bail!("sandbox time not reached")}
// All raw RPC calls are confined to the Sandbox listener. Captured transaction
// signatures and gas profile metadata are stripped; receipt actions remain intact.
async fn raw_rpc(url:&str,method:&str,params:Value)->Result<Value>{
 ensure!(url.starts_with("http://127.0.0.1:")||url.starts_with("http://localhost:"),"refusing non-loopback RPC");
 let body=reqwest::Client::new().post(url).json(&json!({"jsonrpc":"2.0","id":"sandbox-proof","method":method,"params":params})).send().await?.error_for_status()?.json::<Value>().await?;
 ensure!(body.get("error").is_none(),"sandbox RPC {method} error: {}",body["error"]);Ok(body["result"].clone())
}
fn strip_graph(v:&mut Value){
 if let Some(tx)=v.get_mut("transaction").and_then(Value::as_object_mut){tx.remove("signature");}
 if let Some(out)=v.get_mut("transaction_outcome").and_then(|x|x.get_mut("outcome")).and_then(Value::as_object_mut){if let Some(m)=out.get_mut("metadata").and_then(Value::as_object_mut){m.remove("gas_profile");}}
 if let Some(rows)=v.get_mut("receipts_outcome").and_then(Value::as_array_mut){for row in rows {if let Some(o)=row.get_mut("outcome").and_then(Value::as_object_mut){if let Some(m)=o.get_mut("metadata").and_then(Value::as_object_mut){m.remove("gas_profile");}}}}
}
async fn snapshot(url:&str,escrow:&AccountId,token:&AccountId,provider:&AccountId)->Result<Value>{
 let block=raw_rpc(url,"block",json!({"finality":"final"})).await?;let h=block["header"]["hash"].as_str().ok_or_else(||anyhow::anyhow!("missing block hash"))?;let height=block["header"]["height"].as_u64().ok_or_else(||anyhow::anyhow!("missing block height"))?;
 let mut values=serde_json::Map::new();
 for (label,account,method,args) in [("event",escrow,"get_event",json!({})),("control",escrow,"get_rhea_control",json!({})),("position",provider,"get_account",json!({"account_id":escrow})),("escrow_ft",token,"ft_balance_of",json!({"account_id":escrow})),("provider_ft",token,"ft_balance_of",json!({"account_id":provider}))]{
  let encoded=base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&args)?);
  let r=raw_rpc(url,"query",json!({"request_type":"call_function","block_id":h,"account_id":account,"method_name":method,"args_base64":encoded})).await?;
  ensure!(r["block_hash"]==h&&r["block_height"]==height,"snapshot block mismatch");let bytes=r["result"].as_array().ok_or_else(||anyhow::anyhow!("missing view bytes"))?.iter().map(|x|x.as_u64().and_then(|v|u8::try_from(v).ok()).ok_or_else(||anyhow::anyhow!("invalid view bytes"))).collect::<Result<Vec<_>>>()?;values.insert(label.into(),serde_json::from_slice(&bytes)?);
 }
 Ok(json!({"block_hash":h,"block_height":height,"views":values}))
}
async fn capture_snapshot(label:&str,escrow:&AccountId,token:&AccountId,provider:&AccountId)->Result<()> {
 if let Some(dir)=evidence_dir() {
  let rpc=SANDBOX_RPC.get().ok_or_else(||anyhow::anyhow!("sandbox RPC unavailable"))?;
  save(&dir,&format!("snapshot-{label}.json"),&snapshot(rpc,escrow,token,provider).await?)?;
 }
 Ok(())
}
async fn graph(url:&str,f:&ExecutionFinalResult,signer:&AccountId)->Result<Value>{
 let tx=f.outcomes().first().ok_or_else(||anyhow::anyhow!("missing transaction outcome"))?.transaction_hash.to_string();
 let mut raw=raw_rpc(url,"EXPERIMENTAL_tx_status",json!([tx,signer])).await?;
 ensure!(raw["transaction"]["hash"]==tx&&raw["transaction"]["signer_id"]==signer.as_str()&&raw["receipts"].is_array()&&raw["receipts_outcome"].is_array(),"incomplete RPC action graph");
 strip_graph(&mut raw);Ok(raw)
}
fn save(dir:&str,name:&str,value:&Value)->Result<()>{let path=std::path::Path::new(dir);std::fs::create_dir_all(path)?;std::fs::write(path.join(name),serde_json::to_vec_pretty(value)?)?;Ok(())}
#[tokio::main] async fn main() -> Result<()> {
 let provider_code=std::fs::read(std::env::var("RHEA_WASM")?)?;
 let ft_code=std::fs::read(std::env::var("FT_WASM")?)?;
 let leaf=std::fs::read(std::env::var("LINKED_WASM")?)?;
 let factory_code=std::fs::read(std::env::var("FACTORY_WASM")?)?;
 let code=base64::engine::general_purpose::STANDARD.encode(&leaf);
 let sb=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
 SANDBOX_RPC.set(sb.rpc_addr.clone()).map_err(|_|anyhow::anyhow!("RPC initialized twice"))?;
 let n=NetworkConfig::from_rpc_url("sandbox",sb.rpc_addr.parse()?);
 let s=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 let owner:AccountId="owner.testnet".parse()?; let fid:AccountId="factory.sandbox".parse()?;
 let pid:AccountId=PROVIDER.parse()?; let tid:AccountId=TOKEN.parse()?;
 let orgs:Vec<AccountId>=vec!["first.sandbox".parse()?,"second.sandbox".parse()?];
 let users:Vec<AccountId>=(0..10).map(|i|format!("user{i}.testnet").parse().unwrap()).collect();
 for id in [&owner,&fid,&pid,&tid].into_iter().chain(orgs.iter()).chain(users.iter()) {
  sb.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(80)).send().await?;
 }
 deploy(tid.clone(),ft_code,json!({"owner_id":owner,"total_supply":"22000000","metadata":{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"USDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}}),s.clone(),&n).await?;
 let config=json!({"oracle_account_id":"oracle.testnet","pyth_oracle_account_id":"pyth.testnet","ref_exchange_id":"ref.testnet","owner_id":owner,"booster_token_id":"boost.testnet","booster_decimals":18,"max_num_assets":20,"maximum_recency_duration_sec":90,"maximum_staleness_duration_sec":90,"lp_tokens_info_valid_duration_sec":600,"pyth_price_valid_duration_sec":60,"minimum_staking_duration_sec":2592000,"maximum_staking_duration_sec":7776000,"x_booster_multiplier_at_maximum_staking_duration":30000,"force_closing_enabled":true,"enable_price_oracle":false,"enable_pyth_oracle":true,"contract_mode":"Running","boost_suppress_factor":1000,"dcl_id":"dcl.testnet","pause_operator_id":null});
 deploy(pid.clone(),provider_code,json!({"config":config}),s.clone(),&n).await?;
 deploy(fid.clone(),factory_code,json!({"canonical_ft":tid,"network":"mainnet","policy_version":"showstake-native-usdc-factory-rhea/3","provider_account":pid,"provider_kind":"RHEA_MAINNET"}),s.clone(),&n).await?;
 let ft=Contract(tid.clone()); let rhea=Contract(pid.clone()); let factory=Contract(fid.clone());
 let ac=json!({"reserve_ratio":2500,"beneficiaries":{},"target_utilization":8000,"target_utilization_rate":"1000000000001847694955734069","max_utilization_rate":"1000000000012857214234867166","holding_position_fee_rate":"1000000000000000000000000000","volatility_ratio":9500,"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":false,"can_borrow":false,"net_tvl_multiplier":10000,"max_change_rate":null,"supplied_limit":"1000000000000000000000000","borrowed_limit":"0","min_borrowed_amount":"1"});
 must(&rhea,"add_asset",json!({"token_id":tid,"asset_config":ac}),&owner,s.clone(),&n,1).await?;
 for id in [&pid].into_iter().chain(users.iter()) { must(&ft,"storage_deposit",json!({"account_id":id}),&owner,s.clone(),&n,10_000_000_000_000_000_000_000).await?; }
 let now=view(&factory,"get_native_accounting",json!({}),&n).await?; let _=now;
 // Use chain time from a JSON-RPC block, not host wall clock.
 let block=raw_rpc(&sb.rpc_addr,"block",json!({"finality":"final"})).await?;
 let start=block["header"]["timestamp_nanosec"].as_str().ok_or_else(||anyhow::anyhow!("missing timestamp"))?.parse::<u64>()?/1_000_000;
 let close=start+300_000; let end=close+300_000;
 let mut ids=Vec::new(); let mut escrows=Vec::new();
 for (i,org) in orgs.iter().enumerate() {
  let rules=json!({"event_id":format!("event{i}"),"title":"Test","location":"Sandbox","rules_text":"Candidate","finalize_deadline":end+86400000u64,"deposit":"2000000","capacity":5,"reg_open":start,"reg_close":close,"checkin_open":close,"checkin_close":end});
  let q=view(&factory,"quote_provision_event",json!({"organizer":org,"request_nonce":1,"rules":rules}),&n).await?;
  let amount=q["total"].as_str().ok_or_else(||anyhow::anyhow!("quote total"))?.parse::<u128>()?;
  must(&factory,"provision_event",json!({"request_nonce":1,"rules":rules,"code":code}),org,s.clone(),&n,amount).await?;
  let request=view(&factory,"get_request",json!({"organizer":org,"request_nonce":1}),&n).await?;
  ensure!(request["state"]=="Ready","factory request not ready: {request}");
  let eid:AccountId=request["child_id"].as_str().unwrap().parse()?; let escrow=Contract(eid.clone());
  let e=view(&escrow,"get_event",json!({}),&n).await?;ensure!(e["organizer"]==org.as_str()&&e["event_id"]==format!("event{i}"),"wrong initialized event");
  let storage=view(&escrow,"get_storage_state",json!({}),&n).await?;
  ensure!(storage["storage_cost_yocto"].as_str().unwrap().parse::<u128>()? <= storage["account_balance_yocto"].as_str().unwrap().parse::<u128>()?,"underfunded child");
  must(&escrow,"rhea_storage_deposit",json!({"target":"ft"}),org,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
  must(&escrow,"rhea_storage_deposit",json!({"target":"provider"}),org,s.clone(),&n,100_000_000_000_000_000_000_000).await?;
  ids.push(eid); escrows.push(escrow);
 }
 for (i,u) in users.iter().enumerate() {
  must(&ft,"ft_transfer",json!({"receiver_id":u,"amount":"2000000"}),&owner,s.clone(),&n,1).await?;
  let which=i/5; let event_id=format!("event{which}");
  let msg=json!({"version":1,"event_id":event_id,"commitment_id":format!("c{i}")}).to_string();
  let tx=must(&ft,"ft_transfer_call",json!({"receiver_id":ids[which],"amount":"2000000","msg":msg}),u,s.clone(),&n,1).await?;
  ensure!(tx.json::<String>()?=="2000000","commit refunded");
  let rid=format!("event{which}-reg-{}",i%5); let reg=view(&escrows[which],"get_registration",json!({"registration_id":rid}),&n).await?;
  ensure!(reg["participant"]==u.as_str(),"registration missing");
  let pass=view(&escrows[which],"get_pass",json!({"pass_id":reg["pass_id"]}),&n).await?; ensure!(pass["owner"]==u.as_str(),"pass missing");
 }
 // Invalid amount, duplicate commitment and noncanonical caller are rejected without a seat.
 must(&ft,"ft_transfer",json!({"receiver_id":users[0],"amount":"2000000"}),&owner,s.clone(),&n,1).await?;
 for (amount,commitment) in [("1000000","new"),("2000000","c0")] {
  let msg=json!({"version":1,"event_id":"event0","commitment_id":commitment}).to_string();
  let rejected=must(&ft,"ft_transfer_call",json!({"receiver_id":ids[0],"amount":amount,"msg":msg}),&users[0],s.clone(),&n,1).await?;
  ensure!(rejected.json::<String>()?=="0","invalid transfer accepted");
 }
 let wrong=must(&escrows[0],"ft_on_transfer",json!({"sender_id":users[0],"amount":"2000000","msg":"{}"}),&owner,s.clone(),&n,0).await?;
 ensure!(wrong.json::<String>()?=="2000000","wrong token accepted");
 ensure!(view(&escrows[0],"get_event",json!({}),&n).await?["total_registrations"]==5,"invalid registration changed count");
 advance(&sb,&escrows[0],&n,close).await?;
 for i in 0..2 { capture_snapshot(&format!("{i}-before-supply"),&ids[i],&tid,&pid).await?; must(&escrows[i],"close_registration",json!({}),&orgs[i],s.clone(),&n,0).await?; must(&escrows[i],"trigger_earn_supply",json!({}),&orgs[i],s.clone(),&n,0).await?; ensure!(view(&escrows[i],"get_event",json!({}),&n).await?["earn_state"]=="Supplied","supply not reconciled"); capture_snapshot(&format!("{i}-after-supply"),&ids[i],&tid,&pid).await?; }
 let b_before=view(&rhea,"get_account",json!({"account_id":ids[1]}),&n).await?;
 for i in [1,3] { must(&escrows[0],"mark_attendance",json!({"registration_id":format!("event0-reg-{i}"),"attended":true}),&orgs[0],s.clone(),&n,0).await?; }
 must(&escrows[1],"cancel_event",json!({"event_id":"event1"}),&orgs[1],s.clone(),&n,0).await?;
 advance(&sb,&escrows[0],&n,end).await?;
 must(&escrows[0],"finalize_attendance",json!({}),&orgs[0],s.clone(),&n,0).await?;
 capture_snapshot("0-before-redeem",&ids[0],&tid,&pid).await?;
 must(&escrows[0],"trigger_earn_redeem",json!({}),&users[0],s.clone(),&n,0).await?;
 ensure!(view(&escrows[0],"get_event",json!({}),&n).await?["earn_state"]=="Redeemed","first redemption incomplete");
 capture_snapshot("0-after-redeem",&ids[0],&tid,&pid).await?;
 let b_after=view(&rhea,"get_account",json!({"account_id":ids[1]}),&n).await?;
 ensure!(b_before["supplied"]==b_after["supplied"],"first event spent second event position");
 must(&escrows[0],"settle",json!({}),&orgs[0],s.clone(),&n,0).await?;
 for i in [1,3] { let r=view(&escrows[0],"get_registration",json!({"registration_id":format!("event0-reg-{i}")}),&n).await?; ensure!(r["claim_amount"]=="5000000","incorrect settlement"); }
 if let Some(dir)=evidence_dir() { save(&dir,"balances-before-claims.json",&json!({"attendee1":bal(&ft,&users[1],&n).await?.to_string(),"attendee3":bal(&ft,&users[3],&n).await?.to_string(),"escrow0":bal(&ft,&ids[0],&n).await?.to_string(),"escrow1":bal(&ft,&ids[1],&n).await?.to_string(),"provider":bal(&ft,&pid,&n).await?.to_string()}))?; }
 must(&ft,"storage_unregister",json!({"force":false}),&users[1],s.clone(),&n,1).await?;
 let failed=call(&escrows[0],"claim",json!({"registration_id":"event0-reg-1"}),&users[1],s.clone(),&n,1).await?;
 ensure!(!failed.receipt_failures().is_empty(),"expected FT payout failure");
 ensure!(view(&escrows[0],"get_registration",json!({"registration_id":"event0-reg-1"}),&n).await?["claim"]=="Claimable","failed payout not restored");
 must(&ft,"storage_deposit",json!({"account_id":users[1]}),&owner,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
 for i in [1,3] { must(&escrows[0],"claim",json!({"registration_id":format!("event0-reg-{i}")}),&users[i],s.clone(),&n,1).await?; ensure!(bal(&ft,&users[i],&n).await?==5_000_000,"claim amount"); }
 capture_snapshot("1-before-redeem",&ids[1],&tid,&pid).await?;
 must(&escrows[1],"trigger_earn_redeem",json!({}),&orgs[1],s.clone(),&n,0).await?;
 ensure!(view(&escrows[1],"get_event",json!({}),&n).await?["earn_state"]=="Redeemed","cancel redemption incomplete");
 capture_snapshot("1-after-redeem",&ids[1],&tid,&pid).await?;
 for i in 0..5 { must(&escrows[1],"claim",json!({"registration_id":format!("event1-reg-{i}")}),&users[i+5],s.clone(),&n,1).await?; ensure!(bal(&ft,&users[i+5],&n).await?==2_000_000,"refund amount"); }
 ensure!(bal(&ft,&pid,&n).await?==0&&bal(&ft,&ids[0],&n).await?==0&&bal(&ft,&ids[1],&n).await?==0,"conservation failure");
 if let Some(dir)=evidence_dir() { save(&dir,"balances-after-claims.json",&json!({"attendee1":bal(&ft,&users[1],&n).await?.to_string(),"attendee3":bal(&ft,&users[3],&n).await?.to_string(),"refunds":[bal(&ft,&users[5],&n).await?.to_string(),bal(&ft,&users[6],&n).await?.to_string(),bal(&ft,&users[7],&n).await?.to_string(),bal(&ft,&users[8],&n).await?.to_string(),bal(&ft,&users[9],&n).await?.to_string()],"escrow0":bal(&ft,&ids[0],&n).await?.to_string(),"escrow1":bal(&ft,&ids[1],&n).await?.to_string(),"provider":bal(&ft,&pid,&n).await?.to_string()}))?; }
 println!("{}",json!({"status":"PASS_LOCAL","scope":"factory children and actual public Rhea Wasm in synthetic Sandbox; mock USDC","children":ids,"concurrent_position_unchanged":true,"attendee_payouts":["5000000","5000000"],"cancel_refunds":"5 x 2000000","failed_claim_restored_and_retried":true})); Ok(())
}
