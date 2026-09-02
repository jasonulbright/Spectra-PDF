"""Clean-runner guards for optional capabilities used by engine tests."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import conftest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ("ci.yml", "release.yml")


def _git(*args: str, cwd: Path = ROOT) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout

#: Every capability axis a test may skip on, mapped to the command that stages
#: it on a clean runner. An axis is declared by a module-level `*_AXIS_SKIP`
#: constant in a `tests/` helper module; the discovery test below refuses an
#: axis that is not registered here, so a new axis cannot reach CI without its
#: provisioning. The zero-skip gate is what makes that mandatory: an axis with
#: nothing staging it does not skip quietly, it reds the whole run.
AXIS_PROVISIONING = {
    ("gs_axis", "PRESENT_AXIS_SKIP"):
        "powershell -ExecutionPolicy Bypass -File "
        "scripts/install-ghostscript-test-tool.ps1",
    ("ghent_corpus", "CORPUS_AXIS_SKIP"): "python scripts/fetch-ghent-suite.py --check",
    ("processing_steps_corpus", "PROCESSING_STEPS_AXIS_SKIP"):
        "python scripts/fetch-processing-steps-suite.py --check",
    ("pdfa_conformance_corpus", "PDFA_CORPUS_AXIS_SKIP"):
        "python scripts/fetch-pdfa-corpus.py --check",
}

#: Every fetched corpus staged the same way: an actions/cache step keyed on
#: the fetch SCRIPT (which is where the archive digests are pinned), a fetch
#: guarded by the cache miss, and an unconditional `--check`. One table so a
#: new corpus cannot arrive with half the pattern.
CACHED_CORPORA = (
    ("ghent-cache", "ghent-corpus", "scripts/fetch-ghent-suite.py"),
    ("processing-steps-cache", "processing-steps-corpus",
     "scripts/fetch-processing-steps-suite.py"),
    ("pdfa-corpus-cache", "pdfa-corpus", "scripts/fetch-pdfa-corpus.py"),
)


#: Vendored runtimes fetched as one large pinned archive rather than as a
#: corpus: the workflow caches the archive itself and the bundle script does
#: the verifying. Keyed on the bundle SCRIPT because that file carries both the
#: version and the SHA-256. Same shape as CACHED_CORPORA, different unit — a
#: runtime has no `--check`, its notice gate runs inside the script.
CACHED_RUNTIME_ARCHIVES = (
    ("libreoffice-msi", ".lo-msi-cache", "scripts/bundle-libreoffice.ps1",
     "SPECTRAPDF_LO_MSI_CACHE"),
)


def _axis_constants() -> set[tuple[str, str]]:
    """Every `*_AXIS_SKIP` constant defined by a tests/ helper module."""
    found: set[tuple[str, str]] = set()
    for path in sorted((ROOT / "tests").glob("*.py")):
        if path.name.startswith("test_"):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            targets = (
                node.targets
                if isinstance(node, ast.Assign)
                else [node.target] if isinstance(node, ast.AnnAssign)
                else []
            )
            for target in targets:
                if isinstance(target, ast.Name) and target.id.endswith("AXIS_SKIP"):
                    found.add((path.stem, target.id))
    return found


def _assert_capabilities_precede_engine_tests(workflow: str) -> None:
    text = (ROOT / ".github" / "workflows" / workflow).read_text()
    engine_test = text.index("python -m pytest tests/ -q")

    for resource_step in (
        "scripts/bundle-icc.ps1",
        "scripts/sync-edit-fonts.ps1",
        "scripts/bundle-libreoffice.ps1",
        "scripts/bundle-tesseract.ps1",
        "scripts/bundle-jbig2enc.ps1",
        "scripts/bundle-dictionaries.ps1",
        "scripts/bundle-voikko.ps1",
        "scripts/sync-ocr-assets.mjs",
        "scripts/setup-test-softhsm.ps1",
    ):
        assert text.index(resource_step) < engine_test
    install = text.index("scripts/install-ghostscript-test-tool.ps1")
    export = text.index("SPECTRAPDF_GS_PATH=")
    # The path export reads what the install produced, so the order is part of
    # the contract: exporting first would publish a stale or absent executable.
    assert install < export < engine_test
    # A failed install attempt can leave a version directory behind, so the
    # export selects the newest rather than requiring exactly one.
    assert (
        "Sort-Object { [version]($_.Directory.Parent.Name -replace '^gs', '') }"
        " -Descending"
    ) in text
    assert text.index("SPECTRAPDF_REQUIRE_ZERO_SKIPS") > engine_test
    for command in AXIS_PROVISIONING.values():
        assert text.index(command) < engine_test


def test_every_skip_axis_is_registered_with_its_provisioning() -> None:
    assert _axis_constants() == set(AXIS_PROVISIONING)


@pytest.mark.parametrize("workflow", WORKFLOWS)
@pytest.mark.parametrize("cache_id,path,script", CACHED_CORPORA)
def test_each_corpus_fetch_is_cached_on_its_pins(
    workflow: str, cache_id: str, path: str, script: str
) -> None:
    """The fetch hits GWG's server on a pin change, not once per run.

    The key is the fetch script because that file IS the pin: the archive
    digests live in its `SOURCES`. A cache hit skips only the download —
    `--check` runs unconditionally, so a truncated restore fails the job
    rather than presenting as an absent corpus (which would be a skip).
    """
    text = (ROOT / ".github" / "workflows" / workflow).read_text()
    cache = text.index(f"id: {cache_id}")
    fetch = text.index(f"run: python {script}\n")
    check = text.index(f"run: python {script} --check")

    assert f"hashFiles('{script}')" in text
    assert f"path: {path}" in text
    assert cache < fetch < check
    guard = text.index(f"if: steps.{cache_id}.outputs.cache-hit != 'true'")
    assert cache < guard < check
    assert text[fetch:check].count("cache-hit") == 0


@pytest.mark.parametrize("workflow", WORKFLOWS)
@pytest.mark.parametrize("cache_id,path,script,env_var", CACHED_RUNTIME_ARCHIVES)
def test_each_cached_runtime_archive_precedes_every_use_of_its_script(
    workflow: str, cache_id: str, path: str, script: str, env_var: str
) -> None:
    """Every invocation of the bundle script gets the cache, not just the first.

    release.yml runs the LibreOffice staging twice (verification job, build
    job); a cache wired into only one of them leaves the 373 MB download on
    the path that a tag release actually depends on.
    """
    text = (ROOT / ".github" / "workflows" / workflow).read_text()
    assert f"hashFiles('{script}')" in text
    assert f"path: {path}" in text

    runs = [i for i in range(len(text)) if text.startswith(f"-File {script}", i)]
    assert runs, f"{workflow} never runs {script}"
    caches = [i for i in range(len(text)) if text.startswith(f"id: {cache_id}", i)]
    envs = [i for i in range(len(text)) if text.startswith(f"{env_var}: {path}", i)]
    assert len(caches) == len(runs)
    assert len(envs) == len(runs)
    for cache, run, env in zip(caches, runs, envs):
        assert cache < run < env


def test_the_libreoffice_download_falls_back_across_tdf_hosts() -> None:
    """A named mirror leads; the redirector is one host and can be down whole.

    A redirector outage failed a release publish and a CI run inside one hour
    while the named osuosl mirror kept serving, so the order below is the
    contract: named host first, redirector second, archive last. Trust does not
    rest on any of them: the pinned checksum is verified before extraction.
    """
    text = (ROOT / "scripts" / "bundle-libreoffice.ps1").read_text()
    hosts = (
        "ftp.osuosl.org/pub/tdf/libreoffice/stable/",
        "download.documentfoundation.org/libreoffice/stable/",
        "downloadarchive.documentfoundation.org/libreoffice/old/",
    )
    positions = []
    for host in hosts:
        assert host in text
        positions.append(text.index(f"https://{host}"))
    assert positions == sorted(positions), (
        "the download sources must be ordered: " + ", ".join(hosts)
    )
    assert '$ExpectedSha256 = "F15BA07BFCB0186986CF3171063506F5D207C11F8CC051BA0D135209E9E915F9"' in text
    # The verify gates extraction regardless of which source or cache answered.
    assert text.index("Test-PinnedMsi $Msi") < text.index("msiexec.exe")


REDO_VERIFIER_STEP = "Check out the verifier tooling from the workflow's revision"
REDO_REGIME_STEP = "Select the engine payload verification regime from the tag's tree"
REDO_LEGACY_ENGINE_STEP = (
    "Engine payload matches the tag's engine tree (legacy, pre-manifest tag)"
)
ENGINE_MANIFEST = "src/engine/PAYLOAD-MANIFEST.tsv"


def test_the_redo_publisher_takes_product_bytes_from_the_tag() -> None:
    """The redo workflow may overlay download tooling and nothing else.

    It exists so a dead pinned vendor host can be routed around without moving
    or re-cutting a tag. That is only sound while the ONLY file it takes from
    main is the vendor download script, whose archive SHA-256 is pinned inside
    it: any other overlaid file would publish, under the tag's version, code
    the tag does not contain.
    """
    text = (ROOT / ".github" / "workflows" / "release-redo.yml").read_text()
    assert "ref: refs/tags/${{ inputs.tag }}" in text
    overlays = [
        line.strip()
        for line in text.splitlines()
        if "git checkout origin/main --" in line
    ]
    assert overlays == ["git checkout origin/main -- scripts/bundle-libreoffice.ps1"]
    assert "permissions:\n  contents: write" in text
    # The publish steps address the dispatched tag, never a ref the run is on.
    assert "github.ref_name" not in text
    # Verifier tooling is the one other source, checked out beside the tag
    # from the revision the workflow runs at, and it is read, never bundled.
    verifier = dict(_job_steps("release-redo.yml", "release"))[REDO_VERIFIER_STEP]
    assert "ref: ${{ github.sha }}" in verifier
    assert "path: verifier" in verifier
    # Scripts and the Rust test sources only: the draft verifier compiles the
    # updater manifest check into the TAG's package, so the plugin version the
    # tag's binary pins is the one that parses the manifest.
    assert "sparse-checkout: |\n            scripts\n            src-tauri/tests\n" in verifier
    assert "verifier" not in (ROOT / "src-tauri" / "tauri.conf.json").read_text()


#: The publishers: (workflow, job) pairs whose last step is the only one that
#: makes a release public. Both must carry the same gates in the same order.
PUBLISHER_JOBS = (("release.yml", "release"), ("release-redo.yml", "release"))

#: Every gate that runs against the built and uploaded assets, in the order
#: the job runs them. All of them precede the publish step. The redo carries
#: one more: the legacy engine gate for a tag that predates the manifest.
RELEASE_VERIFICATION_STEPS = {
    "release.yml": (
        "Verify the portable tree against the installer's staging",
        "Portable payload notice map covers every declared resource",
        "Engine payload manifest is current",
        "Engine payload matches its manifest",
        "Shipped renderer carries no test harness",
        "Verify the draft's assets and updater manifest",
    ),
    "release-redo.yml": (
        "Verify the portable tree against the installer's staging",
        "Portable payload notice map covers every declared resource",
        "Engine payload manifest is current",
        "Engine payload matches its manifest",
        REDO_LEGACY_ENGINE_STEP,
        "Shipped renderer carries no test harness",
        "Verify the draft's assets and updater manifest",
    ),
}

#: The payload gates: step name and the exact command, so a workflow cannot
#: keep the name and drop the run. release.yml runs the checkout's own copy
#: (mirrored in scripts/ci-parity-gates.sh); the redo runs the WORKFLOW's copy
#: from `verifier/` against the tag checkout, because the tag may predate the
#: script.
RELEASE_PAYLOAD_GATES = {
    "release.yml": (
        ("Engine payload manifest is current",
         "python scripts/gen-engine-payload-manifest.py --check"),
        ("Engine payload matches its manifest", "python scripts/check-engine-payload.py"),
        ("Shipped renderer carries no test harness",
         "python scripts/check-release-bundle.py"),
    ),
    "release-redo.yml": (
        ("Engine payload manifest is current",
         "python verifier/scripts/gen-engine-payload-manifest.py --root . --check"),
        ("Engine payload matches its manifest",
         "python verifier/scripts/check-engine-payload.py --root ."),
        (REDO_LEGACY_ENGINE_STEP,
         "python verifier/scripts/check-engine-payload.py --root . --legacy-rev HEAD"),
        ("Shipped renderer carries no test harness",
         'python verifier/scripts/check-release-bundle.py "$GITHUB_WORKSPACE/dist/renderer"'),
    ),
}

RELEASE_DRAFT_STEP = "Build, sign, and upload to a draft release"
RELEASE_PUBLISH_STEP = "Publish the release"
RELEASE_VERIFY_DRAFT_STEP = "Verify the draft's assets and updater manifest"
DRAFT_VERIFIER = "scripts/verify-release-draft.ps1"


def _job_steps(workflow: str, job: str) -> list[tuple[str, str]]:
    """(name, text) of each step of `job`, in file order.

    The workflows are read as text, not YAML: the release verifier installs
    only pytest beside the shipped requirement set, which carries no YAML
    parser, and the step layout is the two-space convention every workflow
    in this repository follows.
    """
    lines = (ROOT / ".github" / "workflows" / workflow).read_text().splitlines()
    start = lines.index(f"  {job}:")
    body: list[str] = []
    for line in lines[start + 1:]:
        if line and not line.startswith(" "):
            break
        if line.startswith("  ") and not line.startswith("   "):
            break
        body.append(line)
    steps_at = body.index("    steps:")
    steps: list[list[str]] = []
    for line in body[steps_at + 1:]:
        if line.startswith("      - "):
            steps.append([line])
        elif steps:
            steps[-1].append(line)
    named: list[tuple[str, str]] = []
    for step in steps:
        text = "\n".join(step)
        names = [
            line.split("name:", 1)[1].strip()
            for line in step
            if line.startswith("      - name:") or line.startswith("        name:")
        ]
        named.append((names[0] if names else "", text))
    return named


@pytest.mark.parametrize("workflow,job", PUBLISHER_JOBS)
def test_the_publish_step_is_last_and_every_verification_precedes_it(
    workflow: str, job: str
) -> None:
    """Assets are built and uploaded to a DRAFT; undrafting is the final step.

    A non-draft publish followed by verification leaves a public installer
    when a gate fails. With this order a failing gate leaves a draft nobody
    can download, and the remedy is forward-only from there.
    """
    steps = _job_steps(workflow, job)
    names = [name for name, _ in steps]
    assert names[-1] == RELEASE_PUBLISH_STEP
    publish = len(names) - 1
    draft = names.index(RELEASE_DRAFT_STEP)
    for gate in RELEASE_VERIFICATION_STEPS[workflow]:
        assert draft < names.index(gate) < publish, (workflow, gate)
    uploads = [i for i, name in enumerate(names) if name.startswith("Upload ")]
    assert uploads, workflow
    # Every upload lands before the read-back verification of the draft.
    verify = names.index(RELEASE_VERIFY_DRAFT_STEP)
    assert max(uploads) < verify
    assert all(draft < i for i in uploads)
    # The read-back is a download-and-hash of every uploaded asset, and it is
    # the last gate before the publish: a same-length wrong upload must fail
    # here or it ships.
    assert verify == publish - 1
    text = dict(steps)[RELEASE_VERIFY_DRAFT_STEP]
    assert DRAFT_VERIFIER in text and "-ReleaseId $env:RELEASE_ID" in text


def test_the_draft_verifier_hashes_the_bytes_github_holds() -> None:
    text = (ROOT / DRAFT_VERIFIER).read_text()
    assert "is already public before verification" in text
    download = text.index('"https://api.github.com/repos/$Repo/releases/assets/$($asset.id)"')
    assert "curl.exe --fail" in text[download:download + 400]
    assert '-H "Accept: application/octet-stream"' in text
    # The hash under comparison is the DOWNLOADED file's, and it is compared
    # against the local build, the downloaded checksum file, and the manifest.
    hashed = text.index("(Get-Sha256 $target)")
    assert download < hashed
    assert "uploaded bytes differ from the built file" in text[hashed:]
    assert "SHA256SUMS.txt is wrong for" in text[hashed:]
    assert "latest.json signature is not the uploaded installer's .sig" in text[hashed:]
    # Never a PowerShell redirection of a native command: it re-encodes bytes.
    assert re.search(r"gh api[^\n]*>\s*\$", text) is None


UPDATER_MANIFEST_TEST = "src-tauri/tests/updater_manifest.rs"
#: The prefix of the integration-test target the draft verifier stages its
#: own copy of UPDATER_MANIFEST_TEST under (`verifier_<16 hex>_updater_manifest`,
#: fresh per run), in whichever package it verifies. Reserved to the verifier:
#: a product revision never commits a file under this prefix, and the verifier
#: refuses a package whose manifest names one, so a tag can never supply the
#: logic that judges its manifest -- and, the name being unpredictable, can
#: never declare a `[[test]]` that claims it.
VERIFIER_TEST_PREFIX = "verifier_"
VERIFIER_TEST_IGNORE = f"src-tauri/tests/{VERIFIER_TEST_PREFIX}*"


def test_the_draft_verifier_parses_the_manifest_with_the_updaters_deserializer() -> None:
    """The manifest's final reader is the pinned plugin's `RemoteRelease`.

    The script's own checks are re-implementations and can only ever agree
    with the plugin by accident; the parse that decides whether every
    installed copy can read the release is the plugin's, so the gate runs it.
    """
    text = (ROOT / DRAFT_VERIFIER).read_text()
    assert "cargo test --manifest-path" in text
    assert f'$verifierPrefix = "{VERIFIER_TEST_PREFIX}"' in text
    assert '$verifierTest = "${verifierPrefix}${nonce}_updater_manifest"' in text
    assert "--test $verifierTest -- verifies_the_manifest_named_by_the_environment" in text
    rust = (ROOT / UPDATER_MANIFEST_TEST).read_text()
    assert "use tauri_plugin_updater::{RemoteRelease, RemoteReleaseInner};" in rust
    assert "serde_json::from_str(manifest)" in rust
    for env_var in (
        "SPECTRAPDF_UPDATER_MANIFEST", "SPECTRAPDF_UPDATER_VERSION",
        "SPECTRAPDF_UPDATER_NOTES_FILE", "SPECTRAPDF_UPDATER_PLATFORMS",
        "SPECTRAPDF_UPDATER_URL", "SPECTRAPDF_UPDATER_SIGNATURE_FILE",
    ):
        assert f'"{env_var}"' in rust, env_var
        assert f"$env:{env_var} = " in text, env_var


def test_the_draft_verifier_never_selects_its_logic_from_the_verified_package() -> None:
    """Verifier code is staged from the verifier's revision on every run.

    The redo runs the script from `verifier/` against a TAG's package. An
    existence check on the package's tests/ would let a tag's own stale or
    accepting `updater_manifest.rs` stand in for the current verifier. The
    script therefore copies its sibling source under a fresh name in the
    reserved prefix unconditionally, hashes the staged bytes against the
    source, proves through cargo's own resolution that the target of that
    name IS the staged file, runs exactly that target, checks the path cargo
    reports having run, and removes the file after.
    """
    text = (ROOT / DRAFT_VERIFIER).read_text()
    staging = text[text.index('$verifierPrefix = "'):]
    assert "RandomNumberGenerator]::GetBytes(8)" in staging
    assert "Copy-Item -LiteralPath $testSource -Destination $testTarget -Force" in staging
    # No presence test guards the copy: the only Test-Path in the staging
    # block is the one that requires the verifier's own source to exist.
    assert staging.count("Test-Path") == 1
    assert "if (-not (Test-Path -LiteralPath $testSource))" in staging
    copy = staging.index("Copy-Item")
    assert "$stagedSha = Get-Sha256 $testTarget" in staging[copy:]
    assert "is not the verifier's source" in staging[copy:]
    # The resolution proof sits between the hash and the run.
    metadata = staging.index("cargo metadata --no-deps --format-version 1 --manifest-path $packageManifest", copy)
    run = staging.index("cargo test --manifest-path $packageManifest --test $verifierTest", metadata)
    proof = staging[metadata:run]
    assert "Test-OrdinalEqual ([string]$_.name) $verifierTest" in proof
    assert "not the staged $stagedPath" in proof
    assert "autotests\\s*=\\s*false" in staging[copy:metadata]
    assert "under the reserved '$verifierPrefix' prefix" in staging[copy:run]
    assert "'^\\s*Running (.+?\\.rs) \\('" in staging[run:]
    assert "not the staged verifier $stagedPath" in staging[run:]
    assert "Remove-Item -LiteralPath $testTarget" in staging[run:]
    # The package's conventionally named test is never named as a target.
    assert "--test updater_manifest" not in text


def test_the_verifier_test_target_prefix_is_reserved() -> None:
    """No product revision may commit a file under the verifier's prefix.

    The verifier refuses a package whose manifest or tests/ carries any
    target under the prefix, so a tracked file there is a contract breach
    that would fail every release, not a product test. The working tree is
    excluded by .gitignore for the same reason.
    """
    tracked = _git("ls-files", "--", "src-tauri/tests").split()
    assert not [
        path for path in tracked
        if path.removeprefix("src-tauri/tests/").startswith(VERIFIER_TEST_PREFIX)
    ]
    assert VERIFIER_TEST_IGNORE in (ROOT / ".gitignore").read_text().splitlines()
    for staged in (
        f"src-tauri/tests/{VERIFIER_TEST_PREFIX}0123456789abcdef_updater_manifest.rs",
        f"src-tauri/tests/{VERIFIER_TEST_PREFIX}updater_manifest.rs",
    ):
        ignored = subprocess.run(
            ["git", "check-ignore", "-q", staged], cwd=ROOT, capture_output=True,
        )
        assert ignored.returncode == 0, staged


@pytest.mark.parametrize("workflow,job", PUBLISHER_JOBS)
def test_every_publisher_runs_the_verifier_target(workflow: str, job: str) -> None:
    """Both publishers run the draft verifier, which runs the reserved target.

    The ordinary release runs the checkout's own script; the redo runs the
    workflow revision's from `verifier/`. Either way the manifest is judged
    by the staged verifier target, after every upload and before the publish
    (test_the_publish_step_is_last_and_every_verification_precedes_it holds
    the order).
    """
    steps = dict(_job_steps(workflow, job))
    verify = steps[RELEASE_VERIFY_DRAFT_STEP]
    expected = "verifier/" + DRAFT_VERIFIER if workflow == "release-redo.yml" else DRAFT_VERIFIER
    assert f"-File {expected} " in verify, (workflow, verify)
    # The redo's sparse checkout must deliver the verifier's Rust source.
    if workflow == "release-redo.yml":
        checkout = steps[REDO_VERIFIER_STEP]
        assert "src-tauri/tests" in checkout
    # No workflow step runs the target directly: the script is the only
    # caller, so the staging and hash check cannot be bypassed.
    for name, text in steps.items():
        assert f"--test {VERIFIER_TEST_PREFIX}" not in text, (workflow, name)


@pytest.mark.parametrize("workflow,job", PUBLISHER_JOBS)
def test_the_rust_toolchain_precedes_the_draft_verifier(workflow: str, job: str) -> None:
    steps = _job_steps(workflow, job)
    names = [name for name, _ in steps]
    toolchain = [i for i, (_n, t) in enumerate(steps) if "dtolnay/rust-toolchain@stable" in t]
    assert toolchain and max(toolchain) < names.index(RELEASE_VERIFY_DRAFT_STEP), (workflow, job)


@pytest.mark.parametrize("workflow,job", PUBLISHER_JOBS)
def test_the_release_is_a_draft_until_the_publish_step(workflow: str, job: str) -> None:
    steps = dict(_job_steps(workflow, job))
    draft = steps[RELEASE_DRAFT_STEP]
    assert "uses: tauri-apps/tauri-action@v1" in draft
    assert "releaseDraft: true" in draft
    assert "id: draft" in draft
    publish = steps[RELEASE_PUBLISH_STEP]
    assert "-F draft=false" in publish
    # No other step undrafts, and no upload addresses a release by tag: a
    # draft has no tag ref, so a tag-addressed upload could land on a public
    # release for the same tag.
    for name, text in steps.items():
        if name != RELEASE_PUBLISH_STEP:
            assert "draft=false" not in text, (workflow, name)
        if name.startswith("Upload "):
            assert "steps.draft.outputs.releaseId" in text, (workflow, name)
            assert "gh release upload" not in text, (workflow, name)
    verify = steps[RELEASE_VERIFY_DRAFT_STEP]
    assert "steps.draft.outputs.releaseId" in verify
    assert "steps.draft.outputs.releaseId" in publish


@pytest.mark.parametrize(
    "workflow,job,name,command",
    [(w, j, n, c) for w, j in PUBLISHER_JOBS for n, c in RELEASE_PAYLOAD_GATES[w]],
)
def test_both_payload_gates_run_in_every_publisher(
    workflow: str, job: str, name: str, command: str
) -> None:
    steps = dict(_job_steps(workflow, job))
    assert f"run: {command}" in steps[name], (workflow, name)


def test_the_payload_gates_are_mirrored_locally() -> None:
    text = (ROOT / "scripts" / "ci-parity-gates.sh").read_text()
    for _name, command in RELEASE_PAYLOAD_GATES["release.yml"]:
        assert command.removeprefix("python ") in text
    assert "build-portable-zip.ps1 -CheckMap" in text
    assert "tests/test_ci_capability_setup.py" in text
    assert f"{LIVE_CLI_ENV}=1 cargo test --test cli_bytecode" in text
    # The updater manifest parse runs locally against the tracked fixture, in
    # the env-driven mode the draft verifier uses.
    assert "SPECTRAPDF_UPDATER_MANIFEST=tests/fixtures/updater-manifest/latest.json" in text
    assert "cargo test --test updater_manifest" in text


LIVE_CLI_ENV = "SPECTRAPDF_REQUIRE_LIVE_CLI"
LIVE_CLI_STEP = "Live CLI leaves no bytecode in the engine payload (provisioned runtime)"


@pytest.mark.parametrize(
    "workflow,job,provisioner",
    [
        ("ci.yml", "test-engine", "scripts/setup-python-embed.ps1"),
        ("release.yml", "release", "scripts/setup-python-embed.ps1"),
    ],
)
def test_the_live_cli_test_runs_against_a_provisioned_runtime(
    workflow: str, job: str, provisioner: str
) -> None:
    """The bytecode regression test may skip on a developer checkout only.

    Every automatic gate that has the embedded runtime sets the env that
    turns absence into a failure, after the step that vendors the runtime,
    so a removal of the interpreter's no-bytecode setup cannot stay green.
    """
    steps = _job_steps(workflow, job)
    names = [name for name, _ in steps]
    live = names.index(LIVE_CLI_STEP)
    provisioned = [i for i, (_n, t) in enumerate(steps) if provisioner in t]
    assert provisioned and max(provisioned) < live, (workflow, job)
    text = dict(steps)[LIVE_CLI_STEP]
    assert "cargo test --test cli_bytecode" in text
    assert f'{LIVE_CLI_ENV}: "1"' in text
    rust = (ROOT / "src-tauri" / "tests" / "cli_bytecode.rs").read_text()
    assert f'const REQUIRE_LIVE: &str = "{LIVE_CLI_ENV}";' in rust
    assert "std::env::var_os(REQUIRE_LIVE)" in rust


@pytest.mark.parametrize(
    "workflow,job",
    [("ci.yml", "lint-and-build"), ("release.yml", "verify")],
)
def test_the_stub_only_rust_runs_do_not_claim_a_live_cli(workflow: str, job: str) -> None:
    steps = _job_steps(workflow, job)
    names = [name for name, _ in steps]
    stubs = names.index("Create resource stubs for Tauri build script")
    assert stubs < names.index("Rust tests")
    assert LIVE_CLI_ENV not in "\n".join(t for _n, t in steps)


def _released_tags(count: int) -> list[str]:
    tags = [
        t for t in _git("tag", "--sort=-v:refname").split()
        if re.fullmatch(r"v\d+\.\d+\.\d+", t)
    ]
    assert len(tags) >= count, "the repository carries fewer released tags than expected"
    return tags[:count]


def _tag_has(tag: str, path: str) -> bool:
    return subprocess.run(
        ["git", "cat-file", "-e", f"{tag}:{path}"], cwd=ROOT, capture_output=True
    ).returncode == 0


def _redo_regime(tag: str) -> str:
    """The selection the redo's regime step makes, from the tag's tree."""
    return "manifest" if _tag_has(tag, ENGINE_MANIFEST) else "legacy"


def _redo_script_references() -> list[tuple[str, str, str]]:
    """(step name, condition, script path) for every script a redo step runs."""
    refs = []
    for name, text in _job_steps("release-redo.yml", "release"):
        cond = ""
        for line in text.splitlines():
            if line.strip().startswith("if: "):
                cond = line.split("if:", 1)[1].strip()
        for match in re.finditer(r"(?<![\w/])((?:verifier/)?scripts/[\w.-]+)", text):
            refs.append((name, cond, match.group(1)))
    return refs


@pytest.mark.parametrize("tag", _released_tags(3))
def test_the_redo_selects_a_regime_every_released_tag_can_run(tag: str) -> None:
    """Every script the redo runs exists where the redo will look for it.

    The redo checks out the TAG, so a tag-side `scripts/x` must exist in the
    tag; a `verifier/scripts/x` must exist at the workflow's own revision. A
    gate conditioned on a regime is only required to resolve when that regime
    is the one the tag selects. The verifier copies are also required in the
    working tree, which is what the sparse checkout will provide.
    """
    text = (ROOT / ".github" / "workflows" / "release-redo.yml").read_text()
    assert f"git cat-file -e HEAD:{ENGINE_MANIFEST}" in text
    regime = _redo_regime(tag)
    steps = dict(_job_steps("release-redo.yml", "release"))
    for step in ("Engine payload manifest is current", "Engine payload matches its manifest"):
        assert "if: steps.engine-regime.outputs.regime == 'manifest'" in steps[step]
    assert "if: steps.engine-regime.outputs.regime == 'legacy'" in steps[REDO_LEGACY_ENGINE_STEP]

    # Tracked, or untracked and not ignored: an ignored file (scratch) never
    # reaches the sparse checkout, whatever the working tree holds.
    head_tracked = set(
        _git("ls-files", "--cached", "--others", "--exclude-standard", "--", "scripts").split()
    )
    checked = 0
    for step, cond, ref in _redo_script_references():
        if "outputs.regime ==" in cond and f"'{regime}'" not in cond:
            continue
        if ref.startswith("verifier/"):
            rel = ref.removeprefix("verifier/")
            assert rel in head_tracked, (tag, step, ref)
            assert (ROOT / rel).is_file(), (tag, step, ref)
        elif ref == "scripts/bundle-libreoffice.ps1":
            assert "scripts/bundle-libreoffice.ps1" in head_tracked
        else:
            assert _tag_has(tag, ref), f"{tag} lacks {ref}, run by the redo step {step!r}"
        checked += 1
    assert checked >= 20, "the redo's script references were not found"


@pytest.mark.parametrize("tag", _released_tags(3))
def test_the_legacy_engine_verifier_runs_against_the_released_tag(
    tag: str, tmp_path: Path
) -> None:
    """The regime the redo picks for the tag verifies the tag's real tree.

    A scratch worktree at the tag stands in for the redo's checkout; the
    built engine tree is a copy of the checked-out `src/engine`, which is what
    the pre-manifest bundler shipped. The verifier accepts that tree, refuses
    planted bytecode, and refuses a byte change -- all from the workflow's
    copy of the script, with the tag never having carried it.
    """
    regime = _redo_regime(tag)
    worktree = tmp_path / "tag"
    _git("worktree", "add", "--detach", str(worktree), tag)
    try:
        built = worktree / "src-tauri" / "target" / "release" / "engine"
        shutil.copytree(worktree / "src" / "engine", built)
        verifier = ROOT / "scripts" / "check-engine-payload.py"
        args = [sys.executable, str(verifier), "--root", str(worktree)]
        if regime == "legacy":
            args += ["--legacy-rev", "HEAD"]
            assert not (worktree / ENGINE_MANIFEST).exists()
        run = subprocess.run(args, capture_output=True, text=True)
        assert run.returncode == 0, run.stdout + run.stderr
        assert f"engine payload OK ({regime}" in run.stdout

        cache = built / "__pycache__"
        cache.mkdir()
        (cache / "check.cpython-314.pyc").write_bytes(b"\x00")
        run = subprocess.run(args, capture_output=True, text=True)
        assert run.returncode == 1
        assert "cached bytecode in the engine payload" in run.stdout
        shutil.rmtree(cache)

        target = built / "__startup__.py"
        target.write_bytes(target.read_bytes() + b"#")
        run = subprocess.run(args, capture_output=True, text=True)
        assert run.returncode == 1
        assert "payload bytes differ" in run.stdout
    finally:
        _git("worktree", "remove", "--force", str(worktree))


def _draft_fixture(root: Path) -> tuple[list[str], Path]:
    """A built release beside a byte-identical 'downloaded' draft."""
    bundle = root / "nsis"
    portable = root / "portable"
    sources = root / "sources"
    downloaded = root / "downloaded"
    for d in (bundle, portable, sources, downloaded):
        d.mkdir()
    installer = "Spectra PDF_1.2.3_x64-setup.exe"
    files = {
        bundle / installer: b"MZ" + bytes(range(256)) * 4,
        bundle / f"{installer}.sig": b"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZw==\n",
        portable / "Spectra PDF_1.2.3_x64-portable.zip": b"PK" + bytes(range(256)),
        sources / "libheif-1.0.tar.gz": b"\x1f\x8b" + b"src" * 50,
    }
    for path, data in files.items():
        path.write_bytes(data)
    checksummed = [bundle / installer, portable / "Spectra PDF_1.2.3_x64-portable.zip",
                   sources / "libheif-1.0.tar.gz"]
    sums = "".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in checksummed
    )
    (bundle / "SHA256SUMS.txt").write_bytes(sums.encode("ascii"))
    assets = []
    for i, path in enumerate(list(files) + [bundle / "SHA256SUMS.txt"], start=100):
        shutil.copyfile(path, downloaded / path.name)
        assets.append({"name": path.name, "id": i, "size": path.stat().st_size})
    # The shape Tauri generates for a `["nsis"]` bundle: the target-specific
    # entry the updater reads first, plus the bare fallback.
    entry = {
        "signature": files[bundle / f"{installer}.sig"].decode().strip(),
        "url": "https://api.github.com/repos/o/r/releases/assets/100",
    }
    # The complete manifest Tauri publishes: `notes` is the release body and
    # `pub_date` is the draft's timestamp; both are shown by the update notice.
    manifest = {
        "version": "1.2.3",
        "notes": RELEASE_BODY,
        "pub_date": "2026-09-02T15:00:00.000Z",
        "platforms": {"windows-x86_64": dict(entry), "windows-x86_64-nsis": dict(entry)},
    }
    _write_manifest(downloaded, manifest, assets)
    _write_release(downloaded, {"draft": True, "tag_name": "v1.2.3", "body": RELEASE_BODY})
    args = [
        "pwsh", "-NoProfile", "-File", str(ROOT / DRAFT_VERIFIER),
        "-Repo", "o/r", "-Tag", "v1.2.3", "-Bundle", str(bundle), "-Portable", str(portable),
        "-Sources", str(sources), "-Offline", str(downloaded),
        "-CargoPackage", str(ROOT / "src-tauri"),
    ]
    return args, downloaded


RELEASE_BODY = (
    "See CHANGELOG.md for details. The installer is unsigned (no code-signing "
    "certificate); SmartScreen may warn on first run -- verify your download against "
    "SHA256SUMS.txt, published with this release."
)


def _write_release(downloaded: Path, release: dict) -> None:
    (downloaded / "release.json").write_text(json.dumps(release))


def _mutate_manifest_top(downloaded: Path, mutate) -> None:
    manifest = json.loads((downloaded / "latest.json").read_text())
    mutate(manifest)
    _write_manifest(downloaded, manifest)


def _write_manifest(downloaded: Path, manifest: dict, assets: list[dict] | None = None) -> None:
    """Write latest.json and keep the API-reported size honest, so only the
    manifest check can fail."""
    text = json.dumps(manifest)
    (downloaded / "latest.json").write_text(text)
    if assets is None:
        assets = json.loads((downloaded / "assets.json").read_text())
        for asset in assets:
            if asset["name"] == "latest.json":
                asset["size"] = len(text.encode())
    else:
        assets.append({"name": "latest.json", "id": 200, "size": len(text.encode())})
    (downloaded / "assets.json").write_text(json.dumps(assets))


def _mutate_manifest(downloaded: Path, mutate) -> None:
    manifest = json.loads((downloaded / "latest.json").read_text())
    mutate(manifest["platforms"])
    _write_manifest(downloaded, manifest)


def _run_verifier(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True)


def _verifier_says(run: subprocess.CompletedProcess, message: str) -> bool:
    """pwsh colours its error rendering and soft-wraps long messages onto
    ` | ` continuation lines, dropping the space at the wrap; the comparison
    ignores colour and whitespace so it matches the message, not the wrap."""
    text = re.sub(r"\x1b\[[0-9;]*m", "", run.stdout + run.stderr)
    text = re.sub(r"\n\s*\|", "", text)
    squash = lambda s: re.sub(r"\s+", "", s)  # noqa: E731
    return squash(message) in squash(text)


def test_the_draft_verifier_accepts_a_faithful_upload(tmp_path: Path) -> None:
    args, _downloaded = _draft_fixture(tmp_path)
    run = _run_verifier(args)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "verified from downloaded bytes: 6 assets hashed" in run.stdout


def test_the_draft_verifier_refuses_a_same_length_wrong_installer(tmp_path: Path) -> None:
    """The size check the old step relied on passes this fixture; the hash fails it."""
    args, downloaded = _draft_fixture(tmp_path)
    target = downloaded / "Spectra PDF_1.2.3_x64-setup.exe"
    data = bytearray(target.read_bytes())
    data[-1] ^= 0xFF
    target.write_bytes(bytes(data))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "uploaded bytes differ from the built file" in run.stdout + run.stderr


def test_the_draft_verifier_refuses_a_checksum_file_that_lies(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    sums = downloaded / "SHA256SUMS.txt"
    lines = sums.read_text().splitlines()
    digest, name = lines[0].split("  ", 1)
    swapped = ("0" if digest[0] != "0" else "1") + digest[1:]
    lines[0] = f"{swapped}  {name}"
    body = ("\n".join(lines) + "\n").encode("ascii")
    sums.write_bytes(body)
    (tmp_path / "nsis" / "SHA256SUMS.txt").write_bytes(body)
    run = _run_verifier(args)
    assert run.returncode != 0
    assert f"SHA256SUMS.txt is wrong for {name}" in run.stdout + run.stderr


def test_the_draft_verifier_refuses_a_manifest_with_a_foreign_signature(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p["windows-x86_64"].update(signature="c29tZW9uZSBlbHNl"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "latest.json signature is not the uploaded installer's .sig" in run.stdout + run.stderr


def test_the_draft_verifier_refuses_a_foreign_nsis_entry(tmp_path: Path) -> None:
    """The updater reads windows-x86_64-nsis first; a clean fallback beside a
    corrupt preferred entry must not pass."""
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p["windows-x86_64-nsis"].update(
        signature="not-the-installer-signature", url="not a URL"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(run, "(platform windows-x86_64-nsis)")


def test_the_draft_verifier_refuses_a_missing_nsis_entry(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p.pop("windows-x86_64-nsis"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(
        run, "latest.json platforms [windows-x86_64] != [windows-x86_64, windows-x86_64-nsis]")


def test_the_draft_verifier_refuses_an_extra_platform(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p.update({"linux-x86_64": dict(p["windows-x86_64"])}))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(
        run, "[linux-x86_64, windows-x86_64, windows-x86_64-nsis] != [windows-x86_64, windows-x86_64-nsis]")


def test_the_draft_verifier_refuses_a_same_suffix_foreign_host(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p["windows-x86_64-nsis"].update(
        url="https://evil.example/releases/assets/100"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(
        run, "url mismatch (platform windows-x86_64-nsis): 'https://evil.example/releases/assets/100'")


def test_the_draft_verifier_refuses_a_wrong_asset_id_under_the_right_host(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p["windows-x86_64"].update(
        url="https://api.github.com/repos/o/r/releases/assets/101"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(
        run, "url mismatch (platform windows-x86_64): 'https://api.github.com/repos/o/r/releases/assets/101'")


def test_the_draft_verifier_refuses_swapped_signatures_between_entries(tmp_path: Path) -> None:
    """Both entries must carry the installer's signature; a foreign signature
    landing in either one is refused whichever entry the updater reads."""
    args, downloaded = _draft_fixture(tmp_path)

    def swap(p: dict) -> None:
        p["windows-x86_64"]["signature"] = "c29tZW9uZSBlbHNl"
        p["windows-x86_64-nsis"]["signature"], p["windows-x86_64"]["signature"] = (
            p["windows-x86_64"]["signature"], p["windows-x86_64-nsis"]["signature"])

    _mutate_manifest(downloaded, swap)
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(run, "(platform windows-x86_64-nsis)")


def _rename_asset(downloaded: Path, old: str, new: str) -> None:
    """Rename a draft asset in the API listing only. The Windows filesystem
    still serves the old file under the new name, so only an exact-name
    comparison can tell the two apart."""
    assets = json.loads((downloaded / "assets.json").read_text())
    for asset in assets:
        if asset["name"] == old:
            asset["name"] = new
    (downloaded / "assets.json").write_text(json.dumps(assets))


# Case-only forgeries. Every consumer of these identities is case-sensitive
# (the updater's platform lookup and `latest.json` request, GitHub asset
# names, base64 signatures, `sha256sum -c`), while PowerShell's default
# comparisons, hashtables and property lookups are not.
def test_the_draft_verifier_refuses_a_platform_key_differing_only_by_case(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest(downloaded, lambda p: p.update({"Windows-x86_64-NSIS": p.pop("windows-x86_64-nsis")}))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(run, "latest.json platforms [")


def test_the_draft_verifier_refuses_a_signature_differing_only_by_case(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)

    def recase(p: dict) -> None:
        sig = p["windows-x86_64-nsis"]["signature"]
        assert sig.startswith("dW50")
        p["windows-x86_64-nsis"]["signature"] = "DW50" + sig[4:]

    _mutate_manifest(downloaded, recase)
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(run, "latest.json signature is not the uploaded installer's .sig (platform windows-x86_64-nsis)")


def test_the_draft_verifier_refuses_a_manifest_asset_named_in_upper_case(tmp_path: Path) -> None:
    """The compiled updater endpoint requests `latest.json`; `LATEST.JSON` is
    an asset nobody downloads."""
    args, downloaded = _draft_fixture(tmp_path)
    _rename_asset(downloaded, "latest.json", "LATEST.JSON")
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "draft assets differ from the built set" in run.stdout + run.stderr


def test_the_draft_verifier_refuses_an_installer_asset_differing_only_by_case(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _rename_asset(downloaded, "Spectra PDF_1.2.3_x64-setup.exe", "spectra pdf_1.2.3_x64-setup.exe")
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "draft assets differ from the built set" in run.stdout + run.stderr


def test_the_draft_verifier_refuses_a_tag_differing_only_by_case(tmp_path: Path) -> None:
    args, _downloaded = _draft_fixture(tmp_path)
    args[args.index("-Tag") + 1] = "V1.2.3"
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "-Tag must be a lowercase 'v' tag" in run.stdout + run.stderr
    _write_release(_downloaded, {"draft": True, "tag_name": "V1.2.3", "body": RELEASE_BODY})
    args[args.index("-Tag") + 1] = "v1.2.3"
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(run, "draft is for tag 'V1.2.3', expected 'v1.2.3'")


def test_the_draft_verifier_refuses_upper_case_hex_in_the_checksum_file(tmp_path: Path) -> None:
    """`sha256sum -c` accepts either case, but the workflow writes lowercase;
    an uppercase digest is a rewritten file, not this build's output."""
    args, downloaded = _draft_fixture(tmp_path)
    sums = downloaded / "SHA256SUMS.txt"
    lines = sums.read_text().splitlines()
    digest, name = lines[0].split("  ", 1)
    lines[0] = f"{digest.upper()}  {name}"
    body = ("\n".join(lines) + "\n").encode("ascii")
    sums.write_bytes(body)
    (tmp_path / "nsis" / "SHA256SUMS.txt").write_bytes(body)
    run = _run_verifier(args)
    assert run.returncode != 0
    assert _verifier_says(run, "not lowercase sha256 hex")


def test_the_draft_verifier_refuses_platform_keys_duplicated_under_case(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    manifest = json.loads((downloaded / "latest.json").read_text())
    entry = manifest["platforms"]["windows-x86_64-nsis"]
    # json.dumps keeps both keys: they differ ordinally.
    manifest["platforms"] = {
        "windows-x86_64": dict(entry),
        "windows-x86_64-nsis": dict(entry),
        "WINDOWS-X86_64-NSIS": dict(entry),
    }
    _write_manifest(downloaded, manifest)
    run = _run_verifier(args)
    assert run.returncode != 0
    # ConvertFrom-Json refuses case-duplicated keys before the verifier's own
    # ordinal re-keying can; either refusal names the offending key.
    assert _verifier_says(run, "WINDOWS-X86_64-NSIS")


def test_the_draft_verifier_refuses_an_already_public_release(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _write_release(downloaded, {"draft": False, "tag_name": "v1.2.3", "body": RELEASE_BODY})
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "is already public before verification" in run.stdout + run.stderr


# The manifest's final parse is the updater plugin's own deserializer (see
# src-tauri/tests/updater_manifest.rs). These drive it through the script.
UPDATER_REFUSAL = "refused by the updater's own deserializer or differs from the release"


def test_the_draft_verifier_accepts_a_manifest_with_an_unknown_top_level_field(
    tmp_path: Path,
) -> None:
    """The plugin ignores fields it does not model; so does the gate."""
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest_top(downloaded, lambda m: m.update(unmodelled="ignored"))
    run = _run_verifier(args)
    assert run.returncode == 0, run.stdout + run.stderr


def test_the_draft_verifier_refuses_notes_that_are_not_a_string(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest_top(downloaded, lambda m: m.update(notes={"not": "a string"}))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "the updater's deserializer refuses latest.json" in run.stdout + run.stderr
    assert _verifier_says(run, UPDATER_REFUSAL)


def test_the_draft_verifier_refuses_notes_that_differ_from_the_release_body(
    tmp_path: Path,
) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest_top(downloaded, lambda m: m.update(notes=RELEASE_BODY.replace("See", "SEE", 1)))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "notes differ from the release body" in run.stdout + run.stderr
    assert _verifier_says(run, UPDATER_REFUSAL)


def test_the_draft_verifier_refuses_a_manifest_without_notes(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest_top(downloaded, lambda m: m.pop("notes"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "latest.json carries no `notes`" in run.stdout + run.stderr


@pytest.mark.parametrize(
    "pub_date", ["not-rfc3339", "2026-09-02", "2026-09-02T15:00:00"]
)
def test_the_draft_verifier_refuses_a_pub_date_the_updater_cannot_parse(
    tmp_path: Path, pub_date: str
) -> None:
    """A date PowerShell would coerce is still refused: the parse is the
    plugin's `time` RFC 3339 parse, and an offset-less or date-only value
    fails it."""
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest_top(downloaded, lambda m: m.update(pub_date=pub_date))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "invalid value for `pub_date`" in run.stdout + run.stderr
    assert _verifier_says(run, UPDATER_REFUSAL)


def test_the_draft_verifier_refuses_a_manifest_without_pub_date(tmp_path: Path) -> None:
    args, downloaded = _draft_fixture(tmp_path)
    _mutate_manifest_top(downloaded, lambda m: m.pop("pub_date"))
    run = _run_verifier(args)
    assert run.returncode != 0
    assert "latest.json carries no `pub_date`" in run.stdout + run.stderr


ACCEPTING_UPDATER_TEST = """\
#[test]
fn verifies_the_manifest_named_by_the_environment() {}
"""


#: The reviewer's probe, verbatim in shape: an explicit `[[test]]` claiming
#: the name the verifier once staged under, pathed at a tag-local accepting
#: source. Cargo runs the explicit target over the inferred `tests/<name>.rs`.
EXPLICIT_TEST_REDIRECT = """
[[test]]
name = "verifier_updater_manifest"
path = "tests/accepting_verifier.local.rs"
"""


@pytest.fixture
def tag_package(tmp_path: Path):
    """A scratch package standing in for a TAG's `src-tauri`, with the
    conventionally named test replaced by an accepting one.

    A worktree at HEAD sharing the checkout's cargo target directory, so the
    dependency graph is not rebuilt. The build script requires every
    `resources/` entry of tauri.conf.json to exist; empty stubs satisfy it
    the way the CI jobs' stubs do. Yields (verifier args, downloaded dir,
    package dir, env).
    """
    worktree = tmp_path / "tag"
    _git("worktree", "add", "--detach", str(worktree), "HEAD")
    try:
        package = worktree / "src-tauri"
        conf = json.loads((package / "tauri.conf.json").read_text())
        for entry in conf["bundle"]["resources"]:
            if entry.startswith("../resources/"):
                (worktree / entry.removeprefix("../")).mkdir(parents=True)
        (package / "tests" / "updater_manifest.rs").write_text(ACCEPTING_UPDATER_TEST)
        args, downloaded = _draft_fixture(tmp_path)
        args[args.index("-CargoPackage") + 1] = str(package)
        env = {**os.environ, "CARGO_TARGET_DIR": str(ROOT / "src-tauri" / "target")}
        yield args, downloaded, package, env
    finally:
        _git("worktree", "remove", "--force", str(worktree))


def _staged_leftovers(package: Path) -> list[Path]:
    """Staged verifier files the script failed to remove; a planted file
    under the prefix is the test's own and is not one."""
    return sorted(
        p for p in (package / "tests").glob(f"{VERIFIER_TEST_PREFIX}*")
        if re.fullmatch(rf"{VERIFIER_TEST_PREFIX}[0-9a-f]{{16}}_updater_manifest\.rs", p.name)
    )


def test_the_draft_verifier_ignores_an_accepting_test_the_verified_package_carries(
    tag_package,
) -> None:
    """A tag whose tests/ already holds an accepting `updater_manifest.rs` is
    still judged by the verifier's own source: the malformed pub_date is
    refused, and the faithful control passes against the package's pinned
    updater. Only the package under verification differs from the ordinary
    fixture run.
    """
    args, downloaded, package, env = tag_package
    source = (ROOT / UPDATER_MANIFEST_TEST).read_bytes()

    _mutate_manifest_top(downloaded, lambda m: m.update(pub_date="not-rfc3339"))
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert "invalid value for `pub_date`" in run.stdout + run.stderr
    assert _verifier_says(run, UPDATER_REFUSAL)
    # The staging line names the verifier's source and its exact digest, and
    # the resolution line names the same staged file cargo will run.
    staged = re.search(
        rf"staged .* as (.*[\\/]tests[\\/]{VERIFIER_TEST_PREFIX}[0-9a-f]{{16}}_updater_manifest\.rs) \(sha256 ([0-9a-f]{{64}})\)",
        run.stdout,
    )
    assert staged, run.stdout
    assert Path(staged.group(1)).parent == package / "tests"
    assert staged.group(2) == hashlib.sha256(source).hexdigest()
    assert f"cargo resolves --test {Path(staged.group(1)).stem} to " in run.stdout
    # The staged target is removed after the run, and the package's own
    # accepting test is left exactly as planted: never read, never touched.
    assert _staged_leftovers(package) == []
    assert (package / "tests" / "updater_manifest.rs").read_text() == ACCEPTING_UPDATER_TEST

    _mutate_manifest_top(downloaded, lambda m: m.update(pub_date="2026-09-02T15:00:00.000Z"))
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "verified from downloaded bytes: 6 assets hashed" in run.stdout
    # A fresh name each run: the two staged targets never coincide.
    second = re.search(rf"as .*({VERIFIER_TEST_PREFIX}[0-9a-f]{{16}}_updater_manifest)\.rs", run.stdout)
    assert second and second.group(1) != Path(staged.group(1)).stem
    assert _staged_leftovers(package) == []


def test_the_draft_verifier_refuses_a_manifest_that_redirects_the_verifier_target(
    tag_package,
) -> None:
    """The explicit-target substitution: the tag's Cargo.toml declares a
    `[[test]]` under the reserved name pointing at its own accepting source.
    Refused on the manifest text before any build, with a malformed manifest
    AND with a faithful one -- the breach is the package's, not the release's.
    """
    args, downloaded, package, env = tag_package
    (package / "tests" / "accepting_verifier.local.rs").write_text(ACCEPTING_UPDATER_TEST)
    manifest = package / "Cargo.toml"
    manifest.write_text(manifest.read_text() + EXPLICIT_TEST_REDIRECT)

    _mutate_manifest_top(downloaded, lambda m: m.update(pub_date="not-rfc3339"))
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert _verifier_says(
        run, "declares a [[test]] with name 'verifier_updater_manifest' under the reserved 'verifier_' prefix")
    assert "Running" not in run.stdout + run.stderr
    assert _staged_leftovers(package) == []

    _mutate_manifest_top(downloaded, lambda m: m.update(pub_date="2026-09-02T15:00:00.000Z"))
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert _verifier_says(run, "under the reserved 'verifier_' prefix")
    assert "verified from downloaded bytes" not in run.stdout


def test_the_draft_verifier_refuses_a_package_that_disables_test_inference(
    tag_package,
) -> None:
    """With `autotests = false` the staged file is never a target; cargo
    would report no such test. Refused by name before cargo is asked."""
    args, _downloaded, package, env = tag_package
    manifest = package / "Cargo.toml"
    text = manifest.read_text()
    manifest.write_text(text.replace("[package]\n", "[package]\nautotests = false\n", 1))
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert _verifier_says(run, "sets autotests = false")
    assert _staged_leftovers(package) == []


def test_the_draft_verifier_refuses_duplicate_explicit_targets_under_the_reserved_name(
    tag_package,
) -> None:
    args, _downloaded, package, env = tag_package
    (package / "tests" / "accepting_verifier.local.rs").write_text(ACCEPTING_UPDATER_TEST)
    manifest = package / "Cargo.toml"
    manifest.write_text(manifest.read_text() + EXPLICIT_TEST_REDIRECT + EXPLICIT_TEST_REDIRECT)
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert _verifier_says(run, "under the reserved 'verifier_' prefix")
    assert _staged_leftovers(package) == []


def test_the_draft_verifier_refuses_an_explicit_target_pathed_under_the_reserved_prefix(
    tag_package,
) -> None:
    """A `[[test]]` of an innocuous name whose source sits under
    `tests/verifier_*`: the path, not only the name, is reserved."""
    args, _downloaded, package, env = tag_package
    (package / "tests" / "verifier_planted.rs").write_text(ACCEPTING_UPDATER_TEST)
    manifest = package / "Cargo.toml"
    manifest.write_text(
        manifest.read_text()
        + '\n[[test]]\nname = "manifest_check"\npath = "tests/verifier_planted.rs"\n'
    )
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert _verifier_says(
        run, "declares a [[test]] with path 'tests/verifier_planted.rs' under the reserved 'verifier_' prefix")
    assert _staged_leftovers(package) == []


def test_the_draft_verifier_refuses_an_inferred_test_under_the_reserved_prefix(
    tag_package,
) -> None:
    """No `[[test]]` at all: a planted `tests/verifier_planted.rs` is inferred
    by cargo, and cargo's own target list is what refuses it."""
    args, _downloaded, package, env = tag_package
    (package / "tests" / "verifier_planted.rs").write_text(ACCEPTING_UPDATER_TEST)
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode != 0, run.stdout + run.stderr
    assert _verifier_says(
        run, "carries a test target 'verifier_planted'")
    assert _staged_leftovers(package) == []


def test_the_draft_verifier_tolerates_an_explicit_target_outside_the_reserved_prefix(
    tag_package,
) -> None:
    """The invariant is about the verifier's target, not the tag's right to
    declare its own: an ordinary explicit `[[test]]` is left alone and the
    faithful manifest passes."""
    args, _downloaded, package, env = tag_package
    (package / "tests" / "product_check.rs").write_text("#[test]\nfn product() {}\n")
    manifest = package / "Cargo.toml"
    manifest.write_text(
        manifest.read_text() + '\n[[test]]\nname = "product_check"\npath = "tests/product_check.rs"\n'
    )
    run = subprocess.run(args, capture_output=True, text=True, env=env)
    assert run.returncode == 0, run.stdout + run.stderr
    assert "verified from downloaded bytes: 6 assets hashed" in run.stdout
    assert _staged_leftovers(package) == []


def test_ci_scans_the_renderer_it_just_built_for_the_test_harness() -> None:
    steps = _job_steps("ci.yml", "lint-and-build")
    names = [name for name, _ in steps]
    gate = "Shipped renderer carries no test harness"
    assert names.index("Build renderer (Vite)") + 1 == names.index(gate)
    assert "run: python scripts/check-release-bundle.py" in dict(steps)[gate]


def test_scan_fixture_uses_the_ghostscript_authority() -> None:
    text = (ROOT / "tests" / "fixtures" / "make_scans.py").read_text()
    assert "from engine.gs_capability import require" in text
    assert "resources\" / \"ghostscript" not in text


def test_the_ghostscript_test_tool_install_retries_and_falls_back_pinned() -> None:
    """The capability-present axis does not rest on one flaky package feed.

    The primary path stays the unpinned current package (what a user gets);
    the fallback is a pinned upstream installer, hash-verified before it is
    executed, so an exhausted retry cannot run an unverified binary.
    """
    text = (ROOT / "scripts" / "install-ghostscript-test-tool.ps1").read_text()
    assert "choco install ghostscript -y --no-progress" in text
    assert "$attempt -le 3" in text
    assert "$FallbackSha256 = " in text
    verify = text.index("$actual -ne $FallbackSha256")
    assert verify < text.index("Start-Process -FilePath $installer")


def test_the_test_hsm_download_is_version_and_hash_pinned() -> None:
    text = (ROOT / "scripts" / "setup-test-softhsm.ps1").read_text()
    assert '$Version = "2.5.0"' in text
    assert "releases/download/v$Version/SoftHSM2-$Version-portable.zip" in text
    assert "85273bcc1a6b90e877f7bb4f7e90221d57103d8f5241d154a79dd730a135b910" in text
    assert "1980a74f3088a7273d7efa502b6ceb8de6a5285d5bcd36d49512a8717bf89635" in text


def test_full_capability_gate_refuses_a_skip(monkeypatch) -> None:
    class Report:
        nodeid = "tests/test_ghent_output.py::test_assembled_pages_are_six"
        longrepr = ("tests/test_ghent_output.py", 209, "Skipped: Ghent-corpus axis")

    class Reporter:
        stats = {"skipped": [Report(), object()]}

        def __init__(self) -> None:
            self.lines: list[str] = []

        def write_sep(self, _char, message) -> None:
            self.lines.append(message)

        def write_line(self, message) -> None:
            self.lines.append(message)

    reporter = Reporter()
    session = SimpleNamespace(
        exitstatus=pytest.ExitCode.OK,
        config=SimpleNamespace(
            pluginmanager=SimpleNamespace(get_plugin=lambda _name: reporter)
        ),
    )
    monkeypatch.setenv("SPECTRAPDF_REQUIRE_ZERO_SKIPS", "1")

    conftest.pytest_sessionfinish(session, pytest.ExitCode.OK)

    assert session.exitstatus == pytest.ExitCode.TESTS_FAILED
    # The refusal names the axis and the test, not just a count: a CI log that
    # says only "refused 64" cannot be acted on without re-running the suite.
    assert "full-capability gate refused 2 skipped tests" in reporter.lines
    assert any("Ghent-corpus axis" in line for line in reporter.lines)
    assert any(Report.nodeid in line for line in reporter.lines)
    assert any("unstated reason" in line for line in reporter.lines)


def test_ci_stages_both_engine_capabilities() -> None:
    _assert_capabilities_precede_engine_tests("ci.yml")


def test_release_verification_stages_both_engine_capabilities() -> None:
    _assert_capabilities_precede_engine_tests("release.yml")
