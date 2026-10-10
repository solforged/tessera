//! Deterministic FSRS-6, default weights and 90% desired retention.
//!
//! Memory equations follow the official py-fsrs implementation, pinned at
//! https://github.com/open-spaced-repetition/py-fsrs/tree/9446cb06605c597a063aeee49f7d188d42e34dc2
//! (fsrs/scheduler.py). A small in-house port keeps the native and wasm paths
//! identical without an optimizer, random source, clock or learning-step engine.
//! Session requeueing belongs to the caller; scheduled intervals are whole days.

use serde::{Deserialize, Serialize};

pub const SCHEDULER_VERSION: &str = "fsrs-6";
const MS_PER_DAY: i64 = 86_400_000;
const MAX_INTERVAL: u32 = 36_500;
const MIN_STABILITY: f64 = 0.001;
const W: [f64; 21] = [
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835,
    0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];
const GRADES: [Grade; 4] = [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    const fn index(self) -> usize {
        match self {
            Self::Again => 0,
            Self::Hard => 1,
            Self::Good => 2,
            Self::Easy => 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulingState {
    pub stability: Option<f64>,
    pub difficulty: Option<f64>,
    pub interval_days: u32,
    pub repetitions: u32,
    pub lapses: u32,
    /// Absolute Unix timestamp in milliseconds.
    pub due_at: i64,
    pub last_reviewed_at: Option<i64>,
}

/// New cards have no memory estimate and are immediately due.
pub fn new_card(now_ms: i64) -> SchedulingState {
    SchedulingState {
        stability: None,
        difficulty: None,
        interval_days: 0,
        repetitions: 0,
        lapses: 0,
        due_at: now_ms,
        last_reviewed_at: None,
    }
}

fn initial_difficulty(rating: f64) -> f64 {
    W[4] - (W[5] * (rating - 1.0)).exp() + 1.0
}

fn memory(state: &SchedulingState, grade: Grade, now_ms: i64) -> (f64, f64) {
    let rating = grade.index() as f64 + 1.0;
    let (Some(stability), Some(difficulty), Some(last)) =
        (state.stability, state.difficulty, state.last_reviewed_at)
    else {
        return (
            W[grade.index()],
            initial_difficulty(rating).clamp(1.0, 10.0),
        );
    };
    let elapsed_days = now_ms.saturating_sub(last).max(0) / MS_PER_DAY;
    let next_difficulty = (W[7] * initial_difficulty(4.0)
        + (1.0 - W[7]) * (difficulty - W[6] * (rating - 3.0) * (10.0 - difficulty) / 9.0))
        .clamp(1.0, 10.0);
    let next_stability = if elapsed_days == 0 {
        let increase = (W[17] * (rating - 3.0 + W[18])).exp() * stability.powf(-W[19]);
        stability
            * if grade == Grade::Again {
                increase
            } else {
                increase.max(1.0)
            }
    } else {
        let decay = -W[20];
        let factor = 0.9_f64.powf(1.0 / decay) - 1.0;
        let retrievability = (1.0 + factor * elapsed_days as f64 / stability).powf(decay);
        if grade == Grade::Again {
            let long = W[11]
                * difficulty.powf(-W[12])
                * ((stability + 1.0).powf(W[13]) - 1.0)
                * ((1.0 - retrievability) * W[14]).exp();
            long.min(stability / (W[17] * W[18]).exp())
        } else {
            let hard = if grade == Grade::Hard { W[15] } else { 1.0 };
            let easy = if grade == Grade::Easy { W[16] } else { 1.0 };
            stability
                * (1.0
                    + W[8].exp()
                        * (11.0 - difficulty)
                        * stability.powf(-W[9])
                        * (((1.0 - retrievability) * W[10]).exp() - 1.0)
                        * hard
                        * easy)
        }
    };
    (next_stability.max(MIN_STABILITY), next_difficulty)
}

/// At retention 0.9 the FSRS interval formula simplifies exactly to stability.
fn interval(stability: f64) -> u32 {
    stability
        .round_ties_even()
        .clamp(1.0, f64::from(MAX_INTERVAL)) as u32
}

/// Independent memory outcomes in Again, Hard, Good, Easy display order.
/// Integer rounding and the ceiling can tie intervals. Reserve two days at the
/// ceiling, then separate Hard/Good/Easy by at least one day. This changes only
/// scheduling dates, never the FSRS memory estimates, and also applies on grade.
pub fn previews(state: &SchedulingState, now_ms: i64) -> [(Grade, SchedulingState); 4] {
    let memories = GRADES.map(|grade| memory(state, grade, now_ms));
    let hard = interval(memories[1].0).min(MAX_INTERVAL - 2);
    let good = interval(memories[2].0).clamp(hard + 1, MAX_INTERVAL - 1);
    let easy = interval(memories[3].0).clamp(good + 1, MAX_INTERVAL);
    let days = [interval(memories[0].0).min(hard), hard, good, easy];
    std::array::from_fn(|index| {
        let grade = GRADES[index];
        let (stability, difficulty) = memories[index];
        let interval_days = days[index];
        (
            grade,
            SchedulingState {
                stability: Some(stability),
                difficulty: Some(difficulty),
                interval_days,
                repetitions: if grade == Grade::Again {
                    0
                } else {
                    state.repetitions.saturating_add(1)
                },
                lapses: state
                    .lapses
                    .saturating_add(u32::from(grade == Grade::Again)),
                due_at: now_ms.saturating_add(i64::from(interval_days) * MS_PER_DAY),
                last_reviewed_at: Some(now_ms),
            },
        )
    })
}

/// Apply one review without consulting a clock. Exactly matches its preview.
pub fn schedule(state: &SchedulingState, grade: Grade, now_ms: i64) -> SchedulingState {
    let outcomes = previews(state, now_ms);
    outcomes
        .into_iter()
        .nth(grade.index())
        .expect("four grades")
        .1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_py_fsrs_memo_state_vector() {
        // tests/test_basic.py::TestPyFSRS::test_memo_state at the pinned commit.
        // Explicit elapsed days make learning-step/fuzz choices irrelevant.
        let mut state = new_card(0);
        let mut now = 0;
        for (grade, days) in [
            (Grade::Again, 0),
            (Grade::Good, 0),
            (Grade::Good, 1),
            (Grade::Good, 3),
            (Grade::Good, 8),
            (Grade::Good, 21),
        ] {
            now += days * MS_PER_DAY;
            state = schedule(&state, grade, now);
        }
        assert!((state.stability.unwrap() - 53.62691).abs() < 1e-4);
        assert!((state.difficulty.unwrap() - 6.3574867).abs() < 1e-4);
    }

    #[test]
    fn official_py_fsrs_review_sequence_including_forgetting() {
        // test_review_card's exact review times: its learning/relearning steps
        // are sub-day, but its memory updates are the same as ours.
        let mut state = new_card(0);
        let mut now = 0;
        for (grade, elapsed, expected) in [
            (Grade::Good, 0, Some(2)),
            (Grade::Good, 0, Some(2)),
            (Grade::Good, 2, Some(11)),
            (Grade::Good, 11, Some(46)),
            (Grade::Good, 46, Some(163)),
            (Grade::Good, 163, Some(498)),
            (Grade::Again, 498, None),
            (Grade::Again, 0, None),
            (Grade::Good, 0, Some(2)),
            (Grade::Good, 2, Some(4)),
            (Grade::Good, 4, Some(7)),
            (Grade::Good, 7, Some(12)),
            (Grade::Good, 12, Some(21)),
        ] {
            now += elapsed * MS_PER_DAY;
            state = schedule(&state, grade, now);
            if let Some(expected) = expected {
                assert_eq!(interval(state.stability.unwrap()), expected);
            }
        }
    }

    #[test]
    fn default_initial_memory_and_intervals() {
        let outcomes = previews(&new_card(0), 123);
        for (index, (grade, state)) in outcomes.iter().enumerate() {
            assert_eq!(state.stability, Some(W[index]));
            assert_eq!(state.interval_days, [1, 1, 2, 8][index]);
            assert_eq!(state, &schedule(&new_card(0), *grade, 123));
        }
    }

    #[test]
    fn all_outcomes_are_ordered_bounded_and_deterministic() {
        for stability in [0.001, 0.212, 1.0, 2.3065, 100.0, 36_500.0, 1e9] {
            for difficulty in [1.0, 5.0, 10.0] {
                for days in [0, 1, 30, 100_000] {
                    let state = SchedulingState {
                        stability: Some(stability),
                        difficulty: Some(difficulty),
                        last_reviewed_at: Some(0),
                        repetitions: u32::MAX,
                        lapses: u32::MAX,
                        ..new_card(0)
                    };
                    let now = days * MS_PER_DAY;
                    let outcomes = previews(&state, now);
                    let intervals = outcomes.each_ref().map(|(_, value)| value.interval_days);
                    assert!(intervals[0] <= intervals[1]);
                    assert!(intervals[1] < intervals[2] && intervals[2] < intervals[3]);
                    for (grade, value) in outcomes {
                        assert!((1..=MAX_INTERVAL).contains(&value.interval_days));
                        assert!(value.stability.unwrap().is_finite());
                        assert!((1.0..=10.0).contains(&value.difficulty.unwrap()));
                        assert_eq!(value, schedule(&state, grade, now));
                    }
                }
            }
        }
    }

    #[test]
    fn new_cards_and_timestamp_boundaries() {
        for now in [i64::MIN, -1, 0, i64::MAX] {
            let state = new_card(now);
            assert_eq!(state.stability, None);
            assert_eq!(state.difficulty, None);
            assert_eq!(state.due_at, now);
            let outcome = schedule(&state, Grade::Good, now);
            assert_eq!(outcome.due_at, now.saturating_add(2 * MS_PER_DAY));
            assert_eq!(outcome.last_reviewed_at, Some(now));
        }
    }
}
