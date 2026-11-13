//! LOCAL Sandbox only: deployed public Rhea Wasm + pinned linked escrow candidate.
//! Account bootstrapping is synthetic; no financial state is patched. The sandbox
//! escrow has a fixture key solely to unregister FT storage and induce failure.
use std::sync::Arc;
use base64::Engine;
use anyhow::{ensure,Result};
use near_api::{AccountId,Contract,NearGas,NearToken,NetworkConfig,Signer};
use near_api::types::transaction::result::{ExecutionFinalResult,ValueOrReceiptId};
use serde_json::{json,Value};
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
#[tokio::main] async fn main()->Result<()> {
 let provider_code=std::fs::read(std::env::var("RHEA_WASM")?)?;let ft_code=std::fs::read(std::env::var("FT_WASM")?)?;let leaf=std::fs::read(std::env::var("LINKED_WASM")?)?;
 let sb=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;let n=NetworkConfig::from_rpc_url("sandbox",sb.rpc_addr.parse()?);let s=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 let owner:AccountId="owner.testnet".parse()?;let org:AccountId="organizer.near".parse()?;let eid:AccountId="event.near".parse()?;let pid:AccountId=PROVIDER.parse()?;let tid:AccountId=TOKEN.parse()?;
 let users:Vec<AccountId>=(0..5).map(|i|format!("user{i}.testnet").parse().unwrap()).collect();for id in [&owner,&org,&eid,&pid,&tid].into_iter().chain(users.iter()){sb.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(80)).send().await?;}
 deploy(tid.clone(),ft_code,json!({"owner_id":owner,"total_supply":"10000000","metadata":{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"USDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}}),s.clone(),&n).await?;
 let config=json!({"oracle_account_id":"oracle.testnet","pyth_oracle_account_id":"pyth.testnet","ref_exchange_id":"ref.testnet","owner_id":owner,"booster_token_id":"boost.testnet","booster_decimals":18,"max_num_assets":20,"maximum_recency_duration_sec":90,"maximum_staleness_duration_sec":90,"lp_tokens_info_valid_duration_sec":600,"pyth_price_valid_duration_sec":60,"minimum_staking_duration_sec":2592000,"maximum_staking_duration_sec":7776000,"x_booster_multiplier_at_maximum_staking_duration":30000,"force_closing_enabled":true,"enable_price_oracle":false,"enable_pyth_oracle":true,"contract_mode":"Running","boost_suppress_factor":1000,"dcl_id":"dcl.testnet","pause_operator_id":null});
 deploy(pid.clone(),provider_code,json!({"config":config}),s.clone(),&n).await?;
 deploy(eid.clone(),leaf,json!({"organizer":org,"provider_account":pid,"canonical_ft":tid,"token_symbol":"USDC","token_name":"Mock USDC","token_decimals":6,"provider_kind":"RHEA_MAINNET"}),s.clone(),&n).await?;
 let ft=Contract(tid.clone());let rhea=Contract(pid.clone());let escrow=Contract(eid.clone());ensure!(view(&rhea,"get_version",json!({}),&n).await?=="0.16.2","wrong provider version");
 let cfg=view(&escrow,"get_config",json!({}),&n).await?;ensure!(cfg["policy_version"]=="showstake-native-usdc-rhea-linked-withdraw-review/2"&&cfg["provider_kind"]=="RHEA_MAINNET","wrong leaf config");
 let ac=json!({"reserve_ratio":2500,"beneficiaries":{},"target_utilization":8000,"target_utilization_rate":"1000000000001847694955734069","max_utilization_rate":"1000000000012857214234867166","holding_position_fee_rate":"1000000000000000000000000000","volatility_ratio":9500,"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":false,"can_borrow":false,"net_tvl_multiplier":10000,"max_change_rate":null,"supplied_limit":"1000000000000000000000000","borrowed_limit":"0","min_borrowed_amount":"1"});
 let _=must(&rhea,"add_asset",json!({"token_id":tid,"asset_config":ac}),&owner,s.clone(),&n,1).await?;
 for id in [&pid].into_iter().chain(users.iter()){let _=must(&ft,"storage_deposit",json!({"account_id":id}),&owner,s.clone(),&n,10_000_000_000_000_000_000_000).await?;}
 let _=must(&escrow,"rhea_storage_deposit",json!({"target":"ft"}),&org,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
 let _=must(&escrow,"rhea_storage_deposit",json!({"target":"provider"}),&org,s.clone(),&n,100_000_000_000_000_000_000_000).await?;
 for u in &users{let _=must(&ft,"ft_transfer",json!({"receiver_id":u,"amount":"2000000"}),&owner,s.clone(),&n,1).await?;}
 let _=must(&escrow,"configure_rhea_cap",json!({"principal_cap":"10000000"}),&org,s.clone(),&n,0).await?;let _=must(&escrow,"set_rhea_paused",json!({"paused":false}),&org,s.clone(),&n,0).await?;
 let now=view(&escrow,"get_block_timestamp_ms",json!({}),&n).await?.as_u64().unwrap();let close=now+60000;let end=close+300000;let event_id="e".repeat(128);
 let rules=json!({"event_id":event_id,"title":"t".repeat(256),"location":"l".repeat(512),"rules_text":"r".repeat(8192),"finalize_deadline":end+86400000u64,"deposit":"2000000","capacity":5,"reg_open":now,"reg_close":close,"checkin_open":close,"checkin_close":end});
 let _=must(&escrow,"create_event",json!({"rules":rules}),&org,s.clone(),&n,0).await?;
 let mut registrations=Vec::new();for (i,u) in users.iter().enumerate(){let commitment=format!("c{i:03}");let msg=json!({"version":1,"event_id":event_id,"commitment_id":commitment}).to_string();let d=must(&ft,"ft_transfer_call",json!({"receiver_id":eid,"amount":"2000000","msg":msg}),u,s.clone(),&n,1).await?;ensure!(d.clone().json::<String>()?=="2000000","deposit refunded");let rid=format!("{}-reg-{}",event_id,i);let reg=view(&escrow,"get_registration",json!({"registration_id":rid}),&n).await?;let pass=view(&escrow,"get_pass",json!({"pass_id":reg["pass_id"]}),&n).await?;ensure!(reg["participant"]==u.as_str()&&pass["owner"]==u.as_str(),"missing registration/pass");registrations.push(rid);}
 let event=view(&escrow,"get_event",json!({}),&n).await?;ensure!(event["accepted_principal"]=="10000000"&&bal(&ft,&eid,&n).await?==10000000,"deposit balance mismatch");advance(&sb,&escrow,&n,close).await?;
 let _=must(&escrow,"close_registration",json!({}),&org,s.clone(),&n,0).await?;
 let supply=call(&escrow,"trigger_earn_supply",json!({}),&org,s.clone(),&n,0).await?;let supply_state=view(&escrow,"get_event",json!({}),&n).await?;let supply_control=view(&escrow,"get_rhea_control",json!({}),&n).await?;let rhea_before=view(&rhea,"get_account",json!({"account_id":eid}),&n).await?;
 eprintln!("SUPPLY_RESULT {}",json!({"top_success":supply.is_success(),"gas":supply.total_gas_burnt.as_gas(),"receipts":receipts(&supply),"event":supply_state,"control":supply_control,"rhea":rhea_before}));
 ensure!(supply.is_success()&&supply.receipt_failures().is_empty()&&supply_state["earn_state"]=="Supplied"&&bal(&ft,&eid,&n).await?==0&&bal(&ft,&pid,&n).await?==10000000,"supply reconciliation failed");
 for i in [1,3] {let _=must(&escrow,"mark_attendance",json!({"registration_id":registrations[i],"attended":true}),&org,s.clone(),&n,0).await?;}advance(&sb,&escrow,&n,end).await?;let _=must(&escrow,"finalize_attendance",json!({}),&org,s.clone(),&n,0).await?;
 // LOCAL ONLY: synthetic escrow key unregisters its zero FT balance to force a receiver failure.
 let _=must(&ft,"storage_unregister",json!({"force":false}),&eid,s.clone(),&n,1).await?;
 let output=std::env::var("OUTPUT_DIR").ok();
 let failed_before=if output.is_some(){Some(snapshot(&sb.rpc_addr,&eid,&tid,&pid).await?)}else{None};
 let failed=call(&escrow,"trigger_earn_redeem",json!({}),&org,s.clone(),&n,0).await?;let after_fail=view(&escrow,"get_event",json!({}),&n).await?;let control_fail=view(&escrow,"get_rhea_control",json!({}),&n).await?;let rhea_fail=view(&rhea,"get_account",json!({"account_id":eid}),&n).await?;
 if let (Some(dir),Some(before))=(&output,&failed_before){let raw=graph(&sb.rpc_addr,&failed,&org).await?;let observed=snapshot(&sb.rpc_addr,&eid,&tid,&pid).await?;save(dir,"failed-graph.json",&raw)?;save(dir,"failed-manifest.json",&json!({"scope":"sandbox fixture","expected":{"organizer":org,"escrow":eid,"provider":pid,"token":tid,"method":"trigger_earn_redeem","deposit":"0","gas":"300000000000000","provider_bool":false},"before":before,"after":observed}))?;}
 eprintln!("REDEEM_FAILURE_RESULT {}",json!({"top_success":failed.is_success(),"gas":failed.total_gas_burnt.as_gas(),"receipts":receipts(&failed),"event":after_fail,"control":control_fail,"rhea":rhea_fail}));
 ensure!(provider_bool(&failed,false)&&failed.receipt_failures().iter().any(|o|o.executor_id==tid)&&after_fail["earn_state"]=="Supplied"&&after_fail["redeemed_amount"]=="0"&&bal(&ft,&pid,&n).await?==10000000&&rhea_before["supplied"]==rhea_fail["supplied"],"provider failure/restore not proven");
 let denied=call(&escrow,"claim",json!({"registration_id":registrations[1]}),&users[1],s.clone(),&n,1).await?;ensure!(denied.is_failure(),"claim opened before redeem");
 let _=must(&escrow,"rhea_storage_deposit",json!({"target":"ft"}),&org,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
 let success_before=if output.is_some(){Some(snapshot(&sb.rpc_addr,&eid,&tid,&pid).await?)}else{None};
 let redeem=call(&escrow,"trigger_earn_redeem",json!({}),&org,s.clone(),&n,0).await?;let after=view(&escrow,"get_event",json!({}),&n).await?;let rhea_after=view(&rhea,"get_account",json!({"account_id":eid}),&n).await?;
 if let (Some(dir),Some(before))=(&output,&success_before){let raw=graph(&sb.rpc_addr,&redeem,&org).await?;let observed=snapshot(&sb.rpc_addr,&eid,&tid,&pid).await?;save(dir,"success-graph.json",&raw)?;save(dir,"success-manifest.json",&json!({"scope":"sandbox fixture","expected":{"organizer":org,"escrow":eid,"provider":pid,"token":tid,"method":"trigger_earn_redeem","deposit":"0","gas":"300000000000000","provider_bool":true},"before":before,"after":observed}))?;}
 eprintln!("REDEEM_SUCCESS_RESULT {}",json!({"top_success":redeem.is_success(),"gas":redeem.total_gas_burnt.as_gas(),"receipts":receipts(&redeem),"event":after,"rhea":rhea_after}));
 ensure!(provider_bool(&redeem,true)&&redeem.is_success()&&redeem.receipt_failures().is_empty()&&after["earn_state"]=="Redeemed"&&after["redeemed_amount"]=="10000000"&&after["realized_yield"]=="0"&&bal(&ft,&eid,&n).await?==10000000&&bal(&ft,&pid,&n).await?==0&&rhea_after["supplied"].as_array().is_some_and(Vec::is_empty)&&rhea_after["borrowed"].as_array().is_some_and(Vec::is_empty)&&rhea_after["collateral"].as_array().is_some_and(Vec::is_empty),"linked redeem not proven");
 let settled=must(&escrow,"settle",json!({}),&org,s.clone(),&n,0).await?;let mut claims=Vec::new();for (i,rid) in registrations.iter().enumerate(){let r=view(&escrow,"get_registration",json!({"registration_id":rid}),&n).await?;ensure!(r["claim_amount"]==if [1,3].contains(&i){"5000000"}else{"0"},"payout mismatch {r}");claims.push(r);}
 let p1=must(&escrow,"claim",json!({"registration_id":registrations[1]}),&users[1],s.clone(),&n,1).await?;let p3=must(&escrow,"claim",json!({"registration_id":registrations[3]}),&users[3],s.clone(),&n,1).await?;
 ensure!(bal(&ft,&users[1],&n).await?==5000000&&bal(&ft,&users[3],&n).await?==5000000&&bal(&ft,&eid,&n).await?==0&&bal(&ft,&pid,&n).await?==0,"conservation failed");
 println!("{}",serde_json::to_string_pretty(&json!({"status":"PASS_LOCAL","scope":"Sandbox actual public Rhea Wasm with local clean state, pinned linked leaf, mock USDC; no financial state patch, no production proof","fixture_forced_failure":"Sandbox escrow bootstrap full-access key unregisters empty FT; production keyless child lacks this key","config":cfg,"registrations":registrations,"claims_before_payout":claims,"supply":{"gas":supply.total_gas_burnt.as_gas(),"receipts":receipts(&supply),"rhea_before_redeem":rhea_before},"failed_redeem":{"gas":failed.total_gas_burnt.as_gas(),"receipts":receipts(&failed),"rhea_after_failure":rhea_fail,"claim_denied":denied.is_failure()},"redeem":{"gas":redeem.total_gas_burnt.as_gas(),"receipts":receipts(&redeem),"rhea_after":rhea_after},"settle_gas":settled.total_gas_burnt.as_gas(),"claim1":receipts(&p1),"claim3":receipts(&p3),"beneficiary1":"5000000","beneficiary3":"5000000","final_escrow":"0","final_provider":"0","accepted_principal":"10000000"}))?);Ok(())
}
