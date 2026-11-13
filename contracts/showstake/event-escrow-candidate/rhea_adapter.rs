//! Review-only Rhea/Burrow codec, wired only by the mainnet-review feature.
//! Sources: https://github.com/NearDeFi/burrowland (Actions, storage, views),
//! https://github.com/NearDeFi/burrowland/blob/master/contract/src/actions.rs,
//! https://github.com/rhea-finance/burrow-sdk-python/blob/main/burrow/contract_handler.py
//! Live ABI/code equivalence, registration, liquidity, callbacks and settlement require separate proof.
//! Balance is in Burrow internal units; shares are internal accounting shares, not an FT.
use near_sdk::serde_json::{self, json, Value};

pub const PROVIDER: &str = "contract.main.burrow.near";
pub const USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub const ONE_YOCTO: u128 = 1;

#[derive(Debug, PartialEq, Eq)]
pub struct Call { pub receiver: &'static str, pub method: &'static str, pub args: Vec<u8>, pub deposit_yocto: u128 }
#[derive(Debug, PartialEq, Eq)]
pub struct Asset { pub extra_decimals: u8, pub can_deposit: bool, pub can_withdraw: bool }
#[derive(Debug, PartialEq, Eq)]
pub struct Position { pub shares: u128, pub internal_balance: u128, pub token_atomics_floor: u128, pub internal_remainder: u128 }

fn check_network(network: &str, provider: &str, token: &str) -> Result<(), &'static str> {
    if network != "mainnet" || provider != PROVIDER || token != USDC { return Err("wrong network or contract"); } Ok(())
}
fn atomic(value: &Value) -> Result<u128, &'static str> {
    let s = value.as_str().ok_or("expected integer string")?;
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|x| x.is_ascii_digit()) { return Err("noncanonical integer"); }
    s.parse().map_err(|_| "integer overflow")
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value, &'static str> { v.get(key).ok_or("missing field") }
fn flag(v: &Value, key: &str) -> Result<bool, &'static str> { field(v,key)?.as_bool().ok_or("invalid flag") }
fn args(v: Value) -> Vec<u8> { serde_json::to_vec(&v).expect("static JSON serialization") }

pub fn supply_call(network: &str, provider: &str, token: &str, amount: u128, asset: &Asset) -> Result<Call, &'static str> {
    check_network(network,provider,token)?;
    if amount == 0 || !asset.can_deposit { return Err("supply disabled or zero"); }
    Ok(Call { receiver: USDC, method: "ft_transfer_call", args: args(json!({"receiver_id": PROVIDER,"amount":amount.to_string(),"msg":""})), deposit_yocto: ONE_YOCTO })
}
/// Full withdrawal only. Provider pays predecessor; there is no caller-controlled receiver.
pub fn withdraw_all_call(network: &str, provider: &str, token: &str, asset: &Asset) -> Result<Call, &'static str> {
    check_network(network,provider,token)?;
    if !asset.can_withdraw { return Err("withdraw disabled"); }
    Ok(Call { receiver: PROVIDER, method: "execute", args: args(json!({"actions":[{"Withdraw":{"token_id":USDC}}]})), deposit_yocto: ONE_YOCTO })
}
/// Candidate ABI; amount is whole FT atomic units, never a full-balance sentinel.
#[cfg(feature = "rhea-linked-withdraw-review")]
pub fn linked_withdraw_call(network: &str, provider: &str, token: &str, amount: u128, asset: &Asset) -> Result<Call, &'static str> {
    check_network(network,provider,token)?;
    if amount == 0 || !asset.can_withdraw { return Err("withdraw disabled or zero"); }
    let scale = 10u128.checked_pow(asset.extra_decimals.into()).ok_or("decimal scale overflow")?;
    let inner = amount.checked_mul(scale).ok_or("amount overflow")?;
    Ok(Call { receiver: PROVIDER, method: "simple_withdraw", args: args(json!({"token_id":USDC,"amount_with_inner_decimal":inner.to_string(),"recipient_id":null})), deposit_yocto: ONE_YOCTO })
}
pub fn decode_asset(network: &str, provider: &str, token: &str, data: &[u8]) -> Result<Asset, &'static str> {
    check_network(network,provider,token)?;
    let v: Value = serde_json::from_slice(data).map_err(|_| "invalid asset JSON")?;
    if field(&v,"token_id")?.as_str() != Some(USDC) { return Err("wrong asset"); }
    let config = field(&v,"config")?.as_object().ok_or("invalid config")?;
    for (key,value) in config { if key.starts_with("can_") && (!matches!(key.as_str(), "can_deposit" | "can_withdraw" | "can_use_as_collateral" | "can_borrow") || !value.is_boolean()) { return Err("unknown or invalid capability flag"); } }
    let c = field(&v,"config")?;
    let extra = field(c,"extra_decimals")?.as_u64().ok_or("invalid extra decimals")?;
    let extra_decimals = u8::try_from(extra).map_err(|_| "extra decimals overflow")?;
    10u128.checked_pow(extra_decimals.into()).ok_or("decimal scale overflow")?;
    let can_deposit = flag(c,"can_deposit")?; let can_withdraw = flag(c,"can_withdraw")?;
    flag(c,"can_use_as_collateral")?; flag(c,"can_borrow")?;
    Ok(Asset { extra_decimals, can_deposit, can_withdraw })
}
pub fn decode_position(network: &str, provider: &str, token: &str, expected_account: &str, data: &[u8], asset: &Asset) -> Result<Position, &'static str> {
    check_network(network,provider,token)?;
    if expected_account.is_empty() { return Err("missing account"); }
    let v: Value = serde_json::from_slice(data).map_err(|_| "invalid account JSON")?;
    if field(&v,"account_id")?.as_str() != Some(expected_account) { return Err("wrong account"); }
    for key in ["borrowed", "collateral"] { if !field(&v,key)?.as_array().ok_or("invalid exposure")?.is_empty() { return Err("exposure forbidden"); } }
    // New position containers must be reviewed before this codec is extended.
    for key in ["positions", "margin_positions", "margin_debt"] { if let Some(x)=v.get(key) { if !x.is_null() && x.as_array().map(|a| !a.is_empty()).unwrap_or(true) { return Err("unsupported position exposure"); } } }
    let supplied = field(&v,"supplied")?.as_array().ok_or("invalid supplied")?;
    if supplied.len() > 1 { return Err("multiple supplied assets"); }
    let (shares, balance) = if let Some(row) = supplied.first() {
        if field(row,"token_id")?.as_str() != Some(USDC) { return Err("wrong supplied token"); }
        (atomic(field(row,"shares")?)?, atomic(field(row,"balance")?)?)
    } else { (0,0) };
    if (shares == 0) != (balance == 0) { return Err("inconsistent position"); }
    let scale = 10u128.checked_pow(asset.extra_decimals.into()).ok_or("decimal scale overflow")?;
    Ok(Position { shares, internal_balance: balance, token_atomics_floor: balance / scale, internal_remainder: balance % scale })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn asset() -> Asset { Asset { extra_decimals: 12, can_deposit: true, can_withdraw: true } }
    fn account(supplied: Value, borrowed: Value, collateral: Value) -> Vec<u8> { args(json!({"account_id":"escrow.near","supplied":supplied,"borrowed":borrowed,"collateral":collateral,"farms":[]})) }
    #[test] fn calls_are_fixed_and_one_yocto() {
        let c=supply_call("mainnet",PROVIDER,USDC,42,&asset()).unwrap(); assert_eq!(c.receiver,USDC); assert_eq!(c.deposit_yocto,1); assert_eq!(serde_json::from_slice::<Value>(&c.args).unwrap(),json!({"receiver_id":PROVIDER,"amount":"42","msg":""}));
        let c=withdraw_all_call("mainnet",PROVIDER,USDC,&asset()).unwrap(); assert_eq!(c.receiver,PROVIDER); assert_eq!(c.deposit_yocto,1); assert_eq!(serde_json::from_slice::<Value>(&c.args).unwrap(),json!({"actions":[{"Withdraw":{"token_id":USDC}}]}));
        assert!(supply_call("testnet",PROVIDER,USDC,1,&asset()).is_err()); assert!(supply_call("mainnet",PROVIDER,USDC,0,&asset()).is_err());
    }
    #[test] fn position_uses_integer_floor_and_preserves_dust() {
        let d=account(json!([{"token_id":USDC,"shares":"9","balance":"1000000000001"}]),json!([]),json!([]));
        assert_eq!(decode_position("mainnet",PROVIDER,USDC,"escrow.near",&d,&asset()).unwrap(),Position{shares:9,internal_balance:1000000000001,token_atomics_floor:1,internal_remainder:1});
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test] fn linked_withdraw_uses_checked_exact_inner_units() {
        let c=linked_withdraw_call("mainnet",PROVIDER,USDC,42,&asset()).unwrap();
        assert_eq!(c.method,"simple_withdraw"); assert_eq!(c.deposit_yocto,1);
        assert_eq!(serde_json::from_slice::<Value>(&c.args).unwrap(),json!({"token_id":USDC,"amount_with_inner_decimal":"42000000000000","recipient_id":null}));
        assert!(linked_withdraw_call("mainnet",PROVIDER,USDC,0,&asset()).is_err());
        assert!(linked_withdraw_call("mainnet",PROVIDER,USDC,u128::MAX,&asset()).is_err());
    }
    #[test] fn refuses_exposure_wrong_token_and_noncanonical_numbers() {
        for (s,b,c) in [(json!([]),json!([{}]),json!([])),(json!([]),json!([]),json!([{}])),(json!([{"token_id":"evil.near","shares":"1","balance":"1"}]),json!([]),json!([])),(json!([{"token_id":USDC,"shares":"01","balance":"1"}]),json!([]),json!([])),(json!([{},{}]),json!([]),json!([]))] { assert!(decode_position("mainnet",PROVIDER,USDC,"escrow.near",&account(s,b,c),&asset()).is_err()); }
    }
    #[test] fn asset_flags_fail_closed() {
        let mut v=json!({"token_id":USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        assert_eq!(decode_asset("mainnet",PROVIDER,USDC,&args(v.clone())).unwrap(),asset());
        v["config"]["can_mint"]=json!(true); assert!(decode_asset("mainnet",PROVIDER,USDC,&args(v)).is_err());
    }
}
