//! Local pairing identities and replica credentials. Only SHA-256 key hashes live on the hub;
//! clone finalization strips these rows before any database bytes leave the hub.

use crate::library_store::sha256_hex;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::notebook::{new_ulid, now_ms};
use crate::storage::validation;
use crate::{Notebook, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub paired_at: i64,
    pub state: &'static str,
    pub last_seen_at: Option<i64>,
    pub retired_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct RetainedPatches {
    pub changes: i64,
    pub bytes: i64,
}

/// Private local credentials, deliberately not part of the serializable sync status.
#[derive(Clone)]
pub struct HubCredentials {
    pub key: Option<String>,
    pub hub_name: Option<String>,
    pub device_name: Option<String>,
    pub synced_at: Option<i64>,
}

impl Notebook {
    /// Register a key minted by the pairing endpoint. Never retain its plaintext.
    pub fn sync_pair_device(&mut self, name: &str, key: &str) -> Result<PairedDevice> {
        let device = PairedDevice {
            id: new_ulid().to_string(),
            name: name.to_owned(),
        };
        let hash = sha256_hex(key.as_bytes());
        self.conn.execute(
            "INSERT INTO sync_devices(id, name, key_hash, paired_at) VALUES (?1, ?2, ?3, ?4)",
            params![device.id, device.name, hash, now_ms()],
        )?;
        Ok(device)
    }

    pub fn sync_authenticate(&self, key: &str) -> Result<Option<PairedDevice>> {
        let hash = sha256_hex(key.as_bytes());
        Ok(self
            .conn
            .query_row(
                "SELECT id, name FROM sync_devices WHERE key_hash = ?1",
                [hash],
                |row| {
                    Ok(PairedDevice {
                        id: row.get(0)?,
                        name: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    pub(crate) fn sync_require_device(&self, device: &str) -> Result<()> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_devices WHERE id = ?1)",
            [device],
            |row| row.get(0),
        )?;
        if exists {
            Ok(())
        } else {
            Err(validation("the paired device was forgotten"))
        }
    }

    /// A key may only act on replica IDs cloned using that key.
    pub fn sync_device_owns_replica(&self, device: &str, replica: &str) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_replicas r JOIN sync_devices d ON d.id = r.paired_device
             WHERE r.device_id = ?1 AND d.id = ?2)", params![replica, device], |row| row.get(0),
        )?)
    }

    pub fn sync_devices(&mut self) -> Result<Vec<DeviceInfo>> {
        crate::sync::prune(&self.conn, now_ms())?;
        Ok(self
            .conn
            .prepare(
                "SELECT d.id, d.name, d.paired_at, COUNT(r.device_id),
                    COUNT(r.device_id) FILTER (WHERE r.retired_at IS NULL),
                    MAX(r.seen_at), MAX(r.retired_at)
             FROM sync_devices d LEFT JOIN sync_replicas r ON r.paired_device = d.id
             GROUP BY d.id ORDER BY d.paired_at, d.id",
            )?
            .query_map([], |row| {
                let replicas: i64 = row.get(3)?;
                let active: i64 = row.get(4)?;
                Ok(DeviceInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    paired_at: row.get(2)?,
                    state: if replicas == 0 {
                        "never_synced"
                    } else if active > 0 {
                        "active"
                    } else {
                        "retired"
                    },
                    last_seen_at: row.get(5)?,
                    retired_at: if active > 0 { None } else { row.get(6)? },
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn sync_retained_patches(&self) -> Result<RetainedPatches> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(patch)), 0) FROM change_patches",
            [],
            |row| {
                Ok(RetainedPatches {
                    changes: row.get(0)?,
                    bytes: row.get(1)?,
                })
            },
        )?)
    }

    /// Revoke a key, retire every replica it cloned, and release unneeded patches atomically.
    pub fn sync_forget_device(&mut self, device: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        let now = now_ms();
        tx.execute("DELETE FROM sync_devices WHERE id = ?1", [device])?;
        tx.execute(
            "UPDATE sync_replicas SET retired_at = ?2 WHERE paired_device = ?1 AND retired_at IS NULL",
            params![device, now],
        )?;
        crate::sync::prune(&tx, now)?;
        tx.commit()?;
        Ok(())
    }

    pub fn sync_hub_credentials(&self) -> Result<Option<HubCredentials>> {
        Ok(self
            .conn
            .query_row(
                "SELECT key, hub_name, device_name, synced_at FROM sync_hub WHERE singleton = 1",
                [],
                |row| {
                    Ok(HubCredentials {
                        key: row.get(0)?,
                        hub_name: row.get(1)?,
                        device_name: row.get(2)?,
                        synced_at: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn sync_set_hub_credentials(
        &mut self,
        key: Option<&str>,
        hub_name: Option<&str>,
        device_name: Option<&str>,
    ) -> Result<()> {
        self.require_replica()?;
        self.conn.execute(
            "UPDATE sync_hub SET key = ?1, hub_name = ?2, device_name = ?3 WHERE singleton = 1",
            params![key, hub_name, device_name],
        )?;
        Ok(())
    }

    pub fn sync_mark_synced(&mut self) -> Result<()> {
        self.conn.execute(
            "UPDATE sync_hub SET synced_at = ?1 WHERE singleton = 1",
            [now_ms()],
        )?;
        Ok(())
    }
}
