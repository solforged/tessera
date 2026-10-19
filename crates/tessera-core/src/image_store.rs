use std::collections::HashMap;
use std::path::Path;

use rusqlite::{Connection, params};

use crate::capabilities::ImageRef;
use crate::library_store::validate_sha;
use crate::storage::{quote_target, validation};
use crate::{Block, BlockCapabilities, BlockKind, Notebook, Result};

const CHOOSE_IMAGE: &str = "Choose a PNG, JPEG, WebP or GIF image.";
const QUOTED_IMAGE: &str = "A quoted copy can't hold an image.";

/// Sniff the raster formats notebooks accept, independent of a supplied MIME type.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

fn validate(image: &ImageRef) -> Result<()> {
    if !matches!(
        image.media_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) || !(1..=32768).contains(&image.width)
        || !(1..=32768).contains(&image.height)
        || validate_sha(&image.sha256).is_err()
    {
        return Err(validation(CHOOSE_IMAGE));
    }
    Ok(())
}

impl Notebook {
    pub fn put_image(&self, bytes: &[u8]) -> Result<ImageRef> {
        let media_type = image_type(bytes).ok_or_else(|| validation(CHOOSE_IMAGE))?;
        let size = imagesize::blob_size(bytes).map_err(|_| validation(CHOOSE_IMAGE))?;
        if !(1..=32768).contains(&size.width) || !(1..=32768).contains(&size.height) {
            return Err(validation(CHOOSE_IMAGE));
        }
        Ok(ImageRef {
            sha256: self.put_object(bytes)?,
            media_type: media_type.to_owned(),
            width: size.width as u32,
            height: size.height as u32,
        })
    }
}

pub(crate) fn set(
    conn: &Connection,
    object_dir: &Path,
    local: bool,
    block: &Block,
    image: Option<&ImageRef>,
) -> Result<bool> {
    if block.kind != BlockKind::Block {
        return Err(validation("Only an outline atom can hold an image."));
    }
    let Some(image) = image else {
        return Ok(conn
            .prepare_cached("UPDATE images SET active = 0 WHERE block_id = ?1 AND active = 1")?
            .execute([&block.id])?
            != 0);
    };
    validate(image)?;
    if let Some(target) = quote_target(&block.text) {
        let quoted: bool = conn
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM quotes WHERE block_id = ?1 AND target_id = ?2)",
            )?
            .query_row(params![block.id, target], |row| row.get(0))?;
        if quoted {
            return Err(validation(QUOTED_IMAGE));
        }
    }
    if local {
        #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
        let present = object_dir
            .join("objects")
            .join(&image.sha256[..2])
            .join(&image.sha256[2..])
            .try_exists()?;
        #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
        let present = {
            let _ = object_dir;
            conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM browser_objects WHERE sha256 = ?1)")?
                .query_row([&image.sha256], |row| row.get::<_, bool>(0))?
        };
        if !present {
            return Err(validation("Upload the image before attaching it."));
        }
    }
    Ok(conn.prepare_cached(
        "INSERT INTO images(block_id, active, sha256, media_type, width, height) VALUES (?1, 1, ?2, ?3, ?4, ?5)
         ON CONFLICT(block_id) DO UPDATE SET active = 1, sha256 = excluded.sha256, media_type = excluded.media_type, width = excluded.width, height = excluded.height
         WHERE images.active = 0 OR images.sha256 != excluded.sha256 OR images.media_type != excluded.media_type OR images.width != excluded.width OR images.height != excluded.height"
    )?.execute(params![block.id, image.sha256, image.media_type, image.width, image.height])? != 0)
}

pub(crate) fn at(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Option<ImageRef>> {
    let Some(sha256) = row.get::<_, Option<String>>(index)? else {
        return Ok(None);
    };
    Ok(Some(ImageRef {
        sha256,
        media_type: row.get(index + 1)?,
        width: row.get(index + 2)?,
        height: row.get(index + 3)?,
    }))
}

pub(crate) fn hydrate(
    conn: &Connection,
    mut capabilities: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    if capabilities.is_empty() {
        return Ok(capabilities);
    }
    let ids: Vec<_> = capabilities
        .iter()
        .map(|cap| cap.block_id.as_str())
        .collect();
    let mut images: HashMap<String, Option<ImageRef>> = conn.prepare_cached(
        "SELECT block_id, sha256, media_type, width, height FROM images WHERE active = 1 AND block_id IN (SELECT value FROM json_each(?1))"
    )?.query_map([serde_json::to_string(&ids).expect("IDs serialize")], |row| Ok((row.get(0)?, at(row, 1)?)))?.collect::<rusqlite::Result<_>>()?;
    for capability in &mut capabilities {
        capability.image = images.remove(&capability.block_id).flatten();
        capability.merge_protected |= capability.image.is_some();
    }
    Ok(capabilities)
}

fn active(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM images WHERE block_id = ?1 AND active = 1)")?
        .query_row([id], |row| row.get(0))?)
}

pub(crate) fn guard_merge(conn: &Connection, id: &str) -> Result<()> {
    if active(conn, id)? {
        return Err(validation("Image atoms can't be merged."));
    }
    Ok(())
}

pub(crate) fn guard_quote(conn: &Connection, id: &str) -> Result<()> {
    if active(conn, id)? {
        return Err(validation(QUOTED_IMAGE));
    }
    Ok(())
}
