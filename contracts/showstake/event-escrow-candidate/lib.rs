#[cfg(not(feature = "multi-event"))]
#[path = "src.rs"]
mod legacy;
#[cfg(not(feature = "multi-event"))]
pub use legacy::*;
#[cfg(all(feature = "multi-event", not(feature = "shared-yield")))]
#[path = "multi_event.rs"]
mod multi_event;
#[cfg(all(feature = "multi-event", not(feature = "shared-yield")))]
pub use multi_event::*;
#[cfg(feature = "shared-yield")]
#[path = "shared_yield.rs"]
mod shared_yield;
#[cfg(feature = "shared-yield")]
pub use shared_yield::*;
#[cfg(feature = "shared-yield")]
#[path = "rhea_adapter.rs"]
mod rhea_adapter;
#[cfg(feature = "shared-yield")]
#[path = "shared_vault_math.rs"]
mod shared_vault_math;
