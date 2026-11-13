// LOCAL unit tests for the ShowStake factory/registry slice.
//
// These run in the near-sdk mocked VM and are NOT chain evidence. Real
// receipt/balance evidence is produced by
// `../../test-support/contract-integration/runner/src/bin/factory_runner.rs`
// against a temporary local NEAR Sandbox with the existing FT fixture and the
// frozen leaf artifact.

#![allow(deprecated)]

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::json_types::{U128, Base64VecU8};
use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::{env, AccountId, Gas, NearToken, PromiseOrValue, PromiseResult};
use showstake_factory::{
    Contract, ProvisionState, CHILD_STORAGE_MARGIN_BYTES, FACTORY_POLICY_IDENTITY,
    LEAF_POLICY_IDENTITY, PENDING_TIMEOUT_BLOCKS, SCHEMA_VERSION,
};

const FACTORY: &str = "factory.testnet";
const FT: &str = "ft.testnet";
const PROVIDER: &str = "provider.testnet";
fn leaf() -> Base64VecU8 { Base64VecU8(include_bytes!("../../../test-support/contract-integration/wasm/showstake-mainnet-review.wasm").to_vec()) }
const NETWORK: &str = "testnet";
const LEAF_SHA256: &str = "03076c4a9496e8ae1e6af68c791752d4a7220597942effd0c3a1839a252be9d2";
const NOW_MS: u64 = 1_700_000_000_000;
const YEAR_MS: u64 = 365 * 24 * 3_600_000;

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(predecessor: &AccountId, attached: u128, gas_tgas: u64, block: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acct(FACTORY))
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(attached))
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .account_balance(NearToken::from_near(10_000))
        .block_timestamp(NOW_MS * 1_000_000)
        .block_height(block);
    builder
}

fn new_contract() -> Contract {
    testing_env!(context(&acct("deployer.testnet"), 0, 300, 1).build());
    Contract::new(ft(), NETWORK.to_string(), LEAF_POLICY_IDENTITY.to_string(), acct(PROVIDER), "MOCK_TESTNET".into())
}

fn ft() -> AccountId {
    acct(FT)
}

fn organizer() -> AccountId {
    acct("organizer.testnet")
}

fn intruder() -> AccountId {
    acct("intruder.testnet")
}

fn quote_for(contract: &Contract, organizer: &AccountId) -> (u128, u128) {
    let quote = contract.quote_provision(organizer.clone());
    (quote.child_funding.0, quote.registry_fee.0)
}

/// Provide a context for a call by the organizer with the quote attached.
fn fund_context(contract: &Contract, organizer: &AccountId, surplus: u128) -> (VMContextBuilder, u128) {
    let (child, fee) = quote_for(contract, organizer);
    let total = child + fee + surplus;
    (context(organizer, total, 300, 10), total)
}

fn probe_json() -> Vec<u8> {
    near_sdk::serde_json::json!({
        "organizer": organizer(),
        "canonical_ft": ft(),
        "network": NETWORK,
        "policy_version": LEAF_POLICY_IDENTITY,
        "provider_account": PROVIDER,
        "provider_kind": "MOCK_TESTNET",
    })
    .to_string()
    .into_bytes()
}

#[test]
fn config_is_immutable_and_pins_leaf_hash() {
    let contract = new_contract();
    let view = contract.get_config();
    assert_eq!(view.canonical_ft, ft());
    assert_eq!(view.network, NETWORK);
    assert_eq!(view.leaf_policy_version, LEAF_POLICY_IDENTITY);
    assert_eq!(view.leaf_code_sha256, LEAF_SHA256);
    assert_eq!(view.factory_policy_identity, FACTORY_POLICY_IDENTITY);
    assert_eq!(view.schema_version, SCHEMA_VERSION);
    assert_eq!(view.storage_byte_cost.0, 10_000_000_000_000_000_000);
    assert_eq!(view.child_storage_margin_bytes.0, CHILD_STORAGE_MARGIN_BYTES);
}

#[test]
fn new_rejects_wrong_policy() {
    testing_env!(context(&acct("deployer.testnet"), 0, 300, 1).build());
    let result = catch_unwind(AssertUnwindSafe(|| {
        Contract::new(ft(), NETWORK.to_string(), "showstake-v2/1".to_string(), acct(PROVIDER), "MOCK_TESTNET".into())
    }));
    assert!(result.is_err());
}

#[test]
fn new_rejects_invalid_network() {
    testing_env!(context(&acct("deployer.testnet"), 0, 300, 1).build());
    let result = catch_unwind(AssertUnwindSafe(|| {
        Contract::new(ft(), "bad\nnetwork".to_string(), LEAF_POLICY_IDENTITY.to_string(), acct(PROVIDER), "MOCK_TESTNET".into())
    }));
    assert!(result.is_err());
}

#[test]
fn new_rejects_long_parent_account() {
    let long = format!("{}.testnet", "a".repeat(48));
    let mut ctx=context(&acct("deployer.testnet"), 0, 300, 1); ctx.current_account_id(acct(&long)); testing_env!(ctx.build());
    let result = catch_unwind(AssertUnwindSafe(|| {
        Contract::new(ft(), NETWORK.to_string(), LEAF_POLICY_IDENTITY.to_string(), acct(PROVIDER), "MOCK_TESTNET".into())
    }));
    assert!(result.is_err());
}

#[test]
fn child_id_is_deterministic_and_bounded() {
    let contract = new_contract();
    let first = contract.get_child_id(organizer(), 1);
    let again = contract.get_child_id(organizer(), 1);
    let other_nonce = contract.get_child_id(organizer(), 2);
    let other_organizer = contract.get_child_id(intruder(), 1);
    assert_eq!(first, again);
    assert_ne!(first, other_nonce);
    assert_ne!(first, other_organizer);
    let text = first.as_str();
    assert_eq!(text.len(), 16 + 1 + FACTORY.len());
    assert!(text.ends_with(".factory.testnet"));
    assert!(
        text[..16]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    assert!(first.as_str().len() <= 64);
}

#[test]
fn quote_is_positive_and_linear_in_organizer_length() {
    let contract = new_contract();
    let short = contract.quote_provision(acct("o.testnet"));
    let long = contract.quote_provision(acct("organizer-with-a-longer-name.testnet"));
    assert!(short.child_funding.0 > 2_000_000_000_000_000_000_000_000);
    assert!(short.registry_fee.0 > 0);
    assert_eq!(short.total.0, short.child_funding.0 + short.registry_fee.0);
    assert!(long.child_funding.0 > short.child_funding.0);
    assert_eq!(
        long.child_funding.0 - short.child_funding.0,
        (long.organizer.as_str().len() - short.organizer.as_str().len()) as u128
            * 10_000_000_000_000_000_000
    );
}

#[test]
fn provision_measures_exact_registry_fee() {
    let mut contract = new_contract();
    let (ctx, attached) = fund_context(&contract, &organizer(), 0);
    testing_env!(ctx.build());
    let result = contract.provision(7, leaf());
    assert!(matches!(result, PromiseOrValue::Promise(_)));
    let view = contract.get_request(organizer(), 7);
    assert_eq!(view.state, ProvisionState::Pending);
    assert_eq!(view.attached.0, attached);
    assert_eq!(view.excess_refunded.0, 0);
    assert_eq!(view.child_funding.0 + view.registry_fee.0 + view.excess_refunded.0, attached);
    let accounting = contract.get_native_accounting();
    assert_eq!(accounting.funding_committed.0, view.child_funding.0);
    assert_eq!(accounting.funding_held.0, view.child_funding.0);
    assert_eq!(accounting.registry_fees_collected.0, view.registry_fee.0);
    assert_eq!(accounting.total_requests, 1);
}

#[test]
fn quote_matches_measured_fee_for_first_and_second_rows() {
    let mut contract = new_contract();
    let (first_child, first_fee) = quote_for(&contract, &organizer());
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    testing_env!(ctx.build());
    contract.provision(1, leaf());
    let first = contract.get_request(organizer(), 1);
    assert_eq!(first.child_funding.0, first_child);
    assert_eq!(first.registry_fee.0, first_fee, "first-row quote must equal measured growth");

    let second_quote = contract.quote_provision(organizer());
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    testing_env!(ctx.build());
    contract.provision(2, leaf());
    let second = contract.get_request(organizer(), 2);
    assert_eq!(second.child_funding.0, second_quote.child_funding.0);
    assert_eq!(
        second.registry_fee.0, second_quote.registry_fee.0,
        "second-row quote must equal measured growth"
    );
    assert!(second.registry_fee.0 < first_fee, "count row is absent on later requests");
}

#[test]
fn provision_success_callback_marks_ready_only_once() {
    let mut contract = new_contract();
    let (ctx, attached) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 9);
    testing_env!(ctx.build());
    contract.provision(9, leaf());
    let pending = contract.get_request(organizer(), 9);
    assert_eq!(pending.state, ProvisionState::Pending);

    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 11).build(),
        PromiseResult::Successful(Vec::new()),
    );
    let first = contract.on_provision(organizer(), 9, child.clone(), 1);
    let view = match first {
        PromiseOrValue::Value(view) => view,
        PromiseOrValue::Promise(_) => panic!("success callback must return a value"),
    };
    assert_eq!(view.state, ProvisionState::Ready);
    assert_eq!(view.ready_at_ms, NOW_MS);
    let accounting = contract.get_native_accounting();
    assert_eq!(accounting.funding_delivered.0, view.child_funding.0);
    assert_eq!(accounting.funding_refunded.0, 0);
    assert_eq!(accounting.funding_held.0, 0);
    assert_eq!(accounting.registry_fees_collected.0, attached - view.child_funding.0);

    // Duplicate callback is a terminal no-op, not a second delivery.
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 12).build(),
        PromiseResult::Successful(Vec::new()),
    );
    let second = contract.on_provision(organizer(), 9, child, 1);
    assert!(matches!(second, PromiseOrValue::Value(_)));
    let accounting = contract.get_native_accounting();
    assert_eq!(accounting.funding_delivered.0, view.child_funding.0);
    assert_eq!(accounting.funding_held.0, 0);
}

#[test]
fn provision_failure_callback_refunds_once_and_keeps_fee() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 11);
    testing_env!(ctx.build());
    contract.provision(11, leaf());
    let pending = contract.get_request(organizer(), 11);

    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 12).build(),
        PromiseResult::Failed,
    );
    let first = contract.on_provision(organizer(), 11, child.clone(), 1);
    assert!(matches!(first, PromiseOrValue::Value(_)));
    let view = contract.get_request(organizer(), 11);
    assert_eq!(view.state, ProvisionState::Failed);
    assert_eq!(view.ready_at_ms, 0);
    let accounting = contract.get_native_accounting();
    assert_eq!(accounting.funding_refunded.0, 0);
    assert_eq!(accounting.funding_delivered.0, 0);
    assert_eq!(accounting.funding_held.0, pending.child_funding.0);
    testing_env!(context(&organizer(), 0, 100, 12).build()); drop(contract.claim_failed_funding(11));
    testing_env_with_promise_results(context(&acct(FACTORY), 0, 80, 12).build(), PromiseResult::Failed);
    assert!(!contract.on_failed_funding_refund(organizer(),11,1));
    testing_env!(context(&organizer(), 0, 100, 12).build()); drop(contract.claim_failed_funding(11));
    testing_env_with_promise_results(context(&acct(FACTORY), 0, 80, 12).build(), PromiseResult::Successful(vec![]));
    assert!(contract.on_failed_funding_refund(organizer(),11,2));
    assert_eq!(accounting.registry_fees_collected.0, pending.registry_fee.0);

    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 13).build(),
        PromiseResult::Failed,
    );
    let second = contract.on_provision(organizer(), 11, child, 1);
    assert!(matches!(second, PromiseOrValue::Value(_)));
    assert_eq!(
        contract.get_native_accounting().funding_refunded.0,
        pending.child_funding.0
    );
}

#[test]
fn replay_ready_refunds_attached_without_new_child_or_fee() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 21);
    testing_env!(ctx.build());
    contract.provision(21, leaf());
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 12).build(),
        PromiseResult::Successful(Vec::new()),
    );
    contract.on_provision(organizer(), 21, child, 1);
    let before = contract.get_native_accounting();

    testing_env!(context(&organizer(), 5_000, 120, 13).build());
    let replay = catch_unwind(AssertUnwindSafe(|| contract.provision(21, leaf())));
    assert!(replay.is_err());
    let after = contract.get_native_accounting();
    assert_eq!(after.total_requests, before.total_requests);
    assert_eq!(after.registry_fees_collected, before.registry_fees_collected);
    assert_eq!(after.funding_committed, before.funding_committed);
    assert_eq!(contract.get_request(organizer(), 21).state, ProvisionState::Ready);

    testing_env!(context(&organizer(), 0, 120, 14).build());
    let replay_view = contract.provision(21, leaf());
    assert!(matches!(replay_view, PromiseOrValue::Value(_)));
    assert_eq!(contract.list_children(organizer(), 0, 20).len(), 1);
}

#[test]
fn replay_pending_traps() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    testing_env!(ctx.build());
    contract.provision(31, leaf());
    testing_env!(context(&organizer(), 1_000, 120, 12).build());
    let result = catch_unwind(AssertUnwindSafe(|| contract.provision(31, leaf())));
    assert!(result.is_err());
    assert_eq!(contract.get_request(organizer(), 31).state, ProvisionState::Pending);
}

#[test]
fn insufficient_attached_traps_without_row() {
    let mut contract = new_contract();
    let (child, fee) = quote_for(&contract, &organizer());
    let required = child + fee;
    testing_env!(context(&organizer(), required - 1, 300, 10).build());
    let result = catch_unwind(AssertUnwindSafe(|| contract.provision(41, leaf())));
    assert!(result.is_err());
    let missing = catch_unwind(AssertUnwindSafe(|| contract.get_request(organizer(), 41)));
    assert!(missing.is_err());
    assert!(contract.list_children(organizer(), 0, 20).is_empty());
    assert_eq!(contract.get_native_accounting().total_requests, 0);
    assert_eq!(contract.get_native_accounting().registry_fees_collected.0, 0);
}

#[test]
fn insufficient_prepaid_gas_traps_without_row() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let mut builder = ctx;
    builder.prepaid_gas(Gas::from_tgas(119));
    testing_env!(builder.build());
    let result = catch_unwind(AssertUnwindSafe(|| contract.provision(42, leaf())));
    assert!(result.is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| contract.get_request(organizer(), 42))).is_err());
    assert_eq!(contract.get_native_accounting().total_requests, 0);
}

#[test]
fn private_callback_rejects_external_callers() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 51);
    testing_env!(ctx.build());
    contract.provision(51, leaf());

    testing_env_with_promise_results(
        context(&intruder(), 0, 80, 12).build(),
        PromiseResult::Successful(Vec::new()),
    );
    let result = catch_unwind(AssertUnwindSafe(|| {
        contract.on_provision(organizer(), 51, child, 1)
    }));
    assert!(result.is_err());
    assert_eq!(contract.get_request(organizer(), 51).state, ProvisionState::Pending);

    testing_env_with_promise_results(
        context(&intruder(), 0, 80, 12).build(),
        PromiseResult::Successful(probe_json()),
    );
    let result = catch_unwind(AssertUnwindSafe(|| {
        contract.on_resolve(organizer(), 51)
    }));
    assert!(result.is_err());
}

#[test]
fn callback_argument_mismatch_traps() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 61);
    testing_env!(ctx.build());
    contract.provision(61, leaf());
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 12).build(),
        PromiseResult::Successful(Vec::new()),
    );
    let wrong_child = contract.get_child_id(organizer(), 62);
    let result = catch_unwind(AssertUnwindSafe(|| {
        contract.on_provision(organizer(), 61, wrong_child, 1)
    }));
    assert!(result.is_err());
    assert_eq!(contract.get_request(organizer(), 61).state, ProvisionState::Pending);
}

#[test]
fn resolve_requires_pending_timeout() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    testing_env!(ctx.build());
    contract.provision(71, leaf());
    let pending = contract.get_request(organizer(), 71);
    let ready_block = pending.created_block + PENDING_TIMEOUT_BLOCKS;

    testing_env!(context(&intruder(), 0, 100, ready_block - 1).build());
    let too_early = catch_unwind(AssertUnwindSafe(|| {
        contract.resolve_request(organizer(), 71)
    }));
    assert!(too_early.is_err());

    testing_env!(context(&intruder(), 0, 100, ready_block).build());
    let _promise: near_sdk::Promise = contract.resolve_request(organizer(), 71);
    assert_eq!(contract.get_request(organizer(), 71).state, ProvisionState::Pending);
}

#[test]
fn resolve_success_marks_ready_without_second_funding() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 81);
    testing_env!(ctx.build());
    contract.provision(81, leaf());
    let pending = contract.get_request(organizer(), 81);
    testing_env!(context(&intruder(), 0, 100, pending.created_block + 200).build());
    contract.resolve_request(organizer(), 81);

    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 300).build(),
        PromiseResult::Successful(probe_json()),
    );
    let result = contract.on_resolve(organizer(), 81);
    assert!(matches!(result, PromiseOrValue::Value(_)));
    assert_eq!(contract.get_request(organizer(), 81).state, ProvisionState::Ready);
    assert_eq!(
        contract.get_child(child).state,
        ProvisionState::Ready
    );
    let accounting = contract.get_native_accounting();
    assert_eq!(accounting.funding_delivered.0, pending.child_funding.0);
    assert_eq!(accounting.funding_refunded.0, 0);
    assert_eq!(accounting.funding_held.0, 0);
}

#[test]
fn resolve_mismatched_or_failed_probe_stays_pending() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 91);
    testing_env!(ctx.build());
    contract.provision(91, leaf());
    let pending = contract.get_request(organizer(), 91);
    testing_env!(context(&intruder(), 0, 100, pending.created_block + 200).build());
    contract.resolve_request(organizer(), 91);

    let wrong_config = near_sdk::serde_json::json!({
        "organizer": intruder(),
        "canonical_ft": ft(),
        "network": NETWORK,
        "policy_version": LEAF_POLICY_IDENTITY,
        "provider_account": PROVIDER,
        "provider_kind": "MOCK_TESTNET",
    })
    .to_string()
    .into_bytes();
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 300).build(),
        PromiseResult::Successful(wrong_config),
    );
    let result = contract.on_resolve(organizer(), 91);
    assert!(matches!(result, PromiseOrValue::Value(_)));
    assert_eq!(contract.get_request(organizer(), 91).state, ProvisionState::Pending);
    let accounting = contract.get_native_accounting();
    assert_eq!(accounting.funding_refunded.0, 0);
    assert_eq!(accounting.funding_held.0, pending.child_funding.0);

    // A second resolve callback cannot refund twice.
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 301).build(),
        PromiseResult::Failed,
    );
    let second = contract.on_resolve(organizer(), 91);
    assert!(matches!(second, PromiseOrValue::Value(_)));
    assert_eq!(
        contract.get_native_accounting().funding_refunded.0,
        0
    );
    assert_eq!(contract.get_child(child).state, ProvisionState::Pending);
}

#[test]
fn list_children_is_bounded_and_ordered() {
    let mut contract = new_contract();
    let first = contract.get_child_id(organizer(), 1);
    let second = contract.get_child_id(organizer(), 2);
    for nonce in [1u64, 2u64] {
        let (ctx, _) = fund_context(&contract, &organizer(), 0);
        testing_env!(ctx.build());
        contract.provision(nonce, leaf());
    }
    let listed = contract.list_children(organizer(), 0, 20);
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].child_id, first);
    assert_eq!(listed[1].child_id, second);

    testing_env!(context(&organizer(), 0, 100, 20).build());
    assert!(contract.list_children(organizer(), 10, 20).is_empty());
    let zero = catch_unwind(AssertUnwindSafe(|| contract.list_children(organizer(), 0, 0)));
    assert!(zero.is_err());
    let too_many = catch_unwind(AssertUnwindSafe(|| contract.list_children(organizer(), 0, 21)));
    assert!(too_many.is_err());
}

#[test]
fn native_accounting_is_native_only() {
    let contract = new_contract();
    let view = contract.get_native_accounting();
    assert!(!view.ft_interface_present);
    assert_eq!(view.funding_committed.0, 0);
    assert_eq!(view.funding_delivered.0, 0);
    assert_eq!(view.funding_refunded.0, 0);
    assert_eq!(view.funding_held.0, 0);
    assert_eq!(view.total_requests, 0);
    assert_eq!(view.account_balance.0, 10_000_000_000_000_000_000_000_000_000);
}

#[test]
fn cardle_unused_u128_import_guard() {
    // Keep the U128 re-export exercised for downstream ABI tests.
    let value = U128(7);
    assert_eq!(value.0, 7);
    assert!(env::storage_byte_cost().as_yoctonear() > 0);
    assert!(YEAR_MS > 0);
}

#[test]
fn rejects_wrong_code_length_and_same_length_hash() {
    for invalid in [Base64VecU8(vec![]), {let mut x=leaf().0; x[0]^=1; Base64VecU8(x)}] {
        let mut c=new_contract(); let (ctx,_)=fund_context(&c,&organizer(),0); testing_env!(ctx.build());
        assert!(catch_unwind(AssertUnwindSafe(|| c.provision(700,invalid))).is_err());
        assert_eq!(c.get_native_accounting().total_requests,0);
    }
}

#[test]
fn mainnet_identity_is_pinned() {
    let mut ctx=context(&acct("deployer.near"),0,300,1); ctx.current_account_id(acct("factory.near")); testing_env!(ctx.build());
    let usdc=acct("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"); let provider=acct("contract.main.burrow.near");
    let c=Contract::new(usdc.clone(),"mainnet".into(),showstake_factory::MAINNET_LEAF_POLICY_IDENTITY.into(),provider.clone(),"RHEA_MAINNET".into());
    assert_eq!(c.get_config().provider_account,provider); assert_eq!(c.get_config().leaf_code_len,224939);
    assert_eq!(c.get_config().leaf_policy_version, showstake_factory::MAINNET_LEAF_POLICY_IDENTITY);
    assert!(catch_unwind(AssertUnwindSafe(|| Contract::new(usdc.clone(),"mainnet".into(),LEAF_POLICY_IDENTITY.into(),provider,"RHEA_MAINNET".into()))).is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| Contract::new(usdc,"mainnet".into(),showstake_factory::MAINNET_LEAF_POLICY_IDENTITY.into(),acct("evil.near"),"RHEA_MAINNET".into()))).is_err());
}

#[test]
fn oversized_callback_results_do_not_release_or_retry_funds() {
    let mut contract = new_contract();
    let (ctx, _) = fund_context(&contract, &organizer(), 0);
    let child = contract.get_child_id(organizer(), 801);
    testing_env!(ctx.build());
    drop(contract.provision(801, leaf()));
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 12).build(),
        PromiseResult::Successful(vec![0; 8192]),
    );
    drop(contract.on_provision(organizer(), 801, child.clone(), 1));
    assert_eq!(contract.get_request(organizer(), 801).state, ProvisionState::Pending);
    assert_eq!(contract.get_native_accounting().funding_refunded.0, 0);
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 13).build(), PromiseResult::Failed,
    );
    drop(contract.on_provision(organizer(), 801, child, 1));
    testing_env!(context(&organizer(), 0, 100, 14).build());
    drop(contract.claim_failed_funding(801));
    testing_env_with_promise_results(
        context(&acct(FACTORY), 0, 80, 15).build(),
        PromiseResult::Successful(vec![0; 8192]),
    );
    assert!(!contract.on_failed_funding_refund(organizer(), 801, 1));
    assert_eq!(format!("{:?}", contract.get_request(organizer(), 801).refund_state), "InFlight");
    assert_eq!(contract.get_native_accounting().funding_refunded.0, 0);
}
