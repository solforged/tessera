use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::error::ApiError;

#[derive(Clone)]
pub(crate) struct RequestPolicy {
    hosts: [String; 2],
    origins: [String; 2],
    dev_origin: Option<String>,
}

impl RequestPolicy {
    pub(crate) fn new(port: u16, dev_origin: Option<String>) -> Result<Self, String> {
        if let Some(origin) = &dev_origin {
            validate_dev_origin(origin)?;
        }
        let authority = |host: &str| {
            if port == 80 {
                host.to_string()
            } else {
                format!("{host}:{port}")
            }
        };
        let hosts = [authority("127.0.0.1"), authority("localhost")];
        let origins = hosts.each_ref().map(|host| format!("http://{host}"));
        Ok(Self {
            hosts,
            origins,
            dev_origin,
        })
    }

    fn permits(&self, headers: &HeaderMap, uri: &Uri) -> bool {
        let Some(host) = single_header(headers, "host") else {
            return false;
        };
        let Some(index) = self.hosts.iter().position(|allowed| allowed == host) else {
            return false;
        };
        // Ignore proxy forwarding headers: the listener itself is the authority.
        if uri
            .authority()
            .is_some_and(|authority| authority.as_str() != host)
            || uri.scheme_str().is_some_and(|scheme| scheme != "http")
        {
            return false;
        }
        if headers.contains_key(header::ORIGIN) {
            let Some(origin) = single_header(headers, "origin") else {
                return false;
            };
            origin == self.origins[index] || self.dev_origin.as_deref() == Some(origin)
        } else {
            // CLI requests omit Origin; cross-site browser resource loads must not
            // gain that privilege just because their method omits the header.
            single_header(headers, "sec-fetch-site") != Some("cross-site")
        }
    }
}

fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(value)
}

pub fn validate_dev_origin(origin: &str) -> Result<String, String> {
    let invalid = || {
        "dev origin must be an exact loopback HTTP origin, e.g. http://127.0.0.1:5173".to_string()
    };
    let uri: Uri = origin.parse().map_err(|_| invalid())?;
    let authority = uri.authority().ok_or_else(invalid)?;
    if uri.scheme_str() != Some("http")
        || !matches!(authority.host(), "127.0.0.1" | "localhost")
        || authority.port_u16().is_none()
        || origin != format!("http://{authority}")
    {
        return Err(invalid());
    }
    Ok(origin.to_string())
}

pub(crate) async fn protect(
    State(policy): State<RequestPolicy>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = if policy.permits(request.headers(), request.uri()) {
        next.run(request).await
    } else {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "forbidden_origin",
            "Use the local server address and an allowed browser origin.",
        )
        .into_response()
    };
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        ),
    );
    response
}
