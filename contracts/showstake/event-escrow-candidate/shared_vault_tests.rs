use super::*;
use near_sdk::{PromiseResult, test_utils::VMContextBuilder, testing_env};

fn account(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(who: &str, ms: u64, block: u64, results: Vec<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("escrow.testnet"))
        .predecessor_account_id(account(who))
        .block_timestamp(ms * 1_000_000)
        .block_height(block)
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(NearToken::from_near(100));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn bytes<T: serde::Serialize>(v: &T) -> PromiseResult {
    PromiseResult::Successful(near_sdk::serde_json::to_vec(v).unwrap())
}
fn readings(ft: u128, shares: u128, value: u128) {
    context(
        "escrow.testnet",
        15,
        1,
        vec![
            bytes(&U128(ft)),
            bytes(&near_sdk::serde_json::json!({"shares":U128(shares),"balance":U128(value)})),
            bytes(&true),
        ],
    );
}
fn setup() -> MultiEventContract {
    context("host.testnet", 0, 1, vec![]);
    MultiEventContract::new(
        account("ft.testnet"),
        account("provider.testnet"),
        "MOCK_TESTNET".into(),
        "testnet".into(),
        "USDC".into(),
        "USDC".into(),
        6,
    )
}
#[test]
fn real_create_initializes_enabled_cap_from_published_rules() {
    let mut c = setup();
    let rules = EventRules {
        event_id: "created".into(),
        title: "Event".into(),
        location: "Room".into(),
        rules_text: "Rules".into(),
        deposit: U128(5_000_000),
        capacity: 5,
        reg_open: 1,
        reg_close: 10,
        checkin_open: 10,
        checkin_close: 20,
        finalize_deadline: 86_400_020,
    };
    let quote = c.quote_create_event(rules.clone(), account("host.testnet"));
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("escrow.testnet"))
        .predecessor_account_id(account("host.testnet"))
        .attached_deposit(NearToken::from_yoctonear(quote.0))
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
    c.create_event(rules);
    let control = c.get_rhea_control("created".into());
    assert_eq!(control["paused"], false);
    assert_eq!(control["principal_cap"], "25000000");
}
fn seed(c: &mut MultiEventContract, id: &str, principal: u128) {
    let rules = EventRules {
        event_id: id.into(),
        title: "Event".into(),
        location: "Room".into(),
        rules_text: "Rules".into(),
        deposit: U128(principal),
        capacity: 1,
        reg_open: 1,
        reg_close: 10,
        checkin_open: 10,
        checkin_close: 20,
        finalize_deadline: 86_400_020,
    };
    let event = EventRecord {
        rules,
        created_at: 0,
        organizer: account("host.testnet"),
        phase: EscrowPhase::RegistrationClosed,
        earn_state: EarnState::NotStarted,
        earn_attempt: 0,
        accepted_principal: U128(principal),
        redeemed_amount: U128(0),
        realized_yield: U128(0),
        yield_distributed: U128(0),
        earn_baseline_balance: U128(0),
        earn_action_completed: false,
    };
    c.events.insert(
        &id.to_string(),
        &EventData {
            event,
            ids: vec![],
            paused: false,
            principal_cap: U128(principal),
            paid: U128(0),
            pending: U128(0),
            liability: U128(principal),
            reserved_cash: U128(principal),
        },
    );
    c.reserved_cash += principal;
    c.liability += principal;
}
fn supply(
    c: &mut MultiEventContract,
    id: &str,
    ft_before: u128,
    before_shares: u128,
    before_value: u128,
    ft_after: u128,
    after_shares: u128,
    after_value: u128,
    amount: u128,
) {
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply(id.into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(ft_before, before_shares, before_value);
    drop(c.on_vault_read(id.into(), attempt, true));
    context("escrow.testnet", 15, 1, vec![bytes(&U128(amount))]);
    drop(c.on_vault_action(id.into(), attempt));
    readings(ft_after, after_shares, after_value);
    drop(c.on_vault_read(id.into(), attempt, false));
    assert!(c.operation.is_none());
}
#[test]
fn two_events_nav_gain_and_cash_isolation() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    seed(&mut c, "b", 100);
    supply(&mut c, "a", 200, 0, 0, 100, 100, 100, 100);
    supply(&mut c, "b", 100, 100, 120, 0, 200, 220, 100);
    assert_eq!(c.vault_shares.get(&"a".into()), Some(U128(100)));
    assert_eq!(c.vault_shares.get(&"b".into()), Some(U128(83)));
    assert_eq!(c.total_shares, 183);
    let mut a = c.events.get(&"a".into()).unwrap();
    a.event.phase = EscrowPhase::Cancelled;
    c.events.insert(&"a".into(), &a);
    context("caller.testnet", 30, 1, vec![]);
    drop(c.trigger_earn_redeem("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(0, 200, 220);
    drop(c.on_vault_read("a".into(), attempt, true));
    assert_eq!(c.operation.as_ref().unwrap().amount, U128(120));
    context("escrow.testnet", 30, 1, vec![bytes(&true)]);
    drop(c.on_vault_action("a".into(), attempt));
    readings(120, 90, 100);
    drop(c.on_vault_read("a".into(), attempt, false));
    assert_eq!(
        c.events.get(&"a".into()).unwrap().event.redeemed_amount,
        U128(120)
    );
    assert_eq!(c.vault_shares.get(&"b".into()), Some(U128(83)));
    assert_eq!(c.events.get(&"b".into()).unwrap().reserved_cash, U128(0));
}
#[test]
fn shortfall_isolated_and_preflight_cancel_stale_safe() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    seed(&mut c, "b", 100);
    supply(&mut c, "a", 200, 0, 0, 100, 100, 100, 100);
    let mut a = c.events.get(&"a".into()).unwrap();
    a.event.phase = EscrowPhase::Cancelled;
    c.events.insert(&"a".into(), &a);
    context("caller.testnet", 30, 1, vec![]);
    drop(c.trigger_earn_redeem("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(100, 100, 90);
    drop(c.on_vault_read("a".into(), attempt, true));
    assert_eq!(c.shortfalls.get(&"a".into()), Some(U128(10)));
    assert_eq!(c.events.get(&"b".into()).unwrap().reserved_cash, U128(100));
    context("caller.testnet", 30, 1, vec![]);
    drop(c.trigger_earn_redeem("a".into()));
    let stale = c.operation.as_ref().unwrap().attempt;
    context("anyone.testnet", 30, 22, vec![]);
    assert!(c.cancel_earn_preflight("a".into()));
    readings(100, 100, 100);
    assert!(matches!(
        c.on_vault_read("a".into(), stale, true),
        PromiseOrValue::Value(false)
    ));
}
#[test]
fn unknown_callback_blocks_and_late_callback_cannot_replay() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(100, 0, 0);
    drop(c.on_vault_read("a".into(), attempt, true));
    context("escrow.testnet", 15, 1, vec![PromiseResult::Failed]);
    drop(c.on_vault_action("a".into(), attempt));
    assert_eq!(
        c.operation.as_ref().unwrap().stage,
        OperationStage::Ambiguous
    );
    context("escrow.testnet", 15, 1, vec![bytes(&U128(100))]);
    assert!(matches!(
        c.on_vault_action("a".into(), attempt),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(c.total_shares, 0);
}

#[test]
fn partial_supply_preserves_unsupplied_event_cash() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(100, 0, 0);
    drop(c.on_vault_read("a".into(), attempt, true));
    context("escrow.testnet", 15, 1, vec![bytes(&U128(60))]);
    drop(c.on_vault_action("a".into(), attempt));
    readings(40, 60, 60);
    drop(c.on_vault_read("a".into(), attempt, false));
    assert!(c.operation.is_none());
    assert_eq!(c.invested.get(&"a".into()), Some(U128(60)));
    assert_eq!(c.events.get(&"a".into()).unwrap().reserved_cash, U128(40));
    assert_eq!(c.reserved_cash, 40);
}

#[test]
fn excess_redemption_remains_pooled_and_donation_is_not_yield() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    seed(&mut c, "b", 100);
    supply(&mut c, "a", 300, 0, 0, 200, 100, 100, 100);
    supply(&mut c, "b", 200, 100, 120, 100, 200, 220, 100);
    let mut a = c.events.get(&"a".into()).unwrap();
    a.event.phase = EscrowPhase::Cancelled;
    c.events.insert(&"a".into(), &a);
    context("caller.testnet", 30, 1, vec![]);
    drop(c.trigger_earn_redeem("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(100, 200, 220);
    drop(c.on_vault_read("a".into(), attempt, true));
    assert_eq!(c.operation.as_ref().unwrap().amount, U128(120));
    context("escrow.testnet", 30, 1, vec![bytes(&true)]);
    drop(c.on_vault_action("a".into(), attempt));
    readings(220, 90, 90);
    drop(c.on_vault_read("a".into(), attempt, false));
    assert_eq!(
        c.events.get(&"a".into()).unwrap().event.redeemed_amount,
        U128(114)
    );
    assert_eq!(c.strategy_cash, 6);
    assert_eq!(c.provider_balance, 90);
    assert_eq!(c.total_shares, 83);
    assert_eq!(c.events.get(&"a".into()).unwrap().reserved_cash, U128(114));
}

#[test]
fn known_failure_reconciles_and_can_retry() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply("a".into()));
    let first = c.operation.as_ref().unwrap().attempt;
    readings(100, 0, 0);
    drop(c.on_vault_read("a".into(), first, true));
    context("escrow.testnet", 15, 1, vec![bytes(&U128(0))]);
    drop(c.on_vault_action("a".into(), first));
    readings(100, 0, 0);
    drop(c.on_vault_read("a".into(), first, false));
    assert!(c.operation.is_none());
    assert_eq!(
        c.events.get(&"a".into()).unwrap().event.earn_state,
        EarnState::NotStarted
    );
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply("a".into()));
    assert!(c.operation.as_ref().unwrap().attempt > first);
    readings(100, 0, 0);
    assert!(matches!(
        c.on_vault_read("a".into(), first, true),
        PromiseOrValue::Value(false)
    ));
}

#[test]
fn pending_payout_prevents_provider_operation_and_registration_rejected_during_lock() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    c.pending = 1;
    context("caller.testnet", 15, 1, vec![]);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(
            c.trigger_earn_supply("a".into())
        )))
        .is_err()
    );
    c.pending = 0;
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply("a".into()));
    context("ft.testnet", 15, 1, vec![]);
    assert!(matches!(
        c.ft_on_transfer(account("alice.testnet"), U128(100), "{}".into()),
        PromiseOrValue::Value(U128(100))
    ));
}

#[test]
fn last_event_quarantines_dust_and_next_depositor_does_not_inherit_it() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    supply(&mut c, "a", 100, 0, 0, 0, 100, 100, 100);
    let mut a = c.events.get(&"a".into()).unwrap();
    a.event.phase = EscrowPhase::Cancelled;
    c.events.insert(&"a".into(), &a);
    context("caller.testnet", 30, 1, vec![]);
    drop(c.trigger_earn_redeem("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(0, 100, 100);
    drop(c.on_vault_read("a".into(), attempt, true));
    context("escrow.testnet", 30, 1, vec![bytes(&true)]);
    drop(c.on_vault_action("a".into(), attempt));
    readings(100, 1, 0);
    drop(c.on_vault_read("a".into(), attempt, false));
    assert_eq!(c.last_operation.as_deref(), Some("REDEEM_RECONCILED"));
    assert_eq!(c.strategy_cash, 0);
    assert_eq!(c.total_shares, 0);
    assert_eq!(c.quarantined_provider_shares, 1);
    assert_eq!(c.events.get(&"a".into()).unwrap().reserved_cash, U128(100));
    readings(100, 1, 0);
    assert!(matches!(
        c.on_vault_read("a".into(), attempt, false),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(c.strategy_cash, 0);
    seed(&mut c, "b", 1000);
    supply(&mut c, "b", 1100, 1, 1000, 100, 2, 2000, 1000);
    assert_eq!(c.provider_balance, 1000);
    assert_eq!(c.quarantined_provider_shares, 1);
    assert_eq!(c.vault_shares.get(&"b".into()), Some(U128(1000)));
}

#[test]
fn missing_quarantined_provider_share_fails_closed() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    c.provider_shares = 1;
    c.quarantined_provider_shares = 1;
    context("caller.testnet", 15, 1, vec![]);
    drop(c.trigger_earn_supply("a".into()));
    let attempt = c.operation.as_ref().unwrap().attempt;
    readings(100, 0, 0);
    drop(c.on_vault_read("a".into(), attempt, true));
    assert_eq!(
        c.operation.as_ref().unwrap().stage,
        OperationStage::Ambiguous
    );
    assert_eq!(c.total_shares, 0);
    assert_eq!(c.events.get(&"a".into()).unwrap().reserved_cash, U128(100));
}

#[test]
fn finalize_requires_supplied_and_preserves_phase_on_rejection() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    for state in [EarnState::NotStarted, EarnState::SupplyPending] {
        let mut event = c.events.get(&"a".into()).unwrap();
        event.event.earn_state = state;
        c.events.insert(&"a".into(), &event);
        context("host.testnet", 20, 1, vec![]);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                || c.finalize_attendance("a".into())
            ))
            .is_err()
        );
        assert_eq!(
            c.events.get(&"a".into()).unwrap().event.phase,
            EscrowPhase::RegistrationClosed
        );
    }
    let mut event = c.events.get(&"a".into()).unwrap();
    event.event.earn_state = EarnState::Supplied;
    c.events.insert(&"a".into(), &event);
    context("host.testnet", 20, 1, vec![]);
    c.finalize_attendance("a".into());
    assert_eq!(
        c.events.get(&"a".into()).unwrap().event.phase,
        EscrowPhase::AttendanceFinalized
    );
}

#[test]
fn realized_yield_enters_liability_only_when_settled() {
    let mut c = setup();
    seed(&mut c, "a", 100);
    let mut e = c.events.get(&"a".into()).unwrap();
    e.ids.push("reg-0".into());
    e.event.phase = EscrowPhase::AttendanceFinalized;
    e.event.earn_state = EarnState::Redeemed;
    e.event.realized_yield = U128(20);
    e.reserved_cash = U128(120);
    c.events.insert(&"a".into(), &e);
    c.reserved_cash = 120;
    c.realized_yield = 20;
    c.registrations.insert(
        &"reg-0".into(),
        &RegistrationRecord {
            registration_id: "reg-0".into(),
            pass_id: "pass-0".into(),
            participant: account("alice.testnet"),
            beneficiary: account("alice.testnet"),
            commitment_id: "x".into(),
            amount: U128(100),
            sequence: 0,
            attendance: Attendance::NoShow,
            registration_status: "Active".into(),
            attendance_status: "NoShow".into(),
            claim: ClaimState::None,
            claim_amount: U128(0),
            claim_attempt: 0,
        },
    );
    assert_eq!(c.get_event_totals("a".into())["liability"], "100");
    context("caller.testnet", 30, 1, vec![]);
    c.settle("a".into());
    assert_eq!(c.get_event_totals("a".into())["liability"], "120");
    assert_eq!(c.get_event_totals("a".into())["allocated_yield"], "20");
    assert_eq!(
        c.registrations.get(&"reg-0".into()).unwrap().claim_amount,
        U128(120)
    );
}

#[test]
fn cancelled_yield_remainder_allocated_once_and_failure_restores_actual_refund() {
    let mut c = setup();
    seed(&mut c, "a", 300);
    seed(&mut c, "b", 100);
    let mut e = c.events.get(&"a".into()).unwrap();
    e.event.phase = EscrowPhase::Cancelled;
    e.event.earn_state = EarnState::Redeemed;
    e.event.realized_yield = U128(5);
    e.reserved_cash = U128(305);
    for (i, who) in ["alice.testnet", "bob.testnet", "carol.testnet"]
        .iter()
        .enumerate()
    {
        let id = format!("reg-{i}");
        e.ids.push(id.clone());
        c.registration_event.insert(&id, &"a".into());
        c.registrations.insert(
            &id,
            &RegistrationRecord {
                registration_id: id.clone(),
                pass_id: format!("pass-{i}"),
                participant: account(who),
                beneficiary: account(who),
                commitment_id: format!("c{i}"),
                amount: U128(100),
                sequence: i as u64,
                attendance: Attendance::Unmarked,
                registration_status: "Active".into(),
                attendance_status: "Unmarked".into(),
                claim: ClaimState::None,
                claim_amount: U128(0),
                claim_attempt: 0,
            },
        );
    }
    c.events.insert(&"a".into(), &e);
    c.accepted = 400;
    c.reserved_cash = 405;
    c.realized_yield = 5;
    fn claim_context(who: &str) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(account("escrow.testnet"))
            .predecessor_account_id(account(who))
            .prepaid_gas(Gas::from_tgas(300))
            .attached_deposit(NearToken::from_yoctonear(1))
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }
    claim_context("alice.testnet");
    drop(c.claim("reg-0".into()));
    assert_eq!(
        c.registrations.get(&"reg-0".into()).unwrap().claim_amount,
        U128(102)
    );
    assert_eq!(c.allocated_yield, 5);
    assert_eq!(
        c.events.get(&"a".into()).unwrap().event.yield_distributed,
        U128(5)
    );
    context("escrow.testnet", 30, 1, vec![PromiseResult::Failed]);
    c.on_claim_result("a".into(), "reg-0".into(), 1);
    assert_eq!(c.events.get(&"a".into()).unwrap().liability, U128(305));
    assert_eq!(c.events.get(&"a".into()).unwrap().reserved_cash, U128(305));
    assert_eq!(c.allocated_yield, 5);
    claim_context("alice.testnet");
    drop(c.claim("reg-0".into()));
    context("escrow.testnet", 30, 1, vec![bytes(&true)]);
    c.on_claim_result("a".into(), "reg-0".into(), 2);
    for (who, id, amount) in [
        ("bob.testnet", "reg-1", 102),
        ("carol.testnet", "reg-2", 101),
    ] {
        claim_context(who);
        drop(c.claim(id.into()));
        assert_eq!(
            c.registrations.get(&id.into()).unwrap().claim_amount,
            U128(amount)
        );
        context("escrow.testnet", 30, 1, vec![bytes(&true)]);
        c.on_claim_result("a".into(), id.into(), 1);
    }
    assert_eq!(c.events.get(&"a".into()).unwrap().paid, U128(305));
    assert_eq!(c.events.get(&"a".into()).unwrap().reserved_cash, U128(0));
    assert_eq!(c.events.get(&"a".into()).unwrap().liability, U128(0));
    assert_eq!(c.events.get(&"b".into()).unwrap().reserved_cash, U128(100));
    assert_eq!(c.events.get(&"b".into()).unwrap().liability, U128(100));
    assert_eq!(
        (
            c.accepted,
            c.allocated_yield,
            c.paid,
            c.pending,
            c.liability,
            c.reserved_cash
        ),
        (400, 5, 305, 0, 100, 100)
    );
}
