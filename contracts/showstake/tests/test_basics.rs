// LOCAL unit tests for the ShowStake product slice.
//
// These run in the near-sdk mocked VM and are NOT chain evidence. Real
// receipt/balance evidence is produced by `../../tests/runner` against a
// temporary local NEAR Sandbox with the existing FT fixture.

use near_sdk::json_types::U128;
#[allow(deprecated)]
use near_sdk::test_utils::{testing_env_with_promise_results, VMContextBuilder};
use near_sdk::testing_env;
use near_sdk::{env, AccountId, NearToken, PromiseOrValue, PromiseResult};
use showstake::{Contract, EventRules};

const NOW: u64 = 1_700_000_000_000;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;
const FT: &str = "ft.sandbox";
const CONTRACT: &str = "showstake.sandbox";

fn acct(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn ft() -> AccountId {
    acct(FT)
}

fn context(predecessor: &AccountId, attached_yocto: u128, now_ms: u64) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(acct(CONTRACT))
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(attached_yocto))
        .account_balance(NearToken::from_near(1_000))
        .block_timestamp(now_ms * 1_000_000);
    builder
}

fn new_contract() -> Contract {
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW).build());
    Contract::new(
        acct("organizer.sandbox"),
        ft(),
        "sandbox-local".to_string(),
        showstake::POLICY_IDENTITY.to_string(),
    )
}

fn default_rules(deposit: u128, capacity: u32) -> EventRules {
    EventRules {
        rules_hash: "local-rules-v1".to_string(),
        deposit: U128(deposit),
        capacity,
        reg_open: NOW,
        reg_close: NOW + HOUR_MS,
        cancel_cutoff: NOW + HOUR_MS,
        checkin_open: NOW + HOUR_MS,
        checkin_close: NOW + 2 * HOUR_MS,
    }
}

fn publish_with(contract: &mut Contract, organizer: &AccountId, event_id: &str, rules: EventRules) {
    testing_env!(context(organizer, NearToken::from_near(1).as_yoctonear(), NOW).build());
    contract.publish_event(event_id.to_string(), rules);
}

fn publish(contract: &mut Contract, organizer: &AccountId, event_id: &str) {
    publish_with(contract, organizer, event_id, default_rules(100, 10));
}

fn prepay(contract: &mut Contract, account: &AccountId, yocto: u128) {
    testing_env!(context(account, yocto, NOW).build());
    contract.storage_deposit(None);
}

fn commit_msg(event_id: &str, commitment_id: &str) -> String {
    format!(
        r#"{{"version":1,"event_id":"{event_id}","commitment_id":"{commitment_id}"}}"#
    )
}

fn deposit_from(
    contract: &mut Contract,
    predecessor: &AccountId,
    sender: &AccountId,
    amount: u128,
    msg: &str,
    now_ms: u64,
) -> PromiseOrValue<U128> {
    testing_env!(context(predecessor, 1, now_ms).build());
    contract.ft_on_transfer(sender.clone(), U128(amount), msg.to_string())
}

fn ft_deposit(
    contract: &mut Contract,
    sender: &AccountId,
    amount: u128,
    msg: &str,
    now_ms: u64,
) -> PromiseOrValue<U128> {
    deposit_from(contract, &ft(), sender, amount, msg, now_ms)
}

fn assert_accepted(result: PromiseOrValue<U128>) {
    match result {
        PromiseOrValue::Value(value) => assert_eq!(value, U128(0), "accept must return 0 unused"),
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer must accept synchronously"),
    }
}

fn assert_refunded(result: PromiseOrValue<U128>, amount: u128) {
    match result {
        PromiseOrValue::Value(value) => {
            assert_eq!(value, U128(amount), "invalid path must return the full amount")
        }
        PromiseOrValue::Promise(_) => panic!("ft_on_transfer must return a value, not a promise"),
    }
}

fn first_registration(contract: &Contract, event_id: &str) -> showstake::RegistrationView {
    contract
        .list_event_registrations(event_id.to_string(), 0, 10)
        .into_iter()
        .next()
        .expect("expected one registration")
}

fn claim_as(contract: &mut Contract, account: &AccountId, registration_id: &str, now_ms: u64) {
    testing_env!(context(account, 1, now_ms).build());
    let _ = contract.claim(registration_id.to_string());
}

#[allow(deprecated)]
fn callback_result(success: bool, now_ms: u64) {
    let result = if success {
        PromiseResult::Successful(Vec::new())
    } else {
        PromiseResult::Failed
    };
    testing_env_with_promise_results(context(&acct(CONTRACT), 0, now_ms).build(), result);
}

fn assert_panics<F: FnOnce()>(f: F) {
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).is_err(),
        "expected the call to panic"
    );
}

fn accepted_setup() -> (Contract, AccountId, AccountId) {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    let result = ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1);
    assert_accepted(result);
    (contract, organizer, alice)
}

#[test]
fn new_sets_immutable_config() {
    let contract = new_contract();
    let config = contract.get_config();
    assert_eq!(config.organizer, acct("organizer.sandbox"));
    assert_eq!(config.canonical_ft, ft());
    assert_eq!(config.network, "sandbox-local");
    assert_eq!(config.policy_version, showstake::POLICY_IDENTITY);
    assert_ne!(showstake::POLICY_IDENTITY, "showstake-v2/1");
    assert_ne!(showstake::POLICY_IDENTITY, "showstake-v2-d036/1");
}

#[test]
fn legacy_policy_identity_is_rejected() {
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW).build());
    assert_panics(|| {
        Contract::new(
            acct("organizer.sandbox"),
            ft(),
            "sandbox-local".to_string(),
            "showstake-v2/1".to_string(),
        );
    });
    // The accepted v5 identity is also a different generation: the settlement
    // build must not be silently labelled with it.
    assert_panics(|| {
        Contract::new(
            acct("organizer.sandbox"),
            ft(),
            "sandbox-local".to_string(),
            "showstake-v2-d036/1".to_string(),
        );
    });
}

#[test]
fn publish_sets_predecessor_organizer_and_checked_deadline() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    testing_env!(context(&organizer, NearToken::from_near(2).as_yoctonear(), NOW).build());
    let event = contract.publish_event("evt-1".to_string(), default_rules(100, 10));
    assert_eq!(event.organizer, organizer);
    assert_eq!(event.finalize_deadline, NOW + 2 * HOUR_MS + DAY_MS);
    assert_eq!(event.deposit, U128(100));
    assert_eq!(event.capacity, 10);
    assert_eq!(event.active_registrations, 0);
    assert_eq!(event.total_registrations, 0);
    assert_eq!(event.accepted_principal, U128(0));
    assert_eq!(event.phase, showstake::EventPhase::RegistrationOpen);
    // Event storage was charged from the attached prepaid credit.
    assert!(contract.storage_balance_of(organizer.clone()).0 < NearToken::from_near(2).as_yoctonear());
    assert_eq!(contract.get_escrow_principal(), U128(0));
}

#[test]
#[should_panic(expected = "deposit must be positive")]
fn publish_rejects_zero_deposit() {
    let mut contract = new_contract();
    publish_with(
        &mut contract,
        &acct("organizer.sandbox"),
        "evt-bad",
        default_rules(0, 10),
    );
}

#[test]
#[should_panic(expected = "reg_open must be < reg_close")]
fn publish_rejects_unordered_times() {
    let mut contract = new_contract();
    let mut rules = default_rules(100, 10);
    rules.reg_close = rules.reg_open;
    publish_with(&mut contract, &acct("organizer.sandbox"), "evt-bad", rules);
}

#[test]
#[should_panic(expected = "capacity must be 1..=200")]
fn publish_rejects_capacity_above_200() {
    let mut contract = new_contract();
    publish_with(
        &mut contract,
        &acct("organizer.sandbox"),
        "evt-bad",
        default_rules(100, 201),
    );
}

#[test]
#[should_panic(expected = "event already published")]
fn publish_rejects_duplicate_event_id() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    publish(&mut contract, &organizer, "evt-1");
}

#[test]
fn exact_deposit_creates_one_registration_and_pass_in_one_value_return() {
    let (contract, _organizer, alice) = accepted_setup();
    let event = contract.get_event("evt-1".to_string());
    assert_eq!(event.active_registrations, 1);
    assert_eq!(event.total_registrations, 1);
    assert_eq!(event.accepted_principal, U128(100));
    assert_eq!(contract.get_escrow_principal(), U128(100));

    let registrations = contract.list_event_registrations("evt-1".to_string(), 0, 10);
    assert_eq!(registrations.len(), 1);
    let registration = &registrations[0];
    assert_eq!(registration.participant, alice);
    assert_eq!(registration.beneficiary, alice);
    assert_eq!(registration.amount, U128(100));
    assert_eq!(registration.event_sequence, 0);
    assert_eq!(registration.registration_status, showstake::RegistrationStatus::Active);

    let pass = contract.get_pass(registration.pass_id.clone());
    assert_eq!(pass.owner, alice);
    assert_eq!(pass.registration_id, registration.registration_id);
    assert_eq!(pass.event_id, "evt-1");
    assert_eq!(pass.attendance_status, showstake::AttendanceStatus::NotMarked);
    assert_eq!(pass.financial_status, showstake::FinancialStatus::Committed);
    assert_eq!(pass.policy_version, showstake::POLICY_IDENTITY);
}

#[test]
fn participant_storage_credit_is_charged_measured_usage() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    let before = contract.storage_balance_of(alice.clone()).0;
    assert!(before > 0);
    assert_accepted(ft_deposit(
        &mut contract,
        &alice,
        100,
        &commit_msg("evt-1", "alice-c1"),
        NOW + 1,
    ));
    let after = contract.storage_balance_of(alice.clone()).0;
    assert!(after < before, "registration storage must consume prepaid credit");
}

#[test]
fn wrong_predecessor_returns_full_amount_and_no_state() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    let result = deposit_from(
        &mut contract,
        &acct("ft-b.sandbox"),
        &alice,
        100,
        &commit_msg("evt-1", "alice-c1"),
        NOW + 1,
    );
    assert_refunded(result, 100);
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 0);
    assert_eq!(contract.get_escrow_principal(), U128(0));
    assert!(contract.list_event_registrations("evt-1".to_string(), 0, 10).is_empty());
}

#[test]
fn wrong_amount_returns_full_amount_and_no_state() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    let result = ft_deposit(&mut contract, &alice, 99, &commit_msg("evt-1", "alice-c1"), NOW + 1);
    assert_refunded(result, 99);
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 0);
    assert_eq!(contract.get_escrow_principal(), U128(0));
    assert!(contract.list_event_registrations("evt-1".to_string(), 0, 10).is_empty());
}

#[test]
fn wrong_message_version_returns_full_amount() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    let msg = r#"{"version":2,"event_id":"evt-1","commitment_id":"alice-c1"}"#;
    assert_refunded(ft_deposit(&mut contract, &alice, 100, msg, NOW + 1), 100);
    assert_eq!(contract.get_escrow_principal(), U128(0));
}

#[test]
fn owner_override_field_in_message_is_rejected() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    let msg = r#"{"version":1,"event_id":"evt-1","commitment_id":"alice-c1","owner_id":"bob.sandbox"}"#;
    assert_refunded(ft_deposit(&mut contract, &alice, 100, msg, NOW + 1), 100);
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 0);
    assert_eq!(contract.get_escrow_principal(), U128(0));
}

#[test]
fn second_publish_is_denied_without_state_or_credit_change() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));

    let event_before = contract.get_event("evt-1".to_string());
    let organizer_credit_before = contract.storage_balance_of(organizer.clone()).0;
    let alice_credit_before = contract.storage_balance_of(alice.clone()).0;
    let escrow_before = contract.get_escrow_principal();
    let attached = NearToken::from_near(1).as_yoctonear();
    testing_env!(context(&organizer, attached, NOW).build());
    let usage_before = env::storage_usage();
    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.publish_event("evt-2".to_string(), default_rules(100, 10));
    }));
    assert!(rejected.is_err(), "a contract must host exactly one event");
    assert_eq!(env::storage_usage(), usage_before, "denied publish must not write state");
    assert_eq!(
        contract.storage_balance_of(organizer.clone()).0,
        organizer_credit_before,
        "denied publish must not consume or credit native storage"
    );
    assert_eq!(
        contract.storage_balance_of(alice.clone()).0,
        alice_credit_before
    );
    assert_eq!(contract.get_escrow_principal(), escrow_before);
    assert_eq!(contract.list_events(0, 10).len(), 1);
    let event_after = contract.get_event("evt-1".to_string());
    assert_eq!(event_after.event_id, event_before.event_id);
    assert_eq!(event_after.organizer, event_before.organizer);
    assert_eq!(event_after.total_registrations, event_before.total_registrations);
    assert_eq!(event_after.accepted_principal, event_before.accepted_principal);
}

#[test]
fn unauthorized_publisher_is_denied_without_state_or_credit() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let intruder = acct("intruder.sandbox");
    let attached = NearToken::from_near(1).as_yoctonear();
    testing_env!(context(&intruder, attached, NOW).build());
    let usage_before = env::storage_usage();
    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.publish_event("evt-1".to_string(), default_rules(100, 10));
    }));
    assert!(rejected.is_err(), "only the immutable configured organizer may publish");
    assert_eq!(env::storage_usage(), usage_before, "denied publish must not write state");
    assert_eq!(contract.storage_balance_of(intruder.clone()), U128(0));
    assert_eq!(contract.list_events(0, 10).len(), 0);

    // The configured organizer can still publish and pays the new credit-entry
    // plus event storage from this attached deposit.
    testing_env!(context(&organizer, attached, NOW).build());
    let before = env::storage_usage();
    let event = contract.publish_event("evt-1".to_string(), default_rules(100, 10));
    let after = env::storage_usage();
    assert_eq!(event.organizer, organizer);
    assert_eq!(contract.list_events(0, 10).len(), 1);
    assert_eq!(
        contract.storage_balance_of(event.organizer).0,
        attached - storage_cost_of(after - before)
    );
}

#[test]
fn duplicate_active_account_on_same_event_is_rejected() {
    let (mut contract, _organizer, alice) = accepted_setup();
    assert_refunded(
        ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c2"), NOW + 2),
        100,
    );
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 1);
    assert_eq!(contract.get_escrow_principal(), U128(100));
}

#[test]
fn capacity_full_is_rejected() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    publish_with(&mut contract, &organizer, "evt-1", default_rules(100, 1));
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));
    assert_refunded(
        ft_deposit(&mut contract, &bob, 100, &commit_msg("evt-1", "bob-c1"), NOW + 2),
        100,
    );
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 1);
    assert_eq!(contract.get_escrow_principal(), U128(100));
}

#[test]
fn closed_phase_returns_full_amount() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let mut rules = default_rules(100, 10);
    rules.reg_open = NOW - 2 * HOUR_MS;
    rules.reg_close = NOW - HOUR_MS;
    rules.cancel_cutoff = NOW - HOUR_MS;
    rules.checkin_open = NOW - HOUR_MS;
    rules.checkin_close = NOW + HOUR_MS;
    publish_with(&mut contract, &organizer, "evt-closed", rules);
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    assert_refunded(
        ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-closed", "alice-c1"), NOW),
        100,
    );
    assert_eq!(contract.get_event("evt-closed".to_string()).active_registrations, 0);
    assert_eq!(contract.get_event("evt-closed".to_string()).phase, showstake::EventPhase::RegistrationClosed);
}

#[test]
fn registration_window_boundaries_are_half_open() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    let mut rules = default_rules(100, 10);
    rules.reg_open = NOW + 1_000;
    rules.reg_close = NOW + 1_000 + HOUR_MS;
    rules.cancel_cutoff = rules.reg_close;
    rules.checkin_open = rules.cancel_cutoff;
    rules.checkin_close = rules.checkin_open + HOUR_MS;
    publish_with(&mut contract, &organizer, "evt-1", rules);
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());

    // One millisecond before open: rejected.
    assert_refunded(
        ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 999),
        100,
    );
    // Exactly at open: accepted.
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1_000));
    // Exactly at close: rejected.
    assert_refunded(
        ft_deposit(&mut contract, &bob, 100, &commit_msg("evt-1", "bob-c1"), NOW + 1_000 + HOUR_MS),
        100,
    );
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 1);
}

#[test]
fn insufficient_prepaid_storage_returns_full_amount_and_no_state() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    // No storage_deposit for alice.
    assert_refunded(
        ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1),
        100,
    );
    assert_eq!(contract.get_event("evt-1".to_string()).active_registrations, 0);
    assert_eq!(contract.get_event("evt-1".to_string()).total_registrations, 0);
    assert_eq!(contract.get_escrow_principal(), U128(0));
    assert!(contract.list_event_registrations("evt-1".to_string(), 0, 10).is_empty());
    assert_eq!(contract.storage_balance_of(alice), U128(0));
}

#[test]
fn principal_overflow_returns_full_amount() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    publish_with(&mut contract, &organizer, "evt-max", default_rules(u128::MAX, 2));
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(
        &mut contract,
        &alice,
        u128::MAX,
        &commit_msg("evt-max", "alice-c1"),
        NOW + 1,
    ));
    assert_refunded(
        ft_deposit(&mut contract, &bob, u128::MAX, &commit_msg("evt-max", "bob-c1"), NOW + 2),
        u128::MAX,
    );
    assert_eq!(contract.get_escrow_principal(), U128(u128::MAX));
    assert_eq!(contract.get_event("evt-max".to_string()).active_registrations, 1);
}

fn storage_cost_of(bytes: u64) -> u128 {
    env::storage_byte_cost()
        .as_yoctonear()
        .checked_mul(u128::from(bytes))
        .expect("test storage cost overflow")
}

#[test]
fn storage_deposit_can_credit_another_account() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let attached = NearToken::from_millinear(300).as_yoctonear();
    testing_env!(context(&organizer, attached, NOW).build());
    let before = env::storage_usage();
    let returned = contract.storage_deposit(Some(alice.clone()));
    let after = env::storage_usage();
    // 2-byte map prefix + 4-byte Borsh string length + account id + 16-byte
    // u128 value + 40 protocol bytes per new record.
    let entry_bytes = 2 + 4 + "alice.sandbox".len() as u64 + 16 + 40;
    assert_eq!(after - before, entry_bytes, "measured new-entry footprint");
    let entry_cost = storage_cost_of(after - before);
    assert!(entry_cost > 0, "a new credit entry must consume contract storage");
    assert_eq!(
        returned.0,
        attached - entry_cost,
        "new credit entry storage must be paid from the attached deposit"
    );
    assert_eq!(contract.storage_balance_of(alice).0, returned.0);
    assert_eq!(contract.storage_balance_of(organizer).0, 0);
}

#[test]
#[should_panic(expected = "storage deposit too small for new credit entry")]
fn storage_deposit_rejects_one_yocto_new_entry() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    testing_env!(context(&organizer, 1, NOW).build());
    contract.storage_deposit(Some(alice));
}

#[test]
fn storage_deposit_rejection_restores_new_entry() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    testing_env!(context(&organizer, 1, NOW).build());
    let rejected = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.storage_deposit(Some(alice.clone()));
    }));
    assert!(rejected.is_err(), "1 yoctoNEAR must not buy a new credit entry");
    assert_eq!(
        contract.storage_balance_of(alice.clone()),
        U128(0),
        "failed prepay must leave no credit"
    );

    // The tentative entry is gone, so this adequate prepay pays the same real
    // new-entry cost rather than being treated as an existing top-up.
    let attached = NearToken::from_millinear(300).as_yoctonear();
    testing_env!(context(&organizer, attached, NOW).build());
    let before = env::storage_usage();
    let returned = contract.storage_deposit(Some(alice.clone()));
    let after = env::storage_usage();
    assert_eq!(returned.0, attached - storage_cost_of(after - before));
}

#[test]
fn storage_deposit_existing_account_topup_is_exact() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let first = NearToken::from_millinear(300).as_yoctonear();
    testing_env!(context(&organizer, first, NOW).build());
    let initial = contract.storage_deposit(Some(alice.clone())).0;
    assert!(initial > 0);

    let topup = 123_456_789_012_345_678_901u128;
    testing_env!(context(&organizer, topup, NOW).build());
    let before = env::storage_usage();
    let returned = contract.storage_deposit(Some(alice.clone()));
    let after = env::storage_usage();
    assert_eq!(after, before, "an existing u128 credit entry must not grow on top-up");
    assert_eq!(returned.0, initial + topup, "a top-up must be credited in full");
    assert_eq!(contract.storage_balance_of(alice).0, initial + topup);
}

#[test]
#[should_panic(expected = "storage deposit too small for new credit entry")]
fn publish_event_rejects_one_yocto_new_organizer() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    testing_env!(context(&organizer, 1, NOW).build());
    contract.publish_event("evt-1".to_string(), default_rules(100, 10));
}

#[test]
fn publish_event_new_organizer_charges_credit_entry_overhead() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let attached = NearToken::from_near(1).as_yoctonear();
    testing_env!(context(&organizer, attached, NOW).build());
    let before = env::storage_usage();
    contract.publish_event("evt-1".to_string(), default_rules(100, 10));
    let after = env::storage_usage();
    let total_cost = storage_cost_of(after - before);
    assert_eq!(
        contract.storage_balance_of(organizer.clone()).0,
        attached - total_cost,
        "publish must charge both the new credit entry and the event storage"
    );
    assert!(contract.storage_balance_of(organizer).0 > 0);
}

#[test]
fn publish_event_existing_organizer_charges_only_event_growth() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let prepay = NearToken::from_millinear(500).as_yoctonear();
    testing_env!(context(&organizer, prepay, NOW).build());
    let balance_after_prepay = contract.storage_deposit(None).0;
    assert!(balance_after_prepay > 0);

    // Now the organizer's credit entry already exists, so publish adds the
    // full attached top-up and charges only the measured event growth.
    let topup = NearToken::from_millinear(200).as_yoctonear();
    testing_env!(context(&organizer, topup, NOW).build());
    let before = env::storage_usage();
    contract.publish_event("evt-1".to_string(), default_rules(100, 10));
    let after = env::storage_usage();
    let event_cost = storage_cost_of(after - before);
    assert_eq!(
        contract.storage_balance_of(organizer).0,
        balance_after_prepay + topup - event_cost,
        "an existing credit entry must add its full top-up before event charging"
    );
}

#[test]
fn lists_are_bounded_and_ordered() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    publish(&mut contract, &organizer, "evt-1");
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));
    assert_accepted(ft_deposit(&mut contract, &bob, 100, &commit_msg("evt-1", "bob-c1"), NOW + 2));

    assert_eq!(contract.list_event_registrations("evt-1".to_string(), 0, 1).len(), 1);
    assert_eq!(contract.list_event_registrations("evt-1".to_string(), 1, 1).len(), 1);
    assert_eq!(contract.list_event_registrations("evt-1".to_string(), 2, 10).len(), 0);
    assert_eq!(contract.list_events(0, 10).len(), 1);
    assert_eq!(contract.get_event("evt-1".to_string()).total_registrations, 2);
}

#[test]
#[should_panic(expected = "limit must be 1..=50")]
fn list_limit_zero_is_rejected() {
    let contract = new_contract();
    contract.list_events(0, 0);
}

#[test]
#[should_panic(expected = "limit must be 1..=50")]
fn list_limit_above_50_is_rejected() {
    let contract = new_contract();
    contract.list_events(0, 51);
}

#[test]
#[should_panic(expected = "PASS_NOT_TRANSFERABLE")]
fn nft_transfer_is_rejected() {
    let (mut contract, _organizer, alice) = accepted_setup();
    let registration = contract.list_event_registrations("evt-1".to_string(), 0, 1)[0].clone();
    testing_env!(context(&alice, 1, NOW + 2).build());
    contract.nft_transfer(acct("bob.sandbox"), registration.pass_id, None, None);
}

#[test]
#[should_panic(expected = "PASS_NOT_TRANSFERABLE")]
fn nft_approve_is_rejected() {
    let (mut contract, _organizer, alice) = accepted_setup();
    let registration = contract.list_event_registrations("evt-1".to_string(), 0, 1)[0].clone();
    testing_env!(context(&alice, 1, NOW + 2).build());
    contract.nft_approve(acct("bob.sandbox"), registration.pass_id, None);
}

#[test]
#[should_panic(expected = "PASS_NOT_TRANSFERABLE")]
fn admin_reassign_is_rejected() {
    let (mut contract, _organizer, _alice) = accepted_setup();
    let registration = contract.list_event_registrations("evt-1".to_string(), 0, 1)[0].clone();
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW + 2).build());
    contract.admin_reassign_pass(registration.pass_id, acct("bob.sandbox"));
}

#[test]
#[should_panic(expected = "PASS_NOT_TRANSFERABLE")]
fn burn_is_rejected() {
    let (mut contract, _organizer, alice) = accepted_setup();
    let registration = contract.list_event_registrations("evt-1".to_string(), 0, 1)[0].clone();
    testing_env!(context(&alice, 1, NOW + 2).build());
    contract.burn(registration.pass_id);
}

// ------------------------------------------- cancellation / timeout / claim

fn register_capacity(
    contract: &mut Contract,
    event_id: &str,
    capacity: u32,
) -> Vec<AccountId> {
    let mut accounts = Vec::new();
    for index in 0..capacity {
        let account = acct(&format!("p{index}.sandbox"));
        prepay(
            contract,
            &account,
            NearToken::from_millinear(500).as_yoctonear(),
        );
        assert_accepted(ft_deposit(
            contract,
            &account,
            100,
            &commit_msg(event_id, &format!("p{index}-c1")),
            NOW + 1 + u64::from(index),
        ));
        accounts.push(account);
    }
    accounts
}

#[test]
fn withdrawal_is_disabled_before_mutation() {
    let (mut contract, _organizer, alice) = accepted_setup();
    let registration = first_registration(&contract, "evt-1");
    let before_event = contract.get_event("evt-1".to_string());
    let before_totals = contract.get_event_totals("evt-1".to_string());
    let before_claim = contract.get_claim(registration.registration_id.clone());

    assert_panics(|| {
        testing_env!(context(&alice, 0, NOW + 2).build());
        contract.withdraw_registration(registration.registration_id.clone());
    });

    let after_event = contract.get_event("evt-1".to_string());
    assert_eq!(after_event.state, before_event.state);
    assert_eq!(after_event.active_registrations, before_event.active_registrations);
    assert_eq!(after_event.total_registrations, before_event.total_registrations);
    assert_eq!(after_event.accepted_principal, before_event.accepted_principal);
    assert_eq!(contract.get_event_totals("evt-1".to_string()), before_totals);
    let after_claim = contract.get_claim(registration.registration_id);
    assert_eq!(after_claim.amount, before_claim.amount);
    assert_eq!(after_claim.payout_state, before_claim.payout_state);
    assert_eq!(after_claim.paid_amount, before_claim.paid_amount);
    assert_eq!(contract.get_escrow_principal(), U128(100));
}

#[test]
fn one_lifetime_registration_per_account() {
    let (mut contract, _organizer, alice) = accepted_setup();
    assert_refunded(
        ft_deposit(
            &mut contract,
            &alice,
            100,
            &commit_msg("evt-1", "alice-c2"),
            NOW + 2,
        ),
        100,
    );
    let event = contract.get_event("evt-1".to_string());
    assert_eq!(event.active_registrations, 1);
    assert_eq!(event.total_registrations, 1);
    assert_eq!(event.withdrawn_registrations, 0);
    assert_eq!(contract.get_escrow_principal(), U128(100));
    assert_eq!(
        contract.get_claim("reg-0".to_string()).payout_state,
        showstake::FinancialStatus::Committed
    );
}

#[test]
fn cancel_with_zero_registrations_is_consistent() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    publish(&mut contract, &organizer, "evt-empty");

    testing_env!(context(&organizer, 0, NOW + 1).build());
    let event = contract.cancel_event("evt-empty".to_string());
    assert_eq!(event.state, showstake::EventState::Cancelled);
    let totals = contract.get_event_totals("evt-empty".to_string());
    assert_eq!(totals.registrations, 0);
    assert_eq!(totals.active_registrations, 0);
    assert_eq!(totals.withdrawn_registrations, 0);
    assert_eq!(totals.accepted_principal, U128(0));
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(0));
    assert!(contract
        .list_event_registrations("evt-empty".to_string(), 0, 10)
        .is_empty());
}

#[test]
fn timeout_with_zero_registrations_is_consistent() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let dave = acct("dave.sandbox");
    publish(&mut contract, &organizer, "evt-empty");
    let deadline = NOW + 2 * HOUR_MS + DAY_MS;

    testing_env!(context(&dave, 0, deadline).build());
    let event = contract.activate_timeout_refund("evt-empty".to_string());
    assert_eq!(event.state, showstake::EventState::RefundOnly);
    let totals = contract.get_event_totals("evt-empty".to_string());
    assert_eq!(totals.registrations, 0);
    assert_eq!(totals.accepted_principal, U128(0));
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(0));
}

#[test]
fn cancel_grants_full_principal_claims_and_pays_once() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    publish_with(&mut contract, &organizer, "evt-1", default_rules(100, 3));
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));
    assert_accepted(ft_deposit(&mut contract, &bob, 100, &commit_msg("evt-1", "bob-c1"), NOW + 2));

    testing_env!(context(&organizer, 0, NOW + 3).build());
    let event = contract.cancel_event("evt-1".to_string());
    assert_eq!(event.state, showstake::EventState::Cancelled);
    assert_eq!(event.phase, showstake::EventPhase::Cancelled);
    assert_eq!(event.active_registrations, 2);
    assert_eq!(event.total_registrations, 2);
    assert_eq!(event.withdrawn_registrations, 0);

    for registration in contract.list_event_registrations("evt-1".to_string(), 0, 10) {
        assert_eq!(registration.financial_status, showstake::FinancialStatus::Claimable);
        assert_eq!(registration.registration_status, showstake::RegistrationStatus::Active);
        let pass = contract.get_pass(registration.pass_id.clone());
        assert_eq!(pass.financial_status, showstake::FinancialStatus::Claimable);
        let claim = contract.get_claim(registration.registration_id);
        assert_eq!(claim.amount, U128(100));
        assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
    }
    let totals = contract.get_event_totals("evt-1".to_string());
    assert_eq!(totals.accepted_principal, U128(200));
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(200));
    assert_eq!(contract.get_escrow_principal(), U128(200));

    claim_as(&mut contract, &alice, "reg-0", NOW + 4);
    let pending = contract.get_claim("reg-0".to_string());
    assert_eq!(pending.payout_state, showstake::FinancialStatus::Pending);
    let payout = pending.pending_payout_id.expect("pending payout");
    assert_panics(|| claim_as(&mut contract, &alice, "reg-0", NOW + 5));
    callback_result(true, NOW + 6);
    contract.on_payout_result(payout);
    let paid = contract.get_claim("reg-0".to_string());
    assert_eq!(paid.payout_state, showstake::FinancialStatus::Paid);
    assert_eq!(paid.paid_amount, U128(100));
    let totals = contract.get_event_totals("evt-1".to_string());
    assert_eq!(totals.paid, U128(100));
    assert_eq!(totals.liability, U128(100));
    assert_eq!(contract.get_escrow_principal(), U128(100));
}

#[test]
fn unauthorized_cancel_is_rejected_without_state_change() {
    let (mut contract, _organizer, alice) = accepted_setup();
    let registration = first_registration(&contract, "evt-1");
    let before = contract.get_event_totals("evt-1".to_string());
    assert_panics(|| {
        testing_env!(context(&alice, 0, NOW + 2).build());
        contract.cancel_event("evt-1".to_string());
    });
    let after = contract.get_event("evt-1".to_string());
    assert_eq!(after.state, showstake::EventState::Published);
    assert_eq!(after.total_registrations, 1);
    assert_eq!(
        contract.get_claim(registration.registration_id).payout_state,
        showstake::FinancialStatus::Committed
    );
    assert_eq!(contract.get_event_totals("evt-1".to_string()), before);
}

#[test]
fn timeout_refund_only_is_permissionless_and_deadline_inclusive() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let dave = acct("dave.sandbox");
    publish_with(&mut contract, &organizer, "evt-1", default_rules(100, 2));
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));
    let deadline = NOW + 2 * HOUR_MS + DAY_MS;

    assert_panics(|| {
        testing_env!(context(&dave, 0, deadline - 1).build());
        contract.activate_timeout_refund("evt-1".to_string());
    });
    assert_eq!(
        contract.get_event("evt-1".to_string()).state,
        showstake::EventState::Published
    );

    testing_env!(context(&dave, 0, deadline).build());
    let event = contract.activate_timeout_refund("evt-1".to_string());
    assert_eq!(event.state, showstake::EventState::RefundOnly);
    assert_eq!(event.phase, showstake::EventPhase::RefundOnly);
    let claim = contract.get_claim("reg-0".to_string());
    assert_eq!(claim.amount, U128(100));
    assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
    let totals = contract.get_event_totals("evt-1".to_string());
    assert_eq!(totals.accepted_principal, U128(100));
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(100));

    assert_panics(|| {
        testing_env!(context(&dave, 0, deadline + 1).build());
        contract.activate_timeout_refund("evt-1".to_string());
    });
    assert_panics(|| {
        testing_env!(context(&organizer, 0, deadline + 2).build());
        contract.cancel_event("evt-1".to_string());
    });
}

#[test]
fn claim_requires_claimable_state_and_immutable_beneficiary() {
    let (mut contract, _organizer, alice) = accepted_setup();
    let registration = first_registration(&contract, "evt-1");
    assert_panics(|| {
        claim_as(&mut contract, &alice, &registration.registration_id, NOW + 2);
    });
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW + 3).build());
    contract.cancel_event("evt-1".to_string());

    assert_panics(|| {
        claim_as(
            &mut contract,
            &acct("bob.sandbox"),
            &registration.registration_id,
            NOW + 4,
        );
    });
    assert_panics(|| {
        testing_env!(context(&alice, 2, NOW + 4).build());
        let _ = contract.claim(registration.registration_id.clone());
    });
    assert_panics(|| {
        testing_env!(context(&alice, 0, NOW + 4).build());
        let _ = contract.claim(registration.registration_id.clone());
    });
    assert_eq!(
        contract.get_claim(registration.registration_id).payout_state,
        showstake::FinancialStatus::Claimable
    );
}

#[test]
fn claim_reserves_once_then_callback_pays_exactly_once() {
    let (mut contract, _organizer, alice) = accepted_setup();
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW + 2).build());
    contract.cancel_event("evt-1".to_string());
    let registration = first_registration(&contract, "evt-1");
    claim_as(&mut contract, &alice, &registration.registration_id, NOW + 3);
    let pending = contract.get_claim(registration.registration_id.clone());
    assert_eq!(pending.payout_state, showstake::FinancialStatus::Pending);
    let payout_id = pending.pending_payout_id.clone().expect("pending payout id");
    let totals = contract.get_event_totals("evt-1".to_string());
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(100));
    assert_eq!(totals.liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(100));

    assert_panics(|| claim_as(&mut contract, &alice, &registration.registration_id, NOW + 4));
    callback_result(true, NOW + 5);
    let payout = contract.on_payout_result(payout_id.clone());
    assert_eq!(payout.state, showstake::PayoutState::Succeeded);
    let paid = contract.get_claim(registration.registration_id.clone());
    assert_eq!(paid.payout_state, showstake::FinancialStatus::Paid);
    assert_eq!(paid.paid_amount, U128(100));
    assert_eq!(contract.get_event_totals("evt-1".to_string()).liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(0));

    assert_panics(|| {
        callback_result(true, NOW + 6);
        contract.on_payout_result(payout_id.clone());
    });
    assert_panics(|| claim_as(&mut contract, &alice, &registration.registration_id, NOW + 7));
}

#[test]
fn failed_payout_restores_claim_and_retry_succeeds() {
    let (mut contract, _organizer, alice) = accepted_setup();
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW + 2).build());
    contract.cancel_event("evt-1".to_string());
    let registration = first_registration(&contract, "evt-1");
    claim_as(&mut contract, &alice, &registration.registration_id, NOW + 3);
    let first_payout = contract
        .get_claim(registration.registration_id.clone())
        .pending_payout_id
        .expect("first pending payout");
    callback_result(false, NOW + 4);
    let failed = contract.on_payout_result(first_payout.clone());
    assert_eq!(failed.state, showstake::PayoutState::Failed);

    let restored = contract.get_claim(registration.registration_id.clone());
    assert_eq!(restored.payout_state, showstake::FinancialStatus::Claimable);
    assert_eq!(restored.pending_payout_id, None);
    let totals = contract.get_event_totals("evt-1".to_string());
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(100));
    assert_eq!(contract.get_escrow_principal(), U128(100));

    claim_as(&mut contract, &alice, &registration.registration_id, NOW + 5);
    let retry_payout = contract
        .get_claim(registration.registration_id.clone())
        .pending_payout_id
        .expect("retry pending payout");
    assert_ne!(retry_payout, first_payout);
    callback_result(true, NOW + 6);
    contract.on_payout_result(retry_payout);
    let totals = contract.get_event_totals("evt-1".to_string());
    assert_eq!(totals.paid, U128(100));
    assert_eq!(totals.liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(0));
}

#[test]
fn spoofed_payout_callback_is_rejected_without_state_change() {
    let (mut contract, _organizer, alice) = accepted_setup();
    testing_env!(context(&acct("organizer.sandbox"), 0, NOW + 2).build());
    contract.cancel_event("evt-1".to_string());
    let registration = first_registration(&contract, "evt-1");
    claim_as(&mut contract, &alice, &registration.registration_id, NOW + 3);
    let payout_id = contract
        .get_claim(registration.registration_id.clone())
        .pending_payout_id
        .expect("pending payout");
    assert_panics(|| {
        testing_env!(context(&alice, 0, NOW + 4).build());
        contract.on_payout_result(payout_id.clone());
    });
    assert_eq!(
        contract.get_claim(registration.registration_id.clone()).payout_state,
        showstake::FinancialStatus::Pending
    );
    callback_result(true, NOW + 5);
    contract.on_payout_result(payout_id);
    assert_eq!(
        contract.get_claim(registration.registration_id).payout_state,
        showstake::FinancialStatus::Paid
    );
}

#[test]
fn overlapping_claims_on_two_registrations_resolve_exactly_once() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    publish_with(&mut contract, &organizer, "evt-1", default_rules(100, 2));
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));
    assert_accepted(ft_deposit(&mut contract, &bob, 100, &commit_msg("evt-1", "bob-c1"), NOW + 2));
    testing_env!(context(&organizer, 0, NOW + 3).build());
    contract.cancel_event("evt-1".to_string());

    claim_as(&mut contract, &alice, "reg-0", NOW + 4);
    claim_as(&mut contract, &bob, "reg-1", NOW + 5);
    let alice_payout = contract
        .get_claim("reg-0".to_string())
        .pending_payout_id
        .expect("alice pending payout");
    let bob_payout = contract
        .get_claim("reg-1".to_string())
        .pending_payout_id
        .expect("bob pending payout");
    let both_pending = contract.get_event_totals("evt-1".to_string());
    assert_eq!(both_pending.paid, U128(0));
    assert_eq!(both_pending.pending, U128(200));
    assert_eq!(both_pending.liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(200));

    callback_result(true, NOW + 6);
    contract.on_payout_result(alice_payout.clone());
    let one_paid = contract.get_event_totals("evt-1".to_string());
    assert_eq!(one_paid.paid, U128(100));
    assert_eq!(one_paid.pending, U128(100));
    assert_eq!(contract.get_escrow_principal(), U128(100));

    callback_result(true, NOW + 7);
    contract.on_payout_result(bob_payout.clone());
    let both_paid = contract.get_event_totals("evt-1".to_string());
    assert_eq!(both_paid.paid, U128(200));
    assert_eq!(both_paid.pending, U128(0));
    assert_eq!(both_paid.liability, U128(0));
    assert_eq!(contract.get_escrow_principal(), U128(0));

    assert_panics(|| {
        callback_result(true, NOW + 8);
        contract.on_payout_result(alice_payout);
    });
    assert_panics(|| {
        callback_result(true, NOW + 9);
        contract.on_payout_result(bob_payout);
    });
}

#[test]
fn cancel_is_o1_at_capacity_200() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    publish_with(&mut contract, &organizer, "evt-max", default_rules(100, 200));
    let accounts = register_capacity(&mut contract, "evt-max", 200);
    let event = contract.get_event("evt-max".to_string());
    assert_eq!(event.active_registrations, 200);
    assert_eq!(event.total_registrations, 200);
    assert_eq!(event.withdrawn_registrations, 0);

    testing_env!(context(&organizer, 0, NOW + 1000).build());
    let before = env::storage_usage();
    contract.cancel_event("evt-max".to_string());
    let after = env::storage_usage();
    assert_eq!(after, before, "cancel must not rewrite 200 registrations");
    let totals = contract.get_event_totals("evt-max".to_string());
    assert_eq!(totals.accepted_principal, U128(20000));
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(20000));
    assert_eq!(contract.get_escrow_principal(), U128(20000));

    claim_as(&mut contract, &accounts[0], "reg-0", NOW + 1001);
    let payout = contract
        .get_claim("reg-0".to_string())
        .pending_payout_id
        .expect("capacity-200 pending payout");
    callback_result(true, NOW + 1002);
    contract.on_payout_result(payout);
    let totals = contract.get_event_totals("evt-max".to_string());
    assert_eq!(totals.paid, U128(100));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(19900));
    assert_eq!(contract.get_escrow_principal(), U128(19900));
}

#[test]
fn timeout_refund_is_o1_at_capacity_200() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let dave = acct("dave.sandbox");
    publish_with(&mut contract, &organizer, "evt-max", default_rules(100, 200));
    let accounts = register_capacity(&mut contract, "evt-max", 200);
    let deadline = NOW + 2 * HOUR_MS + DAY_MS;

    assert_panics(|| {
        testing_env!(context(&dave, 0, deadline - 1).build());
        contract.activate_timeout_refund("evt-max".to_string());
    });
    testing_env!(context(&dave, 0, deadline).build());
    let before = env::storage_usage();
    contract.activate_timeout_refund("evt-max".to_string());
    let after = env::storage_usage();
    assert_eq!(after, before, "timeout must not rewrite 200 registrations");
    let event = contract.get_event("evt-max".to_string());
    assert_eq!(event.state, showstake::EventState::RefundOnly);
    let totals = contract.get_event_totals("evt-max".to_string());
    assert_eq!(totals.accepted_principal, U128(20000));
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(20000));

    claim_as(&mut contract, &accounts[199], "reg-199", deadline + 1);
    let payout = contract
        .get_claim("reg-199".to_string())
        .pending_payout_id
        .expect("capacity-200 timeout payout");
    callback_result(true, deadline + 2);
    contract.on_payout_result(payout);
    let totals = contract.get_event_totals("evt-max".to_string());
    assert_eq!(totals.paid, U128(100));
    assert_eq!(totals.liability, U128(19900));
    assert_eq!(contract.get_escrow_principal(), U128(19900));
}

#[test]
fn deposit_after_cancel_is_rejected_without_state_change() {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    let alice = acct("alice.sandbox");
    let bob = acct("bob.sandbox");
    publish_with(&mut contract, &organizer, "evt-1", default_rules(100, 2));
    prepay(&mut contract, &alice, NearToken::from_millinear(500).as_yoctonear());
    prepay(&mut contract, &bob, NearToken::from_millinear(500).as_yoctonear());
    assert_accepted(ft_deposit(&mut contract, &alice, 100, &commit_msg("evt-1", "alice-c1"), NOW + 1));
    testing_env!(context(&organizer, 0, NOW + 2).build());
    contract.cancel_event("evt-1".to_string());
    let before = contract.get_event_totals("evt-1".to_string());
    assert_refunded(
        ft_deposit(&mut contract, &bob, 100, &commit_msg("evt-1", "bob-c1"), NOW + 3),
        100,
    );
    let after = contract.get_event_totals("evt-1".to_string());
    assert_eq!(before, after);
    assert_eq!(after.registrations, 1);
    assert_eq!(after.liability, U128(100));
    assert_eq!(contract.get_escrow_principal(), U128(100));
}


// --------------------------------- attendance / finalize / settle (v6)

fn register_many(
    contract: &mut Contract,
    event_id: &str,
    deposit: u128,
    count: u32,
) -> Vec<AccountId> {
    let mut accounts = Vec::new();
    for index in 0..count {
        let account = acct(&format!("s{index}.sandbox"));
        prepay(
            contract,
            &account,
            NearToken::from_millinear(500).as_yoctonear(),
        );
        assert_accepted(ft_deposit(
            contract,
            &account,
            deposit,
            &commit_msg(event_id, &format!("s{index}-c1")),
            NOW + 1 + u64::from(index),
        ));
        accounts.push(account);
    }
    accounts
}

fn settlement_setup(deposit: u128, count: u32) -> (Contract, AccountId, Vec<AccountId>) {
    let mut contract = new_contract();
    let organizer = acct("organizer.sandbox");
    publish_with(
        &mut contract,
        &organizer,
        "evt-settle",
        default_rules(deposit, count),
    );
    let accounts = register_many(&mut contract, "evt-settle", deposit, count);
    (contract, organizer, accounts)
}

fn settlement_ids(contract: &Contract, count: u32) -> Vec<String> {
    contract
        .list_event_registrations("evt-settle".to_string(), 0, count)
        .into_iter()
        .map(|registration| registration.registration_id)
        .collect()
}

#[test]
fn attendance_marking_is_organizer_only_and_window_bounded() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 2);
    let registration = first_registration(&contract, "evt-settle");
    let checkin_open = NOW + HOUR_MS;
    let checkin_close = NOW + 2 * HOUR_MS;

    assert_panics(|| {
        testing_env!(context(&organizer, 0, checkin_open - 1).build());
        contract.mark_attendance(registration.registration_id.clone(), true);
    });
    let outsider = acct("outsider.sandbox");
    assert_panics(|| {
        testing_env!(context(&outsider, 0, checkin_open).build());
        contract.mark_attendance(registration.registration_id.clone(), true);
    });
    assert_panics(|| {
        testing_env!(context(&organizer, 0, checkin_close).build());
        contract.mark_attendance(registration.registration_id.clone(), true);
    });

    testing_env!(context(&organizer, 0, checkin_open).build());
    let view = contract.mark_attendance(registration.registration_id.clone(), true);
    assert_eq!(
        view.attendance_status,
        showstake::AttendanceStatus::Attended
    );
    let pass = contract.get_pass(view.pass_id.clone());
    assert_eq!(
        pass.attendance_status,
        showstake::AttendanceStatus::Attended
    );
}

#[test]
fn attendance_marking_is_idempotent_and_correctable() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 3);
    let registration = first_registration(&contract, "evt-settle");
    let at = NOW + HOUR_MS + 1;

    testing_env!(context(&organizer, 0, at).build());
    let first = contract.mark_attendance(registration.registration_id.clone(), true);
    assert_eq!(
        first.attendance_status,
        showstake::AttendanceStatus::Attended
    );

    let before = env::storage_usage();
    testing_env!(context(&organizer, 0, at).build());
    let duplicate = contract.mark_attendance(registration.registration_id.clone(), true);
    let after = env::storage_usage();
    assert_eq!(after, before, "duplicate mark must not write state");
    assert_eq!(
        duplicate.attendance_status,
        showstake::AttendanceStatus::Attended
    );

    testing_env!(context(&organizer, 0, at).build());
    let corrected = contract.mark_attendance(registration.registration_id.clone(), false);
    assert_eq!(
        corrected.attendance_status,
        showstake::AttendanceStatus::NotMarked
    );
    let again_before = env::storage_usage();
    testing_env!(context(&organizer, 0, at).build());
    contract.mark_attendance(registration.registration_id.clone(), false);
    assert_eq!(
        env::storage_usage(),
        again_before,
        "duplicate correction must not write state"
    );
}

#[test]
fn finalize_is_window_bounded_immutable_and_counts_attendees() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 3);
    let ids = settlement_ids(&contract, 3);
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    contract.mark_attendance(ids[0].clone(), true);
    contract.mark_attendance(ids[2].clone(), true);

    assert_panics(|| {
        testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS - 1).build());
        contract.finalize_event("evt-settle".to_string());
    });
    assert_panics(|| {
        testing_env!(context(&acct("outsider.sandbox"), 0, NOW + 2 * HOUR_MS).build());
        contract.finalize_event("evt-settle".to_string());
    });

    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    let view = contract.finalize_event("evt-settle".to_string());
    assert_eq!(view.state, showstake::EventState::AttendanceFinalized);
    assert_eq!(view.phase, showstake::EventPhase::AttendanceFinalized);
    let settlement = contract.get_settlement("evt-settle".to_string());
    assert_eq!(settlement.attendee_count, 2);
    assert_eq!(settlement.no_show_count, 1);
    assert!(settlement.attendance_frozen);

    assert_panics(|| {
        testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
        contract.mark_attendance(ids[1].clone(), true);
    });
    assert_panics(|| {
        testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
        contract.finalize_event("evt-settle".to_string());
    });
    let no_show = contract.get_registration(ids[1].clone());
    assert_eq!(
        no_show.attendance_status,
        showstake::AttendanceStatus::NoShow
    );
}

#[test]
fn finalize_at_deadline_is_denied_and_late_timeout_refunds() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 2);
    let deadline = NOW + 2 * HOUR_MS + DAY_MS;
    assert_panics(|| {
        testing_env!(context(&organizer, 0, deadline).build());
        contract.finalize_event("evt-settle".to_string());
    });
    testing_env!(context(&acct("keeper.sandbox"), 0, deadline).build());
    let view = contract.activate_timeout_refund("evt-settle".to_string());
    assert_eq!(view.state, showstake::EventState::RefundOnly);
    let claim = contract.get_claim("reg-0".to_string());
    assert_eq!(claim.amount, U128(10));
    assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
}

#[test]
fn timeout_is_denied_after_finalization_but_settlement_is_not() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 2);
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    let deadline = NOW + 2 * HOUR_MS + DAY_MS;
    assert_panics(|| {
        testing_env!(context(&acct("keeper.sandbox"), 0, deadline).build());
        contract.activate_timeout_refund("evt-settle".to_string());
    });
    testing_env!(context(&acct("keeper.sandbox"), 0, deadline).build());
    let view = contract.settle("evt-settle".to_string());
    assert_eq!(view.state, showstake::EventState::Settled);
}

#[test]
fn settle_before_finalization_is_denied() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 2);
    assert_panics(|| {
        testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
        contract.settle("evt-settle".to_string());
    });
}

#[test]
fn settlement_returns_each_attendee_own_principal() {
    let (mut contract, organizer, accounts) = settlement_setup(10, 3);
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    for index in 0..3 {
        contract.mark_attendance(format!("reg-{index}"), true);
    }
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let settlement = contract.settle("evt-settle".to_string());
    assert_eq!(settlement.state, showstake::EventState::Settled);
    assert!(settlement.complete);
    assert!(settlement.claims_enabled);
    assert_eq!(settlement.pool, U128(0));
    for index in 0..3 {
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, U128(10));
        assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
    }
    claim_as(&mut contract, &accounts[0], "reg-0", NOW + 2 * HOUR_MS + 1);
    let payout = contract
        .get_claim("reg-0".to_string())
        .pending_payout_id
        .expect("pending settlement payout");
    callback_result(true, NOW + 2 * HOUR_MS + 2);
    contract.on_payout_result(payout);
    let totals = contract.get_event_totals("evt-settle".to_string());
    assert_eq!(totals.paid, U128(10));
    assert_eq!(totals.liability, U128(20));
}

#[test]
fn settlement_splits_no_show_principal_with_sequence_remainder() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 5);
    let attended = [true, false, true, true, false];
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    for (index, value) in attended.iter().enumerate() {
        contract.mark_attendance(format!("reg-{index}"), *value);
    }
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let settlement = contract.settle("evt-settle".to_string());
    assert_eq!(settlement.state, showstake::EventState::Settled);
    assert_eq!(settlement.pool, U128(20));
    assert_eq!(settlement.base_share, U128(6));
    assert_eq!(settlement.remainder, U128(2));

    let expected = [U128(17), U128(0), U128(17), U128(16), U128(0)];
    let expected_states = [
        showstake::FinancialStatus::Claimable,
        showstake::FinancialStatus::Forfeited,
        showstake::FinancialStatus::Claimable,
        showstake::FinancialStatus::Claimable,
        showstake::FinancialStatus::Forfeited,
    ];
    for index in 0..5 {
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, expected[index], "reg-{index}");
        assert_eq!(claim.payout_state, expected_states[index], "reg-{index}");
    }
    assert_panics(|| {
        testing_env!(context(&acct("s1.sandbox"), 1, NOW + 2 * HOUR_MS + 1).build());
        contract.claim("reg-1".to_string());
    });
    let totals = contract.get_event_totals("evt-settle".to_string());
    assert_eq!(totals.accepted_principal, U128(50));
    assert_eq!(totals.liability, U128(50));
}

#[test]
fn settlement_refunds_every_registration_when_nobody_attends() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 3);
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let settlement = contract.settle("evt-settle".to_string());
    assert_eq!(settlement.state, showstake::EventState::Settled);
    assert_eq!(settlement.attendee_count, 0);
    assert_eq!(settlement.pool, U128(0));
    for index in 0..3 {
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, U128(10));
        assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
    }
}

#[test]
fn settlement_is_chunked_at_capacity_200_and_claims_are_gated() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 200);
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    let before_settle = env::storage_usage();

    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let first = contract.settle("evt-settle".to_string());
    assert_eq!(first.state, showstake::EventState::Settling);
    assert_eq!(first.cursor, 25);
    assert!(!first.complete);
    assert!(!first.claims_enabled);
    assert_eq!(
        env::storage_usage(),
        before_settle,
        "a settlement chunk must not grow storage"
    );

    assert_panics(|| {
        testing_env!(context(&acct("s0.sandbox"), 1, NOW + 2 * HOUR_MS + 1).build());
        contract.claim("reg-0".to_string());
    });
    assert_panics(|| {
        testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS + 1).build());
        contract.cancel_event("evt-settle".to_string());
    });

    let mut calls = 1u32;
    loop {
        testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
        let view = contract.settle("evt-settle".to_string());
        calls += 1;
        assert_eq!(
            env::storage_usage(),
            before_settle,
            "every chunk must keep storage fixed"
        );
        if view.complete {
            break;
        }
    }
    assert_eq!(calls, 8, "capacity 200 completes in eight 25-entry chunks");

    let settled = contract.get_settlement("evt-settle".to_string());
    assert_eq!(settled.state, showstake::EventState::Settled);
    assert_eq!(settled.cursor, 200);
    assert_eq!(settled.allocated_count, 200);
    assert_eq!(settled.allocated_total, U128(2000));
    assert!(settled.complete);
    assert!(settled.claims_enabled);

    let replay_before = env::storage_usage();
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let replay = contract.settle("evt-settle".to_string());
    assert_eq!(replay.state, showstake::EventState::Settled);
    assert_eq!(
        env::storage_usage(),
        replay_before,
        "settle after completion must be a no-op"
    );
}

#[test]
fn settlement_remainder_is_sequence_deterministic_across_chunks() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 30);
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    for index in 0..7 {
        contract.mark_attendance(format!("reg-{index}"), true);
    }
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let first = contract.settle("evt-settle".to_string());
    assert_eq!(first.cursor, 25);
    assert_eq!(first.state, showstake::EventState::Settling);
    for index in 0..7 {
        let expected = if index < 6 { 43 } else { 42 };
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, U128(expected), "reg-{index}");
    }
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let second = contract.settle("evt-settle".to_string());
    assert_eq!(second.state, showstake::EventState::Settled);
    assert_eq!(second.allocated_total, U128(300));
}

#[test]
fn cancellation_after_finalization_refunds_full_principal_before_settlement() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 3);
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    contract.mark_attendance("reg-0".to_string(), true);
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS + 1).build());
    let view = contract.cancel_event("evt-settle".to_string());
    assert_eq!(view.state, showstake::EventState::Cancelled);
    for index in 0..3 {
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, U128(10));
        assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
    }
}

#[test]
fn settlement_packet_example_two_of_five_attendees() {
    let (mut contract, organizer, _accounts) = settlement_setup(2, 5);
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    contract.mark_attendance("reg-0".to_string(), true);
    contract.mark_attendance("reg-1".to_string(), true);
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    let settlement = contract.settle("evt-settle".to_string());
    assert_eq!(settlement.state, showstake::EventState::Settled);
    assert_eq!(settlement.pool, U128(6));
    assert_eq!(settlement.base_share, U128(3));
    assert_eq!(settlement.remainder, U128(0));
    for index in 0..2 {
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, U128(5), "attendee reg-{index}");
        assert_eq!(claim.payout_state, showstake::FinancialStatus::Claimable);
    }
    for index in 2..5 {
        let claim = contract.get_claim(format!("reg-{index}"));
        assert_eq!(claim.amount, U128(0), "no-show reg-{index}");
        assert_eq!(claim.payout_state, showstake::FinancialStatus::Forfeited);
    }
    let totals = contract.get_event_totals("evt-settle".to_string());
    assert_eq!(totals.accepted_principal, U128(10));
    assert_eq!(totals.liability, U128(10));
}

#[test]
fn settlement_failed_payout_restores_allocated_share_not_principal() {
    let (mut contract, organizer, _accounts) = settlement_setup(10, 5);
    let attended = [true, false, true, true, false];
    testing_env!(context(&organizer, 0, NOW + HOUR_MS).build());
    for (index, value) in attended.iter().enumerate() {
        contract.mark_attendance(format!("reg-{index}"), *value);
    }
    testing_env!(context(&organizer, 0, NOW + 2 * HOUR_MS).build());
    contract.finalize_event("evt-settle".to_string());
    testing_env!(context(&acct("keeper.sandbox"), 0, NOW + 2 * HOUR_MS).build());
    contract.settle("evt-settle".to_string());

    let claimant = acct("s0.sandbox");
    let allocated = contract.get_claim("reg-0".to_string());
    assert_eq!(allocated.amount, U128(17));
    assert_eq!(allocated.payout_state, showstake::FinancialStatus::Claimable);

    claim_as(&mut contract, &claimant, "reg-0", NOW + 2 * HOUR_MS + 1);
    let first_payout = contract
        .get_claim("reg-0".to_string())
        .pending_payout_id
        .expect("first pending settled payout");
    callback_result(false, NOW + 2 * HOUR_MS + 2);
    let failed = contract.on_payout_result(first_payout.clone());
    assert_eq!(failed.state, showstake::PayoutState::Failed);
    assert_eq!(failed.amount, U128(17));

    let restored = contract.get_claim("reg-0".to_string());
    assert_eq!(
        restored.amount,
        U128(17),
        "failure must restore the settled share, not the principal D"
    );
    assert_eq!(restored.payout_state, showstake::FinancialStatus::Claimable);
    assert_eq!(restored.paid_amount, U128(0));
    assert_eq!(restored.pending_payout_id, None);
    let totals = contract.get_event_totals("evt-settle".to_string());
    assert_eq!(totals.paid, U128(0));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(50));
    assert_eq!(contract.get_escrow_principal(), U128(50));

    claim_as(&mut contract, &claimant, "reg-0", NOW + 2 * HOUR_MS + 3);
    let retry_payout = contract
        .get_claim("reg-0".to_string())
        .pending_payout_id
        .expect("retry pending settled payout");
    assert_ne!(retry_payout, first_payout);
    callback_result(true, NOW + 2 * HOUR_MS + 4);
    contract.on_payout_result(retry_payout);
    let paid = contract.get_claim("reg-0".to_string());
    assert_eq!(paid.payout_state, showstake::FinancialStatus::Paid);
    assert_eq!(paid.paid_amount, U128(17));
    let totals = contract.get_event_totals("evt-settle".to_string());
    assert_eq!(totals.paid, U128(17));
    assert_eq!(totals.pending, U128(0));
    assert_eq!(totals.liability, U128(33));
    assert_eq!(contract.get_escrow_principal(), U128(33));

    assert_panics(|| {
        testing_env!(context(&claimant, 1, NOW + 2 * HOUR_MS + 5).build());
        contract.claim("reg-0".to_string());
    });
    assert_panics(|| {
        callback_result(true, NOW + 2 * HOUR_MS + 6);
        contract.on_payout_result(first_payout.clone());
    });
}
