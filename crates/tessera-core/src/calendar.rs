//! Local Gregorian planning dates and clock labels, never timestamps.

use jiff::{Span, civil::Date};
use serde::{Deserialize, Serialize};

use crate::storage::{validate_date, validation};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepeatUnit {
    Day,
    Week,
    Month,
    Year,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepeatMode {
    Fixed,
    CatchUp,
    AfterCompletion,
}

/// A positive interval whose next occurrence must fit the civil date range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repeater {
    pub every: u32,
    pub unit: RepeatUnit,
    pub mode: RepeatMode,
}

/// Accept only canonical `YYYY-MM-DD` dates from year 0001 through 9999.
pub fn validate_civil_date(date: &str) -> Result<()> {
    validate_date(date).map_err(|_| {
        validation("civil date must be valid YYYY-MM-DD between 0001-01-01 and 9999-12-31")
    })
}

/// Accept a local, zero-padded 24-hour `HH:MM` label, including DST gap/fold labels.
pub fn validate_clock_time(time: &str) -> Result<()> {
    let bytes = time.as_bytes();
    if bytes.len() != 5
        || bytes[2] != b':'
        || !bytes[..2].iter().all(u8::is_ascii_digit)
        || !bytes[3..].iter().all(u8::is_ascii_digit)
    {
        return Err(validation("clock time must be HH:MM"));
    }
    let hour = (bytes[0] - b'0') * 10 + bytes[1] - b'0';
    let minute = (bytes[3] - b'0') * 10 + bytes[4] - b'0';
    if hour > 23 || minute > 59 {
        return Err(validation("clock time must be between 00:00 and 23:59"));
    }
    Ok(())
}

/// Add signed calendar days without choosing a timezone or an instant.
pub fn add_days(date: &str, days: i64) -> Result<String> {
    Ok(shift_days(parse_date(date)?, days)?.to_string())
}

/// The signed number of calendar days from `start` to `end`.
pub fn days_between(start: &str, end: &str) -> Result<i64> {
    Ok(day_difference(parse_date(start)?, parse_date(end)?))
}

/// Advance at least one interval. Catch-up selects the first subsequent
/// occurrence strictly after completion, calculated from the original anchor
/// so intermediate month/year clamps do not accumulate.
pub fn advance_repeat(anchor: &str, completed_on: &str, repeat: &Repeater) -> Result<String> {
    Ok(advance_dates(parse_date(anchor)?, parse_date(completed_on)?, repeat)?.to_string())
}

/// Advance the scheduled date, or the deadline when scheduled is absent.
/// A two-sided window retains its exact day separation in every repeat mode.
/// Callers retain the independent clock labels unchanged.
pub fn advance_window(
    scheduled: Option<&str>,
    deadline: Option<&str>,
    completed_on: &str,
    repeat: &Repeater,
) -> Result<(Option<String>, Option<String>)> {
    let scheduled = scheduled.map(parse_date).transpose()?;
    let deadline = deadline.map(parse_date).transpose()?;
    let anchor = scheduled
        .or(deadline)
        .ok_or_else(|| validation("recurrence requires a planning date"))?;
    let next = advance_dates(anchor, parse_date(completed_on)?, repeat)?;
    let next_deadline = match (scheduled, deadline) {
        (Some(start), Some(end)) => Some(shift_days(next, day_difference(start, end))?),
        (None, Some(_)) => Some(next),
        _ => None,
    };
    Ok((
        scheduled.map(|_| next.to_string()),
        next_deadline.map(|date| date.to_string()),
    ))
}

fn parse_date(date: &str) -> Result<Date> {
    validate_civil_date(date)?;
    date.parse().map_err(|_| out_of_range())
}

fn out_of_range() -> Error {
    validation("calendar arithmetic must stay between 0001-01-01 and 9999-12-31")
}

fn day_difference(start: Date, end: Date) -> i64 {
    // Jiff's date subtraction is infallible and returns a day-only span.
    i64::from((end - start).get_days())
}

fn shift_date(date: Date, span: Span) -> Result<Date> {
    let next = date.checked_add(span).map_err(|_| out_of_range())?;
    // Jiff also supports year zero and negative years; planning dates do not.
    if next.year() < 1 {
        return Err(out_of_range());
    }
    Ok(next)
}

fn shift_days(date: Date, days: i64) -> Result<Date> {
    let span = Span::new().try_days(days).map_err(|_| out_of_range())?;
    shift_date(date, span)
}

fn shift_repeat(date: Date, repeat: &Repeater, steps: i64) -> Result<Date> {
    let count = i64::from(repeat.every)
        .checked_mul(steps)
        .ok_or_else(out_of_range)?;
    let span = match repeat.unit {
        RepeatUnit::Day => Span::new().try_days(count),
        RepeatUnit::Week => Span::new().try_days(count.checked_mul(7).ok_or_else(out_of_range)?),
        RepeatUnit::Month => Span::new().try_months(count),
        RepeatUnit::Year => Span::new().try_months(count.checked_mul(12).ok_or_else(out_of_range)?),
    }
    .map_err(|_| out_of_range())?;
    shift_date(date, span)
}

fn advance_dates(anchor: Date, completed_on: Date, repeat: &Repeater) -> Result<Date> {
    if repeat.every == 0 {
        return Err(validation("repeat interval must be greater than zero"));
    }
    match repeat.mode {
        RepeatMode::Fixed => shift_repeat(anchor, repeat, 1),
        RepeatMode::AfterCompletion => shift_repeat(completed_on, repeat, 1),
        RepeatMode::CatchUp => {
            let elapsed_units = match repeat.unit {
                RepeatUnit::Day => day_difference(anchor, completed_on),
                RepeatUnit::Week => day_difference(anchor, completed_on) / 7,
                RepeatUnit::Month | RepeatUnit::Year => {
                    let months = (i64::from(completed_on.year()) - i64::from(anchor.year())) * 12
                        + i64::from(completed_on.month())
                        - i64::from(anchor.month());
                    if repeat.unit == RepeatUnit::Year {
                        months / 12
                    } else {
                        months
                    }
                }
            };
            // Jump directly to the interval containing completion. At most one
            // further step is needed, even across the entire supported range.
            let steps = (elapsed_units.max(0) / i64::from(repeat.every)).max(1);
            let candidate = shift_repeat(anchor, repeat, steps)?;
            if candidate > completed_on {
                Ok(candidate)
            } else {
                shift_repeat(
                    anchor,
                    repeat,
                    steps.checked_add(1).ok_or_else(out_of_range)?,
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repeater(every: u32, unit: RepeatUnit, mode: RepeatMode) -> Repeater {
        Repeater { every, unit, mode }
    }

    fn assert_validation<T: std::fmt::Debug>(result: Result<T>) {
        assert!(
            matches!(result, Err(Error::Validation { op_index: None, .. })),
            "{result:?}"
        );
    }

    #[test]
    fn civil_dates_are_strict_and_use_gregorian_leap_rules() {
        for date in [
            "0001-01-01",
            "9999-12-31",
            "2000-02-29",
            "2024-02-29",
            "2400-02-29",
        ] {
            assert!(validate_civil_date(date).is_ok(), "{date}");
        }
        for date in [
            "",
            "0000-01-01",
            "10000-01-01",
            "-0001-01-01",
            "1900-02-29",
            "2100-02-29",
            "2023-02-29",
            "2024-04-31",
            "2024-00-01",
            "2024-13-01",
            "2024-01-00",
            "2024-1-01",
            "2024-01-1",
            " 2024-01-01",
            "2024-01-01\n",
            "2024/01/01",
            "2024-01-01T00:00",
            "２０２４-01-01",
            "2024-0é-01",
        ] {
            assert_validation(validate_civil_date(date));
        }
    }

    #[test]
    fn clock_labels_are_strict_without_dst_resolution() {
        for time in ["00:00", "01:30", "02:30", "09:30", "23:59"] {
            assert!(validate_clock_time(time).is_ok(), "{time}");
        }
        for time in [
            "", "9:30", "09:3", "24:00", "09:60", "-1:00", "09:30:00", "09:30Z", " 09:30",
            "09:30 ", "09:30\n", "09：30", "０9:30", "00:0０", "aa:bb",
        ] {
            assert_validation(validate_clock_time(time));
        }
    }

    #[test]
    fn signed_days_cross_leap_century_and_year_boundaries() {
        for (start, delta, end) in [
            ("2024-02-28", 1, "2024-02-29"),
            ("2024-02-28", 2, "2024-03-01"),
            ("1900-02-28", 1, "1900-03-01"),
            ("2000-02-28", 1, "2000-02-29"),
            ("2024-03-01", -2, "2024-02-28"),
            ("2024-12-31", 1, "2025-01-01"),
            ("0001-01-01", 3_652_058, "9999-12-31"),
            ("9999-12-31", -3_652_058, "0001-01-01"),
            ("2024-11-03", 0, "2024-11-03"),
        ] {
            assert_eq!(add_days(start, delta).unwrap(), end);
            assert_eq!(days_between(start, end).unwrap(), delta);
            assert_eq!(days_between(end, start).unwrap(), -delta);
        }
    }

    #[test]
    fn day_arithmetic_rejects_invalid_inputs_and_overflow() {
        for (date, delta) in [
            ("0001-01-01", -1),
            ("9999-12-31", 1),
            ("0001-01-01", 3_652_059),
            ("2024-01-01", i64::MIN),
            ("2024-01-01", i64::MAX),
            ("2024-02-30", 0),
        ] {
            assert_validation(add_days(date, delta));
        }
        assert_validation(days_between("2024-01-01", "2024-02-30"));
        assert_validation(days_between("0000-01-01", "2024-01-01"));
    }

    #[test]
    fn repeat_modes_choose_their_own_base_and_occurrence() {
        for (unit, every, anchor, completed, fixed, catch_up, after) in [
            (
                RepeatUnit::Day,
                3,
                "2024-01-01",
                "2024-01-11",
                "2024-01-04",
                "2024-01-13",
                "2024-01-14",
            ),
            (
                RepeatUnit::Week,
                2,
                "2024-01-01",
                "2024-01-30",
                "2024-01-15",
                "2024-02-12",
                "2024-02-13",
            ),
            (
                RepeatUnit::Month,
                1,
                "2024-01-31",
                "2024-03-01",
                "2024-02-29",
                "2024-03-31",
                "2024-04-01",
            ),
            (
                RepeatUnit::Year,
                1,
                "2020-02-29",
                "2023-03-01",
                "2021-02-28",
                "2024-02-29",
                "2024-03-01",
            ),
        ] {
            for (mode, expected) in [
                (RepeatMode::Fixed, fixed),
                (RepeatMode::CatchUp, catch_up),
                (RepeatMode::AfterCompletion, after),
            ] {
                assert_eq!(
                    advance_repeat(anchor, completed, &repeater(every, unit, mode)).unwrap(),
                    expected
                );
            }
        }
    }

    #[test]
    fn month_and_year_advancement_clamp_only_to_the_target_month() {
        for (anchor, every, unit, expected) in [
            ("2023-01-31", 1, RepeatUnit::Month, "2023-02-28"),
            ("2024-01-31", 1, RepeatUnit::Month, "2024-02-29"),
            ("2024-01-31", 2, RepeatUnit::Month, "2024-03-31"),
            ("2024-03-31", 1, RepeatUnit::Month, "2024-04-30"),
            ("2024-12-31", 2, RepeatUnit::Month, "2025-02-28"),
            ("2000-02-29", 100, RepeatUnit::Year, "2100-02-28"),
            ("2000-02-29", 400, RepeatUnit::Year, "2400-02-29"),
            ("0001-01-31", 119_987, RepeatUnit::Month, "9999-12-31"),
            ("0001-01-01", 9_998, RepeatUnit::Year, "9999-01-01"),
        ] {
            assert_eq!(
                advance_repeat(anchor, anchor, &repeater(every, unit, RepeatMode::Fixed)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn catch_up_is_strict_and_keeps_the_original_anchor() {
        for (anchor, completed, every, unit, expected) in [
            (
                "2024-01-10",
                "2024-01-01",
                1,
                RepeatUnit::Week,
                "2024-01-17",
            ),
            (
                "2024-01-01",
                "2024-01-08",
                1,
                RepeatUnit::Week,
                "2024-01-15",
            ),
            (
                "2024-01-31",
                "2024-02-28",
                1,
                RepeatUnit::Month,
                "2024-02-29",
            ),
            (
                "2024-01-31",
                "2024-02-29",
                1,
                RepeatUnit::Month,
                "2024-03-31",
            ),
            (
                "2024-01-31",
                "2024-05-30",
                2,
                RepeatUnit::Month,
                "2024-05-31",
            ),
            (
                "2024-01-31",
                "2024-05-31",
                2,
                RepeatUnit::Month,
                "2024-07-31",
            ),
            (
                "2020-02-29",
                "2024-02-28",
                1,
                RepeatUnit::Year,
                "2024-02-29",
            ),
        ] {
            assert_eq!(
                advance_repeat(
                    anchor,
                    completed,
                    &repeater(every, unit, RepeatMode::CatchUp)
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn catch_up_can_skip_the_entire_supported_range() {
        for (anchor, completed, every, unit, expected) in [
            ("0001-01-01", "9999-12-30", 1, RepeatUnit::Day, "9999-12-31"),
            (
                "0001-01-01",
                "9999-12-20",
                1,
                RepeatUnit::Week,
                "9999-12-27",
            ),
            (
                "0001-01-31",
                "9999-10-01",
                1,
                RepeatUnit::Month,
                "9999-10-31",
            ),
            (
                "0001-03-31",
                "9998-04-01",
                1,
                RepeatUnit::Year,
                "9999-03-31",
            ),
        ] {
            assert_eq!(
                advance_repeat(
                    anchor,
                    completed,
                    &repeater(every, unit, RepeatMode::CatchUp)
                )
                .unwrap(),
                expected
            );
        }
    }

    #[test]
    fn invalid_counts_and_unrepresentable_occurrences_are_errors() {
        for mode in [
            RepeatMode::Fixed,
            RepeatMode::CatchUp,
            RepeatMode::AfterCompletion,
        ] {
            for unit in [
                RepeatUnit::Day,
                RepeatUnit::Week,
                RepeatUnit::Month,
                RepeatUnit::Year,
            ] {
                for every in [0, u32::MAX] {
                    assert_validation(advance_repeat(
                        "2024-01-01",
                        "2024-01-01",
                        &repeater(every, unit, mode),
                    ));
                }
                assert_validation(advance_repeat(
                    "9999-12-31",
                    "9999-12-31",
                    &repeater(1, unit, mode),
                ));
                assert_validation(advance_repeat(
                    "2024-02-30",
                    "2024-01-01",
                    &repeater(1, unit, mode),
                ));
                assert_validation(advance_repeat(
                    "2024-01-01",
                    "2024-02-30",
                    &repeater(1, unit, mode),
                ));
            }
        }
        assert_validation(advance_repeat(
            "0001-01-01",
            "9999-12-31",
            &repeater(1, RepeatUnit::Day, RepeatMode::CatchUp),
        ));
        assert_validation(advance_repeat(
            "0004-02-29",
            "9999-01-01",
            &repeater(4, RepeatUnit::Year, RepeatMode::CatchUp),
        ));
    }

    #[test]
    fn every_mode_preserves_the_planning_windows_day_separation() {
        for (mode, scheduled, deadline) in [
            (RepeatMode::Fixed, "2024-02-29", "2024-03-02"),
            (RepeatMode::CatchUp, "2024-03-31", "2024-04-02"),
            (RepeatMode::AfterCompletion, "2024-04-01", "2024-04-03"),
        ] {
            assert_eq!(
                advance_window(
                    Some("2024-01-31"),
                    Some("2024-02-02"),
                    "2024-03-01",
                    &repeater(1, RepeatUnit::Month, mode)
                )
                .unwrap(),
                (Some(scheduled.to_owned()), Some(deadline.to_owned())),
            );
        }
    }

    #[test]
    fn one_sided_same_day_and_overdue_windows_keep_their_shape() {
        let repeat = repeater(1, RepeatUnit::Month, RepeatMode::Fixed);
        for (scheduled, deadline, expected) in [
            (
                Some("2024-01-31"),
                None,
                (Some("2024-02-29".to_owned()), None),
            ),
            (
                None,
                Some("2024-01-31"),
                (None, Some("2024-02-29".to_owned())),
            ),
            (
                Some("2024-01-31"),
                Some("2024-01-31"),
                (Some("2024-02-29".to_owned()), Some("2024-02-29".to_owned())),
            ),
            (
                Some("2024-02-02"),
                Some("2024-01-31"),
                (Some("2024-03-02".to_owned()), Some("2024-02-29".to_owned())),
            ),
        ] {
            assert_eq!(
                advance_window(scheduled, deadline, "2024-03-01", &repeat).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn windows_reject_missing_invalid_and_overflowing_dates() {
        let repeat = repeater(1, RepeatUnit::Month, RepeatMode::Fixed);
        for (scheduled, deadline) in [
            (None, None),
            (Some("2024-02-30"), None),
            (None, Some("2024-02-30")),
            (Some("2024-01-01"), Some("10000-01-01")),
            (Some("9999-11-30"), Some("9999-12-31")),
        ] {
            assert_validation(advance_window(scheduled, deadline, "2024-03-01", &repeat));
        }
        assert_validation(advance_window(
            Some("2024-01-01"),
            None,
            "2024-02-30",
            &repeat,
        ));
        assert_validation(advance_window(
            None,
            Some("2024-01-01"),
            "2024-03-01",
            &repeater(0, RepeatUnit::Day, RepeatMode::CatchUp),
        ));
    }
}
