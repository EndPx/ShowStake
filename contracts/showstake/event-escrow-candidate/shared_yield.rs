use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near, require,
};
use serde::Deserialize;
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

const POLICY: &str = "showstake-native-usdc-shared-yield/2";
const RESERVE_PER_REGISTRATION: u64 = 4096;
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct EventData {
    pub event: EventRecord,
    pub ids: Vec<String>,
    pub paused: bool,
    pub principal_cap: U128,
    pub paid: U128,
    pub pending: U128,
    pub liability: U128,
    pub reserved_cash: U128,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommitMessage {
    version: u32,
    event_id: String,
    commitment_id: String,
}
#[derive(Deserialize)]
struct MockPositionSnapshot {
    shares: U128,
    balance: U128,
}
#[near(serializers = [borsh])]
struct LegacyConfig {
    organizer: AccountId,
    canonical_ft: AccountId,
    token_symbol: String,
    token_name: String,
    token_decimals: u8,
    provider_account: AccountId,
    provider_kind: String,
}
#[near(serializers = [borsh])]
#[derive(PartialEq, Eq)]
enum LegacyStage {
    Idle,
    Preparing,
    Dispatched,
    TerminalUsed,
    TerminalRefund,
    Ambiguous,
}
#[near(serializers = [borsh])]
struct LegacyRhea {
    paused: bool,
    stage: LegacyStage,
    principal_cap: U128,
    shares: U128,
    last_internal_balance: U128,
    baseline_ft: U128,
    expected_return: U128,
}
#[near(serializers = [borsh])]
struct LegacyState {
    config: LegacyConfig,
    event: Option<EventRecord>,
    registrations: LookupMap<String, RegistrationRecord>,
    passes: LookupMap<String, PassRecord>,
    active: LookupMap<AccountId, String>,
    commitments: LookupMap<String, String>,
    registration_ids: Vector<String>,
    next_registration: u64,
    rhea: LegacyRhea,
}
// C81 layout: used only to read an empty CREATE-only contract during migration.
#[near(serializers = [borsh])]
struct CreateOnlyState {
    canonical_ft: AccountId,
    provider_account: AccountId,
    provider_kind: String,
    network: String,
    token_symbol: String,
    token_name: String,
    token_decimals: u8,
    events: LookupMap<String, EventData>,
    event_ids: Vector<String>,
    registrations: LookupMap<String, RegistrationRecord>,
    passes: LookupMap<String, PassRecord>,
    active: LookupMap<String, String>,
    commitments: LookupMap<String, String>,
    registration_event: LookupMap<String, String>,
    next_registration: u64,
    accepted: u128,
    paid: u128,
    pending: u128,
    liability: u128,
    reserved_cash: u128,
    global_operation: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OperationKind {
    Supply,
    Redeem,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OperationStage {
    Preparing,
    Dispatched,
    TerminalUsed,
    TerminalRefund,
    Ambiguous,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
struct VaultOperation {
    event_id: String,
    attempt: u64,
    kind: OperationKind,
    stage: OperationStage,
    baseline_ft: U128,
    baseline_provider_shares: U128,
    baseline_provider_value: U128,
    amount: U128,
    used: U128,
    retry_after_block: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MultiEventContract {
    canonical_ft: AccountId,
    provider_account: AccountId,
    provider_kind: String,
    network: String,
    token_symbol: String,
    token_name: String,
    token_decimals: u8,
    events: LookupMap<String, EventData>,
    event_ids: Vector<String>,
    registrations: LookupMap<String, RegistrationRecord>,
    passes: LookupMap<String, PassRecord>,
    active: LookupMap<String, String>,
    commitments: LookupMap<String, String>,
    registration_event: LookupMap<String, String>,
    next_registration: u64,
    accepted: u128,
    paid: u128,
    pending: u128,
    liability: u128,
    reserved_cash: u128,
    global_operation: Option<String>,
    vault_shares: LookupMap<String, U128>,
    invested: LookupMap<String, U128>,
    total_shares: u128,
    strategy_cash: u128,
    provider_shares: u128,
    quarantined_provider_shares: u128,
    provider_balance: u128,
    operation: Option<VaultOperation>,
    shortfalls: LookupMap<String, U128>,
    last_operation: Option<String>,
    realized_yield: u128,
    allocated_yield: u128,
}
#[near]
impl MultiEventContract {
    #[init]
    pub fn new(
        canonical_ft: AccountId,
        provider_account: AccountId,
        provider_kind: String,
        network: String,
        token_symbol: String,
        token_name: String,
        token_decimals: u8,
    ) -> Self {
        require!(
            token_symbol == "USDC" && token_decimals == 6 && !token_name.is_empty(),
            "invalid token metadata"
        );
        require!(
            provider_account != canonical_ft && provider_account != env::current_account_id(),
            "invalid provider"
        );
        require!(
            (network == "testnet"
                && provider_kind == "MOCK_TESTNET"
                && canonical_ft.as_str().ends_with(".testnet")
                && provider_account.as_str().ends_with(".testnet")
                && env::current_account_id().as_str().ends_with(".testnet"))
                || (network == "mainnet"
                    && provider_kind == "RHEA_MAINNET"
                    && canonical_ft.as_str()
                        == "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
                    && provider_account.as_str() == "contract.main.burrow.near"
                    && !env::current_account_id().as_str().ends_with(".testnet")),
            "invalid network configuration"
        );
        Self {
            canonical_ft,
            provider_account,
            provider_kind,
            network,
            token_symbol,
            token_name,
            token_decimals,
            events: LookupMap::new(b"me-e".to_vec()),
            event_ids: Vector::new(b"me-i".to_vec()),
            registrations: LookupMap::new(b"me-r".to_vec()),
            passes: LookupMap::new(b"me-p".to_vec()),
            active: LookupMap::new(b"me-a".to_vec()),
            commitments: LookupMap::new(b"me-c".to_vec()),
            registration_event: LookupMap::new(b"me-re".to_vec()),
            next_registration: 0,
            accepted: 0,
            paid: 0,
            pending: 0,
            liability: 0,
            reserved_cash: 0,
            global_operation: None,
            vault_shares: LookupMap::new(b"sv-s".to_vec()),
            invested: LookupMap::new(b"sv-i".to_vec()),
            total_shares: 0,
            strategy_cash: 0,
            provider_shares: 0,
            quarantined_provider_shares: 0,
            provider_balance: 0,
            operation: None,
            shortfalls: LookupMap::new(b"sv-f".to_vec()),
            last_operation: None,
            realized_yield: 0,
            allocated_yield: 0,
        }
    }
    #[private]
    #[init(ignore_state)]
    pub fn migrate_empty_create() -> Self {
        let old: CreateOnlyState = env::state_read().expect("C81 state missing or incompatible");
        require!(
            old.event_ids.is_empty()
                && old.next_registration == 0
                && old.accepted == 0
                && old.paid == 0
                && old.pending == 0
                && old.liability == 0
                && old.reserved_cash == 0
                && old.global_operation.is_none(),
            "C81 state is not empty"
        );
        Self::new(
            old.canonical_ft,
            old.provider_account,
            old.provider_kind,
            old.network,
            old.token_symbol,
            old.token_name,
            old.token_decimals,
        )
    }
    #[private]
    #[init(ignore_state)]
    pub fn migrate_empty_legacy() -> Self {
        let old: LegacyState = env::state_read().expect("legacy state missing or incompatible");
        require!(
            old.event.is_none()
                && old.registration_ids.len() == 0
                && old.next_registration == 0
                && old.rhea.paused
                && old.rhea.stage == LegacyStage::Idle
                && old.rhea.principal_cap.0 == 0
                && old.rhea.shares.0 == 0
                && old.rhea.last_internal_balance.0 == 0
                && old.rhea.baseline_ft.0 == 0
                && old.rhea.expected_return.0 == 0,
            "legacy state is not empty"
        );
        let network = if old.config.provider_kind == "RHEA_MAINNET" {
            "mainnet"
        } else {
            "testnet"
        };
        Self::new(
            old.config.canonical_ft,
            old.config.provider_account,
            old.config.provider_kind,
            network.into(),
            old.config.token_symbol,
            old.config.token_name,
            old.config.token_decimals,
        )
    }
    pub fn get_block_timestamp_ms(&self) -> u64 {
        env::block_timestamp_ms()
    }
    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"canonical_ft":self.canonical_ft,"provider_account":self.provider_account,"provider_kind":self.provider_kind,"network":self.network,"policy_version":POLICY,"schema_version":2,"token_symbol":self.token_symbol,"token_name":self.token_name,"token_decimals":self.token_decimals,"provider_enabled":true,"provider_status":"CANDIDATE_UNVERIFIED"})
    }
    pub fn quote_create_event(&self, rules: EventRules, organizer: AccountId) -> U128 {
        Self::validate_rules(&rules);
        let metadata = near_sdk::borsh::to_vec(&(rules.clone(), organizer))
            .expect("serialization")
            .len() as u64;
        let bytes = metadata
            .checked_add(rules.event_id.len() as u64 * 3)
            .and_then(|x| x.checked_add(2048))
            .and_then(|x| x.checked_add(RESERVE_PER_REGISTRATION * rules.capacity as u64))
            .expect("storage overflow");
        U128(
            (bytes as u128)
                .checked_mul(env::storage_byte_cost().as_yoctonear())
                .expect("cost overflow"),
        )
    }
    fn validate_rules(r: &EventRules) {
        require!(
            !r.event_id.is_empty()
                && r.event_id.len() <= 128
                && r.event_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                && !r.title.is_empty()
                && r.title.len() <= 256
                && !r.location.is_empty()
                && r.location.len() <= 512
                && !r.rules_text.is_empty()
                && r.rules_text.len() <= 8192,
            "metadata bounds"
        );
        require!(
            r.deposit.0 > 0
                && r.capacity > 0
                && r.capacity <= 200
                && r.deposit.0.checked_mul(r.capacity as u128).is_some(),
            "invalid economics"
        );
        require!(
            r.finalize_deadline <= 253_402_300_799_999
                && r.reg_open < r.reg_close
                && r.reg_close <= r.checkin_open
                && r.checkin_open < r.checkin_close
                && r.checkin_close.checked_add(86_400_000) == Some(r.finalize_deadline),
            "invalid times"
        );
    }
    #[payable]
    pub fn create_event(&mut self, rules: EventRules) {
        let organizer = env::predecessor_account_id();
        let quote = self.quote_create_event(rules.clone(), organizer.clone()).0;
        require!(
            env::attached_deposit().as_yoctonear() == quote,
            "exact storage quote required"
        );
        require!(self.events.get(&rules.event_id).is_none(), "event exists");
        let id = rules.event_id.clone();
        let before = env::storage_usage();
        let event = EventRecord {
            rules,
            created_at: env::block_timestamp_ms(),
            organizer,
            phase: EscrowPhase::RegistrationOpen,
            earn_state: EarnState::NotStarted,
            earn_attempt: 0,
            accepted_principal: U128(0),
            redeemed_amount: U128(0),
            realized_yield: U128(0),
            yield_distributed: U128(0),
            earn_baseline_balance: U128(0),
            earn_action_completed: false,
        };
        let capacity = event.rules.capacity as u64;
        let principal_cap = event
            .rules
            .deposit
            .0
            .checked_mul(capacity as u128)
            .expect("validated capacity overflow");
        self.events.insert(
            &id,
            &EventData {
                event,
                ids: vec![],
                paused: false,
                principal_cap: U128(principal_cap),
                paid: U128(0),
                pending: U128(0),
                liability: U128(0),
                reserved_cash: U128(0),
            },
        );
        self.event_ids.push(&id);
        log_event(
            "EventCreated",
            near_sdk::serde_json::json!({"event_id":id,"organizer":env::predecessor_account_id()}),
        );
        let used = env::storage_usage()
            .checked_sub(before)
            .expect("storage underflow");
        require!(
            (used + RESERVE_PER_REGISTRATION * capacity) as u128
                * env::storage_byte_cost().as_yoctonear()
                <= quote,
            "storage quote insufficient"
        );
    }
    pub fn get_event(&self, event_id: String) -> Option<near_sdk::serde_json::Value> {
        self.events.get(&event_id).map(|e| { let r=&e.event.rules; near_sdk::serde_json::json!({"event_id":r.event_id,"title":r.title,"location":r.location,"rules_text":r.rules_text,"phase":e.event.phase,"earn_state":e.event.earn_state,"earn_attempt":e.event.earn_attempt,"earn_action_completed":e.event.earn_action_completed,"organizer":e.event.organizer,"canonical_ft":self.canonical_ft,"policy_version":POLICY,"deposit":r.deposit,"capacity":r.capacity,"reg_open":r.reg_open,"reg_close":r.reg_close,"checkin_open":r.checkin_open,"checkin_close":r.checkin_close,"cancel_cutoff":r.reg_close,"finalize_deadline":r.finalize_deadline,"active_registrations":e.ids.len(),"total_registrations":e.ids.len(),"withdrawn_registrations":0,"rules_hash":"","created_at":e.event.created_at,"accepted_principal":e.event.accepted_principal,"redeemed_amount":e.event.redeemed_amount,"realized_yield":e.event.realized_yield,"yield_distributed":e.event.yield_distributed}) })
    }
    pub fn list_events(&self, from_index: u64, limit: u64) -> Vec<near_sdk::serde_json::Value> {
        (from_index
            ..self
                .event_ids
                .len()
                .min(from_index.saturating_add(limit.min(50))))
            .filter_map(|i| self.event_ids.get(i))
            .filter_map(|id| self.get_event(id))
            .collect()
    }
    pub fn get_registration(&self, registration_id: String) -> Option<near_sdk::serde_json::Value> {
        let record = self.registrations.get(&registration_id)?;
        let event_id = self.registration_event.get(&registration_id)?;
        let mut view = near_sdk::serde_json::to_value(record).ok()?;
        view.as_object_mut()?
            .insert("event_id".into(), event_id.into());
        Some(view)
    }
    pub fn get_pass(&self, pass_id: String) -> Option<PassRecord> {
        self.passes.get(&pass_id)
    }
    pub fn list_event_registrations(
        &self,
        event_id: String,
        from: u64,
        limit: u64,
    ) -> Vec<RegistrationRecord> {
        self.events
            .get(&event_id)
            .map(|e| {
                e.ids
                    .into_iter()
                    .skip(from as usize)
                    .take(limit.min(50) as usize)
                    .filter_map(|id| self.registrations.get(&id))
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn get_rhea_control(&self, event_id: String) -> near_sdk::serde_json::Value {
        let e = self.events.get(&event_id).expect("event missing");
        near_sdk::serde_json::json!({"paused":e.paused,"principal_cap":e.principal_cap,"stage":self.operation.as_ref().map(|o| o.stage),"event_shares":self.vault_shares.get(&event_id).unwrap_or(U128(0)),"invested_principal":self.invested.get(&event_id).unwrap_or(U128(0)),"total_shares":U128(self.total_shares),"strategy_cash":U128(self.strategy_cash),"provider_balance":U128(self.provider_balance),"shortfall":self.shortfalls.get(&event_id).unwrap_or(U128(0)),"last_operation":self.last_operation,"retry_after_block":self.operation.as_ref().map(|o| o.retry_after_block),"pending":self.operation.is_some(),"ambiguous":self.operation.as_ref().is_some_and(|o| matches!(o.stage, OperationStage::Dispatched | OperationStage::Ambiguous))})
    }
    pub fn get_vault(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"policy_version":POLICY,"schema_version":2,"total_shares":U128(self.total_shares),"strategy_cash":U128(self.strategy_cash),"provider_shares":U128(self.provider_shares),"quarantined_provider_shares":U128(self.quarantined_provider_shares),"provider_balance":U128(self.provider_balance),"operation":self.operation,"last_operation":self.last_operation})
    }
    pub fn get_event_totals(&self, event_id: String) -> near_sdk::serde_json::Value {
        let e = self.events.get(&event_id).expect("event missing");
        near_sdk::serde_json::json!({"event_id":event_id,"accepted_principal":e.event.accepted_principal,"realized_yield":e.event.realized_yield,"allocated_yield":e.event.yield_distributed,"paid":e.paid,"pending":e.pending,"liability":e.liability,"reserved_cash":e.reserved_cash})
    }
    pub fn get_accounting(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"accepted_principal":U128(self.accepted),"realized_yield":U128(self.realized_yield),"allocated_yield":U128(self.allocated_yield),"paid":U128(self.paid),"pending":U128(self.pending),"liability":U128(self.liability),"reserved_cash":U128(self.reserved_cash),"global_operation":self.global_operation})
    }
    pub fn get_storage_state(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"storage_bytes":env::storage_usage(),"storage_cost_yocto":(env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear()).to_string(),"account_balance_yocto":env::account_balance().as_yoctonear().to_string()})
    }
    pub fn configure_rhea(&mut self, event_id: String, principal_cap: U128, paused: bool) {
        let mut e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.organizer == env::predecessor_account_id()
                && e.event.phase == EscrowPhase::RegistrationOpen
                && env::block_timestamp_ms() < e.event.rules.reg_close
                && (paused
                    || principal_cap.0 >= e.event.rules.deposit.0 * e.event.rules.capacity as u128),
            "configuration denied"
        );
        e.paused = paused;
        e.principal_cap = principal_cap;
        self.events.insert(&event_id, &e);
        log_event(
            "RheaConfigured",
            near_sdk::serde_json::json!({"event_id":event_id,"principal_cap":principal_cap,"paused":paused}),
        );
    }
    #[payable]
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.canonical_ft || self.operation.is_some() {
            return PromiseOrValue::Value(amount);
        }
        let Ok(m) = near_sdk::serde_json::from_str::<CommitMessage>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(mut e) = self.events.get(&m.event_id) else {
            return PromiseOrValue::Value(amount);
        };
        let active = format!("{}:{}:{}", m.event_id.len(), m.event_id, sender_id);
        let commitment = format!("{}:{}:{}", m.event_id.len(), m.event_id, m.commitment_id);
        let now = env::block_timestamp_ms();
        if m.version != 1
            || m.commitment_id.is_empty()
            || m.commitment_id.len() > 128
            || e.event.phase != EscrowPhase::RegistrationOpen
            || now < e.event.rules.reg_open
            || now >= e.event.rules.reg_close
            || amount != e.event.rules.deposit
            || e.ids.len() >= e.event.rules.capacity as usize
            || self.active.get(&active).is_some()
            || self.commitments.get(&commitment).is_some()
        {
            return PromiseOrValue::Value(amount);
        }
        let before = env::storage_usage();
        let seq = e.ids.len() as u64;
        let id = format!("reg-{}", self.next_registration);
        let pass_id = format!("pass-{}", self.next_registration);
        self.next_registration = self
            .next_registration
            .checked_add(1)
            .expect("registration overflow");
        let reg = RegistrationRecord {
            registration_id: id.clone(),
            pass_id: pass_id.clone(),
            participant: sender_id.clone(),
            beneficiary: sender_id.clone(),
            commitment_id: m.commitment_id,
            amount,
            sequence: seq,
            attendance: Attendance::Unmarked,
            registration_status: "Active".into(),
            attendance_status: "Unmarked".into(),
            claim: ClaimState::None,
            claim_amount: U128(0),
            claim_attempt: 0,
        };
        let pass = PassRecord {
            pass_id: pass_id.clone(),
            event_id: m.event_id.clone(),
            registration_id: id.clone(),
            owner: sender_id,
            registration_status: "Active".into(),
            attendance_status: "Unmarked".into(),
            policy_version: POLICY.into(),
        };
        self.active.insert(&active, &id);
        self.commitments.insert(&commitment, &id);
        self.registration_event.insert(&id, &m.event_id);
        self.registrations.insert(&id, &reg);
        self.passes.insert(&pass_id, &pass);
        e.ids.push(id.clone());
        e.event.accepted_principal.0 = e
            .event
            .accepted_principal
            .0
            .checked_add(amount.0)
            .expect("overflow");
        e.liability.0 = e.liability.0.checked_add(amount.0).expect("overflow");
        e.reserved_cash.0 = e.reserved_cash.0.checked_add(amount.0).expect("overflow");
        self.accepted = self.accepted.checked_add(amount.0).expect("overflow");
        self.liability = self.liability.checked_add(amount.0).expect("overflow");
        self.reserved_cash = self.reserved_cash.checked_add(amount.0).expect("overflow");
        self.events.insert(&m.event_id, &e);
        require!(
            env::storage_usage().saturating_sub(before) <= RESERVE_PER_REGISTRATION,
            "registration storage exceeds prepaid bound"
        );
        log_event(
            "RegistrationCommitted",
            near_sdk::serde_json::json!({"event_id":m.event_id,"registration_id":id,"pass_id":pass_id,"participant":reg.participant,"beneficiary":reg.beneficiary,"commitment_id":reg.commitment_id,"amount":amount,"event_sequence":seq}),
        );
        PromiseOrValue::Value(U128(0))
    }
    pub fn close_registration(&mut self, event_id: String) {
        let mut e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.phase == EscrowPhase::RegistrationOpen
                && env::block_timestamp_ms() >= e.event.rules.reg_close,
            "close gate"
        );
        e.event.phase = EscrowPhase::RegistrationClosed;
        self.events.insert(&event_id, &e);
        log_event(
            "RegistrationClosed",
            near_sdk::serde_json::json!({"event_id": event_id}),
        );
    }
    pub fn mark_attendance(&mut self, registration_id: String, attended: bool) {
        let event_id = self
            .registration_event
            .get(&registration_id)
            .expect("registration missing");
        let e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.organizer == env::predecessor_account_id()
                && e.event.phase == EscrowPhase::RegistrationClosed
                && env::block_timestamp_ms() >= e.event.rules.checkin_open
                && env::block_timestamp_ms() < e.event.rules.checkin_close,
            "attendance gate"
        );
        let mut r = self
            .registrations
            .get(&registration_id)
            .expect("registration missing");
        r.attendance = if attended {
            Attendance::Attended
        } else {
            Attendance::Unmarked
        };
        r.attendance_status = if attended { "Attended" } else { "Unmarked" }.into();
        let mut p = self.passes.get(&r.pass_id).expect("pass missing");
        p.attendance_status = r.attendance_status.clone();
        self.passes.insert(&r.pass_id, &p);
        self.registrations.insert(&registration_id, &r);
        log_event(
            "AttendanceMarked",
            near_sdk::serde_json::json!({"event_id":event_id,"registration_id":registration_id,"attended":attended}),
        );
    }
    pub fn finalize_attendance(&mut self, event_id: String) {
        let mut e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.organizer == env::predecessor_account_id()
                && e.event.phase == EscrowPhase::RegistrationClosed
                && e.event.earn_state == EarnState::Supplied
                && env::block_timestamp_ms() >= e.event.rules.checkin_close
                && env::block_timestamp_ms() < e.event.rules.finalize_deadline,
            "finalize gate"
        );
        for id in &e.ids {
            let mut r = self.registrations.get(id).expect("registration missing");
            if r.attendance == Attendance::Unmarked {
                r.attendance = Attendance::NoShow;
                r.attendance_status = "NoShow".into();
                let mut p = self.passes.get(&r.pass_id).expect("pass missing");
                p.attendance_status = "NoShow".into();
                self.passes.insert(&r.pass_id, &p);
                self.registrations.insert(id, &r);
            }
        }
        e.event.phase = EscrowPhase::AttendanceFinalized;
        self.events.insert(&event_id, &e);
        log_event(
            "AttendanceFinalized",
            near_sdk::serde_json::json!({"event_id":event_id}),
        );
    }
    pub fn cancel_event(&mut self, event_id: String) {
        let mut e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.organizer == env::predecessor_account_id()
                && matches!(
                    e.event.phase,
                    EscrowPhase::RegistrationOpen
                        | EscrowPhase::RegistrationClosed
                        | EscrowPhase::AttendanceFinalized
                ),
            "cancel gate"
        );
        e.event.phase = EscrowPhase::Cancelled;
        self.events.insert(&event_id, &e);
        log_event(
            "EventCancelled",
            near_sdk::serde_json::json!({"event_id":event_id}),
        );
    }
    pub fn activate_timeout_refund(&mut self, event_id: String) {
        let mut e = self.events.get(&event_id).expect("event missing");
        require!(
            matches!(
                e.event.phase,
                EscrowPhase::RegistrationOpen | EscrowPhase::RegistrationClosed
            ) && env::block_timestamp_ms() >= e.event.rules.finalize_deadline,
            "timeout gate"
        );
        e.event.phase = EscrowPhase::RefundOnly;
        self.events.insert(&event_id, &e);
        log_event(
            "RefundModeActivated",
            near_sdk::serde_json::json!({"event_id":event_id}),
        );
    }
    pub fn trigger_earn_supply(&mut self, event_id: String) -> Promise {
        let e = self.events.get(&event_id).expect("event missing");
        require!(
            !e.paused
                && e.event.phase == EscrowPhase::RegistrationClosed
                && e.event.earn_state == EarnState::NotStarted
                && e.event.accepted_principal.0 > 0
                && e.event.accepted_principal.0 <= e.principal_cap.0
                && env::block_timestamp_ms() >= e.event.rules.checkin_open
                && env::block_timestamp_ms() < e.event.rules.finalize_deadline,
            "supply gate"
        );
        self.begin_operation(event_id, OperationKind::Supply)
    }
    pub fn trigger_earn_redeem(&mut self, event_id: String) -> Promise {
        let e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.earn_state == EarnState::Supplied
                && (matches!(
                    e.event.phase,
                    EscrowPhase::Cancelled | EscrowPhase::RefundOnly
                ) || (e.event.phase == EscrowPhase::AttendanceFinalized
                    && env::block_timestamp_ms() >= e.event.rules.checkin_close)),
            "redeem gate"
        );
        self.begin_operation(event_id, OperationKind::Redeem)
    }
    pub fn reconcile_earn(&mut self, event_id: String) -> Promise {
        let op = self.operation.as_ref().expect("no operation");
        require!(
            op.event_id == event_id
                && matches!(
                    op.stage,
                    OperationStage::Preparing
                        | OperationStage::TerminalUsed
                        | OperationStage::TerminalRefund
                ),
            "operation unresolved"
        );
        self.query_vault(
            op.event_id.clone(),
            op.attempt,
            op.stage == OperationStage::Preparing,
        )
    }
    pub fn cancel_earn_preflight(&mut self, event_id: String) -> bool {
        let Some(op) = self.operation.clone() else {
            return false;
        };
        require!(
            op.event_id == event_id
                && op.stage == OperationStage::Preparing
                && env::block_height() >= op.retry_after_block,
            "preflight cancellation unavailable"
        );
        let Some(mut e) = self.events.get(&event_id) else {
            return false;
        };
        e.event.earn_state = if op.kind == OperationKind::Supply {
            EarnState::NotStarted
        } else {
            EarnState::Supplied
        };
        self.events.insert(&event_id, &e);
        self.finish_operation("PREFLIGHT_CANCELLED");
        true
    }
    #[payable]
    pub fn rhea_storage_deposit(&mut self, event_id: String, target: String) -> Promise {
        let e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.organizer == env::predecessor_account_id()
                && self.provider_kind == "RHEA_MAINNET"
                && env::attached_deposit().as_yoctonear() > 0,
            "storage deposit denied"
        );
        let account = match target.as_str() {
            "provider" => self.provider_account.clone(),
            "ft" => self.canonical_ft.clone(),
            _ => env::panic_str("unknown storage target"),
        };
        Promise::new(account).function_call(
            "storage_deposit",
            near_sdk::serde_json::json!({"account_id":env::current_account_id()})
                .to_string()
                .into_bytes(),
            env::attached_deposit(),
            Gas::from_tgas(30),
        )
    }
    fn begin_operation(&mut self, event_id: String, kind: OperationKind) -> Promise {
        require!(
            self.operation.is_none() && self.pending == 0,
            "provider or payout pending"
        );
        let mut e = self.events.get(&event_id).expect("event missing");
        e.event.earn_attempt = e
            .event
            .earn_attempt
            .checked_add(1)
            .expect("attempt overflow");
        e.event.earn_state = if kind == OperationKind::Supply {
            EarnState::SupplyPending
        } else {
            EarnState::RedeemPending
        };
        let attempt = e.event.earn_attempt;
        self.events.insert(&event_id, &e);
        self.global_operation = Some(event_id.clone());
        self.operation = Some(VaultOperation {
            event_id: event_id.clone(),
            attempt,
            kind,
            stage: OperationStage::Preparing,
            baseline_ft: U128(0),
            baseline_provider_shares: U128(0),
            baseline_provider_value: U128(0),
            amount: U128(0),
            used: U128(0),
            retry_after_block: env::block_height().saturating_add(20),
        });
        self.query_vault(event_id, attempt, true)
    }
    fn query_vault(&self, event_id: String, attempt: u64, preflight: bool) -> Promise {
        let ft = Promise::new(self.canonical_ft.clone()).function_call(
            "ft_balance_of",
            near_sdk::serde_json::json!({"account_id":env::current_account_id()})
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        );
        let position = if self.provider_kind == "RHEA_MAINNET" {
            Promise::new(self.provider_account.clone()).function_call(
                "get_account",
                near_sdk::serde_json::json!({"account_id":env::current_account_id()})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            )
        } else {
            Promise::new(self.provider_account.clone()).function_call(
                "get_position",
                near_sdk::serde_json::json!({"account_id":env::current_account_id()})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            )
        };
        let asset = if self.provider_kind == "RHEA_MAINNET" {
            Promise::new(self.provider_account.clone()).function_call(
                "get_asset",
                near_sdk::serde_json::json!({"token_id":self.canonical_ft})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(15),
            )
        } else {
            Promise::new(env::current_account_id()).function_call(
                "vault_mock_asset",
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(5),
            )
        };
        ft.and(position).and(asset).then(Promise::new(env::current_account_id()).function_call("on_vault_read", near_sdk::serde_json::json!({"event_id":event_id,"attempt":attempt,"preflight":preflight}).to_string().into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(if preflight { 210 } else { 30 })))
    }
    #[private]
    pub fn vault_mock_asset(&self) -> bool {
        true
    }
    fn finish_operation(&mut self, label: &str) {
        self.last_operation = Some(label.into());
        self.operation = None;
        self.global_operation = None;
    }
    #[private]
    pub fn on_vault_read(
        &mut self,
        event_id: String,
        attempt: u64,
        preflight: bool,
    ) -> PromiseOrValue<bool> {
        let Some(mut op) = self.operation.clone() else {
            return PromiseOrValue::Value(false);
        };
        if op.event_id != event_id
            || op.attempt != attempt
            || env::promise_results_count() != 3
            || (preflight && op.stage != OperationStage::Preparing)
            || (!preflight
                && !matches!(
                    op.stage,
                    OperationStage::TerminalUsed | OperationStage::TerminalRefund
                ))
        {
            return PromiseOrValue::Value(false);
        }
        let ft = env::promise_result_checked(0, 128)
            .ok()
            .and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok());
        let raw = env::promise_result_checked(1, 65536).ok();
        let (Some(ft), Some(raw)) = (ft, raw) else {
            return PromiseOrValue::Value(false);
        };
        let (shares, value, asset) = if self.provider_kind == "RHEA_MAINNET" {
            let Some(data) = env::promise_result_checked(2, 65536).ok() else {
                return PromiseOrValue::Value(false);
            };
            let Ok(asset) = crate::rhea_adapter::decode_asset(
                "mainnet",
                crate::rhea_adapter::PROVIDER,
                crate::rhea_adapter::USDC,
                &data,
            ) else {
                return PromiseOrValue::Value(false);
            };
            let Ok(pos) = crate::rhea_adapter::decode_position(
                "mainnet",
                crate::rhea_adapter::PROVIDER,
                crate::rhea_adapter::USDC,
                env::current_account_id().as_str(),
                &raw,
                &asset,
            ) else {
                return PromiseOrValue::Value(false);
            };
            if pos.shares < self.quarantined_provider_shares {
                op.stage = OperationStage::Ambiguous;
                self.operation = Some(op);
                return PromiseOrValue::Value(false);
            }
            let Some(scale) = 10u128.checked_pow(asset.extra_decimals.into()) else {
                return PromiseOrValue::Value(false);
            };
            let Some(value) = crate::shared_vault_math::owned_value(
                pos.internal_balance,
                pos.shares,
                self.quarantined_provider_shares,
                scale,
            ) else {
                return PromiseOrValue::Value(false);
            };
            (pos.shares, value, Some(asset))
        } else {
            if let Ok(value) = near_sdk::serde_json::from_slice::<U128>(&raw) {
                if value.0 < self.quarantined_provider_shares {
                    op.stage = OperationStage::Ambiguous;
                    self.operation = Some(op);
                    return PromiseOrValue::Value(false);
                }
                let Some(owned) = crate::shared_vault_math::owned_value(
                    value.0,
                    value.0,
                    self.quarantined_provider_shares,
                    1,
                ) else {
                    return PromiseOrValue::Value(false);
                };
                (value.0, owned, None)
            } else if let Ok(p) = near_sdk::serde_json::from_slice::<MockPositionSnapshot>(&raw) {
                if p.shares.0 < self.quarantined_provider_shares {
                    op.stage = OperationStage::Ambiguous;
                    self.operation = Some(op);
                    return PromiseOrValue::Value(false);
                }
                let Some(owned) = crate::shared_vault_math::owned_value(
                    p.balance.0,
                    p.shares.0,
                    self.quarantined_provider_shares,
                    1,
                ) else {
                    return PromiseOrValue::Value(false);
                };
                (p.shares.0, owned, None)
            } else {
                return PromiseOrValue::Value(false);
            }
        };
        let Some(mut e) = self.events.get(&event_id) else {
            return PromiseOrValue::Value(false);
        };
        if preflight {
            if shares != self.provider_shares
                || (self.total_shares == 0
                    && (shares != self.quarantined_provider_shares
                        || value != 0
                        || self.strategy_cash != 0))
                || ft.0 < self.reserved_cash.saturating_add(self.strategy_cash)
            {
                return PromiseOrValue::Value(false);
            }
            if op.kind == OperationKind::Supply
                && (e.event.phase != EscrowPhase::RegistrationClosed
                    || env::block_timestamp_ms() >= e.event.rules.finalize_deadline)
            {
                e.event.earn_state = EarnState::NotStarted;
                self.events.insert(&event_id, &e);
                self.finish_operation("SUPPLY_WINDOW_CLOSED");
                return PromiseOrValue::Value(false);
            }
            self.provider_balance = value;
            let Some(nav) = self.strategy_cash.checked_add(value) else {
                return PromiseOrValue::Value(false);
            };
            let amount = if op.kind == OperationKind::Supply {
                e.event.accepted_principal.0
            } else {
                let owned = self.vault_shares.get(&event_id).unwrap_or(U128(0)).0;
                let Some(entitled) =
                    crate::shared_vault_math::mul_div(owned, nav, self.total_shares)
                else {
                    return PromiseOrValue::Value(false);
                };
                let invested = self.invested.get(&event_id).unwrap_or(U128(0)).0;
                if entitled < invested {
                    self.shortfalls
                        .insert(&event_id, &U128(invested - entitled));
                    e.event.earn_state = EarnState::Supplied;
                    self.events.insert(&event_id, &e);
                    self.finish_operation("SHORTFALL");
                    return PromiseOrValue::Value(false);
                }
                self.shortfalls.remove(&event_id);
                if self.strategy_cash >= entitled {
                    return PromiseOrValue::Value(self.exit_event(event_id, e, shares, value));
                }
                entitled - self.strategy_cash
            };
            if amount == 0 || (op.kind == OperationKind::Redeem && amount > value) {
                return PromiseOrValue::Value(false);
            }
            op.baseline_ft = ft;
            op.baseline_provider_shares = U128(shares);
            op.baseline_provider_value = U128(value);
            op.amount = U128(amount);
            op.stage = OperationStage::Dispatched;
            let call = if op.kind == OperationKind::Supply {
                if self.provider_kind == "RHEA_MAINNET" {
                    let Ok(call) = crate::rhea_adapter::supply_call(
                        "mainnet",
                        crate::rhea_adapter::PROVIDER,
                        crate::rhea_adapter::USDC,
                        amount,
                        asset.as_ref().unwrap(),
                    ) else {
                        return PromiseOrValue::Value(false);
                    };
                    Promise::new(self.canonical_ft.clone()).function_call(
                        call.method,
                        call.args,
                        NearToken::from_yoctonear(call.deposit_yocto),
                        Gas::from_tgas(60),
                    )
                } else {
                    Promise::new(self.canonical_ft.clone()).function_call("ft_transfer_call", near_sdk::serde_json::json!({"receiver_id":self.provider_account,"amount":amount.to_string(),"msg":""}).to_string().into_bytes(), NearToken::from_yoctonear(1), Gas::from_tgas(60))
                }
            } else if self.provider_kind == "RHEA_MAINNET" {
                let Ok(call) = crate::rhea_adapter::linked_withdraw_call(
                    "mainnet",
                    crate::rhea_adapter::PROVIDER,
                    crate::rhea_adapter::USDC,
                    amount,
                    asset.as_ref().unwrap(),
                ) else {
                    return PromiseOrValue::Value(false);
                };
                Promise::new(self.provider_account.clone()).function_call(
                    call.method,
                    call.args,
                    NearToken::from_yoctonear(call.deposit_yocto),
                    Gas::from_tgas(90),
                )
            } else {
                Promise::new(self.provider_account.clone()).function_call(
                    "withdraw",
                    near_sdk::serde_json::json!({"amount":amount.to_string()})
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(80),
                )
            };
            self.operation = Some(op);
            return PromiseOrValue::Promise(
                call.then(
                    Promise::new(env::current_account_id()).function_call(
                        "on_vault_action",
                        near_sdk::serde_json::json!({"event_id":event_id,"attempt":attempt})
                            .to_string()
                            .into_bytes(),
                        NearToken::from_yoctonear(0),
                        Gas::from_tgas(100),
                    ),
                ),
            );
        }
        if op.stage == OperationStage::TerminalRefund {
            if shares != op.baseline_provider_shares.0
                || ft.0 < self.reserved_cash.saturating_add(self.strategy_cash)
            {
                return PromiseOrValue::Value(false);
            }
            e.event.earn_state = if op.kind == OperationKind::Supply {
                EarnState::NotStarted
            } else {
                EarnState::Supplied
            };
            self.events.insert(&event_id, &e);
            self.provider_balance = value;
            self.finish_operation("KNOWN_FAILURE");
            return PromiseOrValue::Value(true);
        }
        if op.kind == OperationKind::Supply {
            if op.used.0 == 0
                || op.used.0 > op.amount.0
                || shares <= op.baseline_provider_shares.0
                || value < op.used.0
                || value - op.used.0 < op.baseline_provider_value.0
                || e.reserved_cash.0 < op.used.0
                || self.reserved_cash < op.used.0
            {
                return PromiseOrValue::Value(false);
            }
            let Some(required) = self
                .reserved_cash
                .checked_sub(op.used.0)
                .and_then(|v| v.checked_add(self.strategy_cash))
            else {
                return PromiseOrValue::Value(false);
            };
            if ft.0 < required {
                return PromiseOrValue::Value(false);
            }
            let Some(old_nav) = self
                .strategy_cash
                .checked_add(op.baseline_provider_value.0.max(value - op.used.0))
            else {
                return PromiseOrValue::Value(false);
            };
            let minted = if self.total_shares == 0 {
                op.used.0
            } else {
                let Some(v) =
                    crate::shared_vault_math::mul_div(op.used.0, self.total_shares, old_nav)
                else {
                    return PromiseOrValue::Value(false);
                };
                v
            };
            let Some(total) = self.total_shares.checked_add(minted) else {
                return PromiseOrValue::Value(false);
            };
            if minted == 0 {
                return PromiseOrValue::Value(false);
            }
            self.total_shares = total;
            self.vault_shares.insert(&event_id, &U128(minted));
            self.invested.insert(&event_id, &op.used);
            e.reserved_cash.0 -= op.used.0;
            self.reserved_cash -= op.used.0;
            e.event.earn_state = EarnState::Supplied;
            self.events.insert(&event_id, &e);
            self.provider_shares = shares;
            self.provider_balance = value;
            self.finish_operation("SUPPLY_RECONCILED");
            return PromiseOrValue::Value(true);
        }
        if shares >= op.baseline_provider_shares.0 {
            return PromiseOrValue::Value(false);
        }
        let Some(cash) = self.strategy_cash.checked_add(op.amount.0) else {
            return PromiseOrValue::Value(false);
        };
        let Some(required) = self.reserved_cash.checked_add(cash) else {
            return PromiseOrValue::Value(false);
        };
        if ft.0 < required {
            return PromiseOrValue::Value(false);
        }
        op.stage = OperationStage::Ambiguous;
        self.operation = Some(op);
        self.strategy_cash = cash;
        self.provider_shares = shares;
        self.provider_balance = value;
        PromiseOrValue::Value(self.exit_event(event_id, e, shares, value))
    }
    fn exit_event(
        &mut self,
        event_id: String,
        mut e: EventData,
        shares: u128,
        value: u128,
    ) -> bool {
        let owned = self.vault_shares.get(&event_id).unwrap_or(U128(0)).0;
        let Some(nav) = self.strategy_cash.checked_add(value) else {
            return false;
        };
        let Some(entitled) = crate::shared_vault_math::mul_div(owned, nav, self.total_shares)
        else {
            return false;
        };
        let invested = self.invested.get(&event_id).unwrap_or(U128(0)).0;
        if entitled < invested {
            self.shortfalls
                .insert(&event_id, &U128(invested - entitled));
            e.event.earn_state = EarnState::Supplied;
            self.events.insert(&event_id, &e);
            self.finish_operation("SHORTFALL");
            return false;
        }
        if self.strategy_cash < entitled || (owned == self.total_shares && value != 0) {
            e.event.earn_state = EarnState::Supplied;
            self.events.insert(&event_id, &e);
            self.finish_operation(if owned == self.total_shares && value != 0 {
                "ORPHAN_PROVIDER_DUST"
            } else {
                "INSUFFICIENT_STRATEGY_CASH"
            });
            return false;
        }
        let Some(event_cash) = e.reserved_cash.0.checked_add(entitled) else {
            return false;
        };
        let Some(global_cash) = self.reserved_cash.checked_add(entitled) else {
            return false;
        };
        let yield_amount = entitled - invested;
        let Some(realized) = self.realized_yield.checked_add(yield_amount) else {
            return false;
        };
        self.strategy_cash -= entitled;
        self.total_shares -= owned;
        if self.total_shares == 0 {
            self.quarantined_provider_shares = shares;
        }
        self.vault_shares.remove(&event_id);
        self.invested.remove(&event_id);
        self.shortfalls.remove(&event_id);
        e.reserved_cash = U128(event_cash);
        self.reserved_cash = global_cash;
        e.event.redeemed_amount = U128(entitled);
        e.event.realized_yield = U128(yield_amount);
        e.event.earn_state = EarnState::Redeemed;
        self.realized_yield = realized;
        self.events.insert(&event_id, &e);
        self.finish_operation("REDEEM_RECONCILED");
        true
    }
    #[private]
    pub fn on_vault_action(&mut self, event_id: String, attempt: u64) -> PromiseOrValue<bool> {
        let Some(mut op) = self.operation.clone() else {
            return PromiseOrValue::Value(false);
        };
        if op.event_id != event_id
            || op.attempt != attempt
            || op.stage != OperationStage::Dispatched
            || env::promise_results_count() != 1
        {
            return PromiseOrValue::Value(false);
        }
        let result = env::promise_result_checked(0, 1024).ok();
        if op.kind == OperationKind::Supply {
            match result.and_then(|v| near_sdk::serde_json::from_slice::<U128>(&v).ok()) {
                Some(used) if used.0 > 0 && used.0 <= op.amount.0 => {
                    op.used = used;
                    op.stage = OperationStage::TerminalUsed;
                }
                Some(U128(0)) => op.stage = OperationStage::TerminalRefund,
                _ => op.stage = OperationStage::Ambiguous,
            }
        } else {
            match result.and_then(|v| near_sdk::serde_json::from_slice::<bool>(&v).ok()) {
                Some(true) => op.stage = OperationStage::TerminalUsed,
                Some(false) => op.stage = OperationStage::TerminalRefund,
                _ => op.stage = OperationStage::Ambiguous,
            }
        }
        let can_read = op.stage != OperationStage::Ambiguous;
        self.operation = Some(op);
        if can_read {
            PromiseOrValue::Promise(self.query_vault(event_id, attempt, false))
        } else {
            PromiseOrValue::Value(false)
        }
    }
    pub fn settle(&mut self, event_id: String) {
        let mut e = self.events.get(&event_id).expect("event missing");
        require!(
            e.event.phase == EscrowPhase::AttendanceFinalized
                && e.event.earn_state == EarnState::Redeemed,
            "EARN_REDEMPTION_NOT_VERIFIED"
        );
        let mut attendees = Vec::new();
        for id in &e.ids {
            let r = self.registrations.get(id).expect("registration missing");
            if r.attendance == Attendance::Attended {
                attendees.push(id.clone());
            }
        }
        let count = e.ids.len() as u128;
        require!(count > 0, "no registrations");
        let recipients = if attendees.is_empty() {
            e.ids.clone()
        } else {
            attendees
        };
        let pool = e
            .event
            .accepted_principal
            .0
            .checked_add(e.event.realized_yield.0)
            .expect("overflow");
        let each = pool / recipients.len() as u128;
        let rem = pool % recipients.len() as u128;
        for (i, id) in recipients.iter().enumerate() {
            let mut r = self.registrations.get(id).expect("registration missing");
            r.claim_amount = U128(each + u128::from((i as u128) < rem));
            r.claim = ClaimState::Claimable;
            self.registrations.insert(id, &r);
        }
        e.event.yield_distributed = e.event.realized_yield;
        e.liability.0 = e
            .liability
            .0
            .checked_add(e.event.realized_yield.0)
            .expect("liability overflow");
        self.liability = self
            .liability
            .checked_add(e.event.realized_yield.0)
            .expect("liability overflow");
        self.allocated_yield = self
            .allocated_yield
            .checked_add(e.event.realized_yield.0)
            .expect("yield overflow");
        e.event.phase = EscrowPhase::Settled;
        self.events.insert(&event_id, &e);
        log_event(
            "EventSettled",
            near_sdk::serde_json::json!({"event_id":event_id}),
        );
    }
    #[payable]
    pub fn claim(&mut self, registration_id: String) -> Promise {
        require!(self.operation.is_none(), "provider operation pending");
        require!(
            env::attached_deposit().as_yoctonear() == 1,
            "one yocto required"
        );
        let event_id = self
            .registration_event
            .get(&registration_id)
            .expect("registration missing");
        let mut e = self.events.get(&event_id).expect("event missing");
        let refund = matches!(
            e.event.phase,
            EscrowPhase::Cancelled | EscrowPhase::RefundOnly
        ) && matches!(
            e.event.earn_state,
            EarnState::NotStarted | EarnState::Redeemed
        );
        require!(
            refund
                || (e.event.phase == EscrowPhase::Settled
                    && e.event.earn_state == EarnState::Redeemed),
            "claim gate"
        );
        let mut r = self
            .registrations
            .get(&registration_id)
            .expect("registration missing");
        require!(
            r.beneficiary == env::predecessor_account_id()
                && matches!(r.claim, ClaimState::None | ClaimState::Claimable),
            "claim denied"
        );
        let amount = if refund {
            let y = e.event.realized_yield.0;
            if y == 0 {
                r.amount.0
            } else {
                let n = e.ids.len() as u128;
                require!(
                    n > 0
                        && (r.sequence as u128) < n
                        && e.ids.get(r.sequence as usize) == Some(&registration_id),
                    "invalid refund sequence"
                );
                if e.event.yield_distributed.0 == 0 {
                    e.event.yield_distributed = U128(y);
                    self.allocated_yield = self
                        .allocated_yield
                        .checked_add(y)
                        .expect("allocated yield overflow");
                    e.liability.0 = e.liability.0.checked_add(y).expect("liability overflow");
                    self.liability = self.liability.checked_add(y).expect("liability overflow");
                } else {
                    require!(
                        e.event.yield_distributed.0 == y,
                        "yield allocation invariant"
                    );
                }
                r.amount
                    .0
                    .checked_add(y / n)
                    .and_then(|v| v.checked_add(u128::from((r.sequence as u128) < y % n)))
                    .expect("refund overflow")
            }
        } else {
            r.claim_amount.0
        };
        require!(
            amount > 0 && e.reserved_cash.0 >= amount,
            "insufficient event reserve"
        );
        r.claim = ClaimState::Pending;
        r.claim_amount = U128(amount);
        r.claim_attempt = r.claim_attempt.checked_add(1).expect("attempt overflow");
        e.pending.0 += amount;
        self.pending += amount;
        e.liability.0 -= amount;
        self.liability -= amount;
        e.reserved_cash.0 -= amount;
        self.reserved_cash -= amount;
        self.events.insert(&event_id, &e);
        self.registrations.insert(&registration_id, &r);
        log_event(
            "PayoutStarted",
            near_sdk::serde_json::json!({"event_id":event_id,"registration_id":registration_id,"pass_id":r.pass_id,"attempt":r.claim_attempt,"amount":r.claim_amount}),
        );
        Promise::new(self.canonical_ft.clone()).function_call("ft_transfer",near_sdk::serde_json::json!({"receiver_id":r.beneficiary,"amount":amount.to_string(),"memo":format!("{}:{}",registration_id,r.claim_attempt)}).to_string().into_bytes(),NearToken::from_yoctonear(1),Gas::from_tgas(50)).then(Promise::new(env::current_account_id()).function_call("on_claim_result",near_sdk::serde_json::json!({"event_id":event_id,"registration_id":registration_id,"attempt":r.claim_attempt}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(30)))
    }
    #[private]
    pub fn on_claim_result(&mut self, event_id: String, registration_id: String, attempt: u64) {
        if self.registration_event.get(&registration_id) != Some(event_id.clone())
            || env::promise_results_count() != 1
        {
            return;
        }
        let Some(mut r) = self.registrations.get(&registration_id) else {
            return;
        };
        if r.claim != ClaimState::Pending || r.claim_attempt != attempt {
            return;
        }
        let Some(mut e) = self.events.get(&event_id) else {
            return;
        };
        let amount = r.claim_amount.0;
        e.pending.0 = e.pending.0.checked_sub(amount).expect("pending invariant");
        self.pending = self.pending.checked_sub(amount).expect("pending invariant");
        if env::promise_result_checked(0, 1024).is_ok() {
            r.claim = ClaimState::Paid;
            e.paid.0 += amount;
            self.paid += amount;
        } else {
            r.claim = ClaimState::Claimable;
            e.liability.0 += amount;
            self.liability += amount;
            e.reserved_cash.0 += amount;
            self.reserved_cash += amount;
        }
        self.registrations.insert(&registration_id, &r);
        self.events.insert(&event_id, &e);
        log_event(
            if r.claim == ClaimState::Paid {
                "PayoutSucceeded"
            } else {
                "PayoutFailed"
            },
            near_sdk::serde_json::json!({"event_id":event_id,"registration_id":registration_id,"pass_id":r.pass_id,"attempt":attempt,"amount":r.claim_amount}),
        );
    }
}
fn log_event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"showstake\",\"version\":\"1.0.0\",\"event\":\"{name}\",\"data\":{data}}}"
    ));
}
#[cfg(test)]
#[path = "shared_vault_tests.rs"]
mod shared_vault_tests;
#[cfg(all(test, not(feature = "shared-yield")))]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, testing_env_with_promise_results};
    use near_sdk::{PromiseResult, testing_env};
    fn a(s: &str) -> AccountId {
        s.parse().unwrap()
    }
    fn ctx(who: &str, ms: u64, deposit: u128) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(a("escrow.testnet"))
            .predecessor_account_id(a(who))
            .block_timestamp(ms * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
    }
    fn rules(id: &str) -> EventRules {
        EventRules {
            event_id: id.into(),
            title: "Event".into(),
            location: "Room".into(),
            rules_text: "Rules".into(),
            deposit: U128(5_000_000),
            capacity: 2,
            reg_open: 1,
            reg_close: 10,
            checkin_open: 10,
            checkin_close: 20,
            finalize_deadline: 86_400_020,
        }
    }
    fn contract() -> MultiEventContract {
        ctx("creator.testnet", 0, 0);
        MultiEventContract::new(
            a("ft.testnet"),
            a("provider.testnet"),
            "MOCK_TESTNET".into(),
            "testnet".into(),
            "USDC".into(),
            "USDC".into(),
            6,
        )
    }
    fn create(c: &mut MultiEventContract, id: &str) {
        ctx("creator.testnet", 0, 0);
        let r = rules(id);
        let q = c.quote_create_event(r.clone(), a("creator.testnet"));
        ctx("creator.testnet", 0, q.0);
        c.create_event(r);
    }
    fn deposit(c: &mut MultiEventContract, id: &str, who: &str, commit: &str) {
        ctx("ft.testnet", 2, 0);
        let result = c.ft_on_transfer(
            a(who),
            U128(5_000_000),
            near_sdk::serde_json::json!({"version":1,"event_id":id,"commitment_id":commit})
                .to_string(),
        );
        assert!(matches!(result, PromiseOrValue::Value(U128(0))));
    }
    #[test]
    fn overlapping_events_refund_isolation_and_failed_retry() {
        let mut c = contract();
        create(&mut c, "first");
        create(&mut c, "second");
        deposit(&mut c, "first", "alice.testnet", "x");
        deposit(&mut c, "second", "alice.testnet", "x");
        ctx("creator.testnet", 3, 0);
        c.cancel_event("first".into());
        ctx("alice.testnet", 3, 1);
        c.claim("reg-0".into());
        assert_eq!(
            c.get_event_totals("second".into())["reserved_cash"],
            "5000000"
        );
        let mut b = VMContextBuilder::new();
        b.current_account_id(a("escrow.testnet"))
            .predecessor_account_id(a("escrow.testnet"));
        testing_env_with_promise_results(b.build(), PromiseResult::Failed);
        c.on_claim_result("first".into(), "reg-0".into(), 1);
        assert_eq!(c.get_event_totals("first".into())["liability"], "5000000");
        ctx("alice.testnet", 3, 1);
        c.claim("reg-0".into());
        assert_eq!(c.get_accounting()["pending"], "5000000");
    }
    #[test]
    fn wrong_event_callback_does_not_change_pending() {
        let mut c = contract();
        create(&mut c, "first");
        create(&mut c, "second");
        deposit(&mut c, "first", "alice.testnet", "x");
        ctx("creator.testnet", 3, 0);
        c.cancel_event("first".into());
        ctx("alice.testnet", 3, 1);
        c.claim("reg-0".into());
        let mut b = VMContextBuilder::new();
        b.current_account_id(a("escrow.testnet"))
            .predecessor_account_id(a("escrow.testnet"));
        testing_env_with_promise_results(b.build(), PromiseResult::Successful(vec![]));
        c.on_claim_result("second".into(), "reg-0".into(), 1);
        assert_eq!(c.get_accounting()["pending"], "5000000");
    }
    fn legacy(shares: u128) -> LegacyState {
        LegacyState {
            config: LegacyConfig {
                organizer: a("creator.testnet"),
                canonical_ft: a("ft.testnet"),
                token_symbol: "USDC".into(),
                token_name: "USDC".into(),
                token_decimals: 6,
                provider_account: a("provider.testnet"),
                provider_kind: "MOCK_TESTNET".into(),
            },
            event: None,
            registrations: LookupMap::new(b"ec-r".to_vec()),
            passes: LookupMap::new(b"ec-p".to_vec()),
            active: LookupMap::new(b"ec-a".to_vec()),
            commitments: LookupMap::new(b"ec-c".to_vec()),
            registration_ids: Vector::new(b"ec-i".to_vec()),
            next_registration: 0,
            rhea: LegacyRhea {
                paused: true,
                stage: LegacyStage::Idle,
                principal_cap: U128(0),
                shares: U128(shares),
                last_internal_balance: U128(0),
                baseline_ft: U128(0),
                expected_return: U128(0),
            },
        }
    }
    #[test]
    fn empty_legacy_migrates_preserving_config() {
        ctx("escrow.testnet", 0, 0);
        env::state_write(&legacy(0));
        let c = MultiEventContract::migrate_empty_legacy();
        assert_eq!(c.get_config()["canonical_ft"], "ft.testnet");
        assert_eq!(c.get_config()["provider_account"], "provider.testnet");
        assert_eq!(c.list_events(0, 50).len(), 0);
    }
    #[test]
    #[should_panic(expected = "legacy state is not empty")]
    fn funded_legacy_is_rejected() {
        ctx("escrow.testnet", 0, 0);
        env::state_write(&legacy(1));
        let _ = MultiEventContract::migrate_empty_legacy();
    }
    #[test]
    fn any_organizer_creates_independent_flat_views_and_pages() {
        let mut c = contract();
        create(&mut c, "first");
        let r = rules("second");
        ctx("second.testnet", 0, 0);
        let quote = c.quote_create_event(r.clone(), a("second.testnet"));
        ctx("second.testnet", 0, quote.0);
        c.create_event(r);
        assert_eq!(
            c.get_event("first".into()).unwrap()["organizer"],
            "creator.testnet"
        );
        let second = c.get_event("second".into()).unwrap();
        assert_eq!(second["organizer"], "second.testnet");
        assert_eq!(second["event_id"], "second");
        assert_eq!(c.list_events(0, 1).len(), 1);
        assert_eq!(c.list_events(1, 50)[0]["event_id"], "second");
        assert_eq!(c.get_block_timestamp_ms(), 0);
    }
    #[test]
    #[should_panic(expected = "exact storage quote required")]
    fn create_rejects_underfunded_storage() {
        let mut c = contract();
        let r = rules("first");
        let q = c.quote_create_event(r.clone(), a("creator.testnet"));
        ctx("creator.testnet", 0, q.0 - 1);
        c.create_event(r);
    }
    #[test]
    #[should_panic(expected = "event exists")]
    fn duplicate_event_rejected() {
        let mut c = contract();
        create(&mut c, "first");
        create(&mut c, "first");
    }
    #[test]
    fn mainnet_provider_gate_returns_deposit_even_if_event_unpaused() {
        let mut c = contract();
        create(&mut c, "first");
        let mut e = c.events.get(&"first".to_string()).unwrap();
        e.paused = false;
        e.principal_cap = U128(10_000_000);
        c.events.insert(&"first".to_string(), &e);
        c.provider_kind = "RHEA_MAINNET".into();
        c.network = "mainnet".into();
        ctx("ft.testnet", 2, 0);
        let result = c.ft_on_transfer(
            a("alice.testnet"),
            U128(5_000_000),
            near_sdk::serde_json::json!({"version":1,"event_id":"first","commitment_id":"x"})
                .to_string(),
        );
        assert!(matches!(result, PromiseOrValue::Value(U128(5_000_000))));
        assert_eq!(c.get_config()["provider_enabled"], false);
        assert_eq!(
            c.get_event_totals("first".into())["accepted_principal"],
            "0"
        );
        assert!(c.get_registration("reg-0".into()).is_none());
    }
    #[test]
    #[should_panic(expected = "metadata bounds")]
    fn rejects_catalog_unsafe_event_id() {
        let c = contract();
        let r = rules("event/unsafe");
        let _ = c.quote_create_event(r, a("creator.testnet"));
    }
    #[test]
    #[should_panic(expected = "invalid times")]
    fn rejects_time_above_year_9999() {
        let c = contract();
        let mut r = rules("event-safe");
        r.checkin_close = 253_402_300_799_999;
        r.finalize_deadline = r.checkin_close + 86_400_000;
        let _ = c.quote_create_event(r, a("creator.testnet"));
    }
}
