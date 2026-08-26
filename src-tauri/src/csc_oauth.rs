//! The browser half of a signing service's OAuth sign-in (RFC 8252).
//!
//! `engine/csc.py` deliberately stops at the token endpoint: it accepts an
//! authorization code and never fetches a redirect target, which is what keeps
//! the engine's outbound destinations derivable from one configured base. The
//! part that cannot live there is the part that needs a browser and a person —
//! a loopback listener the provider's authorization server redirects back to.
//!
//! RFC 8252 §7.3 is why the listener is a loopback socket on an EPHEMERAL port
//! rather than a custom URI scheme or an embedded webview: a native
//! application cannot keep a client secret, the system browser is where the
//! user's existing session and their password manager already are, and a
//! loopback redirect is the one redirect target a local application can prove
//! it owns. `http` is correct here and only here — §8.3 exempts the loopback
//! interface, and the connection never leaves the machine.
//!
//! What this module does NOT do
//! ----------------------------
//! It makes no outbound request. It binds a socket, hands the system browser a
//! URL, reads ONE request off that socket, and returns the code. Exchanging
//! the code for a token happens in the engine, over the connection whose
//! origin is pinned to the configured provider — so a hostile response landing
//! on this socket can supply a code that the token endpoint then rejects, and
//! cannot redirect anything anywhere.
//!
//! PKCE (RFC 7636) is computed in the renderer, where WebCrypto is: the
//! challenge and the state arrive here already made, this module never sees
//! the verifier, and the verifier travels straight from the renderer to the
//! engine. Splitting it that way means the code and the verifier never sit in
//! the same process until the token request itself.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// How long the sign-in may take. A person has to read a consent screen and
/// possibly reach for a second factor, so this is generous; it is not
/// unbounded, because an abandoned sign-in would otherwise hold the socket for
/// the life of the application.
const WAIT: Duration = Duration::from_secs(300);

/// The redirect carries a code, a state and nothing else worth reading. A
/// request line beyond this is refused unread rather than parsed.
const MAX_REQUEST_LINE: u64 = 8 * 1024;

#[derive(serde::Serialize)]
pub struct CscAuthorization {
    /// The single-use authorization code the provider returned.
    pub code: String,
    /// Echoed back to the token endpoint exactly as the authorization request
    /// carried it (RFC 6749 §4.1.3). It is not an address anything fetches.
    pub redirect_uri: String,
}

/// Percent-encode for a query VALUE: everything outside the unreserved set of
/// RFC 3986 §2.3 is escaped, so a client id or scope carrying a `&` cannot
/// forge an extra parameter.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The query string of a request target, as name/value pairs.
pub fn query_pairs(target: &str) -> Vec<(String, String)> {
    let query = match target.split_once('?') {
        Some((_, rest)) => rest,
        None => return Vec::new(),
    };
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| match part.split_once('=') {
            Some((name, value)) => (decode(name), decode(value)),
            None => (decode(part), String::new()),
        })
        .collect()
}

/// The provider's authorization endpoint, derived from the configured base.
///
/// The base must be HTTPS: this URL carries the user to a sign-in, and a
/// cleartext one is a sign-in anybody on the path can watch and rewrite. No
/// part of it comes from a provider response — the engine pins the token
/// endpoint the same way for the same reason.
pub fn authorize_url(
    base_url: &str,
    client_id: &str,
    scope: &str,
    challenge: &str,
    state: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let base = base_url.trim_end_matches('/');
    if !base.to_ascii_lowercase().starts_with("https://") {
        return Err(
            "The signing service address must use HTTPS. Refusing to open a sign-in over \
             a cleartext connection."
                .to_string(),
        );
    }
    if client_id.is_empty() {
        return Err("The signing service needs the OAuth client ID you registered with that \
                    provider."
            .to_string());
    }
    Ok(format!(
        "{}/oauth2/authorize?response_type=code&client_id={}&scope={}&code_challenge={}\
         &code_challenge_method=S256&redirect_uri={}&state={}",
        base,
        encode(client_id),
        encode(scope),
        encode(challenge),
        encode(redirect_uri),
        encode(state),
    ))
}

/// The body of the one response this listener ever writes.
const DONE_BODY: &[u8] = b"<!doctype html><meta charset=utf-8><title>Signed in</title>\
<p>Signing service sign-in complete. You can close this tab.";

/// The response, with `Content-Length` computed from the body. A hand-counted
/// length truncates the page in the browser and silently goes wrong again on
/// the next edit to the body.
fn done_page() -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
         Cache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        DONE_BODY.len()
    )
    .into_bytes();
    out.extend_from_slice(DONE_BODY);
    out
}

/// How often the accept loop wakes to re-check the deadline.
const ACCEPT_POLL: Duration = Duration::from_millis(100);

/// Read the redirect off one accepted connection.
///
/// Only the request LINE is read: the code is in it, and a body is neither
/// sent by a redirect nor wanted. A connection that is not the redirect (a
/// browser's speculative favicon fetch is the common one) is answered and the
/// listener keeps waiting, because giving up on the first stray request would
/// make the sign-in fail for a reason the user cannot see.
fn read_code(stream: &mut TcpStream, state: &str) -> Result<Option<String>, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    reader
        .by_ref()
        .take(MAX_REQUEST_LINE)
        .read_line(&mut line)
        .map_err(|e| format!("The sign-in response could not be read: {}", e))?;
    let target = line.split_whitespace().nth(1).unwrap_or("");
    let pairs = query_pairs(target);
    let get = |name: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
    };
    if let Some(error) = get("error") {
        let _ = stream.write_all(&done_page());
        let description = get("error_description").unwrap_or_default();
        return Err(format!(
            "The signing service refused the sign-in ({}){}",
            error,
            if description.is_empty() {
                ".".to_string()
            } else {
                format!(": {}", description)
            }
        ));
    }
    let code = match get("code") {
        Some(code) if !code.is_empty() => code,
        // Not the redirect. Answer it and keep waiting.
        _ => {
            let _ = stream.write_all(&done_page());
            return Ok(None);
        }
    };
    // The state is the CSRF binding (RFC 6749 §10.12): a code arriving without
    // the value this sign-in generated did not come from this sign-in, and
    // exchanging it would attach somebody else's authorization to this user.
    if get("state").as_deref() != Some(state) {
        let _ = stream.write_all(&done_page());
        return Err(
            "The sign-in response did not match the request this application made. \
             Nothing was authorized."
                .to_string(),
        );
    }
    let _ = stream.write_all(&done_page());
    Ok(Some(code))
}

/// Accept connections on a NON-BLOCKING listener until one carries the code or
/// the deadline passes.
///
/// The listener must be non-blocking: a blocking `accept()` cannot be
/// interrupted, so an abandoned sign-in would hold the thread and the socket
/// for the life of the application no matter what the deadline says.
fn wait_for_code(
    listener: &TcpListener,
    state: &str,
    deadline: Instant,
) -> Result<String, String> {
    loop {
        if Instant::now() >= deadline {
            return Err("The signing service sign-in was not completed in time.".to_string());
        }
        let (mut stream, _peer) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
                continue;
            }
            Err(e) => return Err(format!("The sign-in response never arrived: {}", e)),
        };
        // An accepted socket can inherit the listener's non-blocking mode;
        // `read_code` relies on a blocking read with a timeout.
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        if let Some(code) = read_code(&mut stream, state)? {
            return Ok(code);
        }
    }
}

/// Open the provider's sign-in in the system browser and wait for the code.
///
/// The listener binds BEFORE the browser opens, so the redirect can never
/// arrive at a port nothing is listening on.
#[tauri::command]
pub async fn csc_authorize(
    app: tauri::AppHandle,
    base_url: String,
    client_id: String,
    scope: String,
    challenge: String,
    state: String,
) -> Result<CscAuthorization, String> {
    if challenge.is_empty() || state.is_empty() {
        return Err("The sign-in was not prepared correctly. Try again.".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .map_err(|e| format!("A sign-in listener could not be opened: {}", e))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let redirect_uri = format!("http://127.0.0.1:{}/callback", port);
        let url = authorize_url(
            &base_url,
            &client_id,
            &scope,
            &challenge,
            &state,
            &redirect_uri,
        )?;
        // Non-blocking so the deadline below is actually enforceable: a
        // blocking `accept()` never returns when the sign-in is abandoned, and
        // the deadline would only ever be consulted between connections that
        // never come — holding the thread and the socket for the life of the
        // application, the exact outcome WAIT exists to prevent.
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        {
            use tauri_plugin_shell::ShellExt;
            // The shell plugin already ships; a second opener crate would
            // widen the graph for no capability gain. The URL is built above
            // from the CONFIGURED provider — never from a document, and never
            // from a provider response.
            #[allow(deprecated)]
            app.shell()
                .open(url, None)
                .map_err(|e| format!("The sign-in page could not be opened: {}", e))?;
        }
        let code = wait_for_code(&listener, &state, Instant::now() + WAIT)?;
        Ok(CscAuthorization { code, redirect_uri })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_carrying_a_separator_cannot_forge_a_parameter() {
        let url = authorize_url(
            "https://signing.example/csc/v2",
            "id&redirect_uri=https://elsewhere.example",
            "service",
            "chal",
            "st",
            "http://127.0.0.1:1/callback",
        )
        .unwrap();
        assert!(!url.contains("elsewhere.example/"));
        assert!(url.contains("id%26redirect_uri%3Dhttps%3A%2F%2Felsewhere.example"));
    }

    #[test]
    fn a_cleartext_provider_refuses_by_name() {
        let err = authorize_url(
            "http://signing.example/csc/v2",
            "id",
            "service",
            "chal",
            "st",
            "http://127.0.0.1:1/callback",
        )
        .unwrap_err();
        assert!(err.contains("HTTPS"));
    }

    #[test]
    fn a_provider_with_no_registration_refuses_by_name() {
        let err = authorize_url(
            "https://signing.example/csc/v2",
            "",
            "service",
            "chal",
            "st",
            "http://127.0.0.1:1/callback",
        )
        .unwrap_err();
        assert!(err.contains("OAuth client ID"));
    }

    #[test]
    fn the_authorization_request_declares_pkce_s256() {
        let url = authorize_url(
            "https://signing.example/csc/v2/",
            "id",
            "service credential",
            "the-challenge",
            "the-state",
            "http://127.0.0.1:9/callback",
        )
        .unwrap();
        assert!(url.starts_with("https://signing.example/csc/v2/oauth2/authorize?"));
        assert!(url.contains("code_challenge=the-challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("scope=service%20credential"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcallback"));
        assert!(url.contains("state=the-state"));
    }

    #[test]
    fn a_redirect_query_decodes_to_its_pairs() {
        let pairs = query_pairs("/callback?code=a%2Fb&state=x+y");
        assert_eq!(pairs[0], ("code".to_string(), "a/b".to_string()));
        assert_eq!(pairs[1], ("state".to_string(), "x y".to_string()));
    }

    #[test]
    fn a_request_with_no_query_yields_no_pairs() {
        assert!(query_pairs("/favicon.ico").is_empty());
    }

    #[test]
    fn the_done_page_declares_the_length_of_its_own_body() {
        let page = done_page();
        let split = page
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("headers end");
        let headers = String::from_utf8(page[..split].to_vec()).unwrap();
        let body_len = page.len() - (split + 4);
        let declared: usize = headers
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .expect("Content-Length header")
            .trim()
            .parse()
            .unwrap();
        assert_eq!(declared, body_len);
        assert_eq!(body_len, DONE_BODY.len());
    }

    #[test]
    fn an_abandoned_sign_in_gives_up_at_its_deadline() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        listener.set_nonblocking(true).unwrap();
        let started = Instant::now();
        // Nothing ever connects. A blocking accept() would hang here forever.
        let err = wait_for_code(
            &listener,
            "the-state",
            Instant::now() + Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(err.contains("not completed in time"), "{}", err);
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn a_redirect_carrying_the_matching_state_yields_its_code() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let mut client =
                TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).unwrap();
            client
                .write_all(b"GET /callback?code=the-code&state=the-state HTTP/1.1\r\n\r\n")
                .unwrap();
            let mut sink = Vec::new();
            let _ = client.read_to_end(&mut sink);
        });
        let code = wait_for_code(
            &listener,
            "the-state",
            Instant::now() + Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(code, "the-code");
    }

    #[test]
    fn a_redirect_carrying_a_foreign_state_authorizes_nothing() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        std::thread::spawn(move || {
            let mut client =
                TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).unwrap();
            client
                .write_all(b"GET /callback?code=the-code&state=forged HTTP/1.1\r\n\r\n")
                .unwrap();
            let mut sink = Vec::new();
            let _ = client.read_to_end(&mut sink);
        });
        let err = wait_for_code(
            &listener,
            "the-state",
            Instant::now() + Duration::from_secs(20),
        )
        .unwrap_err();
        assert!(err.contains("Nothing was authorized"), "{}", err);
    }
}
