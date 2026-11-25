use serde::{Deserialize, Deserializer};

pub(crate) const MAX_LIMIT: usize = 2_000;

#[derive(Deserialize)]
pub(crate) struct Limit {
    #[serde(default = "default_limit", deserialize_with = "clamp_limit")]
    pub(crate) limit: usize,
}

pub(crate) fn default_limit() -> usize {
    50
}

pub(crate) fn clamp_limit<'de, D>(deserializer: D) -> Result<usize, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(usize::deserialize(deserializer)?.min(MAX_LIMIT))
}

#[cfg(test)]
mod tests {
    use axum::{extract::Query, http::Uri};

    use super::{Limit, MAX_LIMIT};

    #[test]
    fn limit_defaults_to_fifty_and_clamps_to_maximum() {
        let Query(default) = Query::<Limit>::try_from_uri(&Uri::from_static("/")).unwrap();
        assert_eq!(default.limit, 50);
        let Query(bounded) =
            Query::<Limit>::try_from_uri(&Uri::from_static("/?limit=999999")).unwrap();
        assert_eq!(bounded.limit, MAX_LIMIT);
    }
}
