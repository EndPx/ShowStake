//! LOCAL Sandbox only: deployed public Rhea Wasm + pinned linked escrow candidate.
//! Account bootstrapping is synthetic; no financial state is patched. The sandbox
//! escrow has a fixture key solely to unregister FT storage and induce failure.
use std::sync::Arc;
use base64::Engine;
use anyhow::{ensure,Result};
use near_api::{AccountId,Contract,NearGas,NearToken,NetworkConfig,Signer,Transaction};
use near_api::types::transaction::actions::{Action,TransferAction};
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
async fn call(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,deposit:u128)->Result<ExecutionFinalResult>{Ok(c.call_function(m,a).transaction().gas(NearGas::from_tgas(300)).deposit(NearToken::from_yoctonear(deposit)).with_signer(id.clone(),s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?)}
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
async fn graph(url:&str,f:&ExecutionFinalResult,signer:&AccountId)->Result<Value>{
 let tx=f.outcomes().first().ok_or_else(||anyhow::anyhow!("missing transaction outcome"))?.transaction_hash.to_string();
 let mut raw=raw_rpc(url,"EXPERIMENTAL_tx_status",json!([tx,signer])).await?;
 ensure!(raw["transaction"]["hash"]==tx&&raw["transaction"]["signer_id"]==signer.as_str()&&raw["receipts"].is_array()&&raw["receipts_outcome"].is_array(),"incomplete RPC action graph");
 strip_graph(&mut raw);Ok(raw)
}
fn save(dir:&str,name:&str,value:&Value)->Result<()>{let path=std::path::Path::new(dir);std::fs::create_dir_all(path)?;std::fs::write(path.join(name),serde_json::to_vec_pretty(value)?)?;Ok(())}
async fn capture_pre_tx(label:&str, id:&AccountId, rpc:&str)->Result<()> {
 eprintln!("STAGE {label}");
 if let Some(dir)=evidence_dir() {
  let account=raw_rpc(rpc,"query",json!({"request_type":"view_account","finality":"final","account_id":id})).await?;
  let keys=raw_rpc(rpc,"query",json!({"request_type":"view_access_key_list","finality":"final","account_id":id})).await?;
  let gas=raw_rpc(rpc,"gas_price",json!([null])).await?;
  save(&dir,&format!("pre-{label}.json"),&json!({"account":account,"public_access_keys":keys,"gas_price":gas}))?;
 }
 Ok(())
}
#[tokio::main] async fn main()->Result<()> {
 let old=std::fs::read(std::env::var("MULTI_WASM")?)?;
 let factory=std::fs::read(std::env::var("SHARED_WASM")?)?;
 let sb=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
 let n=NetworkConfig::from_rpc_url("sandbox",sb.rpc_addr.parse()?);
 if let Some(dir)=evidence_dir() {
  save(&dir,"sandbox-gas-price.json",&raw_rpc(&sb.rpc_addr,"gas_price",json!([null])).await?)?;
  save(&dir,"sandbox-protocol-config.json",&raw_rpc(&sb.rpc_addr,"EXPERIMENTAL_protocol_config",json!({"finality":"final"})).await?)?;
 }
 let signer=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 let empty:AccountId="showstake-mainnet-escrow-endpx-2026.near".parse()?;
 let nonempty:AccountId="nonempty.near".parse()?; let org:AccountId="host.near".parse()?;
 let topup=std::env::var("SHARED_MIGRATION_TOPUP").unwrap_or_else(|_|"600000000000000000000000".into()).parse::<u128>()?;
 ensure!(topup==500_000_000_000_000_000_000_000 || topup==600_000_000_000_000_000_000_000,"unsupported synthetic topup");
 let starting=2_296_370_729_841_206_400_000_000u128.checked_add(topup).ok_or_else(||anyhow::anyhow!("starting balance overflow"))?;
 for id in [&empty,&nonempty,&org] { sb.create_account(id.as_str().parse()?).initial_balance(if id==&empty {NearToken::from_yoctonear(starting)} else {NearToken::from_near(30)}).send().await?; }
 for id in [&empty,&nonempty] {
  // Fixture bootstrap uses the 10 Tgas initialization budget already exercised
  // by multi_create_smoke, avoiding a misleading 300 Tgas advance reservation.
  capture_pre_tx(if id==&empty {"old-empty-bootstrap"} else {"old-nonempty-bootstrap"},id,&sb.rpc_addr).await?;
  let init=json!({"canonical_ft":TOKEN,"provider_account":PROVIDER,"provider_kind":"RHEA_MAINNET","network":"mainnet","token_symbol":"USDC","token_name":"USDC","token_decimals":6});
  let boot=Contract::deploy(id.clone()).use_code(old.clone()).with_init_call("new",init)?.gas(NearGas::from_tgas(10)).with_signer(signer.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal old deploy"))?;
  if let Some(dir)=evidence_dir() { save(&dir,&format!("old-deploy-{id}-graph.json"),&graph(&sb.rpc_addr,&boot,id).await?)?; save(&dir,&format!("old-deploy-{id}-account.json"),&json!(near_api::Account(id.clone()).view().fetch_from(&n).await?.data))?; }
  ensure!(boot.is_success()&&boot.receipt_failures().is_empty(),"old deploy failed for {id}: {:?}",boot.receipt_failures());
  let c=Contract(id.clone());let cfg=view(&c,"get_config",json!({}),&n).await?;ensure!(cfg["policy_version"]=="showstake-native-usdc-multievent/1","wrong old policy");
 }
 let non=Contract(nonempty.clone());let now=view(&non,"get_block_timestamp_ms",json!({}),&n).await?.as_u64().unwrap();
 let close=now+600_000;let end=close+300_000;
 let rules=json!({"event_id":"must-survive","title":"Test","location":"Sandbox","rules_text":"Test","finalize_deadline":end+86400000u64,"deposit":"2000000","capacity":1,"reg_open":now,"reg_close":close,"checkin_open":close,"checkin_close":end});
 let quote=view(&non,"quote_create_event",json!({"rules":rules,"organizer":org}),&n).await?;
 capture_pre_tx("nonempty-create",&org,&sb.rpc_addr).await?;
 must(&non,"create_event",json!({"rules":rules}),&org,signer.clone(),&n,quote.as_str().ok_or_else(||anyhow::anyhow!("bad quote"))?.parse()?).await?;
 // Fixture-only compensation: C81 bootstrap burns gas in this Sandbox, while
 // the observed mainnet starting balance already reflects that historical cost.
 // Set the pre-upgrade balance to the requested observed baseline plus topup.
 let bootstrap_account=near_api::Account(empty.clone()).view().fetch_from(&n).await?;
 let bootstrap_json=json!(bootstrap_account.data);
 let bootstrap_amount=bootstrap_json["amount"].as_str().ok_or_else(||anyhow::anyhow!("missing bootstrap balance"))?.parse::<u128>()?;
 let fixture_compensation=starting.checked_sub(bootstrap_amount).ok_or_else(||anyhow::anyhow!("bootstrap balance exceeds target"))?;
 if fixture_compensation>0 {
  let compensated=Transaction::construct(org.clone(),empty.clone()).add_action(Action::Transfer(TransferAction{deposit:NearToken::from_yoctonear(fixture_compensation)})).with_signer(signer.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal fixture compensation"))?;
  ensure!(compensated.is_success()&&compensated.receipt_failures().is_empty(),"fixture compensation failed");
 }
 let before_empty=near_api::Account(empty.clone()).view().fetch_from(&n).await?;
 ensure!(json!(before_empty.data)["amount"]==starting.to_string(),"pre-upgrade balance differs from baseline plus topup");
 let before_non=near_api::Account(nonempty.clone()).view().fetch_from(&n).await?;
 capture_pre_tx("empty-upgrade",&empty,&sb.rpc_addr).await?;
 let result=Contract::deploy(empty.clone()).use_code(factory.clone()).with_init_call("migrate_empty_create",json!({}))?.gas(NearGas::from_tgas(10)).with_signer(signer.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?;
 if let Some(dir)=evidence_dir() { save(&dir,"empty-upgrade-attempt-graph.json",&graph(&sb.rpc_addr,&result,&empty).await?)?; save(&dir,"empty-upgrade-attempt-account.json",&json!(near_api::Account(empty.clone()).view().fetch_from(&n).await?.data))?; }
 ensure!(result.is_success()&&result.receipt_failures().is_empty(),"empty migration failed: {:?}",result.receipt_failures());
 let ec=Contract(empty.clone());let config=view(&ec,"get_config",json!({}),&n).await?;
 ensure!(config["schema_version"]==2&&config["policy_version"]=="showstake-native-usdc-shared-yield/2"&&config["provider_enabled"]==true,"wrong migrated config");
 ensure!(view(&ec,"list_events",json!({"from_index":0,"limit":20}),&n).await?==json!([]),"unexpected children");
 capture_pre_tx("nonempty-upgrade",&nonempty,&sb.rpc_addr).await?;
 let rejected=Contract::deploy(nonempty.clone()).use_code(factory).with_init_call("migrate_empty_create",json!({}))?.gas(NearGas::from_tgas(10)).with_signer(signer.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?;
 ensure!(rejected.is_failure()||!rejected.receipt_failures().is_empty(),"nonempty migration accepted");
 let retained=view(&non,"get_event",json!({"event_id":"must-survive"}),&n).await?;ensure!(retained["event_id"]=="must-survive","nonempty event not retained");
 let after_empty=near_api::Account(empty.clone()).view().fetch_from(&n).await?;
 let after_non=near_api::Account(nonempty.clone()).view().fetch_from(&n).await?;
 if let Some(dir)=evidence_dir() {
  save(&dir,"empty-upgrade-graph.json",&graph(&sb.rpc_addr,&result,&empty).await?)?;
  save(&dir,"nonempty-upgrade-graph.json",&graph(&sb.rpc_addr,&rejected,&nonempty).await?)?;
  save(&dir,"migration-state.json",&json!({"synthetic_baseline_yocto":"2296370729841206400000000","synthetic_extra_funding_yocto":topup.to_string(),"fixture_bootstrap_compensation_yocto":fixture_compensation.to_string(),"pre_upgrade_target_yocto":starting.to_string(),"attached_gas_tgas":10,"gas_burnt":result.total_gas_burnt.as_gas(),"before_empty":before_empty.data,"after_empty":after_empty.data,"before_nonempty":before_non.data,"after_nonempty":after_non.data,"config":config,"retained_event":retained}))?;
 }
 println!("{}",json!({"status":"PASS_LOCAL","scope":"actual old C81 Wasm root migrated into shared-yield in local Sandbox with synthetic pre-funding; nonempty upgrade rejected","empty":"migrated","nonempty":"rejected","schema":2,"synthetic_extra_funding_yocto":topup.to_string(),"initial_account_yocto":starting.to_string(),"attached_gas_tgas":10,"gas_burnt":result.total_gas_burnt.as_gas()}));Ok(())
}
