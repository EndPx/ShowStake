//! Native-USDC EventEscrow candidate, deliberately independent of Rhea/Earn.
//!
//! This is a local schema/state-machine candidate for the core ShowStake
//! lifecycle. It accepts only the configured native NEP-141 asset, binds the
//! beneficiary and custom account-bound pass to the sender. The primary
//! candidate requires a verified Earn supply/redeem adapter before settlement;
//! the accepted v6 `Contract` remains unchanged until this ABI/storage schema
//! is reviewed.

use std::collections::BTreeMap;

/// Circle's official NEAR testnet link resolves to this NEP-141 account. The
/// account was extracted from Circle's Testnet Address link (nearblocks target)
/// on 2026-11-10; it is recorded here for testnet planning only, not deployment.
pub const NATIVE_USDC_TESTNET_ACCOUNT: &str =
    "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
pub const NATIVE_USDC_DECIMALS: u8 = 6;
pub const CIRCLE_NATIVE_USDC_SOURCE: &str = "https://www.circle.com/multi-chain-usdc/near";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeUsdcConfig {
    pub network: String,
    pub canonical_ft: String,
    pub decimals: u8,
    pub source: String,
}

impl NativeUsdcConfig {
    pub fn testnet_candidate() -> Self {
        Self {
            network: "near-testnet".into(),
            canonical_ft: NATIVE_USDC_TESTNET_ACCOUNT.into(),
            decimals: NATIVE_USDC_DECIMALS,
            source: CIRCLE_NATIVE_USDC_SOURCE.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EarnProviderGate {
    pub provider_name: String,
    pub network: String,
    pub account: Option<String>,
    pub code_hash: Option<String>,
    pub abi_revision: Option<String>,
    pub verified: bool,
}

impl EarnProviderGate {
    /// Read-only evidence candidate. The account and code hash are recorded
    /// from coordinator RPC evidence, but `verified` stays false until exact
    /// supply/redeem ABI, callback, liquidity and redemption proof exist.
    pub fn rhea_readonly_candidate() -> Self {
        Self {
            provider_name: "Rhea USDC Earn (read-only candidate)".into(),
            network: "near-mainnet".into(),
            account: Some("contract.main.burrow.near".into()),
            code_hash: Some("6Nek1M8cwJJ2xMQAUWup9V5AToYS9rkTxJfwo6BCpFa".into()),
            abi_revision: None,
            verified: false,
        }
    }

    pub fn local_mock() -> Self {
        Self {
            provider_name: "Rhea USDC Earn (mock ABI)".into(),
            network: "near-testnet".into(),
            account: Some("rhea.mock".into()),
            code_hash: Some("sha256:mock".into()),
            abi_revision: Some("earn-v1".into()),
            verified: true,
        }
    }
    fn usable(&self) -> bool {
        self.verified
            && self.account.as_ref().is_some_and(|v| !v.is_empty())
            && self.code_hash.as_ref().is_some_and(|v| !v.is_empty())
            && self.abi_revision.as_ref().is_some_and(|v| !v.is_empty())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EarnState {
    NotStarted,
    SupplyPending,
    Supplied,
    RedeemPending,
    Redeemed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EarnCall {
    pub provider_account: String,
    pub action: &'static str,
    pub amount: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EarnCallback {
    Supply {
        event_id: String,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    },
    Redeem {
        event_id: String,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    },
}

pub trait EarnAdapter {
    fn supply(
        &mut self,
        gate: &EarnProviderGate,
        event_id: &str,
        amount: u128,
    ) -> Result<EarnCall, EscrowError>;
    fn redeem(
        &mut self,
        gate: &EarnProviderGate,
        event_id: &str,
        amount: u128,
    ) -> Result<EarnCall, EscrowError>;
}

#[derive(Default)]
pub struct MockEarnAdapter {
    calls: Vec<EarnCall>,
    callbacks: Vec<EarnCallback>,
}

impl MockEarnAdapter {
    pub fn calls(&self) -> &[EarnCall] {
        &self.calls
    }
    pub fn queue_callback(&mut self, callback: EarnCallback) {
        self.callbacks.push(callback);
    }
    pub fn next_callback(&mut self) -> Option<EarnCallback> {
        if self.callbacks.is_empty() {
            None
        } else {
            Some(self.callbacks.remove(0))
        }
    }
}

impl EarnAdapter for MockEarnAdapter {
    fn supply(
        &mut self,
        gate: &EarnProviderGate,
        _event_id: &str,
        amount: u128,
    ) -> Result<EarnCall, EscrowError> {
        if !gate.usable() {
            return Err(EscrowError::EarnUnavailable);
        }
        let call = EarnCall {
            provider_account: gate.account.clone().expect("usable"),
            action: "supply_usdc",
            amount,
        };
        self.calls.push(call.clone());
        Ok(call)
    }
    fn redeem(
        &mut self,
        gate: &EarnProviderGate,
        _event_id: &str,
        amount: u128,
    ) -> Result<EarnCall, EscrowError> {
        if !gate.usable() {
            return Err(EscrowError::EarnUnavailable);
        }
        let call = EarnCall {
            provider_account: gate.account.clone().expect("usable"),
            action: "redeem_usdc",
            amount,
        };
        self.calls.push(call.clone());
        Ok(call)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventPhase {
    RegistrationOpen,
    RegistrationClosed,
    AttendanceFinalized,
    Settled,
    Cancelled,
    RefundOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistrationStatus {
    Active,
    NoShow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimState {
    None,
    Claimable,
    Pending,
    Paid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attendance {
    Unmarked,
    Attended,
    NoShow,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub registration_id: String,
    pub pass_id: String,
    pub participant: String,
    pub beneficiary: String,
    pub commitment_id: String,
    pub amount: u128,
    pub sequence: u64,
    pub status: RegistrationStatus,
    pub attendance: Attendance,
    pub claim: ClaimState,
    pub claim_amount: u128,
    pub claim_attempt: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowEvent {
    pub event_id: String,
    pub organizer: String,
    pub deposit: u128,
    pub capacity: u32,
    pub reg_open: u64,
    pub reg_close: u64,
    pub checkin_open: u64,
    pub checkin_close: u64,
    pub finalize_deadline: u64,
    pub phase: EventPhase,
    pub earn_state: EarnState,
    pub earn_attempt: u64,
    pub accepted_principal: u128,
    pub redeemed_amount: u128,
    pub realized_yield: u128,
    pub yield_distributed: u128,
    pub paid: u128,
    pub pending: u128,
    pub registrations: BTreeMap<String, Registration>,
    pub used_commitments: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistrationReceipt {
    pub registration_id: String,
    pub pass_id: String,
    pub owner: String,
    pub amount: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FtTransferOutcome {
    Accepted(RegistrationReceipt),
    Refunded { amount: u128, reason: RejectReason },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectReason {
    WrongToken,
    WrongAmount,
    WrongPhase,
    Capacity,
    DuplicateCommitment,
    ActiveRegistration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowError {
    EventMissing,
    Unauthorized,
    InvalidTimes,
    InvalidAmount,
    EventExists,
    WrongPhase,
    TooEarly,
    TooLate,
    RegistrationMissing,
    WrongBeneficiary,
    AlreadyClaiming,
    StaleAttempt,
    AmountMismatch,
    PassNotTransferable,
    EarnUnavailable,
    EarnMustRedeemFirst,
}

#[derive(Default)]
pub struct EventEscrowCandidate {
    config: Option<NativeUsdcConfig>,
    earn_provider: Option<EarnProviderGate>,
    events: BTreeMap<String, EscrowEvent>,
    next_registration: u64,
}

impl EventEscrowCandidate {
    pub fn new(config: NativeUsdcConfig) -> Self {
        Self {
            config: Some(config),
            earn_provider: None,
            events: BTreeMap::new(),
            next_registration: 0,
        }
    }

    pub fn config(&self) -> Option<&NativeUsdcConfig> {
        self.config.as_ref()
    }

    pub fn set_earn_provider(&mut self, gate: EarnProviderGate) {
        self.earn_provider = Some(gate);
    }

    pub fn publish_event(
        &mut self,
        event_id: impl Into<String>,
        organizer: impl Into<String>,
        deposit: u128,
        capacity: u32,
        reg_open: u64,
        reg_close: u64,
        checkin_open: u64,
        checkin_close: u64,
    ) -> Result<(), EscrowError> {
        let event_id = event_id.into();
        if self.events.contains_key(&event_id) {
            return Err(EscrowError::EventExists);
        }
        if deposit == 0 || capacity == 0 || capacity > 200 {
            return Err(EscrowError::InvalidAmount);
        }
        if !(reg_open < reg_close && reg_close <= checkin_open && checkin_open < checkin_close) {
            return Err(EscrowError::InvalidTimes);
        }
        self.events.insert(
            event_id.clone(),
            EscrowEvent {
                event_id,
                organizer: organizer.into(),
                deposit,
                capacity,
                reg_open,
                reg_close,
                checkin_open,
                checkin_close,
                finalize_deadline: checkin_close + 86_400_000,
                phase: EventPhase::RegistrationOpen,
                earn_state: EarnState::NotStarted,
                earn_attempt: 0,
                accepted_principal: 0,
                redeemed_amount: 0,
                realized_yield: 0,
                yield_distributed: 0,
                paid: 0,
                pending: 0,
                registrations: BTreeMap::new(),
                used_commitments: BTreeMap::new(),
            },
        );
        Ok(())
    }

    /// Core NEP-141 receiver boundary. The caller must pass the predecessor FT
    /// account; a wrong token or any invalid payment is fully refunded.
    pub fn ft_on_transfer(
        &mut self,
        token_contract: &str,
        sender: &str,
        event_id: &str,
        commitment_id: &str,
        amount: u128,
        now_ms: u64,
    ) -> Result<FtTransferOutcome, EscrowError> {
        let canonical = &self
            .config
            .as_ref()
            .ok_or(EscrowError::WrongPhase)?
            .canonical_ft;
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        let reject = |reason| Ok(FtTransferOutcome::Refunded { amount, reason });
        if token_contract != canonical {
            return reject(RejectReason::WrongToken);
        }
        if amount != event.deposit {
            return reject(RejectReason::WrongAmount);
        }
        if event.phase != EventPhase::RegistrationOpen
            || now_ms < event.reg_open
            || now_ms >= event.reg_close
        {
            return reject(RejectReason::WrongPhase);
        }
        if event.registrations.len() >= event.capacity as usize {
            return reject(RejectReason::Capacity);
        }
        if event.used_commitments.contains_key(commitment_id) {
            return reject(RejectReason::DuplicateCommitment);
        }
        if event
            .registrations
            .values()
            .any(|r| r.participant == sender && r.status == RegistrationStatus::Active)
        {
            return reject(RejectReason::ActiveRegistration);
        }
        let sequence = event.registrations.len() as u64;
        let registration_id = format!("{}-reg-{}", event_id, self.next_registration);
        self.next_registration = self
            .next_registration
            .checked_add(1)
            .ok_or(EscrowError::InvalidAmount)?;
        let pass_id = format!("{}-pass-{}", event_id, sequence);
        event
            .used_commitments
            .insert(commitment_id.into(), registration_id.clone());
        event.registrations.insert(
            registration_id.clone(),
            Registration {
                registration_id: registration_id.clone(),
                pass_id: pass_id.clone(),
                participant: sender.into(),
                beneficiary: sender.into(),
                commitment_id: commitment_id.into(),
                amount,
                sequence,
                status: RegistrationStatus::Active,
                attendance: Attendance::Unmarked,
                claim: ClaimState::None,
                claim_amount: 0,
                claim_attempt: 0,
            },
        );
        event.accepted_principal = event
            .accepted_principal
            .checked_add(amount)
            .ok_or(EscrowError::InvalidAmount)?;
        Ok(FtTransferOutcome::Accepted(RegistrationReceipt {
            registration_id,
            pass_id,
            owner: sender.into(),
            amount,
        }))
    }

    pub fn close_registration(&mut self, event_id: &str, now_ms: u64) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.phase != EventPhase::RegistrationOpen || now_ms < event.reg_close {
            return Err(EscrowError::WrongPhase);
        }
        event.phase = EventPhase::RegistrationClosed;
        Ok(())
    }

    pub fn trigger_earn_supply<A: EarnAdapter>(
        &mut self,
        event_id: &str,
        now_ms: u64,
        adapter: &mut A,
    ) -> Result<EarnCall, EscrowError> {
        let gate = self
            .earn_provider
            .as_ref()
            .filter(|g| g.usable())
            .ok_or(EscrowError::EarnUnavailable)?
            .clone();
        let event = self.events.get(event_id).ok_or(EscrowError::EventMissing)?;
        if event.phase != EventPhase::RegistrationClosed
            || now_ms < event.reg_close
            || event.earn_state != EarnState::NotStarted
        {
            return Err(EscrowError::WrongPhase);
        }
        if event.accepted_principal == 0 {
            return Err(EscrowError::InvalidAmount);
        }
        let call = adapter.supply(&gate, event_id, event.accepted_principal)?;
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        event.earn_attempt = event
            .earn_attempt
            .checked_add(1)
            .ok_or(EscrowError::InvalidAmount)?;
        event.earn_state = EarnState::SupplyPending;
        Ok(call)
    }

    pub fn on_earn_supply_result(
        &mut self,
        event_id: &str,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    ) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.earn_state != EarnState::SupplyPending || event.earn_attempt != attempt {
            return Err(EscrowError::StaleAttempt);
        }
        if amount != event.accepted_principal {
            return Err(EscrowError::AmountMismatch);
        }
        event.earn_state = if succeeded {
            EarnState::Supplied
        } else {
            EarnState::NotStarted
        };
        Ok(())
    }

    pub fn trigger_earn_redeem<A: EarnAdapter>(
        &mut self,
        event_id: &str,
        now_ms: u64,
        adapter: &mut A,
    ) -> Result<EarnCall, EscrowError> {
        let gate = self
            .earn_provider
            .as_ref()
            .filter(|g| g.usable())
            .ok_or(EscrowError::EarnUnavailable)?
            .clone();
        let event = self.events.get(event_id).ok_or(EscrowError::EventMissing)?;
        if event.earn_state != EarnState::Supplied || now_ms < event.checkin_close {
            return Err(EscrowError::WrongPhase);
        }
        let call = adapter.redeem(&gate, event_id, event.accepted_principal)?;
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        event.earn_attempt = event
            .earn_attempt
            .checked_add(1)
            .ok_or(EscrowError::InvalidAmount)?;
        event.earn_state = EarnState::RedeemPending;
        Ok(call)
    }

    pub fn on_earn_redeem_result(
        &mut self,
        event_id: &str,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    ) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.earn_state != EarnState::RedeemPending || event.earn_attempt != attempt {
            return Err(EscrowError::StaleAttempt);
        }
        if succeeded {
            if amount < event.accepted_principal {
                return Err(EscrowError::AmountMismatch);
            }
            event.redeemed_amount = amount;
            event.realized_yield = amount - event.accepted_principal;
            event.yield_distributed = 0;
            event.earn_state = EarnState::Redeemed;
        } else {
            event.earn_state = EarnState::Supplied;
        }
        Ok(())
    }

    pub fn apply_earn_callback(&mut self, callback: EarnCallback) -> Result<(), EscrowError> {
        match callback {
            EarnCallback::Supply {
                event_id,
                attempt,
                succeeded,
                amount,
            } => self.on_earn_supply_result(&event_id, attempt, succeeded, amount),
            EarnCallback::Redeem {
                event_id,
                attempt,
                succeeded,
                amount,
            } => self.on_earn_redeem_result(&event_id, attempt, succeeded, amount),
        }
    }

    pub fn mark_attendance(
        &mut self,
        event_id: &str,
        organizer: &str,
        registration_id: &str,
        attended: bool,
        now_ms: u64,
    ) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.organizer != organizer {
            return Err(EscrowError::Unauthorized);
        }
        if !matches!(
            event.phase,
            EventPhase::RegistrationOpen | EventPhase::RegistrationClosed
        ) || now_ms < event.checkin_open
            || now_ms >= event.checkin_close
        {
            return Err(EscrowError::WrongPhase);
        }
        let registration = event
            .registrations
            .get_mut(registration_id)
            .ok_or(EscrowError::RegistrationMissing)?;
        registration.attendance = if attended {
            Attendance::Attended
        } else {
            Attendance::Unmarked
        };
        Ok(())
    }

    pub fn finalize_attendance(
        &mut self,
        event_id: &str,
        organizer: &str,
        now_ms: u64,
    ) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.organizer != organizer {
            return Err(EscrowError::Unauthorized);
        }
        if !matches!(
            event.phase,
            EventPhase::RegistrationOpen | EventPhase::RegistrationClosed
        ) || now_ms < event.checkin_close
            || now_ms >= event.finalize_deadline
        {
            return Err(EscrowError::WrongPhase);
        }
        if event.earn_state != EarnState::Supplied {
            return Err(EscrowError::WrongPhase);
        }
        for registration in event.registrations.values_mut() {
            if registration.attendance == Attendance::Unmarked {
                registration.attendance = Attendance::NoShow;
                registration.status = RegistrationStatus::NoShow;
            }
            registration.claim = ClaimState::Claimable;
        }
        event.phase = EventPhase::AttendanceFinalized;
        Ok(())
    }

    pub fn cancel_event(&mut self, event_id: &str, organizer: &str) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.organizer != organizer {
            return Err(EscrowError::Unauthorized);
        }
        if !matches!(
            event.phase,
            EventPhase::RegistrationOpen | EventPhase::RegistrationClosed
        ) {
            return Err(EscrowError::WrongPhase);
        }
        if matches!(
            event.earn_state,
            EarnState::SupplyPending | EarnState::Supplied | EarnState::RedeemPending
        ) {
            return Err(EscrowError::EarnMustRedeemFirst);
        }
        let count = event.registrations.len() as u128;
        let yield_base = if event.earn_state == EarnState::Redeemed {
            event.realized_yield / count
        } else {
            0
        };
        let yield_remainder = if event.earn_state == EarnState::Redeemed {
            event.realized_yield % count
        } else {
            0
        };
        for registration in event.registrations.values_mut() {
            registration.claim = ClaimState::Claimable;
            let extra = if registration.sequence < yield_remainder as u64 {
                1
            } else {
                0
            };
            registration.claim_amount = event.deposit + yield_base + extra;
        }
        event.yield_distributed = if event.earn_state == EarnState::Redeemed {
            event.realized_yield
        } else {
            0
        };
        event.phase = EventPhase::Cancelled;
        Ok(())
    }

    pub fn activate_timeout_refund(
        &mut self,
        event_id: &str,
        now_ms: u64,
    ) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if !matches!(
            event.phase,
            EventPhase::RegistrationOpen | EventPhase::RegistrationClosed
        ) || now_ms < event.finalize_deadline
        {
            return Err(EscrowError::WrongPhase);
        }
        if matches!(
            event.earn_state,
            EarnState::SupplyPending | EarnState::Supplied | EarnState::RedeemPending
        ) {
            return Err(EscrowError::EarnMustRedeemFirst);
        }
        let count = event.registrations.len() as u128;
        let yield_base = if event.earn_state == EarnState::Redeemed {
            event.realized_yield / count
        } else {
            0
        };
        let yield_remainder = if event.earn_state == EarnState::Redeemed {
            event.realized_yield % count
        } else {
            0
        };
        for registration in event.registrations.values_mut() {
            registration.claim = ClaimState::Claimable;
            let extra = if registration.sequence < yield_remainder as u64 {
                1
            } else {
                0
            };
            registration.claim_amount = event.deposit + yield_base + extra;
        }
        event.yield_distributed = if event.earn_state == EarnState::Redeemed {
            event.realized_yield
        } else {
            0
        };
        event.phase = EventPhase::RefundOnly;
        Ok(())
    }

    pub fn settle(&mut self, event_id: &str) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        if event.phase != EventPhase::AttendanceFinalized {
            return Err(EscrowError::WrongPhase);
        }
        if event.earn_state != EarnState::Redeemed {
            return Err(EscrowError::WrongPhase);
        }
        let attendees: Vec<String> = event
            .registrations
            .values()
            .filter(|r| r.attendance == Attendance::Attended)
            .map(|r| r.registration_id.clone())
            .collect();
        let no_show_pool = event
            .deposit
            .checked_mul(
                event
                    .registrations
                    .values()
                    .filter(|r| r.attendance == Attendance::NoShow)
                    .count() as u128,
            )
            .ok_or(EscrowError::InvalidAmount)?;
        if attendees.is_empty() {
            let registration_count = event.registrations.len() as u128;
            let yield_base = event.realized_yield / registration_count;
            let yield_remainder = event.realized_yield % registration_count;
            for registration in event.registrations.values_mut() {
                let extra = if registration.sequence < yield_remainder as u64 {
                    1
                } else {
                    0
                };
                registration.claim_amount = event.deposit + yield_base + extra;
            }
        } else {
            let reward_pool = no_show_pool
                .checked_add(event.realized_yield)
                .ok_or(EscrowError::InvalidAmount)?;
            let base = reward_pool / attendees.len() as u128;
            let remainder = reward_pool % attendees.len() as u128;
            for registration in event.registrations.values_mut() {
                if registration.attendance == Attendance::Attended {
                    let extra = if registration.sequence < remainder as u64 {
                        1
                    } else {
                        0
                    };
                    registration.claim_amount = event.deposit + base + extra;
                }
            }
        }
        event.yield_distributed = event.realized_yield;
        event.phase = EventPhase::Settled;
        Ok(())
    }

    pub fn start_claim(
        &mut self,
        event_id: &str,
        registration_id: &str,
        caller: &str,
    ) -> Result<u128, EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        let registration = event
            .registrations
            .get_mut(registration_id)
            .ok_or(EscrowError::RegistrationMissing)?;
        if registration.beneficiary != caller {
            return Err(EscrowError::WrongBeneficiary);
        }
        let claim_phase_allowed = match event.phase {
            EventPhase::Settled => event.earn_state == EarnState::Redeemed,
            EventPhase::Cancelled | EventPhase::RefundOnly => !matches!(
                event.earn_state,
                EarnState::Supplied | EarnState::RedeemPending
            ),
            _ => false,
        };
        if !claim_phase_allowed || registration.claim != ClaimState::Claimable {
            return Err(EscrowError::WrongPhase);
        }
        registration.claim_attempt = registration
            .claim_attempt
            .checked_add(1)
            .ok_or(EscrowError::InvalidAmount)?;
        registration.claim = ClaimState::Pending;
        event.pending = event
            .pending
            .checked_add(registration.claim_amount)
            .ok_or(EscrowError::InvalidAmount)?;
        Ok(registration.claim_amount)
    }

    pub fn on_claim_result(
        &mut self,
        event_id: &str,
        registration_id: &str,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    ) -> Result<(), EscrowError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(EscrowError::EventMissing)?;
        let registration = event
            .registrations
            .get_mut(registration_id)
            .ok_or(EscrowError::RegistrationMissing)?;
        if registration.claim != ClaimState::Pending || registration.claim_attempt != attempt {
            return Err(EscrowError::StaleAttempt);
        }
        if amount != registration.claim_amount {
            return Err(EscrowError::AmountMismatch);
        }
        event.pending = event
            .pending
            .checked_sub(amount)
            .ok_or(EscrowError::AmountMismatch)?;
        if succeeded {
            registration.claim = ClaimState::Paid;
            event.paid = event
                .paid
                .checked_add(amount)
                .ok_or(EscrowError::InvalidAmount)?;
        } else {
            registration.claim = ClaimState::Claimable;
        }
        Ok(())
    }

    pub fn reject_pass_transfer(&self) -> Result<(), EscrowError> {
        Err(EscrowError::PassNotTransferable)
    }

    pub fn conservation_holds(&self, event_id: &str) -> Result<bool, EscrowError> {
        let event = self.events.get(event_id).ok_or(EscrowError::EventMissing)?;
        let claimable = event
            .registrations
            .values()
            .filter(|r| r.claim == ClaimState::Claimable)
            .try_fold(0u128, |sum, r| sum.checked_add(r.claim_amount))
            .ok_or(EscrowError::InvalidAmount)?;
        let covered = event
            .paid
            .checked_add(event.pending)
            .and_then(|v| v.checked_add(claimable))
            .ok_or(EscrowError::InvalidAmount)?;
        Ok(covered == event.accepted_principal + event.yield_distributed)
    }

    pub fn event(&self, event_id: &str) -> Result<&EscrowEvent, EscrowError> {
        self.events.get(event_id).ok_or(EscrowError::EventMissing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn escrow() -> EventEscrowCandidate {
        let mut e = EventEscrowCandidate::new(NativeUsdcConfig::testnet_candidate());
        e.set_earn_provider(EarnProviderGate::local_mock());
        e.publish_event("event-a", "host", 10, 10, 10, 20, 20, 30)
            .unwrap();
        e
    }

    #[test]
    fn native_asset_and_exact_deposit_create_one_pass() {
        let mut e = escrow();
        let result = e
            .ft_on_transfer(
                NATIVE_USDC_TESTNET_ACCOUNT,
                "alice",
                "event-a",
                "c1",
                10,
                10,
            )
            .unwrap();
        assert!(matches!(result, FtTransferOutcome::Accepted(_)));
        let r = &e.event("event-a").unwrap().registrations["event-a-reg-0"];
        assert_eq!(r.participant, "alice");
        assert_eq!(r.beneficiary, "alice");
        assert_eq!(r.pass_id, "event-a-pass-0");
    }

    #[test]
    fn registration_close_is_explicit_and_closes_deposits() {
        let mut e = escrow();
        assert_eq!(
            e.close_registration("event-a", 19),
            Err(EscrowError::WrongPhase)
        );
        e.close_registration("event-a", 20).unwrap();
        assert_eq!(
            e.event("event-a").unwrap().phase,
            EventPhase::RegistrationClosed
        );
        assert!(matches!(
            e.ft_on_transfer(
                NATIVE_USDC_TESTNET_ACCOUNT,
                "alice",
                "event-a",
                "late",
                10,
                20
            )
            .unwrap(),
            FtTransferOutcome::Refunded {
                reason: RejectReason::WrongPhase,
                ..
            }
        ));
    }

    #[test]
    fn wrong_token_amount_duplicate_and_active_are_refunded() {
        let mut e = escrow();
        assert!(matches!(
            e.ft_on_transfer("fake.usdc", "alice", "event-a", "c1", 10, 10)
                .unwrap(),
            FtTransferOutcome::Refunded {
                reason: RejectReason::WrongToken,
                ..
            }
        ));
        assert!(matches!(
            e.ft_on_transfer(NATIVE_USDC_TESTNET_ACCOUNT, "alice", "event-a", "c1", 9, 10)
                .unwrap(),
            FtTransferOutcome::Refunded {
                reason: RejectReason::WrongAmount,
                ..
            }
        ));
        e.ft_on_transfer(
            NATIVE_USDC_TESTNET_ACCOUNT,
            "alice",
            "event-a",
            "c1",
            10,
            10,
        )
        .unwrap();
        assert!(matches!(
            e.ft_on_transfer(NATIVE_USDC_TESTNET_ACCOUNT, "bob", "event-a", "c1", 10, 11)
                .unwrap(),
            FtTransferOutcome::Refunded {
                reason: RejectReason::DuplicateCommitment,
                ..
            }
        ));
        assert!(matches!(
            e.ft_on_transfer(
                NATIVE_USDC_TESTNET_ACCOUNT,
                "alice",
                "event-a",
                "c2",
                10,
                11
            )
            .unwrap(),
            FtTransferOutcome::Refunded {
                reason: RejectReason::ActiveRegistration,
                ..
            }
        ));
    }

    #[test]
    fn event_balances_and_passes_are_isolated() {
        let mut e = escrow();
        e.publish_event("event-b", "host", 20, 10, 10, 20, 20, 30)
            .unwrap();
        e.ft_on_transfer(
            NATIVE_USDC_TESTNET_ACCOUNT,
            "alice",
            "event-a",
            "a1",
            10,
            10,
        )
        .unwrap();
        e.ft_on_transfer(
            NATIVE_USDC_TESTNET_ACCOUNT,
            "alice",
            "event-b",
            "b1",
            20,
            10,
        )
        .unwrap();
        assert_eq!(e.event("event-a").unwrap().accepted_principal, 10);
        assert_eq!(e.event("event-b").unwrap().accepted_principal, 20);
        assert_eq!(
            e.event("event-a").unwrap().registrations["event-a-reg-0"].pass_id,
            "event-a-pass-0"
        );
        assert_eq!(
            e.event("event-b").unwrap().registrations["event-b-reg-1"].pass_id,
            "event-b-pass-0"
        );
    }

    #[test]
    fn attendance_finalize_and_exact_settlement() {
        let mut e = escrow();
        for (who, c) in [("alice", "a"), ("bob", "b"), ("carol", "c")] {
            e.ft_on_transfer(NATIVE_USDC_TESTNET_ACCOUNT, who, "event-a", c, 10, 10)
                .unwrap();
        }
        let mut earn = MockEarnAdapter::default();
        e.close_registration("event-a", 20).unwrap();
        e.trigger_earn_supply("event-a", 20, &mut earn).unwrap();
        e.on_earn_supply_result("event-a", 1, true, 30).unwrap();
        e.mark_attendance("event-a", "host", "event-a-reg-0", true, 20)
            .unwrap();
        e.mark_attendance("event-a", "host", "event-a-reg-1", true, 20)
            .unwrap();
        e.finalize_attendance("event-a", "host", 30).unwrap();
        e.trigger_earn_redeem("event-a", 30, &mut earn).unwrap();
        e.on_earn_redeem_result("event-a", 2, true, 32).unwrap();
        e.settle("event-a").unwrap();
        assert_eq!(
            e.event("event-a").unwrap().registrations["event-a-reg-0"].claim_amount,
            16
        );
        assert_eq!(
            e.event("event-a").unwrap().registrations["event-a-reg-1"].claim_amount,
            16
        );
        assert_eq!(
            e.event("event-a").unwrap().registrations["event-a-reg-2"].claim_amount,
            0
        );
        assert_eq!(e.event("event-a").unwrap().realized_yield, 2);
        assert_eq!(e.event("event-a").unwrap().yield_distributed, 2);
        assert!(e.conservation_holds("event-a").unwrap());
    }

    #[test]
    fn claim_callback_failure_restores_credit_and_retry_is_exactly_once() {
        let mut e = escrow();
        e.ft_on_transfer(
            NATIVE_USDC_TESTNET_ACCOUNT,
            "alice",
            "event-a",
            "c1",
            10,
            10,
        )
        .unwrap();
        e.cancel_event("event-a", "host").unwrap();
        assert_eq!(
            e.start_claim("event-a", "event-a-reg-0", "alice").unwrap(),
            10
        );
        e.on_claim_result("event-a", "event-a-reg-0", 1, false, 10)
            .unwrap();
        assert_eq!(
            e.start_claim("event-a", "event-a-reg-0", "alice").unwrap(),
            10
        );
        assert_eq!(
            e.on_claim_result("event-a", "event-a-reg-0", 1, true, 10),
            Err(EscrowError::StaleAttempt)
        );
        e.on_claim_result("event-a", "event-a-reg-0", 2, true, 10)
            .unwrap();
        assert_eq!(e.event("event-a").unwrap().paid, 10);
        assert_eq!(e.event("event-a").unwrap().pending, 0);
    }

    #[test]
    fn pass_transfer_and_yield_dependency_are_rejected() {
        let e = escrow();
        assert_eq!(
            e.reject_pass_transfer(),
            Err(EscrowError::PassNotTransferable)
        );
        assert_eq!(
            e.event("event-a").unwrap().earn_state,
            EarnState::NotStarted
        );
    }

    #[test]
    fn settlement_is_blocked_until_earn_redeem_and_failed_redeem_retries() {
        let mut e = escrow();
        e.ft_on_transfer(
            NATIVE_USDC_TESTNET_ACCOUNT,
            "alice",
            "event-a",
            "c1",
            10,
            10,
        )
        .unwrap();
        let mut earn = MockEarnAdapter::default();
        e.close_registration("event-a", 20).unwrap();
        e.trigger_earn_supply("event-a", 20, &mut earn).unwrap();
        e.on_earn_supply_result("event-a", 1, true, 10).unwrap();
        e.finalize_attendance("event-a", "host", 30).unwrap();
        assert_eq!(e.settle("event-a"), Err(EscrowError::WrongPhase));
        e.trigger_earn_redeem("event-a", 30, &mut earn).unwrap();
        e.on_earn_redeem_result("event-a", 2, false, 10).unwrap();
        e.trigger_earn_redeem("event-a", 30, &mut earn).unwrap();
        e.on_earn_redeem_result("event-a", 3, true, 10).unwrap();
        e.settle("event-a").unwrap();
    }

    #[test]
    fn cancellation_after_supply_requires_redeem_then_refunds_yield() {
        let mut e = escrow();
        e.ft_on_transfer(
            NATIVE_USDC_TESTNET_ACCOUNT,
            "alice",
            "event-a",
            "c1",
            10,
            10,
        )
        .unwrap();
        e.close_registration("event-a", 20).unwrap();
        let mut earn = MockEarnAdapter::default();
        e.trigger_earn_supply("event-a", 20, &mut earn).unwrap();
        e.on_earn_supply_result("event-a", 1, true, 10).unwrap();
        assert_eq!(
            e.cancel_event("event-a", "host"),
            Err(EscrowError::EarnMustRedeemFirst)
        );
        e.trigger_earn_redeem("event-a", 30, &mut earn).unwrap();
        e.on_earn_redeem_result("event-a", 2, true, 11).unwrap();
        e.cancel_event("event-a", "host").unwrap();
        assert_eq!(
            e.event("event-a").unwrap().registrations["event-a-reg-0"].claim_amount,
            11
        );
        assert!(e.conservation_holds("event-a").unwrap());
    }
}
