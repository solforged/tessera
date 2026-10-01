mod corpus;
mod http;
mod measure;
mod plans;

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, ensure};
use clap::{Parser, ValueEnum};
use corpus::Corpus;
use measure::{Measurement, Recorder};

#[derive(Parser)]
#[command(about = "Stage 0 release-only backend correctness and performance exit test")]
struct Args {
    #[arg(long, default_value = ".tessera/bench")]
    root: PathBuf,
    #[arg(long, value_delimiter = ',', default_value = "1000,10000,50000")]
    sizes: Vec<usize>,
    #[arg(long, default_value_t = 42)]
    seed: u64,
    #[arg(long, default_value_t = 31)]
    runs: usize,
    #[arg(long)]
    force: bool,
    /// Exit nonzero on missed checks. `budgets` fails on any miss and is the
    /// gate on a named device; `scaling` fails only on the no-per-row-work
    /// checks, for shared CI runners where absolute latency is not meaningful.
    /// Correctness failures always exit nonzero.
    #[arg(long, value_enum)]
    fail_on: Option<FailOn>,
}

#[derive(Clone, Copy, ValueEnum)]
enum FailOn {
    Budgets,
    Scaling,
}

impl FailOn {
    fn flag(self) -> &'static str {
        match self {
            Self::Budgets => " --fail-on budgets",
            Self::Scaling => " --fail-on scaling",
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        !cfg!(debug_assertions),
        "measurements require cargo run --release -p tessera-bench"
    );
    ensure!(
        args.runs >= 20,
        "at least 20 repeated runs are required for p95"
    );
    ensure!(!args.sizes.is_empty(), "select at least one corpus size");
    std::fs::create_dir_all(&args.root)?;
    let results = args.root.join("results");
    std::fs::create_dir_all(&results)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let output = results.join(format!("run-{stamp}.jsonl"));
    let mut file = std::fs::File::create(&output)?;
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|name| name.trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    let metadata = serde_json::json!({
        "kind": "environment", "timestamp_ms": stamp, "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH, "host": host,
        "sqlite_version": rusqlite::version(), "schema_version": tessera_core::SCHEMA_VERSION,
        "profile": "release", "runs": args.runs, "seed": args.seed,
        "command": std::env::args().collect::<Vec<_>>(),
        "cold_definition": "fresh Notebook connection; OS file cache is not evicted; cold HTTP additionally starts a fresh loopback server and client",
        "http_definition": "real loopback TCP, service dispatch, JSON encoding and client JSON decoding",
        "page_definition": "descendant rows; root is additional; no viewport rendering is measured",
    });
    writeln!(file, "{metadata}")?;
    let mut all = Vec::new();
    for size in &args.sizes {
        eprintln!("tessera-bench: generating/checking {size} blocks");
        let corpus = Corpus::generate(*size, args.seed)?;
        let dir = corpus.materialize(&args.root, *size, args.seed, args.force)?;
        plans::save(&dir, &results, *size, &corpus, stamp)?;
        let mut recorder = Recorder {
            rows: Vec::new(),
            size: *size,
            seed: args.seed,
            logical_hash: corpus.logical_hash.clone(),
            runs: args.runs,
        };
        measure::queries(&corpus, &dir, &mut recorder).await?;
        measure::commits(&corpus, &dir, &mut recorder, "core").await?;
        measure::commits(&corpus, &dir, &mut recorder, "http").await?;
        recorder.scaling()?;
        for row in &recorder.rows {
            writeln!(file, "{}", serde_json::to_string(row)?)?;
        }
        file.flush()?;
        all.extend(recorder.rows);
        summary(&results, &all, &args, &output, stamp)?;
    }
    println!("Results: {}", output.display());
    println!("Summary: {}", results.join("latest-summary.md").display());
    let misses = all.iter().filter(|row| !row.passed).collect::<Vec<_>>();
    for row in &misses {
        eprintln!(
            "MISS {} {} {} rows={:?}: {} {:.3} ms > {:.3} ms",
            row.size,
            row.transport,
            row.operation,
            row.page_rows,
            if row.is_scaling() { "median" } else { "p95" },
            row.checked_ms(),
            row.budget_ms.unwrap()
        );
    }
    let failing = match args.fail_on {
        None => 0,
        Some(FailOn::Budgets) => misses.len(),
        Some(FailOn::Scaling) => misses.iter().filter(|row| row.is_scaling()).count(),
    };
    ensure!(
        failing == 0,
        "{failing} performance checks missed; see summary and query plans"
    );
    Ok(())
}

fn summary(
    results: &std::path::Path,
    rows: &[Measurement],
    args: &Args,
    output: &std::path::Path,
    stamp: u128,
) -> Result<()> {
    let mut text = format!(
        "# Backend benchmark results\n\nCommand: `cargo run --release -p tessera-bench -- --root {} --sizes {} --seed {} --runs {}{}{}`\n\nRelease build, {} {}. Each measured result passed an independent generator-model check. Cold means a fresh connection, not an evicted OS cache. HTTP includes real loopback TCP and JSON. These are backend page loads, not rendered viewport timings.\n\nJSONL: `{}`. Query plans: `plans-<size>-{stamp}.json`. Median is p50; p95 uses nearest rank. Budgets compare p95. No-per-row-work rows compare the 10,000-row page's median against twice the 100-row page's median plus 1 ms. Backlinks have no specified stage 0 latency budget. Changes use the 100 ms cross-window visibility ceiling as a query ceiling, not an end-to-end propagation claim.\n\n| Blocks | Transport | Operation | Page rows | Median ms | p95 ms | Budget ms | Result |\n|---:|---|---|---:|---:|---:|---:|---|\n",
        args.root.display(),
        args.sizes
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(","),
        args.seed,
        args.runs,
        if args.force { " --force" } else { "" },
        args.fail_on.map_or("", FailOn::flag),
        std::env::consts::OS,
        std::env::consts::ARCH,
        output.display()
    );
    for row in rows {
        text.push_str(&format!(
            "| {} | {} | {} | {} | {:.3} | {:.3} | {} | {} |\n",
            row.size,
            row.transport,
            row.operation,
            row.page_rows
                .map_or_else(|| "-".into(), |rows| rows.to_string()),
            row.median_ms,
            row.p95_ms,
            row.budget_ms
                .map_or_else(|| "not specified".into(), |budget| format!("{budget:.3}")),
            if row.passed { "PASS" } else { "FAIL" }
        ));
    }
    std::fs::write(results.join("latest-summary.md"), text)?;
    Ok(())
}
