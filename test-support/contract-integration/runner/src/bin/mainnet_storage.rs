use near_api::{AccountId, Contract, NearGas, NearToken, NetworkConfig, Signer};
use serde_json::{json, Value};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let wasm_path = std::env::var("SHOWSTAKE_WASM")?;
    let wasm = std::fs::read(&wasm_path)?;
    let sandbox = near_sandbox::Sandbox::start_sandbox_with_version("2.14.0").await?;
    let network = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let signer = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let mut cases = Vec::new();
    for (name, amount, gas_tgas) in [("escrow230.sandbox", 2_300_000_000_000_000_000_000_000u128, 10), ("escrow235.sandbox", 2_350_000_000_000_000_000_000_000u128, 10), ("escrow300.sandbox", 3_000_000_000_000_000_000_000_000u128, 300)] {
        let id: AccountId = name.parse()?;
        sandbox.create_account(name.parse()?).initial_balance(NearToken::from_yoctonear(amount)).send().await?;
        let args = json!({"organizer":"dc634c505ee6b86a9b615ed7ebef7fff6a235c3406163d35d4f0e60c576a27b5","provider_account":"contract.main.burrow.near","canonical_ft":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","token_symbol":"USDC","token_name":"USDC","token_decimals":6,"provider_kind":"RHEA_MAINNET"});
        let tx = Contract::deploy(id.clone()).use_code(wasm.clone()).with_init_call("new", args)?.gas(NearGas::from_tgas(gas_tgas)).with_signer(signer.clone()).send_to(&network).await?;
        let full = tx.into_full().ok_or_else(|| anyhow::anyhow!("transaction not final"))?;
        let success = full.is_success();
        let details = format!("{full:?}");
        let gas = full.total_gas_burnt.as_gas();
        let error = full.clone().into_result().err().map(|e| format!("{e}"));
        let contract = Contract(id.clone());
        let mut views = json!(null);
        if success {
            let mut values = serde_json::Map::new();
            for method in ["get_storage_state", "get_config", "get_rhea_control", "get_event"] {
                let data: near_api::types::Data<Value> = contract.call_function(method, json!({})).read_only().fetch_from(&network).await?;
                values.insert(method.into(), data.data);
            }
            views = Value::Object(values);
            anyhow::ensure!(views["get_rhea_control"]["paused"] == true && views["get_rhea_control"]["principal_cap"] == "0" && views["get_event"].is_null(), "unexpected init state");
        }
        cases.push(json!({"account":name,"funding_yocto":amount.to_string(),"prepaid_tgas":gas_tgas,"success":success,"gas_burnt":gas,"error":error,"final_transaction_debug":details,"views":views}));
    }
    let pass = cases[0]["success"] == true && cases[1]["success"] == true && cases[2]["success"] == true;
    println!("{}", serde_json::to_string_pretty(&json!({"status":if pass {"PASS_LOCAL"} else {"FAILED"}, "scope":"sandbox only; no provider calls; sandbox gas prices do not prove mainnet fees", "wasm_path":wasm_path,"wasm_bytes":wasm.len(),"cases":cases}))?);
    anyhow::ensure!(pass, "funding cases did not match expectations");
    Ok(())
}
