//! Whether the desktop shows a tray icon at all.
//!
//! The tray icon is an application indicator: it registers with a
//! StatusNotifierItem host through the `org.kde.StatusNotifierWatcher` D-Bus
//! service, and with no watcher it falls back to an XEmbed icon, which an X11
//! system tray (the owner of the `_NET_SYSTEM_TRAY_S<screen>` selection)
//! displays. A desktop with neither shows nothing: a window hidden to the tray
//! there can be reached again only by launching the app a second time. Tray
//! residency is offered only while one of the two hosts exists.
//!
//! The session bus address is resolved here rather than by GIO, because GIO
//! falls back to autolaunching a bus daemon on X11 when the session has no bus.
//!
//! The indicator library itself is the system's (libayatana-appindicator3, or
//! the older libappindicator3), and the binding that builds the icon panics
//! when neither loads. Residency is therefore offered only when one of them
//! opens with `dlopen` AND a host exists.
//!
//! The decision is taken once per process. A launch with `--minimized` on a
//! desktop whose watcher is running but has no host registered yet (a login,
//! where the panel registers after the autostart entries start) waits for the
//! host on a thread of its own; every other launch decides at once, and no
//! launch blocks the main thread on the wait.

use std::ffi::{c_char, c_int, c_ulong, c_void, CString};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use gtk::gio;
use gtk::glib::{self, ToVariant};

const WATCHER_NAME: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const HOST_REGISTERED: &str = "IsStatusNotifierHostRegistered";
/// One property read on the session bus.
const BUS_CALL_TIMEOUT_MS: i32 = 1000;
/// How long a `--minimized` launch waits for a tray host. A login session
/// starts the autostart entries and the panel together, and the panel's host
/// can register after the app has started.
pub const MINIMIZED_LAUNCH_WAIT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The indicator libraries the tray binding can load, preferred first.
const INDICATOR_LIBRARIES: [&std::ffi::CStr; 2] =
    [c"libayatana-appindicator3.so.1", c"libappindicator3.so.1"];

type Decided = Box<dyn FnOnce(bool) + Send>;

/// The launch decision: final, or still waiting with the callbacks to run.
enum State {
    Final(bool),
    Waiting(Vec<Decided>),
}

static DECISION: OnceLock<Mutex<State>> = OnceLock::new();

/// The session bus address, or `None` when this session has no bus.
fn session_bus_address() -> Option<String> {
    bus_address_from(
        std::env::var("DBUS_SESSION_BUS_ADDRESS").ok(),
        std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
    )
}

fn bus_address_from(announced: Option<String>, runtime: Option<PathBuf>) -> Option<String> {
    if let Some(address) = announced.map(|a| a.trim().to_string()).filter(|a| !a.is_empty()) {
        return Some(address);
    }
    let socket = runtime?.join("bus");
    socket
        .exists()
        .then(|| format!("unix:path={}", socket.to_string_lossy()))
}

/// What the StatusNotifierWatcher reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Watcher {
    /// No watcher answers on the session bus.
    Absent,
    /// A watcher runs and no host has registered with it.
    Unhosted,
    Hosted,
}

fn status_notifier() -> Watcher {
    let Some(address) = session_bus_address() else {
        return Watcher::Absent;
    };
    let flags = gio::DBusConnectionFlags::AUTHENTICATION_CLIENT
        | gio::DBusConnectionFlags::MESSAGE_BUS_CONNECTION;
    let Ok(connection) =
        gio::DBusConnection::for_address_sync(&address, flags, None, None::<&gio::Cancellable>)
    else {
        return Watcher::Absent;
    };
    let reply = connection.call_sync(
        Some(WATCHER_NAME),
        WATCHER_PATH,
        "org.freedesktop.DBus.Properties",
        "Get",
        Some(&(WATCHER_NAME, HOST_REGISTERED).to_variant()),
        Some(glib::VariantTy::new("(v)").expect("a valid type string")),
        gio::DBusCallFlags::NO_AUTO_START,
        BUS_CALL_TIMEOUT_MS,
        None::<&gio::Cancellable>,
    );
    let _ = connection.close_sync(None::<&gio::Cancellable>);
    let Ok(reply) = reply else {
        return Watcher::Absent;
    };
    let hosted = reply
        .try_child_value(0)
        .and_then(|boxed| boxed.as_variant())
        .and_then(|value| value.get::<bool>())
        .unwrap_or(false);
    if hosted {
        Watcher::Hosted
    } else {
        Watcher::Unhosted
    }
}

/// Whether one of the indicator libraries opens.
fn indicator_library_present() -> bool {
    INDICATOR_LIBRARIES.iter().any(|name| unsafe {
        let handle = libc::dlopen(name.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if handle.is_null() {
            false
        } else {
            libc::dlclose(handle);
            true
        }
    })
}

/// Whether the toolkit draws through X11, where an XEmbed icon can appear.
/// GDK prefers Wayland when both displays exist and `GDK_BACKEND` names none.
fn toolkit_uses_x11(display: Option<&str>, wayland: Option<&str>, backend: Option<&str>) -> bool {
    if display.map_or(true, str::is_empty) {
        return false;
    }
    match backend.map(str::trim).filter(|b| !b.is_empty()) {
        Some(backend) => backend
            .split(',')
            .next()
            .is_some_and(|first| first.trim() == "x11"),
        None => wayland.map_or(true, str::is_empty),
    }
}

type XOpenDisplay = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type XCloseDisplay = unsafe extern "C" fn(*mut c_void) -> c_int;
type XDefaultScreen = unsafe extern "C" fn(*mut c_void) -> c_int;
type XInternAtom = unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> c_ulong;
type XGetSelectionOwner = unsafe extern "C" fn(*mut c_void, c_ulong) -> c_ulong;

/// Whether an X11 system tray owns `_NET_SYSTEM_TRAY_S<screen>`. libX11 is
/// loaded at run time: a session without it has no XEmbed tray either.
fn xembed_tray_present() -> bool {
    let env = |name: &str| std::env::var(name).ok();
    if !toolkit_uses_x11(
        env("DISPLAY").as_deref(),
        env("WAYLAND_DISPLAY").as_deref(),
        env("GDK_BACKEND").as_deref(),
    ) {
        return false;
    }
    unsafe {
        let library = libc::dlopen(c"libX11.so.6".as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL);
        if library.is_null() {
            return false;
        }
        let symbol = |name: &std::ffi::CStr| libc::dlsym(library, name.as_ptr());
        let (open, close, screen, intern, owner) = (
            symbol(c"XOpenDisplay"),
            symbol(c"XCloseDisplay"),
            symbol(c"XDefaultScreen"),
            symbol(c"XInternAtom"),
            symbol(c"XGetSelectionOwner"),
        );
        if [open, close, screen, intern, owner].iter().any(|s| s.is_null()) {
            libc::dlclose(library);
            return false;
        }
        let open: XOpenDisplay = std::mem::transmute(open);
        let close: XCloseDisplay = std::mem::transmute(close);
        let screen: XDefaultScreen = std::mem::transmute(screen);
        let intern: XInternAtom = std::mem::transmute(intern);
        let owner: XGetSelectionOwner = std::mem::transmute(owner);
        let display = open(std::ptr::null());
        let present = if display.is_null() {
            false
        } else {
            let selection = CString::new(format!("_NET_SYSTEM_TRAY_S{}", screen(display)))
                .expect("no interior NUL");
            let atom = intern(display, selection.as_ptr(), 0);
            let present = atom != 0 && owner(display, atom) != 0;
            close(display);
            present
        };
        libc::dlclose(library);
        present
    }
}

/// Whether a tray host exists now.
pub fn host_present() -> bool {
    status_notifier() == Watcher::Hosted || xembed_tray_present()
}

/// What a launch can decide at once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Probe {
    Present,
    Absent,
    /// A watcher runs without a host: one may still register.
    Pending,
}

fn classify(library: bool, watcher: Watcher, xembed: bool) -> Probe {
    if !library {
        Probe::Absent
    } else if watcher == Watcher::Hosted || xembed {
        Probe::Present
    } else if watcher == Watcher::Unhosted {
        Probe::Pending
    } else {
        Probe::Absent
    }
}

/// Poll `probe` until it answers true or `wait` has passed.
fn present_within(wait: Duration, mut probe: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if probe() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// The first state for a probe: a pending probe waits only when the launch
/// asked to start minimized, and `wait` starts that wait elsewhere.
fn first_state(probe: Probe, minimized: bool, wait: impl FnOnce()) -> State {
    match probe {
        Probe::Present => State::Final(true),
        Probe::Absent => State::Final(false),
        Probe::Pending if minimized => {
            wait();
            State::Waiting(Vec::new())
        }
        Probe::Pending => State::Final(false),
    }
}

fn decision() -> &'static Mutex<State> {
    DECISION.get_or_init(|| {
        let library = indicator_library_present();
        let probe = if library {
            classify(true, status_notifier(), xembed_tray_present())
        } else {
            Probe::Absent
        };
        let minimized = std::env::args().skip(1).any(|a| a == "--minimized");
        Mutex::new(first_state(probe, minimized, || {
            std::thread::spawn(|| {
                let present = present_within(MINIMIZED_LAUNCH_WAIT, host_present);
                settle(decision(), present);
            });
        }))
    })
}

/// Make the decision final and run whoever was waiting for it.
fn settle(state: &Mutex<State>, present: bool) {
    let waiting = {
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        match std::mem::replace(&mut *state, State::Final(present)) {
            State::Waiting(callbacks) => callbacks,
            State::Final(already) => {
                *state = State::Final(already);
                Vec::new()
            }
        }
    };
    for callback in waiting {
        callback(present);
    }
}

/// Whether this process offers tray residency: false while a decision waits.
pub fn residency_at_launch() -> bool {
    matches!(*decision().lock().unwrap_or_else(|e| e.into_inner()), State::Final(true))
}

/// Whether the launch decision is still waiting for a host.
pub fn pending() -> bool {
    matches!(*decision().lock().unwrap_or_else(|e| e.into_inner()), State::Waiting(_))
}

/// Run `decided` with the final answer: now when there is one, otherwise on
/// the waiting thread once the host registers or the wait runs out.
pub fn when_decided(decided: impl FnOnce(bool) + Send + 'static) {
    when_decided_in(decision(), Box::new(decided));
}

fn when_decided_in(state: &Mutex<State>, decided: Decided) {
    let now = {
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        match &mut *state {
            State::Final(present) => Some(*present),
            State::Waiting(callbacks) => {
                callbacks.push(decided);
                return;
            }
        }
    };
    if let Some(present) = now {
        decided(present);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xembed_counts_only_where_the_toolkit_draws_through_x11() {
        assert!(toolkit_uses_x11(Some(":0"), None, None));
        assert!(!toolkit_uses_x11(Some(":0"), Some("wayland-0"), None));
        assert!(toolkit_uses_x11(Some(":0"), Some("wayland-0"), Some("x11")));
        assert!(toolkit_uses_x11(Some(":0"), Some("wayland-0"), Some("x11,wayland")));
        assert!(!toolkit_uses_x11(Some(":0"), None, Some("wayland")));
        assert!(!toolkit_uses_x11(None, None, Some("x11")));
        assert!(!toolkit_uses_x11(Some(""), None, None));
        assert!(toolkit_uses_x11(Some(":0"), Some(""), Some(" ")));
    }

    #[test]
    fn residency_needs_the_indicator_library_and_a_host() {
        assert_eq!(classify(false, Watcher::Hosted, true), Probe::Absent);
        assert_eq!(classify(true, Watcher::Hosted, false), Probe::Present);
        assert_eq!(classify(true, Watcher::Absent, true), Probe::Present);
        assert_eq!(classify(true, Watcher::Unhosted, false), Probe::Pending);
        assert_eq!(classify(true, Watcher::Absent, false), Probe::Absent);
    }

    #[test]
    fn only_a_minimized_launch_with_a_waiting_watcher_waits() {
        let mut waits = 0;
        assert!(matches!(first_state(Probe::Absent, true, || waits += 1), State::Final(false)));
        assert!(matches!(first_state(Probe::Present, true, || waits += 1), State::Final(true)));
        assert!(matches!(first_state(Probe::Pending, false, || waits += 1), State::Final(false)));
        assert_eq!(waits, 0, "no watcher, a host, or a shown launch decides at once");
        assert!(matches!(first_state(Probe::Pending, true, || waits += 1), State::Waiting(_)));
        assert_eq!(waits, 1);
    }

    #[test]
    fn callbacks_run_once_with_the_final_answer() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let state = Mutex::new(State::Waiting(Vec::new()));
        let ran = Arc::new(AtomicUsize::new(0));
        let early = ran.clone();
        when_decided_in(&state, Box::new(move |present| {
            assert!(present);
            early.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(ran.load(Ordering::SeqCst), 0);
        settle(&state, true);
        assert_eq!(ran.load(Ordering::SeqCst), 1);
        settle(&state, false);
        assert!(matches!(*state.lock().unwrap(), State::Final(true)), "a final answer is kept");
        let late = ran.clone();
        when_decided_in(&state, Box::new(move |present| {
            assert!(present);
            late.fetch_add(1, Ordering::SeqCst);
        }));
        assert_eq!(ran.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_launch_wait_ends_on_the_first_yes_and_at_the_deadline() {
        let mut asked = 0;
        assert!(present_within(Duration::from_secs(5), || {
            asked += 1;
            asked == 2
        }));
        assert_eq!(asked, 2);
        let started = Instant::now();
        let mut asked = 0;
        assert!(!present_within(Duration::ZERO, || {
            asked += 1;
            false
        }));
        assert_eq!(asked, 1);
        assert!(started.elapsed() < POLL_INTERVAL);
    }

    #[test]
    fn a_session_without_a_bus_has_no_status_notifier_host() {
        let runtime = tempfile::tempdir().unwrap();
        assert_eq!(bus_address_from(None, Some(runtime.path().to_path_buf())), None);
        assert_eq!(bus_address_from(Some("  ".into()), None), None);
        assert_eq!(
            bus_address_from(Some("unix:path=/run/user/7/bus".into()), None).as_deref(),
            Some("unix:path=/run/user/7/bus")
        );
        std::fs::write(runtime.path().join("bus"), b"").unwrap();
        assert_eq!(
            bus_address_from(None, Some(runtime.path().to_path_buf())),
            Some(format!("unix:path={}", runtime.path().join("bus").display()))
        );
    }
}
