use std::sync::Arc;
use anyhow::{ensure,Result};
use near_api::{AccountId,Contract,NearGas,NearToken,NetworkConfig,Signer};
use near_api::types::transaction::result::ExecutionFinalResult;
use serde_json::{json,Value};
async fn view(c:&Contract,m:&str,a:Value,n:&NetworkConfig)->Result<Value>{let d:near_api::types::Data<Value>=c.call_function(m,a).read_only().fetch_from(n).await?;Ok(d.data)}
async fn call(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,dep:u128)->Result<ExecutionFinalResult>{Ok(c.call_function(m,a).transaction().gas(NearGas::from_tgas(300)).deposit(NearToken::from_yoctonear(dep)).with_signer(id.clone(),s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("not final"))?)}
async fn must(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,dep:u128)->Result<ExecutionFinalResult>{let f=call(c,m,a,id,s,n,dep).await?;ensure!(f.is_success(),"{m} failed {f:?}");Ok(f)}
async fn deploy(id:AccountId,wasm:Vec<u8>,a:Value,s:Arc<Signer>,n:&NetworkConfig)->Result<()>{let f=Contract::deploy(id).use_code(wasm).with_init_call("new",a)?.gas(NearGas::from_tgas(300)).with_signer(s).send_to(n).await?.into_full().ok_or_else(||anyhow::anyhow!("not final"))?;ensure!(f.is_success(),"deployment failed {f:?}");Ok(())}
fn outcomes(f:&ExecutionFinalResult)->Vec<Value>{f.receipt_outcomes().iter().map(|x|json!({"executor":x.executor_id.to_string(),"receipt":x.transaction_hash.to_string(),"success":x.is_success(),"failure":x.is_failure(),"logs":x.logs})).collect()}
async fn advance(sandbox:&near_sandbox::Sandbox,c:&Contract,n:&NetworkConfig,target:u64)->Result<()> {for _ in 0..12 {let now=view(c,"get_block_timestamp_ms",json!({}),n).await?.as_u64().unwrap();if now>=target{return Ok(());}sandbox.fast_forward((((target-now)/300)+50).min(500)).await?;}anyhow::bail!("fastforward not reached")}
#[tokio::main] async fn main()->Result<()> {
 let sandbox=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;let n=NetworkConfig::from_rpc_url("sandbox",sandbox.rpc_addr.parse()?);let s=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 let org:AccountId="organizer.testnet".parse()?;let eid:AccountId="escrow.testnet".parse()?;let ftid:AccountId="usdc.testnet".parse()?;let mid:AccountId="earn.testnet".parse()?;let mut users=Vec::new();for i in 0..5 {users.push(format!("user{i}.testnet").parse::<AccountId>()?);}for id in [&org,&eid,&ftid,&mid].into_iter().chain(users.iter()){sandbox.create_account(id.as_str().parse()?).initial_balance(NearToken::from_near(20)).send().await?;}
 let leaf=std::fs::read(std::env::var("SHOWSTAKE_WASM")?)?;let ftwasm=std::fs::read(std::env::var("FT_WASM")?)?;let mock=std::fs::read(std::env::var("MOCK_WASM")?)?;
 deploy(ftid.clone(),ftwasm,json!({"owner_id":org,"total_supply":"20000000","metadata":{"spec":"ft-1.0.0","name":"Mock USDC","symbol":"USDC","icon":null,"reference":null,"reference_hash":null,"decimals":6}}),s.clone(),&n).await?;
 deploy(mid.clone(),mock,json!({"token":ftid,"controller":org}),s.clone(),&n).await?;
 deploy(eid.clone(),leaf.clone(),json!({"organizer":org,"provider_account":mid,"canonical_ft":ftid,"token_symbol":"USDC","token_name":"Mock USDC","token_decimals":6,"provider_kind":"MOCK_TESTNET"}),s.clone(),&n).await?;
 let ft=Contract(ftid.clone());let escrow=Contract(eid.clone());let earn=Contract(mid.clone());
 for id in [&eid,&mid].into_iter().chain(users.iter()){must(&ft,"storage_deposit",json!({"account_id":id}),&org,s.clone(),&n,10_000_000_000_000_000_000_000).await?;}
 for id in &users {must(&ft,"ft_transfer",json!({"receiver_id":id,"amount":"2000000"}),&org,s.clone(),&n,1).await?;}
 let now=view(&escrow,"get_block_timestamp_ms",json!({}),&n).await?.as_u64().unwrap();let close=now+60000;let end=close+300000;
 must(&escrow,"create_event",json!({"rules":{"event_id":"five","title":"Five","location":"Local","rules_text":"five participants","finalize_deadline":end+60000,"deposit":"2000000","capacity":5,"reg_open":now,"reg_close":close,"checkin_open":close,"checkin_close":end}}),&org,s.clone(),&n,0).await?;
 for (i,id) in users.iter().enumerate(){let msg=json!({"version":1,"event_id":"five","commitment_id":format!("c{i}")}).to_string();let f=must(&ft,"ft_transfer_call",json!({"receiver_id":eid,"amount":"2000000","msg":msg}),id,s.clone(),&n,1).await?;ensure!(f.receipt_outcomes().iter().all(|x|!x.is_failure()),"failed deposit receipt");}
 let pre=view(&escrow,"get_event",json!({}),&n).await?;ensure!(pre["accepted_principal"]=="10000000","bad deposit aggregate");advance(&sandbox,&escrow,&n,close).await?;
 must(&escrow,"close_registration",json!({}),&org,s.clone(),&n,0).await?;must(&escrow,"trigger_earn_supply",json!({}),&org,s.clone(),&n,0).await?;ensure!(view(&escrow,"get_event",json!({}),&n).await?["earn_state"]=="Supplied","supply incomplete");
 for i in [1,3]{must(&escrow,"mark_attendance",json!({"registration_id":format!("five-reg-{i}"),"attended":true}),&org,s.clone(),&n,0).await?;}advance(&sandbox,&escrow,&n,end).await?;
 must(&escrow,"finalize_attendance",json!({}),&org,s.clone(),&n,0).await?;must(&escrow,"trigger_earn_redeem",json!({}),&org,s.clone(),&n,0).await?;let ev=view(&escrow,"get_event",json!({}),&n).await?;ensure!(ev["earn_state"]=="Redeemed"&&ev["realized_yield"]=="0","mock redeem incomplete {ev}");must(&escrow,"settle",json!({}),&org,s.clone(),&n,0).await?;
 let mut claims=Vec::new();for i in 0..5{let r=view(&escrow,"get_registration",json!({"registration_id":format!("five-reg-{i}")}),&n).await?;ensure!(r["claim_amount"]==if [1,3].contains(&i){"5000000"}else{"0"},"wrong payout {r}");claims.push(r);}
 must(&ft,"storage_unregister",json!({"force":false}),&users[1],s.clone(),&n,1).await?;
 let before_user=view(&ft,"ft_balance_of",json!({"account_id":users[1]}),&n).await?;let before_escrow=view(&ft,"ft_balance_of",json!({"account_id":eid}),&n).await?;
 let failed=call(&escrow,"claim",json!({"registration_id":"five-reg-1"}),&users[1],s.clone(),&n,1).await?;
 let ft_failed=failed.receipt_outcomes().iter().any(|x|x.executor_id==ftid&&x.is_failure());let callback_ok=failed.receipt_outcomes().iter().filter(|x|x.executor_id==eid&&x.is_success()).count()>=2;
 let after_fail=view(&escrow,"get_registration",json!({"registration_id":"five-reg-1"}),&n).await?;
 ensure!(ft_failed&&callback_ok&&after_fail["claim"]=="Claimable"&&view(&ft,"ft_balance_of",json!({"account_id":users[1]}),&n).await?==before_user&&view(&ft,"ft_balance_of",json!({"account_id":eid}),&n).await?==before_escrow&&after_fail["claim_amount"]=="5000000","failure not restored");
 must(&ft,"storage_deposit",json!({"account_id":users[1]}),&org,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
 let retry=must(&escrow,"claim",json!({"registration_id":"five-reg-1"}),&users[1],s.clone(),&n,1).await?;ensure!(retry.receipt_outcomes().iter().all(|x|!x.is_failure()),"retry receipt failed");
 ensure!(view(&ft,"ft_balance_of",json!({"account_id":users[1]}),&n).await?=="5000000"&&view(&escrow,"get_registration",json!({"registration_id":"five-reg-1"}),&n).await?["claim"]=="Paid","retry not paid");
 let duplicate=call(&escrow,"claim",json!({"registration_id":"five-reg-1"}),&users[1],s.clone(),&n,1).await?;let noshow=call(&escrow,"claim",json!({"registration_id":"five-reg-0"}),&users[0],s.clone(),&n,1).await?;let spoof=call(&escrow,"on_claim_result",json!({"registration_id":"five-reg-3","attempt":1}),&users[0],s.clone(),&n,0).await?;ensure!(duplicate.is_failure()&&noshow.is_failure()&&spoof.is_failure(),"claim guard failed");
 let other=must(&escrow,"claim",json!({"registration_id":"five-reg-3"}),&users[3],s.clone(),&n,1).await?;ensure!(other.receipt_outcomes().iter().all(|x|!x.is_failure()),"second payout receipt failed");
 let end_event=view(&escrow,"get_event",json!({}),&n).await?;let u3=view(&ft,"ft_balance_of",json!({"account_id":users[3]}),&n).await?;let balance=view(&ft,"ft_balance_of",json!({"account_id":eid}),&n).await?;let position=view(&earn,"get_position",json!({"account_id":eid}),&n).await?;
 ensure!(u3=="5000000"&&balance=="0"&&position=="0"&&end_event["accepted_principal"]=="10000000","conservation failed");
 let cancelid:AccountId="cancel.testnet".parse()?;sandbox.create_account(cancelid.as_str().parse()?).initial_balance(NearToken::from_near(20)).send().await?;
 deploy(cancelid.clone(),leaf,json!({"organizer":org,"provider_account":mid,"canonical_ft":ftid,"token_symbol":"USDC","token_name":"Mock USDC","token_decimals":6,"provider_kind":"MOCK_TESTNET"}),s.clone(),&n).await?;
 let cancel=Contract(cancelid.clone());must(&ft,"storage_deposit",json!({"account_id":cancelid}),&org,s.clone(),&n,10_000_000_000_000_000_000_000).await?;
 must(&ft,"ft_transfer",json!({"receiver_id":users[0],"amount":"2000000"}),&org,s.clone(),&n,1).await?;
 let now=view(&cancel,"get_block_timestamp_ms",json!({}),&n).await?.as_u64().unwrap();
 must(&cancel,"create_event",json!({"rules":{"event_id":"cancel","title":"Cancel","location":"Local","rules_text":"cancel before supply","finalize_deadline":now+240000,"deposit":"2000000","capacity":1,"reg_open":now,"reg_close":now+120000,"checkin_open":now+120000,"checkin_close":now+180000}}),&org,s.clone(),&n,0).await?;
 let msg=json!({"version":1,"event_id":"cancel","commitment_id":"cancel-c0"}).to_string();must(&ft,"ft_transfer_call",json!({"receiver_id":cancelid,"amount":"2000000","msg":msg}),&users[0],s.clone(),&n,1).await?;
 ensure!(view(&cancel,"get_event",json!({}),&n).await?["accepted_principal"]=="2000000","cancel deposit not accepted");
 must(&cancel,"cancel_event",json!({"event_id":"cancel"}),&org,s.clone(),&n,0).await?;
 let cancel_claim=must(&cancel,"claim",json!({"registration_id":"cancel-reg-0"}),&users[0],s.clone(),&n,1).await?;
 ensure!(cancel_claim.receipt_outcomes().iter().all(|x|!x.is_failure())&&view(&ft,"ft_balance_of",json!({"account_id":users[0]}),&n).await?=="2000000"&&view(&ft,"ft_balance_of",json!({"account_id":cancelid}),&n).await?=="0","cancel refund failed");
 println!("{}",serde_json::to_string_pretty(&json!({"status":"PASS_LOCAL","scope":"five local participants, MockEarn zero yield, no financial state patch","claims_before":claims,"failed_top_success":failed.is_success(),"failed_receipts":outcomes(&failed),"after_failure":after_fail,"retry_receipts":outcomes(&retry),"other_receipts":outcomes(&other),"duplicate_denied":duplicate.is_failure(),"noshow_denied":noshow.is_failure(),"foreign_callback_denied":spoof.is_failure(),"final_event":end_event,"attendee_1":"5000000","attendee_3":u3,"escrow_balance":balance,"provider_position":position,"cancel_before_supply":{"status":"PASS_LOCAL","returned_atomics":"2000000","receipts":outcomes(&cancel_claim)},"timeout":"NOT_RUN"}))?);Ok(())
}
