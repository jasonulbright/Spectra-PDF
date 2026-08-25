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
//!   * **Destinations are classified before connecting.** Each hop's host is
//!     resolved and every resolved address is classified (loopback, RFC1918,
//!     link-local incl. cloud metadata, ULA, unspecified); the transport is
//!     pinned to the validated addresses. A DOCUMENT-chosen submit refuses a
//!     private target by name; a USER-typed open allows a private FIRST hop
//!     (the dialog warns) but a redirect that starts public and lands private
//!     is refused on either path — that hop was never shown.
//!   * **A response is bytes on disk**, capped, never interpreted here. What
//!     reads them is whatever ordinary parser the caller routes them to.
//!
//! Nothing received here is executed, and nothing here opens a shell.

use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
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
    /// Whether a private/loopback/link-local destination is REFUSED by name.
    ///
    /// A `/SubmitForm` names a destination the DOCUMENT chose, so a submit
    /// transmit sets this: a document must not steer a state-changing POST at a
    /// service on the user's own machine or LAN (a cloud metadata endpoint, an
    /// unauthenticated admin port). Open-from-web is a USER-TYPED address, where
    /// a private host is plausibly a deliberate LAN fetch, so it clears this and
    /// the dialog warns instead. Either way a redirect that STARTS public and
    /// lands private is refused — that hop is document-influenced and unseen.
    ///
    /// Defaults to refusing: a caller that forgets the field fails closed.
    #[serde(default = "refuse_private_default")]
    pub refuse_private: bool,
}

fn refuse_private_default() -> bool {
    true
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

/// How an IP address sits relative to the public internet.
///
/// The distinction that matters to this module is `Global` versus everything
/// else: a request the user did not knowingly point at their own machine or LAN
/// must not be steered there by a document. The variants below the line are all
/// non-global; they are kept apart only so a refusal can NAME what it refused.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AddrClass {
    /// Routable on the public internet.
    Global,
    /// 127.0.0.0/8, ::1 — the user's own machine.
    Loopback,
    /// RFC1918 (10/8, 172.16/12, 192.168/16) — the user's LAN.
    Private,
    /// 169.254.0.0/16, fe80::/10 — link-local, INCLUDING the cloud-metadata
    /// endpoint 169.254.169.254, the confused-deputy target this guard exists
    /// for.
    LinkLocal,
    /// fc00::/7 — IPv6 unique local, the LAN's v6 equivalent.
    UniqueLocal,
    /// 0.0.0.0/8, :: — "this host"/unspecified, which some stacks route to
    /// loopback.
    Unspecified,
    /// Other non-global space (CGNAT, multicast, benchmarking, reserved).
    OtherNonGlobal,
}

impl AddrClass {
    pub fn is_global(self) -> bool {
        matches!(self, AddrClass::Global)
    }

    /// A short English noun for the refusal message.
    pub fn label(self) -> &'static str {
        match self {
            AddrClass::Global => "public",
            AddrClass::Loopback => "loopback",
            AddrClass::Private => "private-network",
            AddrClass::LinkLocal => "link-local",
            AddrClass::UniqueLocal => "unique-local",
            AddrClass::Unspecified => "non-routable",
            AddrClass::OtherNonGlobal => "non-global",
        }
    }
}

fn classify_v4(a: Ipv4Addr) -> AddrClass {
    let o = a.octets();
    if a.is_loopback() {
        AddrClass::Loopback
    } else if a.is_unspecified() || o[0] == 0 {
        AddrClass::Unspecified
    } else if a.is_private() {
        AddrClass::Private
    } else if a.is_link_local() {
        AddrClass::LinkLocal
    } else if o[0] == 100 && (o[1] & 0xc0) == 64 {
        // 100.64.0.0/10 — carrier-grade NAT, not internet-routable.
        AddrClass::OtherNonGlobal
    } else if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        // 192.0.0.0/24 — IETF protocol assignments.
        AddrClass::OtherNonGlobal
    } else if a.is_broadcast() || o[0] >= 224 {
        // 255.255.255.255, and 224.0.0.0+ multicast/reserved.
        AddrClass::OtherNonGlobal
    } else {
        AddrClass::Global
    }
}

fn classify_v6(a: Ipv6Addr) -> AddrClass {
    if a.is_loopback() {
        AddrClass::Loopback
    } else if a.is_unspecified() {
        AddrClass::Unspecified
    } else if let Some(v4) = a.to_ipv4_mapped() {
        // ::ffff:a.b.c.d carries a v4 address and is classified as one.
        classify_v4(v4)
    } else {
        let seg = a.segments();
        if (seg[0] & 0xffc0) == 0xfe80 {
            AddrClass::LinkLocal // fe80::/10
        } else if (seg[0] & 0xfe00) == 0xfc00 {
            AddrClass::UniqueLocal // fc00::/7
        } else if (seg[0] & 0xff00) == 0xff00 {
            AddrClass::OtherNonGlobal // ff00::/8 multicast
        } else {
            AddrClass::Global
        }
    }
}

/// Classify a resolved IP. A literal-IP host is classified directly; a
/// hostname is classified only AFTER resolution, because a name resolving to a
/// private address is precisely the bypass this guards.
pub fn classify_ip(ip: IpAddr) -> AddrClass {
    match ip {
        IpAddr::V4(a) => classify_v4(a),
        IpAddr::V6(a) => classify_v6(a),
    }
}

/// Split a lowercased authority into (host, port), applying the scheme default
/// when no port is written. Handles the bracketed IPv6 literal form.
pub fn split_host_port(authority: &str, scheme: &str) -> (String, u16) {
    let default = if scheme == "https" { 443 } else { 80 };
    if let Some(rest) = authority.strip_prefix('[') {
        // [::1] or [::1]:8080
        if let Some(end) = rest.find(']') {
            let host = &rest[..end];
            let after = &rest[end + 1..];
            let port = after
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(default);
            return (host.to_string(), port);
        }
        return (authority.to_string(), default);
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse::<u16>().unwrap_or(default))
        }
        _ => (authority.to_string(), default),
    }
}

/// An authority reduced to its comparison key: the port is dropped when it is
/// the scheme's default, so `example.com` and `example.com:443` (https) are one
/// origin. Same-scheme is enforced separately, so normalizing against one
/// scheme is sound.
pub fn canonical_authority(authority: &str, scheme: &str) -> String {
    let (host, port) = split_host_port(authority, scheme);
    let default = if scheme == "https" { 443 } else { 80 };
    if port == default {
        host
    } else if authority.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Resolve a host:port to the addresses it names. Empty resolution is an error,
/// not an empty allow.
fn resolve_host(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("The address {host} could not be looked up: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("The address {host} resolved to nothing"));
    }
    Ok(addrs)
}

/// One hop's verdict against the private-address policy.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum HopDecision {
    Allow,
    Refuse,
}

/// Whether a hop landing on `class` may be followed.
///
/// `allow_private` is the test-only carve-out (see `env_allows_private`): when
/// set, every class is allowed so a suite talking to `127.0.0.1` works, and
/// production — where it is never set — blocks. Otherwise:
///   * a global address is always allowed;
///   * a submit (`refuse_private`) refuses any non-global address;
///   * an open (not `refuse_private`) allows a non-global FIRST hop (the user
///     typed it) but refuses a non-global REDIRECT that started from a global
///     address — that hop is document-influenced and was never shown.
fn hop_decision(
    class: AddrClass,
    is_first_hop: bool,
    refuse_private: bool,
    first_hop_global: bool,
    allow_private: bool,
) -> HopDecision {
    if class.is_global() || allow_private {
        return HopDecision::Allow;
    }
    if refuse_private {
        return HopDecision::Refuse;
    }
    if is_first_hop {
        return HopDecision::Allow;
    }
    if first_hop_global {
        HopDecision::Refuse
    } else {
        HopDecision::Allow
    }
}

/// The test-only escape that lets the suite reach loopback. Honored ONLY when
/// the environment sets it, so production (which never does) always blocks. The
/// e2e binary already exports `SPECTRAPDF_E2E`; that is honored here too so the
/// end-to-end network spec, which binds `127.0.0.1`, needs no second flag.
fn env_allows_private() -> bool {
    matches!(
        std::env::var("SPECTRA_NET_ALLOW_PRIVATE").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    ) || std::env::var("SPECTRAPDF_E2E").is_ok()
}

/// Append an already-encoded query string to a URL, before any fragment.
fn append_query(url: &str, query: &str) -> String {
    if query.is_empty() {
        return url.to_string();
    }
    let (base, frag) = match url.find('#') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    };
    let sep = if base.contains('?') { '&' } else { '?' };
    format!("{base}{sep}{query}{frag}")
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
/// Whether a string begins with a real URL scheme followed by `://`, i.e.
/// `^[a-z][a-z0-9+.-]*://` (case-insensitive). This is the absolute-URL test a
/// substring search for `://` gets wrong.
pub fn starts_with_scheme(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || !bytes[0].is_ascii_alphabetic() {
        return false;
    }
    let mut i = 1;
    while i < bytes.len() {
        let c = bytes[i];
        if c.is_ascii_alphanumeric() || c == b'+' || c == b'.' || c == b'-' {
            i += 1;
            continue;
        }
        break;
    }
    s[i..].starts_with("://")
}

pub fn resolve_location(base: &str, location: &str) -> Result<String, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("The redirect named no address".to_string());
    }
    let (_, scheme, authority) = validate_http_url(base)?;
    // Absolute means a real scheme at position 0 (`scheme://`), NOT the mere
    // presence of `://` anywhere: a same-origin `Location: /login?next=https://x`
    // carries `://` in its query and is root-relative, and treating it as
    // absolute would send the chain to `https://x` — the address inside the
    // return-URL parameter, which no one chose.
    if starts_with_scheme(location) {
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
        // Ports are normalized to their scheme default before comparison, so a
        // redirect from `example.com` to `example.com:443` (https) is the same
        // origin rather than a spurious cross-origin abort.
        Ok((_, s, a)) => {
            s == scheme && canonical_authority(&a, &s) == canonical_authority(authority, scheme)
        }
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
///
/// The private-address policy is read from the environment here (see
/// `env_allows_private`); `fetch_with_policy` takes it explicitly so tests can
/// pin either side without touching process env.
pub async fn fetch(request: &NetRequest) -> Result<NetResponse, String> {
    fetch_with_policy(request, env_allows_private()).await
}

async fn fetch_with_policy(request: &NetRequest, allow_private: bool) -> Result<NetResponse, String> {
    let (start, scheme, authority) = validate_http_url(&request.url)?;
    let method = request.method.to_ascii_lowercase();
    if method != "get" && method != "post" {
        return Err(format!("{} is not a request this app makes", request.method));
    }

    let mut post = method == "post";
    // The address actually requested. A GET that carries a built submission
    // encodes it into the query here, because GetMethod puts the field data on
    // the URL — a POST body attached to a GET would leave the server with none.
    let mut current = start;
    let body = match request.body_path.as_deref() {
        Some(path) => Some(
            std::fs::read(path).map_err(|e| format!("Cannot read the payload to send: {e}"))?,
        ),
        None => None,
    };
    if !post {
        if let Some(ref bytes) = body {
            if !bytes.is_empty() {
                let base = request
                    .content_type
                    .as_deref()
                    .unwrap_or("")
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                // Only URL-encoded (the HTML export) can ride a GET's query.
                // FDF/XFDF/PDF have no query encoding, so a GET of one would
                // otherwise send NOTHING while the app reported success — that
                // is refused by name instead.
                if base == "application/x-www-form-urlencoded" {
                    let query = String::from_utf8_lossy(bytes);
                    current = append_query(&current, query.trim());
                } else {
                    return Err(format!(
                        "This form is set to submit by GET, which can only carry URL-encoded (HTML) form data, not {}. Nothing was sent.",
                        if base.is_empty() { "that format" } else { &base }
                    ));
                }
            }
        }
    }
    let mut send_body = if post { body } else { None };
    let mut hops = 0u32;
    let mut first_hop_global = true;

    loop {
        // Resolve THIS hop's host and classify every address it names, then
        // connect only to an address that was checked: a hostname resolving to
        // a private IP is the bypass, so the name is resolved and validated
        // before any connection, and reqwest is pinned to the validated set so
        // a re-resolution cannot swap in a different address between check and
        // connect.
        let (_, cur_scheme, cur_authority) = validate_http_url(&current)?;
        let (host, port) = split_host_port(&cur_authority, &cur_scheme);
        let addrs = resolve_host(&host, port)?;
        let offending = addrs
            .iter()
            .map(|a| (a.ip(), classify_ip(a.ip())))
            .find(|(_, c)| !c.is_global());
        let hop_class = offending.map(|(_, c)| c).unwrap_or(AddrClass::Global);
        let is_first_hop = hops == 0;
        if hop_decision(
            hop_class,
            is_first_hop,
            request.refuse_private,
            first_hop_global,
            allow_private,
        ) == HopDecision::Refuse
        {
            let ip = offending.map(|(ip, _)| ip);
            let ip_note = ip.map(|ip| format!(" ({ip})")).unwrap_or_default();
            let label = hop_class.label();
            return if is_first_hop {
                Err(format!(
                    "{host} is a {label} address{ip_note}. This app does not send form data to your own computer or a private network, so nothing was sent."
                ))
            } else {
                Err(format!(
                    "{authority} redirected to {host}, a {label} address{ip_note}. Nothing was sent there: this app does not follow a redirect onto your own computer or a private network."
                ))
            };
        }
        if is_first_hop {
            first_hop_global = hop_class.is_global();
        }

        let client = reqwest::Client::builder()
            .user_agent(user_agent())
            // Redirects are resolved in the loop below so a cross-origin one can
            // be REFUSED BY NAME rather than reported as a transport error.
            .redirect(reqwest::redirect::Policy::none())
            // Pin the transport to the exact addresses just validated. TLS still
            // verifies the certificate against the hostname, so this narrows
            // WHERE the connection goes without weakening WHO it trusts.
            .resolve_to_addrs(&host, &addrs)
            .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(std::time::Duration::from_secs(TOTAL_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Cannot start the network client: {e}"))?;

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

    /// A GET request with a `probe` name and no body — the open-from-web shape.
    fn get_req(url: String) -> NetRequest {
        NetRequest {
            url,
            method: "get".to_string(),
            body_path: None,
            content_type: None,
            file_name: Some("probe".to_string()),
            refuse_private: false,
        }
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
    fn a_return_url_query_is_root_relative_not_absolute() {
        // The review's exact case: a same-origin `Location` whose query carries
        // a full URL. `://` appears, but the target is root-relative and must
        // resolve against the base host — not be flung at the address inside
        // the `next=` parameter.
        let base = "https://example.com/forms/submit";
        assert_eq!(
            resolve_location(base, "/login?next=https://evil.test/x").unwrap(),
            "https://example.com/login?next=https://evil.test/x"
        );
        // A genuinely absolute Location is still taken as absolute.
        assert_eq!(
            resolve_location(base, "https://elsewhere.test/a?u=http://x").unwrap(),
            "https://elsewhere.test/a?u=http://x"
        );
    }

    #[test]
    fn a_scheme_is_recognized_only_at_position_zero() {
        assert!(starts_with_scheme("https://x"));
        assert!(starts_with_scheme("HTTP://x"));
        assert!(starts_with_scheme("custom+1.-://x"));
        assert!(!starts_with_scheme("/login?next=https://x"));
        assert!(!starts_with_scheme("path/to?u=a://b"));
        assert!(!starts_with_scheme("//host/x"));
        assert!(!starts_with_scheme("1http://x"));
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
    fn a_default_port_is_the_same_origin_as_no_port() {
        // Finding 3: the authority is compared with default ports normalized,
        // so an explicit :443/:80 does not read as a different origin.
        assert!(same_origin("https://example.com:443/a", "https", "example.com"));
        assert!(same_origin("https://example.com/a", "https", "example.com:443"));
        assert!(same_origin("http://example.com:80/a", "http", "example.com"));
        assert!(same_origin("http://example.com/a", "http", "example.com:80"));
        // A non-default port is still its own origin.
        assert!(!same_origin("https://example.com:8443/a", "https", "example.com"));
        assert_eq!(canonical_authority("example.com:443", "https"), "example.com");
        assert_eq!(canonical_authority("example.com:80", "http"), "example.com");
        assert_eq!(canonical_authority("example.com:8443", "https"), "example.com:8443");
        // The comparison key drops the brackets with the default port; both
        // sides of a same_origin check normalize identically, so the key form
        // matters only for equality, not display.
        assert_eq!(canonical_authority("[::1]:443", "https"), "::1");
    }

    #[test]
    fn every_non_global_range_is_classified() {
        use std::str::FromStr;
        let non_global = [
            ("127.0.0.1", AddrClass::Loopback),
            ("10.1.2.3", AddrClass::Private),
            ("172.16.5.5", AddrClass::Private),
            ("192.168.1.5", AddrClass::Private),
            ("169.254.1.1", AddrClass::LinkLocal),
            ("169.254.169.254", AddrClass::LinkLocal), // cloud metadata
            ("0.0.0.0", AddrClass::Unspecified),
            ("100.64.0.1", AddrClass::OtherNonGlobal), // CGNAT
            ("::1", AddrClass::Loopback),
            ("::", AddrClass::Unspecified),
            ("fe80::1", AddrClass::LinkLocal),
            ("fc00::1", AddrClass::UniqueLocal),
            ("fd12::1", AddrClass::UniqueLocal),
            ("::ffff:10.0.0.1", AddrClass::Private), // v4-mapped
        ];
        for (ip, want) in non_global {
            let got = classify_ip(IpAddr::from_str(ip).unwrap());
            assert_eq!(got, want, "{ip}");
            assert!(!got.is_global(), "{ip} must not be global");
        }
        // Public addresses are global.
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"] {
            assert!(
                classify_ip(IpAddr::from_str(ip).unwrap()).is_global(),
                "{ip} should be global"
            );
        }
    }

    #[test]
    fn the_hop_policy_splits_submit_from_open() {
        // Submit refuses any non-global hop, first or not.
        assert_eq!(
            hop_decision(AddrClass::Loopback, true, true, true, false),
            HopDecision::Refuse
        );
        assert_eq!(
            hop_decision(AddrClass::Private, true, true, true, false),
            HopDecision::Refuse
        );
        // Open ALLOWS a non-global first hop (the user typed it)…
        assert_eq!(
            hop_decision(AddrClass::Private, true, false, true, false),
            HopDecision::Allow
        );
        // …but refuses a non-global REDIRECT that started public (unseen).
        assert_eq!(
            hop_decision(AddrClass::Loopback, false, false, true, false),
            HopDecision::Refuse
        );
        // A chain that started private may stay private across a redirect.
        assert_eq!(
            hop_decision(AddrClass::Loopback, false, false, false, false),
            HopDecision::Allow
        );
        // A global hop is always allowed; submit or open, first or not.
        assert_eq!(
            hop_decision(AddrClass::Global, true, true, true, false),
            HopDecision::Allow
        );
        // The carve-out allows every class regardless.
        assert_eq!(
            hop_decision(AddrClass::Loopback, true, true, true, true),
            HopDecision::Allow
        );
    }

    #[test]
    fn the_private_carve_out_is_env_gated() {
        let allow = std::env::var("SPECTRA_NET_ALLOW_PRIVATE").ok();
        let e2e = std::env::var("SPECTRAPDF_E2E").ok();
        std::env::remove_var("SPECTRAPDF_E2E");
        std::env::remove_var("SPECTRA_NET_ALLOW_PRIVATE");
        assert!(!env_allows_private(), "off by default");
        std::env::set_var("SPECTRA_NET_ALLOW_PRIVATE", "1");
        assert!(env_allows_private(), "on when set to 1");
        std::env::set_var("SPECTRA_NET_ALLOW_PRIVATE", "0");
        assert!(!env_allows_private(), "off when not 1/true");
        std::env::remove_var("SPECTRA_NET_ALLOW_PRIVATE");
        std::env::set_var("SPECTRAPDF_E2E", "1");
        assert!(env_allows_private(), "the e2e flag also opens the carve-out");
        std::env::remove_var("SPECTRAPDF_E2E");
        // Restore whatever the harness set.
        if let Some(v) = allow {
            std::env::set_var("SPECTRA_NET_ALLOW_PRIVATE", v);
        }
        if let Some(v) = e2e {
            std::env::set_var("SPECTRAPDF_E2E", v);
        }
    }

    #[tokio::test]
    async fn a_submit_to_a_hostname_that_resolves_private_is_refused() {
        // `localhost` resolves to a loopback address offline; a submit
        // (refuse_private) must refuse it BY NAME after resolution, and connect
        // to nothing.
        let server = TestServer::start(vec![body_reply("text/plain", "unreached")]);
        let mut request = get_req(format!("http://localhost:{}/submit", server.port));
        request.refuse_private = true;
        // allow_private=false: production policy, no carve-out.
        let error = fetch_with_policy(&request, false).await.unwrap_err();
        assert!(error.contains("localhost"), "{error}");
        assert!(error.contains("loopback"), "{error}");
        assert!(server.requests().is_empty(), "nothing was connected to");
    }

    #[tokio::test]
    async fn a_submit_to_a_private_literal_is_refused_by_name() {
        let mut request = get_req("http://192.168.1.5/submit".to_string());
        request.refuse_private = true;
        let error = fetch_with_policy(&request, false).await.unwrap_err();
        assert!(error.contains("192.168.1.5"), "{error}");
        assert!(error.contains("private-network"), "{error}");
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

        let response = fetch_with_policy(
            &NetRequest {
                url: server.url("/submit"),
                method: "post".to_string(),
                body_path: Some(payload.to_string_lossy().to_string()),
                content_type: Some("application/vnd.fdf".to_string()),
                file_name: Some("probe".to_string()),
                refuse_private: true,
            },
            true,
        )
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
        let response = fetch_with_policy(&get_req(server.url("/submit")), true)
            .await
            .unwrap();
        assert_eq!(response.status, 200);
        assert!(response.final_url.ends_with("/thanks"));
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn a_get_submit_puts_field_values_in_the_query() {
        // A GET `/SubmitForm` (GetMethod) must carry its field data on the URL.
        // The built HTML payload is already `key=val&key=val`; it lands in the
        // query and no body is sent.
        let server = TestServer::start(vec![body_reply("text/plain", "ok")]);
        let dir = std::env::temp_dir().join("spectrapdf-net-test-get");
        std::fs::create_dir_all(&dir).unwrap();
        let payload = dir.join("payload.txt");
        std::fs::write(&payload, b"name=Ada&city=London").unwrap();

        let response = fetch_with_policy(
            &NetRequest {
                url: server.url("/submit"),
                method: "get".to_string(),
                body_path: Some(payload.to_string_lossy().to_string()),
                content_type: Some("application/x-www-form-urlencoded".to_string()),
                file_name: Some("probe".to_string()),
                refuse_private: true,
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(response.status, 200);
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0].starts_with("GET /submit?name=Ada&city=London "),
            "{}",
            requests[0]
        );
        // A GET carries no request body.
        assert!(!requests[0].contains("name=Ada&city=London\r\n\r\n"));
    }

    #[tokio::test]
    async fn a_get_submit_of_a_non_urlencoded_format_refuses_by_name() {
        // FDF/XFDF/PDF have no GET query encoding: sending an empty GET while
        // reporting success is the defect, so this refuses instead of sending.
        let dir = std::env::temp_dir().join("spectrapdf-net-test-getfdf");
        std::fs::create_dir_all(&dir).unwrap();
        let payload = dir.join("payload.fdf");
        std::fs::write(&payload, b"%FDF-1.2 data").unwrap();
        let error = fetch_with_policy(
            &NetRequest {
                url: "http://127.0.0.1:1/submit".to_string(),
                method: "get".to_string(),
                body_path: Some(payload.to_string_lossy().to_string()),
                content_type: Some("application/vnd.fdf".to_string()),
                file_name: Some("probe".to_string()),
                refuse_private: true,
            },
            true,
        )
        .await
        .unwrap_err();
        assert!(error.contains("URL-encoded"), "{error}");
        assert!(error.contains("vnd.fdf"), "{error}");
    }

    #[tokio::test]
    async fn a_cross_origin_redirect_aborts_and_names_both_hosts() {
        let server = TestServer::start(vec![
            "HTTP/1.1 302 Found\r\nLocation: http://other.invalid:1/a\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
        ]);
        let error = fetch_with_policy(
            &NetRequest {
                url: server.url("/submit"),
                method: "post".to_string(),
                body_path: None,
                content_type: None,
                file_name: Some("probe".to_string()),
                refuse_private: true,
            },
            true,
        )
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
        let error = fetch_with_policy(&get_req(server.url("/big")), true)
            .await
            .unwrap_err();
        assert!(error.contains("larger than"), "{error}");
    }

    #[tokio::test]
    async fn a_method_this_app_does_not_make_is_refused() {
        let error = fetch_with_policy(
            &NetRequest {
                url: "https://example.com/a".to_string(),
                method: "delete".to_string(),
                body_path: None,
                content_type: None,
                file_name: None,
                refuse_private: true,
            },
            false,
        )
        .await
        .unwrap_err();
        assert!(error.contains("delete"), "{error}");
    }

    #[tokio::test]
    async fn a_non_http_scheme_never_reaches_the_transport() {
        for bad in ["file:///C:/Windows/win.ini", "javascript:alert(1)"] {
            let error = fetch_with_policy(&get_req(bad.to_string()), false)
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
