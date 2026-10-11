//! Rows written outside the change log carry a hybrid logical clock so devices
//! agree on the last write. See "State outside the log" in `docs/sync.md`.

use rusqlite::Connection;

use crate::Result;

/// The clock, device and arrival order for one write outside the change log.
pub(crate) struct Stamp {
    pub hlc: i64,
    pub device: String,
    pub seq: i64,
}

/// Advance the clock past `now` and the last time it gave out.
pub(crate) fn stamp(conn: &Connection, now: i64) -> Result<Stamp> {
    Ok(conn.query_row(
        "UPDATE replica SET clock = MAX(clock + 1, ?1), unlogged_seq = unlogged_seq + 1
         WHERE singleton = 1 RETURNING clock, device_id, unlogged_seq",
        [now],
        |row| {
            Ok(Stamp {
                hlc: row.get(0)?,
                device: row.get(1)?,
                seq: row.get(2)?,
            })
        },
    )?)
}
