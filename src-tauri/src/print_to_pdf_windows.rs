//! The Windows receiver.
//!
//! The printer is a per-account queue on the in-box PS class driver that
//! holds its jobs: paused, raw-only, keeping printed jobs, on the `NUL:` port.
//! No process listens anywhere, so no other process can stand in for this one.
//! This process reads each finished job of its own queue straight from the
//! spooler, stages the bytes in a private folder, and then deletes the job.
//!
//! Each job is its own spool file, so one job never overwrites another. A job
//! handle (`"<queue>, Job <id>"`, MS-RPRN 2.2.4.14) is readable with
//! `ReadPrinter` (MS-RPRN 3.1.4.9.6) only by a caller holding JOB_READ on that
//! job (MS-RPRN 2.2.3.1 and its product note 376), and the spooler grants
//! JOB_READ to the job's submitter (MS-RPRN 3.1.1, product note 238). A job
//! that another account manages to queue is unreadable here and is never
//! delivered. The queue's DACL grants Print to the owning account alone and
//! keeps the AppContainer entries that Windows gives every queue.
//!
//! Raw-only spooling (PRINTER_ATTRIBUTE_RAW_ONLY) makes the spooled data the
//! driver's PostScript. An enhanced-metafile job is not PostScript, so a job
//! whose datatype is not RAW is refused.
//!
//! The pause holds a job before it reaches the port. A job that is released
//! anyway (an administrator resumes the queue, or a spooler restart does not
//! restore the pause) goes to `NUL:`, which delivers it to nobody, and the
//! queue keeps the printed job (PRINTER_ATTRIBUTE_KEEPPRINTEDJOBS), so this
//! process still reads it.
//!
//! A job is read once. A ledger in the private folder records each job as
//! taken, by submission time and id, before the job is deleted, and keeps the
//! entry until a full listing of its queue no longer shows the job. A job that
//! the spooler does not delete (a retained job, or one whose delete right went
//! to an elevated token) is never staged or delivered a second time, across
//! restarts too. Delivery records each printed PDF in the same ledger before
//! the PDF takes its final name, so a process stopped after that point opens
//! the existing PDF on its next start instead of distilling a second copy.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Write;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{ERROR_HANDLE_EOF, ERROR_NO_MORE_ITEMS, ERROR_PRINT_CANCELLED};
use windows::Win32::Graphics::Printing::{
    JOB_STATUS_DELETED, JOB_STATUS_DELETING, JOB_STATUS_SPOOLING,
    PRINTER_ATTRIBUTE_KEEPPRINTEDJOBS, PRINTER_ATTRIBUTE_RAW_ONLY,
};

use super::{
    convert_staged, open_printed, printed_dir, reclaim_job_intermediates, JobSlot, PrinterState,
    VirtualPrinterStatus, IN_FLIGHT, MAX_CONCURRENT_JOBS, MAX_JOB_BYTES, PRINTED_PREFIX,
    PRINTER_NAME,
};

/// The queue and port of releases that delivered jobs over loopback TCP.
pub(super) const LEGACY_PORT_NAME: &str = "SpectraPDF_9100";
const LEGACY_PORT_NUMBER: u16 = 9100;
const DRIVER_NAME: &str = "Microsoft PS Class Driver";
/// The port of every held queue. A job that leaves the queue reaches no
/// process through it.
pub(super) const HOLD_PORT: &str = "NUL:";
const HELD_ATTRIBUTES: u32 = PRINTER_ATTRIBUTE_RAW_ONLY | PRINTER_ATTRIBUTE_KEEPPRINTEDJOBS;
/// In the 32-bit registry view (WOW6432Node on 64-bit Windows): the scripts
/// open it through `Registry32` and this module through `KEY_WOW64_32KEY`.
/// The installer's product keys live in the 64-bit view; a real uninstall
/// removes the empty 32-bit parents this key leaves behind.
const MARKER_KEY: &str = r"SOFTWARE\Jason Ulbright\Spectra PDF\VirtualPrinter";
/// The queue's Comment when the app passes none.
const DEFAULT_QUEUE_COMMENT: &str = "Held for Spectra PDF; jobs open in the app";
/// The install script carries the comment base64-encoded inside a command
/// that is base64-encoded again; this bound keeps that command under the
/// Windows command-line limit.
const MAX_COMMENT_CHARS: usize = 120;
const INSTALL_FAILED: &str = "The printer was not installed";
const REMOVE_FAILED: &str = "The printer was not removed";
const SERVICE_UNAVAILABLE: &str = "the Windows print service is not available";

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const CLAIM_RETRY: Duration = Duration::from_secs(5);
/// A job that keeps failing is named at its first failure and left alone
/// after this many passes.
const MAX_READ_ATTEMPTS: u32 = 3;
/// Jobs beyond this many are taken in a later pass, once earlier ones are
/// deleted.
const MAX_JOBS_PER_PASS: u32 = 4096;
const MAX_ENUM_BUFFER_BYTES: usize = 64 * 1024 * 1024;
const READ_CHUNK: usize = 64 * 1024;

const APP_DIR: &str = "com.spectrapdf.app";
const PRINTER_DIR: &str = "virtual-printer";
const STAGING_DIR: &str = "staging";
const LEDGER_DIR: &str = "ledger";
const LOCK_FILE: &str = "receiver.lock";
const ACKNOWLEDGED_FILE: &str = "replaced-acknowledged";
const PART_SUFFIX: &str = ".part";
/// Ledger entry: the job's data is staged or delivered, so the job is never
/// read again while its queue lists it. The content is the queue's name.
const TAKEN_SUFFIX: &str = ".taken";
/// A ledger entry before its rename into place; never counts as an entry.
const ENTRY_TEMP_SUFFIX: &str = ".new";
/// Ledger entry: the file name of a staged job's printed PDF, written before
/// the PDF takes that name.
const DELIVERED_SUFFIX: &str = ".delivered";

pub(super) const HELD_ELSEWHERE: &str =
    "another Spectra PDF window of this Windows account is receiving the printer's jobs";

const ERROR_SHARING_VIOLATION: i32 = 32;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Layout {
    pub root: PathBuf,
    pub staging: PathBuf,
    pub ledger: PathBuf,
    pub lock: PathBuf,
    pub acknowledged: PathBuf,
}

impl Layout {
    pub fn under(local_app_data: &Path) -> Self {
        let root = local_app_data.join(APP_DIR).join(PRINTER_DIR);
        Self {
            staging: root.join(STAGING_DIR),
            ledger: root.join(LEDGER_DIR),
            lock: root.join(LOCK_FILE),
            acknowledged: root.join(ACKNOWLEDGED_FILE),
            root,
        }
    }

    fn current() -> Self {
        Self::under(&crate::shell_action::local_app_data())
    }
}

/// A SID string fit to embed in a script: `S-1-` and decimal fields only.
pub(super) fn is_account_sid(sid: &str) -> bool {
    let Some(rest) = sid.strip_prefix("S-1-") else {
        return false;
    };
    let fields: Vec<&str> = rest.split('-').collect();
    (2..=16).contains(&fields.len())
        && fields
            .iter()
            .all(|f| !f.is_empty() && f.len() <= 15 && f.bytes().all(|b| b.is_ascii_digit()))
}

/// This account and SYSTEM, full control, inherited by every child; nothing
/// inherited from the profile above.
pub(super) fn folder_sddl(sid: &str) -> String {
    format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)")
}

/// Printer names refuse `\` and `,`; the account name is display text only.
pub(super) fn printer_name_label(user: &str) -> String {
    let label: String = user
        .chars()
        .filter(|c| !matches!(c, '\\' | ',') && !c.is_control())
        .take(64)
        .collect();
    let label = label.trim();
    if label.is_empty() {
        "user".to_string()
    } else {
        label.to_string()
    }
}

/// The queue's Comment: display text from the app without control
/// characters, cut to its bound; the English text when nothing is left.
pub(super) fn queue_comment(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_COMMENT_CHARS)
        .collect();
    let kept = kept.trim();
    if kept.is_empty() {
        DEFAULT_QUEUE_COMMENT.to_string()
    } else {
        kept.to_string()
    }
}

#[derive(Debug, Clone)]
pub(super) struct Account {
    pub sid: String,
    pub user_name: String,
}

impl Account {
    pub fn current() -> Result<Self, String> {
        let sid = crate::scheduler::current_user_sid()
            .filter(|sid| is_account_sid(sid))
            .ok_or_else(|| "The Windows account identity could not be read.".to_string())?;
        let user_name = printer_name_label(&std::env::var("USERNAME").unwrap_or_default());
        Ok(Self { sid, user_name })
    }
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(text.as_bytes())
}

// ── queues and jobs ────────────────────────────────────────────────────────

/// What the spooler reports about one local queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct QueueFacts {
    pub name: String,
    pub driver: String,
    pub port: String,
    pub attributes: u32,
    /// The accounts and groups that a queue-level allow entry grants Print,
    /// directly or through a generic right.
    pub print_grantees: Vec<String>,
    /// False when the security of a queue that looks held could not be read:
    /// `print_grantees` is then empty, so the queue is nobody's for that pass.
    pub grantees_known: bool,
}

pub(super) fn is_held_queue(queue: &QueueFacts) -> bool {
    queue.driver.eq_ignore_ascii_case(DRIVER_NAME)
        && queue.port.eq_ignore_ascii_case(HOLD_PORT)
        && queue.attributes & HELD_ATTRIBUTES == HELD_ATTRIBUTES
}

/// A held queue this account can print to.
pub(super) fn is_own_queue(queue: &QueueFacts, sid: &str) -> bool {
    is_held_queue(queue)
        && queue
            .print_grantees
            .iter()
            .any(|grantee| grantee.eq_ignore_ascii_case(sid))
}

/// A queue with the loopback releases' driver and port name. The scripts
/// also require the port to be the loopback RAW port; `legacy_confirmed`
/// applies that test.
pub(super) fn is_legacy_candidate(queue: &QueueFacts) -> bool {
    queue.driver.eq_ignore_ascii_case(DRIVER_NAME)
        && queue.port.eq_ignore_ascii_case(LEGACY_PORT_NAME)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct JobFacts {
    pub id: u32,
    pub status: u32,
    pub datatype: String,
    /// Milliseconds since the Unix epoch.
    pub submitted_ms: u64,
    /// The spooled size in bytes, as the spooler reports it.
    pub size: u64,
}

/// A job still spooling has no final length; a deleting job has no future.
pub(super) fn job_is_complete(status: u32) -> bool {
    status & (JOB_STATUS_SPOOLING | JOB_STATUS_DELETING | JOB_STATUS_DELETED) == 0
}

/// `RAW` and its form-feed variants (`RAW [FF appended]`, `RAW [FF auto]`)
/// differ only in what the print processor adds while printing; the spooled
/// bytes are the driver's own.
pub(super) fn datatype_is_raw(datatype: &str) -> bool {
    let datatype = datatype.trim();
    datatype.len() >= 3
        && datatype.as_bytes()[..3].eq_ignore_ascii_case(b"RAW")
        && (datatype.len() == 3 || datatype.as_bytes()[3] == b' ')
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReadFailure {
    /// This account holds no JOB_READ on the job: another account, or this
    /// account through an elevated app, submitted it.
    Denied,
    /// The job left the queue while it was read.
    Gone,
    Failed(String),
}

/// The spooler calls the receiver makes.
pub(super) trait Spooler {
    fn queues(&self) -> Result<Vec<QueueFacts>, String>;
    fn jobs(&self, queue: &str) -> Result<Vec<JobFacts>, String>;
    /// Copy the job's spooled data into `sink`, stopping once more than
    /// `limit` bytes were copied.
    fn read_job(
        &self,
        queue: &str,
        job: &JobFacts,
        sink: &mut dyn Write,
        limit: u64,
    ) -> Result<u64, ReadFailure>;
    fn delete_job(&self, queue: &str, job: u32) -> Result<(), String>;
}

/// How a failed ReadPrinter call ends a read.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReadEnd {
    Complete,
    Gone,
    Failed,
}

/// ERROR_HANDLE_EOF and ERROR_NO_MORE_ITEMS name the end of the data. An
/// error that arrives once the job's whole spooled size is read also ends a
/// complete read: no data is missing.
pub(super) fn read_error_end(code: u32, read: u64, size: u64) -> ReadEnd {
    if code == ERROR_PRINT_CANCELLED.0 {
        ReadEnd::Gone
    } else if code == ERROR_HANDLE_EOF.0
        || code == ERROR_NO_MORE_ITEMS.0
        || (size > 0 && read >= size)
    {
        ReadEnd::Complete
    } else {
        ReadEnd::Failed
    }
}

/// Copy a job's data into `sink` through `read`, which fills a buffer and
/// returns the byte count or a Win32 error code, until the data ends or more
/// than `limit` bytes were copied.
pub(super) fn copy_job_data(
    read: &mut dyn FnMut(&mut [u8]) -> Result<u32, u32>,
    size: u64,
    sink: &mut dyn Write,
    limit: u64,
) -> Result<u64, ReadFailure> {
    let mut buffer = vec![0u8; READ_CHUNK];
    let mut total = 0u64;
    loop {
        let room = limit.saturating_add(1).saturating_sub(total);
        if room == 0 {
            return Ok(total);
        }
        let want = room.min(buffer.len() as u64) as usize;
        match read(&mut buffer[..want]) {
            Ok(0) => return Ok(total),
            Ok(count) => {
                let count = (count as usize).min(want);
                sink.write_all(&buffer[..count])
                    .map_err(|e| ReadFailure::Failed(format!("cannot stage the job: {e}")))?;
                total += count as u64;
            }
            Err(code) => {
                return match read_error_end(code, total, size) {
                    ReadEnd::Complete => Ok(total),
                    ReadEnd::Gone => Err(ReadFailure::Gone),
                    ReadEnd::Failed => Err(ReadFailure::Failed(
                        std::io::Error::from_raw_os_error(code as i32).to_string(),
                    )),
                }
            }
        }
    }
}

/// What a receiver remembers between passes, by staged name.
pub(super) struct Taker {
    /// Jobs taken, refused or given up on by this process.
    passed: HashSet<String>,
    failures: HashMap<String, u32>,
    /// Writes a job's ledger entry (path, queue name).
    write_entry: fn(&Path, &[u8]) -> std::io::Result<()>,
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

/// The staged file of one job. Its name carries the job's submission time
/// in milliseconds and its id: a job id is unique only among the jobs
/// present, and the pair is the job's key in the ledger. The stem is the
/// printed PDF's name.
pub(super) fn staged_name(job: &JobFacts) -> String {
    format!(
        "{PRINTED_PREFIX}{}-{:03}{:010}.ps",
        job.submitted_ms / 1000,
        job.submitted_ms % 1000,
        job.id
    )
}

/// The output stem of a staged job: its name without the `-<key>.ps` tail.
pub(super) fn stem_of(staged: &Path) -> Option<String> {
    let name = staged.file_name()?.to_str()?;
    let rest = name.strip_suffix(".ps")?;
    let (stem, key) = rest.rsplit_once('-')?;
    if !stem.starts_with(PRINTED_PREFIX)
        || key.is_empty()
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    Some(stem.to_string())
}

fn part_path(staged: &Path) -> PathBuf {
    let mut name = staged.file_name().unwrap_or_default().to_os_string();
    name.push(PART_SUFFIX);
    staged.with_file_name(name)
}

fn ledger_entry(ledger: &Path, staged_name: &str, suffix: &str) -> PathBuf {
    ledger.join(format!("{staged_name}{suffix}"))
}

/// Create `path` holding `contents`, on disk before this returns. A write or
/// flush that fails removes the file again.
fn write_durable(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut file = File::create(path)?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    if written.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Rename `from` to `to`, on disk before this returns. An existing `to` is
/// refused.
fn rename_durable(from: &Path, to: &Path) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
    let from = wide(from.as_os_str());
    let to = wide(to.as_os_str());
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(std::io::Error::other)
}

/// Write a ledger entry under a temporary name and rename it into place, so
/// the entry exists whole or not at all.
fn write_entry_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
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
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

/// The receiver's view of one pass.
struct Pass<'a> {
    spooler: &'a dyn Spooler,
    staging: &'a Path,
    ledger: &'a Path,
    record_error: &'a dyn Fn(String),
}

/// What one pass saw, for the ledger. Queue names are lowercase: printer
/// names compare without case.
#[derive(Default)]
struct Seen {
    /// Every local queue, own or not.
    queues: HashSet<String>,
    /// Own queues whose jobs were listed in full.
    listed: HashSet<String>,
    /// The pass can drop entries: it found an own queue, read the security
    /// of every queue that looks held, and listed every own queue in full.
    complete: bool,
    /// The staged names of the jobs listed.
    jobs: HashSet<String>,
}

/// One pass over this account's queues: stage every finished job, record it
/// in the ledger, and delete it from its queue. Returns the queues read, or
/// why the print service listed none.
pub(super) fn take_jobs(
    spooler: &dyn Spooler,
    sid: &str,
    staging: &Path,
    ledger: &Path,
    taker: &mut Taker,
    record_error: &dyn Fn(String),
) -> Result<Vec<String>, String> {
    let pass = Pass {
        spooler,
        staging,
        ledger,
        record_error,
    };
    let queues = spooler.queues()?;
    let own: Vec<String> = queues
        .iter()
        .filter(|queue| is_own_queue(queue, sid))
        .map(|queue| queue.name.clone())
        .collect();
    // A queue whose security could not be read hides its jobs for this pass,
    // and a pass without an own queue lists no job at all: neither can tell
    // that a job left its queue.
    let mut seen = Seen {
        queues: queues
            .iter()
            .map(|queue| queue.name.to_lowercase())
            .collect(),
        complete: !own.is_empty()
            && queues
                .iter()
                .all(|queue| queue.grantees_known || !is_held_queue(queue)),
        ..Seen::default()
    };
    for queue in &own {
        let jobs = match spooler.jobs(queue) {
            Ok(jobs) => jobs,
            Err(e) => {
                seen.complete = false;
                record_error(format!("the jobs of {queue} could not be listed: {e}"));
                continue;
            }
        };
        if jobs.len() >= MAX_JOBS_PER_PASS as usize {
            seen.complete = false;
        } else {
            seen.listed.insert(queue.to_lowercase());
        }
        for job in jobs {
            let name = staged_name(&job);
            take_one(&pass, queue, &job, &name, taker);
            seen.jobs.insert(name);
        }
    }
    taker.passed.retain(|name| seen.jobs.contains(name));
    taker.failures.retain(|name, _| seen.jobs.contains(name));
    if seen.complete {
        prune_ledger(ledger, &seen);
    }
    Ok(own)
}

fn take_one(pass: &Pass, queue: &str, job: &JobFacts, name: &str, taker: &mut Taker) {
    if taker.passed.contains(name) || !job_is_complete(job.status) {
        return;
    }
    if !datatype_is_raw(&job.datatype) {
        (pass.record_error)(match pass.spooler.delete_job(queue, job.id) {
            Ok(()) => format!(
                "a print job arrived as {} data instead of PostScript and was removed from {queue}",
                job.datatype
            ),
            Err(e) => format!(
                "a print job arrived as {} data instead of PostScript and could not be removed from {queue}: {e}",
                job.datatype
            ),
        });
        taker.passed.insert(name.to_string());
        return;
    }
    let taken = ledger_entry(pass.ledger, name, TAKEN_SUFFIX);
    if !taken.exists() {
        let staged = pass.staging.join(name);
        let ready = if staged.exists() {
            // Staging writes the entry before the staged name, so this copy
            // came from elsewhere; it is recorded like a fresh one.
            record_taken(pass, taker, queue, name, &taken, &staged)
        } else {
            stage_job(pass, queue, job, name, &taken, &staged, taker)
        };
        if !ready {
            return;
        }
    }
    remove_from_queue(pass, queue, job, name, taker);
}

/// Write the job's ledger entry, naming its queue. When the write fails, the
/// copy of the job's data goes too, but only once the entry is gone: a copy
/// without an entry would be delivered while a later pass reads the job
/// again, and an entry without a copy would let that pass delete the job.
/// Returns whether the entry is there.
fn record_taken(
    pass: &Pass,
    taker: &mut Taker,
    queue: &str,
    name: &str,
    taken: &Path,
    copy: &Path,
) -> bool {
    let Err(e) = (taker.write_entry)(taken, queue.as_bytes()) else {
        return true;
    };
    failed_attempt(
        pass,
        taker,
        name,
        format!("the print job could not be recorded as taken: {e}"),
    );
    if removed(taken) {
        let _ = std::fs::remove_file(copy);
        false
    } else {
        true
    }
}

/// Read the job and stage it: the data is flushed under a `.part` name, the
/// ledger entry is written, and only then does the data take its staged
/// name. True once the job needs nothing more from its queue: its data is
/// staged, or it was empty or over the limit and is dropped. A read that ends
/// before the job's spooled size stages nothing and keeps the job.
fn stage_job(
    pass: &Pass,
    queue: &str,
    job: &JobFacts,
    name: &str,
    taken: &Path,
    staged: &Path,
    taker: &mut Taker,
) -> bool {
    let part = part_path(staged);
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
    {
        Ok(file) => file,
        Err(e) => {
            failed_attempt(
                pass,
                taker,
                name,
                format!("the print job could not be staged: {e}"),
            );
            return false;
        }
    };
    let read = pass.spooler.read_job(queue, job, &mut file, MAX_JOB_BYTES);
    match read {
        Ok(bytes) if bytes > MAX_JOB_BYTES => {
            drop(file);
            let _ = std::fs::remove_file(&part);
            (pass.record_error)(format!(
                "a print job in {queue} is over the {MAX_JOB_BYTES}-byte limit and was not converted"
            ));
            write_or_name(pass, taker, queue, name, taken)
        }
        Ok(bytes) if bytes < job.size => {
            drop(file);
            let _ = std::fs::remove_file(&part);
            failed_attempt(
                pass,
                taker,
                name,
                format!(
                    "a print job in {queue} could not be read in full ({bytes} of {} bytes); it stays in the queue",
                    job.size
                ),
            );
            false
        }
        Ok(0) => {
            drop(file);
            let _ = std::fs::remove_file(&part);
            write_or_name(pass, taker, queue, name, taken)
        }
        Ok(_) => {
            let flushed = file.sync_all();
            drop(file);
            if let Err(e) = flushed {
                let _ = std::fs::remove_file(&part);
                failed_attempt(
                    pass,
                    taker,
                    name,
                    format!("the print job could not be staged: {e}"),
                );
                return false;
            }
            if !record_taken(pass, taker, queue, name, taken, &part) {
                return false;
            }
            if let Err(e) = rename_durable(&part, staged) {
                failed_attempt(
                    pass,
                    taker,
                    name,
                    format!("the print job could not be staged: {e}"),
                );
                // With the entry gone the job is read again later. An entry
                // that stays keeps the `.part`, which the next start renames
                // into place.
                if removed(taken) {
                    let _ = std::fs::remove_file(&part);
                }
                return false;
            }
            true
        }
        Err(failure) => {
            drop(file);
            let _ = std::fs::remove_file(&part);
            match failure {
                ReadFailure::Denied => {
                    taker.passed.insert(name.to_string());
                    (pass.record_error)(format!(
                        "a print job in {queue} was sent by another account or by an app running as administrator; it cannot be read and stays in the queue"
                    ));
                }
                ReadFailure::Gone => failed_attempt(
                    pass,
                    taker,
                    name,
                    format!("a print job was removed from {queue} before it could be read"),
                ),
                ReadFailure::Failed(e) => failed_attempt(
                    pass,
                    taker,
                    name,
                    format!("the print job could not be read from {queue}: {e}"),
                ),
            }
            false
        }
    }
}

/// The entry of a job dropped without a copy (empty, or over the limit).
fn write_or_name(pass: &Pass, taker: &mut Taker, queue: &str, name: &str, taken: &Path) -> bool {
    match (taker.write_entry)(taken, queue.as_bytes()) {
        Ok(()) => true,
        Err(e) => {
            failed_attempt(
                pass,
                taker,
                name,
                format!("the print job could not be recorded as taken: {e}"),
            );
            !removed(taken)
        }
    }
}

/// Count one failed attempt at a job. The first failure is named; after the
/// last attempt this process leaves the job alone.
fn failed_attempt(pass: &Pass, taker: &mut Taker, name: &str, message: String) {
    let attempts = {
        let count = taker.failures.entry(name.to_string()).or_insert(0);
        *count += 1;
        *count
    };
    if attempts == 1 {
        (pass.record_error)(message);
    }
    if attempts >= MAX_READ_ATTEMPTS {
        taker.passed.insert(name.to_string());
    }
}

/// Delete a taken job from its queue, once per process: its ledger entry
/// already keeps it from being read again.
fn remove_from_queue(pass: &Pass, queue: &str, job: &JobFacts, name: &str, taker: &mut Taker) {
    if let Err(e) = pass.spooler.delete_job(queue, job.id) {
        (pass.record_error)(format!(
            "the print job was taken but stays in {queue}, because Windows did not remove it: {e}. It is not taken a second time."
        ));
    }
    taker.passed.insert(name.to_string());
}

/// Drop the entries of jobs that can never be read again; runs only after a
/// complete pass (see `Seen::complete`). An entry names its queue and goes
/// once that queue was listed in full without the job. The entry of a queue
/// that still exists but was not listed (no longer this account's, for
/// example) stays. An entry whose queue is gone, or that names none, goes
/// once the job is in no listed queue.
fn prune_ledger(ledger: &Path, seen: &Seen) {
    let Ok(entries) = std::fs::read_dir(ledger) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(staged) = file_name
            .to_str()
            .and_then(|name| name.strip_suffix(TAKEN_SUFFIX))
        else {
            continue;
        };
        if seen.jobs.contains(staged) {
            continue;
        }
        let queue = std::fs::read_to_string(entry.path())
            .unwrap_or_default()
            .to_lowercase();
        if seen.listed.contains(&queue) || queue.is_empty() || !seen.queues.contains(&queue) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Hand every staged job not yet attempted by this process to `deliver`, up
/// to the concurrency cap. Staging writes each job's ledger entry before the
/// staged name exists, so delivering a staged file never lets its job be read
/// again. Staged jobs a stopped process left behind are delivered again,
/// never discarded.
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

/// Distils a staged job and returns the printed PDF; `before_rename` runs
/// once the PDF is complete and before it takes its final name.
pub(super) type Convert<'a> =
    &'a dyn Fn(&Path, &str, &dyn Fn(&Path) -> Result<(), String>) -> Result<PathBuf, String>;

/// Deliver one staged job: distil it, open the PDF, then drop the staged
/// file. The PDF's file name goes into the ledger before the PDF takes that
/// name, so after a stop past that point the next start opens the existing
/// PDF instead of distilling a second copy. On failure the staged job stays
/// for the next start, and the message says so.
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
    let earlier = std::fs::read_to_string(&record)
        .ok()
        .map(|file_name| file_name.trim().to_string())
        .filter(|file_name| !file_name.is_empty() && !file_name.contains(['\\', '/', ':']))
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
                Err(e) => {
                    let _ = std::fs::remove_file(&record);
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
    // next start opens this PDF again rather than distilling the job twice.
    if std::fs::remove_file(staged).is_ok() || !staged.exists() {
        let _ = std::fs::remove_file(&record);
    }
    Ok(pdf)
}

// ── what Settings shows ────────────────────────────────────────────────────

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct AccountView {
    pub installed: bool,
    pub name: Option<String>,
    pub legacy_present: bool,
}

/// `legacy_present` holds the candidate test only; `status` confirms it.
pub(super) fn account_view(queues: &[QueueFacts], sid: Option<&str>) -> AccountView {
    let mut own: Vec<&str> = queues
        .iter()
        .filter(|queue| sid.is_some_and(|sid| is_own_queue(queue, sid)))
        .map(|queue| queue.name.as_str())
        .collect();
    own.sort_unstable();
    AccountView {
        installed: !own.is_empty(),
        name: own.first().map(|name| name.to_string()),
        legacy_present: queues.iter().any(is_legacy_candidate),
    }
}

/// The scripts' loopback test, run against the installed queues. A check
/// that cannot run counts the candidate as the loopback queue.
fn legacy_confirmed() -> bool {
    super::run_powershell(&[&legacy_probe_script()]).map_or(true, |out| legacy_answer(&out))
}

pub(super) fn legacy_answer(out: &str) -> bool {
    !out.lines().any(|line| line.trim() == "legacy=no")
}

/// The update notice: the installer removed the machine's loopback queue,
/// none is left, and this account has neither installed nor removed its own
/// printer since.
pub(super) fn replaced_notice(marker: bool, view: &AccountView, acknowledged: bool) -> bool {
    marker && !view.legacy_present && !view.installed && !acknowledged
}

fn replaced_marker_set() -> bool {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(MARKER_KEY, KEY_READ | KEY_WOW64_32KEY)
        .and_then(|key| key.get_value::<u32, _>("Replaced"))
        .map(|value| value == 1)
        .unwrap_or(false)
}

fn acknowledge(layout: &Layout) {
    if std::fs::create_dir_all(&layout.root).is_ok() {
        let _ = std::fs::write(&layout.acknowledged, b"");
    }
}

// ── PowerShell scripts ─────────────────────────────────────────────────────
//
// Every account-specific value travels base64-encoded, so each script stays
// ASCII and no value can close a quote. Printers are changed and removed
// through the objects Get-Printer returns, never by name: the name
// parameters of Set-Printer and Remove-Printer take wildcards.

pub(super) const MARKER_FUNCTIONS: &str = r#"function Open-SpMarkers($write) {
$b = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry32')
try { if ($write) { $b.CreateSubKey('__MARKER_KEY__') } else { $b.OpenSubKey('__MARKER_KEY__', $true) } } finally { $b.Dispose() }
}
function Set-SpMarker($n) { $k = Open-SpMarkers $true; try { $k.SetValue($n, 1, 'DWord') } finally { $k.Dispose() } }
function Test-SpMarker($n) { $k = Open-SpMarkers $false; if ($null -eq $k) { return $false }; try { [int]$k.GetValue($n, 0) -eq 1 } finally { $k.Dispose() } }
function Clear-SpMarker($n) { $k = Open-SpMarkers $false; if ($null -ne $k) { try { $k.DeleteValue($n, $false) } finally { $k.Dispose() } } }
function Clear-SpMarkers { $b = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry32'); try { $b.DeleteSubKeyTree('__MARKER_KEY__', $false) } finally { $b.Dispose() } }
function Set-SpResult($nonce, $message) { $k = Open-SpMarkers $true; try { $k.SetValue('ResultNonce', [string]$nonce, 'String'); $k.SetValue('ResultMessage', [string]$message, 'String') } finally { $k.Dispose() } }
function Clear-SpResult { Clear-SpMarker 'ResultNonce'; Clear-SpMarker 'ResultMessage' }
"#;

const QUEUE_FUNCTIONS: &str = r#"function Test-SpName($a, $b) { ([string]$a).Equals([string]$b, [StringComparison]::OrdinalIgnoreCase) }
function Get-SpPrinters { @(Get-Printer) }
function Get-SpPrinter($n) { @(Get-SpPrinters | ? { Test-SpName $_.Name $n }) }
function Get-SpPort($n) { @(Get-PrinterPort | ? { Test-SpName $_.Name $n }) }
function Test-SpLocalPort($p) { [string]$p.CimClass.CimClassName -eq 'MSFT_LocalPrinterPort' }
function Test-SpLegacyPort($p) { [string]$p.PrinterHostAddress -eq '127.0.0.1' -and [int]$p.PortNumber -eq __LEGACY_PORT_NUMBER__ -and [int]$p.Protocol -eq 1 }
function Test-SpLegacy($p) {
if (-not (Test-SpName $p.DriverName '__DRIVER__') -or -not (Test-SpName $p.PortName '__LEGACY_PORT__')) { return $false }
$port = @(Get-SpPort $p.PortName)
$port.Count -gt 0 -and (Test-SpLegacyPort $port[0])
}
function Test-SpHeld($p) {
if (-not (Test-SpName $p.DriverName '__DRIVER__') -or -not (Test-SpName $p.PortName '__HOLD_PORT__')) { return $false }
$w = @(Get-CimInstance Win32_Printer | ? { Test-SpName $_.Name $p.Name })
$w.Count -eq 1 -and ([int64]$w[0].Attributes -band __HELD_ATTRIBUTES__) -eq __HELD_ATTRIBUTES__
}
function Remove-SpPrinter($p) {
foreach ($j in @(Get-PrintJob -PrinterObject $p)) { $null = Remove-PrintJob -InputObject $j }
$null = Remove-Printer -InputObject $p
}
function Remove-SpPort($n, $test) {
$port = @(Get-SpPort $n)
if (@(Get-SpPrinters | ? { Test-SpName $_.PortName $n }).Count -eq 0 -and $port.Count -gt 0 -and (& $test $port[0])) { $null = Remove-PrinterPort -Name ([string]$port[0].Name) }
}
function Remove-SpLegacy {
$found = @(Get-SpPrinters | ? { Test-SpLegacy $_ })
foreach ($p in $found) { Remove-SpPrinter $p }
Remove-SpPort '__LEGACY_PORT__' ${function:Test-SpLegacyPort}
$found.Count -gt 0
}
function Remove-SpHoldPort {
if (-not (Test-SpMarker 'HoldPortCreated') -or @(Get-SpPrinters | ? { Test-SpName $_.PortName '__HOLD_PORT__' }).Count -gt 0) { return }
Remove-SpPort '__HOLD_PORT__' ${function:Test-SpLocalPort}
Clear-SpMarker 'HoldPortCreated'
}
"#;

/// The permission rules. Generic rights of a printer object map to sets that
/// all include PRINTER_ACCESS_USE (MS-RPRN 2.2.3.1), so a grant counts as
/// Print when its mask carries 0x8 or any generic bit. Inherit-only entries
/// apply to jobs, not to printing. An AppContainer or capability entry
/// (S-1-15-2-*, S-1-15-3-*) grants only together with the user's own grant,
/// so it never lets another account print. The rewritten descriptor carries
/// the DACL alone: SetPrinter leaves every component a descriptor omits
/// unchanged, so the owner Windows assigned stays.
const PERMISSION_FUNCTIONS: &str = r#"$SpAce = [System.Security.AccessControl.CommonAce]
$SpFlags = [System.Security.AccessControl.AceFlags]
$SpAllow = [System.Security.AccessControl.AceQualifier]::AccessAllowed
function Get-SpRights($m) {
$v = [int64]$m -band 0xFFFFFFFFL
$r = $v -band 0x0FFFFFFFL
if ($v -band 0x10000000L) { $r = $r -bor 0xF000CL }
if ($v -band 0xE0000000L) { $r = $r -bor 0x20008L }
$r
}
function Test-SpKept($s) { $s -eq 'S-1-5-18' -or $s.StartsWith('S-1-15-2-') -or $s.StartsWith('S-1-15-3-') }
function Get-SpGrantees($sddl) {
$d = [System.Security.AccessControl.RawSecurityDescriptor]::new([string]$sddl)
if ($null -eq $d.DiscretionaryAcl) { return @('S-1-1-0') }
@($d.DiscretionaryAcl | ? { $_ -is $SpAce -and -not $_.AceFlags.HasFlag($SpFlags::InheritOnly) -and $_.AceQualifier -eq $SpAllow -and ((Get-SpRights $_.AccessMask) -band 8) } | % { $_.SecurityIdentifier.Value })
}
function Test-SpPrivate($sddl, $sid) {
$g = @(Get-SpGrantees $sddl)
($g -contains $sid) -and @($g | ? { $_ -ne $sid -and -not (Test-SpKept $_) }).Count -eq 0
}
function ConvertTo-SpPrivate($sddl, $sid) {
$d = [System.Security.AccessControl.RawSecurityDescriptor]::new([string]$sddl)
$acl = [System.Security.AccessControl.RawAcl]::new(2, 0)
$creator = $false
foreach ($a in @($d.DiscretionaryAcl | ? { $_ })) {
if ($a -isnot $SpAce) { $acl.InsertAce($acl.Count, $a); continue }
$g = $a.SecurityIdentifier.Value
if ($g -eq 'S-1-1-0') { continue }
if ($a.AceFlags.HasFlag($SpFlags::InheritOnly)) {
if ($g -eq 'S-1-3-0' -and $a.AceQualifier -eq $SpAllow -and $a.AceFlags.HasFlag($SpFlags::ObjectInherit)) { $creator = $true }
$acl.InsertAce($acl.Count, $a); continue
}
if ($a.AceQualifier -ne $SpAllow -or (Test-SpKept $g)) { $acl.InsertAce($acl.Count, $a); continue }
if ($g -eq $sid) { continue }
$r = (Get-SpRights $a.AccessMask) -band -9L
if ($r) { $acl.InsertAce($acl.Count, $SpAce::new($a.AceFlags, $SpAllow, [int]$r, $a.SecurityIdentifier, $false, $null)) }
}
$acl.InsertAce($acl.Count, $SpAce::new($SpFlags::None, $SpAllow, 0x20008, [System.Security.Principal.SecurityIdentifier]::new($sid), $false, $null))
if (-not $creator) { $acl.InsertAce($acl.Count, $SpAce::new(('ObjectInherit, InheritOnly' -as $SpFlags), $SpAllow, 0xF0030, [System.Security.Principal.SecurityIdentifier]::new('S-1-3-0'), $false, $null)) }
[System.Security.AccessControl.RawSecurityDescriptor]::new('DiscretionaryAclPresent', $null, $null, $null, $acl).GetSddlForm('Access')
}
function Get-SpSddl($p) {
$n = [string]$p.Name
if ([System.Management.Automation.WildcardPattern]::ContainsWildcardCharacters($n)) { $f = Get-Printer -Full } else { $f = Get-Printer -Name $n -Full }
$f = @($f | ? { Test-SpName $_.Name $n })
if ($f.Count -ne 1) { throw "The permissions of printer $n could not be read." }
[string]$f[0].PermissionSDDL
}
function Test-SpMine($p, $sid) { (Test-SpHeld $p) -and (@(Get-SpGrantees (Get-SpSddl $p)) -contains $sid) }
function Get-SpMine($sid) { @(Get-SpPrinters | ? { Test-SpMine $_ $sid }) }
"#;

const HOLD_FUNCTIONS: &str = r#"function Use-SpHoldPort {
$port = @(Get-SpPort '__HOLD_PORT__')
if ($port.Count -gt 0) {
if (-not (Test-SpLocalPort $port[0])) { throw 'A port named __HOLD_PORT__ exists and is not a local port.' }
return [string]$port[0].Name
}
$null = Add-PrinterPort -Name '__HOLD_PORT__'
Set-SpMarker 'HoldPortCreated'
'__HOLD_PORT__'
}
function Set-SpPrivate($p, $sid) {
$sddl = Get-SpSddl $p
if (-not (Test-SpPrivate $sddl $sid)) { $null = Set-Printer -InputObject $p -PermissionSDDL (ConvertTo-SpPrivate $sddl $sid) }
}
function Set-SpHeld($n, $c) {
$p = @(Get-SpPrinter $n)
$w = @(Get-CimInstance Win32_Printer | ? { Test-SpName $_.Name $n })
if ($p.Count -ne 1 -or $w.Count -ne 1) { throw "Printer $n could not be found." }
$null = Set-Printer -InputObject $p[0] -KeepPrintedJobs $true -Datatype 'RAW' -Comment $c
$null = Set-CimInstance -InputObject $w[0] -Property @{ RawOnly = $true }
$r = Invoke-CimMethod -InputObject $w[0] -MethodName 'Pause'
if ([int]$r.ReturnValue -ne 0) { throw "Printer $n could not be paused (error $($r.ReturnValue))." }
}
"#;

fn library(parts: &[&str], marker: &str) -> String {
    let mut text = String::new();
    for part in parts {
        text.push_str(part);
    }
    text.push_str(marker);
    text.replace("__MARKER_KEY__", MARKER_KEY)
        .replace("__DRIVER__", DRIVER_NAME)
        .replace("__HOLD_PORT__", HOLD_PORT)
        .replace("__LEGACY_PORT_NUMBER__", &LEGACY_PORT_NUMBER.to_string())
        .replace("__LEGACY_PORT__", LEGACY_PORT_NAME)
        .replace("__HELD_ATTRIBUTES__", &format!("0x{HELD_ATTRIBUTES:X}"))
        .replace("__PRINTER_NAME__", PRINTER_NAME)
}

fn account_block(account: &Account) -> String {
    format!(
        "function ConvertFrom-SpB64($v) {{ [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }}\n\
         $spectraSid = ConvertFrom-SpB64 '{}'\n\
         $spectraUserLabel = ConvertFrom-SpB64 '{}'\n",
        b64(&account.sid),
        b64(&account.user_name),
    )
}

/// The elevated process has no console the app can read, so a failure is
/// recorded under the marker key with this run's nonce and read back once
/// the elevation returns.
fn elevated(body: &str, nonce: &str) -> String {
    let nonce: String = nonce.chars().filter(char::is_ascii_alphanumeric).collect();
    format!(
        "$spNonce = '{nonce}'\n\
         try {{ Clear-SpResult }} catch {{ }}\n\
         try {{\n{body}}} catch {{\n\
         $spFailure = $_\n\
         try {{ Set-SpResult $spNonce ([string]$spFailure.Exception.Message) }} catch {{ }}\n\
         throw $spFailure\n\
         }}\n"
    )
}

const INSTALL_BODY: &str = r#"if (Remove-SpLegacy) { Set-SpMarker 'Replaced' }
$mine = @(Get-SpMine $spectraSid)
if ($mine.Count -gt 0) { foreach ($p in $mine) { Set-SpPrivate $p $spectraSid; Set-SpHeld ([string]$p.Name) $spectraComment } } else {
$port = Use-SpHoldPort
$name = '__PRINTER_NAME__'
if (@(Get-SpPrinter $name).Count -gt 0) { $name = "__PRINTER_NAME__ ($spectraUserLabel)" }
if (@(Get-SpPrinter $name).Count -gt 0) { throw 'A different printer already uses the Spectra PDF name.' }
$made = $false
try {
$null = Add-Printer -Name $name -DriverName '__DRIVER__' -PortName $port -KeepPrintedJobs -Datatype 'RAW' -Comment $spectraComment
$made = $true
$p = @(Get-SpPrinter $name)
if ($p.Count -ne 1) { throw 'The new Spectra PDF printer could not be found.' }
Set-SpPrivate $p[0] $spectraSid
Set-SpHeld $name $spectraComment
foreach ($j in @(Get-PrintJob -PrinterObject $p[0])) { $null = Remove-PrintJob -InputObject $j }
$p = @(Get-SpPrinter $name)
if ($p.Count -ne 1 -or -not (Test-SpMine $p[0] $spectraSid) -or -not (Test-SpPrivate (Get-SpSddl $p[0]) $spectraSid)) { throw 'The installed Spectra PDF printer could not be verified.' }
} catch {
$failure = $_
$rollback = @()
if ($made) { try { foreach ($left in @(Get-SpPrinter $name)) { Remove-SpPrinter $left } } catch { $rollback += $_.Exception.Message } }
try { Remove-SpHoldPort } catch { $rollback += $_.Exception.Message }
if ($rollback.Count -gt 0) { throw "$($failure.Exception.Message) (rollback failed: $($rollback -join '; '))" }
throw $failure
}
}
"#;

/// Elevated: retire the loopback queue, then add this account's held queue,
/// or repair the one it has. A partial install rolls back what it created.
pub(super) fn install_script(
    account: &Account,
    comment: &str,
    nonce: &str,
    marker: &str,
) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n{}$spectraComment = ConvertFrom-SpB64 '{}'\n{}{}",
        account_block(account),
        b64(&queue_comment(comment)),
        library(
            &[QUEUE_FUNCTIONS, PERMISSION_FUNCTIONS, HOLD_FUNCTIONS],
            marker
        ),
        elevated(&library(&[INSTALL_BODY], ""), nonce),
    )
}

const UNINSTALL_BODY: &str = r#"foreach ($p in @(Get-SpMine $spectraSid)) { Remove-SpPrinter $p }
Remove-SpHoldPort
if (Remove-SpLegacy) { Set-SpMarker 'Replaced' }
"#;

/// Elevated: remove this account's queue, its jobs first, and the loopback
/// queue.
pub(super) fn uninstall_script(account: &Account, nonce: &str, marker: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n{}{}{}",
        account_block(account),
        library(&[QUEUE_FUNCTIONS, PERMISSION_FUNCTIONS], marker),
        elevated(UNINSTALL_BODY, nonce),
    )
}

/// Installer, every install including an update: remove the loopback queue,
/// its pending jobs first, and record that it was replaced.
pub(super) fn retire_legacy_script(marker: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n{}if (Remove-SpLegacy) {{ Set-SpMarker 'Replaced' }}\n",
        library(&[QUEUE_FUNCTIONS], marker),
    )
}

const REMOVE_ALL_BODY: &str = r#"foreach ($p in @(Get-SpPrinters | ? { Test-SpHeld $_ })) { Remove-SpPrinter $p }
Remove-SpHoldPort
[void](Remove-SpLegacy)
Clear-SpMarkers
"#;

/// Uninstaller: remove every account's held queue and the loopback queue,
/// each with its jobs, and the machine-wide markers.
pub(super) fn remove_all_script(marker: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n{}{REMOVE_ALL_BODY}",
        library(&[QUEUE_FUNCTIONS], marker),
    )
}

/// Not elevated: whether an installed queue passes the scripts' loopback
/// test.
pub(super) fn legacy_probe_script() -> String {
    format!(
        "$ErrorActionPreference = 'Stop'\n{}if (@(Get-SpPrinters | ? {{ Test-SpLegacy $_ }}).Count -gt 0) {{ 'legacy=yes' }} else {{ 'legacy=no' }}\n",
        library(&[QUEUE_FUNCTIONS], ""),
    )
}

// ── commands ───────────────────────────────────────────────────────────────

pub(super) fn status(app: &AppHandle) -> Result<VirtualPrinterStatus, String> {
    let layout = Layout::current();
    let state = app.state::<PrinterState>();
    let listener = state.listener_status.lock().unwrap().clone();
    let last_job_error = state.last_job_error.lock().unwrap().clone();
    let (queues, service_error) = match WinSpooler.queues() {
        Ok(queues) => (queues, String::new()),
        Err(e) => (Vec::new(), e),
    };
    let sid = Account::current().ok().map(|account| account.sid);
    let mut view = account_view(&queues, sid.as_deref());
    if view.legacy_present {
        view.legacy_present = legacy_confirmed();
    }
    let replaced = service_error.is_empty()
        && replaced_notice(replaced_marker_set(), &view, layout.acknowledged.exists());
    Ok(VirtualPrinterStatus {
        installed: view.installed,
        listener,
        last_job_error,
        printer_name: view.name.unwrap_or_else(|| PRINTER_NAME.to_string()),
        replaced,
        legacy_present: view.legacy_present,
        staging: layout.staging.to_string_lossy().into_owned(),
        service_error,
    })
}

/// `comment` is the queue's Comment field, in the installing user's language.
pub(super) fn install(comment: &str) -> Result<(), String> {
    let layout = Layout::current();
    let account = Account::current()?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    super::run_elevated_script(&install_script(&account, comment, &nonce, MARKER_FUNCTIONS))
        .map_err(|printed| elevated_failure(INSTALL_FAILED, &printed, recorded_reason(&nonce)))?;
    acknowledge(&layout);
    Ok(())
}

pub(super) fn uninstall() -> Result<(), String> {
    let layout = Layout::current();
    let account = Account::current()?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    super::run_elevated_script(&uninstall_script(&account, &nonce, MARKER_FUNCTIONS))
        .map_err(|printed| elevated_failure(REMOVE_FAILED, &printed, recorded_reason(&nonce)))?;
    acknowledge(&layout);
    Ok(())
}

/// The reason the elevated script recorded for the run with `nonce`.
fn recorded_reason(nonce: &str) -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY};
    let key = winreg::RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(MARKER_KEY, KEY_READ | KEY_WOW64_32KEY)
        .ok()?;
    let recorded: String = key.get_value("ResultNonce").ok()?;
    if recorded != nonce {
        return None;
    }
    key.get_value("ResultMessage").ok()
}

/// Why an elevated step failed, never empty: the reason its script recorded,
/// else what PowerShell printed, else a named fallback. A declined prompt
/// keeps its own message.
pub(super) fn elevated_failure(what: &str, printed: &str, recorded: Option<String>) -> String {
    if let Some(reason) = recorded.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        return format!("{what}: {reason}");
    }
    let printed = printed.trim();
    if printed == super::ELEVATION_DECLINED {
        printed.to_string()
    } else if printed.is_empty() {
        format!("{what}: the administrator step ended without a reason.")
    } else {
        format!("{what}: {printed}")
    }
}

pub(super) fn retire_legacy() -> Result<(), String> {
    super::run_powershell(&[&retire_legacy_script(MARKER_FUNCTIONS)]).map(|_| ())
}

pub(super) fn remove_all() -> Result<(), String> {
    super::run_powershell(&[&remove_all_script(MARKER_FUNCTIONS)]).map(|_| ())
}

// ── the folder ─────────────────────────────────────────────────────────────

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.encode_wide().chain(std::iter::once(0)).collect()
}

fn is_reparse_point(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

/// Replace `dir`'s DACL with the protected private one. Existing children
/// receive the inheritable entries.
pub(super) fn apply_private_dacl(dir: &Path, sid: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        GetSecurityDescriptorDacl, ACL, DACL_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    };

    if !is_account_sid(sid) {
        return Err(format!("not an account SID: {sid}"));
    }
    let sddl = wide(std::ffi::OsStr::new(&folder_sddl(sid)));
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .map_err(|e| format!("the folder permissions could not be built: {e}"))?;
    let result = (|| {
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) }
            .map_err(|e| format!("the folder permissions could not be read: {e}"))?;
        let path = wide(dir.as_os_str());
        let status = unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(dacl),
                None,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "the folder permissions could not be set on {}: {}",
                dir.display(),
                std::io::Error::from_raw_os_error(status.0 as i32)
            ))
        }
    })();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result
}

/// Create `dir` if missing and refuse a link standing in its place.
fn ensure_real_dir(dir: &Path) -> Result<(), String> {
    match std::fs::create_dir(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("cannot create {}: {e}", dir.display())),
    }
    if is_reparse_point(dir) || !dir.is_dir() {
        return Err(format!("{} is not a plain folder", dir.display()));
    }
    Ok(())
}

pub(super) fn prepare(layout: &Layout, sid: &str) -> Result<(), String> {
    let parent = layout
        .root
        .parent()
        .ok_or_else(|| "the printer folder has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    ensure_real_dir(&layout.root)?;
    apply_private_dacl(&layout.root, sid)?;
    ensure_real_dir(&layout.staging)?;
    ensure_real_dir(&layout.ledger)?;
    Ok(())
}

#[derive(Debug)]
pub(super) enum ClaimFailure {
    HeldElsewhere,
    Failed(String),
}

/// Held open without sharing for the receiver's life, so a second receiver
/// of the same account is refused.
pub(super) struct ReceiverClaim {
    _file: File,
}

pub(super) fn claim_receiver(lock: &Path) -> Result<ReceiverClaim, ClaimFailure> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(lock)
        .map(|file| ReceiverClaim { _file: file })
        .map_err(|e| match e.raw_os_error() {
            Some(ERROR_SHARING_VIOLATION) => ClaimFailure::HeldElsewhere,
            _ => ClaimFailure::Failed(format!("cannot hold {}: {e}", lock.display())),
        })
}

/// Settle what a stopped process left; returns the files removed. Runs once
/// the receiver holds its claim and before any job is read or delivered.
///
/// A partial read without a ledger entry is removed: its job is still in its
/// queue. A partial read with an entry was complete and on disk before the
/// entry was written, and its job may be gone, so the rename is finished
/// instead. An entry still under its temporary name never counted, and a
/// delivery record whose staged job is gone guards nothing.
pub(super) fn reclaim_staging(staging: &Path, ledger: &Path) -> usize {
    let mut removed = 0;
    if let Ok(entries) = std::fs::read_dir(staging) {
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(name) = file_name
                .to_str()
                .filter(|name| name.starts_with(PRINTED_PREFIX))
                .and_then(|name| name.strip_suffix(PART_SUFFIX))
            else {
                continue;
            };
            let staged = staging.join(name);
            if ledger_entry(ledger, name, TAKEN_SUFFIX).exists()
                && !staged.exists()
                && rename_durable(&entry.path(), &staged).is_ok()
            {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
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
                    .is_some_and(|staged| !staging.join(staged).exists());
            if stale && std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

// ── the spooler ────────────────────────────────────────────────────────────

mod spooler {
    use std::ffi::c_void;
    use std::io::Write;

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER,
        ERROR_INVALID_PARAMETER, ERROR_INVALID_PRINTER_NAME, FILETIME, GENERIC_ALL,
        GENERIC_EXECUTE, GENERIC_READ, GENERIC_WRITE, HANDLE, HLOCAL, SYSTEMTIME, WAIT_OBJECT_0,
    };
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EnumJobsW, EnumPrintersW, FindClosePrinterChangeNotification,
        FindFirstPrinterChangeNotification, FindNextPrinterChangeNotification, GetPrinterW,
        OpenPrinterW, ReadPrinter, SetJobW, JOB_CONTROL_DELETE, JOB_INFO_2W, PRINTER_ACCESS_RIGHTS,
        PRINTER_ACCESS_USE, PRINTER_CHANGE_JOB, PRINTER_DEFAULTSW, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_2W, PRINTER_INFO_3,
    };
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{
        AclSizeInformation, GetAce, GetAclInformation, GetSecurityDescriptorDacl,
        IsValidSecurityDescriptor, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
        INHERIT_ONLY_ACE, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR, PSID,
    };
    use windows::Win32::System::Threading::WaitForMultipleObjects;
    use windows::Win32::System::Time::SystemTimeToFileTime;

    use super::{
        copy_job_data, is_held_queue, JobFacts, QueueFacts, ReadFailure, Spooler,
        MAX_ENUM_BUFFER_BYTES, MAX_JOBS_PER_PASS,
    };

    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACCESS_DENIED_ACE_TYPE: u8 = 1;
    /// READ_CONTROL with JOB_ACCESS_READ: JOB_READ, the right ReadPrinter
    /// checks on a job handle (MS-RPRN 2.2.3.1, product note 376).
    const JOB_READ: u32 = 0x0002_0020;
    const READ_CONTROL: u32 = 0x0002_0000;
    const PRINT_RIGHTS: u32 =
        PRINTER_ACCESS_USE.0 | GENERIC_ALL.0 | GENERIC_EXECUTE.0 | GENERIC_WRITE.0 | GENERIC_READ.0;
    const EVERYONE: &str = "S-1-1-0";
    /// 100 ns ticks from 1601-01-01 to 1970-01-01.
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

    /// One entry of a DACL, as far as the receiver reads it.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(super) struct AceEntry {
        pub allow: bool,
        pub inherit_only: bool,
        pub object_inherit: bool,
        pub mask: u32,
        pub sid: String,
    }

    struct PrinterGuard(PRINTER_HANDLE);

    impl Drop for PrinterGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = ClosePrinter(self.0);
            }
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn text(value: PWSTR) -> String {
        if value.is_null() {
            String::new()
        } else {
            unsafe { value.to_string() }.unwrap_or_default()
        }
    }

    fn win32_code(error: &windows::core::Error) -> u32 {
        let code = error.code().0 as u32;
        if code & 0xFFFF_0000 == 0x8007_0000 {
            code & 0xFFFF
        } else {
            code
        }
    }

    fn open_printer(name: &str, access: u32) -> windows::core::Result<PrinterGuard> {
        let name = wide(name);
        let defaults = PRINTER_DEFAULTSW {
            pDatatype: PWSTR::null(),
            pDevMode: std::ptr::null_mut(),
            DesiredAccess: PRINTER_ACCESS_RIGHTS(access),
        };
        let mut handle = PRINTER_HANDLE::default();
        unsafe {
            OpenPrinterW(
                PCWSTR(name.as_ptr()),
                &mut handle,
                Some(std::ptr::addr_of!(defaults)),
            )
        }?;
        Ok(PrinterGuard(handle))
    }

    fn aligned(bytes: usize) -> Result<Vec<u64>, String> {
        if bytes > MAX_ENUM_BUFFER_BYTES {
            return Err(format!(
                "the spooler reply needs {bytes} bytes, above the {} MiB limit",
                MAX_ENUM_BUFFER_BYTES / (1024 * 1024)
            ));
        }
        let mut values = Vec::new();
        values
            .try_reserve_exact(bytes.div_ceil(8))
            .map_err(|e| format!("cannot allocate the spooler reply: {e}"))?;
        values.resize(bytes.div_ceil(8), 0u64);
        Ok(values)
    }

    /// Every allow and deny entry of `sd`'s DACL; `None` for a NULL DACL,
    /// which grants everyone everything.
    ///
    /// # Safety
    /// `sd` is null or points to a security descriptor that outlives the call.
    pub(super) unsafe fn dacl_entries(
        sd: PSECURITY_DESCRIPTOR,
    ) -> Result<Option<Vec<AceEntry>>, String> {
        if sd.0.is_null() || !IsValidSecurityDescriptor(sd).as_bool() {
            return Err("no valid security descriptor".to_string());
        }
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted)
            .map_err(|e| e.to_string())?;
        if !present.as_bool() || dacl.is_null() {
            return Ok(None);
        }
        let mut info = ACL_SIZE_INFORMATION::default();
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
        .map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        for index in 0..info.AceCount {
            let mut ace: *mut c_void = std::ptr::null_mut();
            if GetAce(dacl, index, &mut ace).is_err() || ace.is_null() {
                continue;
            }
            let header = &*(ace as *const ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE && header.AceType != ACCESS_DENIED_ACE_TYPE
            {
                continue;
            }
            let body = &*(ace as *const ACCESS_ALLOWED_ACE);
            let sid = PSID(std::ptr::addr_of!(body.SidStart) as *mut c_void);
            let mut sid_text = PWSTR::null();
            if ConvertSidToStringSidW(sid, &mut sid_text).is_err() {
                continue;
            }
            let sid_string = text(sid_text);
            let _ = LocalFree(Some(HLOCAL(sid_text.0.cast())));
            let flags = u32::from(header.AceFlags);
            entries.push(AceEntry {
                allow: header.AceType == ACCESS_ALLOWED_ACE_TYPE,
                inherit_only: flags & INHERIT_ONLY_ACE.0 != 0,
                object_inherit: flags & OBJECT_INHERIT_ACE.0 != 0,
                mask: body.Mask,
                sid: sid_string,
            });
        }
        Ok(Some(entries))
    }

    /// The SIDs a queue-level allow entry of `sd` grants Print; `None` when
    /// `sd` cannot be read.
    ///
    /// # Safety
    /// As for [`dacl_entries`].
    pub(super) unsafe fn print_grantees(sd: PSECURITY_DESCRIPTOR) -> Option<Vec<String>> {
        match dacl_entries(sd) {
            Ok(None) => Some(vec![EVERYONE.to_string()]),
            Ok(Some(entries)) => Some(
                entries
                    .into_iter()
                    .filter(|entry| {
                        entry.allow && !entry.inherit_only && entry.mask & PRINT_RIGHTS != 0
                    })
                    .map(|entry| entry.sid)
                    .collect(),
            ),
            Err(_) => None,
        }
    }

    /// The security of a queue whose enumeration entry carried none; `None`
    /// when it cannot be read.
    fn queue_grantees(name: &str) -> Option<Vec<String>> {
        let printer = open_printer(name, READ_CONTROL).ok()?;
        let mut needed = 0u32;
        unsafe {
            let _ = GetPrinterW(printer.0, 3, None, &mut needed);
        }
        if needed == 0 {
            return None;
        }
        let mut buffer = aligned(needed as usize).ok()?;
        let bytes = needed as usize;
        let view =
            unsafe { std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>(), bytes) };
        if unsafe { GetPrinterW(printer.0, 3, Some(view), &mut needed) }.is_err()
            || bytes < std::mem::size_of::<PRINTER_INFO_3>()
        {
            return None;
        }
        let info = unsafe { &*buffer.as_ptr().cast::<PRINTER_INFO_3>() };
        unsafe { print_grantees(info.pSecurityDescriptor) }
    }

    fn unix_ms(time: &SYSTEMTIME) -> u64 {
        let mut file_time = FILETIME::default();
        if unsafe { SystemTimeToFileTime(time, &mut file_time) }.is_err() {
            return 0;
        }
        let ticks =
            (u64::from(file_time.dwHighDateTime) << 32) | u64::from(file_time.dwLowDateTime);
        ticks.saturating_sub(UNIX_EPOCH_TICKS) / 10_000
    }

    pub(super) struct WinSpooler;

    impl Spooler for WinSpooler {
        fn queues(&self) -> Result<Vec<QueueFacts>, String> {
            for _ in 0..3 {
                let mut needed = 0u32;
                let mut returned = 0u32;
                // Only ERROR_INSUFFICIENT_BUFFER leads to the sized call; a
                // stopped spooler fails here and is reported, never read as
                // an empty printer list.
                let sized = unsafe {
                    EnumPrintersW(
                        PRINTER_ENUM_LOCAL,
                        PCWSTR::null(),
                        2,
                        None,
                        &mut needed,
                        &mut returned,
                    )
                };
                match sized {
                    Ok(()) => return Ok(Vec::new()),
                    Err(e) if win32_code(&e) == ERROR_INSUFFICIENT_BUFFER.0 => {}
                    Err(e) => return Err(e.to_string()),
                }
                if needed == 0 {
                    return Ok(Vec::new());
                }
                let bytes = needed as usize;
                let mut buffer = aligned(bytes)?;
                let view = unsafe {
                    std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>(), bytes)
                };
                match unsafe {
                    EnumPrintersW(
                        PRINTER_ENUM_LOCAL,
                        PCWSTR::null(),
                        2,
                        Some(view),
                        &mut needed,
                        &mut returned,
                    )
                } {
                    Ok(()) => {}
                    Err(e) if win32_code(&e) == ERROR_INSUFFICIENT_BUFFER.0 => continue,
                    Err(e) => return Err(format!("EnumPrinters failed: {e}")),
                }
                if returned as usize > bytes / std::mem::size_of::<PRINTER_INFO_2W>() {
                    return Err(
                        "EnumPrinters returned more entries than its buffer holds".to_string()
                    );
                }
                let infos = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<PRINTER_INFO_2W>(),
                        returned as usize,
                    )
                };
                return Ok(infos
                    .iter()
                    .map(|info| {
                        let mut queue = QueueFacts {
                            name: text(info.pPrinterName),
                            driver: text(info.pDriverName),
                            port: text(info.pPortName),
                            attributes: info.Attributes,
                            print_grantees: Vec::new(),
                            grantees_known: true,
                        };
                        let grantees = if !info.pSecurityDescriptor.0.is_null() {
                            unsafe { print_grantees(info.pSecurityDescriptor) }
                        } else if is_held_queue(&queue) {
                            queue_grantees(&queue.name)
                        } else {
                            Some(Vec::new())
                        };
                        match grantees {
                            Some(grantees) => queue.print_grantees = grantees,
                            None => queue.grantees_known = !is_held_queue(&queue),
                        }
                        queue
                    })
                    .collect());
            }
            Err("the printer list kept changing while it was read".to_string())
        }

        fn jobs(&self, queue: &str) -> Result<Vec<JobFacts>, String> {
            let printer = open_printer(queue, PRINTER_ACCESS_USE.0).map_err(|e| e.to_string())?;
            for _ in 0..3 {
                let mut needed = 0u32;
                let mut returned = 0u32;
                let sized = unsafe {
                    EnumJobsW(
                        printer.0,
                        0,
                        MAX_JOBS_PER_PASS,
                        2,
                        None,
                        &mut needed,
                        &mut returned,
                    )
                };
                match sized {
                    Ok(()) => return Ok(Vec::new()),
                    Err(e) if win32_code(&e) == ERROR_INSUFFICIENT_BUFFER.0 => {}
                    Err(e) => return Err(format!("EnumJobs failed: {e}")),
                }
                if needed == 0 {
                    return Ok(Vec::new());
                }
                let bytes = needed as usize;
                let mut buffer = aligned(bytes)?;
                let view = unsafe {
                    std::slice::from_raw_parts_mut(buffer.as_mut_ptr().cast::<u8>(), bytes)
                };
                match unsafe {
                    EnumJobsW(
                        printer.0,
                        0,
                        MAX_JOBS_PER_PASS,
                        2,
                        Some(view),
                        &mut needed,
                        &mut returned,
                    )
                } {
                    Ok(()) => {}
                    Err(e) if win32_code(&e) == ERROR_INSUFFICIENT_BUFFER.0 => continue,
                    Err(e) => return Err(format!("EnumJobs failed: {e}")),
                }
                if returned as usize > bytes / std::mem::size_of::<JOB_INFO_2W>() {
                    return Err("EnumJobs returned more entries than its buffer holds".to_string());
                }
                let infos = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<JOB_INFO_2W>(),
                        returned as usize,
                    )
                };
                return Ok(infos
                    .iter()
                    .map(|info| JobFacts {
                        id: info.JobId,
                        status: info.Status,
                        datatype: text(info.pDatatype),
                        submitted_ms: unix_ms(&info.Submitted),
                        size: u64::from(info.Size),
                    })
                    .collect());
            }
            Err("the job list kept changing while it was read".to_string())
        }

        fn read_job(
            &self,
            queue: &str,
            job: &JobFacts,
            sink: &mut dyn Write,
            limit: u64,
        ) -> Result<u64, ReadFailure> {
            let handle =
                open_printer(&format!("{queue}, Job {}", job.id), JOB_READ).map_err(|e| {
                    match win32_code(&e) {
                        code if code == ERROR_ACCESS_DENIED.0 => ReadFailure::Denied,
                        code if code == ERROR_INVALID_PRINTER_NAME.0
                            || code == ERROR_INVALID_PARAMETER.0 =>
                        {
                            ReadFailure::Gone
                        }
                        _ => ReadFailure::Failed(e.to_string()),
                    }
                })?;
            let mut read = |buffer: &mut [u8]| -> Result<u32, u32> {
                let want = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
                let mut count = 0u32;
                let ok =
                    unsafe { ReadPrinter(handle.0, buffer.as_mut_ptr().cast(), want, &mut count) };
                if ok.as_bool() {
                    Ok(count)
                } else {
                    Err(unsafe { GetLastError() }.0)
                }
            };
            copy_job_data(&mut read, job.size, sink, limit)
        }

        fn delete_job(&self, queue: &str, job: u32) -> Result<(), String> {
            let printer = open_printer(queue, PRINTER_ACCESS_USE.0).map_err(|e| e.to_string())?;
            if unsafe { SetJobW(printer.0, job, 0, None, JOB_CONTROL_DELETE) }.as_bool() {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error().to_string())
            }
        }
    }

    struct Watched {
        name: String,
        change: HANDLE,
        _printer: PrinterGuard,
    }

    impl Drop for Watched {
        fn drop(&mut self) {
            unsafe {
                let _ = FindClosePrinterChangeNotification(self.change);
            }
        }
    }

    /// Job-change notifications of the queues being read. A wait that sees
    /// none still returns after its timeout, so a missed notification delays
    /// a job by one interval at most.
    #[derive(Default)]
    pub(super) struct Watcher {
        watched: Vec<Watched>,
    }

    impl Watcher {
        pub fn wait(&mut self, queues: &[String], timeout: std::time::Duration) {
            self.watched
                .retain(|watched| queues.contains(&watched.name));
            for name in queues {
                if self.watched.iter().any(|watched| &watched.name == name) {
                    continue;
                }
                let Ok(printer) = open_printer(name, PRINTER_ACCESS_USE.0) else {
                    continue;
                };
                let change = unsafe {
                    FindFirstPrinterChangeNotification(printer.0, PRINTER_CHANGE_JOB, 0, None)
                };
                if !change.is_invalid() {
                    self.watched.push(Watched {
                        name: name.clone(),
                        change,
                        _printer: printer,
                    });
                }
            }
            let handles: Vec<HANDLE> = self.watched.iter().map(|watched| watched.change).collect();
            if handles.is_empty() || handles.len() > 64 {
                std::thread::sleep(timeout);
                return;
            }
            let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
            let index = unsafe { WaitForMultipleObjects(&handles, false, millis) }
                .0
                .wrapping_sub(WAIT_OBJECT_0.0) as usize;
            if index < handles.len() {
                let mut changed = 0u32;
                let reset = unsafe {
                    FindNextPrinterChangeNotification(
                        handles[index],
                        Some(std::ptr::addr_of_mut!(changed)),
                        None,
                        None,
                    )
                };
                if !reset.as_bool() {
                    // A notification that cannot be reset stays signalled.
                    self.watched.clear();
                    std::thread::sleep(timeout);
                }
            }
        }
    }
}

#[cfg(test)]
use spooler::{dacl_entries, print_grantees, AceEntry};
use spooler::{Watcher, WinSpooler};

// ── the receiver ───────────────────────────────────────────────────────────

fn set_listener(app: &AppHandle, text: &str) {
    if let Some(state) = app.try_state::<PrinterState>() {
        *state.listener_status.lock().unwrap() = text.to_string();
    }
}

fn record_job_error(app: &AppHandle, message: String) {
    eprintln!("virtual printer: {message}");
    if let Some(state) = app.try_state::<PrinterState>() {
        *state.last_job_error.lock().unwrap() = message;
    }
}

/// Start the receiver: the app-setup hook. Never panics: every failure is a
/// named listener status in Settings.
pub(super) fn start(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let layout = Layout::current();
        let account = match Account::current() {
            Ok(account) => account,
            Err(e) => return set_listener(&handle, &e),
        };
        if let Err(e) = prepare(&layout, &account.sid) {
            return set_listener(
                &handle,
                &format!("the printer folder cannot be prepared: {e}"),
            );
        }
        let claim = loop {
            match claim_receiver(&layout.lock) {
                Ok(claim) => break claim,
                Err(ClaimFailure::HeldElsewhere) => {
                    set_listener(&handle, HELD_ELSEWHERE);
                    std::thread::sleep(CLAIM_RETRY);
                }
                Err(ClaimFailure::Failed(e)) => {
                    return set_listener(
                        &handle,
                        &format!("the printer folder cannot be prepared: {e}"),
                    )
                }
            }
        };
        reclaim_job_intermediates(&printed_dir());
        reclaim_staging(&layout.staging, &layout.ledger);
        set_listener(&handle, "listening");
        run(&layout, &account, claim, handle.clone());
    });
}

fn run(layout: &Layout, account: &Account, _claim: ReceiverClaim, app: AppHandle) -> ! {
    let spooler = WinSpooler;
    let mut taker = Taker::default();
    let mut watcher = Watcher::default();
    let attempted: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();
    let record_error = |message: String| record_job_error(&app, message);
    let mut service_down = false;
    loop {
        let queues = match take_jobs(
            &spooler,
            &account.sid,
            &layout.staging,
            &layout.ledger,
            &mut taker,
            &record_error,
        ) {
            Ok(queues) => {
                if service_down {
                    set_listener(&app, "listening");
                    service_down = false;
                }
                queues
            }
            Err(e) => {
                set_listener(&app, &format!("{SERVICE_UNAVAILABLE}: {e}"));
                service_down = true;
                Vec::new()
            }
        };
        let deliver = |stem: String, staged: PathBuf| {
            IN_FLIGHT.fetch_add(1, Ordering::Relaxed);
            let app = app.clone();
            let ledger = layout.ledger.clone();
            let attempted = Arc::clone(&attempted);
            std::thread::spawn(move || {
                let _slot = JobSlot;
                let open = |pdf: &Path| open_printed(&app, pdf);
                match deliver_one(
                    &ledger,
                    &printed_dir(),
                    &staged,
                    &stem,
                    &convert_staged,
                    &open,
                ) {
                    // A staged job that is still on disk stays attempted, so
                    // this process does not open its PDF twice.
                    Ok(_) => {
                        if !staged.exists() {
                            attempted.lock().unwrap().remove(&staged);
                        }
                    }
                    Err(e) => record_job_error(&app, e),
                }
            });
        };
        deliver_staged(&layout.staging, &attempted, &record_error, &deliver);
        watcher.wait(&queues, POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use windows::Win32::Foundation::ERROR_GEN_FAILURE;
    use windows::Win32::Graphics::Printing::{JOB_STATUS_PRINTED, JOB_STATUS_RETAINED};

    fn sid() -> String {
        crate::scheduler::current_user_sid().expect("this process has a user SID")
    }

    const OWN: &str = "S-1-5-21-1-2-3-1001";
    const OTHER: &str = "S-1-5-21-1-2-3-1002";

    fn held_queue(name: &str, grantees: &[&str]) -> QueueFacts {
        QueueFacts {
            name: name.to_string(),
            driver: DRIVER_NAME.to_string(),
            port: HOLD_PORT.to_string(),
            attributes: HELD_ATTRIBUTES | 0x40,
            print_grantees: grantees.iter().map(|g| g.to_string()).collect(),
            grantees_known: true,
        }
    }

    fn job(id: u32, submitted_ms: u64) -> JobFacts {
        JobFacts {
            id,
            status: 0,
            datatype: "RAW".to_string(),
            submitted_ms,
            size: 0,
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Read {
        Data,
        Denied,
        Gone,
        Fail,
        FailHalfway,
        /// The data ends early without an error.
        Short,
    }

    struct FakeJob {
        queue: String,
        facts: JobFacts,
        data: Vec<u8>,
        read: Read,
    }

    #[derive(Default)]
    struct FakeSpooler {
        queues: RefCell<Vec<QueueFacts>>,
        jobs: RefCell<Vec<FakeJob>>,
        reads: RefCell<Vec<u32>>,
        deletes: RefCell<Vec<u32>>,
        refuse_delete: RefCell<HashSet<u32>>,
        service_down: RefCell<Option<String>>,
        unlisted: RefCell<HashSet<String>>,
    }

    impl FakeSpooler {
        fn with_queue(queue: QueueFacts) -> Self {
            Self {
                queues: RefCell::new(vec![queue]),
                ..Self::default()
            }
        }

        /// A job as the spooler lists it: its size is its data's length.
        fn add(&self, queue: &str, mut facts: JobFacts, data: &[u8], read: Read) {
            facts.size = data.len() as u64;
            self.jobs.borrow_mut().push(FakeJob {
                queue: queue.to_string(),
                facts,
                data: data.to_vec(),
                read,
            });
        }

        fn left(&self) -> Vec<u32> {
            self.jobs.borrow().iter().map(|job| job.facts.id).collect()
        }

        fn drop_job(&self, id: u32) {
            self.jobs.borrow_mut().retain(|job| job.facts.id != id);
        }
    }

    impl Spooler for FakeSpooler {
        fn queues(&self) -> Result<Vec<QueueFacts>, String> {
            match self.service_down.borrow().clone() {
                Some(e) => Err(e),
                None => Ok(self.queues.borrow().clone()),
            }
        }

        fn jobs(&self, queue: &str) -> Result<Vec<JobFacts>, String> {
            if self.unlisted.borrow().contains(queue) {
                return Err("simulated listing failure".into());
            }
            Ok(self
                .jobs
                .borrow()
                .iter()
                .filter(|job| job.queue == queue)
                .map(|job| job.facts.clone())
                .collect())
        }

        fn read_job(
            &self,
            queue: &str,
            facts: &JobFacts,
            sink: &mut dyn Write,
            limit: u64,
        ) -> Result<u64, ReadFailure> {
            self.reads.borrow_mut().push(facts.id);
            let jobs = self.jobs.borrow();
            let job = jobs
                .iter()
                .find(|job| job.queue == queue && job.facts.id == facts.id)
                .ok_or(ReadFailure::Gone)?;
            match job.read {
                Read::Denied => Err(ReadFailure::Denied),
                Read::Gone => Err(ReadFailure::Gone),
                Read::Fail => Err(ReadFailure::Failed("simulated spooler failure".into())),
                Read::FailHalfway => {
                    sink.write_all(&job.data[..job.data.len() / 2]).unwrap();
                    Err(ReadFailure::Failed("simulated failure halfway".into()))
                }
                Read::Short => {
                    let half = job.data.len() / 2;
                    sink.write_all(&job.data[..half]).unwrap();
                    Ok(half as u64)
                }
                Read::Data => {
                    let take = (job.data.len() as u64).min(limit + 1) as usize;
                    sink.write_all(&job.data[..take]).unwrap();
                    Ok(take as u64)
                }
            }
        }

        fn delete_job(&self, queue: &str, id: u32) -> Result<(), String> {
            let denied = self.refuse_delete.borrow().contains(&id)
                || self
                    .jobs
                    .borrow()
                    .iter()
                    .any(|job| job.facts.id == id && job.read == Read::Denied);
            if denied {
                return Err("Access is denied.".into());
            }
            self.deletes.borrow_mut().push(id);
            self.jobs
                .borrow_mut()
                .retain(|job| !(job.queue == queue && job.facts.id == id));
            Ok(())
        }
    }

    struct Folders {
        _dir: tempfile::TempDir,
        staging: PathBuf,
        ledger: PathBuf,
    }

    fn folders() -> Folders {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join(STAGING_DIR);
        let ledger = dir.path().join(LEDGER_DIR);
        std::fs::create_dir(&staging).unwrap();
        std::fs::create_dir(&ledger).unwrap();
        Folders {
            _dir: dir,
            staging,
            ledger,
        }
    }

    fn pass(spooler: &FakeSpooler, folders: &Folders, taker: &mut Taker) -> Vec<String> {
        let errors = RefCell::new(Vec::new());
        take_jobs(
            spooler,
            OWN,
            &folders.staging,
            &folders.ledger,
            taker,
            &|e| errors.borrow_mut().push(e),
        )
        .expect("the fake print service answers");
        errors.into_inner()
    }

    fn staged(staging: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        std::fs::read_dir(staging)
            .unwrap()
            .flatten()
            .map(|entry| {
                (
                    entry.file_name().into_string().unwrap(),
                    std::fs::read(entry.path()).unwrap(),
                )
            })
            .collect()
    }

    fn names(dir: &Path) -> std::collections::BTreeSet<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect()
    }

    fn taken(folders: &Folders, facts: &JobFacts) -> bool {
        ledger_entry(&folders.ledger, &staged_name(facts), TAKEN_SUFFIX).exists()
    }

    /// The facts the fake lists for a job, size included.
    fn listed(spooler: &FakeSpooler, id: u32) -> JobFacts {
        spooler
            .jobs
            .borrow()
            .iter()
            .find(|job| job.facts.id == id)
            .map(|job| job.facts.clone())
            .unwrap()
    }

    #[test]
    fn the_layout_keeps_every_file_in_one_private_folder() {
        let layout = Layout::under(Path::new(r"C:\Users\a\AppData\Local"));
        let root = PathBuf::from(r"C:\Users\a\AppData\Local\com.spectrapdf.app\virtual-printer");
        assert_eq!(layout.root, root);
        for path in [
            &layout.staging,
            &layout.ledger,
            &layout.lock,
            &layout.acknowledged,
        ] {
            assert_eq!(path.parent(), Some(root.as_path()), "{path:?}");
        }
    }

    #[test]
    fn only_plain_account_sids_reach_a_script() {
        for good in [
            "S-1-5-21-1-2-3-1001",
            "S-1-12-1-4015-2244-3456-7788",
            "S-1-5-18",
        ] {
            assert!(is_account_sid(good), "{good}");
        }
        for bad in [
            "",
            "S-1-5",
            "S-1-5-21-1)(A;;FA;;;WD",
            "S-1-5--1",
            "s-1-5-21-1",
            "S-1-5-21-1 ",
            "WD",
            "S-1-5-21-1'",
        ] {
            assert!(!is_account_sid(bad), "{bad}");
        }
    }

    #[test]
    fn two_jobs_printed_back_to_back_are_both_staged_and_neither_overwrites_the_other() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(7, 1_700_000_000_000),
            b"%!PS first",
            Read::Data,
        );
        spooler.add(
            "Spectra PDF",
            job(8, 1_700_000_000_000),
            b"%!PS second",
            Read::Data,
        );
        let mut taker = Taker::default();
        assert!(pass(&spooler, &f, &mut taker).is_empty());
        let files = staged(&f.staging);
        assert_eq!(files.len(), 2, "{files:?}");
        assert!(files.values().any(|bytes| bytes == b"%!PS first"));
        assert!(files.values().any(|bytes| bytes == b"%!PS second"));
        assert_eq!(*spooler.deletes.borrow(), vec![7, 8]);
        assert!(spooler.left().is_empty());
    }

    #[test]
    fn a_backlog_left_while_the_app_was_closed_is_taken_whole_in_one_pass() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        for id in 1..=25u32 {
            spooler.add(
                "Spectra PDF",
                job(id, 1_700_000_000_000 + u64::from(id % 3)),
                format!("%!PS job {id}").as_bytes(),
                Read::Data,
            );
        }
        let mut taker = Taker::default();
        pass(&spooler, &f, &mut taker);
        let files = staged(&f.staging);
        assert_eq!(files.len(), 25);
        for id in 1..=25u32 {
            assert!(
                files
                    .values()
                    .any(|bytes| bytes == format!("%!PS job {id}").as_bytes()),
                "job {id} lost"
            );
        }
        let stems: HashSet<String> = files
            .keys()
            .map(|name| stem_of(Path::new(name)).unwrap())
            .collect();
        assert!(
            stems.iter().all(|stem| stem.starts_with(PRINTED_PREFIX)),
            "{stems:?}"
        );
    }

    #[test]
    fn a_job_still_spooling_is_left_until_it_is_complete() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        let mut spooling = job(3, 1_700_000_000_000);
        spooling.status = JOB_STATUS_SPOOLING;
        spooler.add("Spectra PDF", spooling, b"%!PS half", Read::Data);
        let mut taker = Taker::default();
        pass(&spooler, &f, &mut taker);
        assert!(spooler.reads.borrow().is_empty());
        assert_eq!(spooler.left(), vec![3]);

        {
            let mut jobs = spooler.jobs.borrow_mut();
            jobs[0].facts.status = 0;
            jobs[0].data = b"%!PS half and the rest".to_vec();
            jobs[0].facts.size = jobs[0].data.len() as u64;
        }
        pass(&spooler, &f, &mut taker);
        assert_eq!(
            staged(&f.staging).into_values().collect::<Vec<_>>(),
            vec![b"%!PS half and the rest".to_vec()]
        );
    }

    #[test]
    fn a_printed_job_the_queue_keeps_is_taken_once() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        let mut printed = job(21, 1_700_000_000_000);
        printed.status = JOB_STATUS_PRINTED;
        spooler.add("Spectra PDF", printed, b"%!PS released", Read::Data);
        let mut taker = Taker::default();
        assert!(pass(&spooler, &f, &mut taker).is_empty());
        pass(&spooler, &f, &mut taker);
        assert_eq!(*spooler.reads.borrow(), vec![21]);
        assert_eq!(*spooler.deletes.borrow(), vec![21]);
        assert_eq!(
            staged(&f.staging).into_values().collect::<Vec<_>>(),
            vec![b"%!PS released".to_vec()]
        );
    }

    #[test]
    fn a_retained_job_is_staged_once_and_its_delete_tried_once_per_start() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        let mut retained = job(22, 1_700_000_000_000);
        retained.status = JOB_STATUS_RETAINED;
        spooler.add("Spectra PDF", retained, b"%!PS retained", Read::Data);
        spooler.refuse_delete.borrow_mut().insert(22);
        let facts = listed(&spooler, 22);

        let mut first = Taker::default();
        let errors = pass(&spooler, &f, &mut first);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("stays in Spectra PDF"), "{errors:?}");
        assert!(taken(&f, &facts));
        assert!(pass(&spooler, &f, &mut first).is_empty());

        let mut after_restart = Taker::default();
        let errors = pass(&spooler, &f, &mut after_restart);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(pass(&spooler, &f, &mut after_restart).is_empty());

        assert_eq!(*spooler.reads.borrow(), vec![22], "the job was read twice");
        assert_eq!(staged(&f.staging).len(), 1);
        assert_eq!(spooler.left(), vec![22]);
    }

    #[test]
    fn a_delivered_job_whose_delete_failed_is_not_read_again_after_a_restart() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(23, 1_700_000_000_000),
            b"%!PS from an elevated app",
            Read::Data,
        );
        spooler.refuse_delete.borrow_mut().insert(23);
        let facts = listed(&spooler, 23);
        pass(&spooler, &f, &mut Taker::default());
        // The delivery converted the job and dropped its staged file.
        std::fs::remove_file(f.staging.join(staged_name(&facts))).unwrap();

        for _ in 0..3 {
            pass(&spooler, &f, &mut Taker::default());
        }
        assert_eq!(
            *spooler.reads.borrow(),
            vec![23],
            "a second PDF would follow"
        );
        assert!(staged(&f.staging).is_empty());
        assert!(taken(&f, &facts));
    }

    #[test]
    fn the_ledger_forgets_a_job_once_no_queue_lists_it() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(24, 1_700_000_000_000),
            b"%!PS kept",
            Read::Data,
        );
        spooler.refuse_delete.borrow_mut().insert(24);
        let facts = listed(&spooler, 24);
        let mut taker = Taker::default();
        pass(&spooler, &f, &mut taker);
        assert!(taken(&f, &facts));

        spooler.drop_job(24);
        spooler
            .unlisted
            .borrow_mut()
            .insert("Spectra PDF".to_string());
        pass(&spooler, &f, &mut taker);
        assert!(
            taken(&f, &facts),
            "an entry was dropped while its queue could not be listed"
        );

        spooler.unlisted.borrow_mut().clear();
        pass(&spooler, &f, &mut taker);
        assert!(!taken(&f, &facts));
    }

    #[test]
    fn a_ledger_entry_whose_flush_failed_is_removed_and_the_job_read_again() {
        fn flush_fails(path: &Path, contents: &[u8]) -> std::io::Result<()> {
            std::fs::write(path, contents)?;
            Err(std::io::Error::other("simulated flush failure"))
        }
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(26, 1_700_000_000_000),
            b"%!PS keep me",
            Read::Data,
        );
        let facts = listed(&spooler, 26);
        let mut taker = Taker {
            write_entry: flush_fails,
            ..Taker::default()
        };
        let errors = pass(&spooler, &f, &mut taker);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(!taken(&f, &facts), "a stale entry would hide the job");
        assert!(staged(&f.staging).is_empty());
        assert_eq!(spooler.left(), vec![26], "the job went without a copy");

        taker.write_entry = write_entry_file;
        pass(&spooler, &f, &mut taker);
        assert_eq!(*spooler.reads.borrow(), vec![26, 26]);
        assert!(taken(&f, &facts));
        assert!(spooler.left().is_empty());
        assert_eq!(
            staged(&f.staging).into_values().collect::<Vec<_>>(),
            vec![b"%!PS keep me".to_vec()]
        );
    }

    #[test]
    fn a_queue_that_is_not_this_accounts_for_a_pass_keeps_its_ledger_entries() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(27, 1_700_000_000_000),
            b"%!PS kept",
            Read::Data,
        );
        spooler.refuse_delete.borrow_mut().insert(27);
        let facts = listed(&spooler, 27);
        pass(&spooler, &f, &mut Taker::default());
        assert!(taken(&f, &facts));
        assert_eq!(
            std::fs::read_to_string(ledger_entry(&f.ledger, &staged_name(&facts), TAKEN_SUFFIX))
                .unwrap(),
            "Spectra PDF",
            "the entry does not name its queue"
        );

        spooler.queues.borrow_mut()[0].print_grantees = vec![OTHER.to_string()];
        pass(&spooler, &f, &mut Taker::default());
        assert!(
            taken(&f, &facts),
            "the entry went while its queue was not listed"
        );

        spooler.queues.borrow_mut()[0].print_grantees = vec![OWN.to_string()];
        pass(&spooler, &f, &mut Taker::default());
        assert_eq!(
            *spooler.reads.borrow(),
            vec![27],
            "the job was read a second time"
        );
        assert_eq!(staged(&f.staging).len(), 1);
    }

    #[test]
    fn entries_of_a_removed_queue_go_and_entries_of_another_existing_queue_stay() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(28, 1_700_000_000_000),
            b"%!PS retained",
            Read::Data,
        );
        spooler.refuse_delete.borrow_mut().insert(28);
        let facts = listed(&spooler, 28);
        pass(&spooler, &f, &mut Taker::default());
        assert!(taken(&f, &facts));
        let unknown = ledger_entry(&f.ledger, &staged_name(&job(31, 5)), TAKEN_SUFFIX);
        std::fs::write(&unknown, b"").unwrap();
        let elsewhere = ledger_entry(&f.ledger, &staged_name(&job(32, 5)), TAKEN_SUFFIX);
        std::fs::write(&elsewhere, b"Office").unwrap();

        *spooler.queues.borrow_mut() = vec![
            held_queue("Office", &[OTHER]),
            held_queue("Spectra PDF (new)", &[OWN]),
        ];
        spooler.drop_job(28);
        pass(&spooler, &f, &mut Taker::default());
        assert!(!taken(&f, &facts), "the removed queue's entry stayed");
        assert!(!unknown.exists(), "an entry of an unknown queue stayed");
        assert!(
            elsewhere.exists(),
            "the entry of a queue that was not listed went"
        );
    }

    #[test]
    fn a_pass_without_an_own_queue_or_with_unread_security_drops_no_entry() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(33, 1_700_000_000_000),
            b"%!PS retained",
            Read::Data,
        );
        spooler.refuse_delete.borrow_mut().insert(33);
        let facts = listed(&spooler, 33);
        pass(&spooler, &f, &mut Taker::default());
        assert!(taken(&f, &facts));

        // Renamed and readable but not this account's: no own queue is left,
        // the entry's queue name is gone, and its job is listed nowhere.
        {
            let mut queues = spooler.queues.borrow_mut();
            queues[0].name = "Spectra PDF (renamed)".to_string();
            queues[0].print_grantees = vec![OTHER.to_string()];
        }
        for job in spooler.jobs.borrow_mut().iter_mut() {
            job.queue = "Spectra PDF (renamed)".to_string();
        }
        pass(&spooler, &f, &mut Taker::default());
        assert!(
            taken(&f, &facts),
            "a pass with no own queue dropped an entry"
        );

        // Its security cannot be read, beside another own queue listed in
        // full: the job is still listed nowhere.
        {
            let mut queues = spooler.queues.borrow_mut();
            queues[0].print_grantees.clear();
            queues[0].grantees_known = false;
            queues.push(held_queue("Spectra PDF (me)", &[OWN]));
        }
        pass(&spooler, &f, &mut Taker::default());
        assert!(
            taken(&f, &facts),
            "a pass that could not read a held queue's security dropped an entry"
        );

        {
            let mut queues = spooler.queues.borrow_mut();
            queues[0].print_grantees = vec![OWN.to_string()];
            queues[0].grantees_known = true;
        }
        pass(&spooler, &f, &mut Taker::default());
        assert_eq!(
            *spooler.reads.borrow(),
            vec![33],
            "the job was read a second time"
        );
    }

    #[test]
    fn a_copy_stays_while_its_entry_cannot_be_removed() {
        static HELD: Mutex<Vec<File>> = Mutex::new(Vec::new());
        fn lands_then_fails(path: &Path, contents: &[u8]) -> std::io::Result<()> {
            std::fs::write(path, contents)?;
            // Open without delete sharing, so the entry cannot be removed.
            let held = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0x1)
                .open(path)?;
            HELD.lock().unwrap().push(held);
            Err(std::io::Error::other(
                "simulated failure after the entry landed",
            ))
        }
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(34, 1_700_000_000_000),
            b"%!PS only copy",
            Read::Data,
        );
        let facts = listed(&spooler, 34);
        let mut taker = Taker {
            write_entry: lands_then_fails,
            ..Taker::default()
        };
        let errors = pass(&spooler, &f, &mut taker);
        HELD.lock().unwrap().clear();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(taken(&f, &facts));
        assert_eq!(
            staged(&f.staging).into_values().collect::<Vec<_>>(),
            vec![b"%!PS only copy".to_vec()],
            "the job went without a copy"
        );
        assert!(spooler.left().is_empty());
        assert_eq!(*spooler.reads.borrow(), vec![34]);
    }

    #[test]
    fn a_read_shorter_than_the_spooled_size_is_named_and_the_job_stays() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(29, 1_700_000_000_000),
            b"%!PS twenty bytes...",
            Read::Short,
        );
        let mut taker = Taker::default();
        let mut errors = Vec::new();
        for _ in 0..(MAX_READ_ATTEMPTS + 1) {
            errors.extend(pass(&spooler, &f, &mut taker));
        }
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("10 of 20 bytes"), "{errors:?}");
        assert!(staged(&f.staging).is_empty());
        assert!(
            spooler.deletes.borrow().is_empty(),
            "a short job was deleted"
        );
        assert_eq!(spooler.left(), vec![29]);
        assert!(!taken(&f, &listed(&spooler, 29)));
    }

    #[test]
    fn an_empty_read_of_a_job_with_a_spooled_size_is_not_an_empty_job() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add("Spectra PDF", job(30, 1_700_000_000_000), b"", Read::Data);
        spooler.jobs.borrow_mut()[0].facts.size = 4096;
        let errors = pass(&spooler, &f, &mut Taker::default());
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("0 of 4096 bytes"), "{errors:?}");
        assert!(spooler.deletes.borrow().is_empty());
        assert_eq!(spooler.left(), vec![30]);
    }

    #[test]
    fn a_stopped_print_service_is_reported_and_never_read_as_no_queues() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        *spooler.service_down.borrow_mut() = Some("The RPC server is unavailable.".into());
        let errors = RefCell::new(Vec::new());
        let outcome = take_jobs(
            &spooler,
            OWN,
            &f.staging,
            &f.ledger,
            &mut Taker::default(),
            &|e| errors.borrow_mut().push(e),
        );
        assert_eq!(outcome, Err("The RPC server is unavailable.".to_string()));
        assert!(errors.into_inner().is_empty());
    }

    #[test]
    fn another_accounts_job_is_never_staged_or_deleted_and_is_named_once() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(5, 1_700_000_000_000),
            b"%!PS forged",
            Read::Denied,
        );
        let mut taker = Taker::default();
        let errors = pass(&spooler, &f, &mut taker);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("another account"), "{errors:?}");
        assert!(pass(&spooler, &f, &mut taker).is_empty());
        assert!(staged(&f.staging).is_empty());
        assert_eq!(
            *spooler.reads.borrow(),
            vec![5],
            "the denied job was read again"
        );
        assert_eq!(spooler.left(), vec![5]);
    }

    #[test]
    fn only_this_accounts_held_queues_are_read() {
        let f = folders();
        let mut not_held = held_queue("Not held", &[OWN]);
        not_held.attributes = 0x40;
        let mut legacy = held_queue("Spectra PDF", &[]);
        legacy.port = LEGACY_PORT_NAME.to_string();
        let spooler = FakeSpooler {
            queues: RefCell::new(vec![
                held_queue("Spectra PDF (other)", &[OTHER, "S-1-15-2-1"]),
                not_held,
                legacy,
                held_queue("Spectra PDF (me)", &["S-1-15-2-1", OWN]),
            ]),
            ..FakeSpooler::default()
        };
        for (index, queue) in [
            "Spectra PDF (other)",
            "Not held",
            "Spectra PDF",
            "Spectra PDF (me)",
        ]
        .iter()
        .enumerate()
        {
            spooler.add(
                queue,
                job(index as u32 + 1, 1_700_000_000_000),
                b"%!PS",
                Read::Data,
            );
        }
        let read = take_jobs(
            &spooler,
            OWN,
            &f.staging,
            &f.ledger,
            &mut Taker::default(),
            &|_| {},
        )
        .unwrap();
        assert_eq!(read, vec!["Spectra PDF (me)".to_string()]);
        assert_eq!(*spooler.reads.borrow(), vec![4]);
    }

    #[test]
    fn a_staged_copy_without_an_entry_is_recorded_with_its_queue_and_deleted_without_a_read() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(9, 1_700_000_000_123),
            b"%!PS earlier",
            Read::Data,
        );
        let facts = listed(&spooler, 9);
        std::fs::write(f.staging.join(staged_name(&facts)), b"%!PS earlier").unwrap();
        pass(&spooler, &f, &mut Taker::default());
        assert!(spooler.reads.borrow().is_empty());
        assert_eq!(*spooler.deletes.borrow(), vec![9]);
        assert_eq!(staged(&f.staging).len(), 1);
        assert_eq!(
            std::fs::read_to_string(ledger_entry(&f.ledger, &staged_name(&facts), TAKEN_SUFFIX))
                .unwrap(),
            "Spectra PDF"
        );
    }

    #[test]
    fn an_empty_job_is_removed_without_a_staged_file() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add("Spectra PDF", job(2, 1_700_000_000_000), b"", Read::Data);
        let mut taker = Taker::default();
        assert!(pass(&spooler, &f, &mut taker).is_empty());
        assert!(staged(&f.staging).is_empty());
        assert!(spooler.left().is_empty());
    }

    #[test]
    fn a_job_over_the_limit_is_removed_and_named() {
        struct Huge {
            deletes: RefCell<Vec<u32>>,
        }
        impl Spooler for Huge {
            fn queues(&self) -> Result<Vec<QueueFacts>, String> {
                Ok(vec![held_queue("Spectra PDF", &[OWN])])
            }
            fn jobs(&self, _queue: &str) -> Result<Vec<JobFacts>, String> {
                Ok(vec![job(4, 1_700_000_000_000)])
            }
            fn read_job(
                &self,
                _queue: &str,
                _job: &JobFacts,
                sink: &mut dyn Write,
                limit: u64,
            ) -> Result<u64, ReadFailure> {
                sink.write_all(b"%!PS").unwrap();
                Ok(limit + 1)
            }
            fn delete_job(&self, _queue: &str, job: u32) -> Result<(), String> {
                self.deletes.borrow_mut().push(job);
                Ok(())
            }
        }
        let f = folders();
        let huge = Huge {
            deletes: RefCell::default(),
        };
        let errors = RefCell::new(Vec::new());
        take_jobs(
            &huge,
            OWN,
            &f.staging,
            &f.ledger,
            &mut Taker::default(),
            &|e| errors.borrow_mut().push(e),
        )
        .unwrap();
        assert!(staged(&f.staging).is_empty());
        assert_eq!(*huge.deletes.borrow(), vec![4]);
        assert!(
            errors.borrow().iter().any(|e| e.contains("byte limit")),
            "{:?}",
            errors.borrow()
        );
    }

    #[test]
    fn a_job_that_is_not_raw_is_removed_or_named_when_it_cannot_be() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        let mut emf = job(6, 1_700_000_000_000);
        emf.datatype = "NT EMF 1.008".to_string();
        spooler.add("Spectra PDF", emf.clone(), b"EMF", Read::Data);
        let mut kept = emf;
        kept.id = 60;
        spooler.add("Spectra PDF", kept, b"EMF", Read::Denied);
        let mut taker = Taker::default();
        let errors = pass(&spooler, &f, &mut taker);
        assert!(staged(&f.staging).is_empty());
        assert!(spooler.reads.borrow().is_empty());
        assert_eq!(spooler.left(), vec![60]);
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(
            errors.iter().all(|e| e.contains("NT EMF 1.008")),
            "{errors:?}"
        );
        assert!(errors[0].contains("was removed from"), "{errors:?}");
        assert!(
            errors[1].contains("could not be removed from"),
            "{errors:?}"
        );
        assert!(pass(&spooler, &f, &mut taker).is_empty());
    }

    #[test]
    fn a_job_that_vanishes_mid_read_is_named_and_leaves_no_partial_file() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(11, 1_700_000_000_000),
            b"%!PS",
            Read::Gone,
        );
        let errors = pass(&spooler, &f, &mut Taker::default());
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("removed from Spectra PDF"), "{errors:?}");
        assert!(staged(&f.staging).is_empty());
    }

    #[test]
    fn a_failing_read_is_retried_and_then_named_once() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(12, 1_700_000_000_000),
            b"%!PS",
            Read::Fail,
        );
        let mut taker = Taker::default();
        let mut errors = Vec::new();
        for _ in 0..(MAX_READ_ATTEMPTS + 2) {
            errors.extend(pass(&spooler, &f, &mut taker));
        }
        assert_eq!(spooler.reads.borrow().len(), MAX_READ_ATTEMPTS as usize);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(staged(&f.staging).is_empty());
    }

    #[test]
    fn a_read_that_fails_halfway_stages_nothing_and_is_tried_again() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(25, 1_700_000_000_000),
            b"%!PS the whole job",
            Read::FailHalfway,
        );
        let mut taker = Taker::default();
        let errors = pass(&spooler, &f, &mut taker);
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(staged(&f.staging).is_empty(), "a truncated job was staged");
        assert!(!taken(&f, &listed(&spooler, 25)));

        spooler.jobs.borrow_mut()[0].read = Read::Data;
        pass(&spooler, &f, &mut taker);
        assert_eq!(
            staged(&f.staging).into_values().collect::<Vec<_>>(),
            vec![b"%!PS the whole job".to_vec()]
        );
    }

    #[test]
    fn a_job_that_cannot_be_deleted_is_named_and_not_staged_twice() {
        let f = folders();
        let spooler = FakeSpooler::with_queue(held_queue("Spectra PDF", &[OWN]));
        spooler.add(
            "Spectra PDF",
            job(13, 1_700_000_000_000),
            b"%!PS",
            Read::Data,
        );
        spooler.refuse_delete.borrow_mut().insert(13);
        let mut taker = Taker::default();
        let errors = pass(&spooler, &f, &mut taker);
        assert_eq!(errors.len(), 1, "{errors:?}");
        pass(&spooler, &f, &mut taker);
        assert_eq!(*spooler.reads.borrow(), vec![13]);
        assert_eq!(staged(&f.staging).len(), 1);
    }

    /// A scripted ReadPrinter: each call returns the next step.
    fn scripted(
        steps: Vec<Result<&'static [u8], u32>>,
    ) -> impl FnMut(&mut [u8]) -> Result<u32, u32> {
        let mut steps = steps.into_iter();
        move |buffer: &mut [u8]| match steps.next() {
            Some(Ok(bytes)) => {
                buffer[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len() as u32)
            }
            Some(Err(code)) => Err(code),
            None => Ok(0),
        }
    }

    #[test]
    fn a_read_error_at_the_end_of_the_data_completes_the_read() {
        let mut sink = Vec::new();
        let mut read = scripted(vec![Ok(b"%!PS "), Ok(b"done"), Err(ERROR_GEN_FAILURE.0)]);
        assert_eq!(copy_job_data(&mut read, 9, &mut sink, 1024), Ok(9));
        assert_eq!(sink, b"%!PS done");

        for code in [ERROR_HANDLE_EOF.0, ERROR_NO_MORE_ITEMS.0] {
            let mut sink = Vec::new();
            let mut read = scripted(vec![Ok(b"%!PS"), Err(code)]);
            assert_eq!(copy_job_data(&mut read, 0, &mut sink, 1024), Ok(4));
        }
    }

    #[test]
    fn a_read_error_before_the_end_of_the_data_fails_the_read() {
        let mut sink = Vec::new();
        let mut read = scripted(vec![Ok(b"%!PS "), Err(ERROR_GEN_FAILURE.0)]);
        assert!(matches!(
            copy_job_data(&mut read, 9, &mut sink, 1024),
            Err(ReadFailure::Failed(_))
        ));
        let mut read = scripted(vec![Ok(b"%!PS "), Err(ERROR_PRINT_CANCELLED.0)]);
        assert_eq!(
            copy_job_data(&mut read, 9, &mut Vec::new(), 1024),
            Err(ReadFailure::Gone)
        );
        let mut read = scripted(vec![Ok(b"%!PS "), Ok(b"done")]);
        assert_eq!(copy_job_data(&mut read, 9, &mut Vec::new(), 1024), Ok(9));
    }

    #[test]
    fn read_errors_end_a_read_by_their_meaning() {
        assert_eq!(read_error_end(ERROR_PRINT_CANCELLED.0, 9, 9), ReadEnd::Gone);
        assert_eq!(read_error_end(ERROR_HANDLE_EOF.0, 0, 9), ReadEnd::Complete);
        assert_eq!(
            read_error_end(ERROR_NO_MORE_ITEMS.0, 3, 9),
            ReadEnd::Complete
        );
        assert_eq!(read_error_end(ERROR_GEN_FAILURE.0, 9, 9), ReadEnd::Complete);
        assert_eq!(read_error_end(ERROR_GEN_FAILURE.0, 8, 9), ReadEnd::Failed);
        assert_eq!(
            read_error_end(ERROR_GEN_FAILURE.0, 8, 0),
            ReadEnd::Failed,
            "an unknown size never vouches for a read"
        );
    }

    #[test]
    fn partial_reads_are_removed_unless_the_ledger_marks_them_taken() {
        let f = folders();
        let open = job(14, 1_700_000_000_000);
        let partial = part_path(&f.staging.join(staged_name(&open)));
        std::fs::write(&partial, b"%!PS ha").unwrap();
        let mut finished = job(16, 1_700_000_000_000);
        finished.size = 9;
        let interrupted = part_path(&f.staging.join(staged_name(&finished)));
        std::fs::write(&interrupted, b"%!PS whole").unwrap();
        std::fs::write(
            ledger_entry(&f.ledger, &staged_name(&finished), TAKEN_SUFFIX),
            b"",
        )
        .unwrap();
        std::fs::write(f.staging.join(staged_name(&job(15, 1))), b"%!PS done").unwrap();
        std::fs::write(f.staging.join("notes.part"), b"x").unwrap();
        let orphan = ledger_entry(&f.ledger, &staged_name(&job(17, 1)), DELIVERED_SUFFIX);
        std::fs::write(&orphan, b"Printed 1.pdf").unwrap();
        let half_written = ledger_entry(
            &f.ledger,
            &staged_name(&job(18, 1)),
            &format!("{TAKEN_SUFFIX}{ENTRY_TEMP_SUFFIX}"),
        );
        std::fs::write(&half_written, b"Spectra PDF").unwrap();

        assert_eq!(reclaim_staging(&f.staging, &f.ledger), 3);
        assert!(!partial.exists());
        assert!(!orphan.exists());
        assert!(!half_written.exists());
        assert_eq!(
            std::fs::read(f.staging.join(staged_name(&finished))).unwrap(),
            b"%!PS whole"
        );
        assert_eq!(staged(&f.staging).len(), 3);
    }

    #[test]
    fn staged_names_round_trip_to_their_output_stem() {
        let mut facts = job(42, 1_700_000_000_007);
        facts.size = 1234;
        let name = staged_name(&facts);
        assert_eq!(name, "Printed 1700000000-0070000000042.ps");
        assert_eq!(
            stem_of(Path::new(&name)).as_deref(),
            Some("Printed 1700000000")
        );
        let mut later = facts.clone();
        later.submitted_ms += 1;
        let mut other_id = facts.clone();
        other_id.id += 1;
        for other in [later, other_id] {
            assert_ne!(staged_name(&other), name);
        }
        let mut resized = facts.clone();
        resized.size += 1;
        assert_eq!(
            staged_name(&resized),
            name,
            "the key must not depend on the reported size"
        );
        for other in [
            "Printed 1.ps",
            "notes-1.ps",
            "Printed 1-x.ps",
            "Printed 1-2.pdf",
            "Printed 1-.ps",
            "Printed 1-2.ps.part",
        ] {
            assert_eq!(stem_of(Path::new(other)), None, "{other}");
        }
    }

    #[test]
    fn raw_datatypes_are_recognized_and_nothing_else() {
        for raw in ["RAW", "raw", "RAW [FF appended]", "RAW [FF auto]", " RAW "] {
            assert!(datatype_is_raw(raw), "{raw}");
        }
        for other in ["", "NT EMF 1.008", "TEXT", "XPS2GDI", "RAWX", "RA"] {
            assert!(!datatype_is_raw(other), "{other}");
        }
    }

    #[test]
    fn a_pass_delivers_each_staged_job_once_and_leaves_other_files() {
        let f = folders();
        std::fs::write(f.staging.join("Printed 100-3.ps"), b"%!PS earlier").unwrap();
        std::fs::write(f.staging.join("notes.ps"), b"%!PS").unwrap();
        std::fs::write(f.staging.join("Printed 101-4.ps.part"), b"%!PS ha").unwrap();
        let attempted = Mutex::new(HashSet::new());
        let delivered = Mutex::new(Vec::new());
        let errors = Mutex::new(Vec::new());
        let record = |e: String| errors.lock().unwrap().push(e);
        let deliver = |stem: String, path: PathBuf| {
            delivered
                .lock()
                .unwrap()
                .push((stem, std::fs::read(&path).unwrap()))
        };
        deliver_staged(&f.staging, &attempted, &record, &deliver);
        deliver_staged(&f.staging, &attempted, &record, &deliver);
        assert_eq!(
            delivered.into_inner().unwrap(),
            vec![("Printed 100".to_string(), b"%!PS earlier".to_vec())]
        );
        assert!(errors.into_inner().unwrap().is_empty());
        assert!(f.staging.join("notes.ps").is_file());
        assert!(
            names(&f.ledger).is_empty(),
            "delivery wrote a ledger entry without a queue"
        );
    }

    struct Delivery {
        _dir: tempfile::TempDir,
        ledger: PathBuf,
        printed: PathBuf,
        staged: PathBuf,
    }

    fn delivery() -> Delivery {
        let dir = tempfile::tempdir().unwrap();
        let ledger = dir.path().join(LEDGER_DIR);
        let printed = dir.path().join("printed");
        let staging = dir.path().join(STAGING_DIR);
        for folder in [&ledger, &printed, &staging] {
            std::fs::create_dir(folder).unwrap();
        }
        let staged = staging.join("Printed 1700000000-0070000000042.ps");
        std::fs::write(&staged, b"%!PS job").unwrap();
        Delivery {
            _dir: dir,
            ledger,
            printed,
            staged,
        }
    }

    fn record_of(d: &Delivery) -> PathBuf {
        let name = d.staged.file_name().unwrap().to_str().unwrap();
        ledger_entry(&d.ledger, name, DELIVERED_SUFFIX)
    }

    #[test]
    fn a_delivered_job_opens_once_and_leaves_no_staged_file_or_record() {
        let d = delivery();
        let opened = RefCell::new(Vec::new());
        let printed = d.printed.clone();
        let convert = |_: &Path,
                       stem: &str,
                       before_rename: &dyn Fn(&Path) -> Result<(), String>|
         -> Result<PathBuf, String> {
            let pdf = printed.join(format!("{stem}.pdf"));
            before_rename(&pdf)?;
            std::fs::write(&pdf, b"%PDF-1.7").unwrap();
            Ok(pdf)
        };
        let open = |pdf: &Path| opened.borrow_mut().push(pdf.to_path_buf());
        let pdf = deliver_one(
            &d.ledger,
            &d.printed,
            &d.staged,
            "Printed 1700000000",
            &convert,
            &open,
        )
        .unwrap();
        assert_eq!(*opened.borrow(), vec![pdf]);
        assert!(!d.staged.exists());
        assert!(!record_of(&d).exists());
    }

    #[test]
    fn a_stop_after_the_pdf_was_named_opens_that_pdf_instead_of_distilling_again() {
        let d = delivery();
        let pdf = d.printed.join("Printed 1700000000.pdf");
        std::fs::write(&pdf, b"%PDF-1.7 earlier").unwrap();
        std::fs::write(record_of(&d), b"Printed 1700000000.pdf").unwrap();
        let converted = RefCell::new(0);
        let convert = |_: &Path,
                       _: &str,
                       _: &dyn Fn(&Path) -> Result<(), String>|
         -> Result<PathBuf, String> {
            *converted.borrow_mut() += 1;
            Err("distilled a second copy".to_string())
        };
        let opened = RefCell::new(Vec::new());
        let open = |pdf: &Path| opened.borrow_mut().push(pdf.to_path_buf());
        let result = deliver_one(
            &d.ledger,
            &d.printed,
            &d.staged,
            "Printed 1700000000",
            &convert,
            &open,
        );
        assert_eq!(result, Ok(pdf.clone()));
        assert_eq!(*converted.borrow(), 0);
        assert_eq!(*opened.borrow(), vec![pdf]);
        assert!(!d.staged.exists());
        assert!(!record_of(&d).exists());
        assert_eq!(names(&d.printed).len(), 1, "a duplicate PDF was written");
    }

    #[test]
    fn a_stop_before_the_pdf_was_named_distils_the_job_again() {
        let d = delivery();
        std::fs::write(record_of(&d), b"Printed 1700000000.pdf").unwrap();
        let converted = RefCell::new(0);
        let printed = d.printed.clone();
        let convert = |_: &Path,
                       stem: &str,
                       before_rename: &dyn Fn(&Path) -> Result<(), String>|
         -> Result<PathBuf, String> {
            *converted.borrow_mut() += 1;
            let pdf = printed.join(format!("{stem}.pdf"));
            before_rename(&pdf)?;
            std::fs::write(&pdf, b"%PDF-1.7").unwrap();
            Ok(pdf)
        };
        deliver_one(
            &d.ledger,
            &d.printed,
            &d.staged,
            "Printed 1700000000",
            &convert,
            &|_| {},
        )
        .unwrap();
        assert_eq!(*converted.borrow(), 1);
    }

    #[test]
    fn a_failed_conversion_keeps_the_staged_job_and_names_when_it_is_tried_again() {
        let d = delivery();
        let convert = |_: &Path,
                       _: &str,
                       before_rename: &dyn Fn(&Path) -> Result<(), String>|
         -> Result<PathBuf, String> {
            before_rename(Path::new("Printed 1700000000.pdf"))?;
            Err("the print job could not be converted: no Ghostscript".to_string())
        };
        let opened = RefCell::new(0);
        let open = |_: &Path| *opened.borrow_mut() += 1;
        let error = deliver_one(
            &d.ledger,
            &d.printed,
            &d.staged,
            "Printed 1700000000",
            &convert,
            &open,
        )
        .unwrap_err();
        assert!(error.contains("no Ghostscript"), "{error}");
        assert!(
            error.contains("tried again the next time Spectra PDF starts"),
            "{error}"
        );
        assert!(
            error.contains(&d.staged.parent().unwrap().display().to_string()),
            "{error}"
        );
        assert_eq!(std::fs::read(&d.staged).unwrap(), b"%!PS job");
        assert!(!record_of(&d).exists());
        assert_eq!(*opened.borrow(), 0);
    }

    #[test]
    fn settings_names_this_accounts_queue_and_a_loopback_candidate() {
        let mut legacy = held_queue("Old printer", &[]);
        legacy.port = "spectrapdf_9100".to_string();
        legacy.attributes = 0x40;
        let queues = vec![
            held_queue("Spectra PDF", &[OTHER]),
            held_queue("Spectra PDF (me)", &[OWN]),
            legacy,
        ];
        assert_eq!(
            account_view(&queues, Some(OWN)),
            AccountView {
                installed: true,
                name: Some("Spectra PDF (me)".to_string()),
                legacy_present: true
            }
        );
        assert_eq!(
            account_view(&queues[..1], Some(OWN)),
            AccountView {
                installed: false,
                name: None,
                legacy_present: false
            }
        );
        assert_eq!(
            account_view(&queues, None),
            AccountView {
                installed: false,
                name: None,
                legacy_present: true
            }
        );
    }

    #[test]
    fn the_loopback_check_answers_no_only_when_it_says_so() {
        assert!(legacy_answer("legacy=yes\r\n"));
        assert!(!legacy_answer("legacy=no\r\n"));
        assert!(
            legacy_answer(""),
            "a check that printed nothing proves nothing"
        );
    }

    #[test]
    fn the_update_notice_shows_only_after_the_loopback_queue_is_gone_and_until_this_account_acts() {
        let none = AccountView::default();
        assert!(replaced_notice(true, &none, false));
        assert!(
            !replaced_notice(false, &none, false),
            "no update removed anything"
        );
        assert!(
            !replaced_notice(true, &none, true),
            "this account installed or removed its printer"
        );
        let installed = AccountView {
            installed: true,
            ..AccountView::default()
        };
        assert!(!replaced_notice(true, &installed, false));
        let legacy = AccountView {
            legacy_present: true,
            ..AccountView::default()
        };
        assert!(
            !replaced_notice(true, &legacy, false),
            "the loopback queue is still there"
        );
    }

    #[test]
    fn an_elevated_failure_always_names_a_reason() {
        assert_eq!(
            elevated_failure(
                INSTALL_FAILED,
                "",
                Some("Printer x could not be paused.".into())
            ),
            "The printer was not installed: Printer x could not be paused."
        );
        assert_eq!(
            elevated_failure(REMOVE_FAILED, "Access is denied.", None),
            "The printer was not removed: Access is denied."
        );
        assert_eq!(
            elevated_failure(INSTALL_FAILED, "  ", Some(" ".into())),
            "The printer was not installed: the administrator step ended without a reason."
        );
        assert_eq!(
            elevated_failure(INSTALL_FAILED, super::super::ELEVATION_DECLINED, None),
            super::super::ELEVATION_DECLINED
        );
    }

    #[test]
    fn the_queue_comment_is_plain_bounded_text() {
        assert_eq!(queue_comment(""), DEFAULT_QUEUE_COMMENT);
        assert_eq!(queue_comment(" \r\n\t"), DEFAULT_QUEUE_COMMENT);
        assert_eq!(queue_comment("Für\nSpectra PDF"), "FürSpectra PDF");
        assert_eq!(
            queue_comment(&"x".repeat(500)).chars().count(),
            MAX_COMMENT_CHARS
        );
    }

    fn descriptor(sddl: &str) -> windows::Win32::Security::PSECURITY_DESCRIPTOR {
        use windows::core::PCWSTR;
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        let text = wide(std::ffi::OsStr::new(sddl));
        let mut sd = windows::Win32::Security::PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        }
        .unwrap_or_else(|e| panic!("{sddl}: {e}"));
        sd
    }

    fn free(sd: windows::Win32::Security::PSECURITY_DESCRIPTOR) {
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        unsafe {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
    }

    fn grantees_of(sddl: &str) -> Vec<String> {
        let sd = descriptor(sddl);
        let grantees = unsafe { print_grantees(sd) };
        free(sd);
        grantees.expect("a readable security descriptor")
    }

    fn entries_of(sddl: &str) -> Vec<AceEntry> {
        let sd = descriptor(sddl);
        let entries = unsafe { dacl_entries(sd) }.unwrap().expect("a DACL");
        free(sd);
        entries
    }

    #[test]
    fn print_grantees_count_direct_and_generic_rights_and_skip_job_entries() {
        assert_eq!(
            grantees_of(&format!(
                "O:SYG:SYD:(A;;0x20008;;;{OWN})(A;OIIO;GA;;;CO)(A;;LCSWSDRCWDWO;;;BA)(A;;0xF0004;;;S-1-5-32-550)(A;;GR;;;AU)(D;;SW;;;WD)"
            )),
            vec![OWN.to_string(), "S-1-5-32-544".to_string(), "S-1-5-11".to_string()]
        );
        assert_eq!(
            grantees_of("O:SYG:SYD:NO_ACCESS_CONTROL"),
            vec!["S-1-1-0".to_string()]
        );
    }

    #[test]
    fn the_staging_folder_carries_only_the_private_dacl() {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW,
            SDDL_REVISION_1, SE_FILE_OBJECT,
        };
        use windows::Win32::Security::{DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR};

        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::under(dir.path());
        let sid = sid();
        prepare(&layout, &sid).unwrap();
        let path = wide(layout.staging.as_os_str());
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let status = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut sd,
            )
        };
        assert_eq!(status, ERROR_SUCCESS);
        let mut text = PWSTR::null();
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
        }
        .unwrap();
        let sddl = unsafe { text.to_string() }.unwrap();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
        let aces: Vec<&str> = sddl.split('(').skip(1).collect();
        assert_eq!(aces.len(), 2, "{sddl}");
        assert!(sddl.contains(&format!(";FA;;;{sid})")), "{sddl}");
        assert!(sddl.contains(";FA;;;SY)"), "{sddl}");
    }

    #[test]
    fn one_receiver_per_account_holds_the_claim() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::under(dir.path());
        prepare(&layout, &sid()).unwrap();
        let claim = claim_receiver(&layout.lock).unwrap();
        assert!(matches!(
            claim_receiver(&layout.lock),
            Err(ClaimFailure::HeldElsewhere)
        ));
        drop(claim);
        assert!(claim_receiver(&layout.lock).is_ok());
    }

    #[test]
    fn printer_name_labels_drop_what_printer_names_refuse() {
        assert_eq!(printer_name_label(r"ACME\jo,e"), "ACMEjoe");
        assert_eq!(printer_name_label("  "), "user");
        assert_eq!(printer_name_label("Jos\u{e9}"), "Jos\u{e9}");
    }

    // ── the scripts, against a fake spooler ────────────────────────────────

    const FAKE_MARKER: &str = "\
function Set-SpMarker($n) { $script:markers[$n] = $true; $script:events += ('set-' + $n) }
function Test-SpMarker($n) { return [bool]$script:markers[$n] }
function Clear-SpMarker($n) { [void]$script:markers.Remove($n); $script:events += ('clear-' + $n) }
function Clear-SpMarkers { $script:markers = @{}; $script:events += 'clear-markers' }
function Set-SpResult($nonce, $message) { $script:resultNonce = $nonce; $script:resultMessage = $message; $script:events += 'set-result' }
function Clear-SpResult { $script:resultNonce = ''; $script:resultMessage = '' }
";

    const NONCE: &str = "0123456789abcdef0123456789abcdef";
    const COMMENT: &str = "Gehalten f\u{fc}r Spectra PDF; Auftr\u{e4}ge \u{f6}ffnen in der App";

    const CAPABILITY: &str = "S-1-15-3-1024-1-2-3-4-5-6-7-8";

    /// What Windows assigns a new queue: Print for Everyone and the
    /// AppContainer entries, full control for Administrators and the account
    /// that added the queue.
    fn default_sddl() -> String {
        format!(
            "O:SYG:SYD:(A;OIIO;GA;;;CO)(A;OIIO;GA;;;AC)(A;;SWRC;;;WD)(A;CIIO;GX;;;WD)(A;;SWRC;;;AC)(A;CIIO;GX;;;AC)(A;;LCSWDTSDRCWDWO;;;BA)(A;OICIIO;GA;;;BA)(A;OIIO;GA;;;{CAPABILITY})(A;;SWRC;;;{CAPABILITY})(A;CIIO;GX;;;{CAPABILITY})(A;;LCSWDTSDRCWDWO;;;S-1-5-21-9-9-9-500)"
        )
    }

    fn account() -> Account {
        Account {
            sid: OWN.to_string(),
            user_name: "Jos\u{e9} O'Neil".to_string(),
        }
    }

    fn private_sddl(sid: &str) -> String {
        format!("O:SYG:SYD:(A;OIIO;GA;;;CO)(A;;SWRC;;;AC)(A;;LCSDRCWDWO;;;BA)(A;;0x20008;;;{sid})")
    }

    /// A printer record of the fake spooler.
    fn printer(name: &str, driver: &str, port: &str, sddl: &str, held: bool) -> String {
        format!(
            "[pscustomobject]@{{ Name='{}'; DriverName='{driver}'; PortName='{port}'; PermissionSDDL='{sddl}'; KeepPrintedJobs=${held}; Datatype='RAW'; RawOnly=${held}; Paused=${held}; Comment='' }}",
            name.replace('\'', "''")
        )
    }

    fn local_port(name: &str) -> String {
        format!(
            "[pscustomobject]@{{ Name='{}'; CimClass=[pscustomobject]@{{ CimClassName='MSFT_LocalPrinterPort' }} }}",
            name.replace('\'', "''")
        )
    }

    const LEGACY_PORT: &str = "[pscustomobject]@{ Name='SpectraPDF_9100'; PrinterHostAddress='127.0.0.1'; PortNumber=9100; Protocol=1; CimClass=[pscustomobject]@{ CimClassName='MSFT_TcpIpPrinterPort' } }";

    fn legacy_printer(name: &str) -> String {
        printer(
            name,
            DRIVER_NAME,
            LEGACY_PORT_NAME,
            "O:SYG:SYD:(A;;SWRC;;;WD)",
            false,
        )
    }

    fn run_probe(setup: &str, script: &str) -> serde_json::Value {
        let harness = r#"
$script:printers = @()
$script:ports = @()
$script:jobs = @()
$script:events = @()
$script:markers = @{}
$script:defaultSddl = ''
$script:resultNonce = ''
$script:resultMessage = ''
function Find-FakePrinter($name) { return @($script:printers | Where-Object { $_.Name -eq $name })[0] }
function Get-Printer {
  [CmdletBinding()]
  param([string]$Name, [switch]$Full)
  if ($PSBoundParameters.ContainsKey('Name')) { return @($script:printers | Where-Object { $_.Name -like $Name }) }
  return @($script:printers)
}
function Get-PrinterPort {
  [CmdletBinding()]
  param([string]$Name)
  return @($script:ports)
}
function Add-PrinterPort {
  [CmdletBinding()]
  param([string]$Name)
  $script:events += 'add-port'
  $port = [pscustomobject]@{ Name=$Name; CimClass=[pscustomobject]@{ CimClassName='MSFT_LocalPrinterPort' } }
  $script:ports += $port
  return $port
}
function Remove-PrinterPort {
  [CmdletBinding()]
  param([string]$Name)
  $script:events += 'remove-port'
  $script:ports = @($script:ports | Where-Object { $_.Name -ne $Name })
}
function Add-Printer {
  [CmdletBinding()]
  param([string]$Name, [string]$DriverName, [string]$PortName, [switch]$KeepPrintedJobs, [string]$Datatype, [string]$PermissionSDDL, [string]$Comment)
  $script:events += 'add-printer'
  $record = [pscustomobject]@{ Name=$Name; DriverName=$DriverName; PortName=$PortName; PermissionSDDL=$script:defaultSddl; KeepPrintedJobs=[bool]$KeepPrintedJobs; Datatype=$Datatype; RawOnly=$false; Paused=$false; Comment=$Comment }
  $script:printers += $record
  return $record
}
function Set-Printer {
  [CmdletBinding()]
  param($InputObject, [string]$Name, [string]$PermissionSDDL, $KeepPrintedJobs, [string]$Datatype, [string]$Comment)
  if ($PSBoundParameters.ContainsKey('Name')) { throw 'Set-Printer was called by name' }
  $target = Find-FakePrinter $InputObject.Name
  if ($PSBoundParameters.ContainsKey('PermissionSDDL')) { $target.PermissionSDDL = $PermissionSDDL; $script:events += 'set-permissions' }
  if ($PSBoundParameters.ContainsKey('KeepPrintedJobs')) { $target.KeepPrintedJobs = [bool]$KeepPrintedJobs }
  if ($PSBoundParameters.ContainsKey('Datatype')) { $target.Datatype = $Datatype }
  if ($PSBoundParameters.ContainsKey('Comment')) { $target.Comment = $Comment }
}
function Remove-Printer {
  [CmdletBinding()]
  param($InputObject, [string]$Name)
  if ($PSBoundParameters.ContainsKey('Name')) { throw 'Remove-Printer was called by name' }
  $script:events += 'remove-printer'
  $script:printers = @($script:printers | Where-Object { $_.Name -ne $InputObject.Name })
}
function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName)
  return @($script:printers | ForEach-Object {
    $attributes = 0x40
    if ($_.KeepPrintedJobs) { $attributes = $attributes -bor 0x100 }
    if ($_.RawOnly) { $attributes = $attributes -bor 0x1000 }
    [pscustomobject]@{ Name=$_.Name; Attributes=[uint32]$attributes }
  })
}
function Set-CimInstance {
  [CmdletBinding()]
  param($InputObject, [hashtable]$Property)
  $target = Find-FakePrinter $InputObject.Name
  if ($Property.ContainsKey('RawOnly')) { $target.RawOnly = [bool]$Property['RawOnly']; $script:events += 'raw-only' }
}
function Invoke-CimMethod {
  [CmdletBinding()]
  param($InputObject, [string]$MethodName)
  $target = Find-FakePrinter $InputObject.Name
  if ($MethodName -eq 'Pause') { $target.Paused = $true; $script:events += 'pause' }
  return [pscustomobject]@{ ReturnValue = 0 }
}
function Get-PrintJob {
  [CmdletBinding()]
  param($PrinterObject)
  return @($script:jobs | Where-Object { $_.PrinterName -eq $PrinterObject.Name })
}
function Remove-PrintJob {
  [CmdletBinding()]
  param($InputObject)
  $script:events += 'remove-job'
  $script:jobs = @($script:jobs | Where-Object { -not ($_.PrinterName -eq $InputObject.PrinterName -and $_.Id -eq $InputObject.Id) })
}
__SETUP__
$script:message = ''
$script:output = @()
try {
  $script:output = @(& { __SCRIPT__ })
  $script:result = 'OK'
} catch {
  $script:result = 'ERROR'
  $script:message = $_.Exception.Message
}
$state = [ordered]@{
  result = $script:result
  message = $script:message
  events = @($script:events)
  printers = @($script:printers)
  ports = @($script:ports | ForEach-Object { $_.Name })
  jobs = @($script:jobs)
  markers = @($script:markers.Keys | Sort-Object)
  output = @($script:output | ForEach-Object { [string]$_ })
  resultNonce = $script:resultNonce
  resultMessage = $script:resultMessage
}
'STATE=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $state -Depth 6 -Compress)))
"#;
        let setup = format!("$script:defaultSddl = '{}'\n{setup}", default_sddl());
        let command = harness
            .replace("__SETUP__", &setup)
            .replace("__SCRIPT__", script);
        let out = super::super::run_powershell(&[&command]).unwrap();
        let line = out
            .lines()
            .find_map(|line| line.trim().strip_prefix("STATE="))
            .unwrap_or_else(|| panic!("no state in {out}"));
        let json = base64::engine::general_purpose::STANDARD
            .decode(line)
            .unwrap();
        serde_json::from_slice(&json).unwrap()
    }

    fn texts(state: &serde_json::Value, key: &str) -> Vec<String> {
        state[key]
            .as_array()
            .unwrap_or_else(|| panic!("{key} in {state}"))
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect()
    }

    fn printer_names(state: &serde_json::Value) -> Vec<String> {
        state["printers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|printer| printer["Name"].as_str().unwrap().to_string())
            .collect()
    }

    fn printer_named<'a>(state: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
        state["printers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|printer| printer["Name"] == name)
            .unwrap_or_else(|| panic!("{name} in {state}"))
    }

    fn assert_ok(state: &serde_json::Value) {
        assert_eq!(state["result"], "OK", "{state}");
    }

    #[test]
    fn every_script_is_ascii_and_embeds_account_values_only_encoded() {
        let a = account();
        for script in [
            install_script(&a, COMMENT, NONCE, MARKER_FUNCTIONS),
            uninstall_script(&a, NONCE, MARKER_FUNCTIONS),
            retire_legacy_script(MARKER_FUNCTIONS),
            remove_all_script(MARKER_FUNCTIONS),
            legacy_probe_script(),
        ] {
            assert!(script.is_ascii());
            assert!(
                !script.contains("O'Neil") && !script.contains("Spectra PDF; Auftr"),
                "an account value or the comment was embedded unencoded"
            );
            assert!(
                !script.contains("__"),
                "a template token was left in the script"
            );
            assert!(
                !script.contains("Set-Printer -Name") && !script.contains("Remove-Printer -Name")
            );
        }
    }

    #[test]
    fn the_elevated_scripts_fit_the_windows_command_line() {
        let longest = "\u{1f5a8}".repeat(MAX_COMMENT_CHARS * 2);
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        for script in [
            install_script(&account(), &longest, &nonce, MARKER_FUNCTIONS),
            uninstall_script(&account(), &nonce, MARKER_FUNCTIONS),
        ] {
            let units = super::super::elevation_command(&script)
                .encode_utf16()
                .count();
            assert!(units + 512 < 32_767, "{units} UTF-16 units");
        }
    }

    #[test]
    fn install_adds_a_held_queue_only_this_account_can_print_to() {
        let state = run_probe(
            "$script:jobs = @([pscustomobject]@{ PrinterName='Spectra PDF'; Id=1 })",
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        assert_eq!(
            texts(&state, "events"),
            [
                "add-port",
                "set-HoldPortCreated",
                "add-printer",
                "set-permissions",
                "raw-only",
                "pause",
                "remove-job"
            ]
        );
        assert_eq!(texts(&state, "ports"), [HOLD_PORT]);
        assert_eq!(texts(&state, "markers"), ["HoldPortCreated"]);
        assert!(
            state["jobs"].as_array().unwrap().is_empty(),
            "a job queued before the queue was private survived"
        );
        let queue = printer_named(&state, "Spectra PDF");
        assert_eq!(queue["PortName"], HOLD_PORT);
        assert_eq!(queue["DriverName"], DRIVER_NAME);
        assert_eq!(queue["KeepPrintedJobs"], true);
        assert_eq!(queue["RawOnly"], true);
        assert_eq!(queue["Paused"], true);
        assert_eq!(queue["Datatype"], "RAW");
        assert_eq!(queue["Comment"], COMMENT);
        assert_eq!(state["resultNonce"], "", "a successful run left a failure");

        let sddl = queue["PermissionSDDL"].as_str().unwrap();
        let mut grantees = grantees_of(sddl);
        grantees.sort();
        let mut expected = vec![
            OWN.to_string(),
            "S-1-15-2-1".to_string(),
            CAPABILITY.to_string(),
        ];
        expected.sort();
        assert_eq!(grantees, expected, "{sddl}");
        let entries = entries_of(sddl);
        assert!(entries.iter().all(|entry| entry.sid != "S-1-1-0"), "{sddl}");
        let admins: Vec<&AceEntry> = entries
            .iter()
            .filter(|entry| entry.sid == "S-1-5-32-544" && !entry.inherit_only)
            .collect();
        assert_eq!(admins.len(), 1, "{sddl}");
        assert_eq!(
            admins[0].mask, 0xF0044,
            "administrators keep management rights without Print: {sddl}"
        );
        assert!(
            entries.iter().any(|entry| entry.sid == "S-1-3-0"
                && entry.allow
                && entry.inherit_only
                && entry.object_inherit),
            "the job owner lost the right to delete a job: {sddl}"
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.sid == CAPABILITY && entry.inherit_only),
            "the capability's job entry was dropped: {sddl}"
        );
        assert!(
            entries
                .iter()
                .any(|entry| entry.sid == OWN && entry.mask == 0x20008 && !entry.inherit_only),
            "{sddl}"
        );
    }

    #[test]
    fn install_adds_the_job_owner_entry_when_the_default_has_none() {
        let setup = "$script:defaultSddl = 'O:SYG:SYD:(A;;SWRC;;;WD)(A;;LCSWSDRCWDWO;;;BA)'";
        let state = run_probe(
            setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        let sddl = printer_named(&state, "Spectra PDF")["PermissionSDDL"]
            .as_str()
            .unwrap()
            .to_string();
        let creator: Vec<AceEntry> = entries_of(&sddl)
            .into_iter()
            .filter(|entry| entry.sid == "S-1-3-0")
            .collect();
        assert_eq!(creator.len(), 1, "{sddl}");
        assert!(
            creator[0].inherit_only && creator[0].object_inherit && creator[0].mask == 0xF0030,
            "{sddl}"
        );
        assert_eq!(grantees_of(&sddl), vec![OWN.to_string()]);
    }

    #[test]
    fn install_reuses_an_existing_nul_port_and_never_claims_it() {
        let setup = format!("$script:ports = @({})", local_port("nul:"));
        let state = run_probe(
            &setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        assert_eq!(texts(&state, "ports"), ["nul:"]);
        assert!(texts(&state, "markers").is_empty());
        assert!(!texts(&state, "events").contains(&"add-port".to_string()));
        assert_eq!(printer_named(&state, "Spectra PDF")["PortName"], "nul:");
    }

    #[test]
    fn install_retires_a_renamed_loopback_queue_and_its_waiting_jobs() {
        let setup = format!(
            "$script:ports = @({LEGACY_PORT})\n$script:printers = @({})\n$script:jobs = @([pscustomobject]@{{ PrinterName='My PDF printer'; Id=4 }})",
            legacy_printer("My PDF printer")
        );
        let state = run_probe(
            &setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        let events = texts(&state, "events");
        assert_eq!(
            &events[..4],
            [
                "remove-job",
                "remove-printer",
                "remove-port",
                "set-Replaced"
            ],
            "{events:?}"
        );
        assert_eq!(printer_names(&state), ["Spectra PDF"]);
        assert_eq!(texts(&state, "ports"), [HOLD_PORT]);
        assert_eq!(texts(&state, "markers"), ["HoldPortCreated", "Replaced"]);
    }

    #[test]
    fn the_settings_loopback_check_uses_the_scripts_match() {
        let foreign_port = "[pscustomobject]@{ Name='SpectraPDF_9100'; PrinterHostAddress='203.0.113.7'; PortNumber=9100; Protocol=1; CimClass=[pscustomobject]@{ CimClassName='MSFT_TcpIpPrinterPort' } }";
        for (port, answer) in [(LEGACY_PORT, "legacy=yes"), (foreign_port, "legacy=no")] {
            let setup = format!(
                "$script:ports = @({port})\n$script:printers = @({})",
                legacy_printer("Spectra PDF")
            );
            let state = run_probe(&setup, &legacy_probe_script());
            assert_ok(&state);
            assert_eq!(texts(&state, "output"), [answer], "{port}");
            assert!(
                texts(&state, "events").is_empty(),
                "the check changed something"
            );
        }
    }

    #[test]
    fn the_loopback_match_needs_the_driver_and_the_loopback_port_configuration() {
        let foreign_port = "[pscustomobject]@{ Name='SpectraPDF_9100'; PrinterHostAddress='203.0.113.7'; PortNumber=9100; Protocol=1; CimClass=[pscustomobject]@{ CimClassName='MSFT_TcpIpPrinterPort' } }";
        let setup = format!(
            "$script:ports = @({foreign_port})\n$script:printers = @({})",
            legacy_printer("Spectra PDF")
        );
        let state = run_probe(&setup, &retire_legacy_script(FAKE_MARKER));
        assert_ok(&state);
        assert!(
            texts(&state, "events").is_empty(),
            "a port aimed elsewhere was treated as the loopback queue"
        );

        let setup = format!(
            "$script:ports = @({LEGACY_PORT})\n$script:printers = @({})",
            printer(
                "Spectra PDF",
                "Other driver",
                LEGACY_PORT_NAME,
                "O:SYG:SYD:(A;;SWRC;;;WD)",
                false
            )
        );
        let state = run_probe(&setup, &retire_legacy_script(FAKE_MARKER));
        assert_ok(&state);
        assert!(
            texts(&state, "events").is_empty(),
            "another driver's queue was removed"
        );
    }

    #[test]
    fn install_repairs_an_installed_queue_without_touching_its_jobs() {
        let setup = format!(
            "$script:ports = @({})\n$script:printers = @({})\n$script:jobs = @([pscustomobject]@{{ PrinterName='Spectra PDF'; Id=2 }})",
            local_port(HOLD_PORT),
            printer("Spectra PDF", DRIVER_NAME, HOLD_PORT, &private_sddl(OWN), true)
        );
        let state = run_probe(
            &setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        assert_eq!(texts(&state, "events"), ["raw-only", "pause"]);
        assert_eq!(
            state["jobs"].as_array().unwrap().len(),
            1,
            "a waiting job was deleted"
        );
        assert_eq!(printer_named(&state, "Spectra PDF")["Comment"], COMMENT);
    }

    #[test]
    fn install_closes_a_queue_that_was_opened_to_other_accounts() {
        let open = format!("{}(A;;SWRC;;;BU)", private_sddl(OWN));
        let setup = format!(
            "$script:ports = @({})\n$script:printers = @({})",
            local_port(HOLD_PORT),
            printer("Spectra PDF", DRIVER_NAME, HOLD_PORT, &open, true)
        );
        let state = run_probe(
            &setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        assert_eq!(
            texts(&state, "events"),
            ["set-permissions", "raw-only", "pause"]
        );
        let sddl = printer_named(&state, "Spectra PDF")["PermissionSDDL"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            !grantees_of(&sddl).contains(&"S-1-5-32-545".to_string()),
            "{sddl}"
        );
    }

    #[test]
    fn a_second_account_gets_its_own_named_queue() {
        let setup = format!(
            "$script:ports = @({})\n$script:printers = @({})",
            local_port(HOLD_PORT),
            printer(
                "Spectra PDF",
                DRIVER_NAME,
                HOLD_PORT,
                &private_sddl(OTHER),
                true
            )
        );
        let state = run_probe(
            &setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        assert_eq!(
            printer_names(&state),
            ["Spectra PDF", "Spectra PDF (Jos\u{e9} O'Neil)"]
        );
        assert!(
            texts(&state, "markers").is_empty(),
            "a port another queue made was claimed"
        );
        assert_eq!(
            printer_named(&state, "Spectra PDF")["PermissionSDDL"]
                .as_str()
                .unwrap(),
            private_sddl(OTHER),
            "the other account's queue was changed"
        );
    }

    #[test]
    fn install_rolls_back_the_queue_and_the_port_it_made_when_holding_fails() {
        let setup = "function Invoke-CimMethod { throw 'simulated pause failure' }";
        let state = run_probe(
            setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_eq!(state["result"], "ERROR", "{state}");
        assert!(
            state["message"]
                .as_str()
                .unwrap()
                .contains("simulated pause failure"),
            "{state}"
        );
        assert!(printer_names(&state).is_empty());
        assert!(texts(&state, "ports").is_empty());
        assert!(texts(&state, "markers").is_empty());
        assert_eq!(state["resultNonce"], NONCE, "{state}");
        assert!(
            state["resultMessage"]
                .as_str()
                .unwrap()
                .contains("simulated pause failure"),
            "the app would show no reason: {state}"
        );
    }

    #[test]
    fn an_uninstall_failure_records_its_reason_for_the_app() {
        let setup = format!(
            "$script:printers = @({})\nfunction Remove-Printer {{ throw 'simulated removal failure' }}",
            printer("Spectra PDF", DRIVER_NAME, HOLD_PORT, &private_sddl(OWN), true)
        );
        let state = run_probe(&setup, &uninstall_script(&account(), NONCE, FAKE_MARKER));
        assert_eq!(state["result"], "ERROR", "{state}");
        assert_eq!(state["resultNonce"], NONCE, "{state}");
        assert_eq!(
            state["resultMessage"], "simulated removal failure",
            "{state}"
        );
    }

    #[test]
    fn install_refuses_a_nul_port_that_is_not_a_local_port() {
        let setup = "$script:ports = @([pscustomobject]@{ Name='NUL:'; PrinterHostAddress='203.0.113.7'; PortNumber=9100; Protocol=1; CimClass=[pscustomobject]@{ CimClassName='MSFT_TcpIpPrinterPort' } })";
        let state = run_probe(
            setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_eq!(state["result"], "ERROR", "{state}");
        assert!(
            state["message"]
                .as_str()
                .unwrap()
                .contains("not a local port"),
            "{state}"
        );
        assert!(printer_names(&state).is_empty());
    }

    #[test]
    fn install_keeps_a_foreign_printer_that_uses_the_product_name() {
        let setup = format!(
            "$script:printers = @({})",
            printer(
                "Spectra PDF",
                "Microsoft Print to PDF",
                "PORTPROMPT:",
                "O:SYG:SYD:(A;;SWRC;;;WD)",
                false
            )
        );
        let state = run_probe(
            &setup,
            &install_script(&account(), COMMENT, NONCE, FAKE_MARKER),
        );
        assert_ok(&state);
        assert_eq!(
            printer_names(&state),
            ["Spectra PDF", "Spectra PDF (Jos\u{e9} O'Neil)"]
        );
    }

    #[test]
    fn uninstall_removes_only_this_accounts_queue_and_its_jobs() {
        let setup = format!(
            "$script:markers = @{{ HoldPortCreated = $true }}\n$script:ports = @({LEGACY_PORT}, {})\n$script:printers = @({}, {}, {})\n$script:jobs = @([pscustomobject]@{{ PrinterName='Spectra PDF (me)'; Id=3 }}, [pscustomobject]@{{ PrinterName='Spectra PDF'; Id=5 }})",
            local_port(HOLD_PORT),
            legacy_printer("Spectra PDF old"),
            printer("Spectra PDF (me)", DRIVER_NAME, HOLD_PORT, &private_sddl(OWN), true),
            printer("Spectra PDF", DRIVER_NAME, HOLD_PORT, &private_sddl(OTHER), true)
        );
        let state = run_probe(&setup, &uninstall_script(&account(), NONCE, FAKE_MARKER));
        assert_ok(&state);
        assert_eq!(printer_names(&state), ["Spectra PDF"]);
        assert_eq!(
            texts(&state, "ports"),
            [HOLD_PORT],
            "the port another queue uses was removed"
        );
        assert_eq!(
            texts(&state, "markers"),
            ["HoldPortCreated", "Replaced"],
            "retiring the loopback queue went unrecorded"
        );
        let jobs = state["jobs"].as_array().unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0]["PrinterName"], "Spectra PDF");
    }

    #[test]
    fn uninstall_removes_the_port_it_made_once_no_queue_uses_it() {
        let setup = format!(
            "$script:markers = @{{ HoldPortCreated = $true }}\n$script:ports = @({})\n$script:printers = @({})",
            local_port(HOLD_PORT),
            printer("Spectra PDF", DRIVER_NAME, HOLD_PORT, &private_sddl(OWN), true)
        );
        let state = run_probe(&setup, &uninstall_script(&account(), NONCE, FAKE_MARKER));
        assert_ok(&state);
        assert!(printer_names(&state).is_empty());
        assert!(texts(&state, "ports").is_empty());
        assert!(texts(&state, "markers").is_empty());
    }

    #[test]
    fn retiring_the_loopback_queue_records_the_replacement_only_when_one_was_removed() {
        let setup = format!(
            "$script:ports = @({LEGACY_PORT})\n$script:printers = @({})",
            legacy_printer("Spectra PDF")
        );
        let state = run_probe(&setup, &retire_legacy_script(FAKE_MARKER));
        assert_ok(&state);
        assert_eq!(
            texts(&state, "events"),
            ["remove-printer", "remove-port", "set-Replaced"]
        );
        assert_eq!(texts(&state, "markers"), ["Replaced"]);

        let state = run_probe("", &retire_legacy_script(FAKE_MARKER));
        assert_ok(&state);
        assert!(texts(&state, "events").is_empty());
        assert!(texts(&state, "markers").is_empty());
    }

    #[test]
    fn retiring_keeps_a_loopback_port_another_printer_still_uses() {
        let setup = format!(
            "$script:ports = @({LEGACY_PORT})\n$script:printers = @({}, {})",
            legacy_printer("Spectra PDF"),
            printer(
                "Other",
                "Other driver",
                LEGACY_PORT_NAME,
                "O:SYG:SYD:(A;;SWRC;;;WD)",
                false
            )
        );
        let state = run_probe(&setup, &retire_legacy_script(FAKE_MARKER));
        assert_ok(&state);
        assert_eq!(texts(&state, "events"), ["remove-printer", "set-Replaced"]);
        assert_eq!(texts(&state, "ports"), [LEGACY_PORT_NAME]);
    }

    #[test]
    fn the_uninstaller_removes_every_held_queue_and_nothing_else() {
        let setup = format!(
            "$script:markers = @{{ HoldPortCreated = $true; Replaced = $true }}\n$script:ports = @({LEGACY_PORT}, {}, {})\n$script:printers = @({}, {}, {}, {}, {})\n$script:jobs = @([pscustomobject]@{{ PrinterName='Spectra PDF'; Id=1 }})",
            local_port(HOLD_PORT),
            local_port("PORTPROMPT:"),
            legacy_printer("Spectra PDF old"),
            printer("Spectra PDF", DRIVER_NAME, HOLD_PORT, &private_sddl(OWN), true),
            printer("Spectra PDF (other)", DRIVER_NAME, HOLD_PORT, &private_sddl(OTHER), true),
            printer("Unheld on NUL", DRIVER_NAME, HOLD_PORT, "O:SYG:SYD:(A;;SWRC;;;WD)", false),
            printer("Office", "Vendor", "PORTPROMPT:", "O:SYG:SYD:(A;;SWRC;;;WD)", false)
        );
        let state = run_probe(&setup, &remove_all_script(FAKE_MARKER));
        assert_ok(&state);
        assert_eq!(printer_names(&state), ["Unheld on NUL", "Office"]);
        assert_eq!(
            texts(&state, "ports"),
            [HOLD_PORT, "PORTPROMPT:"],
            "a port still in use was removed"
        );
        assert!(texts(&state, "markers").is_empty());
        assert!(state["jobs"].as_array().unwrap().is_empty());
    }
}
