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
        let path = std::path::Path::new(&base).join(format!("shared-event-{}-{nanos}", std::process::id()));
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
#[tokio::main]
async fn main() -> Result<()> {
 let mock=std::env::var("SHARED_PROVIDER").unwrap_or_else(|_|"rhea".into())=="mock";
 let wasm=std::fs::read(std::env::var("SHARED_WASM")?)?;
 let ft_code=std::fs::read(std::env::var("FT_WASM")?)?;
 let provider_code=std::fs::read(std::env::var(if mock{"MOCK_EARN_WASM"}else{"RHEA_WASM"})?)?;
 let sb=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
 SANDBOX_RPC.set(sb.rpc_addr.clone()).map_err(|_|anyhow::anyhow!("RPC already initialized"))?;
 let n=NetworkConfig::from_rpc_url("sandbox",sb.rpc_addr.parse()?);
 let s=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 let tid:AccountId=if mock{"usdc.testnet"}else{TOKEN}.parse()?;
 let pid:AccountId=if mock{"provider.testnet"}else{PROVIDER}.parse()?;
 let eid:AccountId=if mock{"shared.testnet"}else{"shared.sandbox"}.parse()?;
 let owner:AccountId="owner.testnet".parse()?;
 let orgs:Vec<AccountId>=vec!["first.testnet".parse()?,"second.testnet".parse()?];
 let users:Vec<AccountId>=(0..5).map(|i|format!("u{i}.testnet").parse().unwrap()).collect();
 for id in [&tid,&pid,&eid,&owner].into_iter().chain(orgs.iter()).chain(users.iter()) {sb.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(80)).send().await?;}
 deploy(tid.clone(),ft_code,json!({"owner_id":owner,"total_supply":"50000000","metadata":{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"USDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}}),s.clone(),&n).await?;
 if mock {
  deploy(pid.clone(),provider_code,json!({"token":tid,"controller":owner}),s.clone(),&n).await?;
 } else {
  let cfg=json!({"oracle_account_id":"oracle.testnet","pyth_oracle_account_id":"pyth.testnet","ref_exchange_id":"ref.testnet","owner_id":owner,"booster_token_id":"boost.testnet","booster_decimals":18,"max_num_assets":20,"maximum_recency_duration_sec":90,"maximum_staleness_duration_sec":90,"lp_tokens_info_valid_duration_sec":600,"pyth_price_valid_duration_sec":60,"minimum_staking_duration_sec":2592000,"maximum_staking_duration_sec":7776000,"x_booster_multiplier_at_maximum_staking_duration":30000,"force_closing_enabled":true,"enable_price_oracle":false,"enable_pyth_oracle":true,"contract_mode":"Running","boost_suppress_factor":1000,"dcl_id":"dcl.testnet","pause_operator_id":null});
  deploy(pid.clone(),provider_code,json!({"config":cfg}),s.clone(),&n).await?;
  let ac=json!({"reserve_ratio":2500,"beneficiaries":{},"target_utilization":8000,"target_utilization_rate":"1000000000001847694955734069","max_utilization_rate":"1000000000012857214234867166","holding_position_fee_rate":"1000000000000000000000000000","volatility_ratio":9500,"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":false,"can_borrow":false,"net_tvl_multiplier":10000,"max_change_rate":null,"supplied_limit":"1000000000000000000000000","borrowed_limit":"0","min_borrowed_amount":"1"});
  must(&Contract(pid.clone()),"add_asset",json!({"token_id":tid,"asset_config":ac}),&owner,s.clone(),&n,1).await?;
 }
 deploy(eid.clone(),wasm,json!({"canonical_ft":tid,"provider_account":pid,"provider_kind":if mock{"MOCK_TESTNET"}else{"RHEA_MAINNET"},"network":if mock{"testnet"}else{"mainnet"},"token_symbol":"USDC","token_name":"Mock USDC","token_decimals":6}),s.clone(),&n).await?;
 let ft=Contract(tid.clone());let esc=Contract(eid.clone());let provider=Contract(pid.clone());
 for id in [&pid,&eid].into_iter().chain(users.iter()) {must(&ft,"storage_deposit",json!({"account_id":id,"registration_only":true}),&owner,s.clone(),&n,10_000_000_000_000_000_000_000).await?;}
 if !mock {must(&provider,"storage_deposit",json!({"account_id":eid}),&owner,s.clone(),&n,100_000_000_000_000_000_000_000).await?;}
 let start=view(&esc,"get_block_timestamp_ms",json!({}),&n).await?.as_u64().ok_or_else(||anyhow::anyhow!("clock"))?;let close=start+90_000;let end=close+90_000;
 for (i,org) in orgs.iter().enumerate(){let event=if i==0{"a"}else{"b"};let rules=json!({"event_id":event,"title":"Shared event","location":"Sandbox","rules_text":"Same contract, independent event vault shares","deposit":"2000000","capacity":5,"reg_open":start,"reg_close":close,"checkin_open":close,"checkin_close":end,"finalize_deadline":end+86400000u64});let quote=view(&esc,"quote_create_event",json!({"rules":rules,"organizer":org}),&n).await?;let amount=quote.as_str().ok_or_else(||anyhow::anyhow!("quote"))?.parse()?;must(&esc,"create_event",json!({"rules":rules}),org,s.clone(),&n,amount).await?;}
 for user in &users {must(&ft,"ft_transfer",json!({"receiver_id":user,"amount":"4000000"}),&owner,s.clone(),&n,1).await?;}
 // Wrong amount resolves back to the participant without a seat.
 must(&ft,"ft_transfer_call",json!({"receiver_id":eid,"amount":"1","msg":json!({"version":1,"event_id":"a","commitment_id":"wrong"}).to_string()}),&users[0],s.clone(),&n,1).await?;
 ensure!(view(&esc,"get_event",json!({"event_id":"a"}),&n).await?["total_registrations"]==0,"wrong amount created registration");
 for event in ["a","b"] {for (i,user) in users.iter().enumerate(){must(&ft,"ft_transfer_call",json!({"receiver_id":eid,"amount":"2000000","msg":json!({"version":1,"event_id":event,"commitment_id":format!("{event}-{i}")}).to_string()}),user,s.clone(),&n,1).await?;}}
 let a=view(&esc,"list_event_registrations",json!({"event_id":"a","from":0,"limit":50}),&n).await?;
 let b=view(&esc,"list_event_registrations",json!({"event_id":"b","from":0,"limit":50}),&n).await?;
 ensure!(a.as_array().map(Vec::len)==Some(5)&&b.as_array().map(Vec::len)==Some(5),"ten registrations missing");
 for row in a.as_array().unwrap().iter().chain(b.as_array().unwrap()){let pass=view(&esc,"get_pass",json!({"pass_id":row["pass_id"]}),&n).await?;ensure!(pass["owner"]==row["participant"]&&pass["registration_id"]==row["registration_id"],"pass mismatch");}
 advance(&sb,&esc,&n,close).await?;
 for event in ["a","b"]{must(&esc,"close_registration",json!({"event_id":event}),&owner,s.clone(),&n,0).await?;let supply=call(&esc,"trigger_earn_supply",json!({"event_id":event}),&owner,s.clone(),&n,0).await?;ensure!(supply.is_success()&&supply.receipt_failures().is_empty(),"supply receipts failed {:?}",receipts(&supply));let ev=view(&esc,"get_event",json!({"event_id":event}),&n).await?;ensure!(ev["earn_state"]=="Supplied","supply did not reach Supplied: {ev}");}
 let both=view(&esc,"get_vault",json!({}),&n).await?;
 ensure!(both["provider_balance"]=="20000000"&&both["operation"].is_null(),"two concurrent positions not represented {both}");
 for i in [0,2]{must(&esc,"mark_attendance",json!({"registration_id":a[i]["registration_id"],"attended":true}),&orgs[0],s.clone(),&n,0).await?;}
 advance(&sb,&esc,&n,end).await?;
 must(&esc,"finalize_attendance",json!({"event_id":"a"}),&orgs[0],s.clone(),&n,0).await?;
 let redeem_a=call(&esc,"trigger_earn_redeem",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;
 ensure!(redeem_a.is_success()&&redeem_a.receipt_failures().is_empty(),"redeem A receipts {:?}",receipts(&redeem_a));
 let state_a=view(&esc,"get_event",json!({"event_id":"a"}),&n).await?;let state_b=view(&esc,"get_event",json!({"event_id":"b"}),&n).await?;let remaining=view(&esc,"get_vault",json!({}),&n).await?;
 ensure!(state_a["earn_state"]=="Redeemed"&&state_b["earn_state"]=="Supplied"&&remaining["provider_balance"]=="10000000","A consumed B rights {state_a} {state_b} {remaining}");
 must(&esc,"settle",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;
 for i in [0,2]{ensure!(view(&esc,"get_registration",json!({"registration_id":a[i]["registration_id"]}),&n).await?["claim_amount"]=="5000000","attendee allocation");must(&esc,"claim",json!({"registration_id":a[i]["registration_id"]}),&users[i],s.clone(),&n,1).await?;}
 must(&esc,"cancel_event",json!({"event_id":"b"}),&orgs[1],s.clone(),&n,0).await?;
 must(&esc,"trigger_earn_redeem",json!({"event_id":"b"}),&owner,s.clone(),&n,0).await?;
 ensure!(view(&esc,"get_event",json!({"event_id":"b"}),&n).await?["earn_state"]=="Redeemed","cancelled B redemption missing");
 must(&ft,"storage_unregister",json!({"force":false}),&users[1],s.clone(),&n,1).await?;
 let fail=call(&esc,"claim",json!({"registration_id":b[1]["registration_id"]}),&users[1],s.clone(),&n,1).await?;ensure!(!fail.receipt_failures().is_empty(),"controlled payout did not fail");
 let restored=view(&esc,"get_registration",json!({"registration_id":b[1]["registration_id"]}),&n).await?;ensure!(restored["claim"]=="Claimable"&&restored["claim_attempt"]==1,"payout not restored");
 must(&ft,"storage_deposit",json!({"account_id":users[1],"registration_only":true}),&owner,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
 for (i,user) in users.iter().enumerate(){must(&esc,"claim",json!({"registration_id":b[i]["registration_id"]}),user,s.clone(),&n,1).await?;}
 let balances=for_balances(&ft,&users,&n).await?;ensure!(balances==vec![7_000_000,2_000_000,7_000_000,2_000_000,2_000_000],"balance reconciliation {balances:?}");
 ensure!(bal(&ft,&eid,&n).await?==0,"escrow remainder");let accounting=view(&esc,"get_accounting",json!({}),&n).await?;ensure!(accounting["paid"]=="20000000"&&accounting["liability"]=="0"&&accounting["pending"]=="0"&&accounting["reserved_cash"]=="0","accounting {accounting}");
 let vault=view(&esc,"get_vault",json!({}),&n).await?;ensure!(vault["operation"].is_null()&&vault["total_shares"]=="0"&&vault["strategy_cash"]=="0"&&vault["provider_balance"]=="0","vault remainder {vault}");
 if let Some(dir)=evidence_dir(){save(dir,"result.json",&json!({"classification":"PASS_LOCAL","network":"Sandbox 2.14.0","provider":if mock{"MockEarn"}else{"actual public Rhea Wasm"},"escrow":eid,"events":["a","b"],"per_event_principal":"10000000","attendee_claims":["5000000","5000000"],"cancel_refunds":vec!["2000000";5],"balances":balances.iter().map(ToString::to_string).collect::<Vec<_>>(),"failed_claim_restored":true,"accounting":accounting,"vault":vault}))?;}
 println!("PASS_LOCAL shared event lifecycle: two simultaneous event positions, 5x2 -> 2x5, other event 5x2 refunds, callback failure/retry; {}",if mock{"MockEarn"}else{"public Rhea Wasm"});Ok(())
}
async fn for_balances(ft:&Contract,users:&[AccountId],n:&NetworkConfig)->Result<Vec<u128>>{let mut out=Vec::new();for u in users {out.push(bal(ft,u,n).await?);}Ok(out)}
