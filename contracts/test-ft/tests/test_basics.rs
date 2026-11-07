// TEST-ONLY unit tests for the NEP-141 fixture. These run in the near-sdk
// mocked VM and are NOT chain evidence; the real receipt evidence comes from
// harness/src/main.rs against a temporary local NEAR Sandbox.

use ft_fixture::Contract;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::StorageManagement;
use near_sdk::json_types::U128;
use near_sdk::test_utils::{accounts, testing_env_with_promise_results, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::{AccountId, NearToken, PromiseOrValue, PromiseResult};

fn metadata() -> FungibleTokenMetadata {
    FungibleTokenMetadata {
        spec: FT_METADATA_SPEC.to_string(),
        name: "Sandbox FT A".to_string(),
        symbol: "SFT-A".to_string(),
        icon: None,
        reference: None,
        reference_hash: None,
        decimals: 0,
    }
}

fn context(predecessor: &AccountId, deposit_yocto: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(accounts(0))
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .account_balance(NearToken::from_near(100));
    builder
}

fn fixture() -> (Contract, AccountId, AccountId) {
    let owner = accounts(1);
    let receiver = accounts(2);
    testing_env!(context(&owner, 0).build());
    let contract = Contract::new(owner.clone(), U128(1_000), metadata());
    (contract, owner, receiver)
}

fn register(contract: &mut Contract, account: &AccountId) {
    testing_env!(context(account, NearToken::from_millinear(10).as_yoctonear()).build());
    contract.storage_deposit(Some(account.clone()), Some(true));
}

#[test]
fn new_assigns_entire_supply_to_owner() {
    let (contract, owner, _) = fixture();
    assert_eq!(contract.ft_total_supply(), U128(1_000));
    assert_eq!(contract.ft_balance_of(owner), U128(1_000));
}

#[test]
fn ft_transfer_moves_balance_and_supply_is_conserved() {
    let (mut contract, owner, receiver) = fixture();
    register(&mut contract, &receiver);

    testing_env!(context(&owner, 1).build());
    contract.ft_transfer(receiver.clone(), U128(100), None);

    assert_eq!(contract.ft_balance_of(owner), U128(900));
    assert_eq!(contract.ft_balance_of(receiver), U128(100));
    assert_eq!(contract.ft_total_supply(), U128(1_000));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn ft_transfer_requires_one_yocto() {
    let (mut contract, owner, receiver) = fixture();
    register(&mut contract, &receiver);

    testing_env!(context(&owner, 0).build());
    contract.ft_transfer(receiver, U128(100), None);
}

#[test]
#[should_panic(expected = "The account doesn't have enough balance")]
fn ft_transfer_rejects_insufficient_balance() {
    let (mut contract, owner, receiver) = fixture();
    register(&mut contract, &receiver);

    testing_env!(context(&owner, 1).build());
    contract.ft_transfer(receiver, U128(1_001), None);
}

#[test]
fn ft_transfer_call_schedules_receiver_and_moves_balance() {
    let (mut contract, owner, receiver) = fixture();
    register(&mut contract, &receiver);

    testing_env!(context(&owner, 1).build());
    let result =
        contract.ft_transfer_call(receiver.clone(), U128(100), None, "accept".to_string());

    assert!(matches!(result, PromiseOrValue::Promise(_)));
    assert_eq!(contract.ft_balance_of(owner), U128(900));
    assert_eq!(contract.ft_balance_of(receiver), U128(100));
    assert_eq!(contract.ft_total_supply(), U128(1_000));
}

#[test]
fn resolver_refunds_unused_amount_as_private_callback() {
    let (mut contract, owner, receiver) = fixture();
    register(&mut contract, &receiver);

    testing_env!(context(&owner, 1).build());
    contract.ft_transfer_call(receiver.clone(), U128(100), None, "reject".to_string());
    assert_eq!(contract.ft_balance_of(receiver.clone()), U128(100));

    // The generated private callback runs as the FT contract itself and reads
    // the receiver's returned unused amount from promise result 0.
    testing_env_with_promise_results(
        context(&accounts(0), 0).build(),
        PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(100)).unwrap()),
    );
    let used = contract.ft_resolve_transfer(owner.clone(), receiver.clone(), U128(100));

    assert_eq!(used, U128(0));
    assert_eq!(contract.ft_balance_of(owner), U128(1_000));
    assert_eq!(contract.ft_balance_of(receiver), U128(0));
    assert_eq!(contract.ft_total_supply(), U128(1_000));
}

#[test]
#[should_panic]
fn resolver_is_private() {
    let (mut contract, owner, receiver) = fixture();
    register(&mut contract, &receiver);

    testing_env!(context(&owner, 0).build());
    contract.ft_resolve_transfer(owner, receiver, U128(100));
}
