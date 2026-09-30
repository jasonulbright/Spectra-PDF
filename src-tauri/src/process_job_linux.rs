//! A worker and its descendants cannot outlive the process owning its writes.
//!
//! Every bound child is forked by ONE thread, `spectra-spawner`, which is
//! started on first use and never exits. `PR_SET_PDEATHSIG` fires when the
//! forking THREAD exits, not the process: a child forked from a runtime worker
//! or a blocking-pool thread would be killed when that thread retires, and a
//! child forked from a thread that outlives nothing would never be bound. The
//! spawner's lifetime is the process's lifetime, so the signal fires exactly
//! when this process dies. A pidfd cannot replace this: it lets this process
//! kill the child race-free while it is alive, and does nothing once it is
//! gone.
//!
//! In the child, before exec:
//! - `setpgid(0, 0)` makes the child the leader of its own process group, so
//!   stopping it signals every descendant that has not left the group.
//! - `PR_SET_PDEATHSIG(SIGKILL)` binds its life to the spawner thread.
//! - `getppid()` is compared with this process's pid. A parent that died
//!   between `fork` and `prctl` has already reparented the child, and the
//!   death signal will never arrive; the child exits instead.
//!
//! The group is killed only while the leader is unreaped. A reaped leader's
//! pid can name a new, unrelated process group; an unreaped one cannot.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock, RwLock, Weak};

use tauri::async_runtime::{channel, Receiver, Sender};
use tauri_plugin_shell::process::{CommandEvent, TerminatedPayload};

/// The engine reads this variable to learn the descriptor number of its lease
/// channel.
///
/// Contract with the engine:
/// - The value is the decimal number of an inherited `AF_UNIX`
///   `SOCK_SEQPACKET` socket. The variable is absent when the process was
///   spawned without a channel.
/// - This process sends leases into the socket as `SCM_RIGHTS` messages. Each
///   message carries every lease the worker currently holds, as descriptors
///   of the lease record's open file description, which carries the lease's
///   `flock`. An unread message keeps those descriptions open: the kernel
///   holds in-flight descriptors for the receiving socket, and the worker
///   holds the receiving socket.
/// - The engine keeps the descriptor open for its whole life and never reads,
///   writes or closes it. Its own children do not inherit it.
/// - An engine that ignores the variable satisfies this contract: the
///   descriptor is held until the process exits.
///
/// If this process dies, its copies close and the unread message still holds
/// each lease until the worker exits. No lease is ever re-opened or re-locked
/// in transit, so no instant exists in which a live worker's lease is unheld.
pub const LEASE_FD_ENV: &str = "SPECTRAPDF_LEASE_FD";

/// The kernel's `SCM_MAX_FD`: the most descriptors one message can carry.
const MAX_FDS_PER_MESSAGE: usize = 253;

fn cvt(result: libc::c_int) -> io::Result<libc::c_int> {
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

// ── the spawner thread ─────────────────────────────────────────────────────

type SpawnReply = mpsc::Sender<io::Result<Child>>;

fn spawner() -> &'static Mutex<mpsc::Sender<(Command, SpawnReply)>> {
    static SPAWNER: OnceLock<Mutex<mpsc::Sender<(Command, SpawnReply)>>> = OnceLock::new();
    SPAWNER.get_or_init(|| {
        let (requests, inbox) = mpsc::channel::<(Command, SpawnReply)>();
        std::thread::Builder::new()
            .name("spectra-spawner".into())
            .spawn(move || {
                // The sender lives in a static, so `recv` never fails and the
                // thread never returns.
                while let Ok((mut command, reply)) = inbox.recv() {
                    let _ = reply.send(command.spawn());
                }
            })
            .expect("the spawner thread must start");
        Mutex::new(requests)
    })
}

fn spawn_on_spawner(command: Command) -> io::Result<Child> {
    let (reply, answer) = mpsc::channel();
    spawner()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .send((command, reply))
        .map_err(|_| io::Error::other("the spawner thread is gone"))?;
    answer
        .recv()
        .map_err(|_| io::Error::other("the spawner thread is gone"))?
}

/// What a bound spawn adds beyond lifetime binding.
#[derive(Clone, Copy, Default)]
pub struct Binding {
    /// Give the child a lease channel (see [`LEASE_FD_ENV`]).
    pub lease_channel: bool,
    /// `RLIMIT_DATA` in bytes: the ceiling on the child's private writable
    /// memory, which allocation fails beyond.
    pub memory_limit: Option<u64>,
}

/// Spawn `command` bound to this process's lifetime, in its own process
/// group.
pub fn spawn_bound(mut command: Command, binding: Binding) -> io::Result<(Child, ProcessJob)> {
    let channel = if binding.lease_channel {
        Some(socket_pair()?)
    } else {
        None
    };
    let inherited: Option<RawFd> = channel.as_ref().map(|(_, child_end)| child_end.as_raw_fd());
    if let Some(fd) = inherited {
        command.env(LEASE_FD_ENV, fd.to_string());
    }
    let parent = unsafe { libc::getpid() };
    let memory_limit = binding.memory_limit;
    command.process_group(0);
    unsafe {
        command.pre_exec(move || {
            cvt(libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0))?;
            if libc::getppid() != parent {
                libc::_exit(1);
            }
            if let Some(fd) = inherited {
                cvt(libc::fcntl(fd, libc::F_SETFD, 0))?;
            }
            if let Some(bytes) = memory_limit {
                let limit = libc::rlimit {
                    rlim_cur: bytes as libc::rlim_t,
                    rlim_max: bytes as libc::rlim_t,
                };
                cvt(libc::setrlimit(libc::RLIMIT_DATA, &limit))?;
            }
            Ok(())
        });
    }
    let child = spawn_on_spawner(command)?;
    let pid = child.id();
    let group = Arc::new(Group::new(pid));
    let carrier = channel.map(|(parent_end, child_end)| {
        let carrier = Arc::new(LeaseCarrier::new(parent_end, child_end));
        carriers()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(pid, Arc::downgrade(&carrier));
        carrier
    });
    Ok((child, ProcessJob { pid, group, carrier }))
}

// ── the process group ──────────────────────────────────────────────────────

struct Group {
    pgid: libc::pid_t,
    pidfd: Option<OwnedFd>,
    reaped: Mutex<bool>,
}

impl Group {
    fn new(pid: u32) -> Self {
        let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        let pidfd = (raw >= 0).then(|| unsafe { OwnedFd::from_raw_fd(raw as RawFd) });
        Self {
            pgid: pid as libc::pid_t,
            pidfd,
            reaped: Mutex::new(false),
        }
    }

    fn leader_unreaped(&self) -> bool {
        match &self.pidfd {
            Some(pidfd) => {
                let sent = unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_send_signal,
                        pidfd.as_raw_fd(),
                        0,
                        std::ptr::null::<libc::siginfo_t>(),
                        0,
                    )
                };
                sent == 0
            }
            None => unsafe { libc::kill(self.pgid, 0) == 0 },
        }
    }

    fn kill(&self) -> io::Result<()> {
        let reaped = self.reaped.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if *reaped || !self.leader_unreaped() {
            return Ok(());
        }
        match cvt(unsafe { libc::kill(-self.pgid, libc::SIGKILL) }) {
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(()),
            other => other.map(drop),
        }
    }

    /// Kill what remains of the group, then reap the leader. The group kill
    /// happens while the exited leader is still a zombie, so its pid cannot
    /// yet name another group.
    fn reap(&self, child: &mut Child) -> io::Result<std::process::ExitStatus> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let waited = unsafe {
                libc::waitid(
                    libc::P_PID,
                    child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if waited == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        let _ = self.kill();
        let mut reaped = self.reaped.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let status = child.wait();
        *reaped = true;
        status
    }
}

/// The lifetime binding of one spawned process. Dropping it kills the
/// process's group, as closing a kill-on-close job does.
pub struct ProcessJob {
    pid: u32,
    group: Arc<Group>,
    carrier: Option<Arc<LeaseCarrier>>,
}

impl ProcessJob {
    pub fn kill(&self) -> io::Result<()> {
        self.group.kill()
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        let _ = self.group.kill();
        if let Some(carrier) = self.carrier.take() {
            let mut map = carriers().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if map
                .get(&self.pid)
                .is_some_and(|entry| std::ptr::eq(entry.as_ptr(), Arc::as_ptr(&carrier)))
            {
                map.remove(&self.pid);
            }
        }
    }
}

// ── the worker child ───────────────────────────────────────────────────────

/// A bound worker with piped stdio, driven through the same events as a
/// shell-plugin child.
pub struct WorkerChild {
    pid: u32,
    stdin: ChildStdin,
    job: ProcessJob,
}

impl WorkerChild {
    pub fn write(&mut self, buf: &[u8]) -> io::Result<()> {
        self.stdin.write_all(buf)
    }

    /// Kill the worker and every descendant still in its group.
    pub fn kill(self) -> io::Result<()> {
        self.job.kill()
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

/// Spawn a bound worker whose stdout and stderr arrive as raw chunks on the
/// returned receiver, followed by `Terminated` once both pipes are drained.
pub fn spawn_worker(
    program: &str,
    args: &[String],
    envs: Vec<(String, String)>,
    binding: Binding,
) -> io::Result<(Receiver<CommandEvent>, WorkerChild)> {
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(envs)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let (mut child, job) = spawn_bound(command, binding)?;
    let pid = child.id();
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        drop(job);
        let _ = child.wait();
        return Err(io::Error::other("the worker's pipes were not created"));
    };
    let (tx, rx) = channel(1);
    let drained = Arc::new(RwLock::new(()));
    read_chunks(tx.clone(), drained.clone(), stdout, CommandEvent::Stdout);
    read_chunks(tx.clone(), drained.clone(), stderr, CommandEvent::Stderr);
    let group = job.group.clone();
    std::thread::spawn(move || {
        let event = match group.reap(&mut child) {
            Ok(status) => {
                use std::os::unix::process::ExitStatusExt;
                CommandEvent::Terminated(TerminatedPayload {
                    code: status.code(),
                    signal: status.signal(),
                })
            }
            Err(error) => CommandEvent::Error(error.to_string()),
        };
        let _drained = drained.write().unwrap_or_else(|poisoned| poisoned.into_inner());
        let _ = tx.blocking_send(event);
    });
    Ok((rx, WorkerChild { pid, stdin, job }))
}

fn read_chunks<R: Read + Send + 'static>(
    tx: Sender<CommandEvent>,
    drained: Arc<RwLock<()>>,
    mut pipe: R,
    wrap: fn(Vec<u8>) -> CommandEvent,
) {
    let started = Arc::new(std::sync::Barrier::new(2));
    let ready = started.clone();
    std::thread::spawn(move || {
        let _reading = drained.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        ready.wait();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.blocking_send(wrap(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    let _ = tx.blocking_send(CommandEvent::Error(error.to_string()));
                    break;
                }
            }
        }
    });
    // `Terminated` must follow the last chunk: the reaper takes the write
    // side of `drained` only after both readers hold the read side.
    started.wait();
}

// ── the lease carrier ──────────────────────────────────────────────────────

fn carriers() -> &'static Mutex<HashMap<u32, Weak<LeaseCarrier>>> {
    static CARRIERS: OnceLock<Mutex<HashMap<u32, Weak<LeaseCarrier>>>> = OnceLock::new();
    CARRIERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The lease channel of a live bound worker, by pid.
pub fn lease_carrier(pid: u32) -> Option<Arc<LeaseCarrier>> {
    carriers()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&pid)
        .and_then(Weak::upgrade)
}

fn socket_pair() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    cvt(unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    })?;
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

/// The worker's share of every lease retained in it.
///
/// This process keeps both ends of the channel. The worker's end holds at
/// most one queued message: the full set of live leases. A change sends the
/// new set BEFORE the old message is taken back, so a lease that stays live
/// is in flight at every instant.
pub struct LeaseCarrier {
    parent_end: OwnedFd,
    child_end: OwnedFd,
    state: Mutex<CarrierState>,
}

#[derive(Default)]
struct CarrierState {
    next_id: u64,
    live: Vec<(u64, OwnedFd)>,
    queued: bool,
}

impl LeaseCarrier {
    fn new(parent_end: OwnedFd, child_end: OwnedFd) -> Self {
        Self {
            parent_end,
            child_end,
            state: Mutex::new(CarrierState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, CarrierState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Put `lease`'s open file description in the worker's hands. Returns the
    /// id that releases it.
    pub fn hold(&self, lease: BorrowedFd<'_>) -> io::Result<u64> {
        let copy = lease.try_clone_to_owned()?;
        let mut state = self.lock();
        if state.live.len() >= MAX_FDS_PER_MESSAGE {
            return Err(io::Error::other("the worker holds too many folder leases"));
        }
        let id = state.next_id;
        state.next_id += 1;
        state.live.push((id, copy));
        if let Err(error) = self.publish(&mut state) {
            state.live.pop();
            return Err(error);
        }
        Ok(id)
    }

    pub fn release(&self, id: u64) {
        let mut state = self.lock();
        let before = state.live.len();
        state.live.retain(|(held, _)| *held != id);
        if state.live.len() != before {
            let _ = self.publish(&mut state);
        }
    }

    fn publish(&self, state: &mut CarrierState) -> io::Result<()> {
        if !state.live.is_empty() {
            let fds: Vec<RawFd> = state.live.iter().map(|(_, fd)| fd.as_raw_fd()).collect();
            send_fds(self.parent_end.as_fd(), &fds)?;
        }
        if state.queued {
            // The old message is first in the queue; the one just sent
            // follows it.
            take_one(self.child_end.as_fd())?;
        }
        state.queued = !state.live.is_empty();
        Ok(())
    }

    /// Close every copy this process holds and hand back the worker's end,
    /// as a crash of this process would leave it.
    #[cfg(test)]
    pub fn abandon_parent_side(self) -> OwnedFd {
        let Self { parent_end, child_end, state } = self;
        drop(state);
        drop(parent_end);
        child_end
    }
}

fn send_fds(socket: BorrowedFd<'_>, fds: &[RawFd]) -> io::Result<()> {
    let payload = [0u8; 1];
    let mut iov = libc::iovec {
        iov_base: payload.as_ptr() as *mut libc::c_void,
        iov_len: payload.len(),
    };
    let data_len = std::mem::size_of_val(fds) as u32;
    let space = unsafe { libc::CMSG_SPACE(data_len) } as usize;
    let mut control = vec![0u8; space];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = space as _;
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(data_len) as _;
        std::ptr::copy_nonoverlapping(
            fds.as_ptr().cast::<u8>(),
            libc::CMSG_DATA(header),
            data_len as usize,
        );
    }
    loop {
        let sent = unsafe {
            libc::sendmsg(
                socket.as_raw_fd(),
                &message,
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        };
        if sent >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Receive one message and close every descriptor it carried.
fn take_one(socket: BorrowedFd<'_>) -> io::Result<()> {
    let mut payload = [0u8; 1];
    let mut iov = libc::iovec {
        iov_base: payload.as_mut_ptr().cast(),
        iov_len: payload.len(),
    };
    let data_len = (MAX_FDS_PER_MESSAGE * std::mem::size_of::<RawFd>()) as u32;
    let space = unsafe { libc::CMSG_SPACE(data_len) } as usize;
    let mut control = vec![0u8; space];
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = space as _;
    loop {
        let received = unsafe {
            libc::recvmsg(
                socket.as_raw_fd(),
                &mut message,
                libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC,
            )
        };
        if received >= 0 {
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            if (*header).cmsg_level == libc::SOL_SOCKET && (*header).cmsg_type == libc::SCM_RIGHTS {
                let bytes = (*header).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                let count = bytes / std::mem::size_of::<RawFd>();
                let data = libc::CMSG_DATA(header).cast::<RawFd>();
                for index in 0..count {
                    drop(OwnedFd::from_raw_fd(data.add(index).read_unaligned()));
                }
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufRead;
    use std::time::{Duration, Instant};

    fn alive(pid: u32) -> bool {
        // A reparented zombie is reaped by init shortly; count it as gone.
        std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| {
                stat.rsplit(')')
                    .next()
                    .and_then(|rest| rest.split_whitespace().next())
                    .is_some_and(|state| state != "Z")
            })
            .unwrap_or(false)
    }

    fn wait_gone(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn dropping_the_job_kills_every_descendant_in_the_group() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(Stdio::piped());
        let (mut child, job) = spawn_bound(command, Binding::default()).unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let grandchild: u32 = line.trim().parse().unwrap();
        assert!(alive(grandchild));
        drop(job);
        child.wait().unwrap();
        assert!(wait_gone(grandchild));
    }

    #[test]
    fn a_worker_sees_its_lease_channel_and_no_other_child_does() {
        let mut command = Command::new("sh");
        command.args(["-c", "test -S /proc/self/fd/$SPECTRAPDF_LEASE_FD"]);
        let (mut child, job) = spawn_bound(
            command,
            Binding { lease_channel: true, memory_limit: None },
        )
        .unwrap();
        assert!(child.wait().unwrap().success());
        assert!(lease_carrier(child.id()).is_some());
        drop(job);
        assert!(lease_carrier(child.id()).is_none());

        let (mut plain, _job) = spawn_bound(
            {
                let mut command = Command::new("sh");
                command.args(["-c", "test -z \"$SPECTRAPDF_LEASE_FD\""]);
                command
            },
            Binding::default(),
        )
        .unwrap();
        assert!(plain.wait().unwrap().success());
    }

    #[test]
    fn a_memory_limit_applies_to_the_worker() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "grep 'Max data size' /proc/self/limits"])
            .stdout(Stdio::piped());
        let (child, _job) = spawn_bound(
            command,
            Binding { lease_channel: false, memory_limit: Some(64 * 1024 * 1024) },
        )
        .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(String::from_utf8_lossy(&output.stdout).contains("67108864"));
    }

    fn flock_free(path: &std::path::Path) -> bool {
        let probe = std::fs::File::open(path).unwrap();
        unsafe { libc::flock(probe.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
    }

    /// A child another test forks holds copies of this process's descriptors
    /// until its `exec`, so a release is observed within a bound, not at once.
    fn becomes_free(path: &std::path::Path) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if flock_free(path) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn an_unread_message_holds_the_lease_after_every_parent_copy_closes() {
        let scratch = tempfile::tempdir().unwrap();
        let record = scratch.path().join("record");
        let file = std::fs::File::create(&record).unwrap();
        assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
        let (parent_end, child_end) = socket_pair().unwrap();
        let carrier = LeaseCarrier::new(parent_end, child_end);
        carrier.hold(file.as_fd()).unwrap();
        drop(file);
        assert!(!flock_free(&record));
        let worker_end = carrier.abandon_parent_side();
        assert!(!flock_free(&record), "the in-flight copy must hold the lock");
        drop(worker_end);
        assert!(becomes_free(&record));
    }

    #[test]
    fn releasing_one_lease_keeps_the_others_in_flight() {
        let scratch = tempfile::tempdir().unwrap();
        let (parent_end, child_end) = socket_pair().unwrap();
        let carrier = LeaseCarrier::new(parent_end, child_end);
        let paths = [scratch.path().join("a"), scratch.path().join("b")];
        let mut ids = Vec::new();
        for path in &paths {
            let file = std::fs::File::create(path).unwrap();
            assert_eq!(unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) }, 0);
            ids.push(carrier.hold(file.as_fd()).unwrap());
        }
        carrier.release(ids[0]);
        assert!(becomes_free(&paths[0]));
        assert!(!flock_free(&paths[1]));
        let worker_end = carrier.abandon_parent_side();
        assert!(!flock_free(&paths[1]));
        drop(worker_end);
        assert!(becomes_free(&paths[1]));
    }

    #[test]
    fn a_worker_streams_its_output_and_then_reports_termination() {
        let (mut rx, mut child) = spawn_worker(
            "sh",
            &["-c".into(), "read line; echo \"got $line\"; echo err >&2".into()],
            Vec::new(),
            Binding::default(),
        )
        .unwrap();
        child.write(b"ping\n").unwrap();
        let mut stdout = Vec::new();
        let mut terminated = None;
        while let Some(event) = rx.blocking_recv() {
            match event {
                CommandEvent::Stdout(bytes) => stdout.extend(bytes),
                CommandEvent::Terminated(status) => {
                    terminated = Some(status.code);
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(String::from_utf8_lossy(&stdout), "got ping\n");
        assert_eq!(terminated, Some(Some(0)));
    }

    // Invoked by a second test process, which the test below kills.
    #[test]
    #[ignore]
    fn child_spawns_a_bound_sleeper() {
        if std::env::var_os("SPECTRA_TEST_BOUND_SLEEPER").is_none() {
            return;
        }
        let mut command = Command::new("sleep");
        command.arg("60");
        let (child, job) = spawn_bound(command, Binding::default()).unwrap();
        println!("sleeper={}", child.id());
        std::io::stdout().flush().unwrap();
        std::mem::forget(job);
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn a_bound_child_dies_with_the_process_that_spawned_it() {
        let mut parent = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "process_job::tests::child_spawns_a_bound_sleeper",
                "--ignored",
                "--nocapture",
            ])
            .env("SPECTRA_TEST_BOUND_SLEEPER", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let reader = std::io::BufReader::new(parent.stdout.take().unwrap());
        let mut sleeper = None;
        for line in reader.lines() {
            if let Some(pid) = line.unwrap().strip_prefix("sleeper=") {
                sleeper = Some(pid.trim().parse::<u32>().unwrap());
                break;
            }
        }
        let sleeper = sleeper.expect("the sleeper was spawned");
        assert!(alive(sleeper));
        parent.kill().unwrap();
        parent.wait().unwrap();
        assert!(wait_gone(sleeper), "the death signal must kill the orphan");
    }
}
