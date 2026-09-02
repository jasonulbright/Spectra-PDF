"""Clean-runner guards for optional capabilities used by engine tests."""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

import conftest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ("ci.yml", "release.yml")

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


#: The publishers: (workflow, job) pairs whose last step is the only one that
#: makes a release public. Both must carry the same gates in the same order.
PUBLISHER_JOBS = (("release.yml", "release"), ("release-redo.yml", "release"))

#: Every gate that runs against the built and uploaded assets, in the order
#: the job runs them. All of them precede the publish step.
RELEASE_VERIFICATION_STEPS = (
    "Verify the portable tree against the installer's staging",
    "Portable payload notice map covers every declared resource",
    "Engine payload manifest is current",
    "Engine payload matches its manifest",
    "Verify the draft's assets and updater manifest",
)

#: The two payload gates mirrored in scripts/ci-parity-gates.sh: step name
#: and the exact command, so a workflow cannot keep the name and drop the run.
RELEASE_PAYLOAD_GATES = (
    ("Engine payload manifest is current",
     "python scripts/gen-engine-payload-manifest.py --check"),
    ("Engine payload matches its manifest", "python scripts/check-engine-payload.py"),
)

RELEASE_DRAFT_STEP = "Build, sign, and upload to a draft release"
RELEASE_PUBLISH_STEP = "Publish the release"


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
    for gate in RELEASE_VERIFICATION_STEPS:
        assert draft < names.index(gate) < publish, (workflow, gate)
    uploads = [i for i, name in enumerate(names) if name.startswith("Upload ")]
    assert uploads, workflow
    # Every upload lands before the read-back verification of the draft.
    assert max(uploads) < names.index("Verify the draft's assets and updater manifest")
    assert all(draft < i for i in uploads)


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
    verify = steps["Verify the draft's assets and updater manifest"]
    assert "is already public before verification" in verify
    assert "steps.draft.outputs.releaseId" in verify
    assert "steps.draft.outputs.releaseId" in publish


@pytest.mark.parametrize("workflow,job", PUBLISHER_JOBS)
@pytest.mark.parametrize("name,command", RELEASE_PAYLOAD_GATES)
def test_both_payload_gates_run_in_every_publisher(
    workflow: str, job: str, name: str, command: str
) -> None:
    steps = dict(_job_steps(workflow, job))
    assert f"run: {command}" in steps[name], (workflow, name)


def test_the_payload_gates_are_mirrored_locally() -> None:
    text = (ROOT / "scripts" / "ci-parity-gates.sh").read_text()
    for _name, command in RELEASE_PAYLOAD_GATES:
        assert command.removeprefix("python ") in text
    assert "build-portable-zip.ps1 -CheckMap" in text
    assert "tests/test_ci_capability_setup.py" in text


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
