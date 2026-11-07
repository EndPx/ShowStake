// LOCAL unit tests for the ShowStake product slice.
//
// These run in the near-sdk mocked VM and are NOT chain evidence. Real
// receipt/balance evidence is produced by `../../tests/runner` against a
// temporary local NEAR Sandbox with the existing FT fixture.

use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_sdk::{env, AccountId, NearToken, PromiseOrValue};
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
        "showstake-v2/1".to_string(),
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
    assert_eq!(config.policy_version, "showstake-v2/1");
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
    assert_eq!(pass.policy_version, "showstake-v2/1");
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
