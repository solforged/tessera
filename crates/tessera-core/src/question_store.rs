//! Question and assessment state, ancestry, and the single status derivation rule.
use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;

use crate::calendar::validate_civil_date;
use crate::reads::hidden_blocks;
use crate::storage::{block_at, block_columns, validate_id, validation};
use crate::{
    AssessmentInfo, AssessmentState, BlockCapabilities, BlockInPage, CurrentReading, Notebook,
    Operation, QuestionFilter, QuestionInfo, QuestionQuery, QuestionRow, QuestionState,
    QuestionStatus, Result,
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
    parent_id: Option<String>,
    parent_explicit: bool,
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
            COALESCE(parent.id, o.question_id), parent.id IS NOT NULL,
            b.deletion_id IS NULL AND root.deletion_id IS NULL
              AND b.rowid NOT IN (SELECT rowid FROM hidden)
         FROM seeds s JOIN blocks b ON b.id = s.id JOIN blocks root ON root.id = b.page_id
         LEFT JOIN questions q ON q.block_id = b.id
         LEFT JOIN assessments a ON a.block_id = b.id
         LEFT JOIN owners o ON o.id = b.id
         LEFT JOIN questions owner ON owner.block_id = o.question_id
         LEFT JOIN questions explicit ON explicit.block_id = json_extract(q.state, '$.parent')
           AND explicit.active = 1
         LEFT JOIN blocks parent ON parent.id = explicit.block_id AND parent.deletion_id IS NULL
           AND EXISTS (SELECT 1 FROM blocks pr WHERE pr.id = parent.page_id
             AND pr.deletion_id IS NULL)"
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
                    parent_id: row.get(5)?,
                    parent_explicit: row.get(6)?,
                    visible: row.get(7)?,
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
                parent_id: relation.parent_id.clone(),
                parent_explicit: relation.parent_explicit,
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

pub(crate) fn affected(
    conn: &Connection,
    id: &str,
    into: &mut HashSet<String>,
    check_parent_cycles: bool,
) -> Result<()> {
    let ids = conn
        .prepare_cached(
            "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM blocks WHERE id = ?1
            UNION ALL SELECT b.id FROM blocks b JOIN subtree s ON b.parent_id = s.id
         ) SELECT id FROM subtree WHERE id IN (SELECT block_id FROM questions)
            OR id IN (SELECT block_id FROM assessments)
            OR id IN (SELECT block_id FROM positions)
            UNION SELECT block_id FROM questions
              WHERE active = 1 AND json_extract(state, '$.parent') IN (SELECT id FROM subtree)",
        )?
        .query_map([id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    for relation in relations(conn, &ids)? {
        if let Some(question) = relation.question {
            if check_parent_cycles {
                validate_parent_chain(conn, &relation.id)?;
            }
            into.extend(question.accepted);
        }
        into.extend(relation.parent_id);
        if relation.assessment.is_some() {
            into.extend(relation.question_id);
        }
        into.insert(relation.id);
    }
    Ok(())
}

fn validate_parent_chain(conn: &Connection, id: &str) -> Result<()> {
    let mut seen = HashSet::from([id.to_owned()]);
    let mut current = id.to_owned();
    loop {
        let parent = relations(conn, std::slice::from_ref(&current))?
            .into_iter()
            .find(|r| r.id == current)
            .and_then(|r| r.parent_id);
        let Some(parent) = parent else { return Ok(()) };
        if !seen.insert(parent.clone()) {
            return Err(validation("A question cannot be part of its own branch."));
        }
        current = parent;
    }
}

pub(crate) fn withdraw_acceptance(conn: &Connection, answer: &str) -> Result<Vec<String>> {
    let owners = conn
        .prepare_cached(
            "SELECT q.block_id, q.state FROM questions q JOIN blocks b ON b.id = q.block_id
         WHERE q.active = 1 AND b.deletion_id IS NULL
         AND json_extract(q.state, '$.accepted') = ?1 ORDER BY q.block_id",
        )?
        .query_map([answer], |row| {
            Ok((
                row.get::<_, String>(0)?,
                json_at::<QuestionState>(row, 1)?.expect("question state is non-null"),
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut changed = Vec::with_capacity(owners.len());
    for (id, mut next) in owners {
        next.accepted = None;
        if set_state::<QuestionState>(conn, "questions", &id, None, Some(&next))? {
            changed.push(id);
        }
    }
    Ok(changed)
}

pub(crate) fn apply(conn: &Connection, operation: &Operation, today: &str) -> Result<bool> {
    match operation {
        Operation::SetQuestion { id, question, .. } => {
            if question.is_some() {
                crate::relation_store::guard_other(conn, id, "a question")?;
            }
            let current = relations(conn, std::slice::from_ref(id))?
                .into_iter()
                .find(|r| r.id == *id)
                .expect("Engine checked block");
            if current.assessment.is_some() && question.is_some() {
                return Err(validation(
                    "An atom cannot be both a question and an answer.",
                ));
            }
            let previous = current.question.as_ref();
            let accepted_changed = previous.and_then(|state| state.accepted.as_ref())
                != question.as_ref().and_then(|state| state.accepted.as_ref());
            let restoring = if previous.is_none()
                && let Some(accepted) = question.as_ref().and_then(|state| state.accepted.as_ref())
            {
                conn.prepare_cached("SELECT EXISTS(SELECT 1 FROM questions WHERE block_id = ?1 AND active = 0 AND json_extract(state, '$.accepted') = ?2)")?
                    .query_row(params![id, accepted], |row| row.get::<_, bool>(0))?
            } else {
                false
            };
            if accepted_changed
                && !restoring
                && question
                    .as_ref()
                    .is_some_and(|state| state.accepted.is_some())
                && (previous.is_some_and(|state| state.parked)
                    || question.as_ref().is_some_and(|state| state.parked))
            {
                return Err(validation(
                    "Resume the question before accepting an answer.",
                ));
            }
            let normalized = question.as_ref().map(|next| {
                if accepted_changed
                    && next.reading_history
                        == previous
                            .map(|state| state.reading_history.as_slice())
                            .unwrap_or_default()
                {
                    let mut state = next.clone();
                    state.accepted = previous.and_then(|state| state.accepted.clone());
                    state.with_current_reading(next.accepted.clone(), today.to_owned())
                } else {
                    next.clone()
                }
            });
            let question = &normalized;
            for decision in question.iter().flat_map(|state| &state.reading_history) {
                validate_id(&decision.assessment_id)?;
                validate_civil_date(&decision.on)?;
            }
            if let Some(date) = question.as_ref().and_then(|state| state.review_on.as_ref()) {
                validate_civil_date(date)?;
            }
            if let Some(parent) = question.as_ref().and_then(|state| state.parent.as_ref())
                && previous.and_then(|state| state.parent.as_ref()) != Some(parent)
            {
                validate_id(parent)?;
                if parent == id {
                    return Err(validation("A question cannot be its own parent."));
                }
                // Undo may reactivate a question with its existing dangling pointer.
                let valid: bool = conn
                    .prepare_cached(
                        "SELECT EXISTS(SELECT 1 FROM questions q JOIN blocks b ON b.id = q.block_id
                     JOIN blocks root ON root.id = b.page_id WHERE q.block_id = ?1
                     AND q.active = 1 AND b.deletion_id IS NULL AND root.deletion_id IS NULL)
                     OR EXISTS(SELECT 1 FROM questions WHERE block_id = ?2 AND active = 0
                     AND json_extract(state, '$.parent') = ?1)",
                    )?
                    .query_row(params![parent, id], |row| row.get(0))?;
                if !valid {
                    return Err(validation("Choose a live question as the parent."));
                }
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
                crate::relation_store::guard_other(conn, id, "an answer")?;
                validate_civil_date(&next.assessed_on)?;
                if current.question.is_some() {
                    return Err(validation(
                        "An atom cannot be both a question and an answer.",
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
        if let Some(parent) = &query.parent {
            validate_id(parent)?;
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
        let counts = crate::position_store::subject_counts(&self.conn)?;
        let today = self.today(jiff::Timestamp::now().as_millisecond())?;
        let accepted_ids: Vec<_> = infos
            .values()
            .filter_map(|info| info.state.accepted.as_ref())
            .collect();
        let valid_readings: HashSet<_> = crate::task_store::capabilities_for(
            &self.conn,
            &accepted_ids
                .iter()
                .map(|id| (*id).clone())
                .collect::<Vec<_>>(),
        )?
        .into_iter()
        .filter(|caps| {
            caps.assessment
                .as_ref()
                .is_some_and(|assessment| assessment.accepted)
        })
        .map(|caps| caps.block_id)
        .collect();
        let mut current_readings = HashMap::new();
        let mut statement = self.conn.prepare_cached(
            "SELECT a.block_id, a.state, b.text FROM assessments a JOIN blocks b ON b.id = a.block_id
             WHERE a.active = 1 AND b.deletion_id IS NULL
             AND a.block_id IN (SELECT value FROM json_each(?1))",
        )?;
        let readings = statement.query_map(
            [serde_json::to_string(&accepted_ids).expect("IDs serialize")],
            |row| {
                let state =
                    json_at::<AssessmentState>(row, 1)?.expect("assessment state is non-null");
                let text: String = row.get(2)?;
                Ok(CurrentReading {
                    id: row.get(0)?,
                    assessed_on: state.assessed_on,
                    text: text.lines().next().unwrap_or_default().to_owned(),
                })
            },
        )?;
        for reading in readings {
            let reading = reading?;
            current_readings.insert(reading.id.clone(), reading);
        }
        Ok(blocks
            .into_iter()
            .filter_map(|block| {
                let info = infos.remove(&block.block.id)?;
                if query.status.is_some_and(|status| status != info.status) {
                    return None;
                }
                if query.include_inline == Some(false) && block.block.id != block.page.id {
                    return None;
                }
                if query.state.is_some_and(|filter| match filter {
                    QuestionFilter::Active => !matches!(
                        info.status,
                        QuestionStatus::Open | QuestionStatus::Unsettled
                    ),
                    QuestionFilter::Recurrent => info.status != QuestionStatus::Unsettled,
                    QuestionFilter::Due => {
                        info.state.parked
                            || info
                                .state
                                .review_on
                                .as_deref()
                                .is_none_or(|date| date > today.as_str())
                    }
                    QuestionFilter::Answered => info.status != QuestionStatus::Answered,
                    QuestionFilter::Parked => info.status != QuestionStatus::Parked,
                }) {
                    return None;
                }
                if query
                    .parent
                    .as_deref()
                    .is_some_and(|parent| info.parent_id.as_deref() != Some(parent))
                {
                    return None;
                }
                let position_count = counts.get(&block.block.id).copied().unwrap_or_default();
                let current = info
                    .state
                    .accepted
                    .as_ref()
                    .and_then(|id| current_readings.get(id))
                    .filter(|reading| valid_readings.contains(&reading.id))
                    .cloned();
                let review_on = info.state.review_on.clone();
                Some(QuestionRow {
                    block,
                    info,
                    position_count,
                    current,
                    review_on,
                })
            })
            .take(query.limit.map_or(usize::MAX, |limit| limit as usize))
            .collect())
    }
}
