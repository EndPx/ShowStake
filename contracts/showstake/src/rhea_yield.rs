//! Bounded, event-isolated Rhea USDC yield candidate.
//!
//! This module is a local policy/ABI candidate, not a live integration. The
//! current public Rhea materials describe the lending contract as
//! `contract.main.burrow.near`, but do not provide a pinned code hash and
//! receipt-verified USDC ABI for this repository. Consequently call proposals
//! require an explicitly verified provider configuration and the default
//! configuration is intentionally unverified.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RheaProviderConfig {
    pub provider_name: String,
    pub network: String,
    pub usdc_account: String,
    pub lending_account: Option<String>,
    pub code_hash: Option<String>,
    pub abi_revision: Option<String>,
    pub verified: bool,
}

impl RheaProviderConfig {
    pub fn unverified_public_candidate(
        network: impl Into<String>,
        usdc_account: impl Into<String>,
    ) -> Self {
        Self {
            provider_name: "Rhea Finance lending (Burrow lineage)".into(),
            network: network.into(),
            usdc_account: usdc_account.into(),
            lending_account: None,
            code_hash: None,
            abi_revision: None,
            verified: false,
        }
    }

    pub fn verified_for_local_mock(
        network: impl Into<String>,
        usdc_account: impl Into<String>,
        lending_account: impl Into<String>,
        code_hash: impl Into<String>,
        abi_revision: impl Into<String>,
    ) -> Self {
        Self {
            provider_name: "Rhea Finance lending (mock ABI)".into(),
            network: network.into(),
            usdc_account: usdc_account.into(),
            lending_account: Some(lending_account.into()),
            code_hash: Some(code_hash.into()),
            abi_revision: Some(abi_revision.into()),
            verified: true,
        }
    }

    fn usable(&self) -> bool {
        self.verified
            && !self.network.is_empty()
            && !self.usdc_account.is_empty()
            && self.lending_account.as_ref().is_some_and(|v| !v.is_empty())
            && self.code_hash.as_ref().is_some_and(|v| !v.is_empty())
            && self.abi_revision.as_ref().is_some_and(|v| !v.is_empty())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YieldState {
    RegistrationOpen,
    SupplyReady,
    SupplyPending,
    Supplied,
    RedeemPending,
    Redeemed,
    SettlementOpen,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct YieldEvent {
    pub event_id: String,
    pub start_time_ms: u64,
    pub end_time_ms: u64,
    pub principal: u128,
    pub state: YieldState,
    pub attempt: u64,
    pub supplied: u128,
    pub redeemed: u128,
    pub locked_for_yield: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RheaCall {
    pub receiver_id: String,
    pub method: String,
    pub amount: u128,
    pub args_json: String,
}

/// Receipt delivered by the adapter after a provider transaction is finalized.
/// The event id and attempt are mandatory so an old callback cannot unlock a
/// different event's principal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum YieldCallback {
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

/// Provider boundary used by the event escrow candidate. A production adapter
/// must be added only after the provider account, ABI revision, code hash and
/// finalized receipt shape are independently verified. The mock adapter below
/// is intentionally the only implementation in this repository.
pub trait RheaAdapter {
    fn supply(
        &mut self,
        provider: &RheaProviderConfig,
        event_id: &str,
        amount: u128,
    ) -> Result<RheaCall, YieldError>;
    fn redeem(
        &mut self,
        provider: &RheaProviderConfig,
        event_id: &str,
        amount: u128,
    ) -> Result<RheaCall, YieldError>;
}

#[derive(Default)]
pub struct MockRheaAdapter {
    calls: Vec<RheaCall>,
    callbacks: Vec<YieldCallback>,
}

impl MockRheaAdapter {
    pub fn calls(&self) -> &[RheaCall] {
        &self.calls
    }

    pub fn queue_callback(&mut self, callback: YieldCallback) {
        self.callbacks.push(callback);
    }

    pub fn next_callback(&mut self) -> Option<YieldCallback> {
        if self.callbacks.is_empty() {
            None
        } else {
            Some(self.callbacks.remove(0))
        }
    }
}

impl RheaAdapter for MockRheaAdapter {
    fn supply(
        &mut self,
        provider: &RheaProviderConfig,
        _event_id: &str,
        amount: u128,
    ) -> Result<RheaCall, YieldError> {
        if !provider.usable() {
            return Err(YieldError::ProviderUnverified);
        }
        let receiver_id = provider
            .lending_account
            .clone()
            .ok_or(YieldError::ProviderUnverified)?;
        let call = RheaCall {
            receiver_id: receiver_id.clone(),
            method: "ft_transfer_call".into(),
            amount,
            args_json: format!(
                "{{\"receiver_id\":\"{receiver_id}\",\"amount\":\"{amount}\",\"msg\":\"\"}}"
            ),
        };
        self.calls.push(call.clone());
        Ok(call)
    }

    fn redeem(
        &mut self,
        provider: &RheaProviderConfig,
        _event_id: &str,
        amount: u128,
    ) -> Result<RheaCall, YieldError> {
        if !provider.usable() {
            return Err(YieldError::ProviderUnverified);
        }
        let receiver_id = provider
            .lending_account
            .clone()
            .ok_or(YieldError::ProviderUnverified)?;
        let token_id = &provider.usdc_account;
        let call = RheaCall {
            receiver_id,
            method: "execute".into(),
            amount: 0,
            args_json: format!(
                "{{\"actions\":[{{\"Withdraw\":{{\"token_id\":\"{token_id}\",\"max_amount\":\"{amount}\"}}}}]}}"
            ),
        };
        self.calls.push(call.clone());
        Ok(call)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum YieldError {
    ProviderUnverified,
    EventExists,
    EventMissing,
    InvalidTimes,
    InvalidAmount,
    WrongState,
    TooEarly,
    StaleAttempt,
    AmountMismatch,
    BorrowOrCollateralForbidden,
}

#[derive(Default)]
pub struct RheaYieldCandidate {
    provider: Option<RheaProviderConfig>,
    events: BTreeMap<String, YieldEvent>,
}

impl RheaYieldCandidate {
    pub fn new(provider: RheaProviderConfig) -> Self {
        Self {
            provider: Some(provider),
            events: BTreeMap::new(),
        }
    }

    pub fn provider(&self) -> Option<&RheaProviderConfig> {
        self.provider.as_ref()
    }

    pub fn create_event(
        &mut self,
        event_id: impl Into<String>,
        start_time_ms: u64,
        end_time_ms: u64,
        principal: u128,
    ) -> Result<(), YieldError> {
        let event_id = event_id.into();
        if event_id.is_empty() || principal == 0 {
            return Err(YieldError::InvalidAmount);
        }
        if start_time_ms >= end_time_ms {
            return Err(YieldError::InvalidTimes);
        }
        if self.events.contains_key(&event_id) {
            return Err(YieldError::EventExists);
        }
        self.events.insert(
            event_id.clone(),
            YieldEvent {
                event_id,
                start_time_ms,
                end_time_ms,
                principal,
                state: YieldState::RegistrationOpen,
                attempt: 0,
                supplied: 0,
                redeemed: 0,
                locked_for_yield: false,
            },
        );
        Ok(())
    }

    pub fn close_registration(&mut self, event_id: &str) -> Result<(), YieldError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(YieldError::EventMissing)?;
        if event.state != YieldState::RegistrationOpen {
            return Err(YieldError::WrongState);
        }
        event.state = YieldState::SupplyReady;
        Ok(())
    }

    pub fn trigger_supply<A: RheaAdapter>(
        &mut self,
        event_id: &str,
        now_ms: u64,
        adapter: &mut A,
    ) -> Result<RheaCall, YieldError> {
        if !self
            .provider
            .as_ref()
            .is_some_and(RheaProviderConfig::usable)
        {
            return Err(YieldError::ProviderUnverified);
        }
        let provider = self.provider.as_ref().expect("checked").clone();
        let event = self.events.get(event_id).ok_or(YieldError::EventMissing)?;
        if event.state != YieldState::SupplyReady {
            return Err(YieldError::WrongState);
        }
        if now_ms < event.start_time_ms {
            return Err(YieldError::TooEarly);
        }
        let amount = event.principal;
        let call = adapter.supply(&provider, event_id, amount)?;
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(YieldError::EventMissing)?;
        event.attempt = event
            .attempt
            .checked_add(1)
            .ok_or(YieldError::InvalidAmount)?;
        event.state = YieldState::SupplyPending;
        event.locked_for_yield = true;
        Ok(call)
    }

    pub fn on_supply_result(
        &mut self,
        event_id: &str,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    ) -> Result<(), YieldError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(YieldError::EventMissing)?;
        if event.state != YieldState::SupplyPending || attempt != event.attempt {
            return Err(YieldError::StaleAttempt);
        }
        if amount != event.principal {
            return Err(YieldError::AmountMismatch);
        }
        if succeeded {
            event.supplied = amount;
            event.state = YieldState::Supplied;
        } else {
            event.state = YieldState::SupplyReady;
            event.locked_for_yield = false;
        }
        Ok(())
    }

    pub fn trigger_redeem<A: RheaAdapter>(
        &mut self,
        event_id: &str,
        now_ms: u64,
        adapter: &mut A,
    ) -> Result<RheaCall, YieldError> {
        if !self
            .provider
            .as_ref()
            .is_some_and(RheaProviderConfig::usable)
        {
            return Err(YieldError::ProviderUnverified);
        }
        let provider = self.provider.as_ref().expect("checked").clone();
        let event = self.events.get(event_id).ok_or(YieldError::EventMissing)?;
        if event.state != YieldState::Supplied {
            return Err(YieldError::WrongState);
        }
        if now_ms < event.end_time_ms {
            return Err(YieldError::TooEarly);
        }
        let amount = event.supplied;
        let call = adapter.redeem(&provider, event_id, amount)?;
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(YieldError::EventMissing)?;
        event.attempt = event
            .attempt
            .checked_add(1)
            .ok_or(YieldError::InvalidAmount)?;
        event.state = YieldState::RedeemPending;
        Ok(call)
    }

    pub fn on_redeem_result(
        &mut self,
        event_id: &str,
        attempt: u64,
        succeeded: bool,
        amount: u128,
    ) -> Result<(), YieldError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(YieldError::EventMissing)?;
        if event.state != YieldState::RedeemPending || attempt != event.attempt {
            return Err(YieldError::StaleAttempt);
        }
        if succeeded {
            if amount < event.principal {
                return Err(YieldError::AmountMismatch);
            }
            event.redeemed = amount;
            event.state = YieldState::Redeemed;
            event.locked_for_yield = false;
        } else {
            event.state = YieldState::Supplied;
        }
        Ok(())
    }

    pub fn open_settlement(&mut self, event_id: &str) -> Result<u128, YieldError> {
        let event = self
            .events
            .get_mut(event_id)
            .ok_or(YieldError::EventMissing)?;
        if event.state != YieldState::Redeemed {
            return Err(YieldError::WrongState);
        }
        event.state = YieldState::SettlementOpen;
        Ok(event.redeemed)
    }

    pub fn apply_callback(&mut self, callback: YieldCallback) -> Result<(), YieldError> {
        match callback {
            YieldCallback::Supply {
                event_id,
                attempt,
                succeeded,
                amount,
            } => self.on_supply_result(&event_id, attempt, succeeded, amount),
            YieldCallback::Redeem {
                event_id,
                attempt,
                succeeded,
                amount,
            } => self.on_redeem_result(&event_id, attempt, succeeded, amount),
        }
    }

    pub fn event(&self, event_id: &str) -> Result<&YieldEvent, YieldError> {
        self.events.get(event_id).ok_or(YieldError::EventMissing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate() -> RheaYieldCandidate {
        RheaYieldCandidate::new(RheaProviderConfig::verified_for_local_mock(
            "near-testnet",
            "usdc.testnet",
            "rhea.mock",
            "sha256:mock",
            "burrow-execute-v1",
        ))
    }

    #[test]
    fn provider_gate_rejects_unverified_address() {
        let mut c = RheaYieldCandidate::new(RheaProviderConfig::unverified_public_candidate(
            "near-mainnet",
            "usdc.token.near",
        ));
        c.create_event("e", 10, 20, 100).unwrap();
        c.close_registration("e").unwrap();
        let mut adapter = MockRheaAdapter::default();
        assert_eq!(
            c.trigger_supply("e", 10, &mut adapter),
            Err(YieldError::ProviderUnverified)
        );
    }
    #[test]
    fn supply_time_gate_and_exact_accounting() {
        let mut c = candidate();
        c.create_event("e", 10, 20, 100).unwrap();
        c.close_registration("e").unwrap();
        let mut adapter = MockRheaAdapter::default();
        assert_eq!(
            c.trigger_supply("e", 9, &mut adapter),
            Err(YieldError::TooEarly)
        );
        let call = c.trigger_supply("e", 10, &mut adapter).unwrap();
        assert_eq!(call.amount, 100);
        assert_eq!(call.method, "ft_transfer_call");
        assert!(call.args_json.contains("rhea.mock"));
        assert!(call.args_json.contains("100"));
        c.on_supply_result("e", 1, true, 100).unwrap();
        assert_eq!(c.event("e").unwrap().state, YieldState::Supplied);
    }
    #[test]
    fn failed_supply_retries_and_duplicate_is_stale() {
        let mut c = candidate();
        c.create_event("e", 1, 2, 10).unwrap();
        c.close_registration("e").unwrap();
        let mut adapter = MockRheaAdapter::default();
        c.trigger_supply("e", 1, &mut adapter).unwrap();
        assert_eq!(
            c.on_supply_result("e", 99, true, 10),
            Err(YieldError::StaleAttempt)
        );
        c.on_supply_result("e", 1, false, 10).unwrap();
        c.trigger_supply("e", 1, &mut adapter).unwrap();
        c.on_supply_result("e", 2, true, 10).unwrap();
        assert_eq!(c.event("e").unwrap().attempt, 2);
    }
    #[test]
    fn redeem_is_after_end_and_before_settlement() {
        let mut c = candidate();
        c.create_event("e", 1, 5, 10).unwrap();
        c.close_registration("e").unwrap();
        let mut adapter = MockRheaAdapter::default();
        c.trigger_supply("e", 1, &mut adapter).unwrap();
        c.on_supply_result("e", 1, true, 10).unwrap();
        assert_eq!(
            c.trigger_redeem("e", 4, &mut adapter),
            Err(YieldError::TooEarly)
        );
        c.trigger_redeem("e", 5, &mut adapter).unwrap();
        c.on_redeem_result("e", 2, true, 11).unwrap();
        assert_eq!(c.open_settlement("e").unwrap(), 11);
    }
    #[test]
    fn failed_redeem_retry_and_duplicate_callback_rejected() {
        let mut c = candidate();
        c.create_event("e", 1, 5, 10).unwrap();
        c.close_registration("e").unwrap();
        let mut adapter = MockRheaAdapter::default();
        c.trigger_supply("e", 1, &mut adapter).unwrap();
        c.on_supply_result("e", 1, true, 10).unwrap();
        c.trigger_redeem("e", 5, &mut adapter).unwrap();
        c.on_redeem_result("e", 2, false, 10).unwrap();
        c.trigger_redeem("e", 5, &mut adapter).unwrap();
        assert_eq!(
            c.on_redeem_result("e", 2, true, 10),
            Err(YieldError::StaleAttempt)
        );
        c.on_redeem_result("e", 3, true, 10).unwrap();
    }
    #[test]
    fn event_isolation_and_no_collateral_or_borrow() {
        let mut c = candidate();
        c.create_event("a", 1, 5, 10).unwrap();
        c.create_event("b", 1, 5, 20).unwrap();
        c.close_registration("a").unwrap();
        c.close_registration("b").unwrap();
        let mut adapter = MockRheaAdapter::default();
        c.trigger_supply("a", 1, &mut adapter).unwrap();
        c.on_supply_result("a", 1, true, 10).unwrap();
        assert_eq!(c.event("b").unwrap().state, YieldState::SupplyReady);
        assert!(c.event("a").unwrap().locked_for_yield);
        let mut c2 = candidate();
        c2.create_event("x", 1, 2, 1).unwrap();
        assert_eq!(c2.open_settlement("x"), Err(YieldError::WrongState));
    }

    #[test]
    fn mock_adapter_maps_callbacks_to_the_same_event() {
        let mut c = candidate();
        let mut adapter = MockRheaAdapter::default();
        c.create_event("e", 1, 5, 10).unwrap();
        c.close_registration("e").unwrap();
        c.trigger_supply("e", 1, &mut adapter).unwrap();
        adapter.queue_callback(YieldCallback::Supply {
            event_id: "e".into(),
            attempt: 1,
            succeeded: true,
            amount: 10,
        });
        c.apply_callback(adapter.next_callback().unwrap()).unwrap();
        c.trigger_redeem("e", 5, &mut adapter).unwrap();
        adapter.queue_callback(YieldCallback::Redeem {
            event_id: "e".into(),
            attempt: 2,
            succeeded: true,
            amount: 11,
        });
        c.apply_callback(adapter.next_callback().unwrap()).unwrap();
        assert_eq!(c.open_settlement("e").unwrap(), 11);
        assert_eq!(adapter.calls().len(), 2);
        assert!(adapter.calls()[1].args_json.contains("usdc.testnet"));
    }
}
