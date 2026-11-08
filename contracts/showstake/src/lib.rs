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
//!   * bounded views, and explicit rejection of transfer/approval/reassignment,
//!   * one lifetime registration per account/event (no voluntary
//!     withdrawal/rejoin), O(1) organizer cancellation and timeout
//!     refund-only, and exactly-once beneficiary claims materialized lazily,
//!   * organizer attendance marking inside the check-in window, an immutable
//!     attendance snapshot at finalization, and permissionless bounded
//!     settlement that redistributes no-show principal to attendees with a
//!     deterministic registration-sequence remainder. Claims stay disabled
//!     until the allocation is complete.
//!
//! Out of scope here: the factory. The state retained below is only what the
//! settlement/claim stages need.
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
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use serde::Deserialize;

/// Event financial state for this slice. Variants are append-only so Borsh
/// state written by the deployed `Published`-only artifact still decodes.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventState {
    Published,
    Cancelled,
    RefundOnly,
    AttendanceFinalized,
    Settling,
    Settled,
}

/// Registration lifecycle in this slice: accepted registrations are Active.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegistrationStatus {
    Active,
    Withdrawn,
}

/// Organizer-marked attendance. `NoShow` is derived once attendance is frozen;
/// only `NotMarked`/`Attended` are ever written.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttendanceStatus {
    NotMarked,
    Attended,
    NoShow,
}

/// Registration/pass financial lifecycle. Variants are append-only so Borsh
/// state written by the deployed `Committed`-only artifact still decodes.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FinancialStatus {
    Committed,
    Claimable,
    Pending,
    Paid,
    Forfeited,
}

/// Derived from immutable times and block time (plus terminal event state);
/// never stored.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventPhase {
    Scheduled,
    RegistrationOpen,
    RegistrationClosed,
    Cancelled,
    RefundOnly,
    AttendanceFinalized,
    Settling,
    Settled,
}

/// Outcome of one FT payout attempt. Not stored directly; derived from the
/// registration claim record.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PayoutState {
    Pending,
    Succeeded,
    Failed,
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

/// Fixed-size per-registration claim state. Deliberately created in the same
/// measured storage write as a new registration, so no non-payable lifecycle
/// method ever creates uncharged storage. Field widths are fixed, so updates
/// during cancel/refund-only/claim/callback never grow storage.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ClaimRecord {
    pub amount: U128,
    pub paid_amount: U128,
    pub payout_state: FinancialStatus,
    pub attempts: u32,
    /// 0 means no payout is pending; otherwise it is the attempt number.
    pub pending_attempt: u32,
    pub withdrawn_at: u64,
}

/// Fixed-size per-event accounting aggregates. Created during the measured
/// publish write and updated only by fixed-size claim/callback writes. This
/// keeps cancellation, timeout activation and totals O(1); no critical write
/// walks the capacity-200 registration set.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EventAccounting {
    pub paid: U128,
    pub pending: U128,
}

/// Fixed-size per-event attendance/settlement state. Created in the measured
/// `publish_event` write, so finalize/settle never create uncharged storage.
/// `cursor`, `attendee_cursor`, `allocated_count` and `allocated_total` are the
/// frozen resumable chunk cursor plus the independent sum verification basis.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct SettlementState {
    pub attendance_frozen: bool,
    pub finalized_at: u64,
    pub attendee_count: u32,
    pub pool: U128,
    pub base_share: U128,
    pub remainder: U128,
    pub cursor: u64,
    pub attendee_cursor: u32,
    pub allocated_count: u64,
    pub allocated_total: U128,
    pub complete: bool,
    pub completed_at: u64,
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
    pub withdrawn_registrations: u64,
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

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ClaimView {
    pub registration_id: String,
    pub event_id: String,
    pub beneficiary: AccountId,
    pub amount: U128,
    pub payout_state: FinancialStatus,
    pub pending_payout_id: Option<String>,
    pub paid_amount: U128,
    pub withdrawn_at: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PayoutView {
    pub payout_id: String,
    pub registration_id: String,
    pub event_id: String,
    pub beneficiary: AccountId,
    pub amount: U128,
    pub state: PayoutState,
    pub attempt: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventTotalsView {
    pub event_id: String,
    pub state: EventState,
    pub registrations: u64,
    pub active_registrations: u32,
    pub withdrawn_registrations: u64,
    pub accepted_principal: U128,
    pub paid: U128,
    pub pending: U128,
    pub liability: U128,
}

/// O(1) attendance/settlement view. Additive: existing view JSON is
/// unchanged.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SettlementView {
    pub event_id: String,
    pub state: EventState,
    pub attendance_frozen: bool,
    pub attendee_count: u32,
    pub no_show_count: u64,
    pub registrations: u64,
    pub pool: U128,
    pub base_share: U128,
    pub remainder: U128,
    pub cursor: u64,
    pub allocated_count: u64,
    pub allocated_total: U128,
    pub complete: bool,
    pub claims_enabled: bool,
    pub finalized_at: u64,
    pub completed_at: u64,
}

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const FT_TRANSFER_GAS: u64 = 50_000_000_000_000;
const PAYOUT_CALLBACK_GAS: u64 = 40_000_000_000_000;
const CLAIM_MIN_PREPAID_GAS: u64 = 100_000_000_000_000;
const ONE_YOCTO: u128 = 1;
const MIN_CAPACITY: u32 = 1;
const MAX_CAPACITY: u32 = 200;
const MAX_ID_LEN: usize = 64;
const MAX_HASH_LEN: usize = 128;
const MAX_MSG_LEN: usize = 512;
const MAX_LIST_LIMIT: u32 = 50;
const MAX_TEXT_LEN: usize = 64;
/// Product state schema. Old candidates lack the `sv` marker and must use a
/// clean instance; the settlement generation never upgrades them in place.
const SCHEMA_VERSION: u32 = 3;

/// Bounded settlement chunk. Each `settle` call allocates at most this many
/// registrations from the frozen registration-sequence cursor, so a
/// capacity-200 event completes in eight permissionless calls without a
/// history walk in any single receipt.
const SETTLE_CHUNK: u64 = 25;

/// Published policy identity. D036 removes voluntary withdrawal/rejoin and
/// this generation adds organizer attendance finalization plus permissionless
/// bounded settlement, so an instance built from this source must not be
/// labelled with an earlier identity.
pub const POLICY_IDENTITY: &str = "showstake-v2-d036-settle/1";

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
    ///
    /// `policy_version` must equal [`POLICY_IDENTITY`] (D036: commit/pass is
    /// final, no voluntary withdrawal or rejoin). The parameter is retained
    /// for ABI stability with the deployed `fc49fb85` surface, but the earlier
    /// voluntary-withdrawal identity `showstake-v2/1` is rejected so old rules
    /// can never be silently reinterpreted by a new instance.
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
        require!(
            policy_version == POLICY_IDENTITY,
            "policy_version must equal the current D036 policy identity"
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
        let event = self.event_or_panic(&registration.event_id);
        let frozen = self.attendance_frozen_or_default(&event.event_id);
        registration_view(&registration, &event, frozen)
    }

    pub fn get_pass(&self, pass_id: String) -> PassView {
        let pass = self.pass_or_panic(&pass_id);
        let event = self.event_or_panic(&pass.event_id);
        let frozen = self.attendance_frozen_or_default(&event.event_id);
        pass_view(&pass, &event, frozen)
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).unwrap_or(0))
    }

    /// Aggregate canonical-FT principal still held by this contract (accepted
    /// minus successful payouts). Per-event cumulative principal is in
    /// `get_event`; paid/pending/liability are in `get_event_totals`.
    pub fn get_escrow_principal(&self) -> U128 {
        U128(self.escrow_principal)
    }

    pub fn get_claim(&self, registration_id: String) -> ClaimView {
        let registration = self.registration_or_panic(&registration_id);
        self.schema_or_panic(&registration.event_id);
        let record = self.claim_record_or_panic(&registration_id);
        let event = self.event_or_panic(&registration.event_id);
        self.claim_view(&registration, &record, &event)
    }

    pub fn get_payout(&self, payout_id: String) -> PayoutView {
        let (registration_id, attempt) = parse_payout_id(&payout_id)
            .unwrap_or_else(|| env::panic_str("invalid payout id"));
        let registration = self.registration_or_panic(&registration_id);
        self.schema_or_panic(&registration.event_id);
        let record = self.claim_record_or_panic(&registration_id);
        self.payout_view(&payout_id, attempt, &registration, &record)
    }

    pub fn get_event_totals(&self, event_id: String) -> EventTotalsView {
        let event = self.event_or_panic(&event_id);
        self.event_totals(&event)
    }

    /// O(1) attendance/settlement state for the single event instance.
    pub fn get_settlement(&self, event_id: String) -> SettlementView {
        let event = self.event_or_panic(&event_id);
        self.schema_or_panic(&event.event_id);
        let settlement = self.settlement_or_panic(&event.event_id);
        self.settlement_view(&event, &settlement)
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
        let attendance_frozen = self.attendance_frozen_or_default(&event.event_id);
        let mut out = Vec::new();
        let mut index = from;
        while out.len() < limit as usize && index < event.total_registrations {
            let Some(registration_id) = self.event_index.get(&(event_id.clone(), index)) else {
                break;
            };
            let Some(registration) = self.registrations.get(&registration_id) else {
                break;
            };
            out.push(registration_view(&registration, &event, attendance_frozen));
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
        self.schema().insert(&event_id, &SCHEMA_VERSION);
        self.accounting().insert(
            &event_id,
            &EventAccounting {
                paid: U128(0),
                pending: U128(0),
            },
        );
        self.settlement().insert(
            &event_id,
            &SettlementState {
                attendance_frozen: false,
                finalized_at: 0,
                attendee_count: 0,
                pool: U128(0),
                base_share: U128(0),
                remainder: U128(0),
                cursor: 0,
                attendee_cursor: 0,
                allocated_count: 0,
                allocated_total: U128(0),
                complete: false,
                completed_at: 0,
            },
        );
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
        if event.state != EventState::Published {
            log_reject("EVENT_NOT_PUBLISHED", amount.0);
            return refund(amount);
        }
        // Clean-instance gate: legacy states have no schema marker and are
        // never upgraded in place.
        self.schema_or_panic(&event.event_id);

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
        let lifetime_key = (message.event_id.clone(), sender_id.clone());
        if self.lifetime().contains_key(&lifetime_key) {
            log_reject("ACCOUNT_ALREADY_REGISTERED", amount.0);
            return refund(amount);
        }
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
        let claim_record = ClaimRecord {
            amount: U128(0),
            paid_amount: U128(0),
            payout_state: FinancialStatus::Committed,
            attempts: 0,
            pending_attempt: 0,
            withdrawn_at: 0,
        };

        // One receipt: all of these writes belong to this ft_on_transfer call.
        let before = env::storage_usage();
        self.registrations.insert(&registration_id, &registration);
        self.passes.insert(&pass_id, &pass);
        self.claims().insert(&registration_id, &claim_record);
        self.commitments.insert(&commitment_key, &registration_id);
        self.active.insert(&active_key, &registration_id);
        self.lifetime().insert(&lifetime_key, &registration_id);
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
                self.claims().remove(&registration_id);
                self.commitments.remove(&commitment_key);
                self.active.remove(&active_key);
                self.lifetime().remove(&lifetime_key);
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

    // ---------------------------------- attendance / finalization / settle

    /// Organizer-only attendance attestation inside the check-in window.
    /// Repeated marks with the same value are idempotent and write nothing;
    /// `attended=false` is a correction inside the same window. The
    /// registration and its pass are updated together.
    pub fn mark_attendance(
        &mut self,
        registration_id: String,
        attended: bool,
    ) -> RegistrationView {
        let organizer = env::predecessor_account_id();
        require!(
            organizer == self.config.organizer,
            "only the configured organizer may mark attendance"
        );
        let mut registration = self.registration_or_panic(&registration_id);
        let event = self.event_or_panic(&registration.event_id);
        require!(
            event.state == EventState::Published,
            "attendance can only be marked before finalization"
        );
        self.schema_or_panic(&event.event_id);
        let now = env::block_timestamp_ms();
        require!(
            now >= event.checkin_open && now < event.checkin_close,
            "attendance marking is only allowed inside the check-in window"
        );
        let mut pass = self.pass_or_panic(&registration.pass_id);
        let desired = if attended {
            AttendanceStatus::Attended
        } else {
            AttendanceStatus::NotMarked
        };
        let changed = registration.attendance_status != desired;
        if changed {
            registration.attendance_status = desired.clone();
            pass.attendance_status = desired;
            self.registrations.insert(&registration_id, &registration);
            self.passes.insert(&registration.pass_id, &pass);
        }
        log_event(
            "AttendanceMarked",
            near_sdk::serde_json::json!({
                "event_id": event.event_id,
                "registration_id": registration_id,
                "attended": attended,
                "changed": changed,
            }),
        );
        registration_view(&registration, &event, false)
    }

    /// Organizer-only attendance snapshot in `[checkin_close,
    /// finalize_deadline)`. Walks the append-only registration index once
    /// (bounded by capacity 200), freezes attendee count and moves the event to
    /// ATTENDANCE_FINALIZED. Attendance cannot change afterwards.
    pub fn finalize_event(&mut self, event_id: String) -> EventView {
        let organizer = env::predecessor_account_id();
        require!(
            organizer == self.config.organizer,
            "only the configured organizer may finalize"
        );
        let mut event = self.event_or_panic(&event_id);
        require!(
            event.state == EventState::Published,
            "cannot finalize from the current event state"
        );
        self.schema_or_panic(&event.event_id);
        let now = env::block_timestamp_ms();
        require!(now >= event.checkin_close, "finalization opens at checkin_close");
        require!(
            now < event.finalize_deadline,
            "finalization deadline reached; only refund-only remains"
        );
        let mut settlement = self.settlement_or_panic(&event.event_id);
        require!(!settlement.attendance_frozen, "attendance already finalized");

        let mut attended: u32 = 0;
        let mut sequence: u64 = 0;
        while sequence < event.total_registrations {
            let Some(registration_id) = self
                .event_index
                .get(&(event.event_id.clone(), sequence))
            else {
                env::panic_str("registration index gap at finalization");
            };
            let Some(registration) = self.registrations.get(&registration_id) else {
                env::panic_str("registration missing at finalization");
            };
            require!(
                registration.event_id == event.event_id,
                "registration index crossed an event boundary"
            );
            if registration.attendance_status == AttendanceStatus::Attended {
                attended = attended
                    .checked_add(1)
                    .unwrap_or_else(|| env::panic_str("attendee count overflow"));
            }
            sequence = sequence
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("registration sequence overflow"));
        }

        settlement.attendance_frozen = true;
        settlement.finalized_at = now;
        settlement.attendee_count = attended;
        settlement.pool = U128(0);
        settlement.base_share = U128(0);
        settlement.remainder = U128(0);
        settlement.cursor = 0;
        settlement.attendee_cursor = 0;
        settlement.allocated_count = 0;
        settlement.allocated_total = U128(0);
        settlement.complete = false;
        settlement.completed_at = 0;
        event.state = EventState::AttendanceFinalized;
        self.settlement().insert(&event.event_id, &settlement);
        self.events.insert(&event.event_id, &event);
        let no_show = event
            .total_registrations
            .saturating_sub(u64::from(attended));
        log_event(
            "EventFinalized",
            near_sdk::serde_json::json!({
                "event_id": event.event_id,
                "attendee_count": attended,
                "no_show_count": no_show,
                "total_registrations": event.total_registrations,
                "finalized_at": now,
            }),
        );
        self.event_view(&event)
    }

    /// Permissionless bounded settlement. The first call freezes allocation
    /// terms and enters SETTLING; every call allocates at most `SETTLE_CHUNK`
    /// registrations in immutable registration-sequence order from the stored
    /// cursor. Completion verifies count, sum and attendee cursor before
    /// SETTLED. A call while SETTLED is an idempotent no-op. Claims are
    /// disabled until the allocation is complete.
    pub fn settle(&mut self, event_id: String) -> SettlementView {
        let actor = env::predecessor_account_id();
        let mut event = self.event_or_panic(&event_id);
        self.schema_or_panic(&event.event_id);
        let mut settlement = self.settlement_or_panic(&event.event_id);
        if event.state == EventState::Settled {
            log_event(
                "SettlementChunk",
                near_sdk::serde_json::json!({
                    "event_id": event.event_id,
                    "cursor": settlement.cursor,
                    "total_registrations": event.total_registrations,
                    "allocated_total": settlement.allocated_total.0.to_string(),
                    "complete": true,
                    "already_settled": true,
                }),
            );
            return self.settlement_view(&event, &settlement);
        }
        if event.state == EventState::AttendanceFinalized {
            require!(settlement.attendance_frozen, "attendance is not finalized");
            let (pool, base_share, remainder) = allocation_terms(&event, &settlement);
            settlement.pool = U128(pool);
            settlement.base_share = U128(base_share);
            settlement.remainder = U128(remainder);
            settlement.cursor = 0;
            settlement.attendee_cursor = 0;
            settlement.allocated_count = 0;
            settlement.allocated_total = U128(0);
            settlement.complete = false;
            settlement.completed_at = 0;
            event.state = EventState::Settling;
            self.events.insert(&event.event_id, &event);
            log_event(
                "SettlementStarted",
                near_sdk::serde_json::json!({
                    "event_id": event.event_id,
                    "pool": pool.to_string(),
                    "base_share": base_share.to_string(),
                    "remainder": remainder.to_string(),
                    "attendee_count": settlement.attendee_count,
                    "actor": actor,
                }),
            );
        } else {
            require!(
                event.state == EventState::Settling,
                "attendance must be finalized before settlement"
            );
        }

        let chunk_end = settlement
            .cursor
            .saturating_add(SETTLE_CHUNK)
            .min(event.total_registrations);
        let mut sequence = settlement.cursor;
        let mut allocated_total = settlement.allocated_total.0;
        let mut allocated_count = settlement.allocated_count;
        let mut attendee_cursor = settlement.attendee_cursor;
        while sequence < chunk_end {
            let Some(registration_id) = self
                .event_index
                .get(&(event.event_id.clone(), sequence))
            else {
                env::panic_str("registration index gap at settlement");
            };
            let Some(mut registration) = self.registrations.get(&registration_id) else {
                env::panic_str("registration missing at settlement");
            };
            require!(
                registration.event_id == event.event_id,
                "settlement index crossed an event boundary"
            );
            let mut pass = self.pass_or_panic(&registration.pass_id);
            let mut claim = self.claim_record_or_panic(&registration_id);
            let amount = if registration.attendance_status == AttendanceStatus::Attended {
                let index = u128::from(attendee_cursor);
                let bonus = if index < settlement.remainder.0 { 1 } else { 0 };
                attendee_cursor = attendee_cursor
                    .checked_add(1)
                    .unwrap_or_else(|| env::panic_str("attendee cursor overflow"));
                event
                    .deposit
                    .0
                    .checked_add(settlement.base_share.0)
                    .and_then(|value| value.checked_add(bonus))
                    .unwrap_or_else(|| env::panic_str("settlement amount overflow"))
            } else if settlement.attendee_count == 0 {
                event.deposit.0
            } else {
                0
            };
            if amount > 0 {
                claim.amount = U128(amount);
                claim.payout_state = FinancialStatus::Claimable;
                registration.financial_status = FinancialStatus::Claimable;
                pass.financial_status = FinancialStatus::Claimable;
            } else {
                claim.amount = U128(0);
                claim.payout_state = FinancialStatus::Forfeited;
                registration.financial_status = FinancialStatus::Forfeited;
                pass.financial_status = FinancialStatus::Forfeited;
            }
            allocated_total = allocated_total
                .checked_add(amount)
                .unwrap_or_else(|| env::panic_str("allocated total overflow"));
            allocated_count = allocated_count
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("allocated count overflow"));
            self.registrations.insert(&registration_id, &registration);
            self.passes.insert(&registration.pass_id, &pass);
            self.claims().insert(&registration_id, &claim);
            sequence = sequence
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("settlement sequence overflow"));
        }

        settlement.cursor = sequence;
        settlement.attendee_cursor = attendee_cursor;
        settlement.allocated_count = allocated_count;
        settlement.allocated_total = U128(allocated_total);
        if settlement.cursor == event.total_registrations {
            require!(
                settlement.allocated_count == event.total_registrations,
                "settlement count verification failed"
            );
            require!(
                settlement.allocated_total.0 == event.accepted_principal.0,
                "settlement sum verification failed"
            );
            require!(
                settlement.attendee_count == 0
                    || settlement.attendee_cursor == settlement.attendee_count,
                "settlement attendee verification failed"
            );
            settlement.complete = true;
            settlement.completed_at = env::block_timestamp_ms();
            event.state = EventState::Settled;
            self.events.insert(&event.event_id, &event);
            log_event(
                "EventSettled",
                near_sdk::serde_json::json!({
                    "event_id": event.event_id,
                    "allocated_total": settlement.allocated_total.0.to_string(),
                    "attendee_count": settlement.attendee_count,
                    "no_show_count": event
                        .total_registrations
                        .saturating_sub(u64::from(settlement.attendee_count)),
                    "total_registrations": event.total_registrations,
                }),
            );
        } else {
            log_event(
                "SettlementChunk",
                near_sdk::serde_json::json!({
                    "event_id": event.event_id,
                    "cursor": settlement.cursor,
                    "total_registrations": event.total_registrations,
                    "allocated_total": settlement.allocated_total.0.to_string(),
                    "complete": false,
                }),
            );
        }
        self.settlement().insert(&event.event_id, &settlement);
        self.settlement_view(&event, &settlement)
    }

    // --------------------------------------- cancellation / timeout / claim

    /// D036 product policy: after a valid deposit/pass the participant cannot
    /// voluntarily cancel/refund. The route remains callable for ABI stability
    /// but traps before any state read or mutation. One lifetime registration
    /// per account/event; no rejoin exists.
    pub fn withdraw_registration(&mut self, _registration_id: String) -> ClaimView {
        env::log_str("SHOWSTAKE_REJECT reason=VOLUNTARY_WITHDRAWAL_DISABLED");
        env::panic_str(
            "voluntary withdrawal is disabled; one lifetime registration per account/event",
        );
    }

    /// Organizer cancellation before settlement starts. Allowed while the event
    /// is `Published` or `AttendanceFinalized`; denied once `Settling` so a
    /// partial allocation is never overwritten. Every registration becomes
    /// entitled to a full-principal claim. The terminal transition is O(1):
    /// entitlement is materialized lazily on `claim`.
    pub fn cancel_event(&mut self, event_id: String) -> EventView {
        let caller = env::predecessor_account_id();
        let mut event = self.event_or_panic(&event_id);
        require!(
            caller == self.config.organizer,
            "only the configured organizer may cancel"
        );
        require!(
            matches!(
                event.state,
                EventState::Published | EventState::AttendanceFinalized
            ),
            "cancellation is allowed only before settlement starts"
        );
        // Fail closed on legacy state before writing the terminal flag.
        self.schema_or_panic(&event.event_id);
        self.accounting_or_panic(&event.event_id);
        event.state = EventState::Cancelled;
        self.events.insert(&event.event_id, &event);
        let totals = self.event_totals(&event);
        log_event(
            "EventCancelled",
            near_sdk::serde_json::json!({
                "event_id": event.event_id,
                "organizer": event.organizer,
                "refunded_registrations": totals.registrations,
                "accepted_principal": totals.accepted_principal.0.to_string(),
                "paid": totals.paid.0.to_string(),
                "pending": totals.pending.0.to_string(),
                "liability": totals.liability.0.to_string(),
                "reward": "0",
            }),
        );
        self.event_view(&event)
    }

    /// Permissionless timeout refund-only activation at/after the immutable
    /// `finalize_deadline`. Finalization does not exist in this slice, so any
    /// still-`Published` event becomes REFUND_ONLY exactly once. Like
    /// cancellation, this terminal transition is O(1) and does not walk
    /// historical registrations.
    pub fn activate_timeout_refund(&mut self, event_id: String) -> EventView {
        let actor = env::predecessor_account_id();
        let mut event = self.event_or_panic(&event_id);
        require!(
            event.state == EventState::Published,
            "cannot activate refund-only from the current event state"
        );
        let now = env::block_timestamp_ms();
        require!(
            now >= event.finalize_deadline,
            "refund-only activates at/after the finalization deadline"
        );
        // Fail closed on legacy state before writing the terminal flag.
        self.schema_or_panic(&event.event_id);
        self.accounting_or_panic(&event.event_id);
        event.state = EventState::RefundOnly;
        self.events.insert(&event.event_id, &event);
        let totals = self.event_totals(&event);
        log_event(
            "RefundModeActivated",
            near_sdk::serde_json::json!({
                "event_id": event.event_id,
                "activated_by": actor,
                "finalize_deadline": event.finalize_deadline,
                "refunded_registrations": totals.registrations,
                "accepted_principal": totals.accepted_principal.0.to_string(),
                "paid": totals.paid.0.to_string(),
                "pending": totals.pending.0.to_string(),
                "liability": totals.liability.0.to_string(),
                "permissionless": true,
            }),
        );
        self.event_view(&event)
    }

    /// Claim the registration's full-principal refund. The caller must be the
    /// immutable beneficiary; the FT receiver is always that beneficiary. One
    /// payout may be pending per registration. Exactly 1 yoctoNEAR is forwarded
    /// to the canonical FT `ft_transfer`; the private callback resolves or
    /// restores the claim exactly once.
    #[payable]
    pub fn claim(&mut self, registration_id: String) -> Promise {
        require!(
            env::attached_deposit().as_yoctonear() == ONE_YOCTO,
            "claim requires exactly 1 yoctoNEAR"
        );
        require!(
            env::prepaid_gas().as_gas() >= CLAIM_MIN_PREPAID_GAS,
            "claim requires at least 100 Tgas"
        );
        let caller = env::predecessor_account_id();
        let mut registration = self.registration_or_panic(&registration_id);
        require!(
            caller == registration.beneficiary,
            "claim receiver must be the immutable beneficiary"
        );
        let mut record = self.claim_record_or_panic(&registration_id);
        let event = self.event_or_panic(&registration.event_id);
        require!(
            matches!(
                event.state,
                EventState::Cancelled | EventState::RefundOnly | EventState::Settled
            ),
            "claims are disabled until allocation completes"
        );
        match record.payout_state.clone() {
            FinancialStatus::Committed => {
                // Cancellation/refund-only is O(1) and does not rewrite every
                // historical registration. The full-D entitlement is
                // materialized here, on the first claim for this registration.
                require!(
                    terminal_event(&event.state),
                    "registration has no claimable allocation"
                );
                record.amount = event.deposit;
                record.payout_state = FinancialStatus::Claimable;
            }
            FinancialStatus::Pending => env::panic_str("claim already pending"),
            FinancialStatus::Paid => env::panic_str("claim already paid"),
            FinancialStatus::Claimable => {}
            FinancialStatus::Forfeited => {
                env::panic_str("registration has no claimable allocation (no-show)")
            }
        }
        require!(record.amount.0 > 0, "claim amount is zero");
        require!(
            effective_financial_status(&event.state, &registration.financial_status)
                == FinancialStatus::Claimable,
            "registration is not claimable"
        );
        self.schema_or_panic(&registration.event_id);
        let mut accounting = self.accounting_or_panic(&registration.event_id);
        let pending = accounting
            .pending
            .0
            .checked_add(record.amount.0)
            .unwrap_or_else(|| env::panic_str("pending total overflow"));
        accounting.pending = U128(pending);
        let mut pass = self.pass_or_panic(&registration.pass_id);
        let attempt = record
            .attempts
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("payout attempt overflow"));
        let payout_id = payout_id_for(&registration_id, attempt);

        record.attempts = attempt;
        record.pending_attempt = attempt;
        record.payout_state = FinancialStatus::Pending;
        registration.financial_status = FinancialStatus::Pending;
        pass.financial_status = FinancialStatus::Pending;
        self.registrations.insert(&registration_id, &registration);
        self.passes.insert(&registration.pass_id, &pass);
        self.claims().insert(&registration_id, &record);
        self.accounting()
            .insert(&registration.event_id, &accounting);

        log_event(
            "PayoutStarted",
            near_sdk::serde_json::json!({
                "payout_id": payout_id,
                "registration_id": registration_id,
                "event_id": registration.event_id,
                "beneficiary": registration.beneficiary,
                "amount": record.amount.0.to_string(),
            }),
        );

        let ft_args = near_sdk::serde_json::json!({
            "receiver_id": registration.beneficiary,
            "amount": record.amount,
            "memo": null,
        });
        let callback_args = near_sdk::serde_json::json!({"payout_id": payout_id});
        Promise::new(self.config.canonical_ft.clone())
            .function_call(
                "ft_transfer".to_string(),
                ft_args.to_string().into_bytes(),
                NearToken::from_yoctonear(ONE_YOCTO),
                Gas::from_gas(FT_TRANSFER_GAS),
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_payout_result".to_string(),
                    callback_args.to_string().into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_gas(PAYOUT_CALLBACK_GAS),
                ),
            )
    }

    /// Private FT payout callback. Only this contract can call it. A pending
    /// payout resolves exactly once: success moves liability to paid; failure
    /// restores the claimable liability without changing registration status. A stale or
    /// duplicate callback traps without paying twice.
    #[private]
    pub fn on_payout_result(&mut self, payout_id: String) -> PayoutView {
        require!(
            env::promise_results_count() == 1,
            "payout callback requires exactly one promise result"
        );
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(near_sdk::PromiseError::Failed) => false,
            Err(_) => env::panic_str("unexpected payout callback result"),
        };
        let (registration_id, attempt) = parse_payout_id(&payout_id)
            .unwrap_or_else(|| env::panic_str("invalid payout id"));
        require!(
            payout_id == payout_id_for(&registration_id, attempt),
            "non-canonical payout id"
        );
        let mut registration = self.registration_or_panic(&registration_id);
        let mut record = self.claim_record_or_panic(&registration_id);
        require!(
            record.payout_state == FinancialStatus::Pending
                && record.pending_attempt == attempt,
            "payout is not pending"
        );
        let amount = record.amount.0;
        self.schema_or_panic(&registration.event_id);
        let mut accounting = self.accounting_or_panic(&registration.event_id);
        accounting.pending = U128(
            accounting
                .pending
                .0
                .checked_sub(amount)
                .unwrap_or_else(|| env::panic_str("pending total underflow")),
        );
        let mut pass = self.pass_or_panic(&registration.pass_id);
        if success {
            record.payout_state = FinancialStatus::Paid;
            record.paid_amount = U128(
                record
                    .paid_amount
                    .0
                    .checked_add(amount)
                    .unwrap_or_else(|| env::panic_str("paid amount overflow")),
            );
            record.pending_attempt = 0;
            registration.financial_status = FinancialStatus::Paid;
            pass.financial_status = FinancialStatus::Paid;
            accounting.paid = U128(
                accounting
                    .paid
                    .0
                    .checked_add(amount)
                    .unwrap_or_else(|| env::panic_str("paid total overflow")),
            );
            self.escrow_principal = self
                .escrow_principal
                .checked_sub(amount)
                .unwrap_or_else(|| env::panic_str("escrow principal underflow"));
        } else {
            record.payout_state = FinancialStatus::Claimable;
            record.pending_attempt = 0;
            registration.financial_status = FinancialStatus::Claimable;
            pass.financial_status = FinancialStatus::Claimable;
        }
        self.registrations.insert(&registration_id, &registration);
        self.passes.insert(&registration.pass_id, &pass);
        self.claims().insert(&registration_id, &record);
        self.accounting()
            .insert(&registration.event_id, &accounting);
        log_event(
            if success {
                "PayoutSucceeded"
            } else {
                "PayoutFailed"
            },
            near_sdk::serde_json::json!({
                "payout_id": payout_id,
                "registration_id": registration_id,
                "event_id": registration.event_id,
                "beneficiary": registration.beneficiary,
                "amount": amount.to_string(),
            }),
        );
        self.payout_view(&payout_id, attempt, &registration, &record)
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

    /// Fixed-prefix map kept outside the root Borsh layout so the deployed
    /// `Published`/`Committed`-only state layout is not reinterpreted.
    fn claims(&self) -> LookupMap<String, ClaimRecord> {
        LookupMap::new(b"lc".to_vec())
    }

    /// Fixed-prefix per-event accounting aggregates, also outside the root
    /// Borsh layout. One fixed-size entry per event, created at publish.
    fn accounting(&self) -> LookupMap<String, EventAccounting> {
        LookupMap::new(b"ea".to_vec())
    }

    /// Fixed-prefix per-event attendance/settlement state, also outside the
    /// root Borsh layout. One fixed-size entry per event, created at publish.
    fn settlement(&self) -> LookupMap<String, SettlementState> {
        LookupMap::new(b"st".to_vec())
    }

    /// Fixed-prefix schema marker. Present only on state created by this
    /// product generation; legacy candidates fail closed instead of being
    /// upgraded in place.
    fn schema(&self) -> LookupMap<String, u32> {
        LookupMap::new(b"sv".to_vec())
    }

    /// Lifetime registration index: one accepted registration per
    /// account/event, never removed. Withdrawal is disabled in this product.
    fn lifetime(&self) -> LookupMap<(String, AccountId), String> {
        LookupMap::new(b"lr".to_vec())
    }

    fn schema_or_panic(&self, event_id: &str) -> u32 {
        let version = self.schema().get(&event_id.to_string()).unwrap_or_else(|| {
            env::panic_str(
                "schema marker missing; clean lifecycle instance or explicit migration required",
            )
        });
        require!(
            version == SCHEMA_VERSION,
            "unsupported lifecycle schema; clean instance required"
        );
        version
    }

    fn accounting_or_panic(&self, event_id: &str) -> EventAccounting {
        self.accounting().get(&event_id.to_string()).unwrap_or_else(|| {
            env::panic_str(
                "event accounting missing; clean lifecycle instance or explicit migration required",
            )
        })
    }

    fn settlement_or_panic(&self, event_id: &str) -> SettlementState {
        self.settlement().get(&event_id.to_string()).unwrap_or_else(|| {
            env::panic_str(
                "settlement state missing; clean lifecycle instance or explicit migration required",
            )
        })
    }

    /// Read-only view helper: legacy state without a settlement entry simply
    /// has no frozen attendance, so views stay readable.
    fn attendance_frozen_or_default(&self, event_id: &str) -> bool {
        self.settlement()
            .get(&event_id.to_string())
            .map(|settlement| settlement.attendance_frozen)
            .unwrap_or(false)
    }

    fn claim_record_or_panic(&self, registration_id: &str) -> ClaimRecord {
        self.claims()
            .get(&registration_id.to_string())
            .unwrap_or_else(|| {
                env::panic_str(
                    "claim record missing; clean lifecycle instance or explicit migration required",
                )
            })
    }

    fn claim_view(
        &self,
        registration: &Registration,
        record: &ClaimRecord,
        event: &Event,
    ) -> ClaimView {
        // Terminal cancellation/refund-only does not rewrite historical claim
        // records; the full-D entitlement is derived until first claim.
        let (amount, payout_state) = if record.payout_state == FinancialStatus::Committed
            && terminal_event(&event.state)
        {
            (event.deposit, FinancialStatus::Claimable)
        } else {
            (record.amount, record.payout_state.clone())
        };
        let pending_payout_id =
            if payout_state == FinancialStatus::Pending && record.pending_attempt > 0 {
                Some(payout_id_for(
                    &registration.registration_id,
                    record.pending_attempt,
                ))
            } else {
                None
            };
        ClaimView {
            registration_id: registration.registration_id.clone(),
            event_id: registration.event_id.clone(),
            beneficiary: registration.beneficiary.clone(),
            amount,
            payout_state,
            pending_payout_id,
            paid_amount: record.paid_amount,
            withdrawn_at: record.withdrawn_at,
        }
    }

    fn payout_view(
        &self,
        payout_id: &str,
        attempt: u32,
        registration: &Registration,
        record: &ClaimRecord,
    ) -> PayoutView {
        let state = if record.payout_state == FinancialStatus::Pending
            && record.pending_attempt == attempt
        {
            PayoutState::Pending
        } else if record.payout_state == FinancialStatus::Paid && record.attempts == attempt {
            PayoutState::Succeeded
        } else if record.payout_state == FinancialStatus::Claimable && record.attempts == attempt {
            PayoutState::Failed
        } else {
            env::panic_str("payout not found or stale")
        };
        PayoutView {
            payout_id: payout_id.to_string(),
            registration_id: registration.registration_id.clone(),
            event_id: registration.event_id.clone(),
            beneficiary: registration.beneficiary.clone(),
            amount: record.amount,
            state,
            attempt,
        }
    }

    /// O(1) totals from the per-event accounting entry. Cancellation, timeout
    /// activation and this view never walk registrations, so the capacity-200
    /// registration set cannot exhaust gas.
    fn event_totals(&self, event: &Event) -> EventTotalsView {
        self.schema_or_panic(&event.event_id);
        let accounting = self.accounting_or_panic(&event.event_id);
        let accepted = event.accepted_principal.0;
        let paid = accounting.paid.0;
        let pending = accounting.pending.0;
        let settled = paid
            .checked_add(pending)
            .unwrap_or_else(|| env::panic_str("settled total overflow"));
        require!(settled <= accepted, "event totals exceed accepted principal");
        let withdrawn = event
            .total_registrations
            .saturating_sub(u64::from(event.active_registrations));
        EventTotalsView {
            event_id: event.event_id.clone(),
            state: event.state.clone(),
            registrations: event.total_registrations,
            active_registrations: event.active_registrations,
            withdrawn_registrations: withdrawn,
            accepted_principal: event.accepted_principal,
            paid: U128(paid),
            pending: U128(pending),
            liability: U128(accepted - settled),
        }
    }

    /// O(1) attendance/settlement view derived from the frozen entry.
    fn settlement_view(&self, event: &Event, settlement: &SettlementState) -> SettlementView {
        let no_show = event
            .total_registrations
            .saturating_sub(u64::from(settlement.attendee_count));
        SettlementView {
            event_id: event.event_id.clone(),
            state: event.state.clone(),
            attendance_frozen: settlement.attendance_frozen,
            attendee_count: settlement.attendee_count,
            no_show_count: no_show,
            registrations: event.total_registrations,
            pool: settlement.pool,
            base_share: settlement.base_share,
            remainder: settlement.remainder,
            cursor: settlement.cursor,
            allocated_count: settlement.allocated_count,
            allocated_total: settlement.allocated_total,
            complete: settlement.complete,
            claims_enabled: matches!(
                event.state,
                EventState::Cancelled | EventState::RefundOnly | EventState::Settled
            ),
            finalized_at: settlement.finalized_at,
            completed_at: settlement.completed_at,
        }
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
            withdrawn_registrations: event
                .total_registrations
                .saturating_sub(u64::from(event.active_registrations)),
            accepted_principal: event.accepted_principal,
            created_at: event.created_at,
        }
    }
}

fn event_phase(event: &Event, now: u64) -> EventPhase {
    match event.state {
        EventState::Cancelled => EventPhase::Cancelled,
        EventState::RefundOnly => EventPhase::RefundOnly,
        EventState::AttendanceFinalized => EventPhase::AttendanceFinalized,
        EventState::Settling => EventPhase::Settling,
        EventState::Settled => EventPhase::Settled,
        EventState::Published => {
            if now < event.reg_open {
                EventPhase::Scheduled
            } else if now < event.reg_close {
                EventPhase::RegistrationOpen
            } else {
                EventPhase::RegistrationClosed
            }
        }
    }
}

/// Frozen allocation terms. `A > 0`: only no-show principal is pooled
/// (`M*D`), split evenly with the remainder to the earliest attendees.
/// `A == 0`: every registration is refunded its own `D` (pool is unused).
fn allocation_terms(event: &Event, settlement: &SettlementState) -> (u128, u128, u128) {
    let attendees = u128::from(settlement.attendee_count);
    if attendees == 0 {
        return (0, 0, 0);
    }
    let registrations = u128::from(event.total_registrations);
    let no_shows = registrations
        .checked_sub(attendees)
        .unwrap_or_else(|| env::panic_str("attendee count exceeds registrations"));
    let pool = no_shows
        .checked_mul(event.deposit.0)
        .unwrap_or_else(|| env::panic_str("settlement pool overflow"));
    (pool, pool / attendees, pool % attendees)
}

fn effective_attendance(
    stored: &AttendanceStatus,
    attendance_frozen: bool,
) -> AttendanceStatus {
    if attendance_frozen && *stored == AttendanceStatus::NotMarked {
        AttendanceStatus::NoShow
    } else {
        stored.clone()
    }
}

fn payout_id_for(registration_id: &str, attempt: u32) -> String {
    format!("pay-{registration_id}-{attempt}")
}

fn parse_payout_id(payout_id: &str) -> Option<(String, u32)> {
    let rest = payout_id.strip_prefix("pay-")?;
    let (registration_id, attempt) = rest.rsplit_once('-')?;
    let attempt: u32 = attempt.parse().ok()?;
    if registration_id.is_empty() || attempt == 0 {
        return None;
    }
    Some((registration_id.to_string(), attempt))
}

fn terminal_event(state: &EventState) -> bool {
    matches!(state, EventState::Cancelled | EventState::RefundOnly)
}

/// Stored `Committed` becomes an effective `Claimable` once the event is
/// terminal. Cancellation/refund-only does not rewrite historical records;
/// views and `claim` derive the entitlement from the event state.
fn effective_financial_status(
    state: &EventState,
    stored: &FinancialStatus,
) -> FinancialStatus {
    if *stored == FinancialStatus::Committed && terminal_event(state) {
        FinancialStatus::Claimable
    } else {
        stored.clone()
    }
}

fn registration_view(
    registration: &Registration,
    event: &Event,
    attendance_frozen: bool,
) -> RegistrationView {
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
        attendance_status: effective_attendance(
            &registration.attendance_status,
            attendance_frozen,
        ),
        financial_status: effective_financial_status(
            &event.state,
            &registration.financial_status,
        ),
        registered_at: registration.registered_at,
    }
}

fn pass_view(pass: &Pass, event: &Event, attendance_frozen: bool) -> PassView {
    PassView {
        pass_id: pass.pass_id.clone(),
        event_id: pass.event_id.clone(),
        registration_id: pass.registration_id.clone(),
        owner: pass.owner.clone(),
        issued_at: pass.issued_at,
        registration_status: pass.registration_status.clone(),
        attendance_status: effective_attendance(&pass.attendance_status, attendance_frozen),
        financial_status: effective_financial_status(&event.state, &pass.financial_status),
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
