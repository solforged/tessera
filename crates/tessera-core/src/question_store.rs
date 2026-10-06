//! Question and assessment state, ancestry, and the single status derivation rule.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

use crate::calendar::validate_civil_date;
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{
    AssessmentInfo, AssessmentState, BlockCapabilities, BlockInPage, Notebook, Operation,
    QuestionInfo, QuestionQuery, QuestionRow, QuestionState, QuestionStatus, Result,
};

pub fn question_status(state: &QuestionState, accepted_live: bool) -> QuestionStatus {
    if state.parked {
        QuestionStatus::Parked
    } else if state.unsettled {
        QuestionStatus::Unsettled
    } else if accepted_live {
        QuestionStatus::Answered
    } else {
        QuestionStatus::Open
    }
}

pub fn nearest_question_ancestor(conn: &Connection, block_id: &str) -> Result<Option<String>> {
    validate_id(block_id)?;
    Ok(conn
        .prepare_cached(
            "WITH RECURSIVE ancestors(id, depth) AS (
            SELECT parent_id, 0 FROM blocks WHERE id = ?1 AND parent_id IS NOT NULL
            UNION ALL
            SELECT b.parent_id, a.depth + 1 FROM ancestors a JOIN blocks b ON b.id = a.id
            WHERE b.parent_id IS NOT NULL
         ) SELECT a.id FROM ancestors a JOIN questions q ON q.block_id = a.id
           JOIN blocks b ON b.id = a.id
           WHERE q.active = 1 AND b.deletion_id IS NULL ORDER BY a.depth LIMIT 1",
        )?
        .query_row([block_id], |row| row.get(0))
        .optional()?)
}

fn json_at<T: DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<T>> {
    let json: Option<String> = row.get(index)?;
    json.map(|json| {
        serde_json::from_str(&json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    })
    .transpose()
}

struct Relation {
    id: String,
    question: Option<QuestionState>,
    assessment: Option<AssessmentState>,
    question_id: Option<String>,
    owner_accepted: Option<String>,
    visible: bool,
}

// Include accepted targets with the requested IDs, so validity and ancestry are
// loaded together. Page hydration never performs a query per capability.
fn relations(conn: &Connection, ids: &[String]) -> Result<Vec<Relation>> {
    Ok(conn
        .prepare_cached(concat!(
            hidden_blocks!(),
            ", seeds(id) AS (
            SELECT value FROM json_each(?1)
            UNION SELECT json_extract(q.state, '$.accepted') FROM questions q
              WHERE q.active = 1 AND q.block_id IN (SELECT value FROM json_each(?1))
         ), ancestors(source, id, depth) AS (
            SELECT b.id, b.parent_id, 0 FROM blocks b JOIN seeds s ON s.id = b.id
              WHERE b.parent_id IS NOT NULL
            UNION ALL
            SELECT a.source, b.parent_id, a.depth + 1 FROM ancestors a JOIN blocks b ON b.id = a.id
              WHERE b.parent_id IS NOT NULL
         ), owners AS (
            SELECT s.id, (SELECT a.id FROM ancestors a JOIN questions q ON q.block_id = a.id
              JOIN blocks b ON b.id = a.id
              WHERE a.source = s.id AND q.active = 1 AND b.deletion_id IS NULL
              ORDER BY a.depth LIMIT 1) AS question_id FROM seeds s
         ) SELECT b.id, CASE WHEN q.active = 1 THEN q.state END,
            CASE WHEN a.active = 1 THEN a.state END, o.question_id,
            json_extract(owner.state, '$.accepted'),
            b.deletion_id IS NULL AND root.deletion_id IS NULL
              AND b.rowid NOT IN (SELECT rowid FROM hidden)
         FROM seeds s JOIN blocks b ON b.id = s.id JOIN blocks root ON root.id = b.page_id
         LEFT JOIN questions q ON q.block_id = b.id
         LEFT JOIN assessments a ON a.block_id = b.id
         LEFT JOIN owners o ON o.id = b.id
         LEFT JOIN questions owner ON owner.block_id = o.question_id"
        ))?
        .query_map(
            [serde_json::to_string(ids).expect("IDs serialize")],
            |row| {
                Ok(Relation {
                    id: row.get(0)?,
                    question: json_at(row, 1)?,
                    assessment: json_at(row, 2)?,
                    question_id: row.get(3)?,
                    owner_accepted: row.get(4)?,
                    visible: row.get(5)?,
                })
            },
        )?
        .collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn hydrate(
    conn: &Connection,
    mut capabilities: Vec<BlockCapabilities>,
) -> Result<Vec<BlockCapabilities>> {
    let ids: Vec<_> = capabilities
        .iter()
        .map(|capability| capability.block_id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(capabilities);
    }
    let relations = relations(conn, &ids)?;
    let live: HashMap<_, _> = relations
        .iter()
        .filter(|r| r.visible && r.assessment.is_some())
        .map(|r| (r.id.as_str(), r.question_id.as_deref()))
        .collect();
    let mut infos = HashMap::new();
    for relation in &relations {
        let question = relation.question.as_ref().map(|state| {
            let accepted_live = state
                .accepted
                .as_deref()
                .is_some_and(|id| live.get(id) == Some(&Some(relation.id.as_str())));
            QuestionInfo {
                state: state.clone(),
                status: question_status(state, accepted_live),
            }
        });
        let assessment = relation.assessment.as_ref().map(|state| AssessmentInfo {
            state: state.clone(),
            question_id: relation.question_id.clone(),
            accepted: relation.visible
                && relation.owner_accepted.as_deref() == Some(relation.id.as_str()),
        });
        infos.insert(relation.id.as_str(), (question, assessment));
    }
    for capability in &mut capabilities {
        if let Some((question, assessment)) = infos.remove(capability.block_id.as_str()) {
            capability.merge_protected |= question.is_some() || assessment.is_some();
            capability.question = question;
            capability.assessment = assessment;
        }
    }
    Ok(capabilities)
}

pub(crate) fn affected(conn: &Connection, id: &str, into: &mut HashSet<String>) -> Result<()> {
    let ids = conn
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM blocks WHERE id = ?1
            UNION ALL SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
         ) SELECT id FROM subtree WHERE id IN (SELECT block_id FROM questions)
            OR id IN (SELECT block_id FROM assessments)",
        )?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for relation in relations(conn, &ids)? {
        if let Some(question) = relation.question {
            into.extend(question.accepted);
        }
        if relation.assessment.is_some() {
            into.extend(relation.question_id);
        }
        into.insert(relation.id);
    }
    Ok(())
}

pub(crate) fn apply(conn: &Connection, operation: &Operation) -> Result<bool> {
    match operation {
        Operation::SetQuestion { id, question, .. } => {
            let current = relations(conn, std::slice::from_ref(id))?
                .into_iter()
                .find(|r| r.id == *id)
                .expect("Engine checked block");
            if current.assessment.is_some() && question.is_some() {
                return Err(validation(
                    "A block cannot be both a question and an answer.",
                ));
            }
            let previous = current.question.as_ref();
            let accepted_changed = previous.and_then(|state| state.accepted.as_ref())
                != question.as_ref().and_then(|state| state.accepted.as_ref());
            if accepted_changed
                && (previous.is_some_and(|state| state.parked)
                    || question.as_ref().is_some_and(|state| state.parked))
            {
                return Err(validation(
                    "Resume the question before accepting an answer.",
                ));
            }
            if let Some(date) = question.as_ref().and_then(|state| state.review_on.as_ref()) {
                validate_civil_date(date)?;
            }
            // Activate first so ancestry is also correct when undo restores a
            // removed question. Validation failure rolls back the entire batch.
            let changed = set_state(conn, "questions", id, previous, question.as_ref())?;
            if accepted_changed
                && let Some(accepted) = question.as_ref().and_then(|state| state.accepted.as_ref())
            {
                validate_id(accepted)?;
                let valid = relations(conn, std::slice::from_ref(accepted))?
                    .into_iter()
                    .any(|r| {
                        r.id == *accepted
                            && r.visible
                            && r.assessment.is_some()
                            && r.question_id.as_deref() == Some(id.as_str())
                    });
                if !valid {
                    return Err(validation("Accept an active answer beneath this question."));
                }
            }
            Ok(changed)
        }
        Operation::SetAssessment { id, assessment, .. } => {
            let current = relations(conn, std::slice::from_ref(id))?
                .into_iter()
                .find(|r| r.id == *id)
                .expect("Engine checked block");
            if let Some(next) = assessment {
                validate_civil_date(&next.assessed_on)?;
                if current.question.is_some() {
                    return Err(validation(
                        "A block cannot be both a question and an answer.",
                    ));
                }
                let owner = current
                    .question_id
                    .as_ref()
                    .ok_or_else(|| validation("Put the answer under a question first."))?;
                if current.assessment.is_none() {
                    let parked: bool = conn.prepare_cached("SELECT json_extract(state, '$.parked') FROM questions WHERE block_id = ?1")?
                        .query_row([owner], |row| row.get(0))?;
                    if parked {
                        return Err(validation("Resume the question before answering it."));
                    }
                }
            }
            set_state(
                conn,
                "assessments",
                id,
                current.assessment.as_ref(),
                assessment.as_ref(),
            )
        }
        _ => Err(validation(
            "operation does not update a question or assessment",
        )),
    }
}

fn set_state<T: serde::Serialize + PartialEq>(
    conn: &Connection,
    table: &str,
    id: &str,
    previous: Option<&T>,
    next: Option<&T>,
) -> Result<bool> {
    if previous == next {
        return Ok(false);
    }
    if let Some(next) = next {
        let sql = match table {
            "questions" => {
                "INSERT INTO questions(block_id, active, state) VALUES (?1, 1, ?2)
                ON CONFLICT(block_id) DO UPDATE SET active = 1, state = excluded.state"
            }
            "assessments" => {
                "INSERT INTO assessments(block_id, active, state) VALUES (?1, 1, ?2)
                ON CONFLICT(block_id) DO UPDATE SET active = 1, state = excluded.state"
            }
            _ => unreachable!("question capability table"),
        };
        conn.prepare_cached(sql)?.execute(params![
            id,
            serde_json::to_string(next).expect("capability state serializes")
        ])?;
    } else {
        let sql = match table {
            "questions" => "UPDATE questions SET active = 0 WHERE block_id = ?1",
            "assessments" => "UPDATE assessments SET active = 0 WHERE block_id = ?1",
            _ => unreachable!("question capability table"),
        };
        conn.prepare_cached(sql)?.execute([id])?;
    }
    Ok(true)
}

impl Notebook {
    pub fn questions(&self, query: &QuestionQuery) -> Result<Vec<QuestionRow>> {
        if let Some(date) = &query.review_by {
            validate_civil_date(date)?;
        }
        let blocks = self
            .conn
            .prepare_cached(concat!(hidden_blocks!(),
            "SELECT ", block_columns!("b"), ", ", block_columns!("p"),
            " FROM questions q JOIN blocks b ON b.id = q.block_id JOIN blocks p ON p.id = b.page_id
              WHERE q.active = 1 AND b.deletion_id IS NULL AND p.deletion_id IS NULL
              AND b.rowid NOT IN (SELECT rowid FROM hidden)
              AND (?1 IS NULL OR (json_extract(q.state, '$.parked') = 0
                AND json_extract(q.state, '$.review_on') <= ?1))
              ORDER BY b.id"
        ))?
            .query_map([query.review_by.as_deref()], |row| {
                Ok(BlockInPage {
                    block: block_at(row, 0)?,
                    page: block_at(row, 10)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let ids: Vec<_> = blocks.iter().map(|b| b.block.id.clone()).collect();
        let mut infos: HashMap<_, _> = crate::task_store::capabilities_for(&self.conn, &ids)?
            .into_iter()
            .filter_map(|c| c.question.map(|info| (c.block_id, info)))
            .collect();
        Ok(blocks
            .into_iter()
            .filter_map(|block| {
                let info = infos.remove(&block.block.id)?;
                if query.status.is_some_and(|status| status != info.status) {
                    return None;
                }
                Some(QuestionRow { block, info })
            })
            .take(query.limit.map_or(usize::MAX, |limit| limit as usize))
            .collect())
    }
}
