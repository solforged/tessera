use std::{collections::HashSet, io::Write, path::PathBuf};

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::{error::ApiError, notebooks::Registry};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Protocol {
    Anthropic,
    Openai,
}

// Deliberately not Debug: provider credentials must never reach logs.
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Provider {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
}

impl Provider {
    pub fn redact(&self, text: &str) -> String {
        if self.api_key.is_empty() {
            text.to_owned()
        } else {
            text.replace(&self.api_key, "[redacted]")
        }
    }
}

#[derive(Serialize)]
pub(super) struct ProviderView {
    id: String,
    name: String,
    protocol: Protocol,
    base_url: String,
    model: String,
    has_key: bool,
}

impl From<&Provider> for ProviderView {
    fn from(provider: &Provider) -> Self {
        Self {
            id: provider.id.clone(),
            name: provider.name.clone(),
            protocol: provider.protocol,
            base_url: provider.base_url.clone(),
            model: provider.model.clone(),
            has_key: !provider.api_key.is_empty(),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct ProviderInput {
    id: Option<String>,
    name: String,
    protocol: Protocol,
    base_url: String,
    model: String,
    api_key: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct SaveProviders {
    providers: Vec<ProviderInput>,
    default: Option<String>,
}

#[derive(Default, Deserialize, Serialize)]
struct Stored {
    providers: Vec<Provider>,
    default: Option<String>,
}

#[derive(Serialize)]
pub(super) struct Providers {
    providers: Vec<ProviderView>,
    default: Option<String>,
}

impl Stored {
    fn view(&self) -> Providers {
        Providers {
            providers: self.providers.iter().map(ProviderView::from).collect(),
            default: self.default.clone(),
        }
    }
}

pub(super) struct Store {
    path: Option<PathBuf>,
}

pub(super) fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "invalid_agent", message)
}

fn storage_error() -> ApiError {
    // Do not include serde errors, which may quote secret JSON values.
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "agent_storage",
        "Cannot read or save agent settings.",
    )
}

impl Store {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path: path
                .or_else(|| Registry::platform().map(|r| r.path.with_file_name("agent.json"))),
        }
    }

    fn load(&self) -> Result<Stored, ApiError> {
        let path = self.path.as_ref().ok_or_else(storage_error)?;
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| storage_error()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Stored::default()),
            Err(_) => Err(storage_error()),
        }
    }

    pub fn list(&self) -> Result<Providers, ApiError> {
        Ok(self.load()?.view())
    }

    pub fn get(&self, id: &str) -> Result<Provider, ApiError> {
        self.load()?
            .providers
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(ApiError::not_found)
    }

    pub fn save(&self, input: SaveProviders) -> Result<Providers, ApiError> {
        let old = self.load()?;
        let mut providers = Vec::with_capacity(input.providers.len());
        let mut ids = HashSet::new();
        for input in input.providers {
            if input.name.trim().is_empty() || input.model.trim().is_empty() {
                return Err(invalid("Name and model are both required."));
            }
            let url = reqwest::Url::parse(input.base_url.trim())
                .map_err(|_| invalid("The address must start with http:// or https://."))?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err(invalid("The address must start with http:// or https://."));
            }
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(invalid(
                    "The address can't hold a password, a query or a fragment; put the key under Key.",
                ));
            }
            let id = input.id.unwrap_or_else(|| Ulid::generate().to_string());
            if id.is_empty() || !ids.insert(id.clone()) {
                return Err(invalid("Provider IDs must be nonempty and unique."));
            }
            let api_key = input.api_key.unwrap_or_else(|| {
                old.providers
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.api_key.clone())
                    .unwrap_or_default()
            });
            providers.push(Provider {
                id,
                name: input.name.trim().to_owned(),
                protocol: input.protocol,
                base_url: input.base_url.trim().trim_end_matches('/').to_owned(),
                model: input.model.trim().to_owned(),
                api_key,
            });
        }
        if input.default.as_ref().is_some_and(|id| !ids.contains(id)) {
            return Err(invalid(
                "The default provider must be in the provider list.",
            ));
        }
        let stored = Stored {
            providers,
            default: input.default,
        };
        let path = self.path.as_ref().ok_or_else(storage_error)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| storage_error())?;
        }
        let temporary = path.with_extension(format!("{}.tmp", Ulid::generate()));
        let result = (|| -> std::io::Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec_pretty(&stored)?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
            return Err(storage_error());
        }
        Ok(stored.view())
    }
}
