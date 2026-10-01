//! The virtual printer on Linux: an IPP Everywhere printer on loopback.
//!
//! This process serves IPP/2.0 (encoding RFC 8010, semantics RFC 8011) on
//! `127.0.0.1` at a per-user port and accepts `application/pdf` documents.
//! The CUPS queue is created with `lpadmin -m everywhere`, the one model
//! lpadmin(8) does not mark as deprecated: lpadmin asks this printer for its
//! attributes and CUPS generates the queue's PPD from the answer. Every
//! application's print dialog then prints to the queue, CUPS converts the job
//! to PDF, and its IPP backend delivers the PDF here. The PDF is kept as
//! received (no Ghostscript run) and opens through the normal open funnel.
//!
//! The queue belongs to one user: it is named after the user, accepts jobs
//! from that user only (`-u allow:`), points at that user's port, and this
//! printer refuses a job whose `requesting-user-name` is anyone else. The
//! port is fixed per user id because the queue's device URI records it.
//!
//! The client is identified by the kernel, not by what it sends: on accept,
//! the connection's client socket is looked up in `/proc/net/tcp` (proc(5))
//! and only its owner uid counts. Root, the CUPS `User` account (the IPP
//! backend's identity, cups-files.conf(5)) and this user are admitted; any
//! other account is refused before a byte of its request is read, so it can
//! neither submit a job nor list one.
//!
//! The device URI carries `contimeout` (CUPS ipp backend option, network.html)
//! and the queue `printer-error-policy=abort-job`: a job sent while this app
//! is not listening is aborted after the timeout instead of waiting for
//! whatever process binds the port next.
//!
//! Adding or removing a queue is a scheduler administration operation.
//! `lpadmin` runs first as the user, which the scheduler authorizes for
//! members of its system group through the local socket's peer credentials.
//! When the scheduler refuses, the same command runs through `pkexec`, a
//! visible polkit prompt. Nothing elevates silently; without pkexec or a
//! polkit agent, the refusal names the exact command an administrator runs.

use std::collections::VecDeque;
use std::ffi::{c_char, CStr};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::{
    copy_job, part_path, reclaim_job_intermediates, reserve_pdf, timestamp_name, JobSlot,
    PrinterState, VirtualPrinterStatus, IN_FLIGHT, MAX_CONCURRENT_JOBS, MAX_JOB_BYTES,
    MAX_JOB_RECEIVE_DURATION, READ_IDLE_TIMEOUT,
};

/// The resource the printer answers at.
const RESOURCE: &str = "/ipp/print";
/// What a print dialog shows for the queue (`printer-info`).
const DESCRIPTION: &str = "Spectra PDF";
const MAKE_AND_MODEL: &str = "Spectra PDF Virtual Printer";
/// Queue names are at most 127 bytes (lpadmin(8)).
const MAX_QUEUE_NAME: usize = 127;
/// The attribute section of one request; documents follow it.
const MAX_ATTRIBUTE_BYTES: usize = 1024 * 1024;
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// Finished jobs kept for Get-Job-Attributes and Get-Jobs.
const MAX_JOBS_KEPT: usize = 64;
const LPADMIN_TIMEOUT: Duration = Duration::from_secs(120);

// ── identity ────────────────────────────────────────────────────────────────

/// The login name of the effective user, from the password database.
pub(super) fn current_user() -> Option<String> {
    let uid = unsafe { libc::geteuid() };
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as c_char; 16 * 1024];
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut found) };
    if rc != 0 || found.is_null() || pwd.pw_name.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(pwd.pw_name) }
        .to_str()
        .ok()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// The loopback port a user's printer listens on: below the kernel's default
/// ephemeral range, and fixed because the queue's device URI records it.
pub(super) fn port_for(uid: u32) -> u16 {
    10_000 + (uid % 22_768) as u16
}

fn own_port() -> u16 {
    port_for(unsafe { libc::geteuid() })
}

/// `Spectra-PDF-<user>`, restricted to characters every CUPS release accepts
/// in a queue name.
pub(super) fn queue_name(user: &str) -> String {
    let mut name = String::from("Spectra-PDF-");
    for c in user.chars() {
        if name.len() >= MAX_QUEUE_NAME {
            break;
        }
        name.push(if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            c
        } else {
            '_'
        });
    }
    name
}

pub(super) fn device_uri(port: u16) -> String {
    format!("ipp://127.0.0.1:{port}{RESOURCE}")
}

/// How long the CUPS IPP backend tries to reach this printer before the job
/// fails, in seconds. Its default is seven days.
const CONNECT_TIMEOUT_S: u32 = 30;

/// The queue's device URI: the printer plus the backend's connection timeout.
pub(super) fn queue_uri(port: u16) -> String {
    format!("{}?contimeout={CONNECT_TIMEOUT_S}", device_uri(port))
}

// ── who connected ───────────────────────────────────────────────────────────

/// `ip:port` as `/proc/net/tcp` prints it: the address as the hexadecimal
/// value of its network-order bytes read as a host integer, the port in
/// hexadecimal.
fn proc_endpoint(text: &str) -> Option<SocketAddrV4> {
    let (addr, port) = text.split_once(':')?;
    if addr.len() != 8 {
        return None;
    }
    let raw = u32::from_str_radix(addr, 16).ok()?;
    let port = u16::from_str_radix(port, 16).ok()?;
    Some(SocketAddrV4::new(Ipv4Addr::from(raw.to_ne_bytes()), port))
}

/// The uid owning the client end of a loopback connection: the table row
/// whose local address is the client's and whose remote address is this
/// server's. TIME_WAIT and CLOSE rows carry no owner (the kernel prints uid
/// 0 for them), so only states in which the client socket is still owned
/// count: ESTABLISHED (01), FIN_WAIT1 (04), FIN_WAIT2 (05).
pub(super) fn peer_uid_in(table: &str, client: SocketAddrV4, server: SocketAddrV4) -> Option<u32> {
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 8 || !matches!(fields[3], "01" | "04" | "05") {
            return None;
        }
        if proc_endpoint(fields[1])? != client || proc_endpoint(fields[2])? != server {
            return None;
        }
        fields[7].parse().ok()
    })
}

fn peer_uid(stream: &TcpStream) -> Option<u32> {
    let (SocketAddr::V4(client), SocketAddr::V4(server)) =
        (stream.peer_addr().ok()?, stream.local_addr().ok()?)
    else {
        return None;
    };
    let table = std::fs::read_to_string("/proc/net/tcp").ok()?;
    peer_uid_in(&table, client, server)
}

/// The account cupsd runs its backends as: the `User` directive of
/// cups-files.conf, `lp` when the file names none.
pub(super) fn cups_user_name(conf: Option<&str>) -> String {
    conf.and_then(|text| {
        text.lines().find_map(|line| {
            let line = line.trim();
            let (key, value) = line.split_once(char::is_whitespace)?;
            (!line.starts_with('#') && key.eq_ignore_ascii_case("User"))
                .then(|| value.trim().to_string())
                .filter(|v| !v.is_empty())
        })
    })
    .unwrap_or_else(|| "lp".to_string())
}

fn uid_of(name: &str) -> Option<u32> {
    if let Ok(uid) = name.parse::<u32>() {
        return Some(uid);
    }
    let name = std::ffi::CString::new(name).ok()?;
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as c_char; 16 * 1024];
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe { libc::getpwnam_r(name.as_ptr(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut found) };
    (rc == 0 && !found.is_null()).then_some(pwd.pw_uid)
}

/// Root, this user, and the CUPS backend account.
pub(super) fn admitted_uids(own: u32, cups_user: Option<u32>) -> Vec<u32> {
    let mut uids = vec![0, own];
    uids.extend(cups_user);
    uids.sort_unstable();
    uids.dedup();
    uids
}

fn system_admitted_uids() -> Vec<u32> {
    let conf = std::fs::read_to_string("/etc/cups/cups-files.conf").ok();
    admitted_uids(unsafe { libc::geteuid() }, uid_of(&cups_user_name(conf.as_deref())))
}

/// Letter for the territories whose locales default to it, A4 elsewhere.
pub(super) fn default_media_for_locale(locale: &str) -> &'static str {
    const LETTER: &[&str] = &[
        "US", "CA", "MX", "PR", "PH", "CL", "CO", "VE", "CR", "PA", "GT", "SV", "NI", "DO",
    ];
    let territory = locale
        .split(['.', '@'])
        .next()
        .and_then(|lang| lang.split_once('_'))
        .map(|(_, t)| t)
        .unwrap_or("");
    if LETTER.contains(&territory) {
        "na_letter_8.5x11in"
    } else {
        "iso_a4_210x297mm"
    }
}

/// `$XDG_CACHE_HOME/spectrapdf/printed`; a per-user folder under the temp
/// directory only when no home is known.
pub(super) fn printed_dir() -> PathBuf {
    crate::portable::xdg_base_from(
        std::env::var_os("XDG_CACHE_HOME"),
        std::env::var_os("HOME").map(PathBuf::from),
        ".cache",
    )
    .map(|cache| cache.join("spectrapdf").join("printed"))
    .unwrap_or_else(|| {
        std::env::temp_dir()
            .join(format!("spectrapdf-{}", unsafe { libc::geteuid() }))
            .join("printed")
    })
}

/// Create `dir` readable by its owner only, and refuse a folder another
/// account owns or a symbolic link put in its place.
pub(super) fn private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is not a folder this user owns", dir.display()),
        ));
    }
    Ok(())
}

fn session_locale() -> String {
    ["LC_ALL", "LC_PAPER", "LANG"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

// ── IPP encoding (RFC 8010) ─────────────────────────────────────────────────

mod tag {
    pub const OPERATION: u8 = 0x01;
    pub const JOB: u8 = 0x02;
    pub const END: u8 = 0x03;
    pub const PRINTER: u8 = 0x04;
    pub const UNSUPPORTED_GROUP: u8 = 0x05;

    pub const INTEGER: u8 = 0x21;
    pub const BOOLEAN: u8 = 0x22;
    pub const ENUM: u8 = 0x23;
    pub const RESOLUTION: u8 = 0x32;
    pub const RANGE: u8 = 0x33;
    pub const BEGIN_COLLECTION: u8 = 0x34;
    pub const TEXT_LANG: u8 = 0x35;
    pub const NAME_LANG: u8 = 0x36;
    pub const END_COLLECTION: u8 = 0x37;
    pub const TEXT: u8 = 0x41;
    pub const NAME: u8 = 0x42;
    pub const KEYWORD: u8 = 0x44;
    pub const URI: u8 = 0x45;
    pub const URI_SCHEME: u8 = 0x46;
    pub const CHARSET: u8 = 0x47;
    pub const LANGUAGE: u8 = 0x48;
    pub const MIME: u8 = 0x49;
    pub const MEMBER_NAME: u8 = 0x4A;
    pub const EXTENSION: u8 = 0x7F;
}

mod status {
    pub const OK: u16 = 0x0000;
    pub const OK_IGNORED: u16 = 0x0001;
    pub const BAD_REQUEST: u16 = 0x0400;
    pub const NOT_AUTHORIZED: u16 = 0x0403;
    pub const NOT_POSSIBLE: u16 = 0x0404;
    pub const NOT_FOUND: u16 = 0x0406;
    pub const ENTITY_TOO_LARGE: u16 = 0x0408;
    pub const FORMAT_NOT_SUPPORTED: u16 = 0x040A;
    pub const FORMAT_ERROR: u16 = 0x0411;
    pub const INTERNAL: u16 = 0x0500;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x0501;
    pub const VERSION_NOT_SUPPORTED: u16 = 0x0503;
    pub const BUSY: u16 = 0x0507;
}

mod op {
    pub const PRINT_JOB: u16 = 0x0002;
    pub const VALIDATE_JOB: u16 = 0x0004;
    pub const CREATE_JOB: u16 = 0x0005;
    pub const SEND_DOCUMENT: u16 = 0x0006;
    pub const CANCEL_JOB: u16 = 0x0008;
    pub const GET_JOB_ATTRIBUTES: u16 = 0x0009;
    pub const GET_JOBS: u16 = 0x000A;
    pub const GET_PRINTER_ATTRIBUTES: u16 = 0x000B;
    pub const SUPPORTED: &[u16] = &[
        PRINT_JOB,
        VALIDATE_JOB,
        CREATE_JOB,
        SEND_DOCUMENT,
        CANCEL_JOB,
        GET_JOB_ATTRIBUTES,
        GET_JOBS,
        GET_PRINTER_ATTRIBUTES,
    ];
}

/// `job-state` (RFC 8011 section 5.3.7).
mod job_state {
    pub const PENDING: i32 = 3;
    pub const PROCESSING: i32 = 5;
    pub const CANCELED: i32 = 7;
    pub const ABORTED: i32 = 8;
    pub const COMPLETED: i32 = 9;
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Value {
    Integer(i32),
    Boolean(bool),
    Enum(i32),
    Text(String),
    Name(String),
    Keyword(String),
    Uri(String),
    Charset(String),
    Language(String),
    Mime(String),
    Range(i32, i32),
    /// Cross-feed, feed, units (3 = dots per inch).
    Resolution(i32, i32, i8),
    Collection(Vec<Attr>),
    Other(u8, Vec<u8>),
}

impl Value {
    fn text(&self) -> Option<&str> {
        match self {
            Value::Text(s)
            | Value::Name(s)
            | Value::Keyword(s)
            | Value::Uri(s)
            | Value::Charset(s)
            | Value::Language(s)
            | Value::Mime(s) => Some(s),
            _ => None,
        }
    }

    fn integer(&self) -> Option<i32> {
        match self {
            Value::Integer(i) | Value::Enum(i) => Some(*i),
            _ => None,
        }
    }

    fn boolean(&self) -> Option<bool> {
        match self {
            Value::Boolean(b) => Some(*b),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Attr {
    pub name: String,
    pub values: Vec<Value>,
}

impl Attr {
    fn new(name: &str, values: Vec<Value>) -> Self {
        Self {
            name: name.to_string(),
            values,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Group {
    pub tag: u8,
    pub attrs: Vec<Attr>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Message {
    pub version: (u8, u8),
    /// The operation id of a request, the status code of a response.
    pub code: u16,
    pub request_id: u32,
    pub groups: Vec<Group>,
}

impl Message {
    fn attr(&self, group: u8, name: &str) -> Option<&Attr> {
        self.groups
            .iter()
            .filter(|g| g.tag == group)
            .flat_map(|g| g.attrs.iter())
            .find(|a| a.name == name)
    }

    fn op_text(&self, name: &str) -> Option<&str> {
        self.attr(tag::OPERATION, name)
            .and_then(|a| a.values.first())
            .and_then(Value::text)
    }

    fn op_integer(&self, name: &str) -> Option<i32> {
        self.attr(tag::OPERATION, name)
            .and_then(|a| a.values.first())
            .and_then(Value::integer)
    }

    fn op_boolean(&self, name: &str) -> Option<bool> {
        self.attr(tag::OPERATION, name)
            .and_then(|a| a.values.first())
            .and_then(Value::boolean)
    }
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

/// Reads the attribute section through a budget, so a request cannot make
/// this process buffer more than `MAX_ATTRIBUTE_BYTES` before its document.
struct Budget<'a, R: Read + ?Sized> {
    inner: &'a mut R,
    left: usize,
}

impl<R: Read + ?Sized> Budget<'_, R> {
    fn bytes(&mut self, n: usize) -> io::Result<Vec<u8>> {
        if n > self.left {
            return Err(bad("the request's attributes exceed the size limit"));
        }
        self.left -= n;
        let mut buf = vec![0u8; n];
        self.inner.read_exact(&mut buf)?;
        Ok(buf)
    }

    fn u8(&mut self) -> io::Result<u8> {
        Ok(self.bytes(1)?[0])
    }

    fn u16(&mut self) -> io::Result<u16> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> io::Result<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    /// One attribute item: value tag, name, value bytes.
    fn item(&mut self, value_tag: u8) -> io::Result<(String, Vec<u8>)> {
        if value_tag == tag::EXTENSION {
            return Err(bad("extension value tags are not supported"));
        }
        let name_len = self.u16()? as usize;
        let name = String::from_utf8_lossy(&self.bytes(name_len)?).into_owned();
        let value_len = self.u16()? as usize;
        Ok((name, self.bytes(value_len)?))
    }
}

fn be_i32(bytes: &[u8]) -> io::Result<i32> {
    bytes
        .try_into()
        .map(i32::from_be_bytes)
        .map_err(|_| bad("an integer value is not four bytes"))
}

/// The text of a `textWithLanguage` / `nameWithLanguage` value: a
/// length-prefixed language tag, then the length-prefixed text (RFC 8010
/// section 3.9).
fn with_language(bytes: &[u8]) -> io::Result<String> {
    let short = || bad("a value with language is truncated");
    let length_at = |at: usize| -> io::Result<usize> {
        let b = bytes.get(at..at + 2).ok_or_else(short)?;
        Ok(u16::from_be_bytes([b[0], b[1]]) as usize)
    };
    let text_at = 2 + length_at(0)?;
    let text_len = length_at(text_at)?;
    let text = bytes.get(text_at + 2..text_at + 2 + text_len).ok_or_else(short)?;
    Ok(String::from_utf8_lossy(text).into_owned())
}

fn decode_value(value_tag: u8, bytes: Vec<u8>) -> io::Result<Value> {
    let string = |b: Vec<u8>| String::from_utf8_lossy(&b).into_owned();
    Ok(match value_tag {
        tag::INTEGER => Value::Integer(be_i32(&bytes)?),
        tag::ENUM => Value::Enum(be_i32(&bytes)?),
        tag::BOOLEAN => match bytes.as_slice() {
            [b] => Value::Boolean(*b != 0),
            _ => return Err(bad("a boolean value is not one byte")),
        },
        tag::RANGE if bytes.len() == 8 => Value::Range(be_i32(&bytes[..4])?, be_i32(&bytes[4..])?),
        tag::RESOLUTION if bytes.len() == 9 => {
            Value::Resolution(be_i32(&bytes[..4])?, be_i32(&bytes[4..8])?, bytes[8] as i8)
        }
        tag::TEXT_LANG => Value::Text(with_language(&bytes)?),
        tag::NAME_LANG => Value::Name(with_language(&bytes)?),
        tag::TEXT => Value::Text(string(bytes)),
        tag::NAME => Value::Name(string(bytes)),
        tag::KEYWORD => Value::Keyword(string(bytes)),
        tag::URI | tag::URI_SCHEME => Value::Uri(string(bytes)),
        tag::CHARSET => Value::Charset(string(bytes)),
        tag::LANGUAGE => Value::Language(string(bytes)),
        tag::MIME => Value::Mime(string(bytes)),
        other => Value::Other(other, bytes),
    })
}

fn push_value(attrs: &mut Vec<Attr>, name: String, value: Value) -> io::Result<()> {
    if name.is_empty() {
        attrs
            .last_mut()
            .ok_or_else(|| bad("an additional value has no attribute"))?
            .values
            .push(value);
    } else {
        attrs.push(Attr {
            name,
            values: vec![value],
        });
    }
    Ok(())
}

fn decode_collection<R: Read + ?Sized>(r: &mut Budget<'_, R>, depth: usize) -> io::Result<Vec<Attr>> {
    if depth > 8 {
        return Err(bad("collections nest too deeply"));
    }
    let mut members: Vec<Attr> = Vec::new();
    let mut pending: Option<String> = None;
    loop {
        let value_tag = r.u8()?;
        let (_, bytes) = r.item(value_tag)?;
        match value_tag {
            tag::END_COLLECTION => return Ok(members),
            tag::MEMBER_NAME => pending = Some(String::from_utf8_lossy(&bytes).into_owned()),
            _ => {
                let value = if value_tag == tag::BEGIN_COLLECTION {
                    Value::Collection(decode_collection(r, depth + 1)?)
                } else {
                    decode_value(value_tag, bytes)?
                };
                push_value(&mut members, pending.take().unwrap_or_default(), value)?;
            }
        }
    }
}

/// Decode one IPP message's header and attribute section. The reader is left
/// at the first byte of the document data, if any.
pub(super) fn decode<R: Read + ?Sized>(reader: &mut R) -> io::Result<Message> {
    let mut r = Budget {
        inner: reader,
        left: MAX_ATTRIBUTE_BYTES,
    };
    let version = (r.u8()?, r.u8()?);
    let code = r.u16()?;
    let request_id = r.u32()?;
    let mut groups: Vec<Group> = Vec::new();
    loop {
        let value_tag = r.u8()?;
        if value_tag == tag::END {
            break;
        }
        if value_tag < 0x10 {
            groups.push(Group {
                tag: value_tag,
                attrs: Vec::new(),
            });
            continue;
        }
        let (name, bytes) = r.item(value_tag)?;
        let value = if value_tag == tag::BEGIN_COLLECTION {
            Value::Collection(decode_collection(&mut r, 1)?)
        } else {
            decode_value(value_tag, bytes)?
        };
        let group = groups
            .last_mut()
            .ok_or_else(|| bad("an attribute precedes its group"))?;
        push_value(&mut group.attrs, name, value)?;
    }
    Ok(Message {
        version,
        code,
        request_id,
        groups,
    })
}

fn put_item(out: &mut Vec<u8>, value_tag: u8, name: &str, value: &[u8]) {
    out.push(value_tag);
    out.extend_from_slice(&(name.len() as u16).to_be_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
}

fn put_value(out: &mut Vec<u8>, name: &str, value: &Value) {
    match value {
        Value::Integer(i) => put_item(out, tag::INTEGER, name, &i.to_be_bytes()),
        Value::Enum(i) => put_item(out, tag::ENUM, name, &i.to_be_bytes()),
        Value::Boolean(b) => put_item(out, tag::BOOLEAN, name, &[u8::from(*b)]),
        Value::Text(s) => put_item(out, tag::TEXT, name, s.as_bytes()),
        Value::Name(s) => put_item(out, tag::NAME, name, s.as_bytes()),
        Value::Keyword(s) => put_item(out, tag::KEYWORD, name, s.as_bytes()),
        Value::Uri(s) => put_item(out, tag::URI, name, s.as_bytes()),
        Value::Charset(s) => put_item(out, tag::CHARSET, name, s.as_bytes()),
        Value::Language(s) => put_item(out, tag::LANGUAGE, name, s.as_bytes()),
        Value::Mime(s) => put_item(out, tag::MIME, name, s.as_bytes()),
        Value::Range(lo, hi) => {
            let mut b = lo.to_be_bytes().to_vec();
            b.extend_from_slice(&hi.to_be_bytes());
            put_item(out, tag::RANGE, name, &b);
        }
        Value::Resolution(x, y, units) => {
            let mut b = x.to_be_bytes().to_vec();
            b.extend_from_slice(&y.to_be_bytes());
            b.push(*units as u8);
            put_item(out, tag::RESOLUTION, name, &b);
        }
        Value::Collection(members) => {
            put_item(out, tag::BEGIN_COLLECTION, name, &[]);
            for member in members {
                put_item(out, tag::MEMBER_NAME, "", member.name.as_bytes());
                for v in &member.values {
                    put_value(out, "", v);
                }
            }
            put_item(out, tag::END_COLLECTION, "", &[]);
        }
        Value::Other(t, bytes) => put_item(out, *t, name, bytes),
    }
}

pub(super) fn encode(message: &Message) -> Vec<u8> {
    let mut out = vec![message.version.0, message.version.1];
    out.extend_from_slice(&message.code.to_be_bytes());
    out.extend_from_slice(&message.request_id.to_be_bytes());
    for group in &message.groups {
        out.push(group.tag);
        for attr in &group.attrs {
            let mut first = true;
            for value in &attr.values {
                put_value(&mut out, if first { &attr.name } else { "" }, value);
                first = false;
            }
        }
    }
    out.push(tag::END);
    out
}

// ── HTTP/1.1 framing ────────────────────────────────────────────────────────

pub(super) struct Head {
    pub method: String,
    pub target: String,
    pub http10: bool,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn keep_alive(&self) -> bool {
        let connection = self.header("connection").unwrap_or("").to_ascii_lowercase();
        if self.http10 {
            connection.contains("keep-alive")
        } else {
            !connection.contains("close")
        }
    }
}

fn read_line<R: BufRead>(r: &mut R, budget: &mut usize) -> io::Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let available = r.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(bad("the connection closed inside a line"))
            };
        }
        let (taken, done) = match available.iter().position(|&b| b == b'\n') {
            Some(at) => (at + 1, true),
            None => (available.len(), false),
        };
        if taken > *budget {
            return Err(bad("an HTTP line exceeds the size limit"));
        }
        *budget -= taken;
        line.extend_from_slice(&available[..taken]);
        r.consume(taken);
        if done {
            while matches!(line.last(), Some(b'\n' | b'\r')) {
                line.pop();
            }
            return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
        }
    }
}

/// One request head, or `None` when the client closed between requests.
pub(super) fn read_head<R: BufRead>(r: &mut R) -> io::Result<Option<Head>> {
    let mut budget = MAX_HEAD_BYTES;
    let request_line = loop {
        match read_line(r, &mut budget)? {
            None => return Ok(None),
            // RFC 9112 section 2.2: an empty line before the request line is
            // ignored.
            Some(line) if line.is_empty() => continue,
            Some(line) => break line,
        }
    };
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(bad("malformed request line"));
    };
    let mut headers = Vec::new();
    loop {
        let line = read_line(r, &mut budget)?.ok_or_else(|| bad("the connection closed in a head"))?;
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').ok_or_else(|| bad("malformed header"))?;
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    Ok(Some(Head {
        method: method.to_string(),
        target: target.to_string(),
        http10: version == "HTTP/1.0",
        headers,
    }))
}

/// A request body: `Content-Length` or chunked transfer coding (RFC 9112
/// sections 6.2 and 7.1).
pub(super) struct Body<'a, R: BufRead> {
    inner: &'a mut R,
    chunked: bool,
    left: u64,
    done: bool,
}

impl<'a, R: BufRead> Body<'a, R> {
    pub fn new(inner: &'a mut R, head: &Head) -> io::Result<Self> {
        let chunked = head
            .header("transfer-encoding")
            .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
        if chunked {
            return Ok(Self {
                inner,
                chunked: true,
                left: 0,
                done: false,
            });
        }
        let left = match head.header("content-length") {
            Some(v) => v.trim().parse::<u64>().map_err(|_| bad("invalid Content-Length"))?,
            None => 0,
        };
        Ok(Self {
            inner,
            chunked: false,
            left,
            done: left == 0,
        })
    }

    fn next_chunk(&mut self) -> io::Result<()> {
        let mut budget = 4096;
        let line = read_line(self.inner, &mut budget)?.ok_or_else(|| bad("truncated chunk"))?;
        let size_text = line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_text, 16).map_err(|_| bad("invalid chunk size"))?;
        if size == 0 {
            loop {
                let mut budget = 4096;
                match read_line(self.inner, &mut budget)? {
                    None => break,
                    Some(trailer) if trailer.is_empty() => break,
                    Some(_) => {}
                }
            }
            self.done = true;
        } else {
            self.left = size;
        }
        Ok(())
    }

    /// Read and discard what the handler left, so the connection can carry
    /// the next request. A remainder over the job limit closes it instead.
    pub fn drain(&mut self) -> io::Result<()> {
        let mut sink = io::sink();
        let copied = io::copy(&mut self.take(MAX_JOB_BYTES + 1), &mut sink)?;
        if copied > MAX_JOB_BYTES {
            return Err(bad("the request body exceeds the size limit"));
        }
        Ok(())
    }
}

impl<R: BufRead> Read for Body<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.done {
                return Ok(0);
            }
            if self.left == 0 {
                if !self.chunked {
                    self.done = true;
                    return Ok(0);
                }
                self.next_chunk()?;
                continue;
            }
            let want = buf.len().min(self.left.min(usize::MAX as u64) as usize);
            let n = self.inner.read(&mut buf[..want])?;
            if n == 0 {
                return Err(bad("the connection closed inside the body"));
            }
            self.left -= n as u64;
            if self.left == 0 && self.chunked {
                let mut budget = 16;
                read_line(self.inner, &mut budget)?;
            } else if self.left == 0 {
                self.done = true;
            }
            return Ok(n);
        }
    }
}

fn write_response(out: &mut impl Write, status: &str, content_type: Option<&str>, body: &[u8], close: bool) -> io::Result<()> {
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n", body.len());
    if let Some(ct) = content_type {
        head.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    if close {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    out.write_all(head.as_bytes())?;
    out.write_all(body)?;
    out.flush()
}

// ── the printer ─────────────────────────────────────────────────────────────

/// Sizes the printer offers (PWG 5101.1 names), in hundredths of millimetres.
const MEDIA: &[(&str, i32, i32)] = &[
    ("na_letter_8.5x11in", 21590, 27940),
    ("na_legal_8.5x14in", 21590, 35560),
    ("na_ledger_11x17in", 27940, 43180),
    ("na_executive_7.25x10.5in", 18415, 26670),
    ("iso_a3_297x420mm", 29700, 42000),
    ("iso_a4_210x297mm", 21000, 29700),
    ("iso_a5_148x210mm", 14800, 21000),
    ("iso_a6_105x148mm", 10500, 14800),
    ("iso_b5_176x250mm", 17600, 25000),
    ("jis_b5_182x257mm", 18200, 25700),
    ("iso_dl_110x220mm", 11000, 22000),
    ("na_number-10_4.125x9.5in", 10478, 24130),
];
/// Custom sizes: 1 inch to 48 inches on either side.
const CUSTOM_MIN: i32 = 2540;
const CUSTOM_MAX: i32 = 121_920;

#[derive(Clone, Debug)]
struct Job {
    id: i32,
    state: i32,
    reasons: &'static str,
    message: String,
    name: String,
    user: String,
    created: i32,
    completed: Option<i32>,
    documents: u32,
}

/// What a received document became.
pub(super) enum Delivery {
    Delivered(PathBuf),
    Empty,
}

pub(super) struct IppPrinter {
    port: u16,
    user: String,
    default_media: &'static str,
    started: Instant,
    next_job: AtomicI32,
    jobs: Mutex<VecDeque<Job>>,
    receiving: AtomicUsize,
    dir: PathBuf,
    deliver: Box<dyn Fn(PathBuf) + Send + Sync>,
    record_error: Box<dyn Fn(String) + Send + Sync>,
    /// The uids whose connections are served.
    admitted: Vec<u32>,
}

impl IppPrinter {
    pub(super) fn new(
        port: u16,
        user: String,
        dir: PathBuf,
        deliver: Box<dyn Fn(PathBuf) + Send + Sync>,
        record_error: Box<dyn Fn(String) + Send + Sync>,
    ) -> Self {
        Self {
            port,
            user,
            default_media: default_media_for_locale(&session_locale()),
            started: Instant::now(),
            next_job: AtomicI32::new(1),
            jobs: Mutex::new(VecDeque::new()),
            receiving: AtomicUsize::new(0),
            dir,
            deliver,
            record_error,
            admitted: system_admitted_uids(),
        }
    }

    /// Whether a connection's client may be served at all.
    pub(super) fn admits(&self, uid: Option<u32>) -> bool {
        uid.is_some_and(|uid| self.admitted.contains(&uid))
    }

    fn uri(&self) -> String {
        device_uri(self.port)
    }

    fn up_time(&self) -> i32 {
        i32::try_from(self.started.elapsed().as_secs())
            .unwrap_or(i32::MAX)
            .saturating_add(1)
    }

    fn uuid(&self) -> String {
        format!("urn:uuid:5bd0f6a4-3c1e-4d55-9a6e-{:012x}", unsafe { libc::geteuid() })
    }

    fn media_col(x: Value, y: Value) -> Value {
        let size = Value::Collection(vec![
            Attr::new("x-dimension", vec![x]),
            Attr::new("y-dimension", vec![y]),
        ]);
        let mut members = vec![Attr::new("media-size", vec![size])];
        for margin in ["media-bottom-margin", "media-left-margin", "media-right-margin", "media-top-margin"] {
            members.push(Attr::new(margin, vec![Value::Integer(0)]));
        }
        Value::Collection(members)
    }

    pub(super) fn printer_attributes(&self) -> Vec<Attr> {
        let kw = |s: &str| Value::Keyword(s.to_string());
        let kws = |list: &[&str]| list.iter().map(|s| kw(s)).collect::<Vec<_>>();
        let (dx, dy) = MEDIA
            .iter()
            .find(|(name, _, _)| *name == self.default_media)
            .map(|(_, x, y)| (*x, *y))
            .unwrap_or((21000, 29700));
        let mut database: Vec<Value> = MEDIA
            .iter()
            .map(|(_, x, y)| Self::media_col(Value::Integer(*x), Value::Integer(*y)))
            .collect();
        database.push(Self::media_col(
            Value::Range(CUSTOM_MIN, CUSTOM_MAX),
            Value::Range(CUSTOM_MIN, CUSTOM_MAX),
        ));
        let sizes: Vec<Value> = MEDIA
            .iter()
            .map(|(_, x, y)| {
                Value::Collection(vec![
                    Attr::new("x-dimension", vec![Value::Integer(*x)]),
                    Attr::new("y-dimension", vec![Value::Integer(*y)]),
                ])
            })
            .collect();
        let queued = self
            .jobs
            .lock()
            .map(|jobs| jobs.iter().filter(|j| j.state < job_state::CANCELED).count())
            .unwrap_or(0);
        let processing = self.receiving.load(Ordering::SeqCst) > 0;
        vec![
            Attr::new("charset-configured", vec![Value::Charset("utf-8".into())]),
            Attr::new("charset-supported", vec![Value::Charset("utf-8".into())]),
            Attr::new("color-supported", vec![Value::Boolean(true)]),
            Attr::new("compression-supported", kws(&["none"])),
            Attr::new("copies-default", vec![Value::Integer(1)]),
            Attr::new("copies-supported", vec![Value::Range(1, 999)]),
            Attr::new("document-format-default", vec![Value::Mime("application/pdf".into())]),
            Attr::new("document-format-supported", vec![Value::Mime("application/pdf".into())]),
            Attr::new("generated-natural-language-supported", vec![Value::Language("en".into())]),
            Attr::new("ipp-versions-supported", kws(&["1.1", "2.0"])),
            Attr::new("job-ids-supported", vec![Value::Boolean(true)]),
            Attr::new(
                "job-creation-attributes-supported",
                kws(&["copies", "media", "media-col", "orientation-requested", "print-color-mode", "sides"]),
            ),
            Attr::new("media-bottom-margin-supported", vec![Value::Integer(0)]),
            Attr::new("media-left-margin-supported", vec![Value::Integer(0)]),
            Attr::new("media-right-margin-supported", vec![Value::Integer(0)]),
            Attr::new("media-top-margin-supported", vec![Value::Integer(0)]),
            Attr::new("media-col-database", database),
            Attr::new(
                "media-col-default",
                vec![Self::media_col(Value::Integer(dx), Value::Integer(dy))],
            ),
            Attr::new(
                "media-col-ready",
                vec![Self::media_col(Value::Integer(dx), Value::Integer(dy))],
            ),
            Attr::new(
                "media-col-supported",
                kws(&[
                    "media-bottom-margin",
                    "media-left-margin",
                    "media-right-margin",
                    "media-size",
                    "media-top-margin",
                ]),
            ),
            Attr::new("media-default", vec![kw(self.default_media)]),
            Attr::new("media-ready", vec![kw(self.default_media)]),
            Attr::new("media-size-supported", sizes),
            Attr::new("media-supported", MEDIA.iter().map(|(n, _, _)| kw(n)).collect()),
            Attr::new(
                "multiple-document-handling-supported",
                kws(&["separate-documents-uncollated-copies", "separate-documents-collated-copies"]),
            ),
            Attr::new("multiple-document-jobs-supported", vec![Value::Boolean(true)]),
            Attr::new("multiple-operation-time-out", vec![Value::Integer(60)]),
            Attr::new("natural-language-configured", vec![Value::Language("en".into())]),
            Attr::new(
                "operations-supported",
                op::SUPPORTED.iter().map(|o| Value::Enum(*o as i32)).collect(),
            ),
            Attr::new("orientation-requested-default", vec![Value::Enum(3)]),
            Attr::new(
                "orientation-requested-supported",
                vec![Value::Enum(3), Value::Enum(4), Value::Enum(5), Value::Enum(6)],
            ),
            Attr::new("output-bin-default", vec![kw("face-up")]),
            Attr::new("output-bin-supported", kws(&["face-up"])),
            Attr::new("pdl-override-supported", vec![kw("attempted")]),
            Attr::new("print-color-mode-default", vec![kw("color")]),
            Attr::new("print-color-mode-supported", kws(&["auto", "color", "monochrome"])),
            Attr::new("print-quality-default", vec![Value::Enum(4)]),
            Attr::new("print-quality-supported", vec![Value::Enum(4)]),
            Attr::new(
                "printer-device-id",
                vec![Value::Text("MFG:Spectra PDF;MDL:Virtual Printer;CMD:PDF;CLS:PRINTER;".into())],
            ),
            Attr::new("printer-info", vec![Value::Text(DESCRIPTION.into())]),
            Attr::new("printer-is-accepting-jobs", vec![Value::Boolean(true)]),
            Attr::new("printer-make-and-model", vec![Value::Text(MAKE_AND_MODEL.into())]),
            Attr::new("printer-name", vec![Value::Name(DESCRIPTION.into())]),
            Attr::new("printer-resolution-default", vec![Value::Resolution(300, 300, 3)]),
            Attr::new("printer-resolution-supported", vec![Value::Resolution(300, 300, 3)]),
            Attr::new("printer-state", vec![Value::Enum(if processing { 4 } else { 3 })]),
            Attr::new("printer-state-reasons", kws(&["none"])),
            Attr::new("printer-up-time", vec![Value::Integer(self.up_time())]),
            Attr::new("printer-uri-supported", vec![Value::Uri(self.uri())]),
            Attr::new("printer-uuid", vec![Value::Uri(self.uuid())]),
            Attr::new("queued-job-count", vec![Value::Integer(queued as i32)]),
            Attr::new("sides-default", vec![kw("one-sided")]),
            Attr::new("sides-supported", kws(&["one-sided"])),
            Attr::new("uri-authentication-supported", kws(&["none"])),
            Attr::new("uri-security-supported", kws(&["none"])),
            Attr::new("which-jobs-supported", kws(&["completed", "not-completed", "all"])),
        ]
    }

    fn job_attributes(&self, job: &Job) -> Vec<Attr> {
        let mut attrs = vec![
            Attr::new("job-id", vec![Value::Integer(job.id)]),
            Attr::new("job-uri", vec![Value::Uri(format!("{}/{}", self.uri(), job.id))]),
            Attr::new("job-printer-uri", vec![Value::Uri(self.uri())]),
            Attr::new("job-name", vec![Value::Name(job.name.clone())]),
            Attr::new("job-originating-user-name", vec![Value::Name(job.user.clone())]),
            Attr::new("job-state", vec![Value::Enum(job.state)]),
            Attr::new("job-state-reasons", vec![Value::Keyword(job.reasons.into())]),
            Attr::new("job-impressions-completed", vec![Value::Integer(0)]),
            Attr::new("job-media-sheets-completed", vec![Value::Integer(0)]),
            Attr::new("time-at-creation", vec![Value::Integer(job.created)]),
        ];
        if !job.message.is_empty() {
            attrs.push(Attr::new("job-state-message", vec![Value::Text(job.message.clone())]));
        }
        if let Some(done) = job.completed {
            attrs.push(Attr::new("time-at-completed", vec![Value::Integer(done)]));
        }
        attrs
    }

    fn response(&self, request: &Message, code: u16, message: Option<&str>, groups: Vec<Group>) -> Vec<u8> {
        let mut op_attrs = vec![
            Attr::new("attributes-charset", vec![Value::Charset("utf-8".into())]),
            Attr::new("attributes-natural-language", vec![Value::Language("en".into())]),
        ];
        if let Some(text) = message {
            op_attrs.push(Attr::new("status-message", vec![Value::Text(text.to_string())]));
        }
        let mut all = vec![Group {
            tag: tag::OPERATION,
            attrs: op_attrs,
        }];
        all.extend(groups);
        let version = if matches!(request.version.0, 1 | 2) {
            request.version
        } else {
            (1, 1)
        };
        encode(&Message {
            version,
            code,
            request_id: request.request_id,
            groups: all,
        })
    }

    fn refuse(&self, request: &Message, code: u16, message: &str) -> Vec<u8> {
        self.response(request, code, Some(message), Vec::new())
    }

    /// The requester, when it is the user this printer belongs to.
    fn authorize(&self, request: &Message) -> Result<String, Vec<u8>> {
        match request.op_text("requesting-user-name") {
            Some(user) if user == self.user => Ok(user.to_string()),
            _ => Err(self.refuse(
                request,
                status::NOT_AUTHORIZED,
                "This printer accepts jobs only from the user it belongs to.",
            )),
        }
    }

    fn check_format(&self, request: &Message) -> Result<(), Vec<u8>> {
        match request.op_text("document-format") {
            None | Some("application/pdf") | Some("application/octet-stream") => Ok(()),
            Some(other) => Err(self.refuse(
                request,
                status::FORMAT_NOT_SUPPORTED,
                &format!("The document format {other} is not supported; send application/pdf."),
            )),
        }
    }

    fn now(&self) -> i32 {
        self.up_time()
    }

    fn new_job(&self, request: &Message, user: String) -> Result<Job, Vec<u8>> {
        let mut jobs = self.jobs.lock().map_err(|_| self.refuse(request, status::INTERNAL, "job table unusable"))?;
        let active = jobs.iter().filter(|j| j.state < job_state::CANCELED).count();
        if active >= MAX_CONCURRENT_JOBS {
            return Err(self.refuse(request, status::BUSY, "Too many jobs are in progress."));
        }
        let job = Job {
            id: self.next_job.fetch_add(1, Ordering::SeqCst),
            state: job_state::PENDING,
            reasons: "job-incoming",
            message: String::new(),
            name: request.op_text("job-name").unwrap_or("Untitled").chars().take(255).collect(),
            user,
            created: self.now(),
            completed: None,
            documents: 0,
        };
        jobs.push_back(job.clone());
        while jobs.len() > MAX_JOBS_KEPT {
            match jobs.iter().position(|j| j.state >= job_state::CANCELED) {
                Some(at) => {
                    jobs.remove(at);
                }
                None => break,
            }
        }
        Ok(job)
    }

    fn update_job(&self, id: i32, change: impl FnOnce(&mut Job)) -> Option<Job> {
        let mut jobs = self.jobs.lock().ok()?;
        let job = jobs.iter_mut().find(|j| j.id == id)?;
        change(job);
        Some(job.clone())
    }

    fn find_job(&self, request: &Message) -> Result<Job, Vec<u8>> {
        let id = request
            .op_integer("job-id")
            .or_else(|| {
                request
                    .op_text("job-uri")
                    .and_then(|uri| uri.rsplit('/').next())
                    .and_then(|tail| tail.parse().ok())
            })
            .ok_or_else(|| self.refuse(request, status::BAD_REQUEST, "The request names no job."))?;
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.iter().find(|j| j.id == id).cloned())
            .ok_or_else(|| self.refuse(request, status::NOT_FOUND, "No such job."))
    }

    /// Stream the document to its reserved name, then hand it over.
    fn receive(&self, mut body: &mut dyn Read) -> Result<Delivery, (u16, String)> {
        private_dir(&self.dir)
            .map_err(|e| (status::INTERNAL, format!("cannot create the printed-jobs folder: {e}")))?;
        let pdf_path = reserve_pdf(&self.dir, &timestamp_name())
            .map_err(|e| (status::INTERNAL, format!("cannot name the printed file: {e}")))?;
        let part = part_path(&pdf_path);
        let release = |what: (u16, String)| {
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&pdf_path);
            what
        };
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part)
            .map_err(|e| release((status::INTERNAL, format!("cannot stage the printed file: {e}"))))?;
        let count = copy_job(&mut body, &mut file, MAX_JOB_BYTES, MAX_JOB_RECEIVE_DURATION)
            .map_err(|e| release((status::INTERNAL, format!("could not receive the job: {e}"))))?;
        if count > MAX_JOB_BYTES {
            return Err(release((
                status::ENTITY_TOO_LARGE,
                format!("the job is over the {MAX_JOB_BYTES}-byte limit"),
            )));
        }
        if let Err(e) = file.flush().and_then(|()| file.sync_all()) {
            return Err(release((status::INTERNAL, format!("could not store the job: {e}"))));
        }
        drop(file);
        if count == 0 {
            release((status::OK, String::new()));
            return Ok(Delivery::Empty);
        }
        if !starts_as_pdf(&part) {
            return Err(release((status::FORMAT_ERROR, "the job is not a PDF document".to_string())));
        }
        std::fs::rename(&part, &pdf_path)
            .map_err(|e| release((status::INTERNAL, format!("could not finalize the printed file: {e}"))))?;
        Ok(Delivery::Delivered(pdf_path))
    }

    /// Receive one document of a job and settle the job's state.
    fn document(&self, request: &Message, job: &Job, body: &mut dyn Read, last: bool) -> Vec<u8> {
        self.update_job(job.id, |j| {
            j.state = job_state::PROCESSING;
            j.reasons = "job-printing";
        });
        self.receiving.fetch_add(1, Ordering::SeqCst);
        let outcome = self.receive(body);
        self.receiving.fetch_sub(1, Ordering::SeqCst);
        match outcome {
            Ok(delivery) => {
                if let Delivery::Delivered(path) = delivery {
                    (self.deliver)(path);
                }
                let settled = self.update_job(job.id, |j| {
                    j.documents += 1;
                    if last {
                        j.state = job_state::COMPLETED;
                        j.reasons = "job-completed-successfully";
                        j.completed = Some(self.up_time());
                    } else {
                        j.state = job_state::PENDING;
                        j.reasons = "job-incoming";
                    }
                });
                let attrs = settled.map(|j| self.job_attributes(&j)).unwrap_or_default();
                self.response(request, status::OK, None, vec![Group { tag: tag::JOB, attrs }])
            }
            Err((code, message)) => {
                (self.record_error)(message.clone());
                self.update_job(job.id, |j| {
                    j.state = job_state::ABORTED;
                    j.reasons = "aborted-by-system";
                    j.message = message.clone();
                    j.completed = Some(self.up_time());
                });
                self.refuse(request, code, &message)
            }
        }
    }

    /// Answer one IPP request. `body` is positioned after the HTTP head.
    pub(super) fn handle(&self, body: &mut dyn Read) -> Vec<u8> {
        let request = match decode(body) {
            Ok(message) => message,
            Err(_) => {
                let empty = Message {
                    version: (1, 1),
                    code: 0,
                    request_id: 0,
                    groups: Vec::new(),
                };
                return self.refuse(&empty, status::BAD_REQUEST, "The request could not be read.");
            }
        };
        if !matches!(request.version.0, 1 | 2) {
            return self.refuse(&request, status::VERSION_NOT_SUPPORTED, "IPP 1.1 and 2.0 are supported.");
        }
        match request.code {
            op::GET_PRINTER_ATTRIBUTES => {
                let attrs = filter_requested(&request, self.printer_attributes());
                self.response(&request, status::OK, None, vec![Group { tag: tag::PRINTER, attrs }])
            }
            op::VALIDATE_JOB => match self.authorize(&request).and_then(|_| self.check_format(&request)) {
                Ok(()) => self.response(&request, status::OK, None, Vec::new()),
                Err(refusal) => refusal,
            },
            op::PRINT_JOB => {
                let user = match self.authorize(&request) {
                    Ok(user) => user,
                    Err(refusal) => return refusal,
                };
                if let Err(refusal) = self.check_format(&request) {
                    return refusal;
                }
                match self.new_job(&request, user) {
                    Ok(job) => self.document(&request, &job, body, true),
                    Err(refusal) => refusal,
                }
            }
            op::CREATE_JOB => {
                let user = match self.authorize(&request) {
                    Ok(user) => user,
                    Err(refusal) => return refusal,
                };
                match self.new_job(&request, user) {
                    Ok(job) => {
                        let attrs = self.job_attributes(&job);
                        self.response(&request, status::OK, None, vec![Group { tag: tag::JOB, attrs }])
                    }
                    Err(refusal) => refusal,
                }
            }
            op::SEND_DOCUMENT => {
                let user = match self.authorize(&request) {
                    Ok(user) => user,
                    Err(refusal) => return refusal,
                };
                if let Err(refusal) = self.check_format(&request) {
                    return refusal;
                }
                let job = match self.find_job(&request) {
                    Ok(job) => job,
                    Err(refusal) => return refusal,
                };
                if job.user != user {
                    return self.refuse(&request, status::NOT_AUTHORIZED, "The job belongs to another user.");
                }
                if job.state != job_state::PENDING {
                    return self.refuse(&request, status::NOT_POSSIBLE, "The job is not accepting documents.");
                }
                let last = request.op_boolean("last-document").unwrap_or(true);
                self.document(&request, &job, body, last)
            }
            op::CANCEL_JOB => {
                let job = match self.find_job(&request) {
                    Ok(job) => job,
                    Err(refusal) => return refusal,
                };
                if self.authorize(&request).map(|u| u != job.user).unwrap_or(true) {
                    return self.refuse(&request, status::NOT_AUTHORIZED, "The job belongs to another user.");
                }
                if job.state >= job_state::CANCELED {
                    return self.refuse(&request, status::NOT_POSSIBLE, "The job has already finished.");
                }
                self.update_job(job.id, |j| {
                    j.state = job_state::CANCELED;
                    j.reasons = "job-canceled-by-user";
                    j.completed = Some(self.up_time());
                });
                self.response(&request, status::OK, None, Vec::new())
            }
            op::GET_JOB_ATTRIBUTES => match self.find_job(&request) {
                Ok(job) => {
                    let attrs = self.job_attributes(&job);
                    self.response(&request, status::OK, None, vec![Group { tag: tag::JOB, attrs }])
                }
                Err(refusal) => refusal,
            },
            op::GET_JOBS => {
                let which = request.op_text("which-jobs").unwrap_or("not-completed").to_string();
                let jobs: Vec<Job> = self
                    .jobs
                    .lock()
                    .map(|jobs| jobs.iter().cloned().collect())
                    .unwrap_or_default();
                let groups = jobs
                    .iter()
                    .filter(|j| match which.as_str() {
                        "completed" => j.state >= job_state::CANCELED,
                        "all" => true,
                        _ => j.state < job_state::CANCELED,
                    })
                    .map(|j| Group {
                        tag: tag::JOB,
                        attrs: self.job_attributes(j),
                    })
                    .collect();
                self.response(&request, status::OK, None, groups)
            }
            _ => self.refuse(&request, status::OPERATION_NOT_SUPPORTED, "The operation is not supported."),
        }
    }
}

/// The attributes a Get-Printer-Attributes request asked for. `all` and the
/// group names return everything (RFC 8011 section 4.2.5.1).
fn filter_requested(request: &Message, attrs: Vec<Attr>) -> Vec<Attr> {
    let Some(requested) = request.attr(tag::OPERATION, "requested-attributes") else {
        return attrs;
    };
    let names: Vec<&str> = requested.values.iter().filter_map(Value::text).collect();
    if names
        .iter()
        .any(|n| matches!(*n, "all" | "printer-description" | "job-template"))
    {
        return attrs;
    }
    attrs
        .into_iter()
        .filter(|a| names.contains(&a.name.as_str()))
        .collect()
}

fn starts_as_pdf(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::with_capacity(1024);
    if file.take(1024).read_to_end(&mut head).is_err() {
        return false;
    }
    head.windows(5).any(|w| w == b"%PDF-")
}

/// One client connection: requests until it closes, idles out, or errs.
pub(super) fn serve_connection(stream: TcpStream, printer: &IppPrinter) {
    let _ = stream.set_read_timeout(Some(READ_IDLE_TIMEOUT));
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut writer = stream;
    loop {
        let head = match read_head(&mut reader) {
            Ok(Some(head)) => head,
            _ => return,
        };
        let close = !head.keep_alive();
        if head
            .header("expect")
            .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
            && writer.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").is_err()
        {
            return;
        }
        let path = head.target.split('?').next().unwrap_or("");
        let result = match head.method.as_str() {
            "POST" if path == RESOURCE || path.starts_with(&format!("{RESOURCE}/")) => {
                let is_ipp = head
                    .header("content-type")
                    .is_some_and(|ct| ct.to_ascii_lowercase().starts_with("application/ipp"));
                let encoded = head
                    .header("content-encoding")
                    .is_some_and(|ce| !ce.eq_ignore_ascii_case("identity"));
                let mut body = match Body::new(&mut reader, &head) {
                    Ok(body) => body,
                    Err(_) => return,
                };
                if !is_ipp || encoded {
                    let _ = body.drain();
                    write_response(&mut writer, "415 Unsupported Media Type", None, &[], close)
                } else {
                    let response = printer.handle(&mut body);
                    if body.drain().is_err() {
                        let _ = write_response(&mut writer, "200 OK", Some("application/ipp"), &response, true);
                        return;
                    }
                    write_response(&mut writer, "200 OK", Some("application/ipp"), &response, close)
                }
            }
            "OPTIONS" => {
                let mut body = match Body::new(&mut reader, &head) {
                    Ok(body) => body,
                    Err(_) => return,
                };
                let _ = body.drain();
                writer
                    .write_all(b"HTTP/1.1 200 OK\r\nAllow: OPTIONS, POST\r\nContent-Length: 0\r\n\r\n")
                    .and_then(|()| writer.flush())
            }
            _ => {
                let mut body = match Body::new(&mut reader, &head) {
                    Ok(body) => body,
                    Err(_) => return,
                };
                let _ = body.drain();
                write_response(&mut writer, "404 Not Found", None, &[], close)
            }
        };
        if result.is_err() || close {
            return;
        }
    }
}

/// The accept loop. Connections are served on their own threads, bounded by
/// the same in-flight cap as the Windows receiver.
pub(super) fn serve(listener: TcpListener, printer: Arc<IppPrinter>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if !printer.admits(peer_uid(&stream)) {
            let _ = write_response(&mut &stream, "403 Forbidden", None, &[], true);
            continue;
        }
        if IN_FLIGHT.load(Ordering::Relaxed) >= MAX_CONCURRENT_JOBS {
            let _ = write_response(&mut &stream, "503 Service Unavailable", None, &[], true);
            continue;
        }
        IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
        let printer = printer.clone();
        std::thread::spawn(move || {
            let _slot = JobSlot;
            serve_connection(stream, &printer);
        });
    }
}

// ── the app wiring ──────────────────────────────────────────────────────────

fn record(app: &AppHandle, message: String) {
    eprintln!("virtual printer: {message}");
    if let Some(state) = app.try_state::<PrinterState>() {
        *state.last_job_error.lock().unwrap() = message;
    }
}

/// Start the loopback printer. Never panics: a taken port or an unknown user
/// becomes the named status the Settings block shows.
pub(super) fn start_listener(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let set_status = |status: String| {
            if let Some(state) = handle.try_state::<PrinterState>() {
                *state.listener_status.lock().unwrap() = status;
            }
        };
        let Some(user) = current_user() else {
            set_status("the current user has no entry in the password database".to_string());
            return;
        };
        let port = own_port();
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => l,
            Err(e) => {
                set_status(format!("port {port} is unavailable: {e}"));
                return;
            }
        };
        let dir = super::printed_dir();
        reclaim_job_intermediates(&dir);
        set_status("listening".to_string());
        let delivering = handle.clone();
        let failing = handle.clone();
        let printer = Arc::new(IppPrinter::new(
            port,
            user,
            dir,
            Box::new(move |path: PathBuf| {
                if let Some(state) = delivering.try_state::<PrinterState>() {
                    state.last_job_error.lock().unwrap().clear();
                }
                let canonical = crate::commands::canonical_path(&path.to_string_lossy());
                crate::app_windows::route_open(&delivering, vec![canonical], false);
            }),
            Box::new(move |message: String| record(&failing, message)),
        ));
        serve(listener, printer);
    });
}

/// What the print system holds under this user's queue name.
#[derive(Debug, PartialEq)]
pub(super) enum QueueState {
    Absent,
    Ours,
    /// A queue with the name exists and points somewhere else.
    Foreign(String),
}

fn queue_state(queue: &str, uri: &str) -> Result<QueueState, String> {
    let cups = crate::cups_linux::cups()?;
    let dests = cups.destinations()?;
    let Some(dest) = dests.iter().find(|d| crate::cups_linux::display_name(d) == queue) else {
        return Ok(QueueState::Absent);
    };
    match cups.option(dest, "device-uri") {
        Some(found) if found == uri => Ok(QueueState::Ours),
        Some(found) => Ok(QueueState::Foreign(found)),
        None => Ok(QueueState::Foreign(String::new())),
    }
}

pub(super) fn status(app: &AppHandle) -> Result<VirtualPrinterStatus, String> {
    let user = current_user()
        .ok_or_else(|| "The current user has no entry in the password database.".to_string())?;
    let queue = queue_name(&user);
    let installed = matches!(queue_state(&queue, &queue_uri(own_port())), Ok(QueueState::Ours));
    let state = app.state::<PrinterState>();
    let listener = state.listener_status.lock().unwrap().clone();
    let last_job_error = state.last_job_error.lock().unwrap().clone();
    Ok(VirtualPrinterStatus {
        installed,
        listener,
        last_job_error,
        printer_name: queue,
    })
}

/// lpadmin's arguments that add this user's queue.
pub(super) fn install_args(queue: &str, uri: &str, user: &str) -> Vec<String> {
    vec![
        "-p".into(),
        queue.into(),
        "-D".into(),
        DESCRIPTION.into(),
        "-L".into(),
        "This computer".into(),
        "-v".into(),
        uri.into(),
        "-m".into(),
        "everywhere".into(),
        "-o".into(),
        "printer-is-shared=false".into(),
        "-o".into(),
        "printer-error-policy=abort-job".into(),
        "-u".into(),
        format!("allow:{user}"),
        "-E".into(),
    ]
}

pub(super) fn remove_args(queue: &str) -> Vec<String> {
    vec!["-x".into(), queue.into()]
}

/// A system program from the system directories only. `$PATH` is never
/// consulted: the program may run as root through pkexec.
fn find_program(name: &str) -> Option<PathBuf> {
    ["/usr/sbin", "/usr/bin"]
        .iter()
        .map(|dir| Path::new(dir).join(name))
        .find(|p| p.is_file())
}

/// A shell-ready rendering of a command, for the administrator refusal.
pub(super) fn shell_line(program: &Path, args: &[String]) -> String {
    let quote = |s: &str| {
        if !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c))
        {
            s.to_string()
        } else {
            format!("'{}'", s.replace('\'', "'\\''"))
        }
    };
    std::iter::once(quote(&program.to_string_lossy()))
        .chain(args.iter().map(|a| quote(a)))
        .collect::<Vec<_>>()
        .join(" ")
}

struct Ran {
    code: Option<i32>,
    output: String,
}

/// Run a program with no controlling terminal and the C locale, so no
/// password prompt can appear on a terminal the app was started from and its
/// messages are the untranslated ones.
fn run_detached(program: &Path, args: &[String]) -> Result<Ran, String> {
    use std::os::unix::process::CommandExt;
    let mut command = Command::new(program);
    command
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not run {}: {e}", program.display()))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(64 * 1024).read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = Instant::now() + LPADMIN_TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break exit,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{} did not finish in time.", program.display()));
            }
            Err(e) => return Err(format!("{} could not be waited for: {e}", program.display())),
        }
    };
    let stdout = String::from_utf8_lossy(&stdout.join().unwrap_or_default()).trim().to_string();
    let stderr = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).trim().to_string();
    Ok(Ran {
        code: exit.code(),
        output: if stderr.is_empty() { stdout } else { stderr },
    })
}

/// Did the scheduler refuse for lack of administrative rights?
pub(super) fn refused_for_rights(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    ["forbidden", "unauthorized", "not authorized", "authentication", "password"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// The pkexec outcome for one exit code (pkexec(1): 126 means the
/// authorization was dismissed or could not be obtained, 127 means the
/// authentication failed or no agent was available).
pub(super) fn pkexec_refusal(code: Option<i32>, output: &str, manual: &str) -> Option<String> {
    match code {
        Some(0) => None,
        Some(126) => Some("The administrator prompt was declined — the printer was not changed.".to_string()),
        Some(127) => Some(format!(
            "No administrator prompt is available on this desktop. Ask an administrator to run: {manual}"
        )),
        _ => Some(if output.is_empty() {
            "The print system did not accept the change.".to_string()
        } else {
            output.to_string()
        }),
    }
}

/// Run lpadmin as the user, then through pkexec when the scheduler refuses
/// for lack of rights.
fn administer(args: Vec<String>) -> Result<(), String> {
    let lpadmin = find_program("lpadmin").ok_or_else(|| {
        "The CUPS administration tool (lpadmin) is not installed, so the printer cannot be changed."
            .to_string()
    })?;
    let manual = shell_line(&lpadmin, &args);
    let direct = run_detached(&lpadmin, &args)?;
    if direct.code == Some(0) {
        return Ok(());
    }
    if !refused_for_rights(&direct.output) {
        return Err(if direct.output.is_empty() {
            "The print system did not accept the change.".to_string()
        } else {
            direct.output
        });
    }
    let Some(pkexec) = find_program("pkexec") else {
        return Err(format!(
            "Changing printers needs administrator rights, and no administrator prompt (pkexec) is installed. Ask an administrator to run: {manual}"
        ));
    };
    let mut elevated = vec![lpadmin.to_string_lossy().into_owned()];
    elevated.extend(args);
    let ran = run_detached(&pkexec, &elevated)?;
    match pkexec_refusal(ran.code, &ran.output, &manual) {
        None => Ok(()),
        Some(message) => Err(message),
    }
}

pub(super) fn install(app: &AppHandle) -> Result<(), String> {
    let user = current_user()
        .ok_or_else(|| "The current user has no entry in the password database.".to_string())?;
    let listener = app.state::<PrinterState>().listener_status.lock().unwrap().clone();
    if listener != "listening" {
        return Err(format!(
            "The printer cannot be added while its receiver is down ({listener})."
        ));
    }
    let queue = queue_name(&user);
    let uri = queue_uri(own_port());
    match queue_state(&queue, &uri)? {
        QueueState::Ours => return Ok(()),
        QueueState::Foreign(_) => {
            return Err(format!(
                "A different printer already uses the name {queue}; it was not changed."
            ))
        }
        QueueState::Absent => {}
    }
    administer(install_args(&queue, &uri, &user))?;
    match queue_state(&queue, &uri)? {
        QueueState::Ours => Ok(()),
        _ => Err("The printer was added but could not be verified.".to_string()),
    }
}

pub(super) fn uninstall() -> Result<(), String> {
    let user = current_user()
        .ok_or_else(|| "The current user has no entry in the password database.".to_string())?;
    let queue = queue_name(&user);
    match queue_state(&queue, &queue_uri(own_port()))? {
        QueueState::Absent => Ok(()),
        QueueState::Foreign(_) => Err(format!(
            "A different printer already uses the name {queue}; it was not removed."
        )),
        QueueState::Ours => administer(remove_args(&queue)),
    }
}

#[cfg(test)]
#[path = "print_to_pdf_linux_tests.rs"]
mod tests;
