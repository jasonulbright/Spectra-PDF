//! The scanner HOST: every WIA call runs in a separate process.
//!
//! A WIA apartment cannot be torn down with a bound. `CoUninitialize` on an
//! apartment that reached a scanner driver runs COM's DLL-unload pass, which
//! calls `FreeLibrary` on `sti.dll` under the process-wide loader lock; when
//! that unload blocks on a lock an in-process driver thread still holds, the
//! loader lock is held with it, and every other thread that tries to exit
//! stops inside `LdrShutdownThread` and never returns. At that point the
//! process cannot exit, cannot join its threads, and cannot be recovered from
//! inside itself: the stalled thread is unpreemptable, abandoning it does not
//! release the loader lock, and omitting `CoUninitialize` leaks an apartment
//! on every scan instead.
//!
//! The only bound that holds over a loader-lock stall is the one enforced from
//! outside the process. So the WIA code runs in a child process, every request
//! carries a deadline, and a breach terminates the child — `TerminateProcess`
//! needs no loader lock, so it succeeds on exactly the state nothing else can
//! unwedge. The next request spawns a new child.
//!
//! What this buys, per consequence:
//!
//! * The parent never loads `sti.dll` and never initialises a WIA apartment,
//!   so no scanner driver can reach its loader or its thread-exit path.
//! * A stalled driver costs one refusal and one child process, not the app.
//! * Hardware behaviour is unchanged: the child runs the same WIA code, on
//!   the same real device, and reports the same devices, capabilities, pages
//!   and refusals.
//!
//! A request is bounded in two phases because the stall lands between them.
//! The child reports `body` the moment the WIA work returns, before the
//! apartment is torn down; the driver call gets [`CALL_DEADLINE`] and the
//! teardown that follows gets [`TEARDOWN_DEADLINE`]. An acquisition's driver
//! phase is bounded by the device's own callback liveness rather than by a
//! wall clock: each progress event refreshes its deadline, because a long
//! feeder run is not a stall and a run producing nothing is.
//!
//! The device picker is the one request with no driver-phase deadline: it is
//! open until a person closes it. Its teardown is bounded like every other.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::scanner::{
    ScanEvent, ScanRefusal, ScanResult, ScanSession, ScanSettings, ScannerCapabilities,
    ScannerDevice, ScannerSessions,
};

/// The argv marker that turns this executable into a scanner host.
///
/// Not a clap subcommand: it is consumed before the parser runs, so a host
/// child never reaches the GUI or CLI dispatch.
pub const HOST_ARG: &str = "--scan-host";

/// The environment variable that turns a `cargo test` binary into a scanner
/// host. A test binary's entry point belongs to the test harness, so the host
/// child is reached through a test that checks this variable instead of
/// through argv.
pub const HOST_ENV: &str = "SPECTRAPDF_SCAN_HOST";

/// How long one driver call may run before its child is terminated.
pub const CALL_DEADLINE: Duration = Duration::from_secs(120);

/// How long an apartment teardown may run after its driver call returned.
///
/// Short on purpose: nothing legitimate happens here. A teardown still
/// running is the stall this module exists for.
pub const TEARDOWN_DEADLINE: Duration = Duration::from_secs(20);

/// How long an acquisition may go with no progress event before its child is
/// terminated. The device's own watchdog is shorter, so reaching this means
/// the driver stopped reporting rather than the paper stopped moving.
pub const ACQUIRE_SILENCE: Duration = Duration::from_secs(300);

/// How long a freshly spawned child has to announce itself.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(30);

/// How long a request that was never answered may keep being sent to a fresh
/// child. One child serves the whole process, so another caller's stall can
/// take a request down with it; this is the window in which such a request
/// is sent again rather than refused.
pub const RESEND_BUDGET: Duration = Duration::from_secs(30);

/// True inside a host child. The WIA code paths branch on it: in the child
/// they call the driver, in the parent they call this module.
static IN_HOST_CHILD: AtomicBool = AtomicBool::new(false);

/// True inside a host child.
pub fn is_host_child() -> bool {
    IN_HOST_CHILD.load(Ordering::SeqCst)
}

/// Does this argv ask for a host child?
pub fn host_arg_present<S: AsRef<str>>(args: &[S]) -> bool {
    args.iter().any(|a| a.as_ref() == HOST_ARG)
}

/// Is this test binary being run as a host child?
pub fn host_env_present() -> bool {
    std::env::var(HOST_ENV).is_ok_and(|v| v == "1")
}

// ── Wire protocol ───────────────────────────────────────────────────────────

/// One request's reply stream: any number of events and phase notices, then
/// exactly one outcome.
enum Reply {
    /// The driver call returned; the apartment teardown has not finished.
    BodyDone,
    Event(ScanEvent),
    Outcome(Result<Value, ScanRefusal>),
}

/// A refusal for the rows this module raises itself, distinct from the ones a
/// driver raises: the key is the generic scan failure so no catalog entry is
/// invented, and the sentence says which boundary gave up.
fn host_refusal(message: &str) -> ScanRefusal {
    ScanRefusal::named("scan.failed", message)
}

/// Read one line of the child's stream as a protocol message, or nothing.
///
/// The child's stream is not exclusively the protocol's: a host reached
/// through a test harness shares it with the harness's own lines. A line that
/// is not a protocol object is not an error, and a protocol object that a
/// foreign prefix shares a line with is still read — but only when the whole
/// remainder of the line parses, so a partial write is never read as a
/// message.
fn protocol_line(line: &str) -> Option<Value> {
    let line = line.trim();
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        return value.is_object().then_some(value);
    }
    let start = line.find('{')?;
    let value = serde_json::from_str::<Value>(&line[start..]).ok()?;
    value.is_object().then_some(value)
}

/// Rebuild a refusal that crossed the pipe.
fn refusal_from_wire(value: &Value) -> ScanRefusal {
    let key = value.get("key").and_then(Value::as_str).unwrap_or("");
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("The scanner service call failed unexpectedly.");
    ScanRefusal {
        key: crate::scanner::intern_refusal_key(key),
        message: message.to_string(),
        code: value
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string),
        folder: value
            .get("folder")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

// ── The parent side ─────────────────────────────────────────────────────────

/// One live child, and the bookkeeping that lets a caller wait on its own
/// request without blocking anyone else's.
struct Host {
    /// Held only for termination. Never waited on while a request waits.
    child: Mutex<Child>,
    /// Serialises request lines. Held for one write, never across a wait.
    stdin: Mutex<ChildStdin>,
    /// Shared with the reader thread, which answers everything still pending
    /// when the child's stream ends.
    pending: Arc<Mutex<HashMap<u64, Sender<Reply>>>>,
    next_id: AtomicU64,
    /// Identifies this child among the ones this process has spawned, so a
    /// deadline breach terminates the child it timed out on and not its
    /// replacement.
    generation: u64,
    /// The job object holding the child, so a parent that dies without
    /// unwinding does not leave a scanner process behind.
    job: usize,
}

impl Host {
    /// Wake every caller still waiting, by dropping the channel it waits on.
    ///
    /// Dropping rather than sending a refusal is what tells a caller the
    /// difference between "the child answered with a refusal" and "the child
    /// never answered": only the second may be sent again.
    fn wake_all_pending(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }

    fn terminate(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        close_job(self.job);
    }
}

fn hosts() -> &'static Mutex<Option<Arc<Host>>> {
    static HOST: OnceLock<Mutex<Option<Arc<Host>>>> = OnceLock::new();
    HOST.get_or_init(|| Mutex::new(None))
}

fn generations() -> &'static AtomicU64 {
    static GENERATIONS: AtomicU64 = AtomicU64::new(0);
    &GENERATIONS
}

/// The live child, spawning one if none is live.
///
/// The slot lock is held across the spawn and the handshake, both bounded, and
/// is released before any request waits on a reply.
fn current_host() -> Result<Arc<Host>, ScanRefusal> {
    let mut slot = hosts()
        .lock()
        .map_err(|_| host_refusal("The scanner service is unusable."))?;
    if let Some(host) = slot.as_ref() {
        return Ok(host.clone());
    }
    let host = Arc::new(spawn_host()?);
    *slot = Some(host.clone());
    Ok(host)
}

/// Terminate `generation` and forget it, so the next request spawns a fresh
/// child. A generation that is no longer the live one has already been
/// replaced and is left alone.
fn retire(generation: u64) {
    let retired = {
        let Ok(mut slot) = hosts().lock() else {
            return;
        };
        match slot.as_ref() {
            Some(host) if host.generation == generation => slot.take(),
            _ => None,
        }
    };
    if let Some(host) = retired {
        host.wake_all_pending();
        host.terminate();
    }
}

/// Terminate the live child, if any. Called when the app is shutting down:
/// the child holds device locks, and an abandoned one keeps them.
pub fn shutdown() {
    let retired = hosts().lock().ok().and_then(|mut slot| slot.take());
    if let Some(host) = retired {
        host.wake_all_pending();
        host.terminate();
    }
}

/// Which executable serves as the host, and with which arguments.
///
/// In the app this executable re-invokes itself. Under `cargo test` the
/// current executable is a test binary whose entry point is the harness, so
/// the host is reached by running the one test that serves it; the harness
/// writes its own lines to the same stream, which the reader ignores because
/// they are not protocol lines.
fn host_command() -> Result<Command, ScanRefusal> {
    let exe = std::env::current_exe()
        .map_err(|_| host_refusal("The scanner service executable could not be located."))?;
    let mut command = Command::new(exe);
    if cfg!(test) {
        command
            .arg("--exact")
            .arg("scan_host::tests::serves_as_the_scanner_host_child")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env(HOST_ENV, "1");
    } else {
        command.arg(HOST_ARG);
    }
    Ok(command)
}

fn spawn_host() -> Result<Host, ScanRefusal> {
    let mut child = host_command()?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| host_refusal("The scanner service could not be started."))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| host_refusal("The scanner service could not be started."))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| host_refusal("The scanner service could not be started."))?;
    let job = confine(child.id());
    let generation = generations().fetch_add(1, Ordering::SeqCst) + 1;
    let pending: Arc<Mutex<HashMap<u64, Sender<Reply>>>> = Arc::new(Mutex::new(HashMap::new()));

    let (announced, ready) = mpsc::channel::<()>();
    let routed = pending.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Some(message) = protocol_line(&line) else {
                // Anything that is not a protocol line is the host's own
                // stream noise and carries no reply.
                continue;
            };
            if message.get("ready").is_some() {
                let _ = announced.send(());
                continue;
            }
            let Some(id) = message.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let reply = if let Some(event) = message.get("event") {
                match serde_json::from_value::<ScanEvent>(event.clone()) {
                    Ok(event) => Reply::Event(event),
                    Err(_) => continue,
                }
            } else if message.get("phase").and_then(Value::as_str) == Some("body") {
                Reply::BodyDone
            } else if let Some(error) = message.get("err") {
                Reply::Outcome(Err(refusal_from_wire(error)))
            } else if let Some(ok) = message.get("ok") {
                Reply::Outcome(Ok(ok.clone()))
            } else {
                continue;
            };
            let terminal = matches!(reply, Reply::Outcome(_));
            let target = {
                let Ok(mut open) = routed.lock() else { break };
                if terminal {
                    open.remove(&id)
                } else {
                    open.get(&id).cloned()
                }
            };
            if let Some(target) = target {
                let _ = target.send(reply);
            }
        }
        // The stream ended: the child exited or was terminated. Every caller
        // still waiting is woken now rather than at its own deadline, by
        // dropping its channel — which is also how it learns that its request
        // was never answered rather than refused.
        if let Ok(mut open) = routed.lock() {
            open.clear();
        }
    });

    let host = Host {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
        pending,
        next_id: AtomicU64::new(1),
        generation,
        job,
    };
    match ready.recv_timeout(HANDSHAKE_DEADLINE) {
        Ok(()) => Ok(host),
        Err(_) => {
            host.terminate();
            Err(host_refusal("The scanner service did not start."))
        }
    }
}

/// Windows-only: hold the child in a job object that kills it when the last
/// handle closes, so a parent that dies without unwinding does not leave a
/// scanner process holding a device.
#[cfg(windows)]
fn confine(pid: u32) -> usize {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    unsafe {
        let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else {
            return 0;
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .is_err()
        {
            let _ = CloseHandle(job);
            return 0;
        }
        let Ok(process) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) else {
            let _ = CloseHandle(job);
            return 0;
        };
        let assigned = AssignProcessToJobObject(job, process);
        let _ = CloseHandle(process);
        if assigned.is_err() {
            let _ = CloseHandle(job);
            return 0;
        }
        job.0 as usize
    }
}

#[cfg(not(windows))]
fn confine(_pid: u32) -> usize {
    0
}

#[cfg(windows)]
fn close_job(job: usize) {
    if job == 0 {
        return;
    }
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    unsafe {
        let _ = CloseHandle(HANDLE(job as *mut std::ffi::c_void));
    }
}

#[cfg(not(windows))]
fn close_job(_job: usize) {}

/// What a request is waiting for, and for how long.
#[derive(Debug, Clone, Copy)]
struct Bound {
    /// The driver phase's bound. `None` is a request a person closes.
    body: Option<Duration>,
    /// Refresh the driver phase's deadline on every progress event.
    refresh_on_event: bool,
    /// The bound on the apartment teardown that follows the driver call.
    /// Every request kind carries the same one: the teardown is the same work
    /// whatever the call was.
    teardown: Duration,
}

impl Bound {
    fn call() -> Self {
        Bound {
            body: Some(CALL_DEADLINE),
            refresh_on_event: false,
            teardown: TEARDOWN_DEADLINE,
        }
    }

    fn acquisition() -> Self {
        Bound {
            body: Some(ACQUIRE_SILENCE),
            refresh_on_event: true,
            teardown: TEARDOWN_DEADLINE,
        }
    }

    fn user_driven() -> Self {
        Bound {
            body: None,
            refresh_on_event: false,
            teardown: TEARDOWN_DEADLINE,
        }
    }
}

/// Send one request and wait for its outcome under `bound`, forwarding events
/// to `sink`.
///
/// A deadline breach retires the child. The refusal that comes back is a
/// result like any other: the caller's next request starts a new child, so a
/// stalled driver costs one operation rather than the scanner.
///
/// A request the child never received — its predecessor was retired, or the
/// child had already exited — is sent once more to a fresh child under
/// [`Resend::WhenUnanswered`]. That is not a retry over a failure: nothing ran,
/// so nothing is repeated. A request that DID reach the device is never sent
/// again, whatever became of it; a sheet that moved has moved.
fn request(
    op: Value,
    bound: Bound,
    resend: Resend,
    sink: Option<&dyn Fn(ScanEvent)>,
) -> Result<Value, ScanRefusal> {
    // Resending is bounded by a clock rather than by a count because the
    // child is shared: any caller's stall retires it, and a caller whose own
    // request never ran must not be refused for someone else's stall. Each
    // attempt costs a spawn and a handshake, so this cannot spin.
    let deadline = Instant::now() + RESEND_BUDGET;
    let mut last;
    loop {
        let final_attempt = resend == Resend::Never || Instant::now() >= deadline;
        let host = current_host()?;
        let id = host.next_id.fetch_add(1, Ordering::SeqCst);
        let (replies, inbox) = mpsc::channel::<Reply>();
        {
            let mut pending = host
                .pending
                .lock()
                .map_err(|_| host_refusal("The scanner service is unusable."))?;
            pending.insert(id, replies);
        }

        let mut line = op.clone();
        line["id"] = json!(id);
        let written = {
            let Ok(mut stdin) = host.stdin.lock() else {
                return Err(host_refusal("The scanner service is unusable."));
            };
            writeln!(stdin, "{line}").and_then(|()| stdin.flush())
        };
        if written.is_err() {
            if let Ok(mut pending) = host.pending.lock() {
                pending.remove(&id);
            }
            retire(host.generation);
            last = host_refusal("The scanner service is no longer running.");
            if final_attempt {
                break;
            }
            continue;
        }

        match collect(&inbox, bound, sink) {
            Ok(value) => return Ok(value),
            Err(Refused(refusal)) => return Err(refusal),
            Err(Stalled) => {
                retire(host.generation);
                return Err(host_refusal(
                    "The scanner stopped responding; the scanner service was restarted.",
                ));
            }
            Err(Unanswered) => {
                retire(host.generation);
                last = host_refusal("The scanner service stopped before it answered.");
                if final_attempt {
                    break;
                }
            }
        }
    }
    Err(last)
}

/// May a request that was never answered be sent again?
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resend {
    /// Reads and releases: nothing in the device moved, so sending the request
    /// to a fresh child repeats nothing.
    WhenUnanswered,
    /// Acquisitions and the device picker: paper may have moved and a dialog
    /// may have been shown, so the outcome is reported rather than re-run.
    Never,
}

/// Why a request produced no value. The three are never conflated: a jam is
/// the driver's answer, a stall is a bound this module enforced, and an
/// unanswered request is one whose child died without running it to an
/// outcome — only the last may be sent again.
#[derive(Debug)]
enum Failure {
    Stalled,
    Unanswered,
    Refused(ScanRefusal),
}
use Failure::{Refused, Stalled, Unanswered};

fn collect(
    inbox: &Receiver<Reply>,
    bound: Bound,
    sink: Option<&dyn Fn(ScanEvent)>,
) -> Result<Value, Failure> {
    let mut phase = bound.body;
    let mut started = Instant::now();
    loop {
        let waited = match phase {
            Some(limit) => limit.checked_sub(started.elapsed()).unwrap_or_default(),
            // A request with no driver-phase bound is still woken by the
            // reader thread when the child dies, so this is not a wait that
            // only a reply can end.
            None => Duration::from_secs(3600),
        };
        match inbox.recv_timeout(waited) {
            Ok(Reply::Event(event)) => {
                if let Some(sink) = sink {
                    sink(event);
                }
                if bound.refresh_on_event {
                    started = Instant::now();
                }
            }
            Ok(Reply::BodyDone) => {
                // The driver returned. What remains is the apartment
                // teardown, which is the stall this bound exists for.
                phase = Some(bound.teardown);
                started = Instant::now();
            }
            Ok(Reply::Outcome(Ok(value))) => return Ok(value),
            Ok(Reply::Outcome(Err(refusal))) => return Err(Refused(refusal)),
            Err(RecvTimeoutError::Timeout) => {
                if phase.is_some() {
                    return Err(Stalled);
                }
            }
            // The reader thread drops every pending channel when the child's
            // stream ends, so a closed channel means this request never
            // reached an outcome.
            Err(RecvTimeoutError::Disconnected) => return Err(Unanswered),
        }
    }
}

// ── The parent-side backend ─────────────────────────────────────────────────

/// Every WIA device the host child can see, by native id.
pub fn enumerate() -> Result<Vec<ScannerDevice>, ScanRefusal> {
    let value = request(
        json!({ "op": "enumerate" }),
        Bound::call(),
        Resend::WhenUnanswered,
        None,
    )?;
    serde_json::from_value(value)
        .map_err(|_| host_refusal("The scanner service reported an unreadable device list."))
}

/// The system device picker, raised by the host child.
pub fn select_device_dialog(parent: usize) -> Result<Option<String>, ScanRefusal> {
    let value = request(
        json!({ "op": "selectDialog", "parent": parent }),
        Bound::user_driven(),
        Resend::Never,
        None,
    )?;
    Ok(value.as_str().map(str::to_string))
}

/// Open one device in the host child.
pub fn open(native_id: &str) -> Result<Arc<dyn ScanSession>, ScanRefusal> {
    request(
        json!({ "op": "open", "device": native_id }),
        Bound::call(),
        Resend::WhenUnanswered,
        None,
    )?;
    Ok(Arc::new(HostSession {
        device: native_id.to_string(),
    }))
}

/// One device held open in the host child.
///
/// It holds no handle of its own: the child owns the device, keyed by id, so a
/// terminated child takes its sessions with it and the next request opens the
/// device again.
struct HostSession {
    device: String,
}

impl ScanSession for HostSession {
    fn capabilities(&self) -> Result<ScannerCapabilities, ScanRefusal> {
        let value = request(
            json!({ "op": "capabilities", "device": self.device }),
            Bound::call(),
            Resend::WhenUnanswered,
            None,
        )?;
        serde_json::from_value(value).map_err(|_| {
            host_refusal("The scanner service reported an unreadable capability report.")
        })
    }

    fn acquire(
        &self,
        settings: ScanSettings,
        dir: PathBuf,
        sink: crate::scanner::EventSink,
    ) -> Result<ScanResult, ScanRefusal> {
        let settings = serde_json::to_value(&settings)
            .map_err(|_| host_refusal("The scan settings could not be sent to the scanner."))?;
        let value = request(
            json!({
                "op": "acquire",
                "device": self.device,
                "settings": settings,
                "dir": dir.to_string_lossy(),
            }),
            Bound::acquisition(),
            Resend::Never,
            Some(&|event| sink(event)),
        )?;
        serde_json::from_value(value)
            .map_err(|_| host_refusal("The scanner service reported an unreadable scan result."))
    }

    fn cancel(&self) {
        // Cancel is a flag on the child's side too: it answers immediately and
        // the run it interrupts ends on its own reply.
        notify(json!({ "op": "cancel", "device": self.device }));
    }
}

impl Drop for HostSession {
    fn drop(&mut self) {
        // Releases the device lock in the child, which acknowledges before the
        // release finishes: a caller dropping a session must not block on a
        // driver, and a release that never finishes is retired by the next
        // request's deadline.
        notify(json!({ "op": "close", "device": self.device }));
    }
}

/// Tell the live child something about a device it holds, if one is live.
///
/// Cancelling or releasing a device in a child that no longer exists is
/// already done: the session went with the process. So this never spawns a
/// child and never resends — a spawn here would start a scanner process purely
/// to tell it to forget a device it never had.
fn notify(op: Value) {
    let live = hosts()
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().cloned());
    if live.is_none() {
        return;
    }
    let _ = request(op, Bound::call(), Resend::Never, None);
}

// ── The child side ──────────────────────────────────────────────────────────

/// Serve requests until the request stream ends, then exit.
///
/// Every request that can block the driver is answered on its own thread, so
/// one stalled device never stops `cancel` or another device's work from being
/// read. Replies are serialised on the writer.
pub fn serve() -> i32 {
    IN_HOST_CHILD.store(true, Ordering::SeqCst);
    let out: Arc<Mutex<Box<dyn Write + Send>>> =
        Arc::new(Mutex::new(Box::new(std::io::stdout())));
    // A leading newline, because a host reached through a test harness starts
    // writing part-way along a line the harness opened. Every protocol line
    // must start at a line boundary to be readable as one.
    if let Ok(mut out) = out.lock() {
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
    emit(&out, json!({ "ready": 1 }));
    let sessions = Arc::new(ScannerSessions::new());

    let stdin = std::io::stdin();
    let mut workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    for line in BufReader::new(stdin.lock()).lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let out = out.clone();
        let sessions = sessions.clone();
        workers.push(std::thread::spawn(move || {
            handle(id, &message, sessions, &out);
        }));
    }
    // The parent is gone. Sessions are dropped here so devices are released
    // in the ordinary way when nothing stalled; a stall costs a terminated
    // process, which releases them too.
    drop(sessions);
    let _ = workers;
    0
}

fn emit(out: &Mutex<Box<dyn Write + Send>>, value: Value) {
    if let Ok(mut out) = out.lock() {
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    }
}

fn handle(
    id: u64,
    message: &Value,
    sessions: Arc<ScannerSessions>,
    out: &Arc<Mutex<Box<dyn Write + Send>>>,
) {
    let op = message.get("op").and_then(Value::as_str).unwrap_or("");
    let device = message
        .get("device")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let announce = {
        let out = out.clone();
        move || emit(&out, json!({ "id": id, "phase": "body" }))
    };
    // The defect's own interleaving, on request: the driver call returns, the
    // teardown announcement goes out, and the thread never comes back. It
    // exists only in a test build — the shipped host has no such request —
    // and it is the only way to drive a loader-lock stall without a driver
    // that chooses to have one.
    #[cfg(test)]
    if message.get("stall").and_then(Value::as_bool) == Some(true) {
        announce();
        loop {
            std::thread::park();
        }
    }
    let outcome: Result<Value, ScanRefusal> = match op {
        "enumerate" => crate::scanner::wia_enumerate_announced(announce)
            .and_then(|devices| encode(&devices)),
        "selectDialog" => {
            let parent = message.get("parent").and_then(Value::as_u64).unwrap_or(0) as usize;
            crate::scanner::wia_select_device_dialog_announced(parent, announce)
                .and_then(|chosen| encode(&chosen))
        }
        "open" => sessions.open(&device).map(|()| Value::Null),
        "capabilities" => sessions.capabilities(&device).and_then(|caps| encode(&caps)),
        "acquire" => {
            let settings = message
                .get("settings")
                .cloned()
                .unwrap_or(Value::Null);
            let dir = message.get("dir").and_then(Value::as_str).unwrap_or("");
            match serde_json::from_value::<ScanSettings>(settings) {
                Err(_) => Err(host_refusal("The scan settings could not be read.")),
                Ok(settings) => {
                    let streamed = out.clone();
                    let sink: crate::scanner::EventSink = Box::new(move |event| {
                        match serde_json::to_value(&event) {
                            Ok(event) => emit(&streamed, json!({ "id": id, "event": event })),
                            Err(_) => {}
                        }
                    });
                    sessions
                        .acquire(&device, settings, PathBuf::from(dir), sink)
                        .and_then(|result| encode(&result))
                }
            }
        }
        "cancel" => {
            sessions.cancel(&device);
            Ok(Value::Null)
        }
        "close" => {
            // Releasing a device drops its session, which joins its apartment
            // thread — the one wait that can stall. The acknowledgement is not
            // made to wait for it: a caller dropping a session must not block,
            // and a release that never finishes wedges this process, which the
            // next request's deadline retires.
            let released = sessions.clone();
            let device = device.clone();
            std::thread::spawn(move || released.close(&device));
            Ok(Value::Null)
        }
        _ => Err(host_refusal("The scanner service received an unknown request.")),
    };
    let line = match outcome {
        Ok(value) => json!({ "id": id, "ok": value }),
        Err(refusal) => json!({
            "id": id,
            "err": {
                "key": refusal.key,
                "message": refusal.message,
                "code": refusal.code,
                "folder": refusal.folder,
            }
        }),
    };
    emit(out, line);
}

fn encode<T: serde::Serialize>(value: &T) -> Result<Value, ScanRefusal> {
    serde_json::to_value(value)
        .map_err(|_| host_refusal("The scanner service could not report its result."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises the tests that deliberately end a child's life. One child
    /// serves the whole process, so two of them at once would be testing each
    /// other's interference rather than the boundary.
    fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let lock = LOCK.get_or_init(|| Mutex::new(()));
        lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The host child's entry point under `cargo test`: the parent runs this
    /// one test with [`HOST_ENV`] set, and it serves the protocol instead of
    /// asserting anything. Without the variable it is a no-op, so the ordinary
    /// suite neither serves nor hangs.
    #[test]
    fn serves_as_the_scanner_host_child() {
        if host_env_present() {
            serve();
        }
    }

    /// The boundary, live: a real child process, a real handshake, a real
    /// reply. Nothing here asserts which devices exist — a machine with no
    /// scanner enumerates empty — only that the answer came back across the
    /// process boundary, which is what the in-process path could not bound.
    #[test]
    fn enumeration_is_answered_across_a_real_child_process() {
        let devices = enumerate().expect("enumeration crosses the host and answers");
        for device in &devices {
            assert!(!device.id.is_empty(), "an enumerated device carries an id");
        }
        // The caller's process stayed out of the apartment: with the flag set
        // the call would have reached the driver here instead.
        assert!(!is_host_child());
    }

    /// The defect, driven: a request whose driver call returned and whose
    /// apartment teardown never finishes. Nothing about it can be recovered
    /// inside the child, so all three consequences are asserted — the caller
    /// is refused, the wedged child is gone, and the scanner still works.
    #[test]
    fn a_teardown_that_never_finishes_is_refused_and_the_child_is_replaced() {
        let _serialised = one_at_a_time();
        enumerate().expect("a child is live");
        let wedged_generation = hosts()
            .lock()
            .expect("the slot is usable")
            .as_ref()
            .expect("a child is live")
            .generation;
        let wedged = request(
            json!({ "op": "enumerate", "stall": true }),
            Bound {
                body: Some(CALL_DEADLINE),
                refresh_on_event: false,
                teardown: Duration::from_millis(250),
            },
            Resend::Never,
            None,
        );
        let refusal = wedged.expect_err("a teardown that never finishes cannot succeed");
        assert_eq!(refusal.key, "scan.failed");
        assert!(
            refusal.message.contains("stopped responding"),
            "{}",
            refusal.message
        );
        // The wedged child was retired, not merely left in the slot: nothing
        // can be asked of it again.
        let still_there = hosts()
            .lock()
            .expect("the slot is usable")
            .as_ref()
            .map(|host| host.generation);
        assert_ne!(
            still_there,
            Some(wedged_generation),
            "a stalled child is terminated and forgotten"
        );
        // And the scanner still works: the stall cost one request.
        enumerate().expect("a replacement child answers");
    }

    /// The recovery the fix exists for: a child that dies takes its generation
    /// with it, and the next request is served by a new one. A stalled
    /// teardown is exactly this case, reached through a deadline instead of
    /// through a kill.
    #[test]
    fn a_dead_child_is_replaced_and_the_next_request_is_answered() {
        let _serialised = one_at_a_time();
        enumerate().expect("the first child answers");
        let first = {
            let slot = hosts().lock().expect("the slot is usable");
            let host = slot.as_ref().expect("a child is live");
            host.terminate();
            host.generation
        };
        // The dead child is still the one in the slot: the next request must
        // notice for itself rather than wait out its deadline.
        let devices = enumerate().expect("a replacement child answers");
        let second = {
            let slot = hosts().lock().expect("the slot is usable");
            slot.as_ref().expect("a child is live").generation
        };
        assert_ne!(first, second, "the replacement is a new child");
        for device in &devices {
            assert!(!device.id.is_empty());
        }
    }

    #[test]
    fn a_host_child_is_recognised_from_argv_and_from_the_environment() {
        assert!(host_arg_present(&[HOST_ARG.to_string()]));
        assert!(host_arg_present(&["spectrapdf".to_string(), HOST_ARG.to_string()]));
        assert!(!host_arg_present(&["spectrapdf".to_string(), "scan".to_string()]));
        // The marker is exact: a document whose name contains it is not one.
        assert!(!host_arg_present(&["--scan-hosted".to_string()]));
    }

    #[test]
    fn the_ordinary_process_is_not_a_host_child() {
        // The parent must never set the flag: with it set, the WIA paths would
        // call the driver in this process, which is what process isolation
        // exists to prevent.
        assert!(!is_host_child());
    }

    #[test]
    fn a_protocol_line_is_read_even_when_something_else_opened_the_line() {
        // A host reached through a test harness starts writing part-way along
        // a line the harness opened, so the first message shares its line.
        let shared = "test scan_host::tests::serves ... {\"ready\":1}";
        assert_eq!(protocol_line(shared), Some(json!({ "ready": 1 })));
        assert_eq!(
            protocol_line("{\"id\":4,\"ok\":null}"),
            Some(json!({ "id": 4, "ok": null }))
        );
    }

    #[test]
    fn stream_noise_is_not_a_message() {
        for line in [
            "",
            "running 1 test",
            "test result: ok. 1 passed",
            // A truncated object is noise, not a message: reading a partial
            // write as one would answer a request with half an outcome.
            "{\"id\":4,\"ok\":",
            // A bare value is not a message either.
            "12",
            "[1,2]",
        ] {
            assert_eq!(protocol_line(line), None, "{line}");
        }
    }

    #[test]
    fn a_refusal_survives_the_wire_with_its_key_and_its_code() {
        let wire = json!({
            "key": "scan.paperJam",
            "message": "The feeder jammed.",
            "code": "0x80210003",
            "folder": null,
        });
        let refusal = refusal_from_wire(&wire);
        assert_eq!(refusal.key, "scan.paperJam");
        assert_eq!(refusal.message, "The feeder jammed.");
        assert_eq!(refusal.code.as_deref(), Some("0x80210003"));
        assert_eq!(refusal.folder, None);
    }

    #[test]
    fn a_refusal_with_a_folder_keeps_the_folder_as_a_field() {
        let wire = json!({
            "key": "scan.scratchUnwritable",
            "message": "The staging folder could not be written.",
            "folder": "C:\\staging",
        });
        let refusal = refusal_from_wire(&wire);
        assert_eq!(refusal.folder.as_deref(), Some("C:\\staging"));
        assert_eq!(refusal.code, None);
    }

    #[test]
    fn an_unreadable_refusal_is_still_a_refusal() {
        let refusal = refusal_from_wire(&json!({}));
        assert_eq!(refusal.key, "scan.failed");
        assert!(!refusal.message.is_empty());
    }

    /// The bound's shape per request kind, asserted because each one is a
    /// different failure mode: a driver call that never returns, an
    /// acquisition that stops reporting, and a dialog a person has not closed.
    #[test]
    fn each_request_kind_carries_the_bound_its_failure_mode_needs() {
        assert_eq!(Bound::call().body, Some(CALL_DEADLINE));
        assert!(!Bound::call().refresh_on_event);
        assert_eq!(Bound::acquisition().body, Some(ACQUIRE_SILENCE));
        assert!(Bound::acquisition().refresh_on_event);
        assert_eq!(Bound::user_driven().body, None);
        // The teardown bound belongs to no request kind in particular.
        for bound in [Bound::call(), Bound::acquisition(), Bound::user_driven()] {
            assert_eq!(bound.teardown, TEARDOWN_DEADLINE);
        }
    }

    #[test]
    fn the_teardown_bound_is_shorter_than_the_driver_call_it_follows() {
        // Nothing legitimate happens in a teardown, so it may not inherit the
        // patience a driver call needs.
        assert!(TEARDOWN_DEADLINE < CALL_DEADLINE);
    }

    fn drive(replies: Vec<Reply>, bound: Bound) -> Result<Value, Failure> {
        let (sender, inbox) = mpsc::channel();
        for reply in replies {
            sender.send(reply).expect("the receiver is alive");
        }
        drop(sender);
        collect(&inbox, bound, None)
    }

    #[test]
    fn an_outcome_is_returned_whatever_preceded_it() {
        let value = drive(
            vec![
                Reply::Event(ScanEvent::Warming),
                Reply::Event(ScanEvent::PageStarted { index: 0 }),
                Reply::BodyDone,
                Reply::Outcome(Ok(json!({ "pages": [] }))),
            ],
            Bound::acquisition(),
        )
        .expect("the outcome arrived");
        assert_eq!(value, json!({ "pages": [] }));
    }

    #[test]
    fn a_driver_refusal_is_reported_as_itself_and_not_as_a_stall() {
        let outcome = drive(
            vec![Reply::Outcome(Err(ScanRefusal {
                key: "scan.paperJam",
                message: "jam".into(),
                code: None,
                folder: None,
            }))],
            Bound::call(),
        );
        match outcome {
            Err(Refused(refusal)) => assert_eq!(refusal.key, "scan.paperJam"),
            _ => panic!("a driver refusal is not a stall"),
        }
    }

    #[test]
    fn a_child_that_dies_without_answering_is_unanswered_and_not_a_wait() {
        // The reader thread drops the sender when the stream ends; a caller
        // must not sit out its deadline on a dead child.
        let started = Instant::now();
        let outcome = drive(vec![Reply::Event(ScanEvent::Warming)], Bound::call());
        assert!(matches!(outcome, Err(Unanswered)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_dialog_that_nobody_closed_is_still_ended_by_its_child_dying() {
        // The one request with no driver-phase bound must not become an
        // unbounded wait when the child is gone.
        let outcome = drive(vec![], Bound::user_driven());
        assert!(matches!(outcome, Err(Unanswered)));
    }

    #[test]
    fn a_stalled_teardown_breaches_after_the_body_returned() {
        // The defect's own shape: the driver call returned, so no driver-phase
        // bound can fire, and the apartment teardown never finishes. The
        // sender stays alive, so only the teardown bound can end this wait.
        let (sender, inbox) = mpsc::channel();
        sender.send(Reply::BodyDone).expect("receiver is alive");
        let bound = Bound {
            body: Some(Duration::from_secs(3600)),
            refresh_on_event: false,
            teardown: Duration::from_millis(150),
        };
        let started = Instant::now();
        let outcome = collect(&inbox, bound, None);
        drop(sender);
        assert!(matches!(outcome, Err(Stalled)));
        // It breached on the teardown bound, not on the driver-phase one.
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(started.elapsed() < Duration::from_secs(30));
    }

    #[test]
    fn a_teardown_that_finishes_in_time_reports_its_own_outcome() {
        let (sender, inbox) = mpsc::channel();
        sender.send(Reply::BodyDone).unwrap();
        sender.send(Reply::Outcome(Ok(json!(7)))).unwrap();
        drop(sender);
        let value = collect(&inbox, Bound::call(), None).expect("the outcome arrived");
        assert_eq!(value, json!(7));
    }

    #[test]
    fn events_reach_the_sink_in_order_and_the_outcome_still_returns() {
        let (sender, inbox) = mpsc::channel();
        sender.send(Reply::Event(ScanEvent::PageStarted { index: 0 })).unwrap();
        sender
            .send(Reply::Event(ScanEvent::PageFinished {
                index: 0,
                path: "a.bmp".into(),
            }))
            .unwrap();
        sender.send(Reply::Outcome(Ok(Value::Null))).unwrap();
        drop(sender);
        let seen = Mutex::new(Vec::new());
        let outcome = collect(&inbox, Bound::acquisition(), Some(&|event| {
            seen.lock().unwrap().push(format!("{event:?}"));
        }));
        assert!(outcome.is_ok());
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].contains("PageStarted"));
        assert!(seen[1].contains("PageFinished"));
    }
}
