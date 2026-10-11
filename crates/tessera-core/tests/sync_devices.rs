use rusqlite::Connection;
use tessera_core::{Actor, Batch, DATABASE_FILE, Notebook, Operation};

#[test]
fn pairing_hashes_keys_binds_clones_and_strips_device_secrets() {
    let hub_dir = tempfile::tempdir().unwrap();
    let replica_dir = tempfile::tempdir().unwrap();
    let mut hub = Notebook::open(hub_dir.path()).unwrap();
    let device = hub.sync_pair_device("Phone", "secret-key").unwrap();
    assert_eq!(
        hub.sync_authenticate("secret-key").unwrap(),
        Some(device.clone())
    );
    assert!(hub.sync_authenticate("wrong-key").unwrap().is_none());
    assert_eq!(hub.sync_devices().unwrap()[0].state, "never_synced");
    let conn = Connection::open(hub_dir.path().join(DATABASE_FILE)).unwrap();
    let hash: String = conn
        .query_row("SELECT key_hash FROM sync_devices", [], |row| row.get(0))
        .unwrap();
    assert_eq!(hash.len(), 64);
    assert_ne!(hash, "secret-key");
    let ticket = hub
        .sync_clone_for_device(&replica_dir.path().join(DATABASE_FILE), Some(&device.id))
        .unwrap()
        .finish()
        .unwrap();
    assert!(
        hub.sync_device_owns_replica(&device.id, &ticket.device_id)
            .unwrap()
    );
    assert!(
        !hub.sync_device_owns_replica("another-device", &ticket.device_id)
            .unwrap()
    );
    assert_eq!(hub.sync_devices().unwrap()[0].state, "active");
    let clone = Connection::open(replica_dir.path().join(DATABASE_FILE)).unwrap();
    let count: i64 = clone
        .query_row("SELECT COUNT(*) FROM sync_devices", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let mut replica = Notebook::open(replica_dir.path()).unwrap();
    replica.sync_adopt("https://hub:4319", &ticket).unwrap();
    replica
        .sync_set_hub_credentials(Some("secret-key"), Some("Mac"), Some("Phone"))
        .unwrap();
    replica.sync_mark_synced().unwrap();
    let credentials = replica.sync_hub_credentials().unwrap().unwrap();
    assert_eq!(credentials.key.as_deref(), Some("secret-key"));
    assert_eq!(credentials.hub_name.as_deref(), Some("Mac"));
    assert_eq!(credentials.device_name.as_deref(), Some("Phone"));
    assert!(credentials.synced_at.is_some());
}

#[test]
fn forgetting_revokes_keys_retires_all_clones_and_prunes_patches() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = Notebook::open(dir.path()).unwrap();
    let device = hub.sync_pair_device("Phone", "key").unwrap();
    for filename in ["clone-one.db", "clone-two.db"] {
        hub.sync_clone_for_device(&dir.path().join(filename), Some(&device.id))
            .unwrap()
            .finish()
            .unwrap();
    }
    hub.apply(&Batch {
        actor: Actor::Person,
        reason: None,
        idempotency_key: None,
        operations: vec![Operation::CreatePage {
            id: ulid::Ulid::from(1_u128).to_string(),
            title: "Hub edit".into(),
        }],
    })
    .unwrap();
    assert_eq!(hub.sync_retained_patches().unwrap().changes, 1);
    assert!(hub.sync_retained_patches().unwrap().bytes > 0);
    hub.sync_forget_device(&device.id).unwrap();
    assert!(hub.sync_authenticate("key").unwrap().is_none());
    assert!(hub.sync_devices().unwrap().is_empty());
    assert!(
        hub.sync_replicas()
            .unwrap()
            .iter()
            .all(|replica| replica.retired_at.is_some())
    );
    assert_eq!(hub.sync_retained_patches().unwrap().changes, 0);
    assert_eq!(hub.sync_retained_patches().unwrap().bytes, 0);
    assert!(
        hub.sync_clone_for_device(&dir.path().join("forgotten.db"), Some(&device.id))
            .is_err()
    );
}
