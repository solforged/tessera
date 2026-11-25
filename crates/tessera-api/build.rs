fn main() {
    cfg_aliases::cfg_aliases! {
        browser: { all(target_arch = "wasm32", target_os = "unknown") },
        native: { not(browser) },
        // The browser worker cannot fetch other origins; native hosts verify TLS with webpki-roots.
        fetch_urls: { not(browser) },
    }
}
