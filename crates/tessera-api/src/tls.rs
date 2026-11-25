//! Outbound HTTPS client builder using bundled WebPKI root certificates.
//!
//! `reqwest`'s default `rustls` setup relies on `rustls-platform-verifier`,
//! which requires JNI initialization on Android. Preconfiguring `rustls` with
//! `webpki-roots` gives the desktop service, CLI and mobile app identical TLS
//! verification without platform-specific setup.

use std::sync::Arc;

pub fn tls_client_builder() -> Result<reqwest::ClientBuilder, String> {
    let roots = rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| error.to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(reqwest::Client::builder().tls_backend_preconfigured(tls))
}
