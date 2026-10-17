//! Automatic updates: the version check, the background download and
//! verification, the staging, and the apply at the app's final exit.
//!
//! The manifest is unauthenticated and supplies only a release number and a
//! signature. Every address is compiled in ([`source`]), every artifact is
//! verified against the compiled-in key with its trusted comment bound to the
//! expected file name, and nothing older than or equal to the running version
//! is ever offered. The machine policy `DisableAutoUpdate` outranks every
//! preference, and the SYSTEM task reads it again before it runs anything.

pub mod cli;
pub mod portable_update;
pub mod proc;
pub mod source;
pub mod system;
pub mod verify;
pub mod version;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use portable_update::{Layout, StagedRecord};
use source::Artifact;
use system::{LastApply, Outcome};
use version::Version;

pub const STATUS_EVENT: &str = "update://status";

const MANIFEST_CAP: u64 = 1024 * 1024;
const FREE_SPACE_MARGIN: u64 = 256 * 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerKind {
    Installed,
    Portable,
    Unsupported,
}

impl ContainerKind {
    /// Whether this container downloads and applies updates itself.
    pub fn applies(self) -> bool {
        self != ContainerKind::Unsupported
    }

    fn artifact(self) -> Option<Artifact> {
        match self {
            ContainerKind::Installed => Some(Artifact::Installer),
            ContainerKind::Portable => Some(Artifact::Portable),
            ContainerKind::Unsupported => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FailureKind {
    Network,
    Signature,
    Disabled,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateError {
    pub kind: FailureKind,
    pub message: String,
}

impl UpdateError {
    fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        UpdateError {
            kind,
            message: message.into(),
        }
    }

    fn other(message: impl Into<String>) -> Self {
        Self::new(FailureKind::Other, message)
    }
}

fn from_release((failure, message): (crate::net::ReleaseFailure, String)) -> UpdateError {
    match failure {
        crate::net::ReleaseFailure::Network => UpdateError::new(FailureKind::Network, message),
        crate::net::ReleaseFailure::Disk | crate::net::ReleaseFailure::Refused => UpdateError::other(message),
    }
}

fn from_verify(error: verify::VerifyError) -> UpdateError {
    match error {
        verify::VerifyError::Signature(m) => UpdateError::new(FailureKind::Signature, m),
        verify::VerifyError::Io(m) => UpdateError::other(m),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastApplyStatus {
    pub outcome: Outcome,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub policy_disabled: bool,
    pub container: ContainerKind,
    pub phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<FailureKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_apply: Option<LastApplyStatus>,
    /// The version whose apply failed: it is prepared only on an Install click.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub check_on_launch: bool,
    pub apply_automatically: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            check_on_launch: true,
            apply_automatically: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckResult {
    pub version: String,
}

// ── Decisions ─────────────────────────────────────────────────────────────

pub fn launch_check_allowed(policy: bool, prefs: Prefs) -> bool {
    !policy && prefs.check_on_launch
}

pub fn manual_check_allowed(policy: bool) -> bool {
    !policy
}

pub fn auto_prepare_allowed(policy: bool, prefs: Prefs, container: ContainerKind) -> bool {
    !policy && prefs.apply_automatically && container.applies()
}

pub fn prepare_allowed(policy: bool, container: ContainerKind) -> bool {
    !policy && container.applies()
}

/// How a staged update was prepared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageOrigin {
    /// The user clicked Install.
    Clicked,
    /// Prepared without a click because automatic install was on.
    Automatic,
}

/// A clicked stage always applies. An automatic stage applies only while
/// automatic install is still on, or when the user chose Restart now.
pub fn apply_at_exit_allowed(
    policy: bool,
    container: ContainerKind,
    staged: Option<StageOrigin>,
    apply_automatically: bool,
    relaunch: bool,
) -> bool {
    let wanted = match staged {
        None => false,
        Some(StageOrigin::Clicked) => true,
        Some(StageOrigin::Automatic) => apply_automatically || relaunch,
    };
    !policy && container.applies() && wanted
}

/// Whether the final exit relaunches: the quit that asked for the relaunch
/// must be the quit that holds the session seal at that exit, and the closing
/// window must be closing for that quit. A cancelled quit lifts its seal, so a
/// later exit never inherits its request; a window that was not part of the
/// quit closes with no quit id and never relaunches.
pub fn relaunch_applies(requested_by: Option<u64>, sealed_by: Option<u64>, closing_for: Option<u64>) -> bool {
    matches!(
        (requested_by, sealed_by, closing_for),
        (Some(asked), Some(sealed), Some(closing)) if asked == sealed && sealed == closing
    )
}

// ── The manifest ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub version: Version,
    /// `platforms` key to its base64 `signature`.
    pub signatures: BTreeMap<String, String>,
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("The update manifest is not JSON: {e}"))?;
    let version = value
        .get("version")
        .and_then(|v| v.as_str())
        .and_then(Version::parse)
        .ok_or("The update manifest names no release number")?;
    let mut signatures = BTreeMap::new();
    if let Some(platforms) = value.get("platforms").and_then(|p| p.as_object()) {
        for (key, entry) in platforms {
            if let Some(signature) = entry.get("signature").and_then(|s| s.as_str()) {
                signatures.insert(key.clone(), signature.to_string());
            }
        }
    }
    Ok(Manifest { version, signatures })
}

// ── State ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Offer {
    version: Version,
    /// The manifest's base64 signature for this container's artifact.
    signature: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Staged {
    Installed {
        run_id: String,
        version: Version,
        installer: PathBuf,
        automatic: bool,
    },
    Portable {
        version: Version,
        automatic: bool,
    },
}

impl Staged {
    fn version(&self) -> Version {
        match self {
            Staged::Installed { version, .. } | Staged::Portable { version, .. } => *version,
        }
    }

    fn automatic(&self) -> bool {
        match self {
            Staged::Installed { automatic, .. } | Staged::Portable { automatic, .. } => *automatic,
        }
    }

    fn origin(&self) -> StageOrigin {
        if self.automatic() {
            StageOrigin::Automatic
        } else {
            StageOrigin::Clicked
        }
    }

    fn set_automatic(&mut self, value: bool) {
        match self {
            Staged::Installed { automatic, .. } | Staged::Portable { automatic, .. } => *automatic = value,
        }
    }
}

/// A record written without an origin counts as automatic, so turning
/// automatic install off still holds it back.
pub(crate) fn automatic_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRun {
    run_id: String,
    version: String,
    installer: PathBuf,
    #[serde(default = "automatic_by_default")]
    automatic: bool,
}

struct Inner {
    prefs: Prefs,
    configured: bool,
    policy: bool,
    phase: Phase,
    version: Option<Version>,
    received: Option<u64>,
    total: Option<u64>,
    failure: Option<FailureKind>,
    last_apply: Option<LastApplyStatus>,
    failed: Option<Version>,
    offer: Option<Offer>,
    staged: Option<Staged>,
    working: bool,
    /// The user clicked Install for the current offer.
    clicked: bool,
    last_progress: Option<Instant>,
}

pub struct UpdateState {
    inner: Mutex<Inner>,
    /// Set only by the final exit ([`arm_relaunch_at_exit`]).
    relaunch: AtomicBool,
    /// The session seal id of the quit that asked to relaunch.
    relaunch_for: Mutex<Option<u64>>,
    container: OnceLock<ContainerKind>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdateState {
    pub fn new() -> Self {
        UpdateState {
            inner: Mutex::new(Inner {
                prefs: Prefs::default(),
                configured: false,
                policy: false,
                phase: Phase::Idle,
                version: None,
                received: None,
                total: None,
                failure: None,
                last_apply: None,
                failed: None,
                offer: None,
                staged: None,
                working: false,
                clicked: false,
                last_progress: None,
            }),
            relaunch: AtomicBool::new(false),
            relaunch_for: Mutex::new(None),
            container: OnceLock::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn container(&self) -> ContainerKind {
        *self.container.get_or_init(detect_container)
    }

    pub fn status(&self) -> UpdateStatus {
        let container = self.container();
        let inner = self.lock();
        UpdateStatus {
            policy_disabled: inner.policy,
            container,
            phase: inner.phase,
            version: inner.version.map(|v| v.to_string()),
            received: inner.received,
            total: inner.total,
            failure: inner.failure,
            last_apply: inner.last_apply.clone(),
            failed_version: inner.failed.map(|v| v.to_string()),
        }
    }

    fn refresh_policy(&self) -> bool {
        let policy = crate::commands::machine_policy_set("DisableAutoUpdate");
        self.lock().policy = policy;
        policy
    }

    fn fail(&self, error: &UpdateError) {
        let mut inner = self.lock();
        inner.phase = Phase::Failed;
        inner.failure = Some(error.kind);
        inner.received = None;
        inner.total = None;
        inner.working = false;
    }
}

fn detect_container() -> ContainerKind {
    if !cfg!(windows)
        || (cfg!(debug_assertions) && !cfg!(feature = "update-test-source"))
        || crate::is_e2e_mode()
    {
        return ContainerKind::Unsupported;
    }
    match crate::portable::container() {
        Ok(crate::portable::Container::Installed) => ContainerKind::Installed,
        Ok(crate::portable::Container::Portable) => match crate::portable::exe_dir() {
            Ok(dir) if portable_root_writable(&dir) => ContainerKind::Portable,
            _ => ContainerKind::Unsupported,
        },
        _ => ContainerKind::Unsupported,
    }
}

fn portable_root_writable(root: &Path) -> bool {
    let dir = root.join(portable_update::UPDATE_DIR);
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let probe = dir.join(format!("probe-{}", std::process::id()));
    let written = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    written
}

fn state_dir(app: &AppHandle) -> Result<PathBuf, UpdateError> {
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("updates"))
        .map_err(|e| UpdateError::other(format!("Cannot resolve the update folder: {e}")))
}

fn portable_layout() -> Result<Layout, UpdateError> {
    crate::portable::exe_dir().map(|dir| Layout::new(&dir)).map_err(UpdateError::other)
}

// ── Failed versions ───────────────────────────────────────────────────────

/// The version whose apply failed (not deferred). Its staged files are
/// removed at the next start and an automatic prepare never takes it again;
/// an Install click prepares it, and the clicked stage removes the record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedRecord {
    pub version: String,
}

fn newer(text: &str) -> Option<Version> {
    Version::parse(text).filter(|v| *v > Version::running())
}

/// The failed record and the last-apply record of a container.
fn failure_paths(app: &AppHandle, container: ContainerKind) -> Option<(PathBuf, PathBuf)> {
    match container {
        ContainerKind::Installed => state_dir(app)
            .ok()
            .map(|state| (state.join(system::FAILED_FILE), state.join(system::LAST_APPLY_FILE))),
        ContainerKind::Portable => portable_layout().ok().map(|layout| (layout.failed, layout.last_apply)),
        ContainerKind::Unsupported => None,
    }
}

/// The failed version newer than the running one. A failed last-apply record
/// that the start has not read yet counts, so a check that runs before the
/// start's restore still sees the failure.
fn failed_version_in(failed: &Path, last_apply: &Path) -> Option<Version> {
    portable_update::read_json::<FailedRecord>(failed)
        .and_then(|r| newer(&r.version))
        .or_else(|| {
            portable_update::read_json::<LastApply>(last_apply)
                .filter(|r| r.outcome == Outcome::Failed)
                .and_then(|r| newer(&r.version))
        })
}

fn failed_version(app: &AppHandle, container: ContainerKind) -> Option<Version> {
    failure_paths(app, container).and_then(|(failed, last)| failed_version_in(&failed, &last))
}

/// Writes the failed record for a failed last apply of a newer version, and
/// removes a record that is no newer than the running version.
fn settle_failed(failed: &Path, last: Option<&LastApplyStatus>) -> Option<Version> {
    let failed_now = last
        .filter(|l| l.outcome == Outcome::Failed)
        .and_then(|l| newer(&l.version));
    if let Some(version) = failed_now {
        let _ = portable_update::write_json(failed, &FailedRecord { version: version.to_string() });
        return Some(version);
    }
    let recorded = portable_update::read_json::<FailedRecord>(failed).and_then(|r| newer(&r.version));
    if recorded.is_none() {
        let _ = std::fs::remove_file(failed);
    }
    recorded
}

/// Removes the failed record when it names `version`.
fn release_failed_in(failed: &Path, version: Version) {
    let recorded = portable_update::read_json::<FailedRecord>(failed).and_then(|r| Version::parse(&r.version));
    if recorded == Some(version) {
        let _ = std::fs::remove_file(failed);
    }
}

fn release_failed(app: &AppHandle, container: ContainerKind, version: Version) {
    if let Some((failed, _)) = failure_paths(app, container) {
        release_failed_in(&failed, version);
    }
}

/// An automatic prepare never takes the failed version. Each Install click
/// is one attempt: a failure records the version again, so no attempt
/// repeats without a click.
pub fn prepare_skipped(automatic: bool, failed: Option<Version>, offered: Version) -> bool {
    automatic && failed == Some(offered)
}

/// Sends the status to every workspace window by label.
pub fn publish(app: &AppHandle) {
    let status = app.state::<UpdateState>().status();
    for label in crate::app_windows::app_window_labels(app) {
        let _ = app.emit_to(label.as_str(), STATUS_EVENT, &status);
    }
}

// ── Check ─────────────────────────────────────────────────────────────────

async fn fetch_manifest() -> Result<Manifest, UpdateError> {
    let source = source::source().map_err(UpdateError::other)?;
    let bytes = crate::net::fetch_release_bytes(&source.manifest_url, &source.origins, MANIFEST_CAP)
        .await
        .map_err(from_release)?;
    parse_manifest(&bytes).map_err(UpdateError::other)
}

async fn check(app: AppHandle, automatic: bool) -> Result<Option<CheckResult>, UpdateError> {
    let state = app.state::<UpdateState>();
    let container = state.container();
    if state.refresh_policy() {
        publish(&app);
        return Err(UpdateError::new(FailureKind::Disabled, "Updates are turned off by policy"));
    }
    {
        let mut inner = state.lock();
        if automatic && !launch_check_allowed(inner.policy, inner.prefs) {
            return Ok(None);
        }
        match inner.phase {
            Phase::Checking => return Ok(inner.version.map(|v| CheckResult { version: v.to_string() })),
            Phase::Downloading | Phase::Verifying | Phase::Ready => {
                return Ok(inner.version.map(|v| CheckResult { version: v.to_string() }))
            }
            _ => {}
        }
        inner.phase = Phase::Checking;
        inner.failure = None;
    }
    publish(&app);
    let manifest = match fetch_manifest().await {
        Ok(manifest) => manifest,
        Err(error) => {
            state.fail(&error);
            publish(&app);
            return Err(error);
        }
    };
    if manifest.version <= Version::running() {
        let mut inner = state.lock();
        inner.phase = Phase::Idle;
        inner.version = None;
        inner.offer = None;
        drop(inner);
        publish(&app);
        return Ok(None);
    }
    let signature = container
        .artifact()
        .and_then(|artifact| manifest.signatures.get(artifact.manifest_key()).cloned());
    if let (Some(artifact), Some(encoded)) = (container.artifact(), signature.as_deref()) {
        let bound = verify::signature_text(encoded)
            .and_then(|text| verify::signature(&text))
            .map_err(|m| UpdateError::new(FailureKind::Signature, m))
            .and_then(|sig| {
                verify::check_binding(&sig, &artifact.signed_name(manifest.version)).map_err(from_verify)
            });
        if let Err(error) = bound {
            state.fail(&error);
            publish(&app);
            return Err(error);
        }
    }
    let failed = failed_version(&app, container);
    let auto = {
        let mut inner = state.lock();
        inner.failed = failed;
        inner.phase = Phase::Available;
        inner.version = Some(manifest.version);
        inner.offer = Some(Offer {
            version: manifest.version,
            signature: signature.clone(),
        });
        auto_prepare_allowed(inner.policy, inner.prefs, container) && signature.is_some()
    };
    publish(&app);
    if auto {
        let _ = start_prepare(&app, true);
    }
    Ok(Some(CheckResult {
        version: manifest.version.to_string(),
    }))
}

// ── Prepare ───────────────────────────────────────────────────────────────

/// Rewrites the staged record with the stage's origin.
fn persist_origin(app: &AppHandle, staged: &Staged) {
    match staged {
        Staged::Installed {
            run_id,
            version,
            installer,
            automatic,
        } => {
            if let Ok(state) = state_dir(app) {
                let _ = portable_update::write_json(
                    &state.join(system::PENDING_RUN_FILE),
                    &PendingRun {
                        run_id: run_id.clone(),
                        version: version.to_string(),
                        installer: installer.clone(),
                        automatic: *automatic,
                    },
                );
            }
        }
        Staged::Portable { version, automatic } => {
            if let Ok(layout) = portable_layout() {
                let _ = portable_update::write_json(
                    &layout.staged_record,
                    &StagedRecord {
                        version: version.to_string(),
                        automatic: *automatic,
                    },
                );
            }
        }
    }
}

/// A click on Install makes the current offer a clicked one, also when an
/// automatic download is running or already staged.
fn mark_clicked(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let changed = {
        let mut inner = state.lock();
        inner.clicked = true;
        match inner.staged.as_mut() {
            Some(staged) if staged.automatic() => {
                staged.set_automatic(false);
                Some(staged.clone())
            }
            _ => None,
        }
    };
    if let Some(staged) = changed {
        persist_origin(app, &staged);
    }
}

fn start_prepare(app: &AppHandle, automatic: bool) -> Result<(), UpdateError> {
    let state = app.state::<UpdateState>();
    let container = state.container();
    let policy = state.refresh_policy();
    if policy {
        return Err(UpdateError::new(FailureKind::Disabled, "Updates are turned off by policy"));
    }
    if !prepare_allowed(policy, container) {
        return Err(UpdateError::other("This copy of the app is updated by its package manager"));
    }
    let failed = failed_version(app, container);
    let offer = {
        let mut inner = state.lock();
        if inner.working || inner.phase == Phase::Ready {
            drop(inner);
            if !automatic {
                mark_clicked(app);
            }
            return Ok(());
        }
        let offer = inner.offer.clone().ok_or_else(|| UpdateError::other("No update is available"))?;
        if offer.signature.is_none() {
            return Err(UpdateError::other("The release carries no signed file for this copy of the app"));
        }
        inner.failed = failed;
        if prepare_skipped(automatic, failed, offer.version) {
            return Ok(());
        }
        inner.working = true;
        inner.clicked = !automatic;
        inner.phase = Phase::Downloading;
        inner.received = Some(0);
        inner.total = None;
        inner.failure = None;
        offer
    };
    publish(app);
    let worker = app.clone();
    std::thread::Builder::new()
        .name("update-download".to_string())
        .spawn(move || prepare_worker(worker, offer, container, automatic))
        .map(|_| ())
        .map_err(|e| {
            let error = UpdateError::other(format!("Cannot start the download: {e}"));
            app.state::<UpdateState>().fail(&error);
            publish(app);
            error
        })
}

fn prepare_worker(app: AppHandle, offer: Offer, container: ContainerKind, automatic: bool) {
    let _background = proc::Background::enter();
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| UpdateError::other(format!("Cannot start the download: {e}")))
        .and_then(|runtime| match container {
            ContainerKind::Installed => runtime.block_on(prepare_installed(&app, &offer, automatic)),
            ContainerKind::Portable => runtime.block_on(prepare_portable(&app, &offer, automatic)),
            ContainerKind::Unsupported => Err(UpdateError::other("Updates are not applied here")),
        });
    let state = app.state::<UpdateState>();
    match result {
        Ok(mut staged) => {
            let rewritten = {
                let mut inner = state.lock();
                let rewrite = inner.clicked && staged.automatic();
                if rewrite {
                    staged.set_automatic(false);
                }
                inner.phase = Phase::Ready;
                inner.version = Some(staged.version());
                inner.staged = Some(staged.clone());
                inner.working = false;
                if !staged.automatic() && inner.failed == Some(staged.version()) {
                    inner.failed = None;
                }
                rewrite.then_some(staged.clone())
            };
            if let Some(rewritten) = rewritten {
                persist_origin(&app, &rewritten);
            }
            if !staged.automatic() {
                release_failed(&app, container, staged.version());
            }
        }
        Err(error) => state.fail(&error),
    }
    publish(&app);
}

fn progress(app: &AppHandle, received: u64, total: Option<u64>) {
    let state = app.state::<UpdateState>();
    let due = {
        let mut inner = state.lock();
        inner.received = Some(received);
        inner.total = total;
        let due = inner.last_progress.map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL)
            || total == Some(received);
        if due {
            inner.last_progress = Some(Instant::now());
        }
        due
    };
    if due {
        publish(app);
    }
}

fn set_verifying(app: &AppHandle) {
    app.state::<UpdateState>().lock().phase = Phase::Verifying;
    publish(app);
}

fn admit_space(dir: &Path, need: u64) -> Result<(), String> {
    match proc::free_bytes(dir) {
        Some(free) if free < need.saturating_add(FREE_SPACE_MARGIN) => Err(format!(
            "The update needs {} MB free on the drive of {}",
            need.saturating_add(FREE_SPACE_MARGIN) / (1024 * 1024),
            dir.display()
        )),
        _ => Ok(()),
    }
}

struct Prepared {
    key: minisign_verify::PublicKey,
    signature: minisign_verify::Signature,
    signature_text: String,
    url: String,
    origins: crate::net::ReleaseOrigins,
}

fn prepared(offer: &Offer, artifact: Artifact) -> Result<Prepared, UpdateError> {
    let source = source::source().map_err(UpdateError::other)?;
    let key = verify::public_key(&source.public_key).map_err(UpdateError::other)?;
    let encoded = offer
        .signature
        .as_deref()
        .ok_or_else(|| UpdateError::other("The release carries no signature"))?;
    let signature_text =
        verify::signature_text(encoded).map_err(|m| UpdateError::new(FailureKind::Signature, m))?;
    let signature =
        verify::signature(&signature_text).map_err(|m| UpdateError::new(FailureKind::Signature, m))?;
    verify::check_binding(&signature, &artifact.signed_name(offer.version)).map_err(from_verify)?;
    Ok(Prepared {
        key,
        signature,
        signature_text,
        url: source.asset_url(artifact, offer.version),
        origins: source.origins,
    })
}

async fn download(app: &AppHandle, p: &Prepared, artifact: Artifact, part: &Path) -> Result<(), UpdateError> {
    let dir = part.parent().map(Path::to_path_buf).unwrap_or_default();
    let _ = std::fs::remove_file(part);
    crate::net::fetch_release_file(
        &p.url,
        &p.origins,
        part,
        artifact.cap(),
        |declared| admit_space(&dir, declared.unwrap_or(0)),
        |received, total| progress(app, received, total),
    )
    .await
    .map_err(from_release)?;
    Ok(())
}

fn inbox_accepts(inbox: &Path, run_id: &str) -> bool {
    let probe = inbox.join(format!("{run_id}.probe"));
    let created = std::fs::OpenOptions::new().write(true).create_new(true).open(&probe).is_ok();
    let _ = std::fs::remove_file(&probe);
    created
}

async fn prepare_installed(app: &AppHandle, offer: &Offer, automatic: bool) -> Result<Staged, UpdateError> {
    let artifact = Artifact::Installer;
    let p = prepared(offer, artifact)?;
    let state = state_dir(app)?;
    std::fs::create_dir_all(&state).map_err(|e| UpdateError::other(e.to_string()))?;
    let run_id = system::new_run_id();
    let inbox = system::machine_layout()
        .ok()
        .map(|layout| layout.inbox)
        .filter(|inbox| system::task_present() && inbox_accepts(inbox, &run_id));
    let dir = match inbox {
        Some(inbox) => inbox,
        None => {
            let local = state.join("download");
            let _ = std::fs::remove_dir_all(&local);
            std::fs::create_dir_all(&local).map_err(|e| UpdateError::other(e.to_string()))?;
            local
        }
    };
    let part = dir.join(format!("{run_id}.exe.part"));
    let installer = dir.join(format!("{run_id}.exe"));
    let signature_file = dir.join(format!("{run_id}.sig"));
    download(app, &p, artifact, &part).await?;
    set_verifying(app);
    let verified = verify::verify_file(&part, &p.signature, &p.key, &artifact.signed_name(offer.version))
        .map_err(from_verify)
        .and_then(|()| std::fs::write(&signature_file, &p.signature_text).map_err(|e| UpdateError::other(e.to_string())))
        .and_then(|()| std::fs::rename(&part, &installer).map_err(|e| UpdateError::other(e.to_string())))
        .and_then(|()| {
            portable_update::write_json(
                &state.join(system::PENDING_RUN_FILE),
                &PendingRun {
                    run_id: run_id.clone(),
                    version: offer.version.to_string(),
                    installer: installer.clone(),
                    automatic,
                },
            )
            .map_err(UpdateError::other)
        });
    if let Err(error) = verified {
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(&installer);
        let _ = std::fs::remove_file(&signature_file);
        return Err(error);
    }
    Ok(Staged::Installed {
        run_id,
        version: offer.version,
        installer,
        automatic,
    })
}

async fn prepare_portable(app: &AppHandle, offer: &Offer, automatic: bool) -> Result<Staged, UpdateError> {
    let artifact = Artifact::Portable;
    let p = prepared(offer, artifact)?;
    let layout = portable_layout()?;
    if layout.swap_record.exists() {
        return Err(UpdateError::other("An earlier update is not finished"));
    }
    let io = |e: std::io::Error| UpdateError::other(e.to_string());
    let _ = std::fs::remove_dir_all(&layout.download);
    std::fs::create_dir_all(&layout.download).map_err(io)?;
    let part = layout.download.join(format!("{}.part", artifact.asset_name(offer.version)));
    download(app, &p, artifact, &part).await?;
    set_verifying(app);
    let outcome = (|| {
        verify::verify_file(&part, &p.signature, &p.key, &artifact.signed_name(offer.version))
            .map_err(from_verify)?;
        let _ = std::fs::remove_dir_all(&layout.staging);
        portable_update::extract(&part, &layout.staging, |plan| admit_space(&layout.dir, plan.total))
            .map_err(UpdateError::other)?;
        let _ = std::fs::remove_file(&layout.staged_record);
        let _ = std::fs::remove_dir_all(&layout.staged);
        std::fs::rename(&layout.staging, &layout.staged).map_err(io)?;
        portable_update::write_json(
            &layout.staged_record,
            &StagedRecord {
                version: offer.version.to_string(),
                automatic,
            },
        )
        .map_err(UpdateError::other)
    })();
    let _ = std::fs::remove_dir_all(&layout.download);
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&layout.staging);
    }
    outcome.map(|()| Staged::Portable {
        version: offer.version,
        automatic,
    })
}

// ── Launch and exit ───────────────────────────────────────────────────────

fn take_last_apply(path: &Path) -> Option<LastApplyStatus> {
    let record: LastApply = portable_update::read_json(path)?;
    let _ = std::fs::remove_file(path);
    Some(LastApplyStatus {
        outcome: record.outcome,
        version: record.version,
    })
}

/// What a start finds: the outcome of the last apply, the failed version and
/// the staged update.
#[derive(Debug, Default, PartialEq, Eq)]
struct Restored {
    last: Option<LastApplyStatus>,
    failed: Option<Version>,
    staged: Option<Staged>,
}

fn restore_installed(app: &AppHandle) -> Restored {
    let Ok(state) = state_dir(app) else {
        return Restored::default();
    };
    restore_installed_in(&state)
}

/// A pending run of the failed version is removed with its installer pair,
/// which the fallback path leaves in place after a failed install.
fn restore_installed_in(state: &Path) -> Restored {
    let _ = std::fs::remove_dir_all(state.join("waiter"));
    let _ = std::fs::remove_dir_all(state.join("fallback"));
    let last = take_last_apply(&state.join(system::LAST_APPLY_FILE));
    let failed = settle_failed(&state.join(system::FAILED_FILE), last.as_ref());
    let pending_path = state.join(system::PENDING_RUN_FILE);
    let pending: Option<PendingRun> = portable_update::read_json(&pending_path);
    let Some(pending) = pending else {
        let _ = std::fs::remove_dir_all(state.join("download"));
        return Restored { last, failed, staged: None };
    };
    let version = Version::parse(&pending.version);
    let usable = system::is_run_id(&pending.run_id)
        && version.is_some_and(|v| v > Version::running() && Some(v) != failed)
        && pending.installer.is_file()
        && pending.installer.with_extension("sig").is_file();
    if !usable {
        let _ = std::fs::remove_file(&pending.installer);
        let _ = std::fs::remove_file(pending.installer.with_extension("sig"));
        let _ = std::fs::remove_file(&pending_path);
        let _ = std::fs::remove_dir_all(state.join("download"));
        return Restored { last, failed, staged: None };
    }
    Restored {
        last,
        failed,
        staged: version.map(|version| Staged::Installed {
            run_id: pending.run_id,
            version,
            installer: pending.installer,
            automatic: pending.automatic,
        }),
    }
}

fn restore_portable() -> Restored {
    let Ok(layout) = portable_layout() else {
        return Restored::default();
    };
    restore_portable_in(&layout)
}

/// Clears what an applied or abandoned portable update left. While a swap
/// record stands nothing is removed: the record needs `backup\`, `staged\`
/// and the helper. A rolled-back swap leaves `staged\` whole; it is removed
/// here when its version is the failed one.
fn restore_portable_in(layout: &Layout) -> Restored {
    if layout.swap_record.exists() {
        return Restored {
            failed: failed_version_in(&layout.failed, &layout.last_apply),
            ..Restored::default()
        };
    }
    let running = Version::running().to_string();
    if layout.started_marker(&running).is_file() && !layout.swap_record.exists() {
        let _ = std::fs::remove_dir_all(&layout.backup);
        let _ = std::fs::remove_file(layout.started_marker(&running));
    }
    let _ = std::fs::remove_dir_all(&layout.helper);
    let _ = std::fs::remove_dir_all(&layout.download);
    let _ = std::fs::remove_dir_all(&layout.staging);
    let last = take_last_apply(&layout.last_apply);
    let failed = settle_failed(&layout.failed, last.as_ref());
    let record: Option<StagedRecord> = portable_update::read_json(&layout.staged_record);
    let automatic = record.as_ref().map_or(true, |r| r.automatic);
    let version = record.and_then(|r| Version::parse(&r.version));
    let staged = match version {
        Some(version)
            if version > Version::running()
                && Some(version) != failed
                && layout.staged.join(portable_update::MAIN_EXE).is_file() =>
        {
            Some(Staged::Portable { version, automatic })
        }
        _ => {
            let _ = std::fs::remove_dir_all(&layout.staged);
            let _ = std::fs::remove_file(&layout.staged_record);
            None
        }
    };
    Restored { last, failed, staged }
}

/// Called once from setup: clears what an applied or abandoned update left,
/// reads the outcome of the last apply, and restores a staged update.
pub fn on_launch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<UpdateState>();
        state.refresh_policy();
        let Restored { last, failed, staged } = match state.container() {
            ContainerKind::Installed => restore_installed(&app),
            ContainerKind::Portable => restore_portable(),
            ContainerKind::Unsupported => Restored::default(),
        };
        {
            let mut inner = state.lock();
            inner.last_apply = last;
            inner.failed = failed;
            if let Some(staged) = staged {
                if !inner.working && inner.phase != Phase::Ready {
                    inner.phase = Phase::Ready;
                    inner.version = Some(staged.version());
                    inner.staged = Some(staged);
                }
            }
        }
        publish(&app);
    });
}

fn copy_runner(source: &Path, dir: &Path, name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(name);
    let _ = std::fs::remove_file(&target);
    std::fs::copy(source, &target).map_err(|e| format!("Cannot copy {}: {e}", source.display()))?;
    Ok(target)
}

/// Runs at the final exit, after the quit flow has closed every window. A
/// staged update starts its applier and this process ends; the applier waits
/// for it.
pub fn on_exit(app: &AppHandle) {
    let state = app.state::<UpdateState>();
    let container = state.container();
    let (staged, apply_automatically) = {
        let inner = state.lock();
        (inner.staged.clone(), inner.prefs.apply_automatically)
    };
    let policy = crate::commands::machine_policy_set("DisableAutoUpdate");
    let relaunch = state.relaunch.load(Ordering::SeqCst);
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(instdir) = exe.parent().map(Path::to_path_buf) else {
        return;
    };
    if !apply_at_exit_allowed(policy, container, staged.as_ref().map(Staged::origin), apply_automatically, relaunch) {
        if relaunch_without_applier(false, relaunch) {
            relaunch_now(app, &exe, &instdir);
        }
        return;
    }
    let started = match staged {
        Some(Staged::Installed {
            run_id,
            version,
            installer,
            ..
        }) => state_dir(app).map_err(|e| e.message).and_then(|state_dir| {
            let dir = state_dir.join("waiter").join(&run_id);
            let waiter = copy_runner(&exe, &dir, system::WAITER_EXE)?;
            let args = system::AwaitArgs {
                run_id,
                parent: std::process::id(),
                instdir: instdir.clone(),
                staged: installer,
                version: version.to_string(),
                state_dir,
                relaunch,
            };
            proc::spawn_detached(&waiter, &args.to_args(), &dir)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }),
        Some(Staged::Portable { version, .. }) => {
            let layout = Layout::new(&instdir);
            copy_runner(
                &layout.staged.join(portable_update::MAIN_EXE),
                &layout.helper,
                portable_update::HELPER_EXE,
            )
            .and_then(|helper| {
                let args = cli::HelperArgs {
                    root: instdir.clone(),
                    parent: std::process::id(),
                    version: version.to_string(),
                    relaunch,
                };
                proc::spawn_detached(&helper, &args.to_args(), &layout.helper)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
        }
        None => Ok(()),
    };
    if relaunch_without_applier(started.is_ok(), relaunch) {
        relaunch_now(app, &exe, &instdir);
    }
}

/// Whether the exit restarts the app itself: Restart now was chosen and no
/// applier started that would relaunch it.
pub fn relaunch_without_applier(applier_started: bool, relaunch: bool) -> bool {
    relaunch && !applier_started
}

/// Starts this executable again. The single-instance lock is released first,
/// or the new process would hand its launch to this exiting one.
fn relaunch_now(app: &AppHandle, exe: &Path, dir: &Path) {
    app.cleanup_before_exit();
    let _ = proc::spawn_detached(exe, &[], dir);
}

// ── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn update_configure(app: AppHandle, prefs: Prefs) -> Result<UpdateStatus, UpdateError> {
    let state = app.state::<UpdateState>();
    let first = {
        let mut inner = state.lock();
        inner.prefs = prefs;
        !std::mem::replace(&mut inner.configured, true)
    };
    let policy = state.refresh_policy();
    if first && launch_check_allowed(policy, prefs) {
        let checker = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = check(checker, true).await;
        });
    }
    Ok(state.status())
}

#[tauri::command]
pub async fn update_status(app: AppHandle) -> Result<UpdateStatus, UpdateError> {
    let state = app.state::<UpdateState>();
    state.refresh_policy();
    Ok(state.status())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<CheckResult>, UpdateError> {
    if !manual_check_allowed(app.state::<UpdateState>().refresh_policy()) {
        publish(&app);
        return Err(UpdateError::new(FailureKind::Disabled, "Updates are turned off by policy"));
    }
    check(app, false).await
}

/// `automatic` is true when the renderer prepares on the user's standing
/// preference rather than on an Install click.
#[tauri::command]
pub async fn update_prepare(app: AppHandle, automatic: Option<bool>) -> Result<UpdateStatus, UpdateError> {
    start_prepare(&app, automatic.unwrap_or(false))?;
    Ok(app.state::<UpdateState>().status())
}

/// Records that the quit sealed under `session_id` asked to relaunch into the
/// staged update. Nothing is recorded when no update is staged.
pub fn request_relaunch_for(app: &AppHandle, session_id: u64) {
    let state = app.state::<UpdateState>();
    let staged = state.lock().staged.is_some();
    *state.relaunch_for.lock().unwrap_or_else(|p| p.into_inner()) = staged.then_some(session_id);
}

/// Drops the relaunch request of a cancelled quit.
pub fn forget_relaunch_for(app: &AppHandle, session_id: u64) {
    let state = app.state::<UpdateState>();
    let mut requested = state.relaunch_for.lock().unwrap_or_else(|p| p.into_inner());
    if *requested == Some(session_id) {
        *requested = None;
    }
}

/// Runs in the last window's close once the final exit is certain, just
/// before `QUITTING` is set. The relaunch is armed only for the quit that
/// holds the session seal, and only when the closing window names that quit.
pub fn arm_relaunch_at_exit(app: &AppHandle, closing_for: Option<u64>) {
    let state = app.state::<UpdateState>();
    let requested = *state.relaunch_for.lock().unwrap_or_else(|p| p.into_inner());
    let sealed = app.state::<crate::session::SessionState>().sealed_by();
    state.relaunch.store(relaunch_applies(requested, sealed, closing_for), Ordering::SeqCst);
}

#[tauri::command]
pub async fn update_open_release(app: AppHandle) -> Result<(), UpdateError> {
    crate::commands::open_releases_page(app).await.map_err(UpdateError::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: Prefs = Prefs {
        check_on_launch: true,
        apply_automatically: true,
    };
    const OFF: Prefs = Prefs {
        check_on_launch: false,
        apply_automatically: false,
    };

    #[test]
    fn the_machine_policy_outranks_every_preference_and_every_trigger() {
        for prefs in [ON, OFF] {
            for container in [ContainerKind::Installed, ContainerKind::Portable, ContainerKind::Unsupported] {
                assert!(!launch_check_allowed(true, prefs));
                assert!(!manual_check_allowed(true));
                assert!(!auto_prepare_allowed(true, prefs, container));
                assert!(!prepare_allowed(true, container));
                for origin in [StageOrigin::Clicked, StageOrigin::Automatic] {
                    assert!(!apply_at_exit_allowed(true, container, Some(origin), true, true));
                }
            }
        }
    }

    #[test]
    fn preferences_decide_when_no_policy_is_set() {
        assert!(launch_check_allowed(false, ON));
        assert!(!launch_check_allowed(false, OFF));
        assert!(manual_check_allowed(false));
        assert!(auto_prepare_allowed(false, ON, ContainerKind::Installed));
        assert!(auto_prepare_allowed(false, ON, ContainerKind::Portable));
        assert!(!auto_prepare_allowed(false, OFF, ContainerKind::Installed));
        let check_only = Prefs {
            check_on_launch: true,
            apply_automatically: false,
        };
        assert!(launch_check_allowed(false, check_only));
        assert!(!auto_prepare_allowed(false, check_only, ContainerKind::Installed));
        assert!(prepare_allowed(false, ContainerKind::Installed));
    }

    #[test]
    fn an_unsupported_container_checks_but_never_downloads_or_applies() {
        assert!(launch_check_allowed(false, ON));
        assert!(!auto_prepare_allowed(false, ON, ContainerKind::Unsupported));
        assert!(!prepare_allowed(false, ContainerKind::Unsupported));
        assert!(!apply_at_exit_allowed(false, ContainerKind::Unsupported, Some(StageOrigin::Clicked), true, false));
        assert!(!apply_at_exit_allowed(false, ContainerKind::Installed, None, true, true));
        assert!(apply_at_exit_allowed(false, ContainerKind::Installed, Some(StageOrigin::Clicked), true, false));
    }

    #[test]
    fn an_automatic_stage_waits_once_automatic_install_is_turned_off() {
        let at_exit = |origin, apply_automatically, relaunch| {
            apply_at_exit_allowed(false, ContainerKind::Installed, Some(origin), apply_automatically, relaunch)
        };
        assert!(at_exit(StageOrigin::Automatic, true, false));
        assert!(!at_exit(StageOrigin::Automatic, false, false));
        assert!(at_exit(StageOrigin::Automatic, false, true), "Restart now is a click");
        assert!(at_exit(StageOrigin::Clicked, false, false), "a clicked install still applies");
        let record: PendingRun =
            serde_json::from_str(r#"{"runId":"x","version":"2026.1101.160","installer":"a"}"#).unwrap();
        assert!(record.automatic, "a record without an origin is held back too");
    }

    #[test]
    fn only_the_quit_that_holds_the_seal_relaunches() {
        assert!(relaunch_applies(Some(3), Some(3), Some(3)));
        assert!(!relaunch_applies(Some(3), None, Some(3)), "a cancelled quit lifted its seal");
        assert!(!relaunch_applies(Some(3), Some(4), Some(4)), "a later quit sealed the record");
        assert!(!relaunch_applies(None, Some(3), Some(3)));
        assert!(!relaunch_applies(None, None, None));
        assert!(
            !relaunch_applies(Some(3), Some(3), None),
            "a window created after the quit took its peers closes with no quit id"
        );
        assert!(!relaunch_applies(Some(3), Some(3), Some(2)), "a close for another quit");
    }

    #[test]
    fn the_manifest_supplies_a_strict_release_number_and_signatures_only() {
        let manifest = parse_manifest(include_bytes!("fixtures/latest156.json")).unwrap();
        assert_eq!(manifest.version.to_string(), "2026.1014.156");
        assert!(manifest.signatures.contains_key("windows-x86_64"));
        assert!(manifest.signatures.contains_key("windows-x86_64-nsis"));
        assert!(!manifest.signatures.contains_key("windows-x86_64-portable"));
        for bad in [
            &br#"{"version":"v2026.1014.156"}"#[..],
            br#"{"version":"2026.1014"}"#,
            br#"{"version":2026}"#,
            br#"{}"#,
            b"not json",
        ] {
            assert!(parse_manifest(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn the_status_serializes_in_the_contract_shape() {
        let status = UpdateStatus {
            policy_disabled: false,
            container: ContainerKind::Installed,
            phase: Phase::Downloading,
            version: Some("2026.1101.160".to_string()),
            received: Some(10),
            total: Some(100),
            failure: None,
            last_apply: Some(LastApplyStatus {
                outcome: Outcome::Deferred,
                version: "2026.1101.160".to_string(),
            }),
            failed_version: Some("2026.1031.159".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "policyDisabled": false,
                "container": "installed",
                "phase": "downloading",
                "version": "2026.1101.160",
                "received": 10,
                "total": 100,
                "lastApply": { "outcome": "deferred", "version": "2026.1101.160" },
                "failedVersion": "2026.1031.159"
            })
        );
        let idle = UpdateStatus {
            policy_disabled: true,
            container: ContainerKind::Unsupported,
            phase: Phase::Failed,
            version: None,
            received: None,
            total: None,
            failure: Some(FailureKind::Disabled),
            last_apply: None,
            failed_version: None,
        };
        assert_eq!(
            serde_json::to_value(&idle).unwrap(),
            serde_json::json!({
                "policyDisabled": true,
                "container": "unsupported",
                "phase": "failed",
                "failure": "disabled"
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateError::new(FailureKind::Network, "x")).unwrap(),
            serde_json::json!({ "kind": "network", "message": "x" })
        );
    }

    #[test]
    fn preferences_read_the_renderer_spelling() {
        let prefs: Prefs =
            serde_json::from_str(r#"{"checkOnLaunch":false,"applyAutomatically":true}"#).unwrap();
        assert_eq!(
            prefs,
            Prefs {
                check_on_launch: false,
                apply_automatically: true
            }
        );
    }

    #[test]
    fn the_exit_hook_runs_only_after_the_quit_flow() {
        let lib = include_str!("../lib.rs");
        let exit = &lib[lib.find("if let RunEvent::Exit = &event {").expect("the exit branch")..];
        let hook = exit.find("updates::on_exit(").expect("the update exit hook");
        assert!(exit[..hook].contains("QUITTING.load(Ordering::SeqCst)"));
    }

    #[test]
    fn the_relaunch_is_armed_only_where_the_final_exit_is_certain() {
        let commands = include_str!("../commands.rs");
        let body = |name: &str| {
            let start = commands.find(name).expect(name);
            let end = commands[start + 1..].find("\n#[tauri::command]").map_or(commands.len(), |e| start + 1 + e);
            &commands[start..end]
        };
        let close = body("pub async fn close_window(");
        assert!(close.contains("session_id: Option<u64>"), "the close names the quit it belongs to");
        let arm = "crate::updates::arm_relaunch_at_exit(&app, session_id);";
        assert_eq!(close.matches(arm).count(), 1);
        let armed = close.find(arm).unwrap();
        let quitting = close.find("crate::QUITTING.store(true").expect("the final exit");
        let aborted = close.find("return Ok(CloseOutcome::Aborted);").expect("the aborted teardown");
        assert!(aborted < armed && armed < quitting, "armed after every early return, before the exit");
        let quit = body("pub async fn request_quit(");
        assert!(quit.contains("relaunch: Option<bool>"));
        assert!(quit.contains("crate::updates::request_relaunch_for(&app, session_id);"));
        assert!(body("pub async fn quit_cancelled(").contains("crate::updates::forget_relaunch_for(&app, session_id);"));
        let module = include_str!("mod.rs");
        let tests = module.find("#[cfg(test)]").expect("the tests");
        assert_eq!(module[..tests].matches(".relaunch.store(").count(), 1, "only the exit arms the relaunch");
    }

    #[test]
    fn a_standing_swap_record_keeps_every_portable_update_file() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        for dir in [&layout.helper, &layout.download, &layout.staging, &layout.staged, &layout.backup] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(layout.staged.join(portable_update::MAIN_EXE), "new").unwrap();
        std::fs::write(&layout.staged_record, r#"{"version":"2026.1101.160"}"#).unwrap();
        std::fs::write(layout.started_marker(&Version::running().to_string()), "").unwrap();
        std::fs::write(&layout.swap_record, "{}").unwrap();
        assert_eq!(restore_portable_in(&layout), Restored::default());
        for path in [&layout.helper, &layout.download, &layout.staging, &layout.staged, &layout.backup, &layout.staged_record] {
            assert!(path.exists(), "{} was removed", path.display());
        }
        let module = include_str!("mod.rs");
        let prepare = &module[module.find("async fn prepare_portable(").unwrap()..];
        let guard = prepare.find("if layout.swap_record.exists() {").expect("the prepare guard");
        assert!(guard < prepare.find("remove_dir_all").unwrap(), "the guard runs before any removal");
    }

    #[test]
    fn restart_now_restarts_the_app_when_no_applier_starts() {
        assert!(relaunch_without_applier(false, true));
        assert!(!relaunch_without_applier(true, true), "the applier relaunches");
        assert!(!relaunch_without_applier(false, false));
        let module = include_str!("mod.rs");
        let exit = &module[module.find("pub fn on_exit(").unwrap()..module.find("pub fn relaunch_without_applier(").unwrap()];
        assert!(exit.contains("if relaunch_without_applier(started.is_ok(), relaunch) {"));
        assert!(!exit.contains("return;
            };
            let args"), "a failed copy falls through to the restart");
    }

    const FAILED_V: &str = "2026.1101.160";
    const NEWER_V: &str = "2026.1108.161";

    fn last_apply(path: &Path, outcome: Outcome, version: &str) {
        portable_update::write_json(
            path,
            &LastApply {
                run_id: String::new(),
                outcome,
                version: version.to_string(),
            },
        )
        .unwrap();
    }

    fn staged_portable(version: &str) -> (tempfile::TempDir, Layout) {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        std::fs::create_dir_all(&layout.staged).unwrap();
        std::fs::write(layout.staged.join(portable_update::MAIN_EXE), "new").unwrap();
        portable_update::write_json(
            &layout.staged_record,
            &StagedRecord {
                version: version.to_string(),
                automatic: true,
            },
        )
        .unwrap();
        (temp, layout)
    }

    #[test]
    fn a_failed_portable_apply_is_recorded_once_and_its_stage_is_removed() {
        let (_temp, layout) = staged_portable(FAILED_V);
        last_apply(&layout.last_apply, Outcome::Failed, FAILED_V);
        let first = restore_portable_in(&layout);
        assert_eq!(first.last.map(|l| l.outcome), Some(Outcome::Failed));
        assert_eq!(first.failed, Version::parse(FAILED_V));
        assert_eq!(first.staged, None, "the failed version is not applied at the next exit");
        assert!(!layout.staged.exists() && !layout.staged_record.exists());
        let second = restore_portable_in(&layout);
        assert_eq!(second.last, None, "the failure is reported once");
        assert_eq!(second.failed, Version::parse(FAILED_V), "the record survives later starts");
    }

    #[test]
    fn a_deferred_portable_apply_stays_staged_for_the_next_exit() {
        let (_temp, layout) = staged_portable(FAILED_V);
        last_apply(&layout.last_apply, Outcome::Deferred, FAILED_V);
        let restored = restore_portable_in(&layout);
        assert_eq!(restored.failed, None);
        assert!(matches!(restored.staged, Some(Staged::Portable { version, .. }) if Some(version) == Version::parse(FAILED_V)));
    }

    #[test]
    fn a_version_newer_than_the_failed_one_stays_staged() {
        let (_temp, layout) = staged_portable(NEWER_V);
        portable_update::write_json(&layout.failed, &FailedRecord { version: FAILED_V.to_string() }).unwrap();
        let restored = restore_portable_in(&layout);
        assert_eq!(restored.failed, Version::parse(FAILED_V));
        assert!(matches!(restored.staged, Some(Staged::Portable { version, .. }) if Some(version) == Version::parse(NEWER_V)));
    }

    fn pending_installed(state: &Path, version: &str) -> PathBuf {
        let download = state.join("download");
        std::fs::create_dir_all(&download).unwrap();
        let run_id = system::new_run_id();
        let installer = download.join(format!("{run_id}.exe"));
        std::fs::write(&installer, "installer").unwrap();
        std::fs::write(installer.with_extension("sig"), "sig").unwrap();
        portable_update::write_json(
            &state.join(system::PENDING_RUN_FILE),
            &PendingRun {
                run_id,
                version: version.to_string(),
                installer: installer.clone(),
                automatic: true,
            },
        )
        .unwrap();
        installer
    }

    #[test]
    fn a_failed_system_install_removes_its_pending_run_and_installer_pair() {
        let temp = tempfile::tempdir().unwrap();
        let installer = pending_installed(temp.path(), FAILED_V);
        last_apply(&temp.path().join(system::LAST_APPLY_FILE), Outcome::Failed, FAILED_V);
        let first = restore_installed_in(temp.path());
        assert_eq!(first.last.map(|l| l.outcome), Some(Outcome::Failed));
        assert_eq!(first.failed, Version::parse(FAILED_V));
        assert_eq!(first.staged, None);
        assert!(!installer.exists() && !installer.with_extension("sig").exists());
        assert!(!temp.path().join(system::PENDING_RUN_FILE).exists());
        let second = restore_installed_in(temp.path());
        assert_eq!(second.last, None);
        assert_eq!(second.failed, Version::parse(FAILED_V));
    }

    #[test]
    fn a_deferred_system_install_stays_pending_for_the_next_exit() {
        let temp = tempfile::tempdir().unwrap();
        let installer = pending_installed(temp.path(), FAILED_V);
        last_apply(&temp.path().join(system::LAST_APPLY_FILE), Outcome::Deferred, FAILED_V);
        let restored = restore_installed_in(temp.path());
        assert_eq!(restored.failed, None);
        assert!(matches!(restored.staged, Some(Staged::Installed { installer: ref i, .. }) if *i == installer));
    }

    #[test]
    fn only_an_install_click_prepares_the_failed_version() {
        let failed = Version::parse(FAILED_V);
        let newer = Version::parse(NEWER_V).unwrap();
        assert!(prepare_skipped(true, failed, failed.unwrap()));
        assert!(!prepare_skipped(false, failed, failed.unwrap()), "a click retries");
        assert!(!prepare_skipped(true, failed, newer), "a newer version prepares normally");
        assert!(!prepare_skipped(true, None, newer));

        let temp = tempfile::tempdir().unwrap();
        let record = temp.path().join(system::FAILED_FILE);
        let last = temp.path().join(system::LAST_APPLY_FILE);
        last_apply(&last, Outcome::Failed, FAILED_V);
        assert_eq!(failed_version_in(&record, &last), failed, "an unread failure already counts");
        std::fs::remove_file(&last).unwrap();
        portable_update::write_json(&record, &FailedRecord { version: FAILED_V.to_string() }).unwrap();
        release_failed_in(&record, newer);
        assert_eq!(failed_version_in(&record, &last), failed, "another version keeps the record");
        release_failed_in(&record, failed.unwrap());
        assert_eq!(failed_version_in(&record, &last), None, "a clicked stage lifts the record");

        portable_update::write_json(&record, &FailedRecord { version: Version::running().to_string() }).unwrap();
        assert_eq!(settle_failed(&record, None), None);
        assert!(!record.exists(), "a record no newer than the running version is removed");
    }

    #[test]
    fn every_update_command_is_registered() {
        let lib = include_str!("../lib.rs");
        for command in [
            "updates::update_configure,",
            "updates::update_status,",
            "updates::update_check,",
            "updates::update_prepare,",
            "updates::update_open_release,",
        ] {
            assert!(lib.contains(command), "{command} is not registered");
        }
        assert!(lib.contains(".manage(updates::UpdateState::new())"));
        assert!(!lib.contains("updates::update_restart"), "no command arms a relaunch on its own");
    }
}
