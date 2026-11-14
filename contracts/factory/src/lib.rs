// SPDX-License-Identifier: MIT
//! ShowStake v2 permissionless one-event leaf factory/registry — local slice.
//!
//! Scope of this file (deliberately narrow, D033/D039):
//!   * one immutable canonical FT / network / leaf policy identity per factory,
//!   * deterministic bounded child account IDs derived from
//!     (organizer, request nonce),
//!   * caller-funded atomic child provisioning: create account + transfer exact
//!     child storage funding + deploy the frozen accepted leaf Wasm + call
//!     `new(organizer = original caller)`, all in one child receipt,
//!   * a private factory callback that marks the registry row `Ready` only on
//!     success, and refunds the child funding exactly once on failure,
//!   * caller-funded measured registry growth and prepaid global-index reserve,
//!   * replay/idempotency per (organizer, nonce) and a bounded permissionless
//!     recovery probe for a lost callback,
//!   * native-only accounting; no FT interface, no event/pass/seat/claim.
//!
//! The factory never calls `publish_event`. The organizer publishes in a
//! separate transaction directly on the child so the frozen leaf's
//! `predecessor == organizer` check remains authoritative. Child accounts are
//! keyless: no FullAccess (or any) access key is added to them, and the
//! factory adds no key to the organizer either.
//!
//! Provenance: original Rust written for ShowStake v2 against near-sdk 5.30.1.
//! Leaf bytes are supplied per call and checked against the pinned candidate hash.
//! The leaf is a review candidate, not a deployment or provider acceptance.

use near_sdk::collections::{LookupMap, Vector};
use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};
use serde::Deserialize;

/// Factory policy identity. Distinct from the leaf identity; a factory built
/// from this source must never be labelled with another rule set.
#[cfg(not(feature = "factory-event"))]
pub const FACTORY_POLICY_IDENTITY: &str = "showstake-factory-d039-global-ready/2";
#[cfg(feature = "factory-event")]
pub const FACTORY_POLICY_IDENTITY: &str = "showstake-factory-atomic-event/3";

/// The only leaf policy identity accepted by this factory generation.
pub const LEAF_POLICY_IDENTITY: &str = "showstake-native-usdc-event/1";
#[cfg(not(feature = "factory-event"))]
pub const MAINNET_LEAF_POLICY_IDENTITY: &str = "showstake-native-usdc-rhea-linked-withdraw-review/2";
#[cfg(feature = "factory-event")]
pub const MAINNET_LEAF_POLICY_IDENTITY: &str = "showstake-native-usdc-factory-rhea/3";

// Exact root Borsh layout of the deployed multi-event CREATE-only generation.
// Collection value types are phantom parameters and are not serialized in the root.
#[cfg(feature = "factory-event")]
#[near(serializers = [borsh])]
struct EmptyMultiEventState {
    canonical_ft: AccountId, provider_account: AccountId, provider_kind: String,
    network: String, token_symbol: String, token_name: String, token_decimals: u8,
    events: LookupMap<String, ()>, event_ids: Vector<String>,
    registrations: LookupMap<String, ()>, passes: LookupMap<String, ()>,
    active: LookupMap<String, ()>, commitments: LookupMap<String, ()>,
    registration_event: LookupMap<String, ()>, next_registration: u64,
    accepted: u128, paid: u128, pending: u128, liability: u128, reserved_cash: u128,
    global_operation: Option<String>,
}

/// Factory state/schema version. No migration exists; a new layout is a new
/// factory deployment.
#[cfg(not(feature = "factory-event"))]
pub const SCHEMA_VERSION: u32 = 2;
#[cfg(feature = "factory-event")]
pub const SCHEMA_VERSION: u32 = 3;

/// Child ID = 8 digest bytes (16 lowercase hex chars) + "." + parent.
pub const CHILD_ID_HEX_LEN: usize = 16;

/// Longest factory account ID that still allows a 64-character child ID with
/// the fixed 17-byte prefix. Enforced at initialization.
pub const PARENT_MAX_LEN: usize = 47;

/// Pinned safety margin on top of the measured child storage footprint. Its
/// exact yocto cost stays in the keyless child as residual balance; the
/// evidence records it instead of pretending it is free.
pub const CHILD_STORAGE_MARGIN_BYTES: u128 = 128;

/// Measured constant overhead of a keyless child account beyond the code bytes
/// and the serialized config-string bytes: account record, code key, contract
/// state key/prefixes and Borsh length prefixes. Pinned from a real Sandbox
/// deployment of the embedded artifact (see evidence manifest) and validated
/// by the runner.
pub const CHILD_ACCOUNT_BASE_BYTES: u128 = 1024;

/// Blocks after request creation before permissionless `resolve_request` may
/// probe a still-`Pending` request.
pub const PENDING_TIMEOUT_BLOCKS: u64 = 100;

/// Gas forwarded to the single atomic child receipt (create + transfer +
/// deploy + `new`). The accepted v6 deploy+init measured 28.88 Tgas.
pub const CHILD_RECEIPT_GAS_TGAS: u64 = 60;

/// Gas forwarded to the private provisioning callback (state write + at most
/// one refund transfer).
pub const PROVISION_CALLBACK_GAS_TGAS: u64 = 25;

/// Enforced minimum prepaid gas for `provision`: 300 Tgas, including the
/// large deploy action costs as well as child (60) and callback (25) gas.
/// Sandbox verification for this profile is pending; unused gas is refunded.
pub const MIN_PROVISION_GAS_TGAS: u64 = 300;

/// Gas forwarded to the leaf `get_config` recovery probe.
pub const RESOLVE_PROBE_GAS_TGAS: u64 = 20;

/// Gas forwarded to the private recovery callback.
pub const RESOLVE_CALLBACK_GAS_TGAS: u64 = 20;

/// Enforced minimum prepaid gas for `resolve_request`.
pub const MIN_RESOLVE_GAS_TGAS: u64 = 50;

/// Bounded public list page size.
pub const MAX_LIST_LIMIT: u32 = 20;

/// Largest nonce exactly representable by JavaScript JSON number consumers.
pub const MAX_SAFE_REQUEST_NONCE: u64 = 9_007_199_254_740_991;

/// Review candidate leaf: bytes are supplied by the caller and checked on-chain.
pub const LEAF_WASM_LEN: usize = 235060;
pub const LEAF_SHA256: [u8; 32] = [
    0x49, 0xa5, 0x91, 0xba, 0x26, 0xa4, 0xa2, 0x3d, 0x05, 0xc0, 0x1c, 0xc3, 0x43, 0x77, 0x9f, 0x1c,
    0x66, 0xaa, 0x5d, 0xa0, 0x38, 0x4e, 0x3a, 0x66, 0x3a, 0x37, 0xf4, 0xe5, 0xed, 0xb5, 0x9b, 0x70,
];
#[cfg(feature = "factory-event")]
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct EventRules {
    pub event_id: String, pub title: String, pub location: String, pub rules_text: String,
    pub finalize_deadline: u64, pub deposit: U128, pub capacity: u32,
    pub reg_open: u64, pub reg_close: u64, pub checkin_open: u64, pub checkin_close: u64,
}

#[cfg(feature = "factory-event")]
#[near(serializers = [json])]
pub struct EventQuoteView {
    pub organizer: AccountId, pub request_nonce: u64, pub child_id: AccountId,
    pub code_config_funding: U128, pub rules_funding: U128, pub participant_reserve: U128,
    pub child_funding: U128, pub registry_fee: U128, pub total: U128,
    pub attached_gas_tgas: u64, pub pending_timeout_blocks: u64,
    pub canonical_ft: AccountId, pub network: String, pub provider_account: AccountId,
    pub provider_kind: String, pub leaf_policy_version: String, pub leaf_code_sha256: String,
}

// These values must be fixed at build time after building the factory-event leaf.
#[cfg(feature = "factory-event")]
fn pinned_leaf() -> (usize, [u8; 32]) {
    let length = env!("SHOWSTAKE_LEAF_WASM_LEN").parse::<usize>().expect("invalid leaf length");
    let hash = env!("SHOWSTAKE_LEAF_SHA256").as_bytes();
    assert_eq!(hash.len(), 64, "invalid leaf hash");
    let mut out = [0u8; 32];
    for i in 0..32 {
        let nibble = |c: u8| -> u8 { match c { b'0'..=b'9' => c-b'0', b'a'..=b'f' => c-b'a'+10, _ => panic!("invalid lowercase leaf hash") } };
        out[i] = nibble(hash[2*i]) * 16 + nibble(hash[2*i+1]);
    }
    (length, out)
}
#[cfg(not(feature = "factory-event"))]
fn pinned_leaf() -> (usize, [u8; 32]) { (LEAF_WASM_LEN, LEAF_SHA256) }

#[cfg(feature = "factory-event")]
type EventRulesCompat = EventRules;
#[cfg(not(feature = "factory-event"))]
type EventRulesCompat = ();

const MAIN_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const MAIN_PROVIDER: &str = "contract.main.burrow.near";

/// Request lifecycle. `Ready`/`Failed` are terminal; no record is deleted and
/// no child is overwritten.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProvisionState {
    Pending,
    Ready,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefundState {
    None,
    InFlight,
    Claimable,
    Paid,
}

/// Immutable factory configuration.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Config {
    pub canonical_ft: AccountId,
    pub network: String,
    pub provider_account: AccountId,
    pub provider_kind: String,
    pub leaf_policy_version: String,
    pub leaf_code_sha256: [u8; 32],
}

/// Per-(organizer, request_nonce) registry row. Every field except the two
/// account IDs is fixed width, so terminal transitions rewrite an entry
/// without creating uncharged storage.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct RequestRecord {
    pub organizer: AccountId,
    pub request_nonce: u64,
    pub child_id: AccountId,
    pub state: ProvisionState,
    pub attempt: u32,
    pub created_block: u64,
    pub created_at_ms: u64,
    pub ready_at_ms: u64,
    pub child_funding: U128,
    pub registry_fee: U128,
    pub attached: U128,
    pub excess_refunded: U128,
    pub refund_state: RefundState,
    pub refund_attempt: u32,
}

/// Per-child registry row keyed by child account ID.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct ChildRecord {
    pub child_id: AccountId,
    pub organizer: AccountId,
    pub request_nonce: u64,
    pub state: ProvisionState,
    pub created_at_ms: u64,
    pub ready_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct FactoryConfigView {
    pub factory_account: AccountId,
    pub canonical_ft: AccountId,
    pub network: String,
    pub provider_account: AccountId,
    pub provider_kind: String,
    pub leaf_code_len: u64,
    pub leaf_policy_version: String,
    pub leaf_code_sha256: String,
    pub factory_policy_identity: String,
    pub schema_version: u32,
    pub parent_max_len: u32,
    pub pending_timeout_blocks: u64,
    pub min_provision_gas_tgas: u64,
    pub min_resolve_gas_tgas: u64,
    pub child_storage_margin_bytes: U128,
    pub storage_byte_cost: U128,
    #[cfg(feature = "factory-event")]
    pub atomic_event_initialization: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RequestView {
    pub organizer: AccountId,
    pub request_nonce: u64,
    pub child_id: AccountId,
    pub state: ProvisionState,
    pub attempt: u32,
    pub created_block: u64,
    pub created_at_ms: u64,
    pub ready_at_ms: u64,
    pub child_funding: U128,
    pub registry_fee: U128,
    pub attached: U128,
    pub excess_refunded: U128,
    pub refund_state: RefundState,
    pub refund_attempt: u32,
    pub leaf_code_sha256: String,
    pub canonical_ft: AccountId,
    pub network: String,
    pub leaf_policy_version: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ChildView {
    pub child_id: AccountId,
    pub organizer: AccountId,
    pub request_nonce: u64,
    pub state: ProvisionState,
    pub created_at_ms: u64,
    pub ready_at_ms: u64,
    pub leaf_code_sha256: String,
    pub canonical_ft: AccountId,
    pub network: String,
    pub leaf_policy_version: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct QuoteView {
    pub organizer: AccountId,
    pub child_funding: U128,
    pub registry_fee: U128,
    pub total: U128,
    pub attached_gas_tgas: u64,
    pub pending_timeout_blocks: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct NativeAccountingView {
    pub account_balance: U128,
    pub account_locked: U128,
    pub storage_usage: u64,
    pub registry_fees_collected: U128,
    pub funding_committed: U128,
    pub funding_delivered: U128,
    pub funding_refunded: U128,
    pub funding_held: U128,
    pub total_requests: u64,
    pub ft_interface_present: bool,
}

/// Minimal shape of the frozen leaf's `get_config` JSON, used only by the
/// permissionless recovery probe. No other leaf ABI is assumed.
#[derive(Deserialize)]
struct LeafConfigProbe {
    organizer: AccountId,
    canonical_ft: AccountId,
    network: String,
    policy_version: String,
    provider_account: AccountId,
    provider_kind: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    /// (organizer, request_nonce) -> request row.
    requests: LookupMap<(AccountId, u64), RequestRecord>,
    /// (organizer, registry index) -> child account ID (append-only order).
    children: LookupMap<(AccountId, u64), AccountId>,
    /// child account ID -> child row.
    child_ids: LookupMap<AccountId, ChildRecord>,
    /// organizer -> number of registry rows/children.
    counts: LookupMap<AccountId, u64>,
    /// Ready children in callback completion order, across all organizers.
    ready_children: Vector<AccountId>,
    /// Measured registry growth plus prepaid global-index reserves.
    registry_fees_collected: u128,
    /// Native child funding committed by callers.
    funding_committed: u128,
    /// Funding that reached a successfully provisioned child.
    funding_delivered: u128,
    /// Funding returned after a failed provision/resolve.
    funding_refunded: u128,
    total_requests: u64,
}

#[near]
impl Contract {
    /// One-time initialization. `canonical_ft`, `network` and the leaf policy
    /// identity are immutable for the lifetime of this factory. The factory
    /// has no admin/owner parameter: no account can mutate this config.
    #[init]
    pub fn new(
        canonical_ft: AccountId,
        network: String,
        policy_version: String,
        provider_account: AccountId,
        provider_kind: String,
    ) -> Self {
        require!(
            valid_text(&network),
            "network must be 1..=64 printable ASCII chars"
        );
        require!(
            policy_version
                == if network == "mainnet" {
                    MAINNET_LEAF_POLICY_IDENTITY
                } else {
                    LEAF_POLICY_IDENTITY
                },
            "policy_version must equal the pinned leaf identity for this network"
        );
        let factory_account = env::current_account_id();
        require!(
            factory_account.as_str().len() >= 2 && factory_account.as_str().len() <= PARENT_MAX_LEN,
            "factory account id length must be 2..=47 for bounded child ids"
        );
        match network.as_str() {
            "mainnet" => require!(
                canonical_ft.as_str() == MAIN_USDC
                    && provider_account.as_str() == MAIN_PROVIDER
                    && provider_kind == "RHEA_MAINNET"
                    && !factory_account.as_str().ends_with(".testnet"),
                "invalid mainnet identity"
            ),
            "testnet" => require!(
                factory_account.as_str().ends_with(".testnet")
                    && canonical_ft.as_str().ends_with(".testnet")
                    && provider_account.as_str().ends_with(".testnet")
                    && provider_kind == "MOCK_TESTNET",
                "invalid testnet identity"
            ),
            _ => env::panic_str("unsupported network"),
        }
        require!(
            canonical_ft != provider_account && provider_account != factory_account,
            "invalid provider"
        );
        let leaf_code_sha256 = pinned_leaf().1;
        Self {
            config: Config {
                canonical_ft,
                network,
                provider_account,
                provider_kind,
                leaf_policy_version: policy_version,
                leaf_code_sha256,
            },
            requests: LookupMap::new(b"rq".to_vec()),
            children: LookupMap::new(b"ch".to_vec()),
            child_ids: LookupMap::new(b"ci".to_vec()),
            counts: LookupMap::new(b"ct".to_vec()),
            ready_children: Vector::new(b"gr".to_vec()),
            registry_fees_collected: 0,
            funding_committed: 0,
            funding_delivered: 0,
            funding_refunded: 0,
            total_requests: 0,
        }
    }

    /// Upgrade-only migration. External FT balance and provider position must
    /// also be freshly checked before deployment; this synchronous method cannot
    /// inspect another account. It accepts only the exact empty root layout.
    #[cfg(feature = "factory-event")]
    #[private]
    #[init(ignore_state)]
    pub fn migrate_empty_multievent() -> Self {
        let old: EmptyMultiEventState = env::state_read().expect("missing or incompatible multi-event state");
        require!(old.event_ids.is_empty() && old.next_registration == 0 && old.accepted == 0 && old.paid == 0 && old.pending == 0 && old.liability == 0 && old.reserved_cash == 0 && old.global_operation.is_none(), "multi-event state not empty");
        require!(old.network == "mainnet" && old.provider_kind == "RHEA_MAINNET" && old.canonical_ft.as_str() == MAIN_USDC && old.provider_account.as_str() == MAIN_PROVIDER && old.token_symbol == "USDC" && old.token_name == "USDC" && old.token_decimals == 6, "unexpected old identity");
        Self::new(old.canonical_ft, old.network, MAINNET_LEAF_POLICY_IDENTITY.to_string(), old.provider_account, old.provider_kind)
    }

    // --------------------------------------------------------------- views

    pub fn get_config(&self) -> FactoryConfigView {
        self.config_view()
    }

    pub fn get_leaf_code_hash(&self) -> String {
        to_hex(&self.config.leaf_code_sha256)
    }

    pub fn get_schema_version(&self) -> u32 {
        SCHEMA_VERSION
    }

    pub fn get_child_id(&self, organizer: AccountId, request_nonce: u64) -> AccountId {
        self.child_id_for(&organizer, request_nonce)
    }

    /// Exact next-request quote for `organizer`: deterministic child funding
    /// plus the serialized registry-row growth at the current storage price.
    /// The fee combines measured immediate growth and a future index reserve.
    /// This view mirrors the row sizes so a call can attach exactly `total`.
    #[cfg(not(feature = "factory-event"))]
    pub fn quote_provision(&self, organizer: AccountId) -> QuoteView {
        let index = self.counts.get(&organizer).unwrap_or(0);
        let child_id = self.child_id_for(&organizer, 0);
        let child_funding = self.child_funding(&organizer, &child_id);
        let registry_fee = self.registry_growth_quote(&organizer, &child_id, index);
        QuoteView {
            organizer,
            child_funding: U128(child_funding),
            registry_fee: U128(registry_fee),
            total: U128(child_funding.saturating_add(registry_fee)),
            attached_gas_tgas: MIN_PROVISION_GAS_TGAS,
            pending_timeout_blocks: PENDING_TIMEOUT_BLOCKS,
        }
    }

    #[cfg(feature = "factory-event")]
    pub fn quote_provision_event(&self, organizer: AccountId, request_nonce: u64, rules: EventRules) -> EventQuoteView {
        require!(request_nonce <= MAX_SAFE_REQUEST_NONCE, "request nonce exceeds safe JSON integer");
        require!(self.requests.get(&(organizer.clone(), request_nonce)).is_none(), "request nonce already used");
        let child_id = self.child_id_for(&organizer, request_nonce);
        let code_config = self.child_funding(&organizer, &child_id);
        let (rules_cost, participant_cost) = self.event_storage_costs(&rules);
        let child_funding = code_config.checked_add(rules_cost).and_then(|v| v.checked_add(participant_cost)).expect("child funding overflow");
        let registry_fee = self.registry_growth_quote(&organizer, &child_id, self.counts.get(&organizer).unwrap_or(0));
        let total = child_funding.checked_add(registry_fee).expect("quote overflow");
        EventQuoteView { organizer, request_nonce, child_id, code_config_funding: U128(code_config), rules_funding: U128(rules_cost), participant_reserve: U128(participant_cost), child_funding: U128(child_funding), registry_fee: U128(registry_fee), total: U128(total), attached_gas_tgas: MIN_PROVISION_GAS_TGAS, pending_timeout_blocks: PENDING_TIMEOUT_BLOCKS, canonical_ft: self.config.canonical_ft.clone(), network: self.config.network.clone(), provider_account: self.config.provider_account.clone(), provider_kind: self.config.provider_kind.clone(), leaf_policy_version: self.config.leaf_policy_version.clone(), leaf_code_sha256: to_hex(&self.config.leaf_code_sha256) }
    }

    #[cfg(feature = "factory-event")]
    fn event_storage_costs(&self, rules: &EventRules) -> (u128, u128) {
        require!(rules.capacity > 0 && rules.capacity <= 200 && rules.deposit.0 > 0, "invalid event economics");
        require!(!rules.event_id.is_empty() && rules.event_id.len() <= 128 && !rules.title.is_empty() && rules.title.len() <= 256 && !rules.location.is_empty() && rules.location.len() <= 512 && !rules.rules_text.is_empty() && rules.rules_text.len() <= 8192, "event metadata bounds");
        require!(rules.reg_open < rules.reg_close && rules.reg_close <= rules.checkin_open && rules.checkin_open < rules.checkin_close && rules.checkin_close < rules.finalize_deadline, "invalid event times");
        if self.config.network == "mainnet" { require!(rules.checkin_close.checked_add(86_400_000) == Some(rules.finalize_deadline), "mainnet requires 24h finalization deadline"); }
        rules.deposit.0.checked_mul(rules.capacity as u128).expect("cap overflow");
        let price = env::storage_byte_cost().as_yoctonear();
        let rules_bytes = borsh_len(rules).checked_add(256).expect("rules reserve overflow");
        let participant_bytes = (rules.capacity as u128).checked_mul(4096).expect("participant reserve overflow");
        (rules_bytes.checked_mul(price).expect("rules cost overflow"), participant_bytes.checked_mul(price).expect("participant cost overflow"))
    }

    pub fn get_request(&self, organizer: AccountId, request_nonce: u64) -> RequestView {
        let record = self
            .requests
            .get(&(organizer, request_nonce))
            .unwrap_or_else(|| env::panic_str("provision request not found"));
        self.request_view(&record)
    }

    pub fn get_child(&self, child_id: AccountId) -> ChildView {
        let record = self
            .child_ids
            .get(&child_id)
            .unwrap_or_else(|| env::panic_str("child not registered"));
        self.child_view(&record)
    }

    /// Bounded append-only listing in provisioning order.
    pub fn list_children(
        &self,
        organizer: AccountId,
        from_index: u64,
        limit: u32,
    ) -> Vec<ChildView> {
        require!(
            limit >= 1 && limit <= MAX_LIST_LIMIT,
            "limit must be 1..=20"
        );
        let count = self.counts.get(&organizer).unwrap_or(0);
        let mut out = Vec::new();
        let mut index = from_index;
        while index < count && out.len() < limit as usize {
            let child_id = self
                .children
                .get(&(organizer.clone(), index))
                .unwrap_or_else(|| env::panic_str("registry index missing"));
            let record = self
                .child_ids
                .get(&child_id)
                .unwrap_or_else(|| env::panic_str("child registry row missing"));
            out.push(self.child_view(&record));
            index = index
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("registry index overflow"));
        }
        out
    }

    /// Bounded global listing of Ready children in callback completion order.
    pub fn list_all_children(&self, from_index: u64, limit: u32) -> Vec<ChildView> {
        require!(
            limit >= 1 && limit <= MAX_LIST_LIMIT,
            "limit must be 1..=20"
        );
        let mut out = Vec::new();
        let mut index = from_index;
        while index < self.ready_children.len() && out.len() < limit as usize {
            let child_id = self
                .ready_children
                .get(index)
                .unwrap_or_else(|| env::panic_str("global registry index missing"));
            let record = self
                .child_ids
                .get(&child_id)
                .unwrap_or_else(|| env::panic_str("child registry row missing"));
            require!(
                record.state == ProvisionState::Ready,
                "global registry row not ready"
            );
            out.push(self.child_view(&record));
            index = index
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("registry index overflow"));
        }
        out
    }

    /// Native-only accounting. `funding_held` is zero after every callback
    /// resolves; `account_balance` is the live factory balance. This contract
    /// has no FT entry point, so `ft_interface_present` is always false and
    /// leaf FT escrow is never included here.
    pub fn get_native_accounting(&self) -> NativeAccountingView {
        let committed = self.funding_committed;
        let delivered = self.funding_delivered;
        let refunded = self.funding_refunded;
        let held = committed
            .checked_sub(delivered)
            .and_then(|value| value.checked_sub(refunded))
            .unwrap_or_else(|| env::panic_str("native accounting underflow"));
        NativeAccountingView {
            account_balance: U128(env::account_balance().as_yoctonear()),
            account_locked: U128(env::account_locked_balance().as_yoctonear()),
            storage_usage: env::storage_usage(),
            registry_fees_collected: U128(self.registry_fees_collected),
            funding_committed: U128(committed),
            funding_delivered: U128(delivered),
            funding_refunded: U128(refunded),
            funding_held: U128(held),
            total_requests: self.total_requests,
            ft_interface_present: false,
        }
    }

    // ------------------------------------------------------------ provision

    /// Provision one dedicated one-event leaf instance for the caller.
    ///
    /// The caller attaches at least the exact child storage funding plus the
    /// measured registry growth and the global-index reserve.
    /// The child batch is atomic: create account, transfer child funding,
    /// deploy the frozen leaf Wasm and call `new` with the caller as the
    /// immutable organizer. The private callback is the only path that can
    /// mark the row `Ready`.
    ///
    /// Replaying an existing `(organizer, nonce)` never creates or charges a
    /// second child; attached native is returned in full. A replay of a
    /// `Pending` row traps; use `resolve_request` after the pending timeout.
    #[cfg(not(feature = "factory-event"))]
    #[payable]
    pub fn provision(
        &mut self,
        request_nonce: u64,
        code: Base64VecU8,
    ) -> PromiseOrValue<RequestView> {
        self.provision_inner(request_nonce, code, None)
    }

    #[cfg(feature = "factory-event")]
    #[payable]
    pub fn provision_event(&mut self, request_nonce: u64, rules: EventRules, code: Base64VecU8) -> PromiseOrValue<RequestView> {
        self.provision_inner(request_nonce, code, Some(rules))
    }

    fn provision_inner(&mut self, request_nonce: u64, code: Base64VecU8, rules: Option<EventRulesCompat>) -> PromiseOrValue<RequestView> {
        #[cfg(feature = "factory-event")]
        require!(rules.is_some(), "event rules required");
        require!(
            request_nonce <= MAX_SAFE_REQUEST_NONCE,
            "request nonce exceeds safe JSON integer"
        );
        let organizer = env::predecessor_account_id();
        let attached = env::attached_deposit().as_yoctonear();
        let key = (organizer.clone(), request_nonce);
        if let Some(record) = self.requests.get(&key) {
            require!(
                record.state != ProvisionState::Pending,
                "provision request is pending; retry after the callback or use resolve_request"
            );
            require!(attached == 0, "replay requires zero deposit");
            return self.replay(record, attached);
        }

        require!(
            code.0.len() == pinned_leaf().0 && env::sha256(&code.0).as_slice() == self.config.leaf_code_sha256,
            "invalid leaf code"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(MIN_PROVISION_GAS_TGAS),
            "insufficient prepaid gas for provision"
        );

        let child_id = self.child_id_for(&organizer, request_nonce);
        let mut child_funding = self.child_funding(&organizer, &child_id);
        #[cfg(feature = "factory-event")]
        {
            let (rules_cost, participant_cost) = self.event_storage_costs(rules.as_ref().unwrap());
            child_funding = child_funding.checked_add(rules_cost).and_then(|v| v.checked_add(participant_cost)).expect("child funding overflow");
        }
        require!(child_funding > 0, "child funding must be positive");
        let index = self.counts.get(&organizer).unwrap_or(0);
        let quoted = self
            .registry_growth_quote(&organizer, &child_id, index)
            .checked_add(child_funding)
            .expect("quote overflow");
        require!(attached == quoted, "attach exact quote");
        let attempt: u32 = 1;
        let now = env::block_timestamp_ms();
        let created_block = env::block_height();

        // Measure the exact registry growth of this request: request row,
        // child row, per-organizer index row and (on the first request) the
        // count row. Add the prepaid future Ready-index entry to this measurement.
        let before = env::storage_usage();
        let placeholder = RequestRecord {
            organizer: organizer.clone(),
            request_nonce,
            child_id: child_id.clone(),
            state: ProvisionState::Pending,
            attempt,
            created_block,
            created_at_ms: now,
            ready_at_ms: 0,
            child_funding: U128(child_funding),
            registry_fee: U128(0),
            attached: U128(attached),
            excess_refunded: U128(0),
            refund_state: RefundState::None,
            refund_attempt: 0,
        };
        let child_record = ChildRecord {
            child_id: child_id.clone(),
            organizer: organizer.clone(),
            request_nonce,
            state: ProvisionState::Pending,
            created_at_ms: now,
            ready_at_ms: 0,
        };
        self.requests.insert(&key, &placeholder);
        self.child_ids.insert(&child_id, &child_record);
        self.children.insert(&(organizer.clone(), index), &child_id);
        self.counts.insert(
            &organizer,
            &index
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("registry index overflow")),
        );
        let after = env::storage_usage();
        let registry_fee = storage_cost(before, after)
            .checked_add(self.ready_index_cost(&child_id))
            .unwrap_or_else(|| env::panic_str("registry fee overflow"));
        let required = child_funding
            .checked_add(registry_fee)
            .unwrap_or_else(|| env::panic_str("provision quote overflow"));
        require!(
            attached == required,
            format!(
                "insufficient attached deposit: attached {attached}, requires {required} (child {child_funding} + registry {registry_fee})"
            )
        );
        let excess = attached - required;

        // Final row write keeps the same Borsh size as the placeholder.
        let record = RequestRecord {
            registry_fee: U128(registry_fee),
            excess_refunded: U128(excess),
            ..placeholder
        };
        self.requests.insert(&key, &record);

        self.registry_fees_collected = self
            .registry_fees_collected
            .checked_add(registry_fee)
            .unwrap_or_else(|| env::panic_str("registry fee overflow"));
        self.funding_committed = self
            .funding_committed
            .checked_add(child_funding)
            .unwrap_or_else(|| env::panic_str("funding counter overflow"));
        self.total_requests = self
            .total_requests
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("request counter overflow"));

        let mut init_args = near_sdk::serde_json::json!({
            "organizer": organizer,
            "canonical_ft": self.config.canonical_ft,
            "provider_account": self.config.provider_account,
            "token_symbol": "USDC",
            "token_name": "USDC",
            "token_decimals": 6,
            "provider_kind": self.config.provider_kind,
        });
        #[cfg(feature = "factory-event")]
        { init_args["rules"] = near_sdk::serde_json::to_value(rules.expect("event rules required")).expect("rules encoding failed"); }
        let init_args = init_args.to_string().into_bytes();
        let callback_args = near_sdk::serde_json::json!({
            "organizer": organizer,
            "request_nonce": request_nonce,
            "child_id": child_id,
            "attempt": attempt,
        })
        .to_string()
        .into_bytes();

        log_event(
            "ProvisionRequested",
            near_sdk::serde_json::json!({
                "organizer": organizer,
                "request_nonce": request_nonce,
                "child_id": child_id,
                "child_funding": child_funding.to_string(),
                "registry_fee": registry_fee.to_string(),
                "attached": attached.to_string(),
                "excess_refunded": excess.to_string(),
                "leaf_code_sha256": to_hex(&self.config.leaf_code_sha256),
                "canonical_ft": self.config.canonical_ft,
                "network": self.config.network,
                "leaf_policy_version": self.config.leaf_policy_version,
            }),
        );

        // One atomic child receipt: create + fund + deploy + initialize. The
        // private callback resolves the registry row only after this receipt
        // finishes, so no state can be marked Ready by a partial batch.
        let promise = Promise::new(child_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(child_funding))
            .deploy_contract(code.0)
            .function_call(
                if cfg!(feature = "factory-event") { "new_with_event" } else { "new" }.to_string(),
                init_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(CHILD_RECEIPT_GAS_TGAS),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_provision".to_string(),
                callback_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(PROVISION_CALLBACK_GAS_TGAS),
            ));
        PromiseOrValue::Promise(promise)
    }

    /// Permissionless recovery for a `Pending` request whose private callback
    /// was lost. Only callable after `PENDING_TIMEOUT_BLOCKS`; probes the
    /// child's frozen `get_config` and finalizes exactly once in the private
    /// callback. Two concurrent probes are harmless: the first terminal write
    /// wins and the second callback no-ops.
    pub fn resolve_request(&mut self, organizer: AccountId, request_nonce: u64) -> Promise {
        let record = self
            .requests
            .get(&(organizer.clone(), request_nonce))
            .unwrap_or_else(|| env::panic_str("provision request not found"));
        require!(
            record.state == ProvisionState::Pending,
            "provision request is not pending"
        );
        let ready_block = record
            .created_block
            .checked_add(PENDING_TIMEOUT_BLOCKS)
            .unwrap_or_else(|| env::panic_str("pending timeout overflow"));
        require!(
            env::block_height() >= ready_block,
            "pending timeout has not elapsed"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(MIN_RESOLVE_GAS_TGAS),
            "insufficient prepaid gas for resolve"
        );
        log_event(
            "ResolveRequested",
            near_sdk::serde_json::json!({
                "organizer": organizer,
                "request_nonce": request_nonce,
                "child_id": record.child_id,
                "created_block": record.created_block,
                "ready_block": ready_block,
                "resolved_by": env::predecessor_account_id(),
            }),
        );
        let callback_args = near_sdk::serde_json::json!({
            "organizer": organizer,
            "request_nonce": request_nonce,
        })
        .to_string()
        .into_bytes();
        Promise::new(record.child_id.clone())
            .function_call(
                "get_config".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(RESOLVE_PROBE_GAS_TGAS),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_resolve".to_string(),
                callback_args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(RESOLVE_CALLBACK_GAS_TGAS),
            ))
    }

    /// Private provisioning callback. Only the factory can call it. It
    /// verifies the stored request and attempt, then:
    ///   * success -> `Ready`, `RegistryReady` (child batch fully applied);
    ///   * failure -> `Failed`, child funding refunded exactly once.
    /// A duplicate callback for a terminal row is a no-op; mismatched
    /// arguments trap. No external caller can reach this method.
    #[private]
    pub fn on_provision(
        &mut self,
        organizer: AccountId,
        request_nonce: u64,
        child_id: AccountId,
        attempt: u32,
    ) -> PromiseOrValue<RequestView> {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "private callback"
        );
        require!(
            env::promise_results_count() == 1,
            "provision callback requires exactly one promise result"
        );
        let key = (organizer.clone(), request_nonce);
        let record = self
            .requests
            .get(&key)
            .unwrap_or_else(|| env::panic_str("provision request not found"));
        require!(
            record.organizer == organizer
                && record.child_id == child_id
                && record.attempt == attempt,
            "provision callback does not match the stored request"
        );
        if record.state != ProvisionState::Pending {
            return PromiseOrValue::Value(self.request_view(&record));
        }
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(near_sdk::PromiseError::Failed) => false,
            Err(_) => return PromiseOrValue::Value(self.request_view(&record)),
        };
        self.finish_provision(record, success, false)
    }

    /// Private recovery callback for `resolve_request`. The probe must decode
    /// to the exact frozen config; any failed or mismatched probe remains pending.
    #[private]
    pub fn on_resolve(
        &mut self,
        organizer: AccountId,
        request_nonce: u64,
    ) -> PromiseOrValue<RequestView> {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "private callback"
        );
        require!(
            env::promise_results_count() == 1,
            "resolve callback requires exactly one promise result"
        );
        let key = (organizer.clone(), request_nonce);
        let record = self
            .requests
            .get(&key)
            .unwrap_or_else(|| env::panic_str("provision request not found"));
        require!(
            record.organizer == organizer,
            "resolve callback does not match the stored request"
        );
        if record.state != ProvisionState::Pending {
            return PromiseOrValue::Value(self.request_view(&record));
        }
        let matched = match env::promise_result_checked(0, 4096) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<LeafConfigProbe>(&bytes)
                .map(|probe| self.probe_matches(&record.organizer, &probe))
                .unwrap_or(false),
            _ => false,
        };
        if matched {
            self.finish_provision(record, true, true)
        } else {
            PromiseOrValue::Value(self.request_view(&record))
        }
    }

    /// Only the original organizer can retry a refund whose previous receipt failed.
    pub fn claim_failed_funding(&mut self, request_nonce: u64) -> Promise {
        let organizer = env::predecessor_account_id();
        let key = (organizer.clone(), request_nonce);
        let mut record = self
            .requests
            .get(&key)
            .unwrap_or_else(|| env::panic_str("request missing"));
        require!(
            record.state == ProvisionState::Failed && record.refund_state == RefundState::Claimable,
            "refund not claimable"
        );
        record.refund_attempt = record
            .refund_attempt
            .checked_add(1)
            .expect("refund attempt overflow");
        record.refund_state = RefundState::InFlight;
        self.requests.insert(&key, &record);
        Promise::new(organizer.clone()).transfer(NearToken::from_yoctonear(record.child_funding.0)).then(Promise::new(env::current_account_id()).function_call("on_failed_funding_refund",near_sdk::serde_json::json!({"organizer":organizer,"request_nonce":request_nonce,"attempt":record.refund_attempt}).to_string().into_bytes(),NearToken::from_yoctonear(0),Gas::from_tgas(15)))
    }

    #[private]
    pub fn on_failed_funding_refund(
        &mut self,
        organizer: AccountId,
        request_nonce: u64,
        attempt: u32,
    ) -> bool {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "private callback"
        );
        require!(env::promise_results_count() == 1, "one receipt required");
        let key = (organizer, request_nonce);
        let mut record = self
            .requests
            .get(&key)
            .unwrap_or_else(|| env::panic_str("request missing"));
        if record.state != ProvisionState::Failed
            || record.refund_state != RefundState::InFlight
            || record.refund_attempt != attempt
        {
            return false;
        }
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) => true,
            Err(near_sdk::PromiseError::Failed) => false,
            Err(_) => return false,
        };
        record.refund_state = if success {
            RefundState::Paid
        } else {
            RefundState::Claimable
        };
        if success {
            self.funding_refunded = self
                .funding_refunded
                .checked_add(record.child_funding.0)
                .expect("refund overflow");
        }
        self.requests.insert(&key, &record);
        success
    }

    // ------------------------------------------------------------ internals

    fn finish_provision(
        &mut self,
        record: RequestRecord,
        success: bool,
        recovered: bool,
    ) -> PromiseOrValue<RequestView> {
        let key = (record.organizer.clone(), record.request_nonce);
        let mut child = self
            .child_ids
            .get(&record.child_id)
            .unwrap_or_else(|| env::panic_str("child registry row missing"));
        let now = env::block_timestamp_ms();
        let mut record = record;
        if success {
            record.state = ProvisionState::Ready;
            record.ready_at_ms = now;
            child.state = ProvisionState::Ready;
            child.ready_at_ms = now;
            self.requests.insert(&key, &record);
            self.child_ids.insert(&record.child_id, &child);
            self.ready_children.push(&record.child_id);
            self.funding_delivered = self
                .funding_delivered
                .checked_add(record.child_funding.0)
                .unwrap_or_else(|| env::panic_str("funding counter overflow"));
            log_event(
                if recovered {
                    "ProvisionRecovered"
                } else {
                    "RegistryReady"
                },
                near_sdk::serde_json::json!({
                    "organizer": record.organizer,
                    "request_nonce": record.request_nonce,
                    "child_id": record.child_id,
                    "child_funding": record.child_funding.0.to_string(),
                    "registry_fee": record.registry_fee.0.to_string(),
                    "leaf_code_sha256": to_hex(&self.config.leaf_code_sha256),
                    "canonical_ft": self.config.canonical_ft,
                    "network": self.config.network,
                    "leaf_policy_version": self.config.leaf_policy_version,
                    "recovered": recovered,
                }),
            );
            PromiseOrValue::Value(self.request_view(&record))
        } else {
            record.state = ProvisionState::Failed;
            record.ready_at_ms = 0;
            child.state = ProvisionState::Failed;
            child.ready_at_ms = 0;
            self.requests.insert(&key, &record);
            self.child_ids.insert(&record.child_id, &child);
            record.refund_state = RefundState::Claimable;
            self.requests.insert(&key, &record);
            log_event(
                "ProvisionFailed",
                near_sdk::serde_json::json!({"organizer":record.organizer,"request_nonce":record.request_nonce,"child_id":record.child_id,"child_funding_claimable":record.child_funding.0.to_string()}),
            );
            PromiseOrValue::Value(self.request_view(&record))
        }
    }

    fn replay(&mut self, record: RequestRecord, attached: u128) -> PromiseOrValue<RequestView> {
        log_event(
            "ProvisionReplay",
            near_sdk::serde_json::json!({
                "organizer": record.organizer,
                "request_nonce": record.request_nonce,
                "child_id": record.child_id,
                "state": record.state,
                "attached_refunded": attached.to_string(),
            }),
        );
        if attached > 0 {
            PromiseOrValue::Promise(
                Promise::new(record.organizer.clone())
                    .transfer(NearToken::from_yoctonear(attached)),
            )
        } else {
            PromiseOrValue::Value(self.request_view(&record))
        }
    }

    fn probe_matches(&self, organizer: &AccountId, probe: &LeafConfigProbe) -> bool {
        &probe.organizer == organizer
            && probe.canonical_ft == self.config.canonical_ft
            && probe.network == self.config.network
            && probe.policy_version == self.config.leaf_policy_version
            && probe.provider_account == self.config.provider_account
            && probe.provider_kind == self.config.provider_kind
    }

    /// Deterministic bounded child ID. The hash input is domain-separated and
    /// includes the immutable leaf hash, so a factory with different code or
    /// configuration cannot derive the same child for the same request.
    fn child_id_for(&self, organizer: &AccountId, request_nonce: u64) -> AccountId {
        let factory = env::current_account_id();
        let mut input = Vec::with_capacity(64 + organizer.as_str().len() + factory.as_str().len());
        input.extend_from_slice(FACTORY_POLICY_IDENTITY.as_bytes());
        input.push(0);
        input.extend_from_slice(
            &near_sdk::borsh::to_vec(organizer)
                .unwrap_or_else(|_| env::panic_str("organizer borsh failed")),
        );
        input.extend_from_slice(&request_nonce.to_le_bytes());
        input.extend_from_slice(factory.as_str().as_bytes());
        input.extend_from_slice(&self.config.leaf_code_sha256);
        let digest = env::sha256(&input);
        let mut child = String::with_capacity(CHILD_ID_HEX_LEN + 1 + factory.as_str().len());
        child.push_str(&to_hex(&digest[..8]));
        child.push('.');
        child.push_str(factory.as_str());
        child
            .parse()
            .unwrap_or_else(|_| env::panic_str("derived child id is invalid"))
    }

    /// Candidate native funding for one keyless child: supplied code bytes plus
    /// the measured account/state overhead, every config string stored by the
    /// leaf, and the pinned margin. Quoted in yocto at the live storage price.
    fn child_funding(&self, organizer: &AccountId, child_id: &AccountId) -> u128 {
        let bytes = (pinned_leaf().0 as u128)
            .saturating_add(CHILD_ACCOUNT_BASE_BYTES)
            .saturating_add(child_id.as_str().len() as u128)
            .saturating_add(organizer.as_str().len() as u128)
            .saturating_add(self.config.canonical_ft.as_str().len() as u128)
            .saturating_add(self.config.provider_account.as_str().len() as u128)
            .saturating_add(self.config.provider_kind.len() as u128)
            .saturating_add(4 + 4 + 1)
            // RHEA_MAINNET initializes an additional retry_after_block u64.
            .saturating_add(if self.config.provider_kind == "RHEA_MAINNET" {
                8
            } else {
                0
            })
            .saturating_add(CHILD_STORAGE_MARGIN_BYTES);
        bytes
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("child funding overflow"))
    }

    /// Serialized growth of the four registry entries written by the next
    /// request. Mirrors the exact Borsh row sizes and legacy LookupMap
    /// prefix+key encoding, plus a reserve for a future Ready-index entry.
    fn registry_growth_quote(
        &self,
        organizer: &AccountId,
        child_id: &AccountId,
        index: u64,
    ) -> u128 {
        // NEAR charges 40 bytes of trie overhead for each new storage entry.
        let mut bytes = if index == 0 { 160u128 } else { 120u128 };
        // requests: 2-byte prefix + Borsh((organizer, nonce)) + Borsh(row)
        bytes = bytes.saturating_add(2);
        bytes = bytes.saturating_add(borsh_len(&(organizer.clone(), 0u64)));
        bytes = bytes.saturating_add(borsh_len(&RequestRecord {
            organizer: organizer.clone(),
            request_nonce: 0,
            child_id: child_id.clone(),
            state: ProvisionState::Pending,
            attempt: 1,
            created_block: 0,
            created_at_ms: 0,
            ready_at_ms: 0,
            child_funding: U128(0),
            registry_fee: U128(0),
            attached: U128(0),
            excess_refunded: U128(0),
            refund_state: RefundState::None,
            refund_attempt: 0,
        }));
        // child_ids: 2-byte prefix + Borsh(child) + Borsh(row)
        bytes = bytes.saturating_add(2);
        bytes = bytes.saturating_add(borsh_len(&child_id.clone()));
        bytes = bytes.saturating_add(borsh_len(&ChildRecord {
            child_id: child_id.clone(),
            organizer: organizer.clone(),
            request_nonce: 0,
            state: ProvisionState::Pending,
            created_at_ms: 0,
            ready_at_ms: 0,
        }));
        // children index: 2-byte prefix + Borsh((organizer, index)) + Borsh(child)
        bytes = bytes.saturating_add(2);
        bytes = bytes.saturating_add(borsh_len(&(organizer.clone(), index)));
        bytes = bytes.saturating_add(borsh_len(&child_id.clone()));
        // counts: written only on the first request for this organizer; later
        // requests rewrite the fixed-size u64 value without growth.
        if index == 0 {
            bytes = bytes.saturating_add(2);
            bytes = bytes.saturating_add(borsh_len(&organizer.clone()));
            bytes = bytes.saturating_add(8);
        }
        bytes
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .and_then(|cost| cost.checked_add(self.ready_index_cost(child_id)))
            .unwrap_or_else(|| env::panic_str("registry quote overflow"))
    }

    // Legacy Vector stores each element under its two-byte prefix plus a
    // little-endian u64 index; its length lives in the fixed-size root state.
    // Reserve one entry per request, including requests that later fail.
    fn ready_index_cost(&self, child_id: &AccountId) -> u128 {
        (40u128 + 2 + 8 + borsh_len(child_id))
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .unwrap_or_else(|| env::panic_str("global index cost overflow"))
    }

    fn config_view(&self) -> FactoryConfigView {
        FactoryConfigView {
            factory_account: env::current_account_id(),
            canonical_ft: self.config.canonical_ft.clone(),
            network: self.config.network.clone(),
            provider_account: self.config.provider_account.clone(),
            provider_kind: self.config.provider_kind.clone(),
            leaf_code_len: pinned_leaf().0 as u64,
            leaf_policy_version: self.config.leaf_policy_version.clone(),
            leaf_code_sha256: to_hex(&self.config.leaf_code_sha256),
            factory_policy_identity: FACTORY_POLICY_IDENTITY.to_string(),
            schema_version: SCHEMA_VERSION,
            parent_max_len: PARENT_MAX_LEN as u32,
            pending_timeout_blocks: PENDING_TIMEOUT_BLOCKS,
            min_provision_gas_tgas: MIN_PROVISION_GAS_TGAS,
            min_resolve_gas_tgas: MIN_RESOLVE_GAS_TGAS,
            child_storage_margin_bytes: U128(CHILD_STORAGE_MARGIN_BYTES),
            storage_byte_cost: U128(env::storage_byte_cost().as_yoctonear()),
            #[cfg(feature = "factory-event")]
            atomic_event_initialization: true,
        }
    }

    fn request_view(&self, record: &RequestRecord) -> RequestView {
        RequestView {
            organizer: record.organizer.clone(),
            request_nonce: record.request_nonce,
            child_id: record.child_id.clone(),
            state: record.state,
            attempt: record.attempt,
            created_block: record.created_block,
            created_at_ms: record.created_at_ms,
            ready_at_ms: record.ready_at_ms,
            child_funding: record.child_funding,
            registry_fee: record.registry_fee,
            attached: record.attached,
            excess_refunded: record.excess_refunded,
            refund_state: record.refund_state,
            refund_attempt: record.refund_attempt,
            leaf_code_sha256: to_hex(&self.config.leaf_code_sha256),
            canonical_ft: self.config.canonical_ft.clone(),
            network: self.config.network.clone(),
            leaf_policy_version: self.config.leaf_policy_version.clone(),
        }
    }

    fn child_view(&self, record: &ChildRecord) -> ChildView {
        ChildView {
            child_id: record.child_id.clone(),
            organizer: record.organizer.clone(),
            request_nonce: record.request_nonce,
            state: record.state,
            created_at_ms: record.created_at_ms,
            ready_at_ms: record.ready_at_ms,
            leaf_code_sha256: to_hex(&self.config.leaf_code_sha256),
            canonical_ft: self.config.canonical_ft.clone(),
            network: self.config.network.clone(),
            leaf_policy_version: self.config.leaf_policy_version.clone(),
        }
    }
}

fn valid_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

fn storage_cost(before: u64, after: u64) -> u128 {
    let bytes = after.saturating_sub(before) as u128;
    env::storage_byte_cost()
        .as_yoctonear()
        .checked_mul(bytes)
        .unwrap_or(u128::MAX)
}

fn borsh_len<T: near_sdk::borsh::BorshSerialize>(value: &T) -> u128 {
    near_sdk::borsh::to_vec(value)
        .map(|bytes| bytes.len() as u128)
        .unwrap_or_else(|_| env::panic_str("borsh size failed"))
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn log_event(name: &str, data: near_sdk::serde_json::Value) {
    let event = near_sdk::serde_json::json!({
        "standard": "showstake_factory",
        "version": "1.0.0",
        "event": name,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{event}"));
}


#[cfg(all(test, feature = "factory-event"))]
mod event_candidate_tests {
    use super::*;
    use near_sdk::{testing_env, test_utils::VMContextBuilder};
    fn id(s: &str) -> AccountId { s.parse().unwrap() }
    fn context() { testing_env!(VMContextBuilder::new().current_account_id(id("factory.near")).predecessor_account_id(id("factory.near")).build()); }
    fn empty() -> EmptyMultiEventState {
        EmptyMultiEventState { canonical_ft: id(MAIN_USDC), provider_account: id(MAIN_PROVIDER), provider_kind: "RHEA_MAINNET".into(), network: "mainnet".into(), token_symbol: "USDC".into(), token_name: "USDC".into(), token_decimals: 6, events: LookupMap::new(b"me-e".to_vec()), event_ids: Vector::new(b"me-i".to_vec()), registrations: LookupMap::new(b"me-r".to_vec()), passes: LookupMap::new(b"me-p".to_vec()), active: LookupMap::new(b"me-a".to_vec()), commitments: LookupMap::new(b"me-c".to_vec()), registration_event: LookupMap::new(b"me-re".to_vec()), next_registration: 0, accepted: 0, paid: 0, pending: 0, liability: 0, reserved_cash: 0, global_operation: None }
    }
    fn rules(capacity: u32) -> EventRules { EventRules { event_id: "e".into(), title: "t".into(), location: "l".into(), rules_text: "r".into(), finalize_deadline: 86_400_040, deposit: U128(2_000_000), capacity, reg_open: 10, reg_close: 20, checkin_open: 20, checkin_close: 40 } }
    #[test]
    fn quote_itemizes_full_capacity_reserve() {
        context(); let c = Contract::new(id(MAIN_USDC), "mainnet".into(), MAINNET_LEAF_POLICY_IDENTITY.into(), id(MAIN_PROVIDER), "RHEA_MAINNET".into());
        let q = c.quote_provision_event(id("host.near"), 7, rules(200));
        assert_eq!(q.participant_reserve.0, 200 * 4096 * env::storage_byte_cost().as_yoctonear());
        assert_eq!(q.total.0, q.code_config_funding.0 + q.rules_funding.0 + q.participant_reserve.0 + q.registry_fee.0);
        assert_eq!(q.child_id, c.get_child_id(id("host.near"), 7));
    }
    #[test]
    fn testnet_identity_and_quote_are_network_bound() {
        testing_env!(VMContextBuilder::new().current_account_id(id("factory.testnet")).predecessor_account_id(id("factory.testnet")).build());
        let c = Contract::new(id("usdc.testnet"), "testnet".into(), LEAF_POLICY_IDENTITY.into(), id("mock.testnet"), "MOCK_TESTNET".into());
        let q = c.quote_provision_event(id("host.testnet"), 1, rules(5));
        assert_eq!(q.network, "testnet"); assert_eq!(q.canonical_ft, id("usdc.testnet"));
        assert_eq!(q.provider_account, id("mock.testnet")); assert_eq!(q.leaf_policy_version, LEAF_POLICY_IDENTITY);
    }
    #[test]
    fn mismatched_network_token_and_provider_fail_closed() {
        for kind in 0..4 {
            testing_env!(VMContextBuilder::new().current_account_id(id("factory.testnet")).predecessor_account_id(id("factory.testnet")).build());
            let (ft, network, policy, provider, provider_kind) = match kind {
                0 => ("usdc.near", "testnet", LEAF_POLICY_IDENTITY, "mock.testnet", "MOCK_TESTNET"),
                1 => ("usdc.testnet", "testnet", LEAF_POLICY_IDENTITY, "mock.near", "MOCK_TESTNET"),
                2 => ("usdc.testnet", "testnet", LEAF_POLICY_IDENTITY, "mock.testnet", "RHEA_MAINNET"),
                _ => (MAIN_USDC, "mainnet", MAINNET_LEAF_POLICY_IDENTITY, MAIN_PROVIDER, "RHEA_MAINNET"),
            };
            assert!(std::panic::catch_unwind(|| Contract::new(id(ft), network.into(), policy.into(), id(provider), provider_kind.into())).is_err());
        }
        context();
        assert!(std::panic::catch_unwind(|| Contract::new(id("wrong.near"), "mainnet".into(), MAINNET_LEAF_POLICY_IDENTITY.into(), id(MAIN_PROVIDER), "RHEA_MAINNET".into())).is_err());
        assert!(std::panic::catch_unwind(|| Contract::new(id(MAIN_USDC), "mainnet".into(), MAINNET_LEAF_POLICY_IDENTITY.into(), id("wrong.near"), "RHEA_MAINNET".into())).is_err());
    }
    #[test]
    fn exact_empty_root_migrates() {
        context(); env::state_write(&empty()); let c = Contract::migrate_empty_multievent();
        assert_eq!(c.get_native_accounting().total_requests, 0);
        assert_eq!(c.get_config().canonical_ft, id(MAIN_USDC));
    }
    #[test]
    fn nonempty_accounting_is_rejected() {
        for kind in 0..5 {
            context(); let mut old = empty();
            match kind { 0 => old.accepted = 1, 1 => old.paid = 1, 2 => old.pending = 1, 3 => old.liability = 1, _ => old.reserved_cash = 1 }
            env::state_write(&old);
            assert!(std::panic::catch_unwind(Contract::migrate_empty_multievent).is_err());
        }
    }
    #[test]
    fn nonempty_event_or_registration_counters_are_rejected() {
        for kind in 0..2 {
            context(); let mut old = empty();
            if kind == 0 { old.event_ids.push(&"event".into()); } else { old.next_registration = 1; }
            env::state_write(&old);
            assert!(std::panic::catch_unwind(Contract::migrate_empty_multievent).is_err());
        }
    }
    #[test]
    fn wrong_provider_identity_is_rejected() {
        context(); let mut old = empty(); old.provider_account = id("other.near"); env::state_write(&old);
        assert!(std::panic::catch_unwind(Contract::migrate_empty_multievent).is_err());
    }
    #[test]
    fn in_flight_operation_is_rejected() {
        context(); let mut old = empty(); old.global_operation = Some("pending".into()); env::state_write(&old);
        assert!(std::panic::catch_unwind(Contract::migrate_empty_multievent).is_err());
    }
}
