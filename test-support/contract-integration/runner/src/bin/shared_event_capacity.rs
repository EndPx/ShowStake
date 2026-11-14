//! Local Sandbox gas proof. 199/200 registrations in event A and all 200 in B
//! are synthetic calls from the FT account, backed by separately transferred FT.
use anyhow::{ensure, Result};
use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer, Transaction};
use near_api::types::transaction::actions::{Action, FunctionCallAction};
use near_api::types::transaction::result::ExecutionFinalResult;
use serde_json::{json, Value};
use std::sync::Arc;

async fn view(c:&Contract,m:&str,a:Value,n:&NetworkConfig)->Result<Value>{let v:near_api::types::Data<Value>=c.call_function(m,a).read_only().fetch_from(n).await?;Ok(v.data)}
async fn call(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,deposit:u128)->Result<ExecutionFinalResult>{
 let f=c.call_function(m,a).transaction().gas(NearGas::from_tgas(300)).deposit(NearToken::from_yoctonear(deposit)).with_signer(id.clone(),s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?;
 ensure!(f.is_success()&&f.receipt_failures().is_empty(),"{m} failed: {:?}",f.receipt_failures());Ok(f)
}
async fn deploy(id:AccountId,code:Vec<u8>,args:Value,s:Arc<Signer>,n:&NetworkConfig)->Result<()>{let f=Contract::deploy(id).use_code(code).with_init_call("new",args)?.gas(NearGas::from_tgas(300)).with_signer(s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?;ensure!(f.is_success()&&f.receipt_failures().is_empty(),"deploy failed {:?}",f.receipt_failures());Ok(())}
async fn advance(sb:&near_sandbox::Sandbox,c:&Contract,n:&NetworkConfig,target:u64)->Result<()>{for _ in 0..30{let now=view(c,"get_block_timestamp_ms",json!({}),n).await?.as_u64().unwrap();if now>=target{return Ok(())}sb.fast_forward((((target-now)/300)+50).min(500)).await?;}anyhow::bail!("clock not reached")}
fn record(f:&ExecutionFinalResult)->Value{json!({"attached_tgas":300,"total_gas_burnt":f.total_gas_burnt.as_gas(),"receipts":f.receipt_outcomes().iter().map(|o|json!({"executor":o.executor_id,"success":o.is_success(),"gas_burnt":o.gas_burnt.as_gas()})).collect::<Vec<_>>()})}
async fn synth(eid:&AccountId,ftid:&AccountId,event:&str,from:usize,to:usize,s:Arc<Signer>,n:&NetworkConfig)->Result<()> {
 for start in (from..to).step_by(10){let mut tx=Transaction::construct(ftid.clone(),eid.clone());for i in start..(start+10).min(to){let args=json!({"sender_id":format!("synthetic-{event}-{i}.testnet"),"amount":"2000000","msg":json!({"version":1,"event_id":event,"commitment_id":format!("{event}-{i}")}).to_string()});tx=tx.add_action(Action::FunctionCall(Box::new(FunctionCallAction{method_name:"ft_on_transfer".into(),args:serde_json::to_vec(&args)?,gas:NearGas::from_tgas(25),deposit:NearToken::from_yoctonear(0)})));}let f=tx.with_signer(s.clone()).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("batch nonfinal"))?;ensure!(f.is_success()&&f.receipt_failures().is_empty(),"synthetic {event} batch {start}: {:?}",f.receipt_failures());println!("synthetic {event}: {}",(start+10).min(to));}Ok(())
}
#[tokio::main]
async fn main()->Result<()> {
 let code=std::fs::read(std::env::var("SHARED_WASM")?)?;let ftcode=std::fs::read(std::env::var("FT_WASM")?)?;let pcode=std::fs::read(std::env::var("MOCK_EARN_WASM")?)?;let out=std::env::var("EVIDENCE_DIR")?;
 let sb=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;ensure!(sb.rpc_addr.starts_with("http://127.0.0.1:")||sb.rpc_addr.starts_with("http://localhost:"),"nonlocal RPC");let n=NetworkConfig::from_rpc_url("sandbox",sb.rpc_addr.parse()?);let s=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 let owner:AccountId="owner.testnet".parse()?;let user:AccountId="user.testnet".parse()?;let eid:AccountId="shared.testnet".parse()?;let tid:AccountId="usdc.testnet".parse()?;let pid:AccountId="earn.testnet".parse()?;
 for id in [&owner,&user,&eid,&tid,&pid]{sb.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(100)).send().await?;}
 deploy(tid.clone(),ftcode,json!({"owner_id":owner,"total_supply":"800000000","metadata":{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"USDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}}),s.clone(),&n).await?;
 deploy(pid.clone(),pcode,json!({"token":tid,"controller":owner}),s.clone(),&n).await?;
 deploy(eid.clone(),code,json!({"canonical_ft":tid,"provider_account":pid,"provider_kind":"MOCK_TESTNET","network":"testnet","token_symbol":"USDC","token_name":"Mock USDC","token_decimals":6}),s.clone(),&n).await?;
 let ft=Contract(tid.clone());let esc=Contract(eid.clone());
 for id in [&pid,&eid,&user]{call(&ft,"storage_deposit",json!({"account_id":id,"registration_only":true}),&owner,s.clone(),&n,10_000_000_000_000_000_000_000).await?;}
 let start=view(&esc,"get_block_timestamp_ms",json!({}),&n).await?.as_u64().unwrap();let close=start+120_000;let end=close+15_000;
 for event in ["a","b","timeout"]{let rules=json!({"event_id":event,"title":"Capacity","location":"Sandbox","rules_text":"Capacity gas fixture","deposit":"2000000","capacity":200,"reg_open":start,"reg_close":close,"checkin_open":close,"checkin_close":end,"finalize_deadline":end+86400000u64});let q=view(&esc,"quote_create_event",json!({"rules":rules,"organizer":owner}),&n).await?;call(&esc,"create_event",json!({"rules":rules}),&owner,s.clone(),&n,q.as_str().unwrap().parse()?).await?;}
 call(&ft,"ft_transfer",json!({"receiver_id":user,"amount":"2000000"}),&owner,s.clone(),&n,1).await?;
 let real=call(&ft,"ft_transfer_call",json!({"receiver_id":eid,"amount":"2000000","msg":json!({"version":1,"event_id":"a","commitment_id":"real"}).to_string()}),&user,s.clone(),&n,1).await?;ensure!(real.json::<String>()?=="2000000","real registration refunded");
 call(&ft,"ft_transfer",json!({"receiver_id":eid,"amount":"798000000"}),&owner,s.clone(),&n,1).await?;
 synth(&eid,&tid,"a",1,200,s.clone(),&n).await?;synth(&eid,&tid,"b",0,200,s.clone(),&n).await?;
 for event in ["a","b"]{let v=view(&esc,"get_event",json!({"event_id":event}),&n).await?;ensure!(v["total_registrations"]==200&&v["accepted_principal"]=="400000000","bad totals {v}");}
 let cancel=call(&esc,"cancel_event",json!({"event_id":"b"}),&owner,s.clone(),&n,0).await?;
 advance(&sb,&esc,&n,close).await?;call(&esc,"close_registration",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;
 let supply=call(&esc,"trigger_earn_supply",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;ensure!(view(&esc,"get_event",json!({"event_id":"a"}),&n).await?["earn_state"]=="Supplied","supply not reconciled");
 advance(&sb,&esc,&n,end).await?;
 let finalized=call(&esc,"finalize_attendance",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;
 let redeem=call(&esc,"trigger_earn_redeem",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;ensure!(view(&esc,"get_event",json!({"event_id":"a"}),&n).await?["earn_state"]=="Redeemed","redeem not reconciled");
 let settled=call(&esc,"settle",json!({"event_id":"a"}),&owner,s.clone(),&n,0).await?;let av=view(&esc,"get_event",json!({"event_id":"a"}),&n).await?;let bv=view(&esc,"get_event_totals",json!({"event_id":"b"}),&n).await?;ensure!(av["phase"]=="Settled"&&bv["reserved_cash"]=="400000000","unexpected state {av} {bv}");
 let result=json!({"classification":"PASS_LOCAL","scope":"Sandbox 2.14.0, MockEarn, one real FT registration plus 399 synthetic FT-predecessor calls, bulk FT backing, synthetic event clock; no live proof","a_real_registrations":1,"a_synthetic_registrations":199,"b_synthetic_registrations":200,"timeout":"NOT_RUN: 24-hour event deadline not advanced","event_a":av,"event_b_totals":bv,"cancel":record(&cancel),"supply":record(&supply),"finalize":record(&finalized),"redeem":record(&redeem),"settle":record(&settled)});
 std::fs::create_dir_all(&out)?;std::fs::write(std::path::Path::new(&out).join("shared-capacity.json"),serde_json::to_vec_pretty(&result)?)?;println!("{}",result);Ok(())
}
