//! Deployable native-USDC EventEscrow candidate.
//!
//! This is a separate near-sdk contract struct; the accepted v6 `Contract`
//! and the local Rhea policy module remain unchanged. The Rhea adapter is
//! fail-closed (`provider_verified=false`) until ABI, receipt and liquidity
//! evidence is accepted; tests may enable a local mock only under cfg(test).

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require,
};
use serde::Deserialize;

pub const NATIVE_USDC_TESTNET_ACCOUNT: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
pub const RHEA_BURROW_READONLY_ACCOUNT: &str = "contract.main.burrow.near";
pub const RHEA_BURROW_READONLY_CODE_HASH: &str = "6Nek1M8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa";
const ONE_YOCTO: u128 = 1;
const CLAIM_GAS: u64 = 50_000_000_000_000;
const CALLBACK_GAS: u64 = 30_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowPhase {
    RegistrationOpen,
    RegistrationClosed,
    AttendanceFinalized,
    Settled,
    Cancelled,
    RefundOnly,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EarnState {
    NotStarted,
    SupplyPending,
    Supplied,
    RedeemPending,
    Redeemed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attendance {
    Unmarked,
    Attended,
    NoShow,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimState {
    None,
    Claimable,
    Pending,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EventRules {
    pub event_id: String,
    pub deposit: U128,
    pub capacity: u32,
    pub reg_open: u64,
    pub reg_close: u64,
    pub checkin_open: u64,
    pub checkin_close: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EventRecord {
    pub rules: EventRules,
    pub organizer: AccountId,
    pub phase: EscrowPhase,
    pub earn_state: EarnState,
    pub earn_attempt: u64,
    pub accepted_principal: U128,
    pub redeemed_amount: U128,
    pub realized_yield: U128,
    pub yield_distributed: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RegistrationRecord {
    pub registration_id: String,
    pub pass_id: String,
    pub participant: AccountId,
    pub beneficiary: AccountId,
    pub commitment_id: String,
    pub amount: U128,
    pub sequence: u64,
    pub attendance: Attendance,
    pub claim: ClaimState,
    pub claim_amount: U128,
    pub claim_attempt: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct PassRecord {
    pub pass_id: String,
    pub event_id: String,
    pub registration_id: String,
    pub owner: AccountId,
    pub policy_version: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EarnCallView {
    pub provider_account: AccountId,
    pub provider_code_hash: String,
    pub method: String,
    pub args_json: String,
    pub amount: U128,
    pub attempt: u64,
    pub verification_status: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EventView {
    pub event_id: String,
    pub phase: EscrowPhase,
    pub earn_state: EarnState,
    pub organizer: AccountId,
    pub canonical_ft: AccountId,
    pub deposit: U128,
    pub capacity: u32,
    pub accepted_principal: U128,
    pub redeemed_amount: U128,
    pub realized_yield: U128,
    pub yield_distributed: U128,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitMessage {
    version: u32,
    event_id: String,
    commitment_id: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
struct Config {
    organizer: AccountId,
    canonical_ft: AccountId,
    provider_account: AccountId,
    provider_code_hash: String,
    provider_verified: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EventEscrowContract {
    config: Config,
    event: Option<EventRecord>,
    registrations: LookupMap<String, RegistrationRecord>,
    passes: LookupMap<String, PassRecord>,
    active: LookupMap<AccountId, String>,
    commitments: LookupMap<String, String>,
    registration_ids: Vector<String>,
    next_registration: u64,
}

#[near]
impl EventEscrowContract {
    #[init]
    pub fn new(organizer: AccountId, provider_account: AccountId) -> Self {
        Self {
            config: Config {
                organizer,
                canonical_ft: NATIVE_USDC_TESTNET_ACCOUNT
                    .parse()
                    .expect("valid USDC account"),
                provider_account,
                provider_code_hash: RHEA_BURROW_READONLY_CODE_HASH.into(),
                provider_verified: false,
            },
            event: None,
            registrations: LookupMap::new(b"ec-r".to_vec()),
            passes: LookupMap::new(b"ec-p".to_vec()),
            active: LookupMap::new(b"ec-a".to_vec()),
            commitments: LookupMap::new(b"ec-c".to_vec()),
            registration_ids: Vector::new(b"ec-i".to_vec()),
            next_registration: 0,
        }
    }

    pub fn get_event(&self) -> Option<EventView> {
        self.event.as_ref().map(|event| EventView {
            event_id: event.rules.event_id.clone(),
            phase: event.phase,
            earn_state: event.earn_state,
            organizer: event.organizer.clone(),
            canonical_ft: self.config.canonical_ft.clone(),
            deposit: event.rules.deposit,
            capacity: event.rules.capacity,
            accepted_principal: event.accepted_principal,
            redeemed_amount: event.redeemed_amount,
            realized_yield: event.realized_yield,
            yield_distributed: event.yield_distributed,
        })
    }

    pub fn get_registration(&self, registration_id: String) -> Option<RegistrationRecord> {
        self.registrations.get(&registration_id)
    }
    pub fn get_pass(&self, pass_id: String) -> Option<PassRecord> {
        self.passes.get(&pass_id)
    }
    pub fn canonical_ft(&self) -> AccountId {
        self.config.canonical_ft.clone()
    }

    pub fn publish_event(&mut self, rules: EventRules) {
        self.create_event(rules);
    }
    pub fn create_event(&mut self, rules: EventRules) {
        require!(
            env::predecessor_account_id() == self.config.organizer,
            "organizer required"
        );
        require!(self.event.is_none(), "event already created");
        require!(
            rules.deposit.0 > 0 && rules.capacity > 0 && rules.capacity <= 200,
            "invalid event economics"
        );
        require!(
            rules.reg_open < rules.reg_close
                && rules.reg_close <= rules.checkin_open
                && rules.checkin_open < rules.checkin_close,
            "invalid event times"
        );
        self.event = Some(EventRecord {
            rules,
            organizer: self.config.organizer.clone(),
            phase: EscrowPhase::RegistrationOpen,
            earn_state: EarnState::NotStarted,
            earn_attempt: 0,
            accepted_principal: U128(0),
            redeemed_amount: U128(0),
            realized_yield: U128(0),
            yield_distributed: U128(0),
        });
    }

    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.config.canonical_ft {
            return PromiseOrValue::Value(amount);
        }
        let Ok(message) = near_sdk::serde_json::from_str::<CommitMessage>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if message.version != 1 {
            return PromiseOrValue::Value(amount);
        }
        let Some(mut event) = self.event.clone() else {
            return PromiseOrValue::Value(amount);
        };
        let now = env::block_timestamp_ms();
        if message.event_id != event.rules.event_id
            || event.phase != EscrowPhase::RegistrationOpen
            || now < event.rules.reg_open
            || now >= event.rules.reg_close
            || amount.0 != event.rules.deposit.0
            || event.accepted_principal.0 / event.rules.deposit.0 >= event.rules.capacity as u128
            || self.commitments.get(&message.commitment_id).is_some()
            || self.active.get(&sender_id).is_some()
        {
            return PromiseOrValue::Value(amount);
        }
        let seq = (event.accepted_principal.0 / event.rules.deposit.0) as u64;
        let registration_id = format!("{}-reg-{}", event.rules.event_id, self.next_registration);
        let pass_id = format!("{}-pass-{}", event.rules.event_id, seq);
        self.next_registration = self
            .next_registration
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("registration overflow"));
        self.commitments
            .insert(&message.commitment_id, &registration_id);
        self.active.insert(&sender_id, &registration_id);
        self.registrations.insert(
            &registration_id,
            &RegistrationRecord {
                registration_id: registration_id.clone(),
                pass_id: pass_id.clone(),
                participant: sender_id.clone(),
                beneficiary: sender_id.clone(),
                commitment_id: message.commitment_id,
                amount,
                sequence: seq,
                attendance: Attendance::Unmarked,
                claim: ClaimState::None,
                claim_amount: U128(0),
                claim_attempt: 0,
            },
        );
        self.registration_ids.push(&registration_id);
        self.passes.insert(
            &pass_id,
            &PassRecord {
                pass_id: pass_id.clone(),
                event_id: event.rules.event_id.clone(),
                registration_id,
                owner: sender_id,
                policy_version: "showstake-native-usdc-event/1".into(),
            },
        );
        event.accepted_principal = U128(
            event
                .accepted_principal
                .0
                .checked_add(amount.0)
                .unwrap_or_else(|| env::panic_str("principal overflow")),
        );
        self.event = Some(event);
        PromiseOrValue::Value(U128(0))
    }

    pub fn close_registration(&mut self) {
        let event = self.event.as_mut().expect("event missing");
        require!(
            event.phase == EscrowPhase::RegistrationOpen
                && env::block_timestamp_ms() >= event.rules.reg_close,
            "registration not closable"
        );
        event.phase = EscrowPhase::RegistrationClosed;
    }

    pub fn trigger_earn_supply(&mut self) -> EarnCallView {
        require!(
            self.config.provider_verified,
            "Rhea provider ABI/code hash not accepted"
        );
        let provider_account = self.config.provider_account.clone();
        let event = self.event.as_mut().expect("event missing");
        require!(
            event.phase == EscrowPhase::RegistrationClosed
                && event.earn_state == EarnState::NotStarted
                && event.accepted_principal.0 > 0,
            "supply gate closed"
        );
        event.earn_attempt += 1;
        event.earn_state = EarnState::SupplyPending;
        let args_json = near_sdk::serde_json::json!({
            "receiver_id": provider_account.clone(),
            "amount": event.accepted_principal.0.to_string(),
            "msg": ""
        })
        .to_string();
        EarnCallView {
            provider_account,
            provider_code_hash: self.config.provider_code_hash.clone(),
            method: "ft_transfer_call".into(),
            args_json,
            amount: event.accepted_principal,
            attempt: event.earn_attempt,
            verification_status: "READ_ONLY_UNVERIFIED_ABI".into(),
        }
    }

    pub fn on_earn_supply_result(&mut self, attempt: u64, succeeded: bool, amount: U128) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "callback self only"
        );
        let event = self.event.as_mut().expect("event missing");
        require!(
            event.earn_state == EarnState::SupplyPending
                && event.earn_attempt == attempt
                && amount.0 == event.accepted_principal.0,
            "stale or invalid supply callback"
        );
        event.earn_state = if succeeded {
            EarnState::Supplied
        } else {
            EarnState::NotStarted
        };
    }

    pub fn mark_attendance(&mut self, registration_id: String, attended: bool) {
        require!(
            env::predecessor_account_id() == self.config.organizer,
            "organizer required"
        );
        let event = self.event.as_ref().expect("event missing");
        require!(
            event.phase == EscrowPhase::RegistrationClosed
                && env::block_timestamp_ms() >= event.rules.checkin_open
                && env::block_timestamp_ms() < event.rules.checkin_close,
            "check-in gate closed"
        );
        let mut registration = self
            .registrations
            .get(&registration_id)
            .expect("registration missing");
        registration.attendance = if attended {
            Attendance::Attended
        } else {
            Attendance::Unmarked
        };
        self.registrations.insert(&registration_id, &registration);
    }

    pub fn finalize_attendance(&mut self) {
        require!(
            env::predecessor_account_id() == self.config.organizer,
            "organizer required"
        );
        let event = self.event.as_ref().expect("event missing");
        require!(
            event.phase == EscrowPhase::RegistrationClosed
                && event.earn_state == EarnState::Supplied
                && env::block_timestamp_ms() >= event.rules.checkin_close,
            "finalize gate closed"
        );
        for registration_id in self.registration_ids.to_vec() {
            if let Some(mut registration) = self.registrations.get(&registration_id) {
                if registration.attendance == Attendance::Unmarked {
                    registration.attendance = Attendance::NoShow;
                }
                registration.claim = ClaimState::Claimable;
                self.registrations.insert(&registration_id, &registration);
            }
        }
        self.event.as_mut().expect("event missing").phase = EscrowPhase::AttendanceFinalized;
    }

    pub fn trigger_earn_redeem(&mut self) -> EarnCallView {
        require!(
            self.config.provider_verified,
            "Rhea provider ABI/code hash not accepted"
        );
        let provider_account = self.config.provider_account.clone();
        let event = self.event.as_mut().expect("event missing");
        require!(
            event.earn_state == EarnState::Supplied
                && env::block_timestamp_ms() >= event.rules.checkin_close,
            "redeem gate closed"
        );
        event.earn_attempt += 1;
        event.earn_state = EarnState::RedeemPending;
        let args_json = near_sdk::serde_json::json!({
            "actions": [{
                "Withdraw": {
                    "token_id": self.config.canonical_ft,
                    "max_amount": u128::MAX.to_string()
                }
            }]
        })
        .to_string();
        EarnCallView {
            provider_account,
            provider_code_hash: self.config.provider_code_hash.clone(),
            method: "execute".into(),
            args_json,
            amount: event.accepted_principal,
            attempt: event.earn_attempt,
            verification_status: "READ_ONLY_UNVERIFIED_ABI".into(),
        }
    }

    pub fn on_earn_redeem_result(&mut self, attempt: u64, succeeded: bool, amount: U128) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "callback self only"
        );
        let event = self.event.as_mut().expect("event missing");
        require!(
            event.earn_state == EarnState::RedeemPending && event.earn_attempt == attempt,
            "stale redeem callback"
        );
        if succeeded {
            require!(
                amount.0 >= event.accepted_principal.0,
                "redeemed below principal"
            );
            event.redeemed_amount = amount;
            event.realized_yield = U128(amount.0 - event.accepted_principal.0);
            event.earn_state = EarnState::Redeemed;
        } else {
            event.earn_state = EarnState::Supplied;
        }
    }

    pub fn settle(&mut self) {
        let (deposit, realized_yield) = {
            let event = self.event.as_ref().expect("event missing");
            require!(
                event.phase == EscrowPhase::AttendanceFinalized
                    && event.earn_state == EarnState::Redeemed,
                "settlement gate closed"
            );
            (event.rules.deposit.0, event.realized_yield.0)
        };
        let mut attendees = Vec::new();
        let mut no_show = 0u128;
        let mut count = 0u128;
        for registration_id in self.registration_ids.to_vec() {
            if let Some(registration) = self.registrations.get(&registration_id) {
                count += 1;
                if registration.attendance == Attendance::Attended {
                    attendees.push(registration_id);
                } else {
                    no_show += deposit;
                }
            }
        }
        if attendees.is_empty() {
            let base = realized_yield / count;
            let rem = realized_yield % count;
            let mut i = 0u64;
            for registration_id in self.registration_ids.to_vec() {
                if let Some(mut registration) = self.registrations.get(&registration_id) {
                    registration.claim_amount =
                        U128(deposit + base + if i < rem as u64 { 1 } else { 0 });
                    self.registrations.insert(&registration_id, &registration);
                    i += 1;
                }
            }
        } else {
            let pool = no_show + realized_yield;
            let base = pool / attendees.len() as u128;
            let rem = pool % attendees.len() as u128;
            for registration_id in attendees.iter() {
                let mut registration = self
                    .registrations
                    .get(registration_id)
                    .expect("registration missing");
                registration.claim_amount = U128(
                    deposit
                        + base
                        + if registration.sequence < rem as u64 {
                            1
                        } else {
                            0
                        },
                );
                self.registrations.insert(registration_id, &registration);
            }
        }
        let event = self.event.as_mut().expect("event missing");
        event.yield_distributed = U128(realized_yield);
        event.phase = EscrowPhase::Settled;
    }

    #[payable]
    pub fn claim(&mut self, registration_id: String) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == ONE_YOCTO,
            "one yocto required"
        );
        let event = self.event.as_ref().expect("event missing");
        require!(
            event.phase == EscrowPhase::Settled && event.earn_state == EarnState::Redeemed,
            "claim gate closed"
        );
        let mut registration = self
            .registrations
            .get(&registration_id)
            .expect("registration missing");
        require!(
            registration.beneficiary == env::predecessor_account_id()
                && registration.claim == ClaimState::Claimable,
            "claim not authorized"
        );
        registration.claim_attempt += 1;
        registration.claim = ClaimState::Pending;
        self.registrations.insert(&registration_id, &registration);
        let payout_id = format!("{}:{}", registration_id, registration.claim_attempt);
        Promise::new(self.config.canonical_ft.clone()).function_call("ft_transfer", near_sdk::serde_json::json!({"receiver_id": registration.beneficiary, "amount": registration.claim_amount.0.to_string(), "memo": payout_id}).to_string().into_bytes(), NearToken::from_yoctonear(ONE_YOCTO), Gas::from_gas(CLAIM_GAS)).then(Promise::new(env::current_account_id()).function_call("on_claim_result", near_sdk::serde_json::json!({"registration_id": registration_id, "attempt": registration.claim_attempt}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_gas(CALLBACK_GAS)))
    }

    #[private]
    pub fn on_claim_result(&mut self, registration_id: String, attempt: u64) {
        let mut registration = self
            .registrations
            .get(&registration_id)
            .expect("registration missing");
        require!(
            registration.claim == ClaimState::Pending && registration.claim_attempt == attempt,
            "stale claim callback"
        );
        let success = env::promise_result_checked(0, usize::MAX).is_ok();
        registration.claim = if success {
            ClaimState::Paid
        } else {
            ClaimState::Claimable
        };
        self.registrations.insert(&registration_id, &registration);
    }

    #[cfg(test)]
    pub fn enable_mock_provider_for_test(&mut self) {
        self.config.provider_verified = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn account(value: &str) -> AccountId {
        value.parse().unwrap()
    }
    fn context(predecessor: &str, timestamp: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(account("event.testnet"))
                .predecessor_account_id(account(predecessor))
                .block_timestamp(timestamp * 1_000_000)
                .build()
        );
    }
    fn rules() -> EventRules {
        EventRules {
            event_id: "e".into(),
            deposit: U128(10),
            capacity: 10,
            reg_open: 10,
            reg_close: 20,
            checkin_open: 20,
            checkin_close: 30,
        }
    }

    #[test]
    fn mock_native_usdc_registration_and_earn_gates() {
        context("host.testnet", 0);
        let mut c = EventEscrowContract::new(account("host.testnet"), account("rhea.mock"));
        context("host.testnet", 0);
        c.publish_event(rules());
        context(NATIVE_USDC_TESTNET_ACCOUNT, 10);
        assert_eq!(near_sdk::env::predecessor_account_id(), c.canonical_ft());
        assert_eq!(near_sdk::env::block_timestamp_ms(), 10);
        let accepted = c.ft_on_transfer(
            account("alice.testnet"),
            U128(10),
            r#"{"version":1,"event_id":"e","commitment_id":"c1"}"#.into(),
        );
        let accepted_is_zero = matches!(&accepted, PromiseOrValue::Value(value) if value.0 == 0);
        assert!(accepted_is_zero);
        context("relayer.testnet", 20);
        c.close_registration();
        c.enable_mock_provider_for_test();
        let call = c.trigger_earn_supply();
        assert_eq!(call.method, "ft_transfer_call");
        assert!(call.args_json.contains("rhea.mock"));
        context("event.testnet", 0);
        c.on_earn_supply_result(1, true, U128(10));
        context("host.testnet", 30);
        c.finalize_attendance();
        c.trigger_earn_redeem();
        context("event.testnet", 30);
        c.on_earn_redeem_result(2, true, U128(11));
        assert_eq!(c.get_event().unwrap().realized_yield, U128(1));
    }
}
