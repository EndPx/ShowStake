// SPDX-License-Identifier: MIT
//! ShowStake v2 product contract — local vertical slice.
//!
//! Scope of this file (deliberately narrow):
//!   * one immutable canonical NEP-141 FT account per deployment,
//!   * immutable event rules published by the authenticated predecessor,
//!   * native NEAR prepaid storage credit measured against real storage usage,
//!     including the measured footprint of a new credit entry itself,
//!   * `ft_on_transfer` acceptance that atomically creates one registration and
//!     one account-bound pass in the same receipt, or returns the full unused
//!     amount and creates no state,
//!   * bounded views, and explicit rejection of transfer/approval/reassignment.
//!
//! Out of scope here (next assignment): withdrawal, cancellation, settlement,
//! claims, attendance. The state retained below is only what those stages need.
//!
//! This is NOT a NEP-171 or NEP-393 implementation. The pass is a custom,
//! account-bound event credential; every transfer/approval/burn/admin-reassign
//! entrypoint that is exposed panics with `PASS_NOT_TRANSFERABLE`.
//!
//! Provenance: original code written for ShowStake v2 against near-sdk 5.30.1.
//! CommitPass Solidity was read only as a behavioral reference (see
//! docs/commitpass-contract-adaptation.md); no Solidity is copied.

use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PanicOnDefault, PromiseOrValue};
use serde::Deserialize;

/// The only event state implemented in this slice. Later lifecycle stages add
/// variants; no financial lifecycle is executed here yet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventState {
    Published,
}

/// Registration lifecycle in this slice: accepted registrations are Active.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistrationStatus {
    Active,
    Withdrawn,
}

/// Attendance is not implemented in this slice; every pass starts NotMarked.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttendanceStatus {
    NotMarked,
}

/// Financial lifecycle in this slice: the accepted principal is committed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinancialStatus {
    Committed,
}

/// Derived from immutable times and block time; never stored.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventPhase {
    Scheduled,
    RegistrationOpen,
    RegistrationClosed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Config {
    /// Immutable authority allowed to publish the single event instance.
    pub organizer: AccountId,
    pub canonical_ft: AccountId,
    pub network: String,
    pub policy_version: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Event {
    pub event_id: String,
    pub organizer: AccountId,
    pub rules_hash: String,
    pub deposit: U128,
    pub capacity: u32,
    pub reg_open: u64,
    pub reg_close: u64,
    pub cancel_cutoff: u64,
    pub checkin_open: u64,
    pub checkin_close: u64,
    pub finalize_deadline: u64,
    pub policy_version: String,
    pub state: EventState,
    pub active_registrations: u32,
    pub total_registrations: u64,
    pub accepted_principal: U128,
    pub created_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Registration {
    pub registration_id: String,
    pub event_id: String,
    pub pass_id: String,
    pub participant: AccountId,
    pub beneficiary: AccountId,
    pub commitment_id: String,
    pub amount: U128,
    pub event_sequence: u64,
    pub registration_status: RegistrationStatus,
    pub attendance_status: AttendanceStatus,
    pub financial_status: FinancialStatus,
    pub registered_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Pass {
    pub pass_id: String,
    pub event_id: String,
    pub registration_id: String,
    pub owner: AccountId,
    pub issued_at: u64,
    pub registration_status: RegistrationStatus,
    pub attendance_status: AttendanceStatus,
    pub financial_status: FinancialStatus,
    pub policy_version: String,
}

/// Bounded, versioned `ft_on_transfer` message. No owner/beneficiary/recipient
/// field is accepted; unknown fields are rejected.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitMessage {
    version: u32,
    event_id: String,
    commitment_id: String,
}

/// Event rules supplied once at publication. Times are UTC milliseconds.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EventRules {
    pub rules_hash: String,
    pub deposit: U128,
    pub capacity: u32,
    pub reg_open: u64,
    pub reg_close: u64,
    pub cancel_cutoff: u64,
    pub checkin_open: u64,
    pub checkin_close: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ConfigView {
    pub organizer: AccountId,
    pub canonical_ft: AccountId,
    pub network: String,
    pub policy_version: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct EventView {
    pub event_id: String,
    pub organizer: AccountId,
    pub canonical_ft: AccountId,
    pub rules_hash: String,
    pub deposit: U128,
    pub capacity: u32,
    pub reg_open: u64,
    pub reg_close: u64,
    pub cancel_cutoff: u64,
    pub checkin_open: u64,
    pub checkin_close: u64,
    pub finalize_deadline: u64,
    pub policy_version: String,
    pub state: EventState,
    pub phase: EventPhase,
    pub active_registrations: u32,
    pub total_registrations: u64,
    pub accepted_principal: U128,
    pub created_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RegistrationView {
    pub registration_id: String,
    pub event_id: String,
    pub pass_id: String,
    pub participant: AccountId,
    pub beneficiary: AccountId,
    pub commitment_id: String,
    pub amount: U128,
    pub event_sequence: u64,
    pub registration_status: RegistrationStatus,
    pub attendance_status: AttendanceStatus,
    pub financial_status: FinancialStatus,
    pub registered_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PassView {
    pub pass_id: String,
    pub event_id: String,
    pub registration_id: String,
    pub owner: AccountId,
    pub issued_at: u64,
    pub registration_status: RegistrationStatus,
    pub attendance_status: AttendanceStatus,
    pub financial_status: FinancialStatus,
    pub policy_version: String,
}

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const MIN_CAPACITY: u32 = 1;
const MAX_CAPACITY: u32 = 200;
const MAX_ID_LEN: usize = 64;
const MAX_HASH_LEN: usize = 128;
const MAX_MSG_LEN: usize = 512;
const MAX_LIST_LIMIT: u32 = 50;
const MAX_TEXT_LEN: usize = 64;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    events: LookupMap<String, Event>,
    event_ids: LookupMap<u64, String>,
    registrations: LookupMap<String, Registration>,
    passes: LookupMap<String, Pass>,
    /// Lifetime uniqueness of (payer, commitment_id); no event selector.
    commitments: LookupMap<(AccountId, String), String>,
    /// One active registration per (event, participant account).
    active: LookupMap<(String, AccountId), String>,
    /// Append-only per-event registration index for bounded lists.
    event_index: LookupMap<(String, u64), String>,
    /// Unused prepaid native NEAR storage credit, in yoctoNEAR.
    credits: LookupMap<AccountId, u128>,
    /// Aggregate accepted canonical-FT principal held by this contract.
    escrow_principal: u128,
    next_event_seq: u64,
    next_registration_seq: u64,
}

#[near]
impl Contract {
    /// One-time initialization. The event organizer, canonical FT, network
    /// label and policy version are immutable for the lifetime of the
    /// deployment. There is exactly one event instance per contract.
    #[init]
    pub fn new(
        organizer: AccountId,
        canonical_ft: AccountId,
        network: String,
        policy_version: String,
    ) -> Self {
        require!(valid_text(&network), "network must be 1..=64 printable ASCII chars");
        require!(
            valid_text(&policy_version),
            "policy_version must be 1..=64 printable ASCII chars"
        );
        Self {
            config: Config {
                organizer,
                canonical_ft,
                network,
                policy_version,
            },
            events: LookupMap::new(b"ev".to_vec()),
            event_ids: LookupMap::new(b"ei".to_vec()),
            registrations: LookupMap::new(b"rg".to_vec()),
            passes: LookupMap::new(b"ps".to_vec()),
            commitments: LookupMap::new(b"cm".to_vec()),
            active: LookupMap::new(b"ac".to_vec()),
            event_index: LookupMap::new(b"ix".to_vec()),
            credits: LookupMap::new(b"cr".to_vec()),
            escrow_principal: 0,
            next_event_seq: 0,
            next_registration_seq: 0,
        }
    }

    // ----------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            organizer: self.config.organizer.clone(),
            canonical_ft: self.config.canonical_ft.clone(),
            network: self.config.network.clone(),
            policy_version: self.config.policy_version.clone(),
        }
    }

    pub fn get_event(&self, event_id: String) -> EventView {
        let event = self.event_or_panic(&event_id);
        self.event_view(&event)
    }

    pub fn get_registration(&self, registration_id: String) -> RegistrationView {
        let registration = self.registration_or_panic(&registration_id);
        registration_view(&registration)
    }

    pub fn get_pass(&self, pass_id: String) -> PassView {
        let pass = self.pass_or_panic(&pass_id);
        pass_view(&pass)
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).unwrap_or(0))
    }

    /// Aggregate accepted canonical-FT principal. Per-event principal is in
    /// `get_event`.
    pub fn get_escrow_principal(&self) -> U128 {
        U128(self.escrow_principal)
    }

    /// Chain clock in UTC milliseconds, used by local clients to build and
    /// test time boundaries. Read-only.
    pub fn get_block_timestamp_ms(&self) -> u64 {
        env::block_timestamp_ms()
    }

    pub fn list_events(&self, from: u64, limit: u32) -> Vec<EventView> {
        require!(limit >= 1 && limit <= MAX_LIST_LIMIT, "limit must be 1..=50");
        let mut out = Vec::new();
        let mut index = from;
        while out.len() < limit as usize {
            let Some(event_id) = self.event_ids.get(&index) else {
                break;
            };
            let Some(event) = self.events.get(&event_id) else {
                break;
            };
            out.push(self.event_view(&event));
            index = match index.checked_add(1) {
                Some(next) => next,
                None => break,
            };
        }
        out
    }

    pub fn list_event_registrations(
        &self,
        event_id: String,
        from: u64,
        limit: u32,
    ) -> Vec<RegistrationView> {
        require!(limit >= 1 && limit <= MAX_LIST_LIMIT, "limit must be 1..=50");
        let event = self.event_or_panic(&event_id);
        let mut out = Vec::new();
        let mut index = from;
        while out.len() < limit as usize && index < event.total_registrations {
            let Some(registration_id) = self.event_index.get(&(event_id.clone(), index)) else {
                break;
            };
            let Some(registration) = self.registrations.get(&registration_id) else {
                break;
            };
            out.push(registration_view(&registration));
            index = match index.checked_add(1) {
                Some(next) => next,
                None => break,
            };
        }
        out
    }

    // --------------------------------------------------------- native storage

    /// Prepay native NEAR storage credit. This never creates an FT credit,
    /// seat, registration or pass. `account_id` may top up another account.
    ///
    /// A new account's `credits` entry costs real contract storage, so that
    /// measured footprint is paid from the attached deposit before any credit
    /// is granted; an attached amount smaller than the entry footprint is
    /// rejected atomically. Existing entries are fixed-size `u128` values, so
    /// a top-up is charged only the actual growth (normally zero).
    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached > 0, "storage_deposit requires a positive attached deposit");
        let before_balance = self.credits.get(&account).unwrap_or(0);
        let next = self.add_credit(&account, attached);
        let credited = next.saturating_sub(before_balance);
        let storage_charge = attached.saturating_sub(credited);
        log_event(
            "StorageDeposited",
            near_sdk::serde_json::json!({
                "account": account,
                "deposited_yocto": attached.to_string(),
                "storage_charge_yocto": storage_charge.to_string(),
                "credited_yocto": credited.to_string(),
                "balance_yocto": next.to_string(),
            }),
        );
        U128(next)
    }

    // --------------------------------------------------------------- publish

    /// Publish the single event instance. Only the immutable organizer fixed
    /// at initialization may publish, and a second publish of any event id is
    /// denied before any state or credit mutation. Any attached native deposit
    /// becomes prepaid storage credit, after the credit entry's own measured
    /// storage growth is paid from that deposit; event storage is then charged
    /// from the resulting credit using measured storage usage.
    #[payable]
    pub fn publish_event(&mut self, event_id: String, rules: EventRules) -> EventView {
        let organizer = env::predecessor_account_id();
        require!(
            organizer == self.config.organizer,
            "only the configured organizer may publish"
        );
        // One event per contract: check before validating or writing anything
        // else so a second publish cannot create state, consume credit, or
        // front-run the configured organizer.
        require!(self.next_event_seq == 0, "event already published");
        require!(valid_id(&event_id), "event_id must be 1..=64 safe ASCII chars");
        require!(
            valid_hash(&rules.rules_hash),
            "rules_hash must be 1..=128 printable ASCII chars"
        );
        require!(rules.deposit.0 > 0, "deposit must be positive");
        require!(
            rules.capacity >= MIN_CAPACITY && rules.capacity <= MAX_CAPACITY,
            "capacity must be 1..=200"
        );
        require!(rules.reg_open < rules.reg_close, "reg_open must be < reg_close");
        require!(
            rules.reg_close <= rules.cancel_cutoff,
            "reg_close must be <= cancel_cutoff"
        );
        require!(
            rules.cancel_cutoff <= rules.checkin_open,
            "cancel_cutoff must be <= checkin_open"
        );
        require!(
            rules.checkin_open < rules.checkin_close,
            "checkin_open must be < checkin_close"
        );
        let finalize_deadline = rules
            .checkin_close
            .checked_add(DAY_MS)
            .unwrap_or_else(|| env::panic_str("finalize deadline overflow"));

        let attached = env::attached_deposit().as_yoctonear();
        if attached > 0 {
            // Charge the credits entry's measured growth first, so the event
            // measurement below starts after that entry already exists.
            self.add_credit(&organizer, attached);
        }

        let now = env::block_timestamp_ms();
        let event = Event {
            event_id: event_id.clone(),
            organizer: organizer.clone(),
            rules_hash: rules.rules_hash,
            deposit: rules.deposit,
            capacity: rules.capacity,
            reg_open: rules.reg_open,
            reg_close: rules.reg_close,
            cancel_cutoff: rules.cancel_cutoff,
            checkin_open: rules.checkin_open,
            checkin_close: rules.checkin_close,
            finalize_deadline,
            policy_version: self.config.policy_version.clone(),
            state: EventState::Published,
            active_registrations: 0,
            total_registrations: 0,
            accepted_principal: U128(0),
            created_at: now,
        };

        // Measured storage reserve: the charge is the actual growth of contract
        // storage caused by this event and its index entry.
        let seq = self.next_event_seq;
        let before = env::storage_usage();
        self.events.insert(&event_id, &event);
        self.event_ids.insert(&seq, &event_id);
        self.next_event_seq = seq.checked_add(1).unwrap_or_else(|| env::panic_str("event seq overflow"));
        let after = env::storage_usage();
        let cost = storage_cost(before, after);
        let credit = self.credits.get(&organizer).unwrap_or(0);
        let remaining = credit
            .checked_sub(cost)
            .unwrap_or_else(|| env::panic_str("insufficient prepaid storage for event"));
        self.credits.insert(&organizer, &remaining);

        log_event(
            "EventPublished",
            near_sdk::serde_json::json!({
                "event_id": &event.event_id,
                "organizer": &event.organizer,
                "deposit": event.deposit.0.to_string(),
                "capacity": event.capacity,
                "finalize_deadline": event.finalize_deadline,
                "policy_version": &event.policy_version,
                "storage_cost_yocto": cost.to_string(),
            }),
        );
        self.event_view(&event)
    }

    // ----------------------------------------------------------- FT deposit

    /// NEP-141 receiver. Only the immutable canonical FT may call this.
    ///
    /// Accepted path (all validated before any write): exact D, canonical FT,
    /// registration phase, capacity, one active account/event, lifetime-unique
    /// (payer, commitment_id), checked arithmetic and sufficient prepaid
    /// storage. It writes one registration and one pass in this same receipt
    /// and returns 0.
    ///
    /// Every invalid path returns the full amount as unused and creates no
    /// registration, pass, seat or principal.
    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let predecessor = env::predecessor_account_id();
        if predecessor != self.config.canonical_ft {
            log_reject("WRONG_FT", amount.0);
            return refund(amount);
        }
        if amount.0 == 0 {
            log_reject("ZERO_AMOUNT", amount.0);
            return refund(amount);
        }
        if msg.len() > MAX_MSG_LEN {
            log_reject("MSG_TOO_LONG", amount.0);
            return refund(amount);
        }
        let message: CommitMessage = match near_sdk::serde_json::from_str(&msg) {
            Ok(message) => message,
            Err(_) => {
                log_reject("BAD_MSG", amount.0);
                return refund(amount);
            }
        };
        if message.version != 1 {
            log_reject("BAD_MSG_VERSION", amount.0);
            return refund(amount);
        }
        if !valid_id(&message.event_id) || !valid_id(&message.commitment_id) {
            log_reject("BAD_MSG_ID", amount.0);
            return refund(amount);
        }

        let Some(event) = self.events.get(&message.event_id) else {
            log_reject("EVENT_NOT_FOUND", amount.0);
            return refund(amount);
        };

        let now = env::block_timestamp_ms();
        if now < event.reg_open || now >= event.reg_close {
            log_reject("PHASE_CLOSED", amount.0);
            return refund(amount);
        }
        if amount.0 != event.deposit.0 {
            log_reject("WRONG_AMOUNT", amount.0);
            return refund(amount);
        }
        if event.active_registrations >= event.capacity {
            log_reject("CAPACITY_FULL", amount.0);
            return refund(amount);
        }
        let active_key = (message.event_id.clone(), sender_id.clone());
        if self.active.contains_key(&active_key) {
            log_reject("ACTIVE_REGISTRATION", amount.0);
            return refund(amount);
        }
        let commitment_key = (sender_id.clone(), message.commitment_id.clone());
        if self.commitments.contains_key(&commitment_key) {
            log_reject("DUPLICATE_COMMITMENT", amount.0);
            return refund(amount);
        }

        let old_escrow = self.escrow_principal;
        let new_escrow = match old_escrow.checked_add(amount.0) {
            Some(value) => value,
            None => {
                log_reject("PRINCIPAL_OVERFLOW", amount.0);
                return refund(amount);
            }
        };
        let new_event_accepted = match event.accepted_principal.0.checked_add(amount.0) {
            Some(value) => value,
            None => {
                log_reject("PRINCIPAL_OVERFLOW", amount.0);
                return refund(amount);
            }
        };

        let seq = self.next_registration_seq;
        let registration_id = format!("reg-{seq}");
        let pass_id = format!("pass-{seq}");
        let event_sequence = event.total_registrations;
        let mut updated_event = event.clone();
        updated_event.active_registrations = match updated_event.active_registrations.checked_add(1) {
            Some(value) => value,
            None => {
                log_reject("CAPACITY_OVERFLOW", amount.0);
                return refund(amount);
            }
        };
        updated_event.total_registrations = match updated_event.total_registrations.checked_add(1) {
            Some(value) => value,
            None => {
                log_reject("SEQUENCE_OVERFLOW", amount.0);
                return refund(amount);
            }
        };
        updated_event.accepted_principal = U128(new_event_accepted);

        let registration = Registration {
            registration_id: registration_id.clone(),
            event_id: message.event_id.clone(),
            pass_id: pass_id.clone(),
            participant: sender_id.clone(),
            beneficiary: sender_id.clone(),
            commitment_id: message.commitment_id.clone(),
            amount,
            event_sequence,
            registration_status: RegistrationStatus::Active,
            attendance_status: AttendanceStatus::NotMarked,
            financial_status: FinancialStatus::Committed,
            registered_at: now,
        };
        let pass = Pass {
            pass_id: pass_id.clone(),
            event_id: message.event_id.clone(),
            registration_id: registration_id.clone(),
            owner: sender_id.clone(),
            issued_at: now,
            registration_status: RegistrationStatus::Active,
            attendance_status: AttendanceStatus::NotMarked,
            financial_status: FinancialStatus::Committed,
            policy_version: self.config.policy_version.clone(),
        };

        // One receipt: all of these writes belong to this ft_on_transfer call.
        let before = env::storage_usage();
        self.registrations.insert(&registration_id, &registration);
        self.passes.insert(&pass_id, &pass);
        self.commitments.insert(&commitment_key, &registration_id);
        self.active.insert(&active_key, &registration_id);
        self.event_index
            .insert(&(message.event_id.clone(), event_sequence), &registration_id);
        self.events.insert(&message.event_id, &updated_event);
        self.escrow_principal = new_escrow;
        self.next_registration_seq = seq.checked_add(1).unwrap_or_else(|| env::panic_str("registration seq overflow"));
        let after = env::storage_usage();
        let cost = storage_cost(before, after);
        let credit = self.credits.get(&sender_id).unwrap_or(0);
        let remaining = match credit.checked_sub(cost) {
            Some(value) => value,
            None => {
                // No state right was granted: remove every write made above and
                // restore the aggregate/root counters before refunding the FT.
                self.registrations.remove(&registration_id);
                self.passes.remove(&pass_id);
                self.commitments.remove(&commitment_key);
                self.active.remove(&active_key);
                self.event_index
                    .remove(&(message.event_id.clone(), event_sequence));
                self.events.insert(&message.event_id, &event);
                self.escrow_principal = old_escrow;
                self.next_registration_seq = seq;
                log_reject("STORAGE_INSUFFICIENT", amount.0);
                return refund(amount);
            }
        };
        self.credits.insert(&sender_id, &remaining);

        log_event(
            "RegistrationCommitted",
            near_sdk::serde_json::json!({
                "event_id": message.event_id,
                "registration_id": registration_id,
                "pass_id": pass_id,
                "participant": &sender_id,
                "beneficiary": &sender_id,
                "commitment_id": message.commitment_id,
                "amount": amount.0.to_string(),
                "event_sequence": event_sequence,
                "storage_cost_yocto": cost.to_string(),
            }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ------------------------------------- explicit non-transferable surface

    #[payable]
    pub fn nft_transfer(
        &mut self,
        _receiver_id: AccountId,
        _token_id: String,
        _approval_id: Option<u64>,
        _memo: Option<String>,
    ) {
        deny_pass_op("PASS_NOT_TRANSFERABLE: ShowStake passes are account-bound");
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        _receiver_id: AccountId,
        _token_id: String,
        _approval_id: Option<u64>,
        _memo: Option<String>,
        _msg: String,
    ) -> PromiseOrValue<U128> {
        deny_pass_op("PASS_NOT_TRANSFERABLE: ShowStake passes are account-bound");
    }

    #[payable]
    pub fn nft_approve(
        &mut self,
        _account_id: AccountId,
        _token_id: String,
        _msg: Option<String>,
    ) {
        deny_pass_op("PASS_NOT_TRANSFERABLE: ShowStake passes have no approvals");
    }

    #[payable]
    pub fn nft_revoke(&mut self, _account_id: AccountId, _token_id: String) {
        deny_pass_op("PASS_NOT_TRANSFERABLE: ShowStake passes have no approvals");
    }

    #[payable]
    pub fn nft_revoke_all(&mut self, _token_id: String) {
        deny_pass_op("PASS_NOT_TRANSFERABLE: ShowStake passes have no approvals");
    }

    /// No burn: a burn must never destroy financial rights.
    #[payable]
    pub fn burn(&mut self, _token_id: String) {
        deny_pass_op("PASS_NOT_TRANSFERABLE: ShowStake passes cannot be burned");
    }

    /// No administrator may reassign a pass owner.
    pub fn admin_reassign_pass(&mut self, _pass_id: String, _new_owner: AccountId) {
        deny_pass_op("PASS_NOT_TRANSFERABLE: no admin reassignment exists");
    }
}

impl Contract {
    /// Add native credit and charge the measured growth of the `credits` entry
    /// itself. A new entry's key/value footprint (plus the runtime's per-record
    /// overhead) is paid from `amount`; only the remainder is spendable. Any
    /// entry that already exists has a fixed-size Borsh `u128` value, so a
    /// top-up is charged only the actual growth, normally zero. A too-small
    /// prepay for a new entry restores the map and traps atomically.
    fn add_credit(&mut self, account: &AccountId, amount: u128) -> u128 {
        let before = env::storage_usage();
        let previous = self.credits.get(account);
        let current = previous.unwrap_or(0);
        let gross = current
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("storage credit overflow"));
        // Tentative write: reverting to `previous` before trapping keeps the
        // mocked VM in the same state a reverted receipt leaves on chain.
        self.credits.insert(account, &gross);
        let after = env::storage_usage();
        let entry_cost = storage_cost(before, after);
        if amount < entry_cost {
            match previous {
                Some(value) => self.credits.insert(account, &value),
                None => self.credits.remove(account),
            };
            env::panic_str(&format!(
                "storage deposit too small for new credit entry: attached {amount}, requires {entry_cost}"
            ));
        }
        let net = gross
            .checked_sub(entry_cost)
            .unwrap_or_else(|| env::panic_str("storage credit underflow"));
        // The final value is also a fixed-size u128, so this rewrite does not
        // grow storage beyond the measurement above.
        self.credits.insert(account, &net);
        net
    }

    fn event_or_panic(&self, event_id: &str) -> Event {
        self.events
            .get(&event_id.to_string())
            .unwrap_or_else(|| env::panic_str(&format!("event not found: {event_id}")))
    }

    fn registration_or_panic(&self, registration_id: &str) -> Registration {
        self.registrations
            .get(&registration_id.to_string())
            .unwrap_or_else(|| env::panic_str(&format!("registration not found: {registration_id}")))
    }

    fn pass_or_panic(&self, pass_id: &str) -> Pass {
        self.passes
            .get(&pass_id.to_string())
            .unwrap_or_else(|| env::panic_str(&format!("pass not found: {pass_id}")))
    }

    fn event_view(&self, event: &Event) -> EventView {
        EventView {
            event_id: event.event_id.clone(),
            organizer: event.organizer.clone(),
            canonical_ft: self.config.canonical_ft.clone(),
            rules_hash: event.rules_hash.clone(),
            deposit: event.deposit,
            capacity: event.capacity,
            reg_open: event.reg_open,
            reg_close: event.reg_close,
            cancel_cutoff: event.cancel_cutoff,
            checkin_open: event.checkin_open,
            checkin_close: event.checkin_close,
            finalize_deadline: event.finalize_deadline,
            policy_version: event.policy_version.clone(),
            state: event.state.clone(),
            phase: event_phase(event, env::block_timestamp_ms()),
            active_registrations: event.active_registrations,
            total_registrations: event.total_registrations,
            accepted_principal: event.accepted_principal,
            created_at: event.created_at,
        }
    }
}

fn event_phase(event: &Event, now: u64) -> EventPhase {
    if now < event.reg_open {
        EventPhase::Scheduled
    } else if now < event.reg_close {
        EventPhase::RegistrationOpen
    } else {
        EventPhase::RegistrationClosed
    }
}

fn registration_view(registration: &Registration) -> RegistrationView {
    RegistrationView {
        registration_id: registration.registration_id.clone(),
        event_id: registration.event_id.clone(),
        pass_id: registration.pass_id.clone(),
        participant: registration.participant.clone(),
        beneficiary: registration.beneficiary.clone(),
        commitment_id: registration.commitment_id.clone(),
        amount: registration.amount,
        event_sequence: registration.event_sequence,
        registration_status: registration.registration_status.clone(),
        attendance_status: registration.attendance_status.clone(),
        financial_status: registration.financial_status.clone(),
        registered_at: registration.registered_at,
    }
}

fn pass_view(pass: &Pass) -> PassView {
    PassView {
        pass_id: pass.pass_id.clone(),
        event_id: pass.event_id.clone(),
        registration_id: pass.registration_id.clone(),
        owner: pass.owner.clone(),
        issued_at: pass.issued_at,
        registration_status: pass.registration_status.clone(),
        attendance_status: pass.attendance_status.clone(),
        financial_status: pass.financial_status.clone(),
        policy_version: pass.policy_version.clone(),
    }
}

fn refund(amount: U128) -> PromiseOrValue<U128> {
    PromiseOrValue::Value(amount)
}

fn storage_cost(before: u64, after: u64) -> u128 {
    let bytes = after.saturating_sub(before) as u128;
    env::storage_byte_cost()
        .as_yoctonear()
        .checked_mul(bytes)
        .unwrap_or(u128::MAX)
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_hash(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HASH_LEN
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn valid_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_TEXT_LEN
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}

fn log_event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"showstake\",\"version\":\"1.0.0\",\"event\":\"{name}\",\"data\":{data}}}"
    ));
}

fn log_reject(reason: &str, amount: u128) {
    env::log_str(&format!(
        "SHOWSTAKE_REJECT reason={reason} amount={amount}"
    ));
}

/// Record an explicit machine-checkable reason before the release-Wasm trap.
/// A failed receipt may expose only `WebAssembly trap`, so the log is the
/// stable negative-path evidence for the non-transferable surface.
fn deny_pass_op(message: &str) -> ! {
    env::log_str("SHOWSTAKE_REJECT reason=PASS_NOT_TRANSFERABLE");
    env::panic_str(message);
}
