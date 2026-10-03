//! The virtual printer on Linux: a per-user CUPS queue that holds every job.
//!
//! The queue `Spectra-PDF-<user>` is configured so that no job printed to it
//! is processed or sent anywhere:
//!
//! - `job-hold-until-default=indefinite`: a job that names no hold time is
//!   'pending-held' until a Release-Job (RFC 8011 sections 5.2.2 and 5.3.7).
//! - the queue is stopped (`printer-state` 5): a released job, or one that
//!   asks for 'no-hold', stays 'pending' (RFC 8011 section 5.3.8).
//! - the device URI is `file:///dev/null`, which cups-files.conf(5) allows
//!   whatever `FileDevice` says: a job processed anyway reaches nobody.
//! - `printer-op-policy=authenticated`, a policy of the stock cupsd.conf:
//!   job creation and the job operations need an authenticated user, so a
//!   `requesting-user-name` alone neither submits as the owner nor cancels,
//!   releases or moves the owner's job. `-u allow:` admits the owner alone.
//!
//! No process listens. This process lists its own jobs (Get-Jobs with
//! `my-jobs`, RFC 8011 section 4.2.6), copies each document out of the spool
//! (CUPS-Get-Document, CUPS IPP extensions), stages it privately and records
//! the job in a durable ledger, then cancels it with `purge-job`, which
//! removes the job's files and history. A job whose cancel fails is never
//! taken twice, and delivery records each PDF before the PDF takes its final
//! name. A PDF document opens as received; a PostScript document goes through
//! the CLI `distill` arm; text and images, and any job with layout options
//! (number-up, order, page selection, scaling, mirror), go through the CLI
//! `printed-job` arm, since a held job never passes through the CUPS filters.
//!
//! Requests travel through libcups (`cupsDoIORequest`), which reaches the
//! scheduler over its local socket and answers an authentication challenge
//! with the socket's peer credentials (cups-files.conf(5) `PeerCred`).
//!
//! Adding, changing or removing the queue is a scheduler administration
//! operation. `lpadmin` runs first as the user, which the scheduler
//! authorizes for members of its system group; when the scheduler refuses,
//! the same command runs through `pkexec`, a visible polkit prompt. Nothing
//! elevates silently; without pkexec or a polkit agent, the refusal names the
//! exact command an administrator runs.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, CStr};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::{
    open_printed, part_path, reclaim_job_intermediates, reserve_pdf, run_cli_conversion, JobReport, JobSlot,
    PrinterState, VirtualPrinterStatus, IN_FLIGHT, MAX_CONCURRENT_JOBS, MAX_JOB_BYTES,
    PRINTED_PREFIX,
};

/// What a print dialog shows for the queue (`printer-info`).
const DESCRIPTION: &str = "Spectra PDF";
const MAKE_AND_MODEL: &str = "Spectra PDF Virtual Printer";
/// Queue names are at most 127 bytes (lpadmin(8)).
const MAX_QUEUE_NAME: usize = 127;
const LPADMIN_TIMEOUT: Duration = Duration::from_secs(120);

/// The device URI of every held queue: the one file device path that needs
/// no `FileDevice` setting (cups-files.conf(5)).
pub(super) const SINK_URI: &str = "file:///dev/null";
const HELD_OP_POLICY: &str = "authenticated";
const HOLD_INDEFINITE: &str = "indefinite";
const ERROR_POLICY: &str = "stop-printer";
/// `printer-state` 'stopped' (RFC 8011 section 5.4.11).
const PRINTER_STOPPED: i32 = 5;
/// The queue's location when the app passes none.
const DEFAULT_LOCATION: &str = "Held for Spectra PDF; jobs open in the app";
/// `printer-location` is text(127) (RFC 8011 section 5.4.5).
const MAX_LOCATION_CHARS: usize = 127;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const CLAIM_RETRY: Duration = Duration::from_secs(5);
/// A job that keeps failing is named at its first failure and left alone
/// after this many passes.
const MAX_READ_ATTEMPTS: u32 = 3;
/// A listing this long may be cut short, so it never prunes the ledger; the
/// jobs beyond it are taken once earlier ones are cancelled.
const MAX_JOBS_PER_PASS: usize = 1000;
/// Staged names carry the document number in three digits.
const MAX_DOCUMENTS: u32 = 999;
/// The attribute section of one response from the scheduler.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

const PRINTER_DIR: &str = "virtual-printer";
const STAGING_DIR: &str = "staging";
const LEDGER_DIR: &str = "ledger";
const LOCK_FILE: &str = "receiver.lock";
const PART_SUFFIX: &str = ".part";
/// A document while CUPS-Get-Document copies it; never counted as staged.
const DOWNLOAD_SUFFIX: &str = ".download";
/// A gzip-compressed document while it is expanded; never counted as staged.
const EXPANDED_SUFFIX: &str = ".expanded";
/// Ledger entry: every document of the job is staged, so the job is never
/// read again while its queue lists it. The content is the queue's name.
const TAKEN_SUFFIX: &str = ".taken";
/// A ledger entry before its rename into place; never counts as an entry.
const ENTRY_TEMP_SUFFIX: &str = ".new";
/// Ledger entry: the file name of a staged document's printed PDF, written
/// before the PDF takes that name.
const DELIVERED_SUFFIX: &str = ".delivered";
/// Ledger entry: how many deliveries of a staged document failed for a
/// reason that was not its own bytes.
const ATTEMPTS_SUFFIX: &str = ".attempts";
/// A staged document whose delivery fails this many times, across restarts,
/// is removed: a job that always exhausts its time or memory budget never
/// reaches the converter's refusal, and would otherwise be retried at every
/// start.
pub(super) const MAX_DELIVERY_ATTEMPTS: u32 = 3;
/// Beside a staged document: the job's layout options, applied at delivery.
const LAYOUT_SUFFIX: &str = ".layout";

pub(super) const HELD_ELSEWHERE: &str =
    "another Spectra PDF window of this account is receiving the printer's jobs";
const SERVICE_UNAVAILABLE: &str = "the print system is not available";

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

/// The scheduler's URI for a local queue.
pub(super) fn printer_uri(queue: &str) -> String {
    format!("ipp://localhost/printers/{queue}")
}

/// A queue of the releases that delivered jobs to this app over loopback
/// TCP: `ipp://127.0.0.1:<port>/ipp/print`, with or without `contimeout`.
pub(super) fn is_legacy_uri(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("ipp://127.0.0.1:") else {
        return false;
    };
    let path = rest.split('?').next().unwrap_or("");
    let Some((port, resource)) = path.split_once('/') else {
        return false;
    };
    !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) && resource == "ipp/print"
}

/// The queue's location: display text from the app without control
/// characters, cut to its bound; the English text when nothing is left.
pub(super) fn queue_location(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LOCATION_CHARS)
        .collect();
    let kept = kept.trim();
    if kept.is_empty() {
        DEFAULT_LOCATION.to_string()
    } else {
        kept.to_string()
    }
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

fn session_locale() -> String {
    ["LC_ALL", "LC_PAPER", "LANG"]
        .iter()
        .filter_map(|v| std::env::var(v).ok())
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

// ── folders ─────────────────────────────────────────────────────────────────

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
    use std::os::unix::fs::DirBuilderExt;
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

/// The receiver's private folder: staged documents, the ledger and the
/// receiver lock, under `$XDG_STATE_HOME/com.spectrapdf.app`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Layout {
    pub root: PathBuf,
    pub staging: PathBuf,
    pub ledger: PathBuf,
    pub lock: PathBuf,
}

impl Layout {
    pub fn under(state_home: &Path) -> Self {
        let root = state_home
            .join(crate::portable::APP_IDENTIFIER)
            .join(PRINTER_DIR);
        Self {
            staging: root.join(STAGING_DIR),
            ledger: root.join(LEDGER_DIR),
            lock: root.join(LOCK_FILE),
            root,
        }
    }

    fn current() -> Option<Self> {
        crate::portable::xdg_state_home().map(|home| Self::under(&home))
    }
}

pub(super) fn prepare(layout: &Layout) -> Result<(), String> {
    for dir in [&layout.root, &layout.staging, &layout.ledger] {
        private_dir(dir).map_err(|e| format!("cannot prepare {}: {e}", dir.display()))?;
    }
    Ok(())
}

#[derive(Debug)]
pub(super) enum ClaimFailure {
    HeldElsewhere,
    Failed(String),
}

/// An exclusive `flock` on the lock file for the receiver's life, so a second
/// receiver of the same account is refused.
pub(super) struct ReceiverClaim {
    _file: File,
}

pub(super) fn claim_receiver(lock: &Path) -> Result<ReceiverClaim, ClaimFailure> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(lock)
        .map_err(|e| ClaimFailure::Failed(format!("cannot hold {}: {e}", lock.display())))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let e = io::Error::last_os_error();
        return Err(if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
            ClaimFailure::HeldElsewhere
        } else {
            ClaimFailure::Failed(format!("cannot hold {}: {e}", lock.display()))
        });
    }
    Ok(ReceiverClaim { _file: file })
}

// ── IPP encoding (RFC 8010) ─────────────────────────────────────────────────

pub(super) mod tag {
    pub const OPERATION: u8 = 0x01;
    pub const JOB: u8 = 0x02;
    pub const END: u8 = 0x03;
    pub const PRINTER: u8 = 0x04;

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

/// Status codes (RFC 8011 section 4.1.6 and appendix B).
pub(super) mod status {
    pub const OK: u16 = 0x0000;
    pub const BAD_REQUEST: u16 = 0x0400;
    pub const FORBIDDEN: u16 = 0x0401;
    pub const NOT_AUTHENTICATED: u16 = 0x0402;
    pub const NOT_AUTHORIZED: u16 = 0x0403;
    pub const NOT_POSSIBLE: u16 = 0x0404;
    pub const NOT_FOUND: u16 = 0x0406;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x0501;
}

pub(super) mod op {
    pub const CANCEL_JOB: u16 = 0x0008;
    pub const GET_JOB_ATTRIBUTES: u16 = 0x0009;
    pub const GET_JOBS: u16 = 0x000A;
    pub const GET_PRINTER_ATTRIBUTES: u16 = 0x000B;
    /// CUPS IPP extensions.
    pub const CUPS_GET_PRINTERS: u16 = 0x4002;
    pub const CUPS_GET_DOCUMENT: u16 = 0x4027;
}

/// `job-state` (RFC 8011 section 5.3.7).
pub(super) mod job_state {
    pub const PENDING: i32 = 3;
    pub const HELD: i32 = 4;
    pub const PROCESSING: i32 = 5;
    pub const STOPPED: i32 = 6;
    pub const CANCELED: i32 = 7;
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
    pub fn text(&self) -> Option<&str> {
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

    pub fn integer(&self) -> Option<i32> {
        match self {
            Value::Integer(i) | Value::Enum(i) => Some(*i),
            _ => None,
        }
    }

    pub fn boolean(&self) -> Option<bool> {
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
    pub fn new(name: &str, values: Vec<Value>) -> Self {
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
    pub fn attr(&self, group: u8, name: &str) -> Option<&Attr> {
        self.groups
            .iter()
            .filter(|g| g.tag == group)
            .flat_map(|g| g.attrs.iter())
            .find(|a| a.name == name)
    }

    /// The first attribute of that name in any group.
    pub fn any_attr(&self, name: &str) -> Option<&Attr> {
        self.groups
            .iter()
            .flat_map(|g| g.attrs.iter())
            .find(|a| a.name == name)
    }

    pub fn op_text(&self, name: &str) -> Option<&str> {
        self.attr(tag::OPERATION, name)
            .and_then(|a| a.values.first())
            .and_then(Value::text)
    }

    pub fn op_integer(&self, name: &str) -> Option<i32> {
        self.attr(tag::OPERATION, name)
            .and_then(|a| a.values.first())
            .and_then(Value::integer)
    }
}

fn bad(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

/// Reads the attribute section through a budget, so a message cannot make
/// this process buffer more than its limit.
struct Budget<'a, R: Read + ?Sized> {
    inner: &'a mut R,
    left: usize,
}

impl<R: Read + ?Sized> Budget<'_, R> {
    fn bytes(&mut self, n: usize) -> io::Result<Vec<u8>> {
        if n > self.left {
            return Err(bad("the message's attributes exceed the size limit"));
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

/// Decode one IPP message's header and attribute section, buffering at most
/// `limit` bytes. The reader is left at the first byte of the data, if any.
pub(super) fn decode_limited<R: Read + ?Sized>(reader: &mut R, limit: usize) -> io::Result<Message> {
    let mut r = Budget {
        inner: reader,
        left: limit,
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

pub(super) fn decode<R: Read + ?Sized>(reader: &mut R) -> io::Result<Message> {
    decode_limited(reader, MAX_RESPONSE_BYTES)
}

pub(super) fn put_item(out: &mut Vec<u8>, value_tag: u8, name: &str, value: &[u8]) {
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

// ── requests ────────────────────────────────────────────────────────────────

/// Each request is its own HTTP exchange, so one id serves them all.
const REQUEST_ID: u32 = 1;

/// The operation attributes every request starts with (RFC 8011 section
/// 4.1.4), then the rest in order.
fn request(operation: u16, rest: Vec<Attr>) -> Message {
    let mut attrs = vec![
        Attr::new("attributes-charset", vec![Value::Charset("utf-8".into())]),
        Attr::new("attributes-natural-language", vec![Value::Language("en".into())]),
    ];
    attrs.extend(rest);
    Message {
        version: (2, 0),
        code: operation,
        request_id: REQUEST_ID,
        groups: vec![Group {
            tag: tag::OPERATION,
            attrs,
        }],
    }
}

fn target(queue: &str) -> Attr {
    Attr::new("printer-uri", vec![Value::Uri(printer_uri(queue))])
}

fn requester(user: &str) -> Attr {
    Attr::new("requesting-user-name", vec![Value::Name(user.to_string())])
}

fn keywords(name: &str, list: &[&str]) -> Attr {
    Attr::new(name, list.iter().map(|k| Value::Keyword(k.to_string())).collect())
}

const QUEUE_ATTRIBUTES: &[&str] = &[
    "device-uri",
    "job-hold-until-default",
    "job-sheets-default",
    "printer-error-policy",
    "printer-is-accepting-jobs",
    "printer-is-shared",
    "printer-op-policy",
    "printer-state",
    "requesting-user-name-allowed",
    "requesting-user-name-denied",
];

const JOB_ATTRIBUTES: &[&str] = &[
    "job-id",
    "job-k-octets",
    "job-originating-user-name",
    "job-state",
    "job-state-reasons",
    "number-of-documents",
    "time-at-creation",
];

/// The job options the CUPS filters would apply. A held job never passes
/// through the filters, so delivery applies them. cupsd keeps every job
/// template attribute a client sends, named or not in the queue's PPD, and
/// Get-Job-Attributes returns those requested here. `outputorder` is the
/// CUPS name `lp -o outputorder=` sends; `output-order` and `page-delivery`
/// are the IPP names.
const LAYOUT_ATTRIBUTES: &[&str] = &[
    "fit-to-page",
    "media",
    "mirror",
    "number-up",
    "number-up-layout",
    "output-order",
    "outputorder",
    "page-delivery",
    "page-ranges",
    "page-set",
    "print-scaling",
    "scaling",
];

pub(super) fn printer_attributes_request(queue: &str, user: &str) -> Message {
    request(
        op::GET_PRINTER_ATTRIBUTES,
        vec![target(queue), requester(user), keywords("requested-attributes", QUEUE_ATTRIBUTES)],
    )
}

/// This user's jobs that are not finished (RFC 8011 section 4.2.6.1).
pub(super) fn get_jobs_request(queue: &str, user: &str) -> Message {
    request(
        op::GET_JOBS,
        vec![
            target(queue),
            requester(user),
            Attr::new("limit", vec![Value::Integer(MAX_JOBS_PER_PASS as i32)]),
            keywords("requested-attributes", JOB_ATTRIBUTES),
            Attr::new("which-jobs", vec![Value::Keyword("not-completed".into())]),
            Attr::new("my-jobs", vec![Value::Boolean(true)]),
        ],
    )
}

/// One job's layout options (RFC 8011 section 4.3.4).
pub(super) fn get_job_attributes_request(queue: &str, user: &str, job: i32) -> Message {
    request(
        op::GET_JOB_ATTRIBUTES,
        vec![
            target(queue),
            Attr::new("job-id", vec![Value::Integer(job)]),
            requester(user),
            keywords("requested-attributes", LAYOUT_ATTRIBUTES),
        ],
    )
}

/// One document of a job; its data follows the response.
pub(super) fn get_document_request(queue: &str, user: &str, job: i32, document: u32) -> Message {
    request(
        op::CUPS_GET_DOCUMENT,
        vec![
            target(queue),
            Attr::new("job-id", vec![Value::Integer(job)]),
            requester(user),
            Attr::new("document-number", vec![Value::Integer(document as i32)]),
        ],
    )
}

/// Cancel a job and remove its files and history (`purge-job`).
pub(super) fn cancel_job_request(queue: &str, user: &str, job: i32) -> Message {
    request(
        op::CANCEL_JOB,
        vec![
            target(queue),
            Attr::new("job-id", vec![Value::Integer(job)]),
            requester(user),
            Attr::new("purge-job", vec![Value::Boolean(true)]),
        ],
    )
}

pub(super) fn get_printers_request(user: &str) -> Message {
    request(
        op::CUPS_GET_PRINTERS,
        vec![requester(user), keywords("requested-attributes", &["printer-name"])],
    )
}

// ── responses ───────────────────────────────────────────────────────────────

/// The 'successful' status class, 0x0000 to 0x00FF (RFC 8011 appendix B).
fn succeeded(code: u16) -> bool {
    code < 0x0100
}

fn status_text(response: &Message) -> String {
    response
        .op_text("status-message")
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("IPP status {:#06x}", response.code))
}

fn texts(attrs: &[Attr], name: &str) -> Vec<String> {
    attrs
        .iter()
        .filter(|a| a.name == name)
        .flat_map(|a| a.values.iter())
        .filter_map(Value::text)
        .map(str::to_string)
        .collect()
}

fn first_text(attrs: &[Attr], name: &str) -> Option<String> {
    texts(attrs, name).into_iter().next()
}

fn first_integer(attrs: &[Attr], name: &str) -> Option<i32> {
    attrs
        .iter()
        .find(|a| a.name == name)
        .and_then(|a| a.values.first())
        .and_then(Value::integer)
}

fn first_boolean(attrs: &[Attr], name: &str) -> Option<bool> {
    attrs
        .iter()
        .find(|a| a.name == name)
        .and_then(|a| a.values.first())
        .and_then(Value::boolean)
}

/// What the scheduler reports about the queue with this user's name.
#[derive(Debug, Clone, PartialEq, Default)]
pub(super) struct QueueFacts {
    pub device_uri: String,
    pub hold_default: String,
    pub sheets: Vec<String>,
    pub error_policy: String,
    pub accepting: bool,
    pub shared: bool,
    pub op_policy: String,
    pub state: i32,
    pub allowed: Vec<String>,
    pub denied: Vec<String>,
}

/// The queue's facts, or none when no queue has the name.
pub(super) fn queue_facts_from(response: &Message) -> Result<Option<QueueFacts>, String> {
    if response.code == status::NOT_FOUND {
        return Ok(None);
    }
    if !succeeded(response.code) {
        return Err(status_text(response));
    }
    let attrs: Vec<Attr> = response
        .groups
        .iter()
        .filter(|g| g.tag == tag::PRINTER)
        .flat_map(|g| g.attrs.iter().cloned())
        .collect();
    Ok(Some(QueueFacts {
        device_uri: first_text(&attrs, "device-uri").unwrap_or_default(),
        hold_default: first_text(&attrs, "job-hold-until-default").unwrap_or_default(),
        sheets: texts(&attrs, "job-sheets-default"),
        error_policy: first_text(&attrs, "printer-error-policy").unwrap_or_default(),
        accepting: first_boolean(&attrs, "printer-is-accepting-jobs").unwrap_or(false),
        shared: first_boolean(&attrs, "printer-is-shared").unwrap_or(true),
        op_policy: first_text(&attrs, "printer-op-policy").unwrap_or_default(),
        state: first_integer(&attrs, "printer-state").unwrap_or(0),
        allowed: texts(&attrs, "requesting-user-name-allowed"),
        denied: texts(&attrs, "requesting-user-name-denied"),
    }))
}

/// What the queue with this user's name is.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum QueueKind {
    Absent,
    /// Holds this user's jobs with every protection in place.
    Held,
    /// This user's queue on the sink, with a protection gone.
    Drifted,
    /// The loopback-TCP queue of earlier releases.
    Legacy,
    /// Another printer, or another account's, uses the name.
    Foreign(String),
}

pub(super) fn classify(facts: Option<&QueueFacts>, user: &str) -> QueueKind {
    let Some(facts) = facts else {
        return QueueKind::Absent;
    };
    let only_user = facts.denied.is_empty()
        && facts.allowed.len() == 1
        && facts.allowed[0].eq_ignore_ascii_case(user);
    let no_list = facts.denied.is_empty() && facts.allowed.is_empty();
    let sink = facts.device_uri == SINK_URI || facts.device_uri == "file:/dev/null";
    if sink && only_user && facts.hold_default == HOLD_INDEFINITE && facts.op_policy == HELD_OP_POLICY {
        QueueKind::Held
    } else if sink && (only_user || no_list) {
        QueueKind::Drifted
    } else if is_legacy_uri(&facts.device_uri) && (only_user || no_list) {
        QueueKind::Legacy
    } else {
        QueueKind::Foreign(facts.device_uri.clone())
    }
}

/// The settings Install leaves beyond the held ones. The scheduler reports
/// `job-sheets-default` only when banner files are installed.
pub(super) fn fully_configured(facts: &QueueFacts) -> bool {
    !facts.shared
        && facts.state == PRINTER_STOPPED
        && facts.accepting
        && facts.error_policy == ERROR_POLICY
        && facts.sheets.iter().all(|sheet| sheet == "none")
}

/// What Get-Jobs reports about one job.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct JobFacts {
    pub id: i32,
    pub state: i32,
    pub reasons: Vec<String>,
    /// `time-at-creation`; the scheduler counts in seconds since the epoch.
    pub created: i64,
    pub documents: u32,
    pub k_octets: u64,
    /// Absent when the scheduler keeps it private (cupsd.conf(5)
    /// `JobPrivateValues`).
    pub owner: Option<String>,
}

pub(super) fn jobs_from(response: &Message) -> Result<Vec<JobFacts>, String> {
    if !succeeded(response.code) {
        return Err(status_text(response));
    }
    Ok(response
        .groups
        .iter()
        .filter(|g| g.tag == tag::JOB)
        .filter_map(|g| {
            let id = first_integer(&g.attrs, "job-id").filter(|id| *id > 0)?;
            Some(JobFacts {
                id,
                state: first_integer(&g.attrs, "job-state").unwrap_or(0),
                reasons: texts(&g.attrs, "job-state-reasons"),
                created: first_integer(&g.attrs, "time-at-creation").map_or(0, i64::from),
                documents: first_integer(&g.attrs, "number-of-documents")
                    .map_or(0, |n| n.max(0) as u32),
                k_octets: first_integer(&g.attrs, "job-k-octets").map_or(0, |k| k.max(0) as u64),
                owner: first_text(&g.attrs, "job-originating-user-name"),
            })
        })
        .collect())
}

/// Every document of a job is in the spool once the job stops being
/// 'job-incoming' (RFC 8011 section 5.3.8); a finished job has no future.
pub(super) fn job_is_complete(job: &JobFacts) -> bool {
    matches!(
        job.state,
        job_state::PENDING | job_state::HELD | job_state::PROCESSING | job_state::STOPPED
    ) && !job.reasons.iter().any(|reason| reason == "job-incoming")
}

/// `number-up` values the queue offers (cupsd's `number-up-supported`).
pub(super) const NUMBER_UP: &[i32] = &[1, 2, 4, 6, 9, 16];
/// `number-up-layout` keywords (CUPS IPP spec).
pub(super) const NUMBER_UP_LAYOUTS: &[&str] =
    &["lrtb", "lrbt", "rltb", "rlbt", "tblr", "tbrl", "btlr", "btrl"];
/// `page-set` keywords (CUPS job options).
pub(super) const PAGE_SETS: &[&str] = &["all", "odd", "even"];
/// The `print-scaling` keywords delivery applies; `none` is no scaling and
/// `auto` scales as `auto-fit` does.
pub(super) const PRINT_SCALINGS: &[&str] = &["fit", "fill", "auto-fit"];
/// The `scaling` percentages delivery applies.
pub(super) const SCALING_PERCENT: std::ops::RangeInclusive<i32> = 1..=800;
/// The page ranges one job may name; more is not laid out.
pub(super) const MAX_PAGE_RANGES: usize = 64;
/// The upper bound of a page range that runs through the last page: libcups
/// encodes `lp -P 3-` as `3-2147483647`.
pub(super) const OPEN_RANGE: i32 = i32::MAX;

/// The layout options of one job.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct JobLayout {
    pub number_up: i32,
    pub number_up_layout: String,
    pub reverse: bool,
    /// A media name of `[A-Za-z0-9._-]` only: a PWG 5101.1 name, a PPD
    /// size name or a `Custom.` size.
    pub media: Option<String>,
    /// One of `PAGE_SETS`.
    pub page_set: String,
    /// 1-based inclusive document page ranges; empty selects every page.
    pub page_ranges: Vec<(i32, i32)>,
    pub mirror: bool,
    /// One of `PRINT_SCALINGS`, or a percentage in `SCALING_PERCENT`.
    pub scaling: Option<String>,
    /// The attributes of the job that arrived with a value delivery does not
    /// apply, reported when the job is delivered.
    pub not_applied: Vec<String>,
    /// A text document's declared character set (`charset_of`); per document.
    pub charset: Option<String>,
}

impl Default for JobLayout {
    fn default() -> Self {
        Self {
            number_up: 1,
            number_up_layout: "lrtb".to_string(),
            reverse: false,
            media: None,
            page_set: "all".to_string(),
            page_ranges: Vec::new(),
            mirror: false,
            scaling: None,
            not_applied: Vec::new(),
            charset: None,
        }
    }
}

/// Whether a character-set name is safe to stage and pass on: an IANA name's
/// characters only.
pub(super) fn charset_is_valid(charset: &str) -> bool {
    !charset.is_empty()
        && charset.len() <= 40
        && charset
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' | b'+'))
}

/// The `charset` parameter of a document format, lower case; none when it
/// is absent. `Err` for a value outside an IANA name's characters.
pub(super) fn charset_of(format: &str) -> Result<Option<String>, ()> {
    for parameter in format.split(';').skip(1) {
        let Some((name, value)) = parameter.split_once('=') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("charset") {
            let value = value.trim().trim_matches('"').to_ascii_lowercase();
            return if charset_is_valid(&value) { Ok(Some(value)) } else { Err(()) };
        }
    }
    Ok(None)
}

/// Whether a text document's bytes are two or four bytes per character: a
/// UTF-16 or UTF-32 byte order mark, or such a declared character set.
fn wide_text(head: &[u8], charset: Option<&str>) -> bool {
    head.starts_with(b"\xff\xfe")
        || head.starts_with(b"\xfe\xff")
        || head.starts_with(b"\x00\x00\xfe\xff")
        || charset.is_some_and(|c| c.starts_with("utf-16") || c.starts_with("utf-32") || c.starts_with("ucs-"))
}

/// Whether a media value is safe to stage: one line of name characters.
pub(super) fn media_is_valid(media: &str) -> bool {
    !media.is_empty()
        && media.len() <= 255
        && media.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn scaling_is_valid(value: &str) -> bool {
    PRINT_SCALINGS.contains(&value)
        || (value.bytes().all(|b| b.is_ascii_digit())
            && value.parse::<i32>().is_ok_and(|n| SCALING_PERCENT.contains(&n)))
}

fn ranges_text(ranges: &[(i32, i32)]) -> String {
    ranges
        .iter()
        .map(|&(lo, hi)| match hi {
            OPEN_RANGE => format!("{lo}-"),
            hi if hi == lo => lo.to_string(),
            hi => format!("{lo}-{hi}"),
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// `1-3,5`, `7-` and `-4` as ranges; none for an empty, malformed or
/// empty-range text. An upper bound past `i32::MAX`, or none, is open-ended.
fn parse_ranges(text: &str) -> Option<Vec<(i32, i32)>> {
    let mut ranges = Vec::new();
    for token in text.split(',') {
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        let (lo, hi) = match token.split_once('-') {
            None if digits(token) => (token, token),
            Some((lo, hi)) if (lo.is_empty() || digits(lo)) && (hi.is_empty() || digits(hi)) => {
                if lo.is_empty() && hi.is_empty() {
                    return None;
                }
                (if lo.is_empty() { "1" } else { lo }, hi)
            }
            _ => return None,
        };
        let lo: i32 = lo.parse().ok()?;
        let hi = if hi.is_empty() { OPEN_RANGE } else { hi.parse().unwrap_or(OPEN_RANGE) };
        if lo < 1 || hi < lo {
            return None;
        }
        ranges.push((lo, hi));
    }
    (!ranges.is_empty() && ranges.len() <= MAX_PAGE_RANGES).then_some(ranges)
}

/// A dimension pair `<w>x<h>` in `per_unit` points each, as a portrait sheet.
fn portrait(numbers: &str, per_unit: f64) -> Option<(f64, f64)> {
    let (w, h) = numbers.split_once('x')?;
    let (w, h): (f64, f64) = (w.parse().ok()?, h.parse().ok()?);
    (w > 0.0 && h > 0.0 && w.is_finite() && h.is_finite())
        .then(|| (w.min(h) * per_unit, w.max(h) * per_unit))
}

impl JobLayout {
    /// Whether delivery has nothing to apply.
    pub fn is_plain(&self) -> bool {
        self.number_up == 1
            && !self.reverse
            && self.page_set == "all"
            && self.page_ranges.is_empty()
            && !self.mirror
            && self.scaling.is_none()
    }

    /// Whether a layout file is staged beside the job's documents.
    pub fn is_staged(&self) -> bool {
        !self.is_plain() || !self.not_applied.is_empty() || self.charset.is_some()
    }

    /// No layout options: the document as sent, read in its own character
    /// set.
    pub fn plain(&self) -> Self {
        Self { charset: self.charset.clone(), ..Self::default() }
    }

    /// The options delivery applies, in words, for a report.
    pub fn describe(&self) -> String {
        let mut parts = Vec::new();
        if self.number_up > 1 {
            parts.push(format!("{} pages per sheet", self.number_up));
        }
        if self.page_set != "all" {
            parts.push(format!("{} pages", self.page_set));
        }
        if !self.page_ranges.is_empty() {
            parts.push(format!("pages {}", ranges_text(&self.page_ranges)));
        }
        if let Some(scaling) = &self.scaling {
            if scaling.bytes().all(|b| b.is_ascii_digit()) {
                parts.push(format!("scaled to {scaling}%"));
            } else {
                parts.push(format!("scaling {scaling}"));
            }
        }
        if self.mirror {
            parts.push("mirrored".to_string());
        }
        if self.reverse {
            parts.push("reverse order".to_string());
        }
        parts.join(", ")
    }

    pub fn to_text(&self) -> String {
        let mut text = format!(
            "number-up={}\nnumber-up-layout={}\nreverse={}\n",
            self.number_up, self.number_up_layout, self.reverse
        );
        if let Some(media) = &self.media {
            text.push_str(&format!("media={media}\n"));
        }
        if self.page_set != "all" {
            text.push_str(&format!("page-set={}\n", self.page_set));
        }
        if !self.page_ranges.is_empty() {
            text.push_str(&format!("page-ranges={}\n", ranges_text(&self.page_ranges)));
        }
        if self.mirror {
            text.push_str("mirror=true\n");
        }
        if let Some(scaling) = &self.scaling {
            text.push_str(&format!("scaling={scaling}\n"));
        }
        for name in &self.not_applied {
            text.push_str(&format!("not-applied={name}\n"));
        }
        if let Some(charset) = &self.charset {
            text.push_str(&format!("charset={charset}\n"));
        }
        text
    }

    pub fn from_text(text: &str) -> Result<Self, String> {
        let mut layout = Self::default();
        for line in text.lines().filter(|line| !line.is_empty()) {
            let (name, value) = line
                .split_once('=')
                .ok_or_else(|| format!("the job's layout line {line:?} has no value"))?;
            match name {
                "number-up" => {
                    layout.number_up = value
                        .parse()
                        .ok()
                        .filter(|n| NUMBER_UP.contains(n))
                        .ok_or_else(|| format!("the job's pages per sheet {value:?} is not offered"))?
                }
                "number-up-layout" if NUMBER_UP_LAYOUTS.contains(&value) => {
                    layout.number_up_layout = value.to_string()
                }
                "reverse" | "mirror" => {
                    let flag = value
                        .parse()
                        .map_err(|_| format!("the job's {name} {value:?} is not true or false"))?;
                    if name == "reverse" {
                        layout.reverse = flag;
                    } else {
                        layout.mirror = flag;
                    }
                }
                "media" if media_is_valid(value) => layout.media = Some(value.to_string()),
                "page-set" if PAGE_SETS.contains(&value) => layout.page_set = value.to_string(),
                "page-ranges" => {
                    layout.page_ranges = parse_ranges(value)
                        .ok_or_else(|| format!("the job's page ranges {value:?} are not understood"))?
                }
                "scaling" if scaling_is_valid(value) => layout.scaling = Some(value.to_string()),
                "not-applied" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_lowercase() || b == b'-') => {
                    layout.not_applied.push(value.to_string())
                }
                "charset" if charset_is_valid(value) => layout.charset = Some(value.to_string()),
                _ => return Err(format!("the job's layout line {line:?} is not understood")),
            }
        }
        Ok(layout)
    }

    /// The portrait sheet in points from the media name: a PPD size name
    /// (`A4`, `Letter`, any case), a `Custom.<w>x<h>[unit]` size, or a PWG
    /// 5101.1 name whose last field is `<w>x<h>mm` or `<w>x<h>in`.
    pub fn sheet_points(&self) -> Option<(f64, f64)> {
        let media = self.media.as_deref()?;
        let named = if media.eq_ignore_ascii_case("Ledger") { "Tabloid" } else { media };
        if let Some((.., x, y)) = PAGES
            .iter()
            .find(|(pwg, ppd, ..)| named.eq_ignore_ascii_case(ppd) || named == *pwg)
        {
            let per = 72.0 / 2540.0;
            let (x, y) = (f64::from(*x) * per, f64::from(*y) * per);
            return Some((x.min(y), x.max(y)));
        }
        if media.len() > 7 && media[..7].eq_ignore_ascii_case("Custom.") {
            let size = &media[7..];
            let split = size.find(|c: char| c.is_ascii_alphabetic() && c != 'x').unwrap_or(size.len());
            let per_unit = match size[split..].to_ascii_lowercase().as_str() {
                "" | "pt" => 1.0,
                "in" => 72.0,
                "ft" => 864.0,
                "mm" => 72.0 / 25.4,
                "cm" => 72.0 / 2.54,
                "m" => 72.0 / 0.0254,
                _ => return None,
            };
            return portrait(&size[..split], per_unit);
        }
        let size = media.rsplit('_').next()?;
        if let Some(n) = size.strip_suffix("mm") {
            portrait(n, 72.0 / 25.4)
        } else if let Some(n) = size.strip_suffix("in") {
            portrait(n, 72.0)
        } else {
            None
        }
    }
}

/// Whether a value says yes: a boolean, or the text CUPS options carry.
fn yes(value: &Value) -> Option<bool> {
    if let Some(flag) = value.boolean() {
        return Some(flag);
    }
    match value.text()?.to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" => Some(true),
        "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// The layout options in a Get-Job-Attributes response. An option with a
/// value delivery does not apply is listed in `not_applied` and left at its
/// default; no value removes the job.
pub(super) fn layout_from(response: &Message) -> JobLayout {
    let mut layout = JobLayout::default();
    let Some(group) = response.groups.iter().find(|g| g.tag == tag::JOB) else {
        return layout;
    };
    let first = |name: &str| {
        group
            .attrs
            .iter()
            .find(|a| a.name == name)
            .and_then(|a| a.values.first())
    };
    let integer = |value: &Value| value.integer().or_else(|| value.text().and_then(|t| t.trim().parse().ok()));
    let keyword = |value: &Value| value.text().map(str::to_ascii_lowercase);
    let mut skipped: Vec<String> = Vec::new();
    let mut skip = |name: &str| skipped.push(name.to_string());

    if let Some(value) = first("number-up") {
        match integer(value).filter(|n| NUMBER_UP.contains(n)) {
            Some(n) => layout.number_up = n,
            None => skip("number-up"),
        }
    }
    if let Some(value) = first("number-up-layout") {
        match keyword(value).filter(|order| NUMBER_UP_LAYOUTS.contains(&order.as_str())) {
            Some(order) => layout.number_up_layout = order,
            None => skip("number-up-layout"),
        }
    }
    for name in ["outputorder", "output-order"] {
        if let Some(value) = first(name) {
            match keyword(value).as_deref() {
                Some("reverse") => layout.reverse = true,
                Some("normal") => {}
                _ => skip(name),
            }
        }
    }
    if let Some(value) = first("page-delivery") {
        match keyword(value).as_deref() {
            Some(delivery) if delivery.starts_with("reverse-order") => layout.reverse = true,
            Some(delivery) if delivery.starts_with("same-order") || delivery == "system-specified" => {}
            _ => skip("page-delivery"),
        }
    }
    match first("media") {
        None => {}
        Some(value) => match value.text() {
            Some(media) if media_is_valid(media) => layout.media = Some(media.to_string()),
            _ => skip("media"),
        },
    }
    if let Some(value) = first("page-set") {
        match keyword(value) {
            Some(set) if PAGE_SETS.contains(&set.as_str()) => layout.page_set = set,
            _ => skip("page-set"),
        }
    }
    if let Some(attr) = group.attrs.iter().find(|a| a.name == "page-ranges") {
        let mut ranges: Vec<(i32, i32)> = Vec::new();
        let mut understood = !attr.values.is_empty();
        for value in &attr.values {
            match value {
                Value::Range(lo, hi) if *lo >= 1 && hi >= lo => ranges.push((*lo, *hi)),
                Value::Integer(n) if *n >= 1 => ranges.push((*n, *n)),
                other => match other.text().and_then(parse_ranges) {
                    Some(parsed) => ranges.extend(parsed),
                    None => understood = false,
                },
            }
        }
        if understood && ranges.len() <= MAX_PAGE_RANGES {
            layout.page_ranges = ranges;
        } else {
            skip("page-ranges");
        }
    }
    if let Some(value) = first("mirror") {
        match yes(value) {
            Some(flag) => layout.mirror = flag,
            None => skip("mirror"),
        }
    }
    // `print-scaling`, when present, alone decides the scaling; without it
    // `scaling` outranks `fit-to-page`, the order of the CUPS image filter.
    // Every job format takes the same order and applies `scaling`, which the
    // CUPS PDF filter ignores.
    if let Some(value) = first("print-scaling") {
        match keyword(value).as_deref() {
            Some("none") => {}
            Some("auto" | "auto-fit") => layout.scaling = Some("auto-fit".to_string()),
            Some(scaling) if PRINT_SCALINGS.contains(&scaling) => layout.scaling = Some(scaling.to_string()),
            _ => skip("print-scaling"),
        }
    } else {
        if let Some(value) = first("scaling") {
            match integer(value).filter(|n| SCALING_PERCENT.contains(n)) {
                Some(n) => layout.scaling = Some(n.to_string()),
                None => skip("scaling"),
            }
        }
        if let Some(value) = first("fit-to-page") {
            match yes(value) {
                Some(true) if layout.scaling.is_none() => layout.scaling = Some("fit".to_string()),
                Some(_) => {}
                None => skip("fit-to-page"),
            }
        }
    }
    layout.not_applied = skipped;
    layout
}

// ── the scheduler ───────────────────────────────────────────────────────────

/// Why an exchange produced no response.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Refusal {
    /// The scheduler refused this user (HTTP 401 or 403).
    Denied(String),
    /// The scheduler could not be reached.
    Unavailable(String),
    Failed(String),
}

impl Refusal {
    fn text(&self) -> &str {
        match self {
            Refusal::Denied(t) | Refusal::Unavailable(t) | Refusal::Failed(t) => t,
        }
    }
}

/// One IPP exchange with the scheduler. Requests and responses are RFC 8010
/// messages.
pub(super) trait Scheduler {
    fn exchange(&self, request: &[u8]) -> Result<Vec<u8>, Refusal>;
    /// The same, with the data that follows the response written to `out`.
    fn exchange_document(&self, request: &[u8], out: &File) -> Result<Vec<u8>, Refusal>;
}

/// The system scheduler through libcups.
pub(super) struct SystemScheduler {
    cups: &'static crate::cups_linux::Cups,
}

impl SystemScheduler {
    pub fn open() -> Result<Self, String> {
        let cups = crate::cups_linux::cups()?;
        cups.refuse_password_prompts();
        Ok(Self { cups })
    }
}

/// `cupsLastError` as a refusal: the authentication statuses and their CUPS
/// extensions (0x1000 authentication cancelled, 0x1002 upgrade required) are
/// the scheduler refusing this user, 'server-error-service-unavailable' is
/// what libcups reports when it cannot connect.
fn refusal_for(code: c_int, text: String) -> Refusal {
    let text = if text.trim().is_empty() {
        format!("IPP status {code:#06x}")
    } else {
        text
    };
    match code {
        0x0401 | 0x0402 | 0x0403 | 0x1000 | 0x1002 => Refusal::Denied(text),
        0x0502 => Refusal::Unavailable(text),
        _ => Refusal::Failed(text),
    }
}

impl Scheduler for SystemScheduler {
    fn exchange(&self, request: &[u8]) -> Result<Vec<u8>, Refusal> {
        self.cups
            .exchange(request, None)
            .map_err(|(code, text)| refusal_for(code, text))
    }

    fn exchange_document(&self, request: &[u8], out: &File) -> Result<Vec<u8>, Refusal> {
        self.cups
            .exchange(request, Some(out.as_raw_fd()))
            .map_err(|(code, text)| refusal_for(code, text))
    }
}

fn call(scheduler: &dyn Scheduler, request: &Message) -> Result<Message, Refusal> {
    let bytes = scheduler.exchange(&encode(request))?;
    decode(&mut bytes.as_slice())
        .map_err(|e| Refusal::Failed(format!("the print system's answer could not be read: {e}")))
}

pub(super) fn queue_facts(
    scheduler: &dyn Scheduler,
    queue: &str,
    user: &str,
) -> Result<Option<QueueFacts>, Refusal> {
    let response = call(scheduler, &printer_attributes_request(queue, user))?;
    queue_facts_from(&response).map_err(Refusal::Failed)
}

/// The lowercase names of every queue the scheduler lists.
fn existing_queues(scheduler: &dyn Scheduler, user: &str) -> Result<HashSet<String>, Refusal> {
    let response = call(scheduler, &get_printers_request(user))?;
    if !succeeded(response.code) && response.code != status::NOT_FOUND {
        return Err(Refusal::Failed(status_text(&response)));
    }
    Ok(response
        .groups
        .iter()
        .filter(|g| g.tag == tag::PRINTER)
        .filter_map(|g| first_text(&g.attrs, "printer-name"))
        .map(|name| name.to_lowercase())
        .collect())
}

// ── staging and the ledger ──────────────────────────────────────────────────

/// What a staged document is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DocKind {
    Pdf,
    PostScript,
    /// `text/plain`, converted through Create PDF at delivery.
    Text,
    /// An image, by its extension; converted through Create PDF at delivery.
    Image(&'static str),
}

impl DocKind {
    fn extension(self) -> &'static str {
        match self {
            DocKind::Pdf => "pdf",
            DocKind::PostScript => "ps",
            DocKind::Text => "txt",
            DocKind::Image(extension) => extension,
        }
    }
}

/// The image formats the queue takes that Create PDF converts: MIME type,
/// staged extension, and the signatures the data must begin with.
pub(super) const IMAGE_FORMATS: &[(&str, &str, &[&[u8]])] = &[
    ("image/png", "png", &[b"\x89PNG\r\n\x1a\n"]),
    ("image/jpeg", "jpg", &[b"\xff\xd8\xff"]),
    ("image/tiff", "tif", &[b"II*\x00", b"MM\x00*"]),
];

/// Whether `extension` names a staged document.
fn staged_extension(extension: &str) -> bool {
    matches!(extension, "pdf" | "ps" | "txt") || IMAGE_FORMATS.iter().any(|(_, e, _)| *e == extension)
}

/// A fetched document by its format, as the scheduler typed it, and its
/// first bytes.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Content {
    Kind(DocKind),
    /// A job sheet the scheduler adds (`job-sheets`), not printed content.
    Banner,
    /// The message that names why the document is not converted.
    Unsupported(String),
}

/// The Universal Exit Language that opens a PJL envelope; the `distill` arm
/// unwraps one around PostScript.
const UEL: &[u8] = b"\x1b%-12345X";

pub(super) fn content_of(format: &str, head: &[u8]) -> Content {
    let charset = charset_of(format).ok().flatten();
    let format = format
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if format == "application/vnd.cups-banner" {
        return Content::Banner;
    }
    let pdf = head[..head.len().min(1024)].windows(5).any(|w| w == b"%PDF-");
    let postscript = head.starts_with(b"%!") || head.starts_with(UEL);
    let unwrapped = matches!(
        format.as_str(),
        "application/octet-stream" | "application/vnd.cups-raw"
    );
    let image = IMAGE_FORMATS.iter().find(|(mime, ..)| *mime == format);
    match format.as_str() {
        "application/pdf" | "application/vnd.cups-pdf" if pdf => Content::Kind(DocKind::Pdf),
        "application/postscript" | "application/vnd.cups-postscript" if postscript => {
            Content::Kind(DocKind::PostScript)
        }
        _ if unwrapped && pdf => Content::Kind(DocKind::Pdf),
        _ if unwrapped && postscript => Content::Kind(DocKind::PostScript),
        "text/plain" if head.starts_with(b"%PDF-") => Content::Kind(DocKind::Pdf),
        "text/plain" if postscript => Content::Kind(DocKind::PostScript),
        "text/plain" if wide_text(head, charset.as_deref()) => Content::Kind(DocKind::Text),
        "text/plain" if head.contains(&0) => Content::Unsupported(
            "a print job arrived as text/plain data that holds binary bytes, which Spectra PDF does not print as text"
                .to_string(),
        ),
        "text/plain" => Content::Kind(DocKind::Text),
        _ if image.is_some_and(|(_, _, signatures)| signatures.iter().any(|s| head.starts_with(s))) => {
            Content::Kind(DocKind::Image(image.map_or("", |(_, extension, _)| extension)))
        }
        "application/pdf" | "application/vnd.cups-pdf" | "application/postscript"
        | "application/vnd.cups-postscript" => Content::Unsupported(format!(
            "a print job arrived as {format} data that does not begin as that format"
        )),
        _ if image.is_some() => Content::Unsupported(format!(
            "a print job arrived as {format} data that does not begin as that format"
        )),
        "" => Content::Unsupported(
            "a print job arrived in a format the print system did not name".to_string(),
        ),
        _ => Content::Unsupported(format!(
            "a print job arrived as {format} data, which Spectra PDF does not convert"
        )),
    }
}

/// A job's ledger key: `Printed <time-at-creation>-<job-id>`. The creation
/// time travels with the id because the scheduler numbers jobs afresh once
/// it forgets every job.
pub(super) fn job_key(job: &JobFacts) -> String {
    format!("{PRINTED_PREFIX}{}-{:010}", job.created.max(0), job.id)
}

/// The staged file of one document: its job's key, the document number and
/// the format's extension.
pub(super) fn staged_name(key: &str, document: u32, kind: DocKind) -> String {
    format!("{key}{document:03}.{}", kind.extension())
}

/// The job key of a staged document's name, for names this receiver writes.
pub(super) fn key_of(staged: &str) -> Option<String> {
    let (rest, extension) = staged.rsplit_once('.')?;
    if !staged_extension(extension) || rest.len() < 3 || !rest.is_char_boundary(rest.len() - 3) {
        return None;
    }
    let (key, document) = rest.split_at(rest.len() - 3);
    let (stamp, id) = key.strip_prefix(PRINTED_PREFIX)?.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (digits(document) && digits(stamp) && digits(id)).then(|| key.to_string())
}

/// The output stem of a staged document: its name without the
/// `-<digits>.<extension>` tail.
pub(super) fn stem_of(staged: &Path) -> Option<String> {
    let name = staged.file_name()?.to_str()?;
    let (rest, extension) = name.rsplit_once('.')?;
    if !staged_extension(extension) {
        return None;
    }
    let (stem, key) = rest.rsplit_once('-')?;
    if !stem.starts_with(PRINTED_PREFIX) || key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(stem.to_string())
}

fn ledger_entry(ledger: &Path, name: &str, suffix: &str) -> PathBuf {
    ledger.join(format!("{name}{suffix}"))
}

/// The staged documents of one job.
fn staged_copies(staging: &Path, key: &str) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(staging) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .and_then(key_of)
                .is_some_and(|of| of == key)
        })
        .collect()
}

fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

/// Create `path` holding `contents`, on disk before this returns. A write or
/// flush that fails removes the file again.
fn write_durable(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    if written.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Rename `from` to `to` and flush the folder that holds the new name.
fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::rename(from, to)?;
    sync_dir(to.parent().unwrap_or_else(|| Path::new(".")))
}

/// Write a ledger entry under a temporary name and rename it into place, so
/// the entry exists whole or not at all.
fn write_entry_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut temp = path.as_os_str().to_os_string();
    temp.push(ENTRY_TEMP_SUFFIX);
    let temp = PathBuf::from(temp);
    write_durable(&temp, contents)?;
    rename_durable(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })
}

/// Whether `path` is gone, removing it if it is there.
fn removed(path: &Path) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) => e.kind() == io::ErrorKind::NotFound,
    }
}

/// What a receiver remembers between passes, by job key.
pub(super) struct Taker {
    /// Jobs taken, refused or given up on by this process.
    passed: HashSet<String>,
    failures: HashMap<String, u32>,
    /// Writes a job's ledger entry (path, queue name).
    write_entry: fn(&Path, &[u8]) -> io::Result<()>,
}

impl Default for Taker {
    fn default() -> Self {
        Self {
            passed: HashSet::new(),
            failures: HashMap::new(),
            write_entry: write_entry_file,
        }
    }
}

/// Expands a gzip-compressed document into a sink, stopping once more than
/// the limit was written; returns the count.
pub(super) type Expand<'a> = &'a dyn Fn(&Path, &mut dyn Write, u64) -> Result<u64, String>;

/// The receiver's view of one pass.
pub(super) struct Pass<'a> {
    pub scheduler: &'a dyn Scheduler,
    pub user: &'a str,
    pub queue: &'a str,
    pub staging: &'a Path,
    pub ledger: &'a Path,
    pub record_error: &'a dyn Fn(String),
    pub expand: Expand<'a>,
}

/// One pass over this user's queue: stage every finished job of the held
/// queue, record it in the ledger and cancel it. Returns what the queue is;
/// nothing is taken from a queue that is not held. An error means the print
/// system did not answer.
pub(super) fn take_jobs(pass: &Pass, taker: &mut Taker) -> Result<QueueKind, String> {
    finish_staging(pass.staging, pass.ledger);
    let facts = queue_facts(pass.scheduler, pass.queue, pass.user).map_err(|r| r.text().to_string())?;
    let kind = classify(facts.as_ref(), pass.user);
    if kind != QueueKind::Held {
        return Ok(kind);
    }
    let jobs = match call(pass.scheduler, &get_jobs_request(pass.queue, pass.user))
        .map_err(|r| r.text().to_string())
        .and_then(|response| jobs_from(&response))
    {
        Ok(jobs) => jobs,
        Err(e) => {
            (pass.record_error)(format!("the jobs of {} could not be listed: {e}", pass.queue));
            return Ok(kind);
        }
    };
    let listed_in_full = jobs.len() < MAX_JOBS_PER_PASS;
    let mut seen: HashSet<String> = HashSet::new();
    for job in &jobs {
        if job
            .owner
            .as_deref()
            .is_some_and(|owner| !owner.eq_ignore_ascii_case(pass.user))
        {
            continue;
        }
        let key = job_key(job);
        take_one(pass, job, &key, taker);
        seen.insert(key);
    }
    taker.passed.retain(|key| seen.contains(key));
    taker.failures.retain(|key, _| seen.contains(key));
    if listed_in_full {
        prune_ledger(pass, &seen);
    }
    Ok(kind)
}

fn take_one(pass: &Pass, job: &JobFacts, key: &str, taker: &mut Taker) {
    if taker.passed.contains(key) || !job_is_complete(job) {
        return;
    }
    let taken = ledger_entry(pass.ledger, key, TAKEN_SUFFIX);
    if !taken.exists() {
        let copies = staged_copies(pass.staging, key);
        let ready = if copies.is_empty() {
            stage_job(pass, job, key, &taken, taker)
        } else {
            // Staging writes the entry before any staged name, so these
            // copies came from elsewhere; they are recorded like fresh ones.
            record_taken(pass, taker, key, &taken, &copies)
        };
        if !ready {
            return;
        }
    }
    remove_from_queue(pass, job, key, taker);
}

/// Write the job's ledger entry, naming its queue. When the write fails, the
/// copies of the job's data go too, but only once the entry is gone: a copy
/// without an entry would be delivered while a later pass reads the job
/// again, and an entry without a copy would let that pass cancel the job.
/// Returns whether the entry is there.
fn record_taken(pass: &Pass, taker: &mut Taker, key: &str, taken: &Path, copies: &[PathBuf]) -> bool {
    let Err(e) = (taker.write_entry)(taken, pass.queue.as_bytes()) else {
        return true;
    };
    failed_attempt(
        pass,
        taker,
        key,
        format!("the print job could not be recorded as taken: {e}"),
    );
    if removed(taken) {
        for copy in copies {
            let _ = std::fs::remove_file(copy);
        }
        false
    } else {
        true
    }
}

/// How one document's fetch ended.
enum Fetched {
    /// Staged under its part name, to be renamed to the staged name, with a
    /// text document's declared character set.
    Staged { part: PathBuf, staged: PathBuf, charset: Result<Option<String>, ()> },
    /// A job sheet or an empty document: nothing to deliver.
    Skipped,
    Refused(String),
    OverLimit,
}

enum FetchFailure {
    /// The scheduler refused this user the document.
    Denied,
    /// The job or the document left the spool.
    Gone,
    Failed(String),
}

/// Read every document of the job and stage it: each is flushed under its
/// part name, the parts' folder is flushed, the ledger entry is written, and
/// only then do the parts take their staged names. True once the job needs
/// nothing more from its queue: its data is staged, or it holds nothing
/// deliverable and is dropped. A failed read stages nothing and keeps the
/// job.
fn stage_job(pass: &Pass, job: &JobFacts, key: &str, taken: &Path, taker: &mut Taker) -> bool {
    let queue = pass.queue;
    if job.documents > MAX_DOCUMENTS {
        (pass.record_error)(format!(
            "a print job in {queue} has {} documents, more than the {MAX_DOCUMENTS} this printer takes, and was removed",
            job.documents
        ));
        return write_or_name(pass, taker, key, taken);
    }
    // job-k-octets is rounded up to whole kilobytes (RFC 8011 section
    // 5.3.17.1), one rounding per document in the scheduler.
    let slack = 1024 * u64::from(job.documents.max(1));
    if job.k_octets.saturating_mul(1024) > MAX_JOB_BYTES.saturating_add(slack) {
        (pass.record_error)(format!(
            "a print job in {queue} is over the {MAX_JOB_BYTES}-byte limit and was not converted"
        ));
        return write_or_name(pass, taker, key, taken);
    }
    let layout = match fetch_layout(pass, job) {
        Ok(layout) => layout,
        Err(failure) => {
            fetch_failed(pass, taker, key, failure);
            return false;
        }
    };
    let mut parts: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut layouts: Vec<JobLayout> = Vec::new();
    let mut refused: Vec<String> = Vec::new();
    let discard = |parts: &[(PathBuf, PathBuf)]| {
        for (part, staged) in parts {
            let _ = std::fs::remove_file(part);
            let _ = std::fs::remove_file(layout_path(staged));
        }
    };
    for document in 1..=job.documents {
        match fetch_document(pass, job, key, document) {
            Ok(Fetched::Staged { part, staged, charset }) => {
                let mut own = layout.clone();
                match charset {
                    Ok(charset) => own.charset = charset,
                    Err(()) => own.not_applied.push("charset".to_string()),
                }
                parts.push((part, staged));
                layouts.push(own);
            }
            Ok(Fetched::Skipped) => {}
            Ok(Fetched::Refused(message)) => refused.push(message),
            Ok(Fetched::OverLimit) => {
                discard(&parts);
                (pass.record_error)(format!(
                    "a print job in {queue} is over the {MAX_JOB_BYTES}-byte limit and was not converted"
                ));
                return write_or_name(pass, taker, key, taken);
            }
            Err(failure) => {
                discard(&parts);
                fetch_failed(pass, taker, key, failure);
                return false;
            }
        }
    }
    for message in &refused {
        (pass.record_error)(format!("{message}; it was removed from {queue}"));
    }
    if parts.is_empty() {
        return write_or_name(pass, taker, key, taken);
    }
    // The layout file is on disk before its document takes the staged name,
    // so delivery never sees the document without its options.
    for ((_, staged), own) in parts.iter().zip(&layouts) {
        if !own.is_staged() {
            continue;
        }
        if let Err(e) = write_durable(&layout_path(staged), own.to_text().as_bytes()) {
            discard(&parts);
            failed_attempt(pass, taker, key, format!("the print job could not be staged: {e}"));
            return false;
        }
    }
    if let Err(e) = sync_dir(pass.staging) {
        discard(&parts);
        failed_attempt(pass, taker, key, format!("the print job could not be staged: {e}"));
        return false;
    }
    let copies: Vec<PathBuf> = parts.iter().map(|(part, _)| part.clone()).collect();
    if !record_taken(pass, taker, key, taken, &copies) {
        return false;
    }
    for (part, staged) in &parts {
        if let Err(e) = rename_durable(part, staged) {
            // The entry stays: the part is complete and on disk, and the next
            // pass, or the next start, finishes the rename.
            failed_attempt(pass, taker, key, format!("the print job could not be staged: {e}"));
        }
    }
    true
}

fn fetch_failed(pass: &Pass, taker: &mut Taker, key: &str, failure: FetchFailure) {
    let queue = pass.queue;
    match failure {
        FetchFailure::Denied => {
            taker.passed.insert(key.to_string());
            (pass.record_error)(format!(
                "a print job in {queue} cannot be read by this account; it stays in the queue"
            ));
        }
        FetchFailure::Gone => failed_attempt(
            pass,
            taker,
            key,
            format!("a print job was removed from {queue} before it could be read"),
        ),
        FetchFailure::Failed(e) => failed_attempt(
            pass,
            taker,
            key,
            format!("the print job could not be read from {queue}: {e}"),
        ),
    }
}

/// The layout file beside a staged document.
pub(super) fn layout_path(staged: &Path) -> PathBuf {
    let mut name = staged.file_name().unwrap_or_default().to_os_string();
    name.push(LAYOUT_SUFFIX);
    staged.with_file_name(name)
}

/// The job's layout options, with Get-Job-Attributes.
fn fetch_layout(pass: &Pass, job: &JobFacts) -> Result<JobLayout, FetchFailure> {
    let response = call(pass.scheduler, &get_job_attributes_request(pass.queue, pass.user, job.id))
        .map_err(|refusal| match refusal {
            Refusal::Denied(_) => FetchFailure::Denied,
            Refusal::Unavailable(e) | Refusal::Failed(e) => FetchFailure::Failed(e),
        })?;
    match response.code {
        code if succeeded(code) => Ok(layout_from(&response)),
        status::NOT_FOUND => Err(FetchFailure::Gone),
        status::FORBIDDEN | status::NOT_AUTHENTICATED | status::NOT_AUTHORIZED => Err(FetchFailure::Denied),
        _ => Err(FetchFailure::Failed(status_text(&response))),
    }
}

fn read_head(path: &Path) -> io::Result<Vec<u8>> {
    let mut head = Vec::with_capacity(1024);
    File::open(path)?.take(1024).read_to_end(&mut head)?;
    Ok(head)
}

fn create_private(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

/// Copy one document out of the spool with CUPS-Get-Document and stage it
/// under its part name. A gzip-compressed spool file (the scheduler keeps a
/// document as it arrived) is expanded first.
fn fetch_document(pass: &Pass, job: &JobFacts, key: &str, document: u32) -> Result<Fetched, FetchFailure> {
    let base = format!("{key}{document:03}");
    let download = pass.staging.join(format!("{base}{DOWNLOAD_SUFFIX}"));
    let expanded = pass.staging.join(format!("{base}{EXPANDED_SUFFIX}"));
    let _ = std::fs::remove_file(&download);
    let _ = std::fs::remove_file(&expanded);
    let file = create_private(&download)
        .map_err(|e| FetchFailure::Failed(format!("cannot stage the job: {e}")))?;
    let outcome = (|| {
        let request = encode(&get_document_request(pass.queue, pass.user, job.id, document));
        let bytes = pass
            .scheduler
            .exchange_document(&request, &file)
            .map_err(|refusal| match refusal {
                Refusal::Denied(_) => FetchFailure::Denied,
                Refusal::Unavailable(e) | Refusal::Failed(e) => FetchFailure::Failed(e),
            })?;
        let response = decode(&mut bytes.as_slice()).map_err(|e| {
            FetchFailure::Failed(format!("the print system's answer could not be read: {e}"))
        })?;
        match response.code {
            code if succeeded(code) => {}
            status::NOT_FOUND => return Err(FetchFailure::Gone),
            status::FORBIDDEN | status::NOT_AUTHENTICATED | status::NOT_AUTHORIZED => {
                return Err(FetchFailure::Denied)
            }
            _ => return Err(FetchFailure::Failed(status_text(&response))),
        }
        file.sync_all()
            .map_err(|e| FetchFailure::Failed(format!("cannot stage the job: {e}")))?;
        let format = response
            .any_attr("document-format")
            .and_then(|a| a.values.first())
            .and_then(Value::text)
            .unwrap_or("")
            .to_string();
        if content_of(&format, b"") == Content::Banner {
            return Ok(Fetched::Skipped);
        }
        let failed = |e: io::Error| FetchFailure::Failed(format!("cannot stage the job: {e}"));
        let mut data = download.clone();
        if read_head(&download).map_err(failed)?.starts_with(&[0x1f, 0x8b]) {
            let mut out = create_private(&expanded).map_err(failed)?;
            let count = (pass.expand)(&download, &mut out, MAX_JOB_BYTES)
                .map_err(FetchFailure::Failed)?;
            if count > MAX_JOB_BYTES {
                return Ok(Fetched::OverLimit);
            }
            out.sync_all().map_err(failed)?;
            data = expanded.clone();
        }
        let length = std::fs::metadata(&data).map_err(failed)?.len();
        if length > MAX_JOB_BYTES {
            return Ok(Fetched::OverLimit);
        }
        if length == 0 {
            return Ok(Fetched::Skipped);
        }
        match content_of(&format, &read_head(&data).map_err(failed)?) {
            Content::Banner => Ok(Fetched::Skipped),
            Content::Unsupported(message) => Ok(Fetched::Refused(message)),
            Content::Kind(kind) => {
                let staged = pass.staging.join(staged_name(key, document, kind));
                let part = part_path(&staged);
                std::fs::rename(&data, &part).map_err(failed)?;
                let charset = if kind == DocKind::Text { charset_of(&format) } else { Ok(None) };
                Ok(Fetched::Staged { part, staged, charset })
            }
        }
    })();
    drop(file);
    let _ = std::fs::remove_file(&download);
    let _ = std::fs::remove_file(&expanded);
    outcome
}

/// The entry of a job dropped without a copy (empty, refused or over the
/// limit).
fn write_or_name(pass: &Pass, taker: &mut Taker, key: &str, taken: &Path) -> bool {
    match (taker.write_entry)(taken, pass.queue.as_bytes()) {
        Ok(()) => true,
        Err(e) => {
            failed_attempt(
                pass,
                taker,
                key,
                format!("the print job could not be recorded as taken: {e}"),
            );
            !removed(taken)
        }
    }
}

/// Count one failed attempt at a job. The first failure is named; after the
/// last attempt this process leaves the job alone.
fn failed_attempt(pass: &Pass, taker: &mut Taker, key: &str, message: String) {
    let attempts = {
        let count = taker.failures.entry(key.to_string()).or_insert(0);
        *count += 1;
        *count
    };
    if attempts == 1 {
        (pass.record_error)(message);
    }
    if attempts >= MAX_READ_ATTEMPTS {
        taker.passed.insert(key.to_string());
    }
}

/// Cancel a taken job and purge its files, once per process: its ledger entry
/// already keeps it from being read again. A job already gone counts as
/// removed.
fn remove_from_queue(pass: &Pass, job: &JobFacts, key: &str, taker: &mut Taker) {
    let cancelled = call(pass.scheduler, &cancel_job_request(pass.queue, pass.user, job.id))
        .map_err(|r| r.text().to_string())
        .and_then(|response| {
            if succeeded(response.code) || response.code == status::NOT_FOUND {
                Ok(())
            } else {
                Err(status_text(&response))
            }
        });
    if let Err(e) = cancelled {
        (pass.record_error)(format!(
            "the print job was taken but stays in {}, because the print system did not remove it: {e}. It is not taken a second time.",
            pass.queue
        ));
    }
    taker.passed.insert(key.to_string());
}

/// Drop the entries of jobs that can never be read again; runs only after a
/// pass that listed the held queue in full. An entry of this queue goes once
/// the listing lacks its job. The entry of another queue that still exists
/// stays; one whose queue is gone, or that names none, goes.
fn prune_ledger(pass: &Pass, seen: &HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(pass.ledger) else {
        return;
    };
    let mut queues: Option<Option<HashSet<String>>> = None;
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(key) = file_name.to_str().and_then(|name| name.strip_suffix(TAKEN_SUFFIX)) else {
            continue;
        };
        if seen.contains(key) {
            continue;
        }
        let named = std::fs::read_to_string(entry.path()).unwrap_or_default();
        let named = named.trim();
        let gone = named.is_empty()
            || named.eq_ignore_ascii_case(pass.queue)
            || queues
                .get_or_insert_with(|| existing_queues(pass.scheduler, pass.user).ok())
                .as_ref()
                .is_some_and(|queues| !queues.contains(&named.to_lowercase()));
        if gone {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Finish the renames of parts whose job is recorded as taken: such a part
/// was complete and on disk before the entry was written.
fn finish_staging(staging: &Path, ledger: &Path) {
    let Ok(entries) = std::fs::read_dir(staging) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(name) = file_name.to_str().and_then(|name| name.strip_suffix(PART_SUFFIX)) else {
            continue;
        };
        let staged = staging.join(name);
        if key_of(name).is_some_and(|key| ledger_entry(ledger, &key, TAKEN_SUFFIX).exists())
            && !staged.exists()
        {
            let _ = rename_durable(&entry.path(), &staged);
        }
    }
}

/// Settle what a stopped process left; returns the files removed. Runs once
/// the receiver holds its claim and before any job is read or delivered.
///
/// A part whose job has a ledger entry was complete and on disk before the
/// entry was written, so its rename is finished; any other part, download or
/// expansion belongs to a job still in its queue and is removed. An entry
/// still under its temporary name never counted, and a delivery record whose
/// staged document is gone guards nothing.
pub(super) fn reclaim_staging(staging: &Path, ledger: &Path) -> usize {
    finish_staging(staging, ledger);
    let mut removed_count = 0;
    if let Ok(entries) = std::fs::read_dir(staging) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let leftover = name.starts_with(PRINTED_PREFIX)
                && (name.ends_with(PART_SUFFIX)
                    || name.ends_with(DOWNLOAD_SUFFIX)
                    || name.ends_with(EXPANDED_SUFFIX));
            if leftover && std::fs::remove_file(entry.path()).is_ok() {
                removed_count += 1;
            }
        }
    }
    // A layout file whose document never took its staged name guards nothing.
    if let Ok(entries) = std::fs::read_dir(staging) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(staged) = file_name.to_str().and_then(|name| name.strip_suffix(LAYOUT_SUFFIX)) else {
                continue;
            };
            if !staging.join(staged).exists() && std::fs::remove_file(entry.path()).is_ok() {
                removed_count += 1;
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(ledger) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            let stale = name.ends_with(ENTRY_TEMP_SUFFIX)
                || name
                    .strip_suffix(DELIVERED_SUFFIX)
                    .or_else(|| name.strip_suffix(ATTEMPTS_SUFFIX))
                    .is_some_and(|staged| !staging.join(staged).exists());
            if stale && std::fs::remove_file(entry.path()).is_ok() {
                removed_count += 1;
            }
        }
    }
    removed_count
}

// ── delivery ────────────────────────────────────────────────────────────────

/// Hand every staged document not yet attempted by this process to
/// `deliver`, up to the concurrency cap. Staging writes each job's ledger
/// entry before any staged name exists, so delivering a staged document
/// never lets its job be read again. Documents a stopped process left behind
/// are delivered again, never discarded.
pub(super) fn deliver_staged(
    staging: &Path,
    attempted: &Mutex<HashSet<PathBuf>>,
    record_error: &dyn Fn(String),
    deliver: &dyn Fn(String, PathBuf),
) {
    let Ok(entries) = std::fs::read_dir(staging) else {
        return;
    };
    let mut ready: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter_map(|path| stem_of(&path).map(|stem| (stem, path)))
        .collect();
    ready.sort();
    for (stem, path) in ready {
        if attempted.lock().unwrap().contains(&path) {
            continue;
        }
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        if len > MAX_JOB_BYTES {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_file(layout_path(&path));
            record_error(format!(
                "a staged print job is over the {MAX_JOB_BYTES}-byte limit and was removed"
            ));
            continue;
        }
        if IN_FLIGHT.load(Ordering::Relaxed) >= MAX_CONCURRENT_JOBS {
            return;
        }
        attempted.lock().unwrap().insert(path.clone());
        deliver(stem, path);
    }
}

/// Why a staged document produced no printed PDF.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Failure {
    /// The document's own bytes cannot be printed: every attempt fails the
    /// same way, so the job is removed.
    Refused(String),
    /// The machine failed (a converter missing, a full disk, a folder that
    /// cannot be written): the job stays staged for the next start.
    Retry(String),
}

/// Turns a staged document into a printed PDF and returns it; `before_rename`
/// runs once the PDF is complete and before it takes its final name.
pub(super) type Convert<'a> =
    &'a dyn Fn(&Path, &str, &dyn Fn(&Path) -> Result<(), String>) -> Result<PathBuf, Failure>;

/// Deliver one staged document: convert it, open the PDF, then drop the
/// staged file. The PDF's file name goes into the ledger before the PDF takes
/// that name, so after a stop past that point the next start opens the
/// existing PDF instead of converting a second copy. A document refused for
/// its own bytes is removed with its layout and record; on any other failure
/// it stays for the next start. The message says which.
pub(super) fn deliver_one(
    ledger: &Path,
    printed: &Path,
    staged: &Path,
    stem: &str,
    convert: Convert<'_>,
    open: &dyn Fn(&Path),
) -> Result<PathBuf, String> {
    let name = staged
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the staged print job has no readable name".to_string())?;
    let record = ledger_entry(ledger, name, DELIVERED_SUFFIX);
    let attempts = ledger_entry(ledger, name, ATTEMPTS_SUFFIX);
    let earlier = std::fs::read_to_string(&record)
        .ok()
        .map(|file_name| file_name.trim().to_string())
        .filter(|file_name| !file_name.is_empty() && !file_name.contains('/'))
        .map(|file_name| printed.join(file_name))
        .filter(|pdf| std::fs::metadata(pdf).is_ok_and(|meta| meta.is_file() && meta.len() > 0));
    let pdf = match earlier {
        Some(pdf) => pdf,
        None => {
            let _ = std::fs::remove_file(&record);
            let note = |pdf: &Path| {
                let file_name = pdf
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| "the printed file has no readable name".to_string())?;
                write_durable(&record, file_name.as_bytes())
                    .map_err(|e| format!("the printed file could not be recorded: {e}"))
            };
            match convert(staged, stem, &note) {
                Ok(pdf) => pdf,
                Err(Failure::Refused(e)) => {
                    let _ = std::fs::remove_file(staged);
                    let _ = std::fs::remove_file(layout_path(staged));
                    let _ = std::fs::remove_file(&record);
                    let _ = std::fs::remove_file(&attempts);
                    return Err(format!("{e}. The print job cannot be printed and was removed."));
                }
                Err(Failure::Retry(e)) => {
                    let _ = std::fs::remove_file(&record);
                    let failed = std::fs::read_to_string(&attempts)
                        .ok()
                        .and_then(|count| count.trim().parse::<u32>().ok())
                        .unwrap_or(0)
                        .saturating_add(1);
                    if failed >= MAX_DELIVERY_ATTEMPTS {
                        let _ = std::fs::remove_file(staged);
                        let _ = std::fs::remove_file(layout_path(staged));
                        let _ = std::fs::remove_file(&attempts);
                        return Err(format!(
                            "{e}. The print job failed {failed} times and was removed."
                        ));
                    }
                    let _ = write_entry_file(&attempts, failed.to_string().as_bytes());
                    let folder = staged.parent().unwrap_or(staged);
                    return Err(format!(
                        "{e}. The job is kept in {} and tried again the next time Spectra PDF starts.",
                        folder.display()
                    ));
                }
            }
        }
    };
    open(&pdf);
    // The record outlives a staged file that could not be removed, so the
    // next start opens this PDF again rather than converting the job twice.
    let _ = std::fs::remove_file(&attempts);
    if std::fs::remove_file(staged).is_ok() || !staged.exists() {
        let _ = std::fs::remove_file(layout_path(staged));
        let _ = std::fs::remove_file(&record);
    }
    Ok(pdf)
}

/// A staged PDF copied into the printed folder under its reserved name; the
/// copy is flushed before `before_rename` runs.
pub(super) fn copy_staged_pdf(
    printed: &Path,
    staged: &Path,
    stem: &str,
    before_rename: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<PathBuf, String> {
    private_dir(printed).map_err(|e| format!("cannot create the printed-jobs folder: {e}"))?;
    let pdf = reserve_pdf(printed, stem).map_err(|e| format!("cannot name the printed file: {e}"))?;
    let part = part_path(&pdf);
    let finished = (|| {
        let mut from = File::open(staged).map_err(|e| format!("cannot read the staged job: {e}"))?;
        let mut to = create_private(&part).map_err(|e| format!("cannot write the printed file: {e}"))?;
        io::copy(&mut from, &mut to)
            .and_then(|_| to.sync_all())
            .map_err(|e| format!("cannot write the printed file: {e}"))?;
        drop(to);
        before_rename(&pdf)?;
        std::fs::rename(&part, &pdf).map_err(|e| format!("could not finalize the printed file: {e}"))
    })();
    match finished {
        Ok(()) => Ok(pdf),
        Err(e) => {
            // A zero-byte PDF would look like a finished print and keep the
            // name taken.
            let _ = std::fs::remove_file(&part);
            let _ = std::fs::remove_file(&pdf);
            Err(e)
        }
    }
}

/// The layout options staged beside a document; none means the defaults.
pub(super) fn staged_layout(staged: &Path) -> Result<JobLayout, LayoutError> {
    match std::fs::read_to_string(layout_path(staged)) {
        Ok(text) => JobLayout::from_text(&text).map_err(LayoutError::Unparsed),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(JobLayout::default()),
        Err(e) if e.kind() == io::ErrorKind::InvalidData => {
            Err(LayoutError::Unparsed(format!("the print job's layout is not text: {e}")))
        }
        Err(e) => Err(LayoutError::Unreadable(format!("the print job's layout could not be read: {e}"))),
    }
}

/// Why a staged layout file gave no layout.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum LayoutError {
    /// The file was read and is not a layout this receiver writes.
    Unparsed(String),
    /// The file is there and could not be read; its options and the text
    /// job's character set are unknown.
    Unreadable(String),
}

/// The layout a delivery starts from: a layout that cannot be parsed is the
/// inner error, which `convert_with_layout` delivers without; one that cannot
/// be read keeps the job for the next start.
pub(super) fn delivery_layout(staged: &Path) -> Result<Result<JobLayout, String>, Failure> {
    match staged_layout(staged) {
        Ok(layout) => Ok(Ok(layout)),
        Err(LayoutError::Unparsed(e)) => Ok(Err(e)),
        Err(LayoutError::Unreadable(e)) => Err(Failure::Retry(e)),
    }
}

/// The CLI `printed-job` arguments that convert a staged document and apply
/// its layout, writing `output`.
pub(super) fn printed_job_args(staged: &Path, layout: &JobLayout, output: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec![
        "printed-job".into(),
        staged.into(),
        "--output".into(),
        output.into(),
        "--number-up".into(),
        layout.number_up.to_string().into(),
        "--number-up-layout".into(),
        layout.number_up_layout.clone().into(),
    ];
    if layout.reverse {
        args.push("--reverse".into());
    }
    if let Some((w, h)) = layout.sheet_points() {
        args.extend(["--sheet-width".into(), format!("{w:.2}").into()]);
        args.extend(["--sheet-height".into(), format!("{h:.2}").into()]);
    }
    if layout.page_set != "all" {
        args.extend(["--page-set".into(), layout.page_set.clone().into()]);
    }
    if let Some(charset) = &layout.charset {
        args.extend(["--charset".into(), charset.clone().into()]);
    }
    if !layout.page_ranges.is_empty() {
        args.extend(["--page-ranges".into(), ranges_text(&layout.page_ranges).into()]);
    }
    if layout.mirror {
        args.push("--mirror".into());
    }
    if let Some(scaling) = &layout.scaling {
        args.extend(["--scaling".into(), scaling.clone().into()]);
    }
    args
}

/// Convert a staged document with its layout through `run`, reporting what
/// delivery leaves out. A layout file that cannot be read, and a layout the
/// engine refuses (a job that needs a password, a page selection of no page),
/// deliver the document as sent with a report. A machine failure of the laid
/// out run is returned as it is, so the job waits rather than printing
/// without its options.
pub(super) fn convert_with_layout(
    layout: Result<JobLayout, String>,
    run: &dyn Fn(&JobLayout) -> Result<PathBuf, Failure>,
    report: &dyn Fn(String),
) -> Result<PathBuf, Failure> {
    let layout = layout.unwrap_or_else(|e| {
        report(format!("{e}; the print job was delivered without its layout options"));
        JobLayout::default()
    });
    if !layout.not_applied.is_empty() {
        report(format!(
            "the print job's {} option{} not applied",
            layout.not_applied.join(", "),
            if layout.not_applied.len() == 1 { " was" } else { "s were" }
        ));
    }
    if layout.is_plain() {
        return run(&layout);
    }
    match run(&layout) {
        Err(Failure::Refused(e)) => {
            let pdf = run(&layout.plain())?;
            report(format!(
                "the print job's layout ({}) could not be applied, so it was delivered as sent: {e}",
                layout.describe()
            ));
            Ok(pdf)
        }
        other => other,
    }
}

/// The `notes` array of a `printed-job` result on the CLI's standard output.
pub(super) fn result_notes(stdout: &[u8]) -> Vec<String> {
    serde_json::from_slice::<serde_json::Value>(stdout)
        .ok()
        .and_then(|result| result.get("notes").and_then(|n| n.as_array()).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|note| note.as_str().map(str::to_string))
        .collect()
}

/// A staged document as a printed PDF: a PDF without layout options as
/// received, everything else through the CLI `printed-job` arm, whose exit
/// code tells a refusal of the document from a machine failure. `report`
/// receives what the delivered PDF leaves out of the job.
fn convert_document(
    staged: &Path,
    stem: &str,
    before_rename: &dyn Fn(&Path) -> Result<(), String>,
    report: &dyn Fn(String),
) -> Result<PathBuf, Failure> {
    let extension = staged.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !staged_extension(extension) {
        return Err(Failure::Refused("the staged print job is in no format this printer takes".to_string()));
    }
    let run = |layout: &JobLayout| {
        if extension == "pdf" && layout.is_plain() {
            return copy_staged_pdf(&printed_dir(), staged, stem, before_rename).map_err(Failure::Retry);
        }
        private_dir(&printed_dir())
            .map_err(|e| Failure::Retry(format!("cannot create the printed-jobs folder: {e}")))?;
        match run_cli_conversion(stem, before_rename, &|part| printed_job_args(staged, layout, part)) {
            Ok((pdf, stdout)) => {
                for note in result_notes(&stdout) {
                    report(note);
                }
                Ok(pdf)
            }
            Err(failure) if failure.refused => Err(Failure::Refused(failure.message)),
            Err(failure) => Err(Failure::Retry(failure.message)),
        }
    };
    convert_with_layout(delivery_layout(staged)?, &run, report)
}

/// Deliver one staged document and settle `report`: a delivered document's
/// notes become the note, a failure the error. The delivery's ticket is taken
/// before it starts, so an error another delivery records meanwhile stays.
pub(super) fn deliver_reported(
    report: &Mutex<JobReport>,
    deliver: &dyn Fn(&dyn Fn(String)) -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    let ticket = report.lock().unwrap().begin();
    let notes: Mutex<Vec<String>> = Mutex::default();
    let result = deliver(&|note| notes.lock().unwrap().push(note));
    let mut report = report.lock().unwrap();
    match &result {
        Ok(_) => report.delivered(ticket, notes.into_inner().unwrap_or_default().join("; ")),
        Err(e) => report.failed(e.clone()),
    }
    result
}

// ── the queue's PPD ─────────────────────────────────────────────────────────

/// The sizes the queue offers: PWG 5101.1 name, PPD name, display text, and
/// the size in hundredths of millimetres.
pub(super) const PAGES: &[(&str, &str, &str, i32, i32)] = &[
    ("na_letter_8.5x11in", "Letter", "US Letter", 21590, 27940),
    ("na_legal_8.5x14in", "Legal", "US Legal", 21590, 35560),
    ("na_ledger_11x17in", "Tabloid", "Tabloid", 27940, 43180),
    ("na_executive_7.25x10.5in", "Executive", "Executive", 18415, 26670),
    ("iso_a3_297x420mm", "A3", "A3", 29700, 42000),
    ("iso_a4_210x297mm", "A4", "A4", 21000, 29700),
    ("iso_a5_148x210mm", "A5", "A5", 14800, 21000),
    ("iso_a6_105x148mm", "A6", "A6", 10500, 14800),
    ("iso_b5_176x250mm", "ISOB5", "B5 (ISO)", 17600, 25000),
    ("jis_b5_182x257mm", "B5", "B5 (JIS)", 18200, 25700),
    ("iso_dl_110x220mm", "EnvDL", "Envelope DL", 11000, 22000),
    ("na_number-10_4.125x9.5in", "Env10", "Envelope #10", 10478, 24130),
];

/// Hundredths of millimetres as PostScript points, two decimals at most.
fn points(hundredths_mm: i32) -> String {
    let text = format!("{:.2}", f64::from(hundredths_mm) * 72.0 / 2540.0);
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The queue's PPD (PPD 4.3 with the CUPS extensions of the CUPS PPD
/// Extensions specification): every size, a custom size from 1 to 48 inches,
/// colour, and the same `cupsFilter2` line a generated IPP Everywhere PPD
/// carries for a PDF printer. It offers no option a held job would ignore.
pub(super) fn queue_ppd(default_media: &str) -> String {
    let default = PAGES
        .iter()
        .find(|(pwg, ..)| *pwg == default_media)
        .map_or("A4", |(_, ppd, ..)| *ppd);
    let mut out = String::new();
    let mut line = |text: String| {
        out.push_str(&text);
        out.push('\n');
    };
    for fixed in [
        "*PPD-Adobe: \"4.3\"".to_string(),
        "*FormatVersion: \"4.3\"".to_string(),
        "*FileVersion: \"1.0\"".to_string(),
        "*LanguageVersion: English".to_string(),
        "*LanguageEncoding: ISOLatin1".to_string(),
        "*PCFileName: \"SPECTRA.PPD\"".to_string(),
        format!("*Manufacturer: \"{DESCRIPTION}\""),
        format!("*Product: \"({MAKE_AND_MODEL})\""),
        format!("*ModelName: \"{MAKE_AND_MODEL}\""),
        format!("*ShortNickName: \"{MAKE_AND_MODEL}\""),
        format!("*NickName: \"{MAKE_AND_MODEL}\""),
        "*PSVersion: \"(3010.000) 0\"".to_string(),
        "*LanguageLevel: \"3\"".to_string(),
        "*ColorDevice: True".to_string(),
        "*FileSystem: False".to_string(),
        "*cupsVersion: 1.6".to_string(),
        "*cupsLanguages: \"en\"".to_string(),
        "*cupsFilter2: \"application/vnd.cups-pdf application/pdf 10 -\"".to_string(),
    ] {
        line(fixed);
    }
    for keyword in ["PageSize", "PageRegion"] {
        line(format!("*OpenUI *{keyword}/Media Size: PickOne"));
        line(format!("*OrderDependency: 10 AnySetup *{keyword}"));
        line(format!("*Default{keyword}: {default}"));
        for (_, ppd, text, x, y) in PAGES {
            line(format!(
                "*{keyword} {ppd}/{text}: \"<</PageSize[{} {}]/ImagingBBox null>>setpagedevice\"",
                points(*x),
                points(*y)
            ));
        }
        line(format!("*CloseUI: *{keyword}"));
    }
    line(format!("*DefaultImageableArea: {default}"));
    for (_, ppd, text, x, y) in PAGES {
        line(format!("*ImageableArea {ppd}/{text}: \"0 0 {} {}\"", points(*x), points(*y)));
    }
    line(format!("*DefaultPaperDimension: {default}"));
    for (_, ppd, text, x, y) in PAGES {
        line(format!("*PaperDimension {ppd}/{text}: \"{} {}\"", points(*x), points(*y)));
    }
    for fixed in [
        "*HWMargins: \"0 0 0 0\"",
        "*ParamCustomPageSize Width: 1 points 72 3456",
        "*ParamCustomPageSize Height: 2 points 72 3456",
        "*ParamCustomPageSize WidthOffset: 3 points 0 0",
        "*ParamCustomPageSize HeightOffset: 4 points 0 0",
        "*ParamCustomPageSize Orientation: 5 int 0 3",
        "*CustomPageSize True: \"pop pop pop <</PageSize[5 -2 roll]/ImagingBBox null>>setpagedevice\"",
        "*DefaultResolution: 300dpi",
    ] {
        line(fixed.to_string());
    }
    out
}

/// A PPD file that exists while its guard lives.
struct PpdFile {
    path: PathBuf,
}

impl Drop for PpdFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A folder only this user can write that root can read on every file
/// system: `$XDG_RUNTIME_DIR` (a local folder of mode 0700 by the XDG Base
/// Directory Specification) when it qualifies, else the receiver's folder.
/// Root reads the PPD when lpadmin runs through pkexec, and a home folder on
/// a network file system may refuse root.
fn ppd_folder() -> Result<PathBuf, String> {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .filter(|dir| {
            std::fs::symlink_metadata(dir).is_ok_and(|meta| {
                meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0
            })
        });
    if let Some(dir) = runtime {
        return Ok(dir);
    }
    let layout = Layout::current()
        .ok_or_else(|| "The account has no home folder for the printer's settings.".to_string())?;
    prepare(&layout)?;
    Ok(layout.root)
}

fn write_ppd() -> Result<PpdFile, String> {
    let path = ppd_folder()?.join(format!(
        "spectrapdf-queue-{}-{}.ppd",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let text = queue_ppd(default_media_for_locale(&session_locale()));
    create_private(&path)
        .and_then(|mut file| file.write_all(text.as_bytes()).and_then(|()| file.sync_all()))
        .map_err(|e| {
            let _ = std::fs::remove_file(&path);
            format!("The printer settings file could not be written: {e}")
        })?;
    Ok(PpdFile { path })
}

// ── administration ──────────────────────────────────────────────────────────

/// lpadmin's arguments that create this user's held queue, or turn the queue
/// with its name into one. `-E` is absent on purpose: it would also enable
/// the queue (lpadmin(8)), and the queue stays stopped while it accepts jobs.
pub(super) fn configure_args(queue: &str, user: &str, location: &str, ppd: &Path) -> Vec<String> {
    vec![
        "-p".into(),
        queue.into(),
        "-D".into(),
        DESCRIPTION.into(),
        "-L".into(),
        location.into(),
        "-v".into(),
        SINK_URI.into(),
        "-P".into(),
        ppd.to_string_lossy().into_owned(),
        "-o".into(),
        "printer-is-shared=false".into(),
        "-o".into(),
        format!("printer-error-policy={ERROR_POLICY}"),
        "-o".into(),
        format!("printer-op-policy={HELD_OP_POLICY}"),
        "-o".into(),
        format!("job-hold-until-default={HOLD_INDEFINITE}"),
        "-o".into(),
        "job-sheets-default=none,none".into(),
        "-o".into(),
        "printer-is-accepting-jobs=true".into(),
        "-o".into(),
        format!("printer-state={PRINTER_STOPPED}"),
        "-u".into(),
        format!("allow:{user}"),
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

fn lpadmin() -> Result<PathBuf, String> {
    find_program("lpadmin").ok_or_else(|| {
        "The CUPS administration tool (lpadmin) is not installed, so the printer cannot be changed."
            .to_string()
    })
}

/// lpadmin as the user. `Err(None)` means the scheduler refused for lack of
/// rights; `Err(Some(_))` names any other failure.
fn administer_direct(args: &[String]) -> Result<(), Option<String>> {
    let ran = run_detached(&lpadmin().map_err(Some)?, args).map_err(Some)?;
    if ran.code == Some(0) {
        Ok(())
    } else if refused_for_rights(&ran.output) {
        Err(None)
    } else if ran.output.is_empty() {
        Err(Some("The print system did not accept the change.".to_string()))
    } else {
        Err(Some(ran.output))
    }
}

/// Run lpadmin as the user, then through pkexec when the scheduler refuses
/// for lack of rights.
fn administer(args: Vec<String>) -> Result<(), String> {
    let lpadmin = lpadmin()?;
    let manual = shell_line(&lpadmin, &args);
    match administer_direct(&args) {
        Ok(()) => return Ok(()),
        Err(Some(message)) => return Err(message),
        Err(None) => {}
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

/// Create or reconfigure this user's held queue in one lpadmin run, through
/// pkexec when `prompt` allows it.
fn configure(queue: &str, user: &str, location: &str, prompt: bool) -> Result<(), String> {
    let ppd = write_ppd()?;
    let args = configure_args(queue, user, location, &ppd.path);
    if prompt {
        administer(args)
    } else {
        administer_direct(&args).map_err(|failure| {
            failure.unwrap_or_else(|| "Changing the printer needs administrator rights.".to_string())
        })
    }
}

fn refusal_message(refusal: Refusal) -> String {
    match refusal {
        Refusal::Unavailable(e) => format!("The print system is not available: {e}"),
        Refusal::Denied(e) | Refusal::Failed(e) => format!("The print system did not answer: {e}"),
    }
}

pub(super) fn install(comment: &str) -> Result<(), String> {
    let user = current_user()
        .ok_or_else(|| "The current user has no entry in the password database.".to_string())?;
    let queue = queue_name(&user);
    let scheduler = SystemScheduler::open()?;
    let facts = queue_facts(&scheduler, &queue, &user).map_err(refusal_message)?;
    match classify(facts.as_ref(), &user) {
        QueueKind::Foreign(_) => {
            return Err(format!(
                "A different printer already uses the name {queue}; it was not changed."
            ))
        }
        QueueKind::Held if facts.as_ref().is_some_and(fully_configured) => return Ok(()),
        _ => {}
    }
    configure(&queue, &user, &queue_location(comment), true)?;
    let facts = queue_facts(&scheduler, &queue, &user).map_err(refusal_message)?;
    match (classify(facts.as_ref(), &user), facts) {
        (QueueKind::Held, Some(facts)) if fully_configured(&facts) => Ok(()),
        _ => Err("The printer was added but could not be verified.".to_string()),
    }
}

pub(super) fn uninstall() -> Result<(), String> {
    let user = current_user()
        .ok_or_else(|| "The current user has no entry in the password database.".to_string())?;
    let queue = queue_name(&user);
    let scheduler = SystemScheduler::open()?;
    let facts = queue_facts(&scheduler, &queue, &user).map_err(refusal_message)?;
    match classify(facts.as_ref(), &user) {
        QueueKind::Absent => Ok(()),
        QueueKind::Foreign(_) => Err(format!(
            "A different printer already uses the name {queue}; it was not removed."
        )),
        _ => administer(remove_args(&queue)),
    }
}

pub(super) fn status(app: &AppHandle) -> Result<VirtualPrinterStatus, String> {
    let user = current_user()
        .ok_or_else(|| "The current user has no entry in the password database.".to_string())?;
    let queue = queue_name(&user);
    let facts = SystemScheduler::open()
        .ok()
        .and_then(|scheduler| queue_facts(&scheduler, &queue, &user).ok())
        .flatten();
    let kind = classify(facts.as_ref(), &user);
    let state = app.state::<PrinterState>();
    let listener = state.listener_status.lock().unwrap().clone();
    let report = state.job_report.lock().unwrap().clone();
    Ok(VirtualPrinterStatus {
        installed: kind == QueueKind::Held && facts.as_ref().is_some_and(fully_configured),
        listener,
        last_job_error: report.error,
        last_job_note: report.note,
        printer_name: queue,
        replaced: false,
        legacy_present: kind == QueueKind::Legacy,
        staging: Layout::current()
            .map(|layout| layout.staging.to_string_lossy().into_owned())
            .unwrap_or_default(),
        service_error: String::new(),
    })
}

/// Turn a loopback-TCP queue of earlier releases into the held queue when the
/// scheduler lets this account do it without a prompt. Otherwise Settings
/// names the old queue and Install turns it.
fn retire_legacy_queue(scheduler: &dyn Scheduler, user: &str) {
    let queue = queue_name(user);
    let Ok(facts) = queue_facts(scheduler, &queue, user) else {
        return;
    };
    if classify(facts.as_ref(), user) != QueueKind::Legacy {
        return;
    }
    if let Err(e) = configure(&queue, user, DEFAULT_LOCATION, false) {
        eprintln!("virtual printer: the earlier printer {queue} was not replaced: {e}");
    }
}

// ── the receiver ────────────────────────────────────────────────────────────

fn set_listener(app: &AppHandle, text: &str) {
    if let Some(state) = app.try_state::<PrinterState>() {
        *state.listener_status.lock().unwrap() = text.to_string();
    }
}

fn record_job_error(app: &AppHandle, message: String) {
    eprintln!("virtual printer: {message}");
    if let Some(state) = app.try_state::<PrinterState>() {
        state.job_report.lock().unwrap().failed(message);
    }
}

/// Start the receiver: the app-setup hook. Never panics: every failure is a
/// named listener status in Settings.
pub(super) fn start_listener(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let Some(user) = current_user() else {
            return set_listener(&handle, "the current user has no entry in the password database");
        };
        let Some(layout) = Layout::current() else {
            return set_listener(&handle, "the account has no home folder for the printer's jobs");
        };
        if let Err(e) = prepare(&layout) {
            return set_listener(&handle, &format!("the printer folder cannot be prepared: {e}"));
        }
        let claim = loop {
            match claim_receiver(&layout.lock) {
                Ok(claim) => break claim,
                Err(ClaimFailure::HeldElsewhere) => {
                    set_listener(&handle, HELD_ELSEWHERE);
                    std::thread::sleep(CLAIM_RETRY);
                }
                Err(ClaimFailure::Failed(e)) => {
                    return set_listener(&handle, &format!("the printer folder cannot be prepared: {e}"))
                }
            }
        };
        let scheduler = match SystemScheduler::open() {
            Ok(scheduler) => scheduler,
            Err(e) => return set_listener(&handle, &e),
        };
        scheduler.cups.refuse_password_prompts();
        let printed = printed_dir();
        if let Err(e) = private_dir(&printed) {
            return set_listener(&handle, &format!("the printed-jobs folder cannot be prepared: {e}"));
        }
        reclaim_job_intermediates(&printed);
        reclaim_staging(&layout.staging, &layout.ledger);
        retire_legacy_queue(&scheduler, &user);
        set_listener(&handle, "listening");
        run(&layout, &user, &scheduler, claim, handle.clone());
    });
}

fn run(layout: &Layout, user: &str, scheduler: &SystemScheduler, _claim: ReceiverClaim, app: AppHandle) -> ! {
    let queue = queue_name(user);
    let mut taker = Taker::default();
    let attempted: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();
    let record_error = |message: String| record_job_error(&app, message);
    let expand = |from: &Path, to: &mut dyn Write, limit: u64| scheduler.cups.expand_into(from, to, limit);
    let mut shown = "listening".to_string();
    loop {
        let pass = Pass {
            scheduler,
            user,
            queue: &queue,
            staging: &layout.staging,
            ledger: &layout.ledger,
            record_error: &record_error,
            expand: &expand,
        };
        let listener = match take_jobs(&pass, &mut taker) {
            Ok(QueueKind::Drifted) => format!(
                "the settings of {queue} no longer hold its jobs for this account; install the printer again"
            ),
            Ok(QueueKind::Foreign(_)) => format!("a different printer uses the name {queue}"),
            Ok(_) => "listening".to_string(),
            Err(e) => format!("{SERVICE_UNAVAILABLE}: {e}"),
        };
        if listener != shown {
            set_listener(&app, &listener);
            shown = listener;
        }
        let deliver = |stem: String, staged: PathBuf| {
            IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
            let app = app.clone();
            let ledger = layout.ledger.clone();
            let attempted = Arc::clone(&attempted);
            std::thread::spawn(move || {
                let _slot = JobSlot;
                let open = |pdf: &Path| open_printed(&app, pdf);
                let deliver = |report: &dyn Fn(String)| {
                    let convert = |staged: &Path, stem: &str, before: &dyn Fn(&Path) -> Result<(), String>| {
                        convert_document(staged, stem, before, report)
                    };
                    deliver_one(&ledger, &printed_dir(), &staged, &stem, &convert, &open)
                };
                let Some(state) = app.try_state::<PrinterState>() else {
                    return;
                };
                match deliver_reported(&state.job_report, &deliver) {
                    // A staged document that is still on disk stays
                    // attempted, so this process does not open its PDF twice.
                    Ok(_) => {
                        if !staged.exists() {
                            attempted.lock().unwrap().remove(&staged);
                        }
                    }
                    Err(e) => {
                        eprintln!("virtual printer: {e}");
                        if !staged.exists() {
                            attempted.lock().unwrap().remove(&staged);
                        }
                    }
                }
            });
        };
        deliver_staged(&layout.staging, &attempted, &record_error, &deliver);
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
#[path = "print_to_pdf_linux_tests.rs"]
mod tests;
