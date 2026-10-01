use std::path::Path;
use std::time::Instant;

use anyhow::{Result, ensure};
use serde::Serialize;
use tessera_core::{Backlink, Block, Change, Notebook, Operation, PageView, SearchHit};

use crate::corpus::{Corpus, Model, batch, id, references};
use crate::http::Http;

/// Which statistic a measurement's pass/fail compares against its budget.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Statistic {
    P95,
    /// Scaling checks compare medians: a p95 over 31 runs is the second
    /// slowest sample, which one slow fsync on a shared disk decides.
    Median,
}

#[derive(Serialize)]
pub struct Measurement {
    pub size: usize,
    pub seed: u64,
    pub logical_hash: String,
    pub transport: String,
    pub operation: String,
    pub page_rows: Option<usize>,
    pub runs: usize,
    pub median_ms: f64,
    pub p95_ms: f64,
    pub budget_ms: Option<f64>,
    pub checks: Statistic,
    pub passed: bool,
}

impl Measurement {
    /// The value compared against the budget.
    pub fn checked_ms(&self) -> f64 {
        match self.checks {
            Statistic::P95 => self.p95_ms,
            Statistic::Median => self.median_ms,
        }
    }

    pub fn is_scaling(&self) -> bool {
        self.checks == Statistic::Median
    }
}

pub struct Recorder {
    pub rows: Vec<Measurement>,
    pub size: usize,
    pub seed: u64,
    pub logical_hash: String,
    pub runs: usize,
}

impl Recorder {
    fn record(
        &mut self,
        transport: &str,
        operation: &str,
        page_rows: Option<usize>,
        mut times: Vec<f64>,
        budget_ms: Option<f64>,
    ) {
        times.sort_by(f64::total_cmp);
        let median_ms = if times.len().is_multiple_of(2) {
            (times[times.len() / 2 - 1] + times[times.len() / 2]) / 2.0
        } else {
            times[times.len() / 2]
        };
        let p95_ms = times[(times.len() * 95).div_ceil(100) - 1];
        self.rows.push(Measurement {
            size: self.size,
            seed: self.seed,
            logical_hash: self.logical_hash.clone(),
            transport: transport.into(),
            operation: operation.into(),
            page_rows,
            runs: times.len(),
            median_ms,
            p95_ms,
            budget_ms,
            checks: Statistic::P95,
            passed: budget_ms.is_none_or(|budget| p95_ms <= budget),
        });
    }

    pub fn scaling(&mut self) -> Result<()> {
        if self.size != 50000 {
            return Ok(());
        }
        for transport in ["core", "http"] {
            for operation in [
                "commit_edit_text",
                "commit_insert",
                "commit_split",
                "commit_move",
                "commit_delete",
                "commit_restore",
            ] {
                let small = self
                    .rows
                    .iter()
                    .find(|row| {
                        row.transport == transport
                            && row.operation == operation
                            && row.page_rows == Some(100)
                    })
                    .ok_or_else(|| anyhow::anyhow!("missing small-page measurement"))?;
                let large = self
                    .rows
                    .iter()
                    .find(|row| {
                        row.transport == transport
                            && row.operation == operation
                            && row.page_rows == Some(10000)
                    })
                    .ok_or_else(|| anyhow::anyhow!("missing large-page measurement"))?;
                let limit = 2.0 * small.median_ms + 1.0;
                self.rows.push(Measurement {
                    size: self.size,
                    seed: self.seed,
                    logical_hash: self.logical_hash.clone(),
                    transport: transport.into(),
                    operation: format!("{operation}_no_per_row_work"),
                    page_rows: Some(10000),
                    runs: large.runs,
                    median_ms: large.median_ms,
                    p95_ms: large.p95_ms,
                    budget_ms: Some(limit),
                    checks: Statistic::Median,
                    passed: large.median_ms <= limit,
                });
            }
        }
        Ok(())
    }
}

fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

pub async fn queries(corpus: &Corpus, dir: &Path, recorder: &mut Recorder) -> Result<()> {
    let model = &corpus.model;
    let notebook = Notebook::open(dir)?;
    let http = Http::start(dir).await?;
    for (&rows, page_id) in &corpus.pages {
        for cold in [true, false] {
            let operation = if cold { "page_cold" } else { "page_warm" };
            let budget = if cold { 500.0 } else { 100.0 };
            // Connection-cold, not OS-cache-cold. No privileged cache eviction.
            if !cold {
                model.check_page(&notebook.page(page_id)?)?;
            }
            let mut times = Vec::new();
            for _ in 0..recorder.runs {
                let start = Instant::now();
                let page = if cold {
                    Notebook::open(dir)?.page(page_id)?
                } else {
                    notebook.page(page_id)?
                };
                times.push(elapsed(start));
                model.check_page(&page)?;
            }
            recorder.record("core", operation, Some(rows), times, Some(budget));
            if !cold {
                model.check_page(
                    &http
                        .get::<PageView>(&format!("/api/pages/{page_id}"))
                        .await?,
                )?;
            }
            let mut times = Vec::new();
            for _ in 0..recorder.runs {
                let start = Instant::now();
                let page = if cold {
                    let fresh = Http::start(dir).await?;
                    fresh
                        .get::<PageView>(&format!("/api/pages/{page_id}"))
                        .await?
                } else {
                    http.get::<PageView>(&format!("/api/pages/{page_id}"))
                        .await?
                };
                times.push(elapsed(start));
                model.check_page(&page)?;
            }
            recorder.record("http", operation, Some(rows), times, Some(budget));
        }
    }
    for query in ["Page", "cobalt", "needle000001", "absentword"] {
        let expected = model.complete_ids(query, 30);
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result = notebook.complete(query, 30)?;
            times.push(elapsed(start));
            check_blocks(model, &result, &expected)?;
        }
        recorder.record(
            "core",
            &format!("complete:{query}"),
            None,
            times,
            Some(25.0),
        );
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result: Vec<Block> = http
                .get(&format!("/api/complete?q={query}&limit=30"))
                .await?;
            times.push(elapsed(start));
            check_blocks(model, &result, &expected)?;
        }
        recorder.record(
            "http",
            &format!("complete:{query}"),
            None,
            times,
            Some(25.0),
        );
        let expected = model.search_ids(query, 30);
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result = notebook.search(query, 30)?;
            times.push(elapsed(start));
            check_search(model, &result, &expected)?;
        }
        recorder.record("core", &format!("search:{query}"), None, times, Some(50.0));
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result: Vec<SearchHit> =
                http.get(&format!("/api/search?q={query}&limit=30")).await?;
            times.push(elapsed(start));
            check_search(model, &result, &expected)?;
        }
        recorder.record("http", &format!("search:{query}"), None, times, Some(50.0));
    }
    // Exercise both an existing referenced target and an empty backlink result.
    let target = model
        .blocks
        .values()
        .find_map(|block| references(&block.text).into_iter().next())
        .unwrap();
    for target in [target.clone(), id(recorder.seed, recorder.size + 1)] {
        let expected = model.backlink_ids(&target, 100);
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result = notebook.backlinks(&target, 100)?;
            times.push(elapsed(start));
            check_backlinks(model, &result, &expected)?;
        }
        recorder.record("core", &format!("backlinks:{target}"), None, times, None);
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result: Vec<Backlink> = http
                .get(&format!("/api/blocks/{target}/backlinks?limit=100"))
                .await?;
            times.push(elapsed(start));
            check_backlinks(model, &result, &expected)?;
        }
        recorder.record("http", &format!("backlinks:{target}"), None, times, None);
    }
    for after in [
        0,
        model.changes.len() as i64 / 2,
        model.changes.len() as i64,
    ] {
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result = notebook.changes_since(after, 100)?;
            times.push(elapsed(start));
            model.check_changes(&result, after, 100)?;
        }
        recorder.record(
            "core",
            &format!("changes_since:{after}"),
            None,
            times,
            Some(100.0),
        );
        let mut times = Vec::new();
        for _ in 0..recorder.runs {
            let start = Instant::now();
            let result: Vec<Change> = http
                .get(&format!("/api/changes?after={after}&limit=100"))
                .await?;
            times.push(elapsed(start));
            model.check_changes(&result, after, 100)?;
        }
        recorder.record(
            "http",
            &format!("changes_since:{after}"),
            None,
            times,
            Some(100.0),
        );
    }
    Ok(())
}

fn check_blocks(model: &Model, blocks: &[Block], ids: &[String]) -> Result<()> {
    ensure!(
        blocks.iter().map(|block| &block.id).eq(ids.iter()),
        "completion differs from naive scan"
    );
    for block in blocks {
        model.check_block(block)?;
    }
    Ok(())
}

fn check_search(model: &Model, hits: &[SearchHit], ids: &[String]) -> Result<()> {
    ensure!(
        hits.iter().map(|hit| &hit.block.id).eq(ids.iter()),
        "search differs from naive scan: {:?} != {ids:?}",
        hits.iter().map(|hit| &hit.block.id).collect::<Vec<_>>()
    );
    for hit in hits {
        model.check_block(&hit.block)?;
        model.check_block(&hit.page)?;
        ensure!(hit.block.page_id == hit.page.id, "search page mismatch");
    }
    Ok(())
}

fn check_backlinks(model: &Model, hits: &[Backlink], ids: &[String]) -> Result<()> {
    ensure!(
        hits.iter().map(|hit| &hit.source.id).eq(ids.iter()),
        "backlinks differ from naive scan"
    );
    for hit in hits {
        model.check_block(&hit.source)?;
        model.check_block(&hit.page)?;
        ensure!(hit.source.page_id == hit.page.id, "backlink page mismatch");
    }
    Ok(())
}

pub async fn commits(
    corpus: &Corpus,
    dir: &Path,
    recorder: &mut Recorder,
    transport: &str,
) -> Result<()> {
    let work = tempfile::tempdir_in(dir.parent().unwrap())?;
    std::fs::copy(
        dir.join(tessera_core::DATABASE_FILE),
        work.path().join(tessera_core::DATABASE_FILE),
    )?;
    let mut notebook = Notebook::open(work.path())?;
    let http = if transport == "http" {
        Some(Http::start(work.path()).await?)
    } else {
        None
    };
    let mut model = corpus.model.clone();
    let mut serial = corpus.model.blocks.len() + 1000;
    for (&rows, page_id) in &corpus.pages {
        if rows != 100 && rows != 10000 {
            continue;
        }
        let target = corpus.model.children[page_id].last().unwrap().clone();
        let original = model.blocks[&target].text.clone();
        let destination = corpus.model.children[page_id].first().unwrap().clone();
        for operation in ["edit_text", "insert", "split", "move", "delete", "restore"] {
            let mut times = Vec::new();
            for run in 0..recorder.runs {
                let mut deletion = None;
                if operation == "restore" {
                    let revision = model.blocks[&target].revision;
                    deletion = Some(
                        apply(
                            &mut notebook,
                            http.as_ref(),
                            &mut model,
                            Operation::Delete {
                                id: target.clone(),
                                base_revision: revision,
                            },
                        )
                        .await?
                        .0
                        .deletions[0]
                            .clone(),
                    );
                }
                let revision = model.blocks[&target].revision;
                serial += 1;
                let new_id = id(recorder.seed, serial);
                let op = match operation {
                    "edit_text" => Operation::EditText {
                        id: target.clone(),
                        base_revision: revision,
                        text: format!("{original} edit{run}"),
                    },
                    "insert" => Operation::Insert {
                        id: new_id.clone(),
                        parent_id: page_id.clone(),
                        after: Some(target.clone()),
                        text: "benchmark insertion".into(),
                        heading: None,
                    },
                    "split" => {
                        let text = &model.blocks[&target].text;
                        let offset = text.find(' ').unwrap();
                        Operation::Split {
                            id: target.clone(),
                            base_revision: revision,
                            new_id: new_id.clone(),
                            left: text[..offset].into(),
                            right: text[offset..].into(),
                        }
                    }
                    "move" => Operation::Move {
                        id: target.clone(),
                        base_revision: revision,
                        parent_id: if model.blocks[&target].parent.as_deref() == Some(page_id) {
                            destination.clone()
                        } else {
                            page_id.clone()
                        },
                        after: None,
                    },
                    "delete" => Operation::Delete {
                        id: target.clone(),
                        base_revision: revision,
                    },
                    "restore" => Operation::Restore {
                        id: target.clone(),
                        deletion_id: deletion.unwrap(),
                        revision,
                    },
                    _ => unreachable!(),
                };
                let (committed, ms) = apply(&mut notebook, http.as_ref(), &mut model, op).await?;
                times.push(ms);
                // Check full observable page state independently, outside timing.
                check_current_page(&notebook, http.as_ref(), &model, page_id).await?;
                let cleanup = match operation {
                    "insert" => vec![Operation::Delete {
                        id: new_id.clone(),
                        base_revision: model.blocks[&new_id].revision,
                    }],
                    "split" => vec![
                        Operation::EditText {
                            id: target.clone(),
                            base_revision: model.blocks[&target].revision,
                            text: original.clone(),
                        },
                        Operation::Delete {
                            id: new_id.clone(),
                            base_revision: model.blocks[&new_id].revision,
                        },
                    ],
                    "delete" => vec![Operation::Restore {
                        id: target.clone(),
                        deletion_id: committed.deletions[0].clone(),
                        revision: model.blocks[&target].revision,
                    }],
                    _ => Vec::new(),
                };
                for op in cleanup {
                    apply(&mut notebook, http.as_ref(), &mut model, op).await?;
                }
            }
            recorder.record(
                transport,
                &format!("commit_{operation}"),
                Some(rows),
                times,
                Some(50.0),
            );
        }
    }
    Ok(())
}

async fn apply(
    notebook: &mut Notebook,
    http: Option<&Http>,
    model: &mut Model,
    op: Operation,
) -> Result<(tessera_core::Committed, f64)> {
    let batch = batch(vec![op]);
    let revisions = model.apply_model(&batch)?;
    let start = Instant::now();
    let committed = match http {
        Some(http) => http.apply(&batch).await?,
        None => notebook.apply(&batch)?,
    };
    let ms = elapsed(start);
    model.check_commit(&committed, &revisions)?;
    Ok((committed, ms))
}

async fn check_current_page(
    notebook: &Notebook,
    http: Option<&Http>,
    model: &Model,
    page_id: &str,
) -> Result<()> {
    let page = match http {
        Some(http) => {
            http.get::<PageView>(&format!("/api/pages/{page_id}"))
                .await?
        }
        None => notebook.page(page_id)?,
    };
    model.check_page(&page)
}
