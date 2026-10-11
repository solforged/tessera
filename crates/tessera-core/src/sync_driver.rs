//! Transport calls happen strictly outside `NotebookAccess::with_notebook`.
use super::*;

/// Access to a notebook for one local step. A host may acquire its writer lock
/// here; the driver never calls the hub from inside this closure.
pub trait NotebookAccess {
    fn with_notebook<T>(&mut self, step: impl FnOnce(&mut Notebook) -> Result<T>) -> Result<T>;

    /// Hosts publish invalidations while still holding the writer lock.
    fn integrate(&mut self, changes: &[PulledChange]) -> Result<IntegrateReport> {
        self.with_notebook(|notebook| notebook.sync_integrate(changes))
    }
}

impl NotebookAccess for Notebook {
    fn with_notebook<T>(&mut self, step: impl FnOnce(&mut Notebook) -> Result<T>) -> Result<T> {
        step(self)
    }
}

pub fn sync_with(local: &mut impl NotebookAccess, hub: &mut dyn Hub) -> Result<SyncReport> {
    let mut report = sync_send(local, hub)?;
    let device = local.with_notebook(|n| n.device_id())?;
    loop {
        let confirmed = local.with_notebook(|n| Ok(n.require_replica()?.confirmed_seq))?;
        let pull = hub.pull(&device, confirmed, confirmed)?;
        let missing = local.with_notebook(|n| n.sync_missing_snapshots(&pull.snapshots))?;
        transfer(
            &missing,
            |ids, from| hub.snapshot_content(ids, from),
            |content| local.with_notebook(|n| n.sync_store_snapshots(content)),
        )?;
        report.received_snapshots += missing.len();
        // An empty page must not undo/replay the pending edits again.
        if !pull.changes.is_empty() {
            let page = local.integrate(&pull.changes)?;
            report.integrated.applied += page.applied;
            report.integrated.confirmed += page.confirmed;
            report.integrated.replayed = page.replayed;
            report.integrated.unapplied = page.unapplied;
        }
        if !pull.more { break; }
    }
    let (sent, received) = unlogged(local, hub, true)?;
    report.sent_rows += sent;
    report.received_rows = received;
    for sha in local.with_notebook(|n| n.sync_wanted_objects())? {
        match hub.object(&sha)? {
            Some(bytes) => {
                local.with_notebook(|n| n.sync_store_object(&sha, &bytes))?;
                report.received_objects += 1;
            }
            None => report.unavailable_objects.push(sha),
        }
    }
    Ok(report)
}

pub fn sync_send(local: &mut impl NotebookAccess, hub: &mut dyn Hub) -> Result<SyncReport> {
    let outbox = local.with_notebook(|n| n.sync_outbox())?;
    let mut report = send_outbox(local, hub, &outbox)?;
    report.sent_rows = unlogged(local, hub, false)?.0;
    Ok(report)
}

fn send_outbox(local: &mut impl NotebookAccess, hub: &mut dyn Hub, outbox: &Outbox) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    if !outbox.snapshots.is_empty() {
        let missing = hub.missing_snapshots(&outbox.snapshots)?;
        transfer(
            &missing,
            |ids, from| local.with_notebook(|n| n.sync_snapshot_content(ids, from)),
            |content| hub.store_snapshots(content),
        )?;
        report.sent_snapshots = missing.len();
    }
    let objects = local.with_notebook(|n| n.sync_outbox_objects(outbox))?;
    if !objects.is_empty() {
        for sha in hub.missing_objects(&objects)? {
            let bytes = local.with_notebook(|n| n.read_object(&sha))?;
            hub.store_object(&sha, &bytes)?;
            report.sent_objects += 1;
        }
    }
    for changes in outbox.changes.chunks(PUSH_LIMIT) {
        report.pushed.extend(hub.push(&outbox.device_id, changes)?);
    }
    Ok(report)
}

fn unlogged(local: &mut impl NotebookAccess, hub: &mut dyn Hub, receive: bool) -> Result<(usize, usize)> {
    let (device, own, cursor, latest) = local.with_notebook(|n| n.sync_unlogged_outbox())?;
    if !receive && own.is_empty() { return Ok((0, 0)); }
    let pull = hub.exchange_rows(&device, &own, if receive { cursor } else { i64::MAX })?;
    let received = local.with_notebook(|n| n.sync_integrate_rows(&pull, latest, receive))?;
    Ok((own.len(), received))
}

/// Import an independent notebook before adopting a clone. `device` is a
/// temporary replica registered by this pairing key. Original change identities
/// make retrying the whole history safe; natural-key resolution is the same as
/// an ordinary push. Rejections remain on the hub and in the preserved old DB.
pub fn sync_import(local: &mut impl NotebookAccess, hub: &mut dyn Hub, device: &str) -> Result<SyncReport> {
    let outbox = local.with_notebook(|n| n.sync_import_outbox(device))?;
    let mut report = send_outbox(local, hub, &outbox)?;
    let rows = local.with_notebook(|n| n.sync_import_rows())?;
    hub.exchange_rows(device, &rows, i64::MAX)?;
    report.sent_rows = rows.len();
    Ok(report)
}

impl Notebook {
    fn sync_import_outbox(&self, device: &str) -> Result<Outbox> {
        let changes = self.conn.prepare(
            "SELECT change_id, origin, created_at, actor, reason, idempotency_key, operations FROM changes ORDER BY seq"
        )?.query_map([], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?, row.get::<_, String>(6)?,
        )))?.map(|row| {
            let (id, _origin, at, actor, reason, idempotency_key, operations) = row?;
            Ok(PushedChange { stamp: ChangeStamp { id, origin: device.into(), at }, batch: Batch {
                actor: parse(&actor)?, reason, idempotency_key, operations: parse(&operations)?,
            }, bases: BTreeMap::new() })
        }).collect::<Result<Vec<_>>>()?;
        // All snapshots, including reading-position-only content, travel once.
        let snapshots = self.conn.prepare("SELECT id FROM snapshots ORDER BY id")?
            .query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok(Outbox { device_id: device.into(), confirmed_seq: 0, changes, snapshots })
    }
}
