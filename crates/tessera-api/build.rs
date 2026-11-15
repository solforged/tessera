fn main() {
    cfg_aliases::cfg_aliases! {
        browser: { all(target_arch = "wasm32", target_os = "unknown") },
        native: { not(browser) },
        // The browser worker cannot fetch other origins. Android's TLS verifier
        // needs JNI setup that the phone app does not do yet.
        fetch_urls: { all(native, not(target_os = "android")) },
    }
}
