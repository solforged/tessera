use percent_encoding::percent_decode_str;
use url::Url;

#[derive(Clone)]
pub(crate) enum Base {
    Book(String),
    Article { url: Url, canonical: Url },
}

pub(crate) enum Target {
    Internal(String),
    External(String),
}

impl Base {
    pub(crate) fn file(&self) -> &str {
        match self {
            Self::Book(path) => path,
            Self::Article { .. } => "",
        }
    }

    pub(crate) fn resolve(&self, href: &str) -> Option<Target> {
        match self {
            Self::Book(path) => {
                let base = Url::parse("https://epub.invalid/").ok()?.join(path).ok()?;
                let resolved = base.join(href).ok()?;
                if resolved.origin() != base.origin() {
                    return Some(Target::External(resolved.into()));
                }
                let mut target = decode(resolved.path().trim_start_matches('/'));
                if let Some(fragment) = resolved.fragment() {
                    target.push('#');
                    target.push_str(&decode(fragment));
                }
                Some(Target::Internal(target))
            }
            Self::Article { url, canonical } => {
                let resolved = url.join(href).ok()?;
                let mut page = resolved.clone();
                page.set_fragment(None);
                let is_current = [url, canonical].iter().any(|base| {
                    let mut base = (*base).clone();
                    base.set_fragment(None);
                    base == page
                });
                if is_current {
                    Some(Target::Internal(
                        resolved
                            .fragment()
                            .map_or_else(String::new, |id| format!("#{}", decode(id))),
                    ))
                } else {
                    Some(Target::External(resolved.into()))
                }
            }
        }
    }

    pub(crate) fn resource(&self, href: &str) -> Option<String> {
        match self {
            Self::Book(_) => match self.resolve(href)? {
                Target::Internal(path) => Some(path.split('#').next()?.to_owned()),
                Target::External(_) => None,
            },
            Self::Article { url, .. } => url.join(href).ok().map(Into::into),
        }
    }
}

fn decode(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().into_owned()
}

pub(crate) fn normalize(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for word in value.split_whitespace() {
        if !normalized.is_empty() {
            normalized.push(' ');
        }
        normalized.push_str(word);
    }
    normalized
}

/// Retain publication precision, rejecting malformed and impossible dates.
pub(crate) fn date(value: &str) -> Option<String> {
    let value = value.trim();
    let end = value.find(['T', 't', ' ']).unwrap_or(value.len());
    let date = &value[..end];
    let mut parts = date.split('-');
    let year = parts.next()?;
    let month = parts.next();
    let day = parts.next();
    if parts.next().is_some()
        || year.len() != 4
        || [Some(year), month, day]
            .into_iter()
            .flatten()
            .any(|part| !part.bytes().all(|byte| byte.is_ascii_digit()))
        || [month, day]
            .into_iter()
            .flatten()
            .any(|part| part.len() != 2)
    {
        return None;
    }
    let year = year.parse::<u32>().ok()?;
    if year == 0 {
        return None;
    }
    if let Some(month) = month {
        let month = month.parse::<usize>().ok()?;
        if !(1..=12).contains(&month) {
            return None;
        }
        if let Some(day) = day {
            let leap =
                year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
            let maximum = [
                31,
                if leap { 29 } else { 28 },
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ][month - 1];
            if !(1..=maximum).contains(&day.parse::<u32>().ok()?) {
                return None;
            }
        }
    }
    if end < value.len() {
        day?;
        let time = &value[end + 1..];
        let clock = time.get(..8)?;
        if clock.as_bytes().get(2) != Some(&b':') || clock.as_bytes().get(5) != Some(&b':') {
            return None;
        }
        for (range, max) in [(0..2, 23), (3..5, 59), (6..8, 60)] {
            let field = clock.get(range)?;
            if !field.bytes().all(|byte| byte.is_ascii_digit()) || field.parse::<u8>().ok()? > max {
                return None;
            }
        }
        let mut suffix = &time[8..];
        if let Some(fraction) = suffix.strip_prefix('.') {
            let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return None;
            }
            suffix = &fraction[digits..];
        }
        if !suffix.is_empty() && !matches!(suffix, "Z" | "z") {
            if !suffix.starts_with(['+', '-']) || suffix.len() != 6 || suffix.as_bytes()[3] != b':'
            {
                return None;
            }
            for (range, max) in [(1..3, 23), (4..6, 59)] {
                let field = suffix.get(range)?;
                if !field.bytes().all(|byte| byte.is_ascii_digit())
                    || field.parse::<u8>().ok()? > max
                {
                    return None;
                }
            }
        }
    }
    Some(date.to_owned())
}
