use crate::YearSpan;

/// Read historical notation without changing its authored spelling or inventing precision.
pub(crate) fn span(text: &str) -> Option<YearSpan> {
    let mut text = text.trim();
    for prefix in ["c.", "ca.", "circa ", "fl."] {
        if let Some(rest) = strip_prefix(text, prefix) {
            text = rest.trim();
            break;
        }
    }
    let birth = strip_prefix(text, "b.");
    let death = strip_prefix(text, "d.");
    if let Some(rest) = birth.or(death) {
        let value = span(rest)?;
        return Some(if birth.is_some() {
            YearSpan {
                from: value.from,
                through: None,
            }
        } else {
            YearSpan {
                from: None,
                through: value.through,
            }
        });
    }
    let (text, era) = era(text);
    let separator = text
        .char_indices()
        .find(|(index, c)| matches!(c, '–' | '—') || (*c == '-' && *index > 0));
    let range = if let Some((index, separator)) = separator {
        let left = endpoint(&text[..index], era)?;
        let right = endpoint(&text[index + separator.len_utf8()..], era)?;
        YearSpan {
            from: left.from,
            through: right.through,
        }
    } else {
        endpoint(text, era)?
    };
    if range.from.is_none() && range.through.is_none()
        || matches!((range.from, range.through), (Some(from), Some(through)) if from > through)
    {
        return None;
    }
    Some(range)
}

fn strip_prefix<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    text.get(..prefix.len())?
        .eq_ignore_ascii_case(prefix)
        .then(|| &text[prefix.len()..])
}

fn era(text: &str) -> (&str, Option<bool>) {
    let text = text.trim();
    for (suffix, bce) in [("BCE", true), ("BC", true), ("CE", false), ("AD", false)] {
        if text.len() >= suffix.len() {
            let split = text.len() - suffix.len();
            if text
                .get(split..)
                .is_some_and(|end| end.eq_ignore_ascii_case(suffix))
            {
                return (text[..split].trim(), Some(bce));
            }
        }
    }
    (text, None)
}

fn endpoint(text: &str, inherited: Option<bool>) -> Option<YearSpan> {
    let (mut text, own_era) = era(text);
    let bce = own_era.or(inherited).unwrap_or(false);
    for prefix in ["c.", "ca.", "circa ", "fl."] {
        if let Some(rest) = strip_prefix(text, prefix) {
            text = rest.trim();
            break;
        }
    }
    if text == "?" {
        return Some(YearSpan {
            from: None,
            through: None,
        });
    }
    let century = text.len() >= 7
        && text
            .get(text.len() - 7..)
            .is_some_and(|s| s.eq_ignore_ascii_case("century"));
    let (from, through) = if century {
        let ordinal = text[..text.len() - 7].trim_end();
        if ordinal.len() == text.len() - 7 {
            return None;
        }
        let suffix = ordinal.trim_start_matches(|c: char| c.is_ascii_digit());
        if !["", "st", "nd", "rd", "th"]
            .iter()
            .any(|expected| suffix.eq_ignore_ascii_case(expected))
        {
            return None;
        }
        let n: i32 = ordinal[..ordinal.len() - suffix.len()].parse().ok()?;
        if !(1..=100_000).contains(&n) {
            return None;
        }
        ((n - 1) * 100 + 1, n * 100)
    } else if let Some(decade) = text.strip_suffix('s') {
        if !decade.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let n: i32 = decade.parse().ok()?;
        if !(1..=9_999_990).contains(&n) || n % 10 != 0 {
            return None;
        }
        (n, n + 9)
    } else {
        let n: i32 = text.parse().ok()?;
        if n == 0 || n.unsigned_abs() > 9_999_999 {
            return None;
        }
        (n, n)
    };
    if bce && from < 0 {
        return None;
    }
    Some(if bce {
        YearSpan {
            from: Some(-through),
            through: Some(-from),
        }
    } else {
        YearSpan {
            from: Some(from),
            through: Some(through),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn historical_boundaries_and_open_ends() {
        for (text, from, through) in [
            ("1332–1406", Some(1332), Some(1406)),
            ("c. 200–118 BCE", Some(-200), Some(-118)),
            ("200 BCE–118 BCE", Some(-200), Some(-118)),
            ("1 BCE–1 CE", Some(-1), Some(1)),
            ("c. 1493", Some(1493), Some(1493)),
            ("fl. 1340s", Some(1340), Some(1349)),
            ("1340s BCE", Some(-1349), Some(-1340)),
            ("4th century BCE", Some(-400), Some(-301)),
            ("4th century", Some(301), Some(400)),
            ("?–118 BCE", None, Some(-118)),
            ("200 BCE–?", Some(-200), None),
            ("b. 1332", Some(1332), None),
            ("d. 1406", None, Some(1406)),
        ] {
            assert_eq!(span(text), Some(YearSpan { from, through }), "{text}");
        }
        for text in [
            "unknown",
            "?",
            "?–?",
            "0",
            "200–118",
            "1341s",
            "0th century",
            "4blah century",
            "4thcentury",
            "2000-01-01",
        ] {
            assert_eq!(span(text), None, "{text}");
        }
    }
}
