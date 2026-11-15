use serde::Deserialize;

#[derive(Deserialize)]
pub(crate) struct Limit {
    #[serde(default = "default_limit")]
    pub(crate) limit: usize,
}

pub(crate) fn default_limit() -> usize {
    50
}
