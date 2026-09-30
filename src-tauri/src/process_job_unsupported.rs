//! Child-process lifetime binding off Windows. No backend yet: a worker is
//! spawned uncontained, so it can outlive this process if this process dies
//! without shutting it down.

/// Uninhabited: no containment exists to hold.
pub enum ProcessJob {}

pub fn contain(_pid: u32) -> Result<Option<ProcessJob>, String> {
    Ok(None)
}
