#[cfg(not(feature = "multi-event"))]
#[path = "src.rs"]
mod legacy;
#[cfg(not(feature = "multi-event"))]
pub use legacy::*;
#[cfg(feature = "multi-event")]
#[path = "multi_event.rs"]
mod multi_event;
#[cfg(feature = "multi-event")]
pub use multi_event::*;
