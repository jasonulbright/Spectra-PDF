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
//! - mailto sets only to, cc, bcc, subject and body, with no control
//!   character once decoded (outside the body's line breaks), no fragment and
//!   only RFC 3986 characters.
//! - At most [`MAX_WEB_LINK_LEN`] bytes.
//!
//! - The address is already the parsed URL's serialization, and is opened
//!   exactly as received. The renderer shows, copies and sends its own parser's
//!   serialization; where the two parsers spell one address differently, the
//!   address is refused rather than opened under a spelling the dialog did not
//!   show.

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

/// The address to open, which is always `raw` itself, or a plain refusal.
pub fn validate_web_link(raw: &str) -> Result<String, String> {
    let serialized = serialize_web_link(raw)?;
    if serialized != raw {
        return Err(
            "The address is not in the spelling that was shown, and was not opened.".to_string(),
        );
    }
    Ok(serialized)
}

/// The parsed URL's serialization of an address that passes every rule.
fn serialize_web_link(raw: &str) -> Result<String, String> {
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
        return validate_mail_link(&parsed);
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

/// The header fields a mail link may set (RFC 6068 hfields). Any other field
/// reaches the mail program as an instruction: `attach=` names a local file
/// that some mail programs attach to the draft unasked.
const MAIL_LINK_FIELDS: [&str; 5] = ["to", "cc", "bcc", "subject", "body"];

/// RFC 3986 characters only. The serialization of a mail link keeps a literal
/// `"` or `<`, and the system's mail handler receives the address inside its
/// own quoted command line.
fn is_uri_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c)
}

/// Percent-decoded bytes, or `None` for a `%` not followed by two hex digits.
fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

/// A decoded control byte in a header field starts a new header. The body may
/// break lines (RFC 6068 section 5 spells a line break `%0D%0A`) and indent.
fn has_control(bytes: &[u8], body: bool) -> bool {
    bytes
        .iter()
        .any(|&b| (b < 0x20 || b == 0x7f) && !(body && matches!(b, b'\r' | b'\n' | b'\t')))
}

fn validate_mail_link(parsed: &Url) -> Result<String, String> {
    let malformed = || "The mail address is not a valid mail link.".to_string();
    let serialized = parsed.as_str();
    if parsed.path().is_empty() {
        return Err("The mail address is empty.".to_string());
    }
    if parsed.fragment().is_some() || !serialized.chars().all(is_uri_char) {
        return Err(malformed());
    }
    let to = percent_decode(parsed.path()).ok_or_else(malformed)?;
    if has_control(&to, false) || std::str::from_utf8(&to).is_err() {
        return Err(malformed());
    }
    for field in parsed.query().unwrap_or("").split('&').filter(|f| !f.is_empty()) {
        let (name, value) = field.split_once('=').unwrap_or((field, ""));
        let name = percent_decode(name).ok_or_else(malformed)?;
        let value = percent_decode(value).ok_or_else(malformed)?;
        let name = String::from_utf8(name).map_err(|_| malformed())?.to_ascii_lowercase();
        if !MAIL_LINK_FIELDS.contains(&name.as_str()) {
            return Err(format!(
                "A mail link may set only recipients, subject and body; this one sets \"{name}\"."
            ));
        }
        if has_control(&value, name == "body") || std::str::from_utf8(&value).is_err() {
            return Err(malformed());
        }
    }
    Ok(serialized.to_string())
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
            validate_web_link("http://example.com/").unwrap(),
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
            serialize_web_link("HTTPS://Example.COM/X").unwrap(),
            "https://example.com/X"
        );
        assert_eq!(
            serialize_web_link("MailTo:a@example.com").unwrap(),
            "mailto:a@example.com"
        );
    }

    #[test]
    fn opens_only_the_spelling_it_was_given() {
        for raw in [
            "HTTPS://Example.COM/X",
            "http://example.com",
            "https://example.com:443/x",
            "https://example.com/a/../b",
            "MailTo:a@example.com",
        ] {
            let err = validate_web_link(raw).unwrap_err();
            assert!(err.contains("spelling"), "{raw}: {err}");
        }
    }

    /// The renderer's half of this fixture is `tests/link-follow.test.ts`: it
    /// asserts the spelling the dialog shows, copies and sends for each address.
    #[test]
    fn opens_the_spelling_the_renderer_shows() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/web-link-spellings.json"))
                .unwrap();
        for row in fixture["offered"].as_array().unwrap() {
            let raw = row[0].as_str().unwrap();
            let shown = row[1].as_str().unwrap();
            assert_eq!(validate_web_link(shown).as_deref(), Ok(shown), "{raw}");
            if let Ok(opened) = validate_web_link(raw) {
                assert_eq!(opened, raw);
            }
        }
        for raw in fixture["refused"].as_array().unwrap() {
            let raw = raw.as_str().unwrap();
            assert!(validate_web_link(raw).is_err(), "{raw}");
        }
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

    #[test]
    fn mail_link_sets_recipients_subject_and_body_only() {
        let ok = "mailto:a@example.com?subject=Hi%20there&cc=b@example.com&body=Line%0D%0ALine";
        assert_eq!(validate_web_link(ok).unwrap(), ok);
        assert!(validate_web_link("mailto:a@example.com?Subject=x").is_ok());
        for raw in [
            "mailto:a@example.com?attach=C:/Users/me/.ssh/id_rsa",
            "mailto:a@example.com?subject=x&Attachment=%2Fetc%2Fpasswd",
            "mailto:a@example.com?%61ttach=x",
            "mailto:a@example.com?in-reply-to=x",
        ] {
            let err = validate_web_link(raw).unwrap_err();
            assert!(err.contains("only recipients"), "{raw}: {err}");
        }
    }

    #[test]
    fn mail_link_carries_no_hidden_header_quote_or_fragment() {
        for raw in [
            "mailto:a@example.com?subject=x%0D%0ABcc:spy@evil.example",
            "mailto:a@example.com%0ABcc:spy@evil.example",
            "mailto:a@example.com?to=b@example.com%00",
            "mailto:a@example.com?body=%07",
            "mailto:a\"b@example.com",
            "mailto:a<b>@example.com",
            "mailto:a@example.com#x",
            "mailto:a@example.com?subject=%E0%A4",
            "mailto:a@example.com?subject=%G1",
            "mailto:?to=a@example.com",
        ] {
            assert!(validate_web_link(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn opens_the_ascii_spelling_of_a_look_alike_host() {
        assert!(validate_web_link("https://\u{0435}xample.com/login").is_err());
        assert_eq!(
            validate_web_link("https://xn--xample-2of.com/login").unwrap(),
            "https://xn--xample-2of.com/login"
        );
    }

    #[test]
    fn serializes_only_rfc3986_characters_for_http() {
        let serialized = serialize_web_link("https://example.com/a\"b<c>d`e{f}").unwrap();
        assert!(!serialized.contains(['"', '<', '>', '`', '{', '}']), "{serialized}");
    }

    #[test]
    fn mail_link_skips_empty_fields_and_refuses_an_empty_fragment() {
        for raw in [
            "mailto:a@example.com?subject=x&",
            "mailto:a@example.com?&subject=x",
            "mailto:a@example.com?subject=a&&body=c",
        ] {
            assert_eq!(validate_web_link(raw).as_deref(), Ok(raw));
        }
        assert!(validate_web_link("mailto:a@example.com#").is_err());
        assert!(validate_web_link("mailto:a@example.com?subject=x#").is_err());
    }
}
