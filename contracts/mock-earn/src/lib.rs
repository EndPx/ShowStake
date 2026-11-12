//! TESTNET ONLY. Zero-yield custody fixture; never evidence of Rhea liquidity.
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
struct Position { available: u128, pending: u128, attempt: u64 }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockEarn {
    token: AccountId,
    controller: AccountId,
    positions: LookupMap<AccountId, Position>,
    reject_supply: bool,
    reject_withdraw: bool,
}

#[near]
impl MockEarn {
    #[init]
    pub fn new(token: AccountId, controller: AccountId) -> Self {
        require!(env::current_account_id().as_str().ends_with(".testnet"), "TESTNET_ONLY");
        require!(token.as_str().ends_with(".testnet"), "TESTNET_TOKEN_ONLY");
        Self { token, controller, positions: LookupMap::new(b"positions".to_vec()), reject_supply: false, reject_withdraw: false }
    }

    pub fn get_position(&self, account_id: AccountId) -> U128 {
        let p = self.positions.get(&account_id);
        U128(p.map(|p| p.available.checked_add(p.pending).expect("overflow")).unwrap_or(0))
    }

    pub fn set_failures(&mut self, reject_supply: bool, reject_withdraw: bool) {
        require!(env::predecessor_account_id() == self.controller, "CONTROLLER_ONLY");
        self.reject_supply = reject_supply;
        self.reject_withdraw = reject_withdraw;
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token || self.reject_supply || !msg.is_empty() || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let mut p = self.positions.get(&sender_id).unwrap_or(Position { available: 0, pending: 0, attempt: 0 });
        if p.pending > 0 { return PromiseOrValue::Value(amount); }
        p.available = p.available.checked_add(amount.0).expect("position overflow");
        self.positions.insert(&sender_id, &p);
        PromiseOrValue::Value(U128(0))
    }

    pub fn withdraw(&mut self, amount: U128) -> Promise {
        require!(!self.reject_withdraw, "CONTROLLED_WITHDRAW_REJECTION");
        require!(env::prepaid_gas().as_gas() >= 60_000_000_000_000, "WITHDRAW_REQUIRES_60_TGAS");
        let owner = env::predecessor_account_id();
        let mut p = self.positions.get(&owner).expect("position missing");
        require!(amount.0 > 0 && p.pending == 0 && p.available >= amount.0, "INVALID_WITHDRAW");
        p.available -= amount.0;
        p.pending = amount.0;
        p.attempt = p.attempt.checked_add(1).expect("attempt overflow");
        self.positions.insert(&owner, &p);
        Promise::new(self.token.clone()).function_call("ft_transfer", near_sdk::serde_json::json!({"receiver_id":owner,"amount":amount,"memo":"TESTNET_MOCK_EARN_REDEEM"}).to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(20))
          .then(Promise::new(env::current_account_id()).function_call("on_withdraw", near_sdk::serde_json::json!({"owner":owner,"attempt":p.attempt}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(15)))
    }

    #[private]
    pub fn on_withdraw(&mut self, owner: AccountId, attempt: u64) -> bool {
        let mut p = self.positions.get(&owner).expect("position missing");
        require!(p.pending > 0 && p.attempt == attempt, "STALE_CALLBACK");
        require!(env::promise_results_count() == 1, "ONE_RESULT_REQUIRED");
        let success = env::promise_result_checked(0, 1024).is_ok();
        if !success { p.available = p.available.checked_add(p.pending).expect("restore overflow"); }
        p.pending = 0;
        self.positions.insert(&owner, &p);
        success
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{testing_env, test_utils::VMContextBuilder};
    fn context(predecessor: &str) {
        testing_env!(VMContextBuilder::new().current_account_id("mock-earn.testnet".parse().unwrap()).predecessor_account_id(predecessor.parse().unwrap()).prepaid_gas(Gas::from_tgas(100)).build());
    }
    #[test]
    fn positions_are_isolated_and_bad_supply_returns_full_amount() {
        context("controller.testnet");
        let mut c=MockEarn::new("usdc.testnet".parse().unwrap(),"controller.testnet".parse().unwrap());
        context("wrong.testnet");
        assert!(matches!(c.ft_on_transfer("alice.testnet".parse().unwrap(),U128(10),String::new()),PromiseOrValue::Value(U128(10))));
        context("usdc.testnet");
        c.ft_on_transfer("alice.testnet".parse().unwrap(),U128(10),String::new());
        c.ft_on_transfer("bob.testnet".parse().unwrap(),U128(20),String::new());
        assert_eq!(c.get_position("alice.testnet".parse().unwrap()).0,10);
        assert_eq!(c.get_position("bob.testnet".parse().unwrap()).0,20);
    }
    #[test]
    fn failed_receipt_restores_once_and_success_reduces_position() {
        context("controller.testnet");
        let mut c=MockEarn::new("usdc.testnet".parse().unwrap(),"controller.testnet".parse().unwrap());
        let owner: AccountId="alice.testnet".parse().unwrap();
        context("usdc.testnet"); c.ft_on_transfer(owner.clone(),U128(10),String::new());
        context("alice.testnet"); c.withdraw(U128(4));
        assert_eq!(c.get_position(owner.clone()).0,10);
        let ctx=VMContextBuilder::new().current_account_id("mock-earn.testnet".parse().unwrap()).predecessor_account_id("mock-earn.testnet".parse().unwrap()).build();
        testing_env!(ctx.clone(),near_sdk::test_vm_config(),near_sdk::RuntimeFeesConfig::test(),Default::default(),vec![near_sdk::PromiseResult::Failed]);
        assert!(!c.on_withdraw(owner.clone(),1));
        assert_eq!(c.positions.get(&owner).unwrap().available,10);
        context("alice.testnet"); c.withdraw(U128(10));
        testing_env!(ctx,near_sdk::test_vm_config(),near_sdk::RuntimeFeesConfig::test(),Default::default(),vec![near_sdk::PromiseResult::Successful(Vec::new())]);
        assert!(c.on_withdraw(owner.clone(),2));
        assert_eq!(c.get_position(owner).0,0);
    }
}
