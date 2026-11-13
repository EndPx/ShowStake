use std::sync::Arc;
use anyhow::{ensure,Result};
use base64::Engine;
use near_api::{Account,AccountId,Contract,NearGas,NearToken,NetworkConfig,Signer};
use serde_json::{json,Value};
async fn view(c:&Contract,m:&str,a:Value,n:&NetworkConfig)->Result<Value>{ let v: near_api::types::Data<Value> = c.call_function(m,a).read_only().fetch_from(n).await?; Ok(v.data) }
async fn call(c:&Contract,m:&str,a:Value,id:&AccountId,s:Arc<Signer>,n:&NetworkConfig,deposit:u128)->Result<Value>{
 let x=c.call_function(m,a).transaction().gas(NearGas::from_tgas(300)).deposit(NearToken::from_yoctonear(deposit)).with_signer(id.clone(),s).send_to(n).await?;
 let f=x.into_full().ok_or_else(||anyhow::anyhow!("nonfinal transaction"))?;
 Ok(json!({"success":f.is_success(),"gas_burnt":f.total_gas_burnt.as_gas(),"result":f.clone().json::<Value>().ok(),"receipts":format!("{:?}",f.receipt_outcomes())}))
}
#[tokio::main]
async fn main()->Result<()> {
 let leaf=std::fs::read(std::env::var("SHOWSTAKE_WASM")?)?; let factory=std::fs::read(std::env::var("FACTORY_WASM")?)?;
 let code=base64::engine::general_purpose::STANDARD.encode(&leaf);
 let sandbox=near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
 let n=NetworkConfig::from_rpc_url("sandbox",sandbox.rpc_addr.parse()?);
 let s=Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
 for a in ["factory.sandbox","organizer.sandbox","attacker.sandbox","factory.testnet","bad.sandbox"] { sandbox.create_account(a.parse()?).initial_balance(NearToken::from_near(30)).send().await?; }
 let fid:AccountId="factory.sandbox".parse()?; let org:AccountId="organizer.sandbox".parse()?; let attacker:AccountId="attacker.sandbox".parse()?;
 let init=json!({"canonical_ft":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","network":"mainnet","policy_version":"showstake-native-usdc-rhea-review/1","provider_account":"contract.main.burrow.near","provider_kind":"RHEA_MAINNET"});
 let d=Contract::deploy(fid.clone()).use_code(factory).with_init_call("new",init)?.gas(NearGas::from_tgas(300)).with_signer(s.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal deploy"))?;
 ensure!(d.is_success(),"factory deployment failed: {d:?}");
 let c=Contract(fid.clone()); let before=Account(fid.clone()).view().fetch_from(&n).await?;
 let q=view(&c,"quote_provision",json!({"organizer":org}),&n).await?; let amount=q["total"].as_str().ok_or_else(||anyhow::anyhow!("bad quote"))?.parse::<u128>()?;
 let wrong=call(&c,"provision",json!({"request_nonce":1,"code":"AA=="}),&org,s.clone(),&n,amount).await?; ensure!(wrong["success"]==false,"wrong code accepted");
 let under=call(&c,"provision",json!({"request_nonce":1,"code":code}),&org,s.clone(),&n,amount-1).await?; ensure!(under["success"]==false,"wrong amount accepted");
 let provision=call(&c,"provision",json!({"request_nonce":1,"code":code}),&org,s.clone(),&n,amount).await?;
 let request=view(&c,"get_request",json!({"organizer":org,"request_nonce":1}),&n).await?;
 ensure!(request["state"]=="Ready","child not ready: {request}; tx {provision}");
 let cid:AccountId=request["child_id"].as_str().unwrap().parse()?; let child=Contract(cid.clone());
 let config=view(&child,"get_config",json!({}),&n).await?; let control=view(&child,"get_rhea_control",json!({}),&n).await?; let event=view(&child,"get_event",json!({}),&n).await?;
 let cv=Account(cid.clone()).view().fetch_from(&n).await?; let keys=Account(cid.clone()).list_keys().fetch_from(&n).await?;
 ensure!(request["leaf_policy_version"]==config["policy_version"],"factory/leaf policy mismatch");
 ensure!(config["organizer"]==org.as_str() && config["provider_kind"]=="RHEA_MAINNET" && control["paused"]==true && control["principal_cap"]=="0" && event.is_null(),"wrong initialized state");
 ensure!(format!("{:?}",cv.data).contains("CpnhymSeF785ZBVTaBZfW8ApsfMVUByNCrys8R2i8os"),"wrong deployed leaf hash");
 let keys_value=serde_json::to_value(&keys.data)?; ensure!(keys_value.as_array().map(|a|a.is_empty())==Some(true),"child has access keys: {keys_value}");
 let after=Account(fid.clone()).view().fetch_from(&n).await?;
 let replay=call(&c,"provision",json!({"request_nonce":1,"code":code}),&org,s.clone(),&n,0).await?; ensure!(replay["success"]==true,"replay failed");
 let unauthorized=call(&child,"configure_rhea_cap",json!({"principal_cap":"1"}),&attacker,s.clone(),&n,0).await?; ensure!(unauthorized["success"]==false,"unauthorized cap accepted");
 let collision_id: String=view(&c,"get_child_id",json!({"organizer":org,"request_nonce":2}),&n).await?.as_str().unwrap().to_string();
 sandbox.create_account(collision_id.parse()?).initial_balance(NearToken::from_near(1)).send().await?;
 let q2=view(&c,"quote_provision",json!({"organizer":org}),&n).await?; let amount2=q2["total"].as_str().unwrap().parse::<u128>()?;
 let collision=call(&c,"provision",json!({"request_nonce":2,"code":code}),&org,s.clone(),&n,amount2).await?;
 let failed=view(&c,"get_request",json!({"organizer":org,"request_nonce":2}),&n).await?;
 ensure!(failed["state"]=="Failed" && failed["refund_state"]=="Claimable","collision did not become claimable {failed}");
 let org_before=Account(org.clone()).view().fetch_from(&n).await?;
 let refund=call(&c,"claim_failed_funding",json!({"request_nonce":2}),&org,s.clone(),&n,0).await?;
 let org_after=Account(org.clone()).view().fetch_from(&n).await?;
 ensure!(org_after.data.amount.as_yoctonear() > org_before.data.amount.as_yoctonear(),"organizer did not receive net refund");
 let refunded=view(&c,"get_request",json!({"organizer":org,"request_nonce":2}),&n).await?;
 ensure!(refunded["refund_state"]=="Paid","refund not paid {refunded}");
 let duplicate=call(&c,"claim_failed_funding",json!({"request_nonce":2}),&org,s.clone(),&n,0).await?; ensure!(duplicate["success"]==false,"duplicate refund accepted");
 let tfid:AccountId="factory.testnet".parse()?;
 let testinit=json!({"canonical_ft":"mockusdc.testnet","network":"testnet","policy_version":"showstake-native-usdc-event/1","provider_account":"provider.testnet","provider_kind":"MOCK_TESTNET"});
 let testdeploy=Contract::deploy(tfid.clone()).use_code(std::fs::read(std::env::var("FACTORY_WASM")?)?).with_init_call("new",testinit)?.gas(NearGas::from_tgas(300)).with_signer(s.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?; ensure!(testdeploy.is_success(),"testnet factory init failed {testdeploy:?}");
 let tc=Contract(tfid); let tq=view(&tc,"quote_provision",json!({"organizer":org}),&n).await?; let ta=tq["total"].as_str().unwrap().parse::<u128>()?;
 let testprovision=call(&tc,"provision",json!({"request_nonce":1,"code":code}),&org,s.clone(),&n,ta).await?;
 let tr=view(&tc,"get_request",json!({"organizer":org,"request_nonce":1}),&n).await?; ensure!(tr["state"]=="Ready","testnet mock child failed {tr}");
 let tchild=Contract(tr["child_id"].as_str().unwrap().parse()?); let tconfig=view(&tchild,"get_config",json!({}),&n).await?; ensure!(tconfig["provider_kind"]=="MOCK_TESTNET" && tconfig["organizer"]==org.as_str(),"bad testnet child");
 let badinit=json!({"canonical_ft":"evil.near","network":"mainnet","policy_version":"showstake-native-usdc-rhea-review/1","provider_account":"contract.main.burrow.near","provider_kind":"RHEA_MAINNET"});
 let bad=Contract::deploy("bad.sandbox".parse()?).use_code(std::fs::read(std::env::var("FACTORY_WASM")?)?).with_init_call("new",badinit)?.gas(NearGas::from_tgas(300)).with_signer(s.clone()).send_to(&n).await?.into_full().ok_or_else(||anyhow::anyhow!("nonfinal"))?; ensure!(bad.is_failure(),"wrong token accepted");
 println!("{}",serde_json::to_string_pretty(&json!({"testnet_provision":testprovision,"testnet_request":tr,"testnet_config":tconfig,"collision":collision,"collision_request":failed,"refund":refund,"refund_before":org_before.data,"refund_after":org_after.data,"duplicate_refund":duplicate,"status":"PASS_LOCAL","scope":"sandbox only; no external provider calls", "quote":q,"factory_before":before.data,"factory_after":after.data,"factory_registry_growth_bytes":after.data.storage_usage-before.data.storage_usage,"provision":provision,"request":request,"child_account":cv.data,"child_keys":keys_value,"config":config,"control":control,"event":event,"negative_wrong_code":wrong,"negative_underpayment":under,"negative_unauthorized":unauthorized,"replay":replay}))?);
 Ok(())
}
