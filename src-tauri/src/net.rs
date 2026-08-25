//! The app's ONE outbound HTTP client.
//!
//! Every outbound request the product makes on a user's behalf comes through
//! here: the form-submission transmit and the open-from-web-address door share
//! this module rather than each growing a client. The renderer never fetches;
//! it hands a validated request across and receives a status, a content type
//! and a path to bytes on disk.
//!
//! The properties this module exists to hold, each of them structural:
//!
//!   * **No ambient authority.** No cookie store (the `cookies` feature is not
//!     enabled, so there is no jar to attach), no credential store, no
//!     proxy-authentication prompt, no `Authorization` header, no persisted
//!     session between requests. A request carries what its caller put in it
//!     and nothing the machine happens to remember.
//!   * **A plain user agent.** `SpectraPDF/<version>` — the product and the
//!     version, no platform inventory.
//!   * **Redirects are followed SAME-ORIGIN ONLY**, and origin includes the
//!     scheme: a redirect that changes scheme or host aborts and names both
//!     hosts, because the address the user consented to is the address that
//!     was shown. Following redirects is done here rather than by the
//!     transport so the refusal can say what it refused.
//!   * **A response is bytes on disk**, capped, never interpreted here. What
//!     reads them is whatever ordinary parser the caller routes them to.
//!
//! Nothing received here is executed, and nothing here opens a shell.

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// How large a response this client will keep.
///
/// 64 MiB. The two callers receive documents a person opens or form data a
/// person imports; the largest plausible answer is a scanned PDF, and 64 MiB
/// is well past what any submission endpoint returns while still bounding a
/// hostile or malfunctioning server to a size a temp volume absorbs. The cap
/// is enforced on the bytes that ARRIVE, not on a declared content length, so
/// a server that omits or overstates its length cannot get past it: the
/// transfer stops at the byte that would exceed the cap and the partial file
/// is removed.
pub const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// How many same-origin redirects are followed before the chain is called a
/// loop. Ten is the ecosystem's ordinary limit.
pub const MAX_REDIRECTS: u32 = 10;

const CONNECT_TIMEOUT_SECS: u64 = 15;
const TOTAL_TIMEOUT_SECS: u64 = 120;

/// One outbound request.
///
/// `body_path` is a FILE rather than bytes: the form submission has already
/// been built to disk by the engine, and P39's GET arm has no body at all.
/// Neither caller needs a payload to cross the renderer boundary twice.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRequest {
    pub url: String,
    /// `"get"` or `"post"`. Anything else is refused rather than mapped.
    pub method: String,
    pub body_path: Option<String>,
    pub content_type: Option<String>,
    /// Stem for the response file. Cosmetic; sanitized before use.
    pub file_name: Option<String>,
}

/// What came back. Never the bytes — the path to them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetResponse {
    pub status: u16,
    /// The `Content-Type` header, lowercased and with parameters kept, or an
    /// empty string when the server sent none.
    pub content_type: String,
    pub path: String,
    pub bytes: u64,
    /// The address the bytes actually came from, which is the requested
    /// address unless a same-origin redirect moved it.
    pub final_url: String,
}

/// The user agent every request carries.
pub fn user_agent() -> String {
    format!("SpectraPDF/{}", env!("CARGO_PKG_VERSION"))
}

/// Split an http(s) address into (normalized url, scheme, authority).
///
/// The authority keeps its port, because `example.com` and `example.com:8443`
/// are different origins. Userinfo is dropped from the comparison key so a
/// credential-bearing redirect cannot pose as the same host.
pub fn validate_http_url(raw: &str) -> Result<(String, String, String), String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("No web address was given".to_string());
    }
    if trimmed.contains(char::is_whitespace) {
        return Err(format!("{trimmed} is not a web address"));
    }
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| format!("{trimmed} does not name http or https"))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "Only http and https addresses can be used, not {scheme}"
        ));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if authority.is_empty() {
        return Err(format!("{trimmed} names no host"));
    }
    Ok((
        trimmed.to_string(),
        scheme,
        authority.to_ascii_lowercase(),
    ))
}

/// Resolve a `Location` header against the URL it arrived from.
///
/// Absolute, protocol-relative, root-relative and path-relative forms are all
/// resolved here rather than guessed at the comparison, because a relative
/// target that resolves to a different host is exactly the case the
/// same-origin rule exists for.
pub fn resolve_location(base: &str, location: &str) -> Result<String, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("The redirect named no address".to_string());
    }
    let (_, scheme, authority) = validate_http_url(base)?;
    if location.contains("://") {
        return Ok(location.to_string());
    }
    if let Some(rest) = location.strip_prefix("//") {
        return Ok(format!("{scheme}://{rest}"));
    }
    if location.starts_with('/') {
        return Ok(format!("{scheme}://{authority}{location}"));
    }
    // Path-relative: replace the last segment of the base path.
    let after_authority = &base[scheme.len() + 3..];
    let path = match after_authority.find(['/', '?', '#']) {
        Some(i) => &after_authority[i..],
        None => "/",
    };
    let path = path.split(['?', '#']).next().unwrap_or("/");
    let dir = match path.rfind('/') {
        Some(i) => &path[..=i],
        None => "/",
    };
    Ok(format!("{scheme}://{authority}{dir}{location}"))
}

/// Whether a redirect target may be followed: same scheme AND same authority
/// as the address the user consented to.
///
/// Deliberately strict about the scheme. An `http` destination redirected to
/// `https` is a different origin, and this refuses it by naming both rather
/// than silently upgrading — the address in the consent dialog is the address
/// that gets used, and a user who wants the secure one types it.
pub fn same_origin(target: &str, scheme: &str, authority: &str) -> bool {
    match validate_http_url(target) {
        Ok((_, s, a)) => s == scheme && a == authority,
        Err(_) => false,
    }
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// A redirect that changes the method to GET and drops the body, per the
/// status. 307 and 308 preserve both; 301, 302 and 303 are followed as GET,
/// which is what the ecosystem does and what a submission endpoint expects.
fn redirect_keeps_body(status: u16) -> bool {
    matches!(status, 307 | 308)
}

/// The file extension a response is stored under, from its content type. The
/// extension is a convenience for the user and for the ordinary open funnel;
/// nothing routes off it — routing reads the content type itself.
pub fn extension_for(content_type: &str) -> &'static str {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "application/pdf" => "pdf",
        "application/vnd.fdf" => "fdf",
        "application/vnd.adobe.xfdf" | "application/xfdf+xml" => "xfdf",
        "text/html" | "application/xhtml+xml" => "html",
        "text/xml" | "application/xml" => "xml",
        "application/json" => "json",
        "text/plain" => "txt",
        _ => "bin",
    }
}

/// A caller-supplied name reduced to a safe stem. A response file is named
/// inside the app's own temp tree, so nothing a server says may steer it.
pub fn safe_stem(hint: Option<&str>) -> String {
    let raw = hint.unwrap_or("").trim();
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    if cleaned.is_empty() {
        "response".to_string()
    } else {
        cleaned
    }
}

/// Where a response lands: the app's own temp tree, never beside a user file.
fn response_path(stem: &str, extension: &str) -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join("spectrapdf").join("net");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create the download scratch folder: {e}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let unique = uuid::Uuid::new_v4().simple().to_string();
    Ok(dir.join(format!("{stem}-{stamp}-{}.{extension}", &unique[..8])))
}

/// Perform one request, following same-origin redirects, and write the
/// response body to a capped file in the app temp tree.
pub async fn fetch(request: &NetRequest) -> Result<NetResponse, String> {
    let (start, scheme, authority) = validate_http_url(&request.url)?;
    let method = request.method.to_ascii_lowercase();
    if method != "get" && method != "post" {
        return Err(format!("{} is not a request this app makes", request.method));
    }
    let body = match request.body_path.as_deref() {
        Some(path) if method == "post" => Some(
            std::fs::read(path).map_err(|e| format!("Cannot read the payload to send: {e}"))?,
        ),
        _ => None,
    };

    let client = reqwest::Client::builder()
        .user_agent(user_agent())
        // Redirects are resolved in the loop below so a cross-origin one can
        // be REFUSED BY NAME rather than reported as a transport error.
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(TOTAL_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Cannot start the network client: {e}"))?;

    let mut current = start;
    let mut send_body = body;
    let mut post = method == "post";
    let mut hops = 0u32;

    loop {
        let mut builder = if post {
            client.post(&current)
        } else {
            client.get(&current)
        };
        if post {
            if let Some(ref ct) = request.content_type {
                builder = builder.header(reqwest::header::CONTENT_TYPE, ct.clone());
            }
            builder = builder.body(send_body.clone().unwrap_or_default());
        }
        let response = builder
            .send()
            .await
            .map_err(|e| format!("The request to {current} did not complete: {e}"))?;
        let status = response.status().as_u16();

        if is_redirect(status) {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let target = resolve_location(&current, &location)?;
            if !same_origin(&target, &scheme, &authority) {
                let (_, _, other) = validate_http_url(&target)
                    .unwrap_or_else(|_| (target.clone(), String::new(), target.clone()));
                return Err(format!(
                    "{authority} redirected to {other}. Nothing was sent to {other}: this app follows a redirect only when it stays on the address you approved."
                ));
            }
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err(format!("{authority} redirected too many times"));
            }
            if !redirect_keeps_body(status) {
                post = false;
                send_body = None;
            }
            current = target;
            continue;
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let path = response_path(
            &safe_stem(request.file_name.as_deref()),
            extension_for(&content_type),
        )?;
        let mut file = std::fs::File::create(&path)
            .map_err(|e| format!("Cannot write the response to disk: {e}"))?;
        let mut written: u64 = 0;
        let mut source = response;
        loop {
            let chunk = match source.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(e) => {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(format!("The response from {current} was cut short: {e}"));
                }
            };
            written += chunk.len() as u64;
            if written > MAX_RESPONSE_BYTES {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(format!(
                    "The response from {authority} is larger than the {} MB this app accepts, so it was discarded",
                    MAX_RESPONSE_BYTES / (1024 * 1024)
                ));
            }
            if let Err(e) = file.write_all(&chunk) {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(format!("Cannot write the response to disk: {e}"));
            }
        }
        file.flush()
            .map_err(|e| format!("Cannot write the response to disk: {e}"))?;

        return Ok(NetResponse {
            status,
            content_type,
            path: path.to_string_lossy().to_string(),
            bytes: written,
            final_url: current,
        });
    }
}

/// The renderer's single door to the network.
///
/// One command, both callers: the form-submission transmit posts a built
/// payload, and open-from-web-address gets a document. There is no second
/// entry point for a document-supplied string to find.
#[tauri::command]
pub async fn net_request(request: NetRequest) -> Result<NetResponse, String> {
    fetch(&request).await
}

/// A path in the app's own temp tree for a payload about to be sent.
///
/// The submission is built to disk before the consent dialog opens, because
/// the dialog shows THAT FILE'S BYTES: a preview built from anything else
/// would be a second answer to what is being transmitted. Both arguments are
/// sanitized here, so nothing a document carries can steer the location.
#[tauri::command]
pub fn net_payload_path(stem: Option<String>, extension: Option<String>) -> Result<String, String> {
    let ext: String = extension
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let ext = if ext.is_empty() { "bin".to_string() } else { ext };
    Ok(response_path(&safe_stem(stem.as_deref()), &ext)?
        .to_string_lossy()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    /// A one-request-at-a-time HTTP/1.1 server, in-process, on a loopback port
    /// the OS picks. Every network test here talks to this and nothing else —
    /// no test in this repo reaches a real host.
    struct TestServer {
        port: u16,
        log: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl TestServer {
        /// `replies` is consumed one per request; the last one repeats.
        fn start(replies: Vec<String>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let log = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = log.clone();
            std::thread::spawn(move || {
                let mut index = 0usize;
                for stream in listener.incoming() {
                    let mut stream = match stream {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    let mut buffer = [0u8; 8192];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let head = String::from_utf8_lossy(&buffer[..read]).to_string();
                    sink.lock().unwrap().push(head);
                    let reply = replies[index.min(replies.len() - 1)].clone();
                    index += 1;
                    let _ = stream.write_all(reply.as_bytes());
                    let _ = stream.flush();
                }
            });
            Self { port, log }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn requests(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
    }

    fn body_reply(content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[test]
    fn user_agent_names_only_the_product_and_version() {
        let ua = user_agent();
        assert!(ua.starts_with("SpectraPDF/"));
        assert!(!ua.contains("Mozilla"));
        assert!(!ua.contains("Windows"));
    }

    #[test]
    fn only_http_and_https_are_addresses() {
        assert!(validate_http_url("https://example.com/x").is_ok());
        assert!(validate_http_url("http://example.com").is_ok());
        for bad in [
            "file:///C:/secret.pdf",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "data:text/html,x",
            "example.com/x",
            "",
        ] {
            assert!(validate_http_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn the_authority_carries_the_port_and_drops_userinfo() {
        let (_, scheme, authority) = validate_http_url("https://u:p@Example.com:8443/a").unwrap();
        assert_eq!(scheme, "https");
        assert_eq!(authority, "example.com:8443");
    }

    #[test]
    fn a_location_resolves_in_every_form() {
        let base = "https://example.com/forms/submit?x=1";
        assert_eq!(
            resolve_location(base, "https://elsewhere.test/a").unwrap(),
            "https://elsewhere.test/a"
        );
        assert_eq!(
            resolve_location(base, "//elsewhere.test/a").unwrap(),
            "https://elsewhere.test/a"
        );
        assert_eq!(
            resolve_location(base, "/thanks").unwrap(),
            "https://example.com/thanks"
        );
        assert_eq!(
            resolve_location(base, "thanks").unwrap(),
            "https://example.com/forms/thanks"
        );
        assert!(resolve_location(base, "").is_err());
    }

    #[test]
    fn origin_includes_the_scheme_and_the_port() {
        assert!(same_origin("https://example.com/a", "https", "example.com"));
        assert!(!same_origin("http://example.com/a", "https", "example.com"));
        assert!(!same_origin(
            "https://example.com:8443/a",
            "https",
            "example.com"
        ));
        assert!(!same_origin("https://evil.test/a", "https", "example.com"));
        // A relative target never reaches here as same-origin: it is resolved
        // first, and an unresolvable string is not an origin match.
        assert!(!same_origin("/a", "https", "example.com"));
    }

    #[test]
    fn a_response_name_cannot_be_steered() {
        assert_eq!(safe_stem(Some("../../evil")), "evil");
        assert_eq!(safe_stem(Some("")), "response");
        assert_eq!(safe_stem(None), "response");
        assert_eq!(safe_stem(Some("form_1-data")), "form_1-data");
    }

    #[tokio::test]
    async fn a_post_sends_the_payload_and_keeps_the_response() {
        let server = TestServer::start(vec![body_reply("application/vnd.fdf", "%FDF-1.2 ok")]);
        let dir = std::env::temp_dir().join("spectrapdf-net-test");
        std::fs::create_dir_all(&dir).unwrap();
        let payload = dir.join("payload.fdf");
        std::fs::write(&payload, b"%FDF-1.2 sent").unwrap();

        let response = fetch(&NetRequest {
            url: server.url("/submit"),
            method: "post".to_string(),
            body_path: Some(payload.to_string_lossy().to_string()),
            content_type: Some("application/vnd.fdf".to_string()),
            file_name: Some("probe".to_string()),
        })
        .await
        .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "application/vnd.fdf");
        assert_eq!(
            std::fs::read_to_string(&response.path).unwrap(),
            "%FDF-1.2 ok"
        );
        assert!(response.path.ends_with(".fdf"));

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /submit "));
        assert!(requests[0].contains("%FDF-1.2 sent"));
        assert!(requests[0].contains("SpectraPDF/"));
        // No ambient authority rides along.
        let lowered = requests[0].to_ascii_lowercase();
        assert!(!lowered.contains("cookie:"));
        assert!(!lowered.contains("authorization:"));
    }

    #[tokio::test]
    async fn a_same_origin_redirect_is_followed() {
        let server = TestServer::start(vec![
            "HTTP/1.1 303 See Other\r\nLocation: /thanks\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
            body_reply("text/html", "<p>thanks</p>"),
        ]);
        let response = fetch(&NetRequest {
            url: server.url("/submit"),
            method: "get".to_string(),
            body_path: None,
            content_type: None,
            file_name: Some("probe".to_string()),
        })
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        assert!(response.final_url.ends_with("/thanks"));
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn a_cross_origin_redirect_aborts_and_names_both_hosts() {
        let server = TestServer::start(vec![
            "HTTP/1.1 302 Found\r\nLocation: http://other.invalid:1/a\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        ]);
        let error = fetch(&NetRequest {
            url: server.url("/submit"),
            method: "post".to_string(),
            body_path: None,
            content_type: None,
            file_name: Some("probe".to_string()),
        })
        .await
        .unwrap_err();
        assert!(error.contains("127.0.0.1"), "{error}");
        assert!(error.contains("other.invalid:1"), "{error}");
        // One request only: nothing was sent to the second host.
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn a_response_past_the_cap_is_discarded() {
        // An honest, genuinely oversize body: the guard counts the bytes that
        // ARRIVE, so the transfer stops partway rather than being refused on
        // the strength of a header. (A body shorter than its declared length
        // is truncated by the transport before this code sees it, which is the
        // other half of why the count is the guard.)
        let oversize = MAX_RESPONSE_BYTES as usize + 4096;
        let mut reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: {oversize}\r\nConnection: close\r\n\r\n"
        );
        reply.push_str(&"A".repeat(oversize));
        let server = TestServer::start(vec![reply]);
        let error = fetch(&NetRequest {
            url: server.url("/big"),
            method: "get".to_string(),
            body_path: None,
            content_type: None,
            file_name: Some("probe".to_string()),
        })
        .await
        .unwrap_err();
        assert!(error.contains("larger than"), "{error}");
    }

    #[tokio::test]
    async fn a_method_this_app_does_not_make_is_refused() {
        let error = fetch(&NetRequest {
            url: "https://example.com/a".to_string(),
            method: "delete".to_string(),
            body_path: None,
            content_type: None,
            file_name: None,
        })
        .await
        .unwrap_err();
        assert!(error.contains("delete"), "{error}");
    }

    #[tokio::test]
    async fn a_non_http_scheme_never_reaches_the_transport() {
        for bad in ["file:///C:/Windows/win.ini", "javascript:alert(1)"] {
            let error = fetch(&NetRequest {
                url: bad.to_string(),
                method: "get".to_string(),
                body_path: None,
                content_type: None,
                file_name: None,
            })
            .await
            .unwrap_err();
            assert!(!error.is_empty());
        }
    }

    #[test]
    fn an_extension_follows_the_content_type() {
        assert_eq!(extension_for("application/pdf"), "pdf");
        assert_eq!(extension_for("application/vnd.fdf; charset=utf-8"), "fdf");
        assert_eq!(extension_for("application/vnd.adobe.xfdf"), "xfdf");
        assert_eq!(extension_for("text/html"), "html");
        assert_eq!(extension_for(""), "bin");
        assert_eq!(extension_for("application/octet-stream"), "bin");
    }
}
