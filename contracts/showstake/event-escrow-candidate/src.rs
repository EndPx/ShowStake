//! Deployable native-USDC EventEscrow candidate.
//!
//! This is a separate near-sdk contract struct; the accepted v6 `Contract`
//! and the local Rhea policy module remain unchanged. The Rhea review adapter
//! is feature-gated, paused and capped at zero on initialization; funded provider
//! receipt/liquidity acceptance is separate from local build and codec tests.

#[cfg(feature = "mainnet-review")]
mod rhea_adapter;

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require,
};
use serde::Deserialize;

/// Circle addresses are production candidates only; neither is the testnet
/// default. Testnet uses the explicit frozen test-ft account passed to `new`.
pub const CIRCLE_NATIVE_USDC_MAINNET_ACCOUNT: &str =
    "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub const CIRCLE_NATIVE_USDC_TESTNET_ACCOUNT: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
pub const RHEA_BURROW_READONLY_ACCOUNT: &str = "contract.main.burrow.near";
pub const RHEA_BURROW_READONLY_CODE_HASH: &str = "6Nek1MZ8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa";
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
    pub title: String,
    pub location: String,
    pub rules_text: String,
    pub finalize_deadline: u64,
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
    pub created_at: u64,
    pub organizer: AccountId,
    pub phase: EscrowPhase,
    pub earn_state: EarnState,
    pub earn_attempt: u64,
    pub accepted_principal: U128,
    pub redeemed_amount: U128,
    pub realized_yield: U128,
    pub yield_distributed: U128,
    pub earn_baseline_balance: U128,
    pub earn_action_completed: bool,
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
    pub registration_status: String,
    pub attendance_status: String,
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
    pub registration_status: String,
    pub attendance_status: String,
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
    pub title: String,
    pub location: String,
    pub rules_text: String,
    pub phase: EscrowPhase,
    pub earn_state: EarnState,
    pub earn_attempt: u64,
    pub earn_action_completed: bool,
    pub organizer: AccountId,
    pub canonical_ft: AccountId,
    pub policy_version: String,
    pub deposit: U128,
    pub capacity: u32,
    pub reg_open: u64,
    pub reg_close: u64,
    pub checkin_open: u64,
    pub checkin_close: u64,
    pub cancel_cutoff: u64,
    pub finalize_deadline: u64,
    pub active_registrations: u32,
    pub total_registrations: u32,
    pub withdrawn_registrations: u32,
    pub rules_hash: String,
    pub created_at: u64,
    pub accepted_principal: U128,
    pub redeemed_amount: U128,
    pub realized_yield: U128,
    pub yield_distributed: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub organizer: AccountId,
    pub canonical_ft: AccountId,
    pub network: String,
    pub policy_version: String,
    pub provider_account: AccountId,
    pub provider_kind: String,
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
    token_symbol: String,
    token_name: String,
    token_decimals: u8,
    provider_account: AccountId,
    provider_kind: String,
}

#[cfg(feature = "mainnet-review")]
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RheaStage { Idle, Preparing, Dispatched, TerminalUsed, TerminalRefund, Ambiguous }

#[cfg(feature = "mainnet-review")]
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RheaControl {
    pub paused: bool,
    pub stage: RheaStage,
    pub principal_cap: U128,
    pub shares: U128,
    pub last_internal_balance: U128,
    pub baseline_ft: U128,
    pub expected_return: U128,
    #[cfg(feature = "rhea-linked-withdraw-review")]
    pub retry_after_block: u64,
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
    #[cfg(feature = "mainnet-review")]
    rhea: RheaControl,
}

#[near]
impl EventEscrowContract {
    fn policy_version(&self) -> String {
        #[cfg(feature = "rhea-linked-withdraw-review")]
        if self.config.provider_kind == "RHEA_MAINNET" { return "showstake-native-usdc-rhea-linked-withdraw-review/2".into(); }
        if self.config.provider_kind == "RHEA_MAINNET" { "showstake-native-usdc-rhea-review/1" } else { "showstake-native-usdc-event/1" }.into()
    }
    #[init]
    pub fn new(
        organizer: AccountId,
        provider_account: AccountId,
        canonical_ft: AccountId,
        token_symbol: String,
        token_name: String,
        token_decimals: u8,
        provider_kind: String,
    ) -> Self {
        if provider_kind == "MOCK_TESTNET" {
            require!(env::current_account_id().as_str().ends_with(".testnet") && provider_account.as_str().ends_with(".testnet") && canonical_ft.as_str().ends_with(".testnet"), "mock provider requires testnet accounts");
        } else {
            #[cfg(feature = "mainnet-review")]
            require!(provider_kind == "RHEA_MAINNET" && provider_account.as_str() == rhea_adapter::PROVIDER && canonical_ft.as_str() == rhea_adapter::USDC && !env::current_account_id().as_str().ends_with(".testnet"), "invalid Rhea configuration");
            #[cfg(not(feature = "mainnet-review"))]
            env::panic_str("only MOCK_TESTNET supported");
        }
        require!(provider_account != canonical_ft && provider_account != env::current_account_id(), "invalid provider");
        require!(token_symbol == "USDC", "canonical FT symbol must be USDC");
        require!(!token_name.is_empty(), "canonical FT name required");
        require!(token_decimals == 6, "canonical FT decimals must be 6");
        Self {
            config: Config {
                organizer,
                canonical_ft,
                token_symbol,
                token_name,
                token_decimals,
                provider_account,
                provider_kind,
            },
            event: None,
            registrations: LookupMap::new(b"ec-r".to_vec()),
            passes: LookupMap::new(b"ec-p".to_vec()),
            active: LookupMap::new(b"ec-a".to_vec()),
            commitments: LookupMap::new(b"ec-c".to_vec()),
            registration_ids: Vector::new(b"ec-i".to_vec()),
            next_registration: 0,
            #[cfg(feature = "mainnet-review")]
            rhea: RheaControl { paused: true, stage: RheaStage::Idle, principal_cap: U128(0), shares: U128(0), last_internal_balance: U128(0), baseline_ft: U128(0), expected_return: U128(0), #[cfg(feature = "rhea-linked-withdraw-review")] retry_after_block: 0 },
        }
    }

    pub fn get_event(&self) -> Option<EventView> {
        self.event.as_ref().map(|event| EventView {
            event_id: event.rules.event_id.clone(),
            title: event.rules.title.clone(),
            location: event.rules.location.clone(),
            rules_text: event.rules.rules_text.clone(),
            phase: event.phase,
            earn_state: event.earn_state,
            earn_attempt: event.earn_attempt,
            earn_action_completed: event.earn_action_completed,
            organizer: event.organizer.clone(),
            canonical_ft: self.config.canonical_ft.clone(),
            policy_version: self.policy_version(),
            deposit: event.rules.deposit,
            capacity: event.rules.capacity,
            reg_open: event.rules.reg_open,
            reg_close: event.rules.reg_close,
            checkin_open: event.rules.checkin_open,
            checkin_close: event.rules.checkin_close,
            cancel_cutoff: event.rules.reg_close,
            finalize_deadline: event.rules.finalize_deadline,
            active_registrations: self.registration_ids.len() as u32,
            total_registrations: self.registration_ids.len() as u32,
            withdrawn_registrations: 0,
            rules_hash: String::new(),
            created_at: event.created_at,
            accepted_principal: event.accepted_principal,
            redeemed_amount: event.redeemed_amount,
            realized_yield: event.realized_yield,
            yield_distributed: event.yield_distributed,
        })
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            organizer: self.config.organizer.clone(),
            canonical_ft: self.config.canonical_ft.clone(),
            network: if self.config.provider_kind == "RHEA_MAINNET" { "mainnet" } else { "testnet" }.into(),
            policy_version: self.policy_version(),
            provider_account: self.config.provider_account.clone(),
            provider_kind: self.config.provider_kind.clone(),
        }
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

    pub fn get_block_timestamp_ms(&self) -> u64 {
        env::block_timestamp_ms()
    }

    pub fn list_event_registrations(
        &self,
        event_id: String,
        from: u64,
        limit: u64,
    ) -> Vec<RegistrationRecord> {
        if self.event.as_ref().map(|event| event.rules.event_id.as_str()) != Some(event_id.as_str()) {
            return Vec::new();
        }
        self.registration_ids
            .to_vec()
            .into_iter()
            .skip(from as usize)
            .take(limit.min(50) as usize)
            .filter_map(|registration_id| self.registrations.get(&registration_id))
            .collect()
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
                && rules.checkin_open < rules.checkin_close
                && rules.checkin_close < rules.finalize_deadline,
            "invalid event times"
        );
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" {
            require!(rules.finalize_deadline == rules.checkin_close.checked_add(86_400_000).expect("deadline overflow"), "mainnet requires 24h finalization deadline");
            require!(!rules.title.is_empty() && rules.title.len() <= 256 && !rules.location.is_empty() && rules.location.len() <= 512 && !rules.rules_text.is_empty() && rules.rules_text.len() <= 8192 && !rules.event_id.is_empty() && rules.event_id.len() <= 128, "mainnet metadata bounds");
            let total = rules.deposit.0.checked_mul(rules.capacity as u128).expect("cap overflow");
            require!(!self.rhea.paused && self.rhea.principal_cap.0 > 0 && total <= self.rhea.principal_cap.0, "mainnet cap or pause");
        }
        self.event = Some(EventRecord {
            rules,
            created_at: env::block_timestamp_ms(),
            organizer: self.config.organizer.clone(),
            phase: EscrowPhase::RegistrationOpen,
            earn_state: EarnState::NotStarted,
            earn_attempt: 0,
            accepted_principal: U128(0),
            redeemed_amount: U128(0),
            realized_yield: U128(0),
            yield_distributed: U128(0),
            earn_baseline_balance: U128(0),
            earn_action_completed: false,
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
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" && self.rhea.paused { return PromiseOrValue::Value(amount); }
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
        if message.commitment_id.is_empty() || message.commitment_id.len() > 128 { return PromiseOrValue::Value(amount); }
        let before_storage = env::storage_usage();
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
                commitment_id: message.commitment_id.clone(),
                amount,
                sequence: seq,
                attendance: Attendance::Unmarked,
                registration_status: "Active".into(),
                attendance_status: "Unmarked".into(),
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
                registration_id: registration_id.clone(),
                owner: sender_id.clone(),
                registration_status: "Active".into(),
                attendance_status: "Unmarked".into(),
                policy_version: self.policy_version(),
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
        let used = env::storage_usage().checked_sub(before_storage).expect("storage underflow");
        let required = (env::storage_usage() as u128).checked_mul(env::storage_byte_cost().as_yoctonear()).expect("storage cost overflow");
        require!(env::account_balance().as_yoctonear() >= required, "contract storage funding insufficient");
        log_event("RegistrationCommitted", near_sdk::serde_json::json!({"event_id":message.event_id,"registration_id":registration_id,"pass_id":pass_id,"participant":sender_id,"beneficiary":sender_id,"commitment_id":message.commitment_id,"amount":amount.0.to_string(),"event_sequence":seq,"storage_bytes":used}));
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

    /// Preflight queries both contracts before sending funds. No retry sends a
    /// second transfer while a previous one has an unresolved receipt.
    pub fn trigger_earn_supply(&mut self) -> Promise {
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" { require!(!self.rhea.paused, "supply paused"); }
        let event = self.event.as_mut().expect("event missing");
        require!(event.phase == EscrowPhase::RegistrationClosed && event.earn_state == EarnState::NotStarted && event.accepted_principal.0 > 0, "supply gate closed");
        #[cfg(feature = "rhea-linked-withdraw-review")]
        if self.config.provider_kind == "RHEA_MAINNET" { require!(env::block_timestamp_ms() >= event.rules.checkin_open && env::block_timestamp_ms() < event.rules.finalize_deadline, "supply window closed"); }
        event.earn_attempt = event.earn_attempt.checked_add(1).expect("earn attempt overflow");
        event.earn_state = EarnState::SupplyPending;
        event.earn_action_completed = false;
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" {
            self.rhea.stage = RheaStage::Preparing;
            #[cfg(feature = "rhea-linked-withdraw-review")]
            { self.rhea.retry_after_block = env::block_height().saturating_add(20); }
        }
        let attempt = event.earn_attempt;
        self.query_earn(attempt, true)
    }

    fn query_earn(&self, attempt: u64, preflight: bool) -> Promise {
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" { return self.query_rhea(attempt, preflight); }
        let current = env::current_account_id();
        let balance = Promise::new(self.config.canonical_ft.clone()).function_call(
            "ft_balance_of", near_sdk::serde_json::json!({"account_id": current}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10));
        let position = Promise::new(self.config.provider_account.clone()).function_call(
            "get_position", near_sdk::serde_json::json!({"account_id": env::current_account_id()}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10));
        balance.and(position).then(Promise::new(env::current_account_id()).function_call(
            "on_earn_reconcile", near_sdk::serde_json::json!({"attempt": attempt, "preflight": preflight}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(if preflight { 170 } else { 30 })))
    }

    /// Retry only reads after a terminal operation callback; never reissue funds.
    pub fn reconcile_earn(&mut self) -> Promise {
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" {
            let event = self.event.as_mut().expect("event missing");
            require!(matches!(event.earn_state, EarnState::SupplyPending | EarnState::RedeemPending), "reconciliation unavailable");
            if self.rhea.stage == RheaStage::Preparing {
                #[cfg(feature = "rhea-linked-withdraw-review")]
                {
                    let refund = matches!(event.phase, EscrowPhase::Cancelled | EscrowPhase::RefundOnly);
                    require!(env::predecessor_account_id() == self.config.organizer || (refund && env::block_height() >= self.rhea.retry_after_block), "preflight retry unavailable");
                    self.rhea.retry_after_block = env::block_height().saturating_add(20);
                }
                #[cfg(not(feature = "rhea-linked-withdraw-review"))]
                require!(env::predecessor_account_id() == self.config.organizer, "organizer required for preflight retry");
                event.earn_attempt=event.earn_attempt.checked_add(1).expect("attempt overflow");
                let attempt=event.earn_attempt;
                return self.query_rhea(attempt,true);
            }
            require!(matches!(self.rhea.stage,RheaStage::TerminalUsed|RheaStage::TerminalRefund), "receipt unresolved");
            let attempt=event.earn_attempt;
            return self.query_rhea(attempt,false);
        }
        let event = self.event.as_ref().expect("event missing");
        require!(matches!(event.earn_state, EarnState::SupplyPending | EarnState::RedeemPending) && event.earn_action_completed, "reconciliation unavailable");
        self.query_earn(event.earn_attempt, false)
    }

    #[private]
    pub fn on_earn_reconcile(&mut self, attempt: u64, preflight: bool) -> PromiseOrValue<bool> {
        let event = self.event.as_ref().expect("event missing");
        if event.earn_attempt != attempt || !matches!(event.earn_state, EarnState::SupplyPending | EarnState::RedeemPending) { return PromiseOrValue::Value(false); }
        let balance = env::promise_result_checked(0, 128).ok().and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
        let position = env::promise_result_checked(1, 128).ok().and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
        let (Some(balance), Some(position)) = (balance, position) else {
            if preflight && !event.earn_action_completed { self.event.as_mut().unwrap().earn_state = EarnState::NotStarted; }
            return PromiseOrValue::Value(false);
        };
        let event = self.event.as_mut().unwrap();
        let principal = event.accepted_principal.0;
        if preflight {
            if event.earn_state != EarnState::SupplyPending || event.earn_action_completed { return PromiseOrValue::Value(false); }
            if position.0 != 0 || balance.0 < principal { event.earn_state = EarnState::NotStarted; return PromiseOrValue::Value(false); }
            event.earn_baseline_balance = balance;
            // Set before constructing the receipt; the only way to reconcile after
            // dispatch is the private terminal action callback.
            let transfer = Promise::new(self.config.canonical_ft.clone()).function_call(
                "ft_transfer_call", near_sdk::serde_json::json!({"receiver_id": self.config.provider_account, "amount": principal.to_string(), "msg": ""}).to_string().into_bytes(), NearToken::from_yoctonear(ONE_YOCTO), Gas::from_tgas(60));
            return PromiseOrValue::Promise(transfer.then(Self::earn_action_callback(attempt)));
        }
        if !event.earn_action_completed { return PromiseOrValue::Value(false); }
        let baseline = event.earn_baseline_balance.0;
        let supplied_balance = baseline.checked_sub(principal).expect("invalid supply baseline");
        match event.earn_state {
            EarnState::SupplyPending if balance.0 == supplied_balance && position.0 == principal => event.earn_state = EarnState::Supplied,
            EarnState::SupplyPending if balance.0 == baseline && position.0 == 0 => event.earn_state = EarnState::NotStarted,
            EarnState::RedeemPending if balance.0 == baseline && position.0 == 0 => { event.earn_state = EarnState::Redeemed; event.redeemed_amount = U128(principal); event.realized_yield = U128(0); },
            EarnState::RedeemPending if balance.0 == supplied_balance && position.0 == principal => event.earn_state = EarnState::Supplied,
            _ => return PromiseOrValue::Value(false),
        }
        event.earn_action_completed = false;
        PromiseOrValue::Value(true)
    }

    fn earn_action_callback(attempt: u64) -> Promise {
        Promise::new(env::current_account_id()).function_call("on_earn_action", near_sdk::serde_json::json!({"attempt": attempt}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(90))
    }

    #[private]
    pub fn on_earn_action(&mut self, attempt: u64) -> PromiseOrValue<bool> {
        let event = self.event.as_mut().expect("event missing");
        if event.earn_attempt != attempt || !matches!(event.earn_state, EarnState::SupplyPending | EarnState::RedeemPending) || event.earn_action_completed { return PromiseOrValue::Value(false); }
        // Inspect the terminal promise result, but never trust it as accounting.
        let _terminal_result = env::promise_result_checked(0, 1024);
        event.earn_action_completed = true;
        PromiseOrValue::Promise(self.query_earn(attempt, false))
    }

    /// REVIEW_NOT_ACCEPTED: config is immutable after publishing an event.
    #[cfg(feature = "mainnet-review")]
    pub fn configure_rhea_cap(&mut self, principal_cap: U128) {
        require!(env::predecessor_account_id() == self.config.organizer && self.config.provider_kind == "RHEA_MAINNET" && self.event.is_none(), "configuration gate closed");
        require!(principal_cap.0 > 0, "cap required");
        self.rhea.principal_cap = principal_cap;
    }

    #[cfg(feature = "mainnet-review")]
    pub fn set_rhea_paused(&mut self, paused: bool) {
        require!(env::predecessor_account_id() == self.config.organizer && self.config.provider_kind == "RHEA_MAINNET", "organizer required");
        self.rhea.paused = paused;
    }

    #[cfg(feature = "mainnet-review")]
    pub fn get_rhea_control(&self) -> RheaControl { self.rhea.clone() }

    /// Owner funds precisely the attached storage deposit; never spends escrow FT.
    /// Registration must still be verified independently before supply.
    #[cfg(feature = "mainnet-review")]
    #[payable]
    pub fn rhea_storage_deposit(&mut self, target: String) -> Promise {
        require!(env::predecessor_account_id() == self.config.organizer && self.config.provider_kind == "RHEA_MAINNET", "organizer required");
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() > 0, "storage deposit required");
        let account = match target.as_str() { "provider" => self.config.provider_account.clone(), "ft" => self.config.canonical_ft.clone(), _ => env::panic_str("unknown storage target") };
        Promise::new(account).function_call("storage_deposit", near_sdk::serde_json::json!({"account_id":env::current_account_id()}).to_string().into_bytes(), deposit, Gas::from_tgas(30))
    }

    #[cfg(feature = "mainnet-review")]
    fn query_rhea(&self, attempt: u64, preflight: bool) -> Promise {
        let account = env::current_account_id();
        let ft = Promise::new(self.config.canonical_ft.clone()).function_call("ft_balance_of", near_sdk::serde_json::json!({"account_id":account}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10));
        let pos = Promise::new(self.config.provider_account.clone()).function_call("get_account", near_sdk::serde_json::json!({"account_id":env::current_account_id()}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(15));
        let asset = Promise::new(self.config.provider_account.clone()).function_call("get_asset", near_sdk::serde_json::json!({"token_id":self.config.canonical_ft}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(15));
        #[cfg(feature = "rhea-linked-withdraw-review")]
        let preflight_gas = 220;
        #[cfg(not(feature = "rhea-linked-withdraw-review"))]
        let preflight_gas = 180;
        ft.and(pos).and(asset).then(Promise::new(env::current_account_id()).function_call("on_rhea_reconcile", near_sdk::serde_json::json!({"attempt":attempt,"preflight":preflight}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(if preflight { preflight_gas } else { 40 })))
    }

    #[cfg(feature = "mainnet-review")]
    #[private]
    pub fn on_rhea_reconcile(&mut self, attempt: u64, preflight: bool) -> PromiseOrValue<bool> {
        let event = self.event.as_ref().expect("event missing");
        if event.earn_attempt != attempt || !matches!(event.earn_state, EarnState::SupplyPending | EarnState::RedeemPending) || env::promise_results_count() != 3 { return PromiseOrValue::Value(false); }
        if (preflight && self.rhea.stage != RheaStage::Preparing) || (!preflight && !matches!(self.rhea.stage,RheaStage::TerminalUsed|RheaStage::TerminalRefund)) { return PromiseOrValue::Value(false); }
        #[cfg(feature = "rhea-linked-withdraw-review")]
        if preflight && event.earn_state == EarnState::SupplyPending
            && (event.phase != EscrowPhase::RegistrationClosed || env::block_timestamp_ms() < event.rules.checkin_open || env::block_timestamp_ms() >= event.rules.finalize_deadline) {
            let event = self.event.as_mut().unwrap();
            event.earn_state = EarnState::NotStarted;
            event.earn_action_completed = false;
            self.rhea.stage = RheaStage::Idle;
            return PromiseOrValue::Value(false);
        }
        let ft = env::promise_result_checked(0, 128).ok().and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
        let pos = env::promise_result_checked(1, 65536).ok();
        let asset = env::promise_result_checked(2, 65536).ok().and_then(|v| rhea_adapter::decode_asset("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,&v).ok());
        let (Some(ft),Some(pos),Some(asset)) = (ft,pos,asset) else { return PromiseOrValue::Value(false); };
        let Ok(position) = rhea_adapter::decode_position("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,env::current_account_id().as_str(),&pos,&asset) else { return PromiseOrValue::Value(false); };
        let event = self.event.as_mut().unwrap();
        if preflight {
            if event.earn_state == EarnState::RedeemPending {
                #[cfg(feature = "rhea-linked-withdraw-review")]
                {
                    let Some(base) = self.rhea.baseline_ft.0.checked_sub(event.accepted_principal.0) else { return PromiseOrValue::Value(false); };
                    let Some(min_ft) = base.checked_add(event.redeemed_amount.0) else { return PromiseOrValue::Value(false); };
                    let remaining_principal = event.accepted_principal.0.saturating_sub(event.redeemed_amount.0);
                    if event.earn_action_completed || position.shares == 0 || position.shares != self.rhea.shares.0 || ft.0 < min_ft || position.token_atomics_floor < remaining_principal || position.token_atomics_floor == 0 { return PromiseOrValue::Value(false); }
                    let amount = if self.rhea.expected_return.0 == 0 { position.token_atomics_floor } else { self.rhea.expected_return.0 };
                    if amount > position.token_atomics_floor { return PromiseOrValue::Value(false); }
                    let Ok(call) = rhea_adapter::linked_withdraw_call("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,amount,&asset) else { return PromiseOrValue::Value(false); };
                    let Some(quarantined) = ft.0.checked_sub(event.redeemed_amount.0).and_then(|v| v.checked_add(event.accepted_principal.0)) else { return PromiseOrValue::Value(false); };
                    self.rhea.baseline_ft = U128(quarantined); self.rhea.expected_return = U128(amount);
                    self.rhea.last_internal_balance = U128(position.internal_balance); self.rhea.stage = RheaStage::Dispatched;
                    return PromiseOrValue::Promise(Promise::new(self.config.provider_account.clone()).function_call(call.method,call.args,NearToken::from_yoctonear(call.deposit_yocto),Gas::from_tgas(90)).then(Self::rhea_action_callback(attempt)));
                }
                #[cfg(not(feature = "rhea-linked-withdraw-review"))]
                {
                let Some(after_supply)=self.rhea.baseline_ft.0.checked_sub(event.accepted_principal.0) else { return PromiseOrValue::Value(false); };
                if event.earn_action_completed || position.shares == 0 || position.shares != self.rhea.shares.0 || ft.0 < after_supply || position.token_atomics_floor < event.accepted_principal.0 { return PromiseOrValue::Value(false); }
                let Ok(call)=rhea_adapter::withdraw_all_call("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,&asset) else { return PromiseOrValue::Value(false); };
                let Some(quarantined_baseline) = ft.0.checked_add(event.accepted_principal.0) else { return PromiseOrValue::Value(false); };
                self.rhea.baseline_ft=U128(quarantined_baseline);
                self.rhea.expected_return=U128(position.token_atomics_floor);
                self.rhea.stage=RheaStage::Dispatched;
                self.rhea.last_internal_balance=U128(position.internal_balance);
                return PromiseOrValue::Promise(Promise::new(self.config.provider_account.clone()).function_call(call.method,call.args,NearToken::from_yoctonear(call.deposit_yocto),Gas::from_tgas(80)).then(Self::rhea_action_callback(attempt)));
                }
            }
            if event.earn_state != EarnState::SupplyPending || event.earn_action_completed || self.rhea.paused || position.shares != 0 || ft.0 < event.accepted_principal.0 { return PromiseOrValue::Value(false); }
            let Ok(call) = rhea_adapter::supply_call("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,event.accepted_principal.0,&asset) else { return PromiseOrValue::Value(false); };
            event.earn_baseline_balance=ft; self.rhea.baseline_ft=ft; self.rhea.stage=RheaStage::Dispatched;
            return PromiseOrValue::Promise(Promise::new(self.config.canonical_ft.clone()).function_call(call.method,call.args,NearToken::from_yoctonear(call.deposit_yocto),Gas::from_tgas(60)).then(Self::rhea_action_callback(attempt)));
        }
        if !event.earn_action_completed { return PromiseOrValue::Value(false); }
        #[cfg(not(feature = "rhea-linked-withdraw-review"))]
        { self.rhea.last_internal_balance=U128(position.internal_balance); }
        let Some(after_supply) = self.rhea.baseline_ft.0.checked_sub(event.accepted_principal.0) else { return PromiseOrValue::Value(false); };
        if event.earn_state == EarnState::SupplyPending && self.rhea.stage == RheaStage::TerminalUsed && position.shares > 0 && position.token_atomics_floor >= event.accepted_principal.0 && ft.0 >= after_supply {
            let Some(quarantined_baseline) = ft.0.checked_add(event.accepted_principal.0) else { return PromiseOrValue::Value(false); };
            self.rhea.baseline_ft=U128(quarantined_baseline); self.rhea.shares=U128(position.shares); event.earn_state=EarnState::Supplied; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle; return PromiseOrValue::Value(true);
        }
        if event.earn_state == EarnState::SupplyPending && self.rhea.stage == RheaStage::TerminalRefund && position.shares == 0 && ft.0 >= self.rhea.baseline_ft.0 { event.earn_state=EarnState::NotStarted; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle; return PromiseOrValue::Value(true); }
        #[cfg(feature = "rhea-linked-withdraw-review")]
        if event.earn_state == EarnState::RedeemPending && self.rhea.stage == RheaStage::TerminalRefund && position.shares > 0 && position.internal_balance >= self.rhea.last_internal_balance.0 && after_supply.checked_add(event.redeemed_amount.0).is_some_and(|n| ft.0 >= n) {
            self.rhea.shares=U128(position.shares); self.rhea.last_internal_balance=U128(position.internal_balance);
            event.earn_state=EarnState::Supplied; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle; self.rhea.expected_return=U128(0);
            return PromiseOrValue::Value(true);
        }
        #[cfg(not(feature = "rhea-linked-withdraw-review"))]
        if event.earn_state == EarnState::RedeemPending && self.rhea.stage == RheaStage::TerminalRefund && position.shares == self.rhea.shares.0 && position.shares > 0 && ft.0 >= after_supply {
            event.earn_state=EarnState::Supplied; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle; self.rhea.expected_return=U128(0);
            return PromiseOrValue::Value(true);
        }
        // Fully fund only the pre-dispatch position floor. Any excess is not
        // allocated. This does not prove the origin/finality of the FT transfer.
        #[cfg(feature = "rhea-linked-withdraw-review")]
        if event.earn_state == EarnState::RedeemPending && self.rhea.stage == RheaStage::TerminalUsed && after_supply.checked_add(event.redeemed_amount.0).is_some_and(|n| ft.0 >= n) {
            self.rhea.shares=U128(position.shares); self.rhea.last_internal_balance=U128(position.internal_balance);
            if position.token_atomics_floor > 0 {
                event.earn_state=EarnState::Supplied; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle; self.rhea.expected_return=U128(0);
                return PromiseOrValue::Value(true);
            }
            if event.redeemed_amount.0 >= event.accepted_principal.0 {
                event.realized_yield=U128(event.redeemed_amount.0-event.accepted_principal.0);
                event.earn_state=EarnState::Redeemed; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle; self.rhea.expected_return=U128(0);
                return PromiseOrValue::Value(true);
            }
            return PromiseOrValue::Value(false);
        }
        #[cfg(not(feature = "rhea-linked-withdraw-review"))]
        if event.earn_state == EarnState::RedeemPending && position.shares == 0 && self.rhea.expected_return.0 >= event.accepted_principal.0 {
            if let Some(required) = after_supply.checked_add(self.rhea.expected_return.0) {
                if ft.0 >= required {
                    event.redeemed_amount=self.rhea.expected_return;
                    event.realized_yield=U128(self.rhea.expected_return.0-event.accepted_principal.0);
                    event.earn_state=EarnState::Redeemed; event.earn_action_completed=false; self.rhea.stage=RheaStage::Idle;
                    return PromiseOrValue::Value(true);
                }
            }
        }
        PromiseOrValue::Value(false)
    }

    #[cfg(feature = "mainnet-review")]
    fn rhea_action_callback(attempt: u64) -> Promise {
        Promise::new(env::current_account_id()).function_call("on_rhea_action",near_sdk::serde_json::json!({"attempt":attempt}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(100))
    }
    #[cfg(feature = "mainnet-review")]
    #[private]
    pub fn on_rhea_action(&mut self, attempt: u64) -> PromiseOrValue<bool> {
        let e=self.event.as_mut().expect("event missing");
        if e.earn_attempt != attempt || !matches!(e.earn_state,EarnState::SupplyPending|EarnState::RedeemPending) || e.earn_action_completed || self.rhea.stage != RheaStage::Dispatched || env::promise_results_count() != 1 { return PromiseOrValue::Value(false); }
        let receipt=env::promise_result_checked(0,1024);
        if e.earn_state == EarnState::SupplyPending {
            let used = receipt.ok().and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
            self.rhea.stage = match used { Some(U128(0)) => RheaStage::TerminalRefund, Some(n) if n == e.accepted_principal => RheaStage::TerminalUsed, _ => RheaStage::Ambiguous };
            if self.rhea.stage == RheaStage::Ambiguous { return PromiseOrValue::Value(false); }
        } else {
            #[cfg(feature = "rhea-linked-withdraw-review")]
            {
                match receipt.ok().and_then(|v| near_sdk::serde_json::from_slice::<bool>(&v).ok()) {
                    Some(true) if self.rhea.expected_return.0 > 0 => {
                        let Some(total) = e.redeemed_amount.0.checked_add(self.rhea.expected_return.0) else { self.rhea.stage=RheaStage::Ambiguous; return PromiseOrValue::Value(false); };
                        e.redeemed_amount=U128(total); self.rhea.stage=RheaStage::TerminalUsed;
                    },
                    Some(false) => self.rhea.stage=RheaStage::TerminalRefund,
                    _ => { self.rhea.stage=RheaStage::Ambiguous; return PromiseOrValue::Value(false); }
                }
            }
            // A failed single-action execute receipt rolls back its scheduled
            // promises; a successful execute may still have detached FT work.
            #[cfg(not(feature = "rhea-linked-withdraw-review"))]
            { self.rhea.stage=if matches!(receipt,Err(near_sdk::PromiseError::Failed)) { RheaStage::TerminalRefund } else { RheaStage::TerminalUsed }; }
        }
        e.earn_action_completed=true;
        PromiseOrValue::Promise(self.query_rhea(attempt,false))
    }
    #[cfg(feature = "mainnet-review")]
    fn trigger_rhea_redeem(&mut self) -> Promise {
        #[cfg(feature = "rhea-linked-withdraw-review")]
        {
            let e = self.event.as_ref().expect("event missing");
            require!(env::predecessor_account_id() == self.config.organizer || matches!(e.phase, EscrowPhase::Cancelled | EscrowPhase::RefundOnly), "organizer required");
        }
        let e=self.event.as_mut().expect("event missing");
        require!(e.earn_state == EarnState::Supplied && (e.phase == EscrowPhase::Cancelled || e.phase == EscrowPhase::RefundOnly || (e.phase == EscrowPhase::AttendanceFinalized && env::block_timestamp_ms() >= e.rules.checkin_close)), "redeem gate closed");
        e.earn_attempt=e.earn_attempt.checked_add(1).expect("attempt overflow"); e.earn_state=EarnState::RedeemPending; e.earn_action_completed=false;
        let attempt=e.earn_attempt;
        self.rhea.expected_return=U128(0); self.rhea.stage=RheaStage::Preparing;
        #[cfg(feature = "rhea-linked-withdraw-review")]
        { self.rhea.retry_after_block = env::block_height().saturating_add(20); }
        self.query_rhea(attempt,true)
    }

    /// Organizer chooses an exact partial amount in FT atomics; it remains bounded
    /// by the independently observed supplied position at preflight.
    #[cfg(feature = "rhea-linked-withdraw-review")]
    pub fn trigger_rhea_redeem_partial(&mut self, amount: U128) -> Promise {
        require!(self.config.provider_kind == "RHEA_MAINNET" && env::predecessor_account_id() == self.config.organizer && amount.0 > 0, "partial redemption unavailable");
        let promise = self.trigger_rhea_redeem();
        self.rhea.expected_return = amount;
        promise
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    pub fn retry_rhea_redeem_partial_preflight(&mut self, amount: U128) -> Promise {
        require!(self.config.provider_kind == "RHEA_MAINNET" && env::predecessor_account_id() == self.config.organizer && amount.0 > 0 && self.rhea.stage == RheaStage::Preparing, "partial preflight unavailable");
        let event = self.event.as_mut().expect("event missing");
        require!(event.earn_state == EarnState::RedeemPending && !event.earn_action_completed, "partial preflight unavailable");
        event.earn_attempt = event.earn_attempt.checked_add(1).expect("attempt overflow");
        let attempt = event.earn_attempt; self.rhea.expected_return = amount; self.rhea.retry_after_block = env::block_height().saturating_add(20);
        self.query_rhea(attempt,true)
    }

    /// Only an observed ambiguous terminal result can be investigated. A lost
    /// callback stays Dispatched and cannot use this path. This does not prove
    /// the fate of the uncertain transfer or allocate any uncertain local FT.
    #[cfg(feature = "rhea-linked-withdraw-review")]
    pub fn recover_rhea_ambiguous(&mut self) -> Promise {
        require!(self.config.provider_kind == "RHEA_MAINNET" && self.rhea.stage == RheaStage::Ambiguous, "ambiguous recovery unavailable");
        let event = self.event.as_mut().expect("event missing");
        let refund = matches!(event.phase, EscrowPhase::Cancelled | EscrowPhase::RefundOnly);
        require!(env::predecessor_account_id() == self.config.organizer || (refund && env::block_height() >= self.rhea.retry_after_block), "ambiguous recovery unavailable");
        self.rhea.retry_after_block = env::block_height().saturating_add(20);
        require!(event.earn_state == EarnState::RedeemPending && !event.earn_action_completed, "ambiguous recovery unavailable");
        event.earn_attempt = event.earn_attempt.checked_add(1).expect("attempt overflow");
        let attempt = event.earn_attempt;
        let ft = Promise::new(self.config.canonical_ft.clone()).function_call("ft_balance_of", near_sdk::serde_json::json!({"account_id":env::current_account_id()}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(10));
        let pos = Promise::new(self.config.provider_account.clone()).function_call("get_account", near_sdk::serde_json::json!({"account_id":env::current_account_id()}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(15));
        let asset = Promise::new(self.config.provider_account.clone()).function_call("get_asset", near_sdk::serde_json::json!({"token_id":self.config.canonical_ft}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(15));
        ft.and(pos).and(asset).then(Promise::new(env::current_account_id()).function_call("on_rhea_ambiguous_recovery", near_sdk::serde_json::json!({"attempt":attempt}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(40)))
    }

    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[private]
    pub fn on_rhea_ambiguous_recovery(&mut self, attempt: u64) -> bool {
        let event = self.event.as_mut().expect("event missing");
        if self.rhea.stage != RheaStage::Ambiguous || event.earn_state != EarnState::RedeemPending || event.earn_action_completed || event.earn_attempt != attempt || env::promise_results_count() != 3 { return false; }
        let ft = env::promise_result_checked(0,128).ok().and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
        let pos = env::promise_result_checked(1,65536).ok();
        let asset = env::promise_result_checked(2,65536).ok().and_then(|v| rhea_adapter::decode_asset("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,&v).ok());
        let (Some(ft),Some(pos),Some(asset)) = (ft,pos,asset) else { return false; };
        let Ok(position) = rhea_adapter::decode_position("mainnet",rhea_adapter::PROVIDER,rhea_adapter::USDC,env::current_account_id().as_str(),&pos,&asset) else { return false; };
        let Some(prior_base) = self.rhea.baseline_ft.0.checked_sub(event.accepted_principal.0) else { return false; };
        let Some(required_ft) = prior_base.checked_add(event.redeemed_amount.0) else { return false; };
        if position.shares == 0 || position.internal_balance < self.rhea.last_internal_balance.0 || ft.0 < required_ft { return false; }
        let Some(quarantined) = ft.0.checked_sub(event.redeemed_amount.0).and_then(|v| v.checked_add(event.accepted_principal.0)) else { return false; };
        self.rhea.baseline_ft=U128(quarantined); self.rhea.shares=U128(position.shares); self.rhea.last_internal_balance=U128(position.internal_balance);
        self.rhea.expected_return=U128(0); self.rhea.stage=RheaStage::Idle; event.earn_state=EarnState::Supplied;
        true
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
        registration.attendance_status = if attended { "Attended" } else { "Unmarked" }.into();
        let mut pass = self.passes.get(&registration.pass_id).expect("pass missing");
        pass.attendance_status = registration.attendance_status.clone();
        self.passes.insert(&registration.pass_id, &pass);
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
                && env::block_timestamp_ms() >= event.rules.checkin_close
                && env::block_timestamp_ms() < event.rules.finalize_deadline,
            "finalize gate closed"
        );
        for registration_id in self.registration_ids.to_vec() {
            if let Some(mut registration) = self.registrations.get(&registration_id) {
                if registration.attendance == Attendance::Unmarked {
                    registration.attendance = Attendance::NoShow;
                    registration.attendance_status = "NoShow".into();
                    let mut pass = self.passes.get(&registration.pass_id).expect("pass missing");
                    pass.attendance_status = "NoShow".into();
                    self.passes.insert(&registration.pass_id, &pass);
                }
                registration.claim = ClaimState::Claimable;
                self.registrations.insert(&registration_id, &registration);
            }
        }
        self.event.as_mut().expect("event missing").phase = EscrowPhase::AttendanceFinalized;
    }

    pub fn trigger_earn_redeem(&mut self) -> Promise {
        #[cfg(feature = "mainnet-review")]
        if self.config.provider_kind == "RHEA_MAINNET" { return self.trigger_rhea_redeem(); }
        let event = self.event.as_mut().expect("event missing");
        require!(event.earn_state == EarnState::Supplied && (event.phase == EscrowPhase::Cancelled || event.phase == EscrowPhase::RefundOnly || (event.phase == EscrowPhase::AttendanceFinalized && env::block_timestamp_ms() >= event.rules.checkin_close)), "redeem gate closed");
        event.earn_attempt = event.earn_attempt.checked_add(1).expect("earn attempt overflow");
        event.earn_state = EarnState::RedeemPending;
        event.earn_action_completed = false;
        let attempt = event.earn_attempt;
        Promise::new(self.config.provider_account.clone()).function_call("withdraw", near_sdk::serde_json::json!({"amount": event.accepted_principal.0.to_string()}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(80)).then(Self::earn_action_callback(attempt))
    }

    pub fn cancel_event(&mut self, event_id: String) {
        require!(env::predecessor_account_id() == self.config.organizer, "organizer required");
        let e = self.event.as_mut().expect("event missing");
        require!(e.rules.event_id == event_id && matches!(e.phase, EscrowPhase::RegistrationOpen | EscrowPhase::RegistrationClosed | EscrowPhase::AttendanceFinalized), "cancel gate closed");
        e.phase = EscrowPhase::Cancelled;
        log_event("EventCancelled", near_sdk::serde_json::json!({"event_id":event_id}));
    }

    pub fn activate_timeout_refund(&mut self, event_id: String) {
        let e = self.event.as_mut().expect("event missing");
        require!(e.rules.event_id == event_id && matches!(e.phase, EscrowPhase::RegistrationOpen | EscrowPhase::RegistrationClosed) && env::block_timestamp_ms() >= e.rules.finalize_deadline, "timeout gate closed");
        e.phase = EscrowPhase::RefundOnly;
        log_event("RefundModeActivated", near_sdk::serde_json::json!({"event_id":event_id}));
    }

    pub fn get_storage_state(&self) -> near_sdk::serde_json::Value {
        let bytes = env::storage_usage();
        near_sdk::serde_json::json!({"storage_bytes": bytes, "storage_cost_yocto": ((bytes as u128) * env::storage_byte_cost().as_yoctonear()).to_string(), "account_balance_yocto": env::account_balance().as_yoctonear().to_string(), "payer": "contract"})
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
                    no_show = no_show.checked_add(deposit).expect("no-show pool overflow");
                }
            }
        }
        require!(count > 0, "no registrations to settle");
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
            let pool = no_show.checked_add(realized_yield).expect("settlement pool overflow");
            let base = pool / attendees.len() as u128;
            let rem = pool % attendees.len() as u128;
            for (ordinal, registration_id) in attendees.iter().enumerate() {
                let mut registration = self
                    .registrations
                    .get(registration_id)
                    .expect("registration missing");
                registration.claim_amount = U128(
                    deposit
                        + base
                        + if (ordinal as u128) < rem {
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
        let refund = matches!(event.phase, EscrowPhase::Cancelled | EscrowPhase::RefundOnly);
        require!((event.phase == EscrowPhase::Settled && event.earn_state == EarnState::Redeemed) || (refund && matches!(event.earn_state, EarnState::NotStarted | EarnState::Redeemed)), "claim gate closed");
        let mut registration = self
            .registrations
            .get(&registration_id)
            .expect("registration missing");
        if refund && matches!(registration.claim, ClaimState::None | ClaimState::Claimable) { registration.claim = ClaimState::Claimable; registration.claim_amount = registration.amount; }
        require!(
            registration.beneficiary == env::predecessor_account_id()
                && registration.claim == ClaimState::Claimable
                && registration.claim_amount.0 > 0,
            "claim not authorized"
        );
        registration.claim_attempt = registration.claim_attempt.checked_add(1).expect("claim attempt overflow");
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


}

fn log_event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{{\"standard\":\"showstake\",\"version\":\"1.0.0\",\"event\":\"{name}\",\"data\":{data}}}"));
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
            title: "Test".into(),
            location: "Local".into(),
            rules_text: "Test rules".into(),
            finalize_deadline: 40,
            deposit: U128(10),
            capacity: 10,
            reg_open: 10,
            reg_close: 20,
            checkin_open: 20,
            checkin_close: 30,
        }
    }

    #[test]
    fn nonconsecutive_attendees_receive_deterministic_remainder() {
        context("host.testnet", 0);
        let mut c = EventEscrowContract::new(account("host.testnet"), account("mock-earn.testnet"), account("mock.usdc.testnet"), "USDC".into(), "Mock USDC".into(), 6, "MOCK_TESTNET".into());
        let mut r = rules(); r.deposit = U128(2); c.publish_event(r);
        context("mock.usdc.testnet", 10);
        for i in 0..5 {
            let msg = format!(r#"{{"version":1,"event_id":"e","commitment_id":"c{}"}}"#, i);
            assert!(matches!(c.ft_on_transfer(account(&format!("user{}.testnet", i)), U128(2), msg), PromiseOrValue::Value(U128(0))));
        }
        for i in [1, 3] {
            let id = format!("e-reg-{}", i);
            let mut registration = c.registrations.get(&id).unwrap();
            registration.attendance = Attendance::Attended;
            c.registrations.insert(&id, &registration);
        }
        let e = c.event.as_mut().unwrap(); e.phase = EscrowPhase::AttendanceFinalized; e.earn_state = EarnState::Redeemed; e.realized_yield = U128(1);
        c.settle();
        assert_eq!(c.get_registration("e-reg-1".into()).unwrap().claim_amount, U128(6));
        assert_eq!(c.get_registration("e-reg-3".into()).unwrap().claim_amount, U128(5));
        assert_eq!(c.get_registration("e-reg-0".into()).unwrap().claim_amount, U128(0));
    }

    fn promise_context(results: Vec<near_sdk::PromiseResult>) {
        let context = VMContextBuilder::new().current_account_id(account("event.testnet")).predecessor_account_id(account("event.testnet")).block_timestamp(30_000_000).build();
        testing_env!(context, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), results);
    }
    fn result(n: u128) -> near_sdk::PromiseResult {
        near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&U128(n)).unwrap())
    }
    fn earned_candidate() -> EventEscrowContract {
        context("host.testnet", 0);
        let mut c = EventEscrowContract::new(account("host.testnet"), account("mock-earn.testnet"), account("mock.usdc.testnet"), "USDC".into(), "Mock USDC".into(), 6, "MOCK_TESTNET".into());
        c.publish_event(rules());
        let e = c.event.as_mut().unwrap(); e.accepted_principal = U128(10); e.phase = EscrowPhase::RegistrationClosed;
        c
    }
    #[cfg(feature = "mainnet-review")]
    fn mainnet_candidate() -> EventEscrowContract {
        testing_env!(VMContextBuilder::new().current_account_id(account("escrow.near")).predecessor_account_id(account("host.near")).build());
        EventEscrowContract::new(account("host.near"), account(rhea_adapter::PROVIDER), account(rhea_adapter::USDC), "USDC".into(), "USDC".into(), 6, "RHEA_MAINNET".into())
    }
    #[cfg(feature = "mainnet-review")]
    #[test]
    fn mainnet_initializes_paused_with_zero_cap_and_fixed_identity() {
        let mut c=mainnet_candidate();
        assert!(c.get_rhea_control().paused);
        assert_eq!(c.get_rhea_control().principal_cap,U128(0));
        assert_eq!(c.get_config().network,"mainnet");
        assert_eq!(c.get_config().canonical_ft.as_str(),rhea_adapter::USDC);
        c.configure_rhea_cap(U128(100));c.set_rhea_paused(false);
        let mut r=rules();r.finalize_deadline=r.checkin_close+86_400_000;
        c.create_event(r);
        assert!(c.event.is_some());
    }
    #[cfg(feature = "mainnet-review")]
    #[test]
    #[should_panic(expected="mainnet requires 24h finalization deadline")]
    fn mainnet_rejects_arbitrary_finalization_deadline() {
        let mut c=mainnet_candidate();c.configure_rhea_cap(U128(100));c.set_rhea_paused(false);
        c.create_event(rules());
    }
    #[cfg(feature = "mainnet-review")]
    #[test]
    #[cfg(not(feature = "rhea-linked-withdraw-review"))]
    fn failed_rhea_execute_can_retry_but_success_with_detached_work_cannot() {
        for failed in [true,false] {
            let mut c=earned_candidate();c.config.provider_kind="RHEA_MAINNET".into();c.config.provider_account=account(rhea_adapter::PROVIDER);c.config.canonical_ft=account(rhea_adapter::USDC);
            c.rhea.baseline_ft=U128(10);c.rhea.shares=U128(5);c.rhea.expected_return=U128(12);c.rhea.stage=RheaStage::Dispatched;
            {let e=c.event.as_mut().unwrap();e.phase=EscrowPhase::AttendanceFinalized;e.earn_state=EarnState::RedeemPending;e.earn_attempt=3;}
            promise_context(vec![if failed{near_sdk::PromiseResult::Failed}else{near_sdk::PromiseResult::Successful(b"null".to_vec())}]);
            drop(c.on_rhea_action(3));
            let position=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":[{"token_id":rhea_adapter::USDC,"shares":"5","balance":"12000000000000"}],"borrowed":[],"collateral":[]});
            let asset=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
            promise_context(vec![result(0),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&position).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&asset).unwrap())]);
            drop(c.on_rhea_reconcile(3,false));
            assert_eq!(c.event.as_ref().unwrap().earn_state,if failed{EarnState::Supplied}else{EarnState::RedeemPending});
            assert_eq!(c.rhea.shares,U128(5));
        }
    }
    #[cfg(feature = "mainnet-review")]
    #[test]
    #[cfg(not(feature = "rhea-linked-withdraw-review"))]
    fn rhea_zero_position_and_unchanged_position_never_complete_redeem() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into();
        c.config.provider_account=account(rhea_adapter::PROVIDER); c.config.canonical_ft=account(rhea_adapter::USDC);
        c.rhea.baseline_ft=U128(10); c.rhea.stage=RheaStage::TerminalUsed;
        { let e=c.event.as_mut().unwrap(); e.earn_state=EarnState::RedeemPending; e.earn_attempt=3; e.earn_action_completed=true; }
        let asset=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        for (balance,shares,internal) in [(10,0,0),(0,5,10_000_000_000_000u128)] {
            let account_json=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":if shares==0 {vec![]} else {vec![near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"shares":shares.to_string(),"balance":internal.to_string()})]},"borrowed":[],"collateral":[]});
            promise_context(vec![result(balance),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&account_json).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&asset).unwrap())]);
            drop(c.on_rhea_reconcile(3,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::RedeemPending);
        }
    }

    #[cfg(feature = "mainnet-review")]
    #[test]
    fn rhea_preflight_retry_invalidates_stale_and_refund_requires_terminal_proof() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.config.provider_account=account(rhea_adapter::PROVIDER); c.config.canonical_ft=account(rhea_adapter::USDC); c.rhea.paused=false;
        #[cfg(feature = "rhea-linked-withdraw-review")]
        context("caller.testnet",20);
        drop(c.trigger_earn_supply());
        promise_context(vec![near_sdk::PromiseResult::Failed,near_sdk::PromiseResult::Failed,near_sdk::PromiseResult::Failed]);
        drop(c.on_rhea_reconcile(1,true)); assert_eq!(c.rhea.stage,RheaStage::Preparing);
        context("host.testnet",30); drop(c.reconcile_earn()); assert_eq!(c.event.as_ref().unwrap().earn_attempt,2);
        let asset=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        let empty=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":[],"borrowed":[],"collateral":[]});
        let results=|| vec![result(10),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&empty).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&asset).unwrap())];
        promise_context(results()); drop(c.on_rhea_reconcile(1,true)); assert_eq!(c.rhea.stage,RheaStage::Preparing);
        promise_context(results()); drop(c.on_rhea_reconcile(2,true)); assert_eq!(c.rhea.stage,RheaStage::Dispatched);
        promise_context(results()); drop(c.on_rhea_reconcile(2,true)); assert_eq!(c.rhea.stage,RheaStage::Dispatched);
        promise_context(vec![result(0)]); drop(c.on_rhea_action(2)); assert_eq!(c.rhea.stage,RheaStage::TerminalRefund);
        promise_context(results()); drop(c.on_rhea_reconcile(2,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::NotStarted);
    }

    #[cfg(feature = "mainnet-review")]
    #[test]
    fn rhea_unauthorized_preflight_retry_cannot_invalidate_attempt() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.rhea.paused=false;
        context("attacker.testnet",30); drop(c.trigger_earn_supply());
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.reconcile_earn())));
        assert!(rejected.is_err()); assert_eq!(c.event.as_ref().unwrap().earn_attempt,1); assert_eq!(c.rhea.stage,RheaStage::Preparing);
    }

    #[cfg(feature = "mainnet-review")]
    #[test]
    #[cfg(not(feature = "rhea-linked-withdraw-review"))]
    fn rhea_donations_are_quarantined_before_redemption() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.config.provider_account=account(rhea_adapter::PROVIDER); c.config.canonical_ft=account(rhea_adapter::USDC);
        c.rhea.baseline_ft=U128(10); c.rhea.stage=RheaStage::TerminalUsed;
        {let e=c.event.as_mut().unwrap(); e.earn_state=EarnState::SupplyPending; e.earn_attempt=1; e.earn_action_completed=true;}
        let asset=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        let position=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":[{"token_id":rhea_adapter::USDC,"shares":"5","balance":"12000000000000"}],"borrowed":[],"collateral":[]});
        let rows=|ft| vec![result(ft),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&position).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&asset).unwrap())];
        promise_context(rows(3)); drop(c.on_rhea_reconcile(1,false));
        assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Supplied); assert_eq!(c.rhea.baseline_ft,U128(13)); assert_eq!(c.event.as_ref().unwrap().accepted_principal,U128(10));
        { let e=c.event.as_mut().unwrap(); e.phase=EscrowPhase::AttendanceFinalized; }
        context("caller.testnet",30); drop(c.trigger_earn_redeem());
        promise_context(rows(7)); drop(c.on_rhea_reconcile(2,true));
        assert_eq!(c.rhea.expected_return,U128(12)); assert_eq!(c.rhea.baseline_ft,U128(17));
        assert_eq!(c.event.as_ref().unwrap().realized_yield,U128(0));
        promise_context(vec![near_sdk::PromiseResult::Successful(b"null".to_vec())]); drop(c.on_rhea_action(2));
        let empty=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":[],"borrowed":[],"collateral":[]});
        let final_rows=|ft| vec![result(ft),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&empty).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&asset).unwrap())];
        promise_context(final_rows(18)); drop(c.on_rhea_reconcile(2,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::RedeemPending);
        promise_context(final_rows(19)); drop(c.on_rhea_reconcile(2,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Redeemed); assert_eq!(c.event.as_ref().unwrap().realized_yield,U128(2));
    }

    #[cfg(feature = "mainnet-review")]
    #[test]
    fn rhea_malformed_action_result_never_retries_and_short_position_never_supplies() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.config.provider_account=account(rhea_adapter::PROVIDER); c.config.canonical_ft=account(rhea_adapter::USDC);
        {let e=c.event.as_mut().unwrap(); e.earn_state=EarnState::SupplyPending; e.earn_attempt=1;}
        c.rhea.stage=RheaStage::Dispatched;
        promise_context(vec![near_sdk::PromiseResult::Successful(b"invalid".to_vec())]); drop(c.on_rhea_action(1)); assert_eq!(c.rhea.stage,RheaStage::Ambiguous);
        c.rhea.stage=RheaStage::TerminalUsed; c.rhea.baseline_ft=U128(10); c.event.as_mut().unwrap().earn_action_completed=true;
        let asset=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        let short=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":[{"token_id":rhea_adapter::USDC,"shares":"1","balance":"9999999999999"}],"borrowed":[],"collateral":[]});
        promise_context(vec![result(0),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&short).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&asset).unwrap())]); drop(c.on_rhea_reconcile(1,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::SupplyPending);
    }

    #[cfg(feature = "mainnet-review")]
    #[test]
    #[cfg(not(feature = "rhea-linked-withdraw-review"))]
    fn rhea_funded_zero_shares_allocates_only_frozen_floor() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.config.provider_account=account(rhea_adapter::PROVIDER); c.config.canonical_ft=account(rhea_adapter::USDC);
        c.rhea.baseline_ft=U128(10); c.rhea.expected_return=U128(12); c.rhea.stage=RheaStage::TerminalUsed;
        { let e=c.event.as_mut().unwrap(); e.earn_state=EarnState::RedeemPending; e.earn_attempt=3; e.earn_action_completed=true; }
        let a=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        let p=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":[],"borrowed":[],"collateral":[]});
        for (ft,done) in [(11,false),(13,true)] {
            promise_context(vec![result(ft),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&p).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&a).unwrap())]);
            drop(c.on_rhea_reconcile(3,false)); assert_eq!(c.event.as_ref().unwrap().earn_state==EarnState::Redeemed,done);
        }
        assert_eq!(c.event.as_ref().unwrap().redeemed_amount,U128(12)); assert_eq!(c.event.as_ref().unwrap().realized_yield,U128(2));
    }

    #[cfg(feature = "rhea-linked-withdraw-review")]
    fn linked_pending() -> EventEscrowContract {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into();
        c.config.provider_account=account(rhea_adapter::PROVIDER); c.config.canonical_ft=account(rhea_adapter::USDC);
        c.rhea.baseline_ft=U128(10); c.rhea.expected_return=U128(10); c.rhea.last_internal_balance=U128(10_000_000_000_000); c.rhea.shares=U128(5); c.rhea.stage=RheaStage::Dispatched;
        let e=c.event.as_mut().unwrap(); e.phase=EscrowPhase::AttendanceFinalized; e.earn_state=EarnState::RedeemPending; e.earn_attempt=3;
        c
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_supply_waits_until_event_start_without_mutation() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.rhea.paused=false;
        context("caller.testnet",19);
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.trigger_earn_supply())));
        assert!(rejected.is_err());
        let e=c.event.as_ref().unwrap(); assert_eq!(e.earn_state,EarnState::NotStarted); assert_eq!(e.earn_attempt,0); assert!(!e.earn_action_completed); assert_eq!(c.rhea.stage,RheaStage::Idle);
        context("caller.testnet",20); drop(c.trigger_earn_supply());
        let e=c.event.as_ref().unwrap(); assert_eq!(e.earn_state,EarnState::SupplyPending); assert_eq!(e.earn_attempt,1); assert_eq!(c.rhea.stage,RheaStage::Preparing);
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    fn linked_context(who: &str, time: u64, height: u64) {
        testing_env!(VMContextBuilder::new().current_account_id(account("event.testnet"))
            .predecessor_account_id(account(who)).block_timestamp(time * 1_000_000)
            .block_height(height).build());
    }

    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_supply_expiry_and_async_phase_change_do_not_dispatch() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.rhea.paused=false;
        linked_context("caller.testnet",40,1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.trigger_earn_supply()))).is_err());
        for phase in [EscrowPhase::RefundOnly, EscrowPhase::Cancelled, EscrowPhase::RegistrationClosed] {
            c.event.as_mut().unwrap().phase=EscrowPhase::RegistrationClosed;
            linked_context("caller.testnet",20,1); drop(c.trigger_earn_supply());
            c.event.as_mut().unwrap().phase=phase;
            let now=if phase==EscrowPhase::RegistrationClosed {40} else {20};
            let ctx=VMContextBuilder::new().current_account_id(account("event.testnet"))
                .predecessor_account_id(account("event.testnet")).block_timestamp(now*1_000_000).build();
            testing_env!(ctx, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), linked_rows(10,0,0));
            let attempt=c.event.as_ref().unwrap().earn_attempt;
            drop(c.on_rhea_reconcile(attempt,true));
            assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::NotStarted);
            assert_eq!(c.rhea.stage,RheaStage::Idle);
            assert!(near_sdk::test_utils::get_created_receipts().is_empty());
        }
    }

    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_lost_supply_preflight_can_be_reset_after_timeout() {
        let mut c=earned_candidate(); c.config.provider_kind="RHEA_MAINNET".into(); c.rhea.paused=false;
        linked_context("caller.testnet",20,100); drop(c.trigger_earn_supply());
        linked_context("caller.testnet",40,119); c.activate_timeout_refund("e".into());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.reconcile_earn()))).is_err());
        linked_context("caller.testnet",40,120); drop(c.reconcile_earn());
        let attempt=c.event.as_ref().unwrap().earn_attempt;
        let ctx=VMContextBuilder::new().current_account_id(account("event.testnet"))
            .predecessor_account_id(account("event.testnet")).block_timestamp(40_000_000).build();
        testing_env!(ctx, near_sdk::test_vm_config(), near_sdk::RuntimeFeesConfig::test(), Default::default(), linked_rows(10,0,0));
        drop(c.on_rhea_reconcile(attempt,true));
        assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::NotStarted);
        assert_eq!(c.rhea.stage,RheaStage::Idle);
        assert!(near_sdk::test_utils::get_created_receipts().is_empty());
    }

    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_refund_permissionless_full_retry_and_ambiguous_cooldown() {
        for phase in [EscrowPhase::RefundOnly, EscrowPhase::Cancelled] {
            let mut c=linked_pending(); c.rhea.stage=RheaStage::Idle;
            {let e=c.event.as_mut().unwrap(); e.phase=phase; e.earn_state=EarnState::Supplied;}
            linked_context("outsider.testnet",40,100); drop(c.trigger_earn_redeem());
            assert_eq!(c.get_rhea_control().retry_after_block,120);
            linked_context("outsider.testnet",40,119);
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.reconcile_earn()))).is_err());
            linked_context("outsider.testnet",40,120); drop(c.reconcile_earn());
            let attempt=c.event.as_ref().unwrap().earn_attempt;
            assert_eq!(c.rhea.retry_after_block,140);
            promise_context(linked_rows(0,5,10_000_000_000_000)); drop(c.on_rhea_reconcile(attempt-1,true));
            assert_eq!(c.rhea.stage,RheaStage::Preparing);
            promise_context(linked_rows(0,5,10_000_000_000_000)); drop(c.on_rhea_reconcile(attempt,true));
            assert_eq!(c.rhea.stage,RheaStage::Dispatched);
            promise_context(vec![near_sdk::PromiseResult::Failed]); drop(c.on_rhea_action(attempt));
            linked_context("outsider.testnet",40,139);
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.recover_rhea_ambiguous()))).is_err());
            linked_context("outsider.testnet",40,140); drop(c.recover_rhea_ambiguous());
            linked_context("outsider.testnet",40,140);
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.recover_rhea_ambiguous()))).is_err());
            let recovery=c.event.as_ref().unwrap().earn_attempt;
            promise_context(linked_rows(0,5,10_000_000_000_000)); assert!(c.on_rhea_ambiguous_recovery(recovery));
            assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Supplied);
        }
    }

    #[cfg(feature = "rhea-linked-withdraw-review")]
    fn linked_rows(ft: u128, shares: u128, internal: u128) -> Vec<near_sdk::PromiseResult> {
        let p=near_sdk::serde_json::json!({"account_id":"event.testnet","supplied":if shares==0 { vec![] } else { vec![near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"shares":shares.to_string(),"balance":internal.to_string()})] },"borrowed":[],"collateral":[]});
        let a=near_sdk::serde_json::json!({"token_id":rhea_adapter::USDC,"config":{"extra_decimals":12,"can_deposit":true,"can_withdraw":true,"can_use_as_collateral":true,"can_borrow":true}});
        vec![result(ft),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&p).unwrap()),near_sdk::PromiseResult::Successful(near_sdk::serde_json::to_vec(&a).unwrap())]
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_false_requires_restored_value_not_original_shares() {
        let mut c=linked_pending(); promise_context(vec![near_sdk::PromiseResult::Successful(b"false".to_vec())]); drop(c.on_rhea_action(3));
        promise_context(linked_rows(0,7,9_999_999_999_999)); drop(c.on_rhea_reconcile(3,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::RedeemPending);
        promise_context(linked_rows(0,7,10_000_000_000_000)); drop(c.on_rhea_reconcile(3,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Supplied); assert_eq!(c.rhea.shares,U128(7));
        assert_eq!(c.event.as_ref().unwrap().redeemed_amount,U128(0));
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_failed_or_malformed_receipt_and_donations_cannot_complete() {
        for receipt in [near_sdk::PromiseResult::Failed,near_sdk::PromiseResult::Successful(b"null".to_vec()),near_sdk::PromiseResult::Successful(b"\"true\"".to_vec())] {
            let mut c=linked_pending(); promise_context(vec![receipt]); drop(c.on_rhea_action(3)); assert_eq!(c.rhea.stage,RheaStage::Ambiguous);
            promise_context(linked_rows(100,0,0)); drop(c.on_rhea_reconcile(3,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::RedeemPending); assert_eq!(c.event.as_ref().unwrap().redeemed_amount,U128(0));
        }
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_repeated_returns_conserve_value_and_exclude_dust_and_donations() {
        let mut c=linked_pending();
        promise_context(vec![near_sdk::PromiseResult::Successful(b"true".to_vec())]); drop(c.on_rhea_action(3));
        promise_context(vec![near_sdk::PromiseResult::Successful(b"true".to_vec())]); drop(c.on_rhea_action(3)); assert_eq!(c.event.as_ref().unwrap().redeemed_amount,U128(10));
        promise_context(linked_rows(11,2,2_000_000_000_001)); drop(c.on_rhea_reconcile(3,false)); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Supplied);
        context("host.testnet",30); drop(c.trigger_earn_redeem());
        promise_context(linked_rows(11,2,2_000_000_000_001)); drop(c.on_rhea_reconcile(4,true)); assert_eq!(c.rhea.expected_return,U128(2));
        promise_context(vec![near_sdk::PromiseResult::Successful(b"true".to_vec())]); drop(c.on_rhea_action(4));
        promise_context(linked_rows(14,1,1)); drop(c.on_rhea_reconcile(4,false));
        let e=c.event.as_ref().unwrap(); assert_eq!(e.earn_state,EarnState::Redeemed); assert_eq!(e.redeemed_amount,U128(12)); assert_eq!(e.realized_yield,U128(2)); assert_eq!(c.rhea.last_internal_balance,U128(1));
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_partial_preflight_is_bounded_and_stale_reads_cannot_dispatch() {
        let mut c=linked_pending(); c.rhea.stage=RheaStage::Idle; c.rhea.expected_return=U128(0);
        { let e=c.event.as_mut().unwrap(); e.earn_state=EarnState::Supplied; }
        context("host.testnet",30); drop(c.trigger_rhea_redeem_partial(U128(20)));
        promise_context(linked_rows(0,5,10_000_000_000_000)); drop(c.on_rhea_reconcile(4,true)); assert_eq!(c.rhea.stage,RheaStage::Preparing);
        context("host.testnet",30); drop(c.retry_rhea_redeem_partial_preflight(U128(4)));
        promise_context(linked_rows(0,5,10_000_000_000_000)); drop(c.on_rhea_reconcile(4,true)); assert_eq!(c.rhea.stage,RheaStage::Preparing);
        promise_context(linked_rows(0,5,10_000_000_000_000)); drop(c.on_rhea_reconcile(5,true)); assert_eq!(c.rhea.stage,RheaStage::Dispatched); assert_eq!(c.rhea.expected_return,U128(4));
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_full_redeem_requires_organizer() {
        let mut c=linked_pending(); c.rhea.stage=RheaStage::Idle; c.event.as_mut().unwrap().earn_state=EarnState::Supplied;
        context("outsider.testnet",30);
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.trigger_earn_redeem())));
        assert!(rejected.is_err()); assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Supplied); assert_eq!(c.rhea.stage,RheaStage::Idle);
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_ambiguous_recovery_quarantines_cash_and_accepts_restored_value_with_new_shares() {
        let mut c=linked_pending(); promise_context(vec![near_sdk::PromiseResult::Failed]); drop(c.on_rhea_action(3));
        assert_eq!(c.rhea.stage,RheaStage::Ambiguous);
        context("host.testnet",30); drop(c.recover_rhea_ambiguous());
        promise_context(linked_rows(11,7,9_999_999_999_999)); assert!(!c.on_rhea_ambiguous_recovery(4)); assert_eq!(c.rhea.stage,RheaStage::Ambiguous);
        context("host.testnet",30); drop(c.recover_rhea_ambiguous());
        promise_context(linked_rows(11,7,10_000_000_000_000)); assert!(!c.on_rhea_ambiguous_recovery(4)); assert!(c.on_rhea_ambiguous_recovery(5));
        assert_eq!(c.event.as_ref().unwrap().earn_state,EarnState::Supplied); assert_eq!(c.event.as_ref().unwrap().redeemed_amount,U128(0)); assert_eq!(c.rhea.baseline_ft,U128(21)); assert_eq!(c.rhea.shares,U128(7));
        context("host.testnet",30); drop(c.trigger_rhea_redeem_partial(U128(4)));
        promise_context(linked_rows(11,7,10_000_000_000_000)); drop(c.on_rhea_reconcile(6,true)); assert_eq!(c.rhea.expected_return,U128(4)); assert_eq!(c.rhea.baseline_ft,U128(21));
    }
    #[cfg(feature = "rhea-linked-withdraw-review")]
    #[test]
    fn linked_missing_callback_cannot_enter_recovery() {
        let mut c=linked_pending(); context("host.testnet",30);
        let rejected=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(c.recover_rhea_ambiguous())));
        assert!(rejected.is_err()); assert_eq!(c.rhea.stage,RheaStage::Dispatched); assert_eq!(c.event.as_ref().unwrap().earn_attempt,3);
    }

    #[test]
    fn mock_supply_and_redeem_require_receipt_and_reconciled_balances() {
        let mut c = earned_candidate();
        drop(c.trigger_earn_supply());
        promise_context(vec![result(10), result(0)]);
        drop(c.on_earn_reconcile(1, true));
        assert_eq!(c.event.as_ref().unwrap().earn_state, EarnState::SupplyPending);
        promise_context(vec![near_sdk::PromiseResult::Successful(b"\"10\"".to_vec())]);
        drop(c.on_earn_action(1));
        promise_context(vec![result(0), result(10)]);
        drop(c.on_earn_reconcile(1, false));
        assert_eq!(c.event.as_ref().unwrap().earn_state, EarnState::Supplied);
        c.event.as_mut().unwrap().phase = EscrowPhase::AttendanceFinalized;
        context("caller.testnet", 30);
        drop(c.trigger_earn_redeem());
        promise_context(vec![near_sdk::PromiseResult::Successful(b"null".to_vec())]);
        drop(c.on_earn_action(2));
        promise_context(vec![result(10), result(0)]);
        drop(c.on_earn_reconcile(2, false));
        assert_eq!(c.event.as_ref().unwrap().earn_state, EarnState::Redeemed);
        assert_eq!(c.event.as_ref().unwrap().redeemed_amount, U128(10));
    }
    #[test]
    fn failed_and_ambiguous_actions_do_not_duplicate_transfers() {
        let mut c = earned_candidate();
        drop(c.trigger_earn_supply());
        promise_context(vec![result(10), result(0)]);
        drop(c.on_earn_reconcile(1, true));
        promise_context(vec![near_sdk::PromiseResult::Failed]);
        drop(c.on_earn_action(1));
        promise_context(vec![near_sdk::PromiseResult::Failed, result(0)]);
        drop(c.on_earn_reconcile(1, false));
        assert_eq!(c.event.as_ref().unwrap().earn_state, EarnState::SupplyPending);
        assert!(c.event.as_ref().unwrap().earn_action_completed);
        context("caller.testnet", 30);
        drop(c.reconcile_earn());
        promise_context(vec![result(10), result(0)]);
        drop(c.on_earn_reconcile(1, false));
        assert_eq!(c.event.as_ref().unwrap().earn_state, EarnState::NotStarted);
        drop(c.trigger_earn_supply());
        assert_eq!(c.event.as_ref().unwrap().earn_attempt, 2);
    }

    #[test]
    fn failed_redemption_reconciles_before_retry() {
        let mut c = earned_candidate();
        let e = c.event.as_mut().unwrap(); e.earn_state = EarnState::Supplied; e.earn_baseline_balance = U128(10); e.phase = EscrowPhase::AttendanceFinalized;
        context("caller.testnet", 30); drop(c.trigger_earn_redeem());
        promise_context(vec![near_sdk::PromiseResult::Failed]); drop(c.on_earn_action(1));
        promise_context(vec![result(0), result(10)]); drop(c.on_earn_reconcile(1, false));
        assert_eq!(c.event.as_ref().unwrap().earn_state, EarnState::Supplied);
        context("caller.testnet", 30); drop(c.trigger_earn_redeem());
        assert_eq!(c.event.as_ref().unwrap().earn_attempt, 2);
    }
    #[test]
    fn five_two_atomic_and_two_nonconsecutive_attendees_pay_five_each() {
        context("host.testnet", 0);
        let mut c = EventEscrowContract::new(account("host.testnet"), account("mock-earn.testnet"), account("mock.usdc.testnet"), "USDC".into(), "Mock USDC".into(), 6, "MOCK_TESTNET".into());
        let mut r = rules(); r.deposit = U128(2); c.publish_event(r);
        context("mock.usdc.testnet", 10);
        for i in 0..5 { let msg = format!(r#"{{"version":1,"event_id":"e","commitment_id":"c{}"}}"#, i); drop(c.ft_on_transfer(account(&format!("u{}.testnet",i)), U128(2), msg)); }
        for i in [1,3] { let id=format!("e-reg-{}",i); let mut r=c.registrations.get(&id).unwrap(); r.attendance=Attendance::Attended; c.registrations.insert(&id,&r); }
        let e=c.event.as_mut().unwrap(); e.phase=EscrowPhase::AttendanceFinalized; e.earn_state=EarnState::Redeemed;
        c.settle();
        assert_eq!(c.get_registration("e-reg-1".into()).unwrap().claim_amount,U128(5));
        assert_eq!(c.get_registration("e-reg-3".into()).unwrap().claim_amount,U128(5));
    }

}
