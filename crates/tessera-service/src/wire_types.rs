//! The TypeScript declarations of the wire types, written from the Rust
//! types that serialize them: the workshop's from `tessera-core`, the
//! workshop routes' from `tessera-api` and the service's own. `mise run wire`
//! rewrites `web/src/api/wire.ts`; the test fails when that file no longer
//! matches. It lives here because this crate sees all three.

use std::any::TypeId;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use ts_rs::{Config, TS, TypeVisitor};

const HEADER: &str = "// Generated from the Rust wire types by `mise run wire`. Do not edit:\n// change the Rust type, then run `mise run wire`.\n";

struct Collector {
    config: Config,
    seen: HashSet<TypeId>,
    declarations: BTreeMap<String, String>,
}

impl TypeVisitor for Collector {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() || !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        let mut text = T::docs().unwrap_or_default();
        text.push_str(&layout(&format!("export {}", T::decl(&self.config))));
        let previous = self.declarations.insert(T::ident(&self.config), text);
        assert!(
            previous.is_none(),
            "two wire types are named {}",
            T::ident(&self.config)
        );
        T::visit_dependencies(self);
    }
}

macro_rules! roots {
    ($collector:ident: $($ty:ty),* $(,)?) => { $($collector.visit::<$ty>();)* };
}

enum Token {
    Comment(String),
    Text(String),
    Mark(char),
}

fn tokens(source: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '/' if chars.peek() == Some(&'*') => {
                let mut comment = String::from(c);
                while !comment.ends_with("*/") {
                    comment.push(chars.next().expect("closed comment"));
                }
                tokens.push(Token::Comment(comment));
            }
            '"' => {
                let mut text = String::from(c);
                loop {
                    let next = chars.next().expect("closed string");
                    text.push(next);
                    match next {
                        '\\' => text.push(chars.next().expect("escaped character")),
                        '"' => break,
                        _ => {}
                    }
                }
                tokens.push(Token::Text(text));
            }
            '\n' => {}
            ' ' if matches!(tokens.last(), Some(Token::Mark(' ' | '{' | ','))) => {}
            _ => tokens.push(Token::Mark(c)),
        }
    }
    tokens
}

/// One field or union member per line, so a changed field is a one-line diff.
/// A declaration without objects that fits on a line stays there.
fn layout(declaration: &str) -> String {
    let (head, body) = declaration.split_once(" = ").expect("a type declaration");
    let tokens = tokens(body);
    let mut nesting = 0;
    let mut union = false;
    for token in &tokens {
        match token {
            Token::Mark('{' | '<' | '(' | '[') => nesting += 1,
            Token::Mark('}' | '>' | ')' | ']') => nesting -= 1,
            Token::Mark('|') if nesting == 0 => union = true,
            _ => {}
        }
    }
    if !body.contains('{') && !body.contains("/*") && declaration.len() <= 100 {
        return format!("{declaration}\n");
    }
    let base = usize::from(union);
    let mut out = format!("{head} =");
    let line = |out: &mut String, depth: usize| {
        while out.ends_with(' ') {
            out.pop();
        }
        out.push('\n');
        out.push_str(&"  ".repeat(depth));
    };
    if union {
        line(&mut out, 1);
        out.push_str("| ");
    } else {
        out.push(' ');
    }
    let mut stack: Vec<char> = Vec::new();
    let depth = |stack: &[char]| base + stack.iter().filter(|c| **c == '{').count();
    let mut tokens = tokens.into_iter().peekable();
    while let Some(token) = tokens.next() {
        match token {
            Token::Comment(comment) => {
                for (index, text) in comment.lines().enumerate() {
                    if index > 0 {
                        line(&mut out, depth(&stack));
                        out.push(' ');
                    }
                    out.push_str(text.trim());
                }
                line(&mut out, depth(&stack));
            }
            Token::Text(text) => out.push_str(&text),
            Token::Mark('{') => {
                if matches!(tokens.peek(), Some(Token::Mark('}'))) {
                    tokens.next();
                    out.push_str("{}");
                } else {
                    out.push('{');
                    stack.push('{');
                    line(&mut out, depth(&stack));
                }
            }
            Token::Mark('}') => {
                stack.pop();
                line(&mut out, depth(&stack));
                out.push('}');
            }
            Token::Mark(open @ ('<' | '(' | '[')) => {
                stack.push(open);
                out.push(open);
            }
            Token::Mark(close @ ('>' | ')' | ']')) => {
                stack.pop();
                out.push(close);
            }
            Token::Mark(',') if stack.last() == Some(&'{') => {
                out.push(',');
                if !matches!(tokens.peek(), Some(Token::Mark('}'))) {
                    line(&mut out, depth(&stack));
                }
            }
            Token::Mark('|') if stack.is_empty() => {
                line(&mut out, 1);
                out.push_str("| ");
                if matches!(tokens.peek(), Some(Token::Mark(' '))) {
                    tokens.next();
                }
            }
            Token::Mark(c) => out.push(c),
        }
    }
    out.push('\n');
    out
}

fn declarations() -> String {
    let mut collector = Collector {
        config: Config::new().with_large_int("number"),
        seen: HashSet::new(),
        declarations: BTreeMap::new(),
    };
    roots!(collector:
        tessera_core::Actor,
        tessera_core::Agenda,
        tessera_core::AgendaItem,
        tessera_core::AgendaReason,
        tessera_core::AssessmentInfo,
        tessera_core::AssessmentState,
        tessera_core::Backlink,
        tessera_core::Batch,
        tessera_core::BatchSubtree,
        tessera_core::BatchSubtrees,
        tessera_core::Block,
        tessera_core::BlockCapabilities,
        tessera_core::BlockInPage,
        tessera_core::BlockKind,
        tessera_core::CardAnswerBlock,
        tessera_core::card_text::CardKind,
        tessera_core::CardPreviews,
        tessera_core::CardQuery,
        tessera_core::CardQueryResult,
        tessera_core::CardRow,
        tessera_core::CardSelection,
        tessera_core::CardTemplate,
        tessera_core::CardTemplateForecast,
        tessera_core::CardTemplateInfo,
        tessera_core::CardTemplateProvenance,
        tessera_core::CardUnit,
        tessera_core::ChangeEvent,
        tessera_core::library::Citation,
        tessera_core::Committed,
        tessera_core::Completion,
        tessera_core::CrossReference,
        tessera_core::CurrentReading,
        tessera_core::DateRange,
        tessera_core::Deck,
        tessera_core::DeletedPage,
        tessera_core::Direction,
        tessera_core::library::ExtractedCreator,
        tessera_core::library::ExtractedMetadata,
        tessera_core::FieldChoiceCandidate,
        tessera_core::FieldDefinition,
        tessera_core::FieldDetail,
        tessera_core::FieldKind,
        tessera_core::FieldOwner,
        tessera_core::FieldOwnerValues,
        tessera_core::FieldsView,
        tessera_core::FieldSummary,
        tessera_core::FieldValue,
        tessera_core::FieldValueUse,
        tessera_core::Filter,
        tessera_core::FilterOp,
        tessera_core::scheduler::Grade,
        tessera_core::GradePreview,
        tessera_core::library::HighlightQuery,
        tessera_core::library::HighlightResult,
        tessera_core::library::HighlightRow,
        tessera_core::HistoryEntry,
        tessera_core::ImageRef,
        tessera_core::IncomingFieldValue,
        tessera_core::IndexKind,
        tessera_core::library::IngestJob,
        tessera_core::library::IngestPlan,
        tessera_core::KeptCopy,
        tessera_core::sync::KeptCopy,
        tessera_core::KindIndex,
        tessera_core::library::LibraryFacets,
        tessera_core::library::LibraryPerson,
        tessera_core::library::LibraryQuery,
        tessera_core::library::LibraryResult,
        tessera_core::library::LibraryRow,
        tessera_core::library::LibraryView,
        tessera_core::library::Mark,
        tessera_core::library::MarkKind,
        tessera_core::Mention,
        tessera_core::NameMatch,
        tessera_core::NoteEntry,
        tessera_core::NoteGroup,
        tessera_core::NoteIndex,
        tessera_core::NoteKind,
        tessera_core::NoteState,
        tessera_core::NoteSummary,
        tessera_core::NoteView,
        tessera_core::WorkshopInfo,
        tessera_core::occlusion::Occlusion,
        tessera_core::occlusion::OcclusionGroup,
        tessera_core::occlusion::OcclusionMask,
        tessera_core::Operation,
        tessera_core::PageReferences,
        tessera_core::PageView,
        tessera_core::library::Passage,
        tessera_core::library::PassageHit,
        tessera_core::library::PassageKind,
        tessera_core::library::PassagePage,
        tessera_core::library::PassagePoint,
        tessera_core::PositionInfo,
        tessera_core::PositionQuery,
        tessera_core::PositionQueryResult,
        tessera_core::PositionQuestion,
        tessera_core::PositionRow,
        tessera_core::ProjectRecord,
        tessera_core::ProjectState,
        tessera_core::ProjectStatus,
        tessera_core::Query,
        tessera_core::QueryAttribute,
        tessera_core::QueryAttributeValue,
        tessera_core::QueryColumn,
        tessera_core::QueryGroup,
        tessera_core::QueryGrouping,
        tessera_core::QueryResult,
        tessera_core::QueryRow,
        tessera_core::QuerySource,
        tessera_core::QuestionFilter,
        tessera_core::QuestionInfo,
        tessera_core::QuestionQuery,
        tessera_core::QuestionRow,
        tessera_core::QuestionState,
        tessera_core::QuestionStatus,
        tessera_core::QuoteState,
        tessera_core::QuoteStatus,
        tessera_core::QuotedRow,
        tessera_core::Reading,
        tessera_core::ReadingDecision,
        tessera_core::library::ReadingPosition,
        tessera_core::library::ReadingProgress,
        tessera_core::library::ReadingState,
        tessera_core::ReadingStatus,
        tessera_core::RecipeDetail,
        tessera_core::occlusion::Rect,
        tessera_core::ReferenceCount,
        tessera_core::ReferenceGroup,
        tessera_core::ReferenceSource,
        tessera_core::sync::RejectedChange,
        tessera_core::RelationEndpoint,
        tessera_core::RelationInfo,
        tessera_core::RelationKind,
        tessera_core::RelationQuery,
        tessera_core::RelationRow,
        tessera_core::calendar::RepeatMode,
        tessera_core::calendar::RepeatUnit,
        tessera_core::calendar::Repeater,
        tessera_core::RequiredField,
        tessera_core::ReviewEvent,
        tessera_core::ReviewEventKind,
        tessera_core::ReviewForecastDay,
        tessera_core::ReviewSchedulingState,
        tessera_core::ReviewSession,
        tessera_core::ReviewSessionState,
        tessera_core::ReviewStats,
        tessera_core::Revision,
        tessera_core::RevisitAction,
        tessera_core::RevisitEvent,
        tessera_core::RevisitRow,
        tessera_core::RevisitSnapshot,
        tessera_core::Row,
        tessera_core::scheduler::SchedulingState,
        tessera_core::SeeTarget,
        tessera_core::Setting,
        tessera_core::SettingRevision,
        tessera_core::SettingsView,
        tessera_core::Shelf,
        tessera_core::library::SnapshotSummary,
        tessera_core::SortKey,
        tessera_core::library::SourceFormat,
        tessera_core::library::SourceRecord,
        tessera_core::library::SourceState,
        tessera_core::SourceSummary,
        tessera_core::library::SourceView,
        tessera_core::Spread,
        tessera_core::SpreadColumn,
        tessera_core::SpreadField,
        tessera_core::SpreadReference,
        tessera_core::SpreadValue,
        tessera_core::library::StagedSnapshot,
        tessera_core::StreamArrival,
        tessera_core::SubjectCriteria,
        tessera_core::Subtree,
        tessera_core::SummaryField,
        tessera_core::library::Surfacing,
        tessera_core::sync::ReplicaConflicts,
        tessera_core::TagDeck,
        tessera_core::TaskFilter,
        tessera_core::TaskOccurrence,
        tessera_core::TaskPriority,
        tessera_core::TaskQuery,
        tessera_core::TaskQueryResult,
        tessera_core::TaskRecord,
        tessera_core::TaskRow,
        tessera_core::TaskSelection,
        tessera_core::TaskState,
        tessera_core::TaskStatus,
        tessera_core::TaskView,
        tessera_core::TextRewrite,
        tessera_core::library::TocEntry,
        tessera_core::Topic,
        tessera_core::TypeInfo,
        tessera_core::UndoReceipt,
        tessera_core::UnlinkedMentions,
        tessera_core::View,
        tessera_core::WorkSession,
        tessera_core::YearSpan
    );
    roots!(collector:
        tessera_api::ConflictDetails,
        tessera_api::HistoryResponse,
        tessera_api::library::LinkPreview,
        tessera_api::library::Preview,
        tessera_api::library::SurfacingBody,
        crate::SyncVersion,
        crate::agent::ContextRef,
        crate::agent::Event,
        crate::agent::Events,
        crate::agent::ProviderTestResult,
        crate::agent::Start,
        crate::agent::Started,
        crate::agent::ThreadMessage,
        crate::agent::store::ProviderInput,
        crate::agent::store::ProviderView,
        crate::agent::store::Providers,
        crate::agent::store::SaveProviders,
        crate::backups::BackupInfo,
        crate::backups::Backups,
        crate::backups::CreatedBackup,
        crate::backups::OtherBackups,
        crate::backups::RestoringBackup,
        crate::info::WorkshopSize,
        crate::info::ServiceInfo,
        crate::notebooks::Entry,
        crate::notebooks::Opening,
        crate::notebooks::Workshops,
        crate::pairing::DeviceRecord,
        crate::pairing::PairingCode,
        crate::pairing::PairingStatus,
        crate::pairing::SyncDevices,
        crate::replica::ReplicaState,
        crate::replica::SyncState,
        crate::sharing::Sharing,
        crate::replica::Attempt,
        crate::sync_client::Pairing
    );
    let mut text = String::from(HEADER);
    for declaration in collector.declarations.values() {
        text.push('\n');
        text.push_str(declaration);
    }
    text
}

#[test]
fn wire_types_match_the_editor() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/src/api/wire.ts");
    let expected = declarations();
    if std::env::var_os("TESSERA_WRITE_WIRE").is_some() {
        std::fs::write(&path, &expected).unwrap();
        return;
    }
    let found = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        found == expected,
        "web/src/api/wire.ts is out of date with the Rust wire types; run `mise run wire`"
    );
}
