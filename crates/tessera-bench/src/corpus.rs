use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tessera_core::{
    Actor, Batch, Block, BlockKind, ChangeEvent, Committed, Notebook, Operation, PageView,
    Revision, SCHEMA_VERSION,
};

const GENERATOR_VERSION: u32 = 3;
const CHUNK: usize = 256;

#[derive(Clone, Debug, Serialize)]
pub struct Expected {
    pub id: String,
    pub kind: BlockKind,
    pub parent: Option<String>,
    pub page: String,
    pub text: String,
    pub heading: Option<u8>,
    pub archived: bool,
    pub revision: i64,
    pub deleted: bool,
}

#[derive(Clone)]
pub struct Model {
    pub blocks: BTreeMap<String, Expected>,
    pub children: BTreeMap<String, Vec<String>>,
    pub changes: Vec<(i64, Vec<Revision>, Vec<String>)>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Manifest {
    generator_version: u32,
    schema_version: u32,
    size: usize,
    seed: u64,
    logical_hash: String,
}

pub struct Corpus {
    pub model: Model,
    pub batches: Vec<Batch>,
    pub pages: BTreeMap<usize, String>,
    pub logical_hash: String,
}

pub fn batch(operations: Vec<Operation>) -> Batch {
    Batch {
        actor: Actor::Client {
            name: "tessera-bench".into(),
        },
        reason: Some("Deterministic benchmark".into()),
        idempotency_key: None,
        operations,
    }
}

pub fn id(seed: u64, index: usize) -> String {
    ulid::Ulid::from((u128::from(seed) << 64) | index as u128).to_string()
}

impl Corpus {
    pub fn generate(size: usize, seed: u64) -> Result<Self> {
        ensure!(
            [1000, 10000, 50000].contains(&size),
            "supported sizes are 1000, 10000 and 50000"
        );
        let mut model = Model {
            blocks: BTreeMap::new(),
            children: BTreeMap::new(),
            changes: Vec::new(),
        };
        let mut operations = Vec::new();
        let mut pages = BTreeMap::new();
        let mut planned = vec![100];
        if size >= 10000 {
            planned.push(2000);
        }
        if size == 50000 {
            planned.push(10000);
        }
        let mut count = planned.iter().sum::<usize>() + planned.len();
        while count < size {
            let rows = (size - count - 1).min(99);
            planned.push(rows);
            count += rows + 1;
        }
        let mut random = seed ^ 0x9e3779b97f4a7c15;
        let mut index = 0;
        for (page_index, rows) in planned.into_iter().enumerate() {
            let root_id = id(seed, index);
            index += 1;
            let journal = page_index > 2 && page_index % 4 == 0;
            let root = if journal {
                let day = page_index / 4;
                Operation::CreateJournal {
                    id: root_id.clone(),
                    date: format!(
                        "{:04}-{:02}-{:02}",
                        2020 + day / 336,
                        1 + (day % 336) / 28,
                        1 + day % 28
                    ),
                }
            } else {
                Operation::CreatePage {
                    id: root_id.clone(),
                    title: format!("Page {page_index:05}"),
                }
            };
            model.operation(&root)?;
            operations.push(root);
            if [100, 2000, 10000].contains(&rows) {
                pages.insert(rows, root_id.clone());
            }
            let mut ancestors = vec![root_id.clone()];
            for row in 0..rows {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                let depth = if row == 0 || row + 1 == rows {
                    0
                } else {
                    (random as usize % 7).min(ancestors.len() - 1)
                };
                ancestors.truncate(depth + 1);
                let parent = ancestors[depth].clone();
                let block_id = id(seed, index);
                // Commit targets have equal text cost across page sizes.
                let words = if row + 1 == rows {
                    2
                } else {
                    [2, 8, 24, 80, 240][random as usize % 5]
                };
                let mut text = format!("needle{index:06} cobalt #[[Page 00000]] ");
                text.push_str(&"outline reading context ".repeat(words));
                if row + 1 != rows && index % 8 == 0 {
                    let target = id(seed, (random as usize % index).min(index - 1));
                    text.push_str(&format!("[[{target}|linked]]"));
                }
                let op = Operation::Insert {
                    id: block_id.clone(),
                    parent_id: parent.clone(),
                    after: model
                        .children
                        .get(&parent)
                        .and_then(|children| children.last())
                        .cloned(),
                    text,
                    heading: (row + 1 != rows && index % 13 == 0).then_some((1 + index % 3) as u8),
                };
                model.operation(&op)?;
                operations.push(op);
                if row + 1 != rows && index % 19 == 0 {
                    let op = Operation::SetArchived {
                        id: block_id.clone(),
                        base_revision: 1,
                        archived: true,
                    };
                    model.operation(&op)?;
                    operations.push(op);
                }
                ancestors.push(block_id);
                index += 1;
            }
        }
        ensure!(model.blocks.len() == size, "generator count mismatch");
        let logical_hash = Sha256::digest(serde_json::to_vec(&(&model.blocks, &model.children))?)
            .iter()
            .fold(String::with_capacity(64), |mut hex, byte| {
                write!(hex, "{byte:02x}").expect("writing to a String cannot fail");
                hex
            });
        let batches = operations
            .chunks(CHUNK)
            .map(|ops| batch(ops.to_vec()))
            .collect::<Vec<_>>();
        // Calculate initial change revisions without consulting the database.
        let mut initial = Model {
            blocks: BTreeMap::new(),
            children: BTreeMap::new(),
            changes: Vec::new(),
        };
        for batch in &batches {
            initial.apply_model(batch)?;
        }
        model.changes = initial.changes;
        Ok(Self {
            model,
            batches,
            pages,
            logical_hash,
        })
    }

    pub fn materialize(&self, root: &Path, size: usize, seed: u64, force: bool) -> Result<PathBuf> {
        let dir = root.join(format!("corpus-{size}-{seed}"));
        let manifest = Manifest {
            generator_version: GENERATOR_VERSION,
            schema_version: SCHEMA_VERSION,
            size,
            seed,
            logical_hash: self.logical_hash.clone(),
        };
        let manifest_path = dir.join("manifest.json");
        let matching = std::fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .is_some_and(|stored| stored == manifest);
        if !force && matching && dir.join(tessera_core::DATABASE_FILE).is_file() {
            return Ok(dir);
        }
        // Only this harness-owned dataset directory is removed.
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        let mut notebook = Notebook::open(&dir)?;
        let mut expected = Model {
            blocks: BTreeMap::new(),
            children: BTreeMap::new(),
            changes: Vec::new(),
        };
        for batch in &self.batches {
            let revisions = expected.apply_model(batch)?;
            let result = notebook.apply(batch)?;
            expected.check_commit(&result, &revisions)?;
        }
        for page in self
            .model
            .blocks
            .values()
            .filter(|block| block.parent.is_none())
        {
            self.model.check_page(&notebook.page(&page.id)?)?;
        }
        drop(notebook);
        std::fs::write(manifest_path, serde_json::to_vec_pretty(&manifest)?)?;
        Ok(dir)
    }
}

impl Model {
    pub fn operation(&mut self, op: &Operation) -> Result<Vec<String>> {
        let touched = match op {
            Operation::CreatePage { id, title } | Operation::CreateJournal { id, date: title } => {
                self.blocks.insert(
                    id.clone(),
                    Expected {
                        id: id.clone(),
                        kind: if matches!(op, Operation::CreatePage { .. }) {
                            BlockKind::Page
                        } else {
                            BlockKind::Journal
                        },
                        parent: None,
                        page: id.clone(),
                        text: title.clone(),
                        heading: None,
                        archived: false,
                        revision: 1,
                        deleted: false,
                    },
                );
                self.children.insert(id.clone(), Vec::new());
                vec![id.clone()]
            }
            Operation::Insert {
                id,
                parent_id,
                after,
                text,
                heading,
            } => {
                let page = self.blocks[parent_id].page.clone();
                self.blocks.insert(
                    id.clone(),
                    Expected {
                        id: id.clone(),
                        kind: BlockKind::Block,
                        parent: Some(parent_id.clone()),
                        page,
                        text: text.clone(),
                        heading: *heading,
                        archived: false,
                        revision: 1,
                        deleted: false,
                    },
                );
                self.place(id, parent_id, after.as_deref())?;
                vec![id.clone()]
            }
            Operation::EditText { id, text, .. } => {
                let block = self.blocks.get_mut(id).context("model edit target")?;
                block.text.clone_from(text);
                block.revision += 1;
                vec![id.clone()]
            }
            Operation::SetArchived { id, archived, .. } => {
                let block = self.blocks.get_mut(id).context("model archive target")?;
                block.archived = *archived;
                block.revision += 1;
                vec![id.clone()]
            }
            Operation::Split {
                id,
                new_id,
                left,
                right,
                ..
            } => {
                let original = self.blocks[id].clone();
                ensure!(
                    format!("{left}{right}") == original.text,
                    "model split mismatch"
                );
                self.blocks.get_mut(id).unwrap().text.clone_from(left);
                self.blocks.get_mut(id).unwrap().revision += 1;
                self.blocks.insert(
                    new_id.clone(),
                    Expected {
                        id: new_id.clone(),
                        text: right.clone(),
                        revision: 1,
                        heading: None,
                        archived: false,
                        ..original.clone()
                    },
                );
                self.place(new_id, original.parent.as_deref().unwrap(), Some(id))?;
                vec![id.clone(), new_id.clone()]
            }
            Operation::Move {
                id,
                parent_id,
                after,
                ..
            } => {
                let old = self.blocks[id].parent.clone().unwrap();
                self.children
                    .get_mut(&old)
                    .unwrap()
                    .retain(|child| child != id);
                self.place(id, parent_id, after.as_deref())?;
                let block = self.blocks.get_mut(id).unwrap();
                block.parent = Some(parent_id.clone());
                block.revision += 1;
                vec![id.clone()]
            }
            Operation::Delete { id, .. } | Operation::Restore { id, .. } => {
                ensure!(
                    self.children.get(id).is_none_or(Vec::is_empty),
                    "benchmark mutates leaves only"
                );
                let block = self.blocks.get_mut(id).unwrap();
                block.deleted = matches!(op, Operation::Delete { .. });
                block.revision += 1;
                vec![id.clone()]
            }
            other => anyhow::bail!("unsupported independent model operation: {other:?}"),
        };
        Ok(touched)
    }

    fn place(&mut self, id: &str, parent: &str, after: Option<&str>) -> Result<()> {
        let children = self.children.entry(parent.into()).or_default();
        let position = match after {
            Some(after) => {
                children
                    .iter()
                    .position(|id| id == after)
                    .context("model sibling missing")?
                    + 1
            }
            None => 0,
        };
        children.insert(position, id.into());
        Ok(())
    }

    pub fn apply_model(&mut self, batch: &Batch) -> Result<Vec<Revision>> {
        let mut touched = Vec::new();
        let mut pages = BTreeSet::new();
        for op in &batch.operations {
            match op {
                Operation::CreatePage { id, .. } | Operation::CreateJournal { id, .. } => {
                    pages.insert(id.clone());
                }
                Operation::Insert { parent_id, .. } => {
                    pages.insert(self.blocks[parent_id].page.clone());
                }
                Operation::Split { id, .. }
                | Operation::Delete { id, .. }
                | Operation::Restore { id, .. } => {
                    pages.insert(self.blocks[id].page.clone());
                }
                Operation::Move { id, parent_id, .. } => {
                    pages.insert(self.blocks[id].page.clone());
                    pages.insert(self.blocks[parent_id].page.clone());
                }
                _ => {}
            }
            for id in self.operation(op)? {
                if !touched.contains(&id) {
                    touched.push(id);
                }
            }
        }
        let revisions = touched
            .into_iter()
            .map(|id| Revision {
                revision: self.blocks[&id].revision,
                id,
            })
            .collect::<Vec<_>>();
        self.changes.push((
            self.changes.len() as i64 + 1,
            revisions.clone(),
            pages.into_iter().collect(),
        ));
        Ok(revisions)
    }

    pub fn check_commit(&self, committed: &Committed, revisions: &[Revision]) -> Result<()> {
        ensure!(
            !committed.replayed && committed.seq == self.changes.len() as i64,
            "unexpected commit sequence/replay"
        );
        ensure!(
            committed.revisions == revisions,
            "commit revisions differ: {:?} != {:?}",
            committed.revisions,
            revisions
        );
        Ok(())
    }

    pub fn check_block(&self, block: &Block) -> Result<()> {
        let expected = self
            .blocks
            .get(&block.id)
            .context("unexpected returned block")?;
        ensure!(
            !expected.deleted
                && block.kind == expected.kind
                && block.parent_id == expected.parent
                && block.page_id == expected.page
                && block.text == expected.text
                && block.heading == expected.heading
                && block.archived == expected.archived
                && block.revision == expected.revision,
            "block {} differs from independent model: {block:?} vs {expected:?}",
            block.id
        );
        Ok(())
    }

    fn preorder(&self, parent: &str, depth: u32, out: &mut Vec<(String, u32)>) {
        if let Some(children) = self.children.get(parent) {
            for id in children {
                if !self.blocks[id].deleted {
                    out.push((id.clone(), depth));
                    self.preorder(id, depth + 1, out);
                }
            }
        }
    }

    pub fn check_page(&self, page: &PageView) -> Result<()> {
        self.check_block(&page.root)?;
        let mut expected = Vec::new();
        self.preorder(&page.root.id, 0, &mut expected);
        let actual = page
            .rows
            .iter()
            .map(|row| (row.block.id.clone(), row.depth))
            .collect::<Vec<_>>();
        ensure!(
            actual == expected,
            "page preorder/depth mismatch for {}",
            page.root.id
        );
        let mut targets = BTreeSet::new();
        for row in &page.rows {
            self.check_block(&row.block)?;
            for target in references(&row.block.text) {
                if self
                    .blocks
                    .get(&target)
                    .is_some_and(|block| !block.deleted && block.page != page.root.id)
                {
                    targets.insert(target);
                }
            }
        }
        if page
            .rows
            .iter()
            .any(|row| row.block.text.contains("#[[Page 00000]]"))
        {
            let type_page = self
                .blocks
                .values()
                .find(|block| {
                    !block.deleted && block.kind == BlockKind::Page && block.text == "Page 00000"
                })
                .context("benchmark type page")?;
            targets.insert(type_page.id.clone());
        }
        for title in page
            .rows
            .iter()
            .flat_map(|row| row.block.text.split_whitespace())
            .filter_map(|word| {
                word.strip_prefix("#bench_type_")
                    .map(|suffix| format!("bench_type_{suffix}"))
            })
        {
            let type_page = self
                .blocks
                .values()
                .find(|block| {
                    !block.deleted && block.kind == BlockKind::Page && block.text == title
                })
                .context("generated benchmark type page")?;
            targets.insert(type_page.id.clone());
        }
        let actual = page
            .targets
            .iter()
            .map(|block| block.id.clone())
            .collect::<BTreeSet<_>>();
        ensure!(
            actual == targets && actual.len() == page.targets.len(),
            "page targets mismatch"
        );
        for block in &page.targets {
            self.check_block(block)?;
        }
        Ok(())
    }

    pub fn search_ids(&self, query: &str, limit: usize) -> Vec<String> {
        let terms = tokens(query);
        let docs = self
            .blocks
            .values()
            .filter(|block| !block.deleted)
            .map(|block| (block, tokens(&block.text)))
            .collect::<Vec<_>>();
        let n = docs.len() as f64;
        let avg = docs.iter().map(|(_, words)| words.len()).sum::<usize>() as f64 / n;
        let idfs = terms
            .iter()
            .map(|term| {
                let matching = docs
                    .iter()
                    .filter(|(_, words)| words.iter().any(|word| word.starts_with(term)))
                    .count() as f64;
                ((n - matching + 0.5) / (matching + 0.5)).ln().max(1e-6)
            })
            .collect::<Vec<_>>();
        let mut hits = docs
            .iter()
            .filter_map(|(block, words)| {
                let mut score = 0.0;
                for (term, idf) in terms.iter().zip(&idfs) {
                    let frequency =
                        words.iter().filter(|word| word.starts_with(term)).count() as f64;
                    if frequency == 0.0 {
                        return None;
                    }
                    score -= idf * frequency * 2.2
                        / (frequency + 1.2 * (0.25 + 0.75 * words.len() as f64 / avg));
                }
                Some((score, block.id.clone()))
            })
            .collect::<Vec<_>>();
        hits.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        hits.into_iter().take(limit).map(|(_, id)| id).collect()
    }

    pub fn complete_ids(&self, query: &str, limit: usize) -> Vec<String> {
        let query = query.to_lowercase();
        let mut pages = self
            .blocks
            .values()
            .filter(|block| {
                !block.deleted
                    && block.kind == BlockKind::Page
                    && block.text.to_lowercase().starts_with(&query)
            })
            .collect::<Vec<_>>();
        pages.sort_by_key(|block| (block.text.to_lowercase(), block.id.clone()));
        let mut ids = pages
            .into_iter()
            .take(limit)
            .map(|block| block.id.clone())
            .collect::<Vec<_>>();
        for id in self.search_ids(&query, self.blocks.len()) {
            if ids.len() == limit {
                break;
            }
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    }

    pub fn backlink_ids(&self, target: &str, limit: usize) -> Vec<String> {
        self.blocks
            .values()
            .filter(|block| !block.deleted && references(&block.text).iter().any(|id| id == target))
            .take(limit)
            .map(|block| block.id.clone())
            .collect()
    }

    pub fn check_changes(&self, changes: &[ChangeEvent], after: i64, limit: usize) -> Result<()> {
        let expected = self
            .changes
            .iter()
            .filter(|(seq, _, _)| *seq > after)
            .take(limit)
            .collect::<Vec<_>>();
        ensure!(changes.len() == expected.len(), "changes count mismatch");
        for (change, (seq, revisions, pages)) in changes.iter().zip(expected) {
            let live = revisions
                .iter()
                .filter(|revision| !self.blocks[&revision.id].deleted)
                .map(|revision| &revision.id);
            let removed = revisions
                .iter()
                .filter(|revision| self.blocks[&revision.id].deleted)
                .map(|revision| &revision.id);
            ensure!(
                change.seq == *seq
                    && change.blocks.iter().map(|block| &block.id).eq(live)
                    && change.removed.iter().eq(removed)
                    && change.restructured_pages == *pages
                    && change.actor == batch(Vec::new()).actor
                    && change.reason == batch(Vec::new()).reason,
                "change history mismatch"
            );
            for block in &change.blocks {
                self.check_block(block)?;
            }
        }
        Ok(())
    }
}

fn tokens(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_lowercase)
        .collect()
}

pub fn references(text: &str) -> Vec<String> {
    text.split("[[")
        .skip(1)
        .filter_map(|part| {
            part.split_once("]]")
                .map(|(body, _)| body.split('|').next().unwrap().to_string())
        })
        .collect()
}
