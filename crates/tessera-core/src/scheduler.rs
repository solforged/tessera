//! Remcard's SM-2 scheduler, with explicit timestamps and saturating boundaries.
//!
//! Hard and Good use the same interval formula with different ease adjustments.
//! Easy multiplies that formula's result by 1.3, including the first two reviews.

use serde::{Deserialize, Serialize};

pub const SCHEDULER_VERSION: u32 = 1;

const DEFAULT_EASE: f64 = 2.5;
const MIN_EASE: f64 = 1.3;
const MS_PER_DAY: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    /// The predecessor's SM-2 quality score, not the grade's UI position.
    pub const fn quality(self) -> u8 {
        match self {
            Self::Again => 1,
            Self::Hard => 3,
            Self::Good => 4,
            Self::Easy => 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchedulingState {
    pub ease_factor: f64,
    pub interval_days: u32,
    pub repetitions: u32,
    pub lapses: u32,
    /// Absolute Unix timestamp in milliseconds.
    pub due_at: i64,
    pub last_reviewed_at: Option<i64>,
}

/// New cards are immediately due at the caller's timestamp.
pub fn new_card(now_ms: i64) -> SchedulingState {
    SchedulingState {
        ease_factor: DEFAULT_EASE,
        interval_days: 0,
        repetitions: 0,
        lapses: 0,
        due_at: now_ms,
        last_reviewed_at: None,
    }
}

/// Apply one review without changing the input or consulting a wall clock.
pub fn schedule(state: &SchedulingState, grade: Grade, now_ms: i64) -> SchedulingState {
    let q = f64::from(grade.quality());
    let ease = state.ease_factor + (0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02));
    let ease = ease.max(MIN_EASE);
    // NaN and negative infinity take the floor above; positive infinity saturates
    // here so every result remains representable in the wire format.
    let ease = if ease.is_finite() { ease } else { f64::MAX };

    let (repetitions, lapses, interval) = if matches!(grade, Grade::Again) {
        (0, state.lapses.saturating_add(1), 1.0)
    } else {
        let repetitions = state.repetitions.saturating_add(1);
        let interval = match repetitions {
            1 => 1.0,
            2 => 6.0,
            _ => (f64::from(state.interval_days) * ease).max(1.0),
        };
        let interval = if matches!(grade, Grade::Easy) {
            interval * 1.3
        } else {
            interval
        };
        (repetitions, state.lapses, interval)
    };

    // Float-to-integer casts saturate, including when interval growth overflows.
    let interval_days = interval.round().max(1.0) as u32;
    // Even u32::MAX days fits in i64 milliseconds; only the timestamp can overflow.
    let due_at = now_ms.saturating_add(i64::from(interval_days) * MS_PER_DAY);
    SchedulingState {
        ease_factor: ease,
        interval_days,
        repetitions,
        lapses,
        due_at,
        last_reviewed_at: Some(now_ms),
    }
}

/// Independent outcomes in the fixed Again, Hard, Good, Easy display order.
pub fn previews(state: &SchedulingState, now_ms: i64) -> [(Grade, SchedulingState); 4] {
    [Grade::Again, Grade::Hard, Grade::Good, Grade::Easy]
        .map(|grade| (grade, schedule(state, grade, now_ms)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_ease(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-12, "{actual} != {expected}");
    }

    fn mature_card() -> SchedulingState {
        SchedulingState {
            interval_days: 10,
            repetitions: 2,
            lapses: 3,
            ..new_card(0)
        }
    }

    #[test]
    fn new_card_is_due_at_the_explicit_time() {
        for now_ms in [i64::MIN, -1, 0, 1_000, i64::MAX] {
            let state = new_card(now_ms);
            assert_eq!(state.due_at, now_ms);
            assert_eq!(state.last_reviewed_at, None);
            let reviewed = schedule(&state, Grade::Good, now_ms);
            assert_eq!(reviewed.repetitions, 1);
            assert_eq!(reviewed.interval_days, 1);
            assert_eq!(reviewed.due_at, now_ms.saturating_add(MS_PER_DAY));
            assert_eq!(reviewed.last_reviewed_at, Some(now_ms));
        }
    }

    #[test]
    fn first_two_successful_reviews_keep_the_predecessor_easy_bonus() {
        for (grade, second_days, second_ease) in [
            (Grade::Hard, 6, 2.22),
            (Grade::Good, 6, 2.5),
            (Grade::Easy, 8, 2.7),
        ] {
            let first = schedule(&new_card(17), grade, 29);
            assert_eq!(first.interval_days, 1);
            assert_eq!(first.repetitions, 1);
            assert_eq!(first.due_at, 29 + MS_PER_DAY);

            let second = schedule(&first, grade, 41);
            assert_eq!(second.interval_days, second_days);
            assert_eq!(second.repetitions, 2);
            assert_eq!(second.lapses, 0);
            assert_ease(second.ease_factor, second_ease);
            assert_eq!(second.due_at, 41 + i64::from(second_days) * MS_PER_DAY);
        }
    }

    #[test]
    fn mature_intervals_use_updated_ease_and_round_after_the_easy_bonus() {
        for (grade, days, ease, repetitions, lapses) in [
            (Grade::Again, 1, 1.96, 0, 4),
            (Grade::Hard, 24, 2.36, 3, 3),
            (Grade::Good, 25, 2.5, 3, 3),
            (Grade::Easy, 34, 2.6, 3, 3),
        ] {
            let reviewed = schedule(&mature_card(), grade, -123);
            assert_eq!(reviewed.interval_days, days);
            assert_ease(reviewed.ease_factor, ease);
            assert_eq!(reviewed.repetitions, repetitions);
            assert_eq!(reviewed.lapses, lapses);
            assert_eq!(reviewed.due_at, -123 + i64::from(days) * MS_PER_DAY);
            assert_eq!(reviewed.last_reviewed_at, Some(-123));
        }
    }

    #[test]
    fn again_restarts_progression_without_erasing_lapses() {
        let again = schedule(&mature_card(), Grade::Again, 101);
        assert_eq!(again.repetitions, 0);
        assert_eq!(again.lapses, 4);
        assert_eq!(again.interval_days, 1);
        let first = schedule(&again, Grade::Good, 102);
        assert_eq!(first.repetitions, 1);
        assert_eq!(first.interval_days, 1);
        assert_eq!(first.lapses, 4);
        let second = schedule(&first, Grade::Good, 103);
        assert_eq!(second.repetitions, 2);
        assert_eq!(second.interval_days, 6);
        assert_eq!(second.lapses, 4);
    }

    #[test]
    fn ease_reaches_the_floor_and_can_recover() {
        for grade in [Grade::Again, Grade::Hard] {
            let mut state = new_card(0);
            for _ in 0..20 {
                state = schedule(&state, grade, state.due_at);
                assert!(state.ease_factor >= MIN_EASE);
            }
            assert_eq!(state.ease_factor, MIN_EASE);
            assert_ease(schedule(&state, Grade::Easy, 0).ease_factor, 1.4);
        }
    }

    #[test]
    fn previews_are_independent_deterministic_review_outcomes() {
        let state = mature_card();
        let preview = previews(&state, 321);
        assert_eq!(preview, previews(&state, 321));
        for ((grade, outcome), (expected_grade, days, ease, repetitions, lapses)) in
            preview.into_iter().zip([
                (Grade::Again, 1, 1.96, 0, 4),
                (Grade::Hard, 24, 2.36, 3, 3),
                (Grade::Good, 25, 2.5, 3, 3),
                (Grade::Easy, 34, 2.6, 3, 3),
            ])
        {
            assert_eq!(grade, expected_grade);
            assert_eq!(outcome.interval_days, days);
            assert_ease(outcome.ease_factor, ease);
            assert_eq!(outcome.repetitions, repetitions);
            assert_eq!(outcome.lapses, lapses);
            assert_eq!(outcome.due_at, 321 + i64::from(days) * MS_PER_DAY);
            assert_eq!(outcome.last_reviewed_at, Some(321));
        }
        assert_eq!(state, mature_card());
    }

    #[test]
    fn interval_counters_and_due_time_saturate_without_wrapping() {
        let state = SchedulingState {
            ease_factor: f64::MAX,
            interval_days: u32::MAX,
            repetitions: u32::MAX,
            lapses: u32::MAX,
            ..new_card(0)
        };
        for grade in [Grade::Hard, Grade::Good, Grade::Easy] {
            let reviewed = schedule(&state, grade, i64::MAX - 1);
            assert_eq!(reviewed.interval_days, u32::MAX);
            assert_eq!(reviewed.repetitions, u32::MAX);
            assert_eq!(reviewed.lapses, u32::MAX);
            assert_eq!(reviewed.due_at, i64::MAX);
            assert_eq!(reviewed.last_reviewed_at, Some(i64::MAX - 1));
            assert_eq!(reviewed.ease_factor, f64::MAX);
        }
        let again = schedule(&state, Grade::Again, i64::MAX);
        assert_eq!(again.repetitions, 0);
        assert_eq!(again.lapses, u32::MAX);
        assert_eq!(again.interval_days, 1);
        assert_eq!(again.due_at, i64::MAX);
        let early = schedule(&state, Grade::Good, i64::MIN);
        assert_eq!(early.due_at, i64::MIN + i64::from(u32::MAX) * MS_PER_DAY);
    }

    #[test]
    fn invalid_ease_stays_finite_and_zero_mature_interval_becomes_one_day() {
        for ease in [f64::NAN, f64::NEG_INFINITY, -1.0, 0.0] {
            let state = SchedulingState {
                ease_factor: ease,
                interval_days: 0,
                ..mature_card()
            };
            for (_, reviewed) in previews(&state, 0) {
                assert_eq!(reviewed.ease_factor, MIN_EASE);
                assert_eq!(reviewed.interval_days, 1);
                assert_eq!(reviewed.due_at, MS_PER_DAY);
            }
        }
        let state = SchedulingState {
            ease_factor: f64::INFINITY,
            ..mature_card()
        };
        let reviewed = schedule(&state, Grade::Good, 0);
        assert_eq!(reviewed.ease_factor, f64::MAX);
        assert_eq!(reviewed.interval_days, u32::MAX);
    }
}
