//! The one check a web address passes before `open_web_link` hands it to the
//! system browser.
//!
//! The address comes from a PDF — a document's /URI link that the reader
//! clicked and then confirmed in a dialog showing the full address. The
//! renderer gates it first (`src/renderer/lib/link-follow.ts`), and this
//! module checks it AGAIN, independently: nothing about the webview is trusted
//! to have done so. Kept free of any Tauri import so the rules are unit-tested
//! on their own.
//!
//! The rules:
//! - http, https and mailto only, case-insensitively. Everything else —
//!   `javascript:`, `file:`, `data:`, `ms-settings:`, any custom protocol a
//!   program registered — is refused: the OS would hand it to whatever handles
//!   that scheme, which is how a link becomes a program launch.
//! - No control, whitespace, zero-width or bidirectional-override character
//!   anywhere: each makes the address the dialog SHOWED differ from the one
//!   that would be used.
//! - http(s) needs a real `scheme://host`, carries no user-info
//!   (`https://bank.example@evil.example` reads as one host and goes to the
//!   other), and no backslash (WHATWG reads it as `/`, other parsers do not).
//! - At most [`MAX_WEB_LINK_LEN`] bytes.
//!
//! What is opened is the parsed URL's canonical serialization, so the browser
//! receives one unambiguous spelling of what was checked.

use url::Url;

pub const MAX_WEB_LINK_LEN: usize = 2048;

const ALLOWED_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

fn is_deceptive(c: char) -> bool {
    c.is_control()
        || c.is_whitespace()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{061C}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
        )
}

/// The address to open, or a plain refusal.
pub fn validate_web_link(raw: &str) -> Result<String, String> {
    if raw.is_empty() {
        return Err("The link has no address.".to_string());
    }
    if raw.len() > MAX_WEB_LINK_LEN {
        return Err(format!(
            "The address is longer than {MAX_WEB_LINK_LEN} characters and was not opened."
        ));
    }
    if raw.chars().any(is_deceptive) {
        return Err(
            "The address contains characters that hide what it is, and was not opened.".to_string(),
        );
    }
    let colon = raw
        .find(':')
        .ok_or_else(|| "The address names no scheme, and was not opened.".to_string())?;
    let scheme = &raw[..colon];
    let well_formed = scheme.chars().enumerate().all(|(i, c)| {
        c.is_ascii_alphabetic() || (i > 0 && (c.is_ascii_digit() || "+.-".contains(c)))
    });
    if scheme.is_empty() || !well_formed {
        return Err("The address names no scheme, and was not opened.".to_string());
    }
    let scheme = scheme.to_ascii_lowercase();
    if !ALLOWED_SCHEMES.contains(&scheme.as_str()) {
        return Err(format!(
            "Only http, https and mailto addresses are opened; this one uses \"{scheme}\"."
        ));
    }
    let parsed = Url::parse(raw).map_err(|_| "The address is not a valid URL.".to_string())?;
    if parsed.scheme() != scheme {
        return Err("The address is not a valid URL.".to_string());
    }
    if scheme == "mailto" {
        if parsed.path().is_empty() {
            return Err("The mail address is empty.".to_string());
        }
        return Ok(parsed.as_str().to_string());
    }
    if !raw[colon..].starts_with("://") || raw.contains('\\') {
        return Err("The address is not a valid URL.".to_string());
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("The address names no host.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The address carries a user name or password, and was not opened.".to_string());
    }
    Ok(parsed.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_http_https_and_mailto() {
        assert_eq!(
            validate_web_link("https://example.com/a?b=1#c").unwrap(),
            "https://example.com/a?b=1#c"
        );
        assert_eq!(
            validate_web_link("http://example.com").unwrap(),
            "http://example.com/"
        );
        assert_eq!(
            validate_web_link("mailto:someone@example.com").unwrap(),
            "mailto:someone@example.com"
        );
    }

    #[test]
    fn scheme_is_case_insensitive() {
        assert_eq!(
            validate_web_link("HTTPS://Example.COM/X").unwrap(),
            "https://example.com/X"
        );
        assert_eq!(
            validate_web_link("MailTo:a@example.com").unwrap(),
            "mailto:a@example.com"
        );
    }

    #[test]
    fn refuses_every_other_scheme() {
        for raw in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "file://host/share/x.pdf",
            "data:text/html,<script>alert(1)</script>",
            "ms-settings:privacy",
            "vbscript:msgbox(1)",
            "ftp://example.com/x",
            "smb://host/share",
            "search-ms:query=x",
        ] {
            assert!(validate_web_link(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn refuses_no_scheme() {
        assert!(validate_web_link("www.example.com").is_err());
        assert!(validate_web_link("/relative").is_err());
        assert!(validate_web_link(":nothing").is_err());
        assert!(validate_web_link("").is_err());
    }

    #[test]
    fn refuses_userinfo() {
        assert!(validate_web_link("https://bank.example@evil.example/").is_err());
        assert!(validate_web_link("https://user:pass@example.com/").is_err());
        assert!(validate_web_link("http://:pass@example.com/").is_err());
    }

    #[test]
    fn refuses_control_whitespace_zero_width_and_bidi() {
        for raw in [
            "https://example.com/\n.evil.example",
            "https://example.com/\r",
            "https://example.com/\u{0000}",
            "https://example.com/\u{007F}",
            "https://exa mple.com/",
            "https://example.com/\t",
            " https://example.com/",
            "https://example.com/\u{200B}",
            "https://example.com/\u{FEFF}",
            "https://example.com/\u{202E}gpj.exe",
            "https://example.com/\u{2066}x\u{2069}",
            "https://example.com/\u{00A0}",
        ] {
            assert!(validate_web_link(raw).is_err(), "{raw:?}");
        }
    }

    #[test]
    fn refuses_overlong() {
        let ok = format!("https://example.com/{}", "a".repeat(MAX_WEB_LINK_LEN - 20));
        assert_eq!(ok.len(), MAX_WEB_LINK_LEN);
        assert!(validate_web_link(&ok).is_ok());
        let long = format!("{ok}a");
        assert!(validate_web_link(&long).is_err());
    }

    #[test]
    fn refuses_malformed_http() {
        assert!(validate_web_link("https:example.com").is_err());
        assert!(validate_web_link("https://").is_err());
        assert!(validate_web_link("https:\\\\evil.example").is_err());
        assert!(validate_web_link("https://example.com\\@evil.example").is_err());
        assert!(validate_web_link("mailto:").is_err());
    }
}
