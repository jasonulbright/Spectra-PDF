"""Clean-runner guards for optional capabilities used by engine tests."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _assert_capabilities_precede_engine_tests(workflow: str) -> None:
    text = (ROOT / ".github" / "workflows" / workflow).read_text()
    engine_test = text.index("python -m pytest tests/ -q")

    assert text.index("scripts/bundle-icc.ps1") < engine_test
    assert text.index("choco install ghostscript -y --no-progress") < engine_test
    assert text.index("SPECTRAPDF_GS_PATH=") < engine_test


def test_ci_stages_both_engine_capabilities() -> None:
    _assert_capabilities_precede_engine_tests("ci.yml")


def test_release_verification_stages_both_engine_capabilities() -> None:
    _assert_capabilities_precede_engine_tests("release.yml")
