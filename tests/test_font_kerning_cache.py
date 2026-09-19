"""The kerning caches keep a bounded number of entries.

The engine worker lives for the whole session, and every document can bring
font programs and faces it has not seen. Each cache keeps its most recently
used entries up to a limit and drops the least recently used one. The limit
is injected small here; the entries are unreadable programs and missing
faces, which parse to no kerning and are cached like any other.
"""

import os

import pytest

from engine import font_kerning


@pytest.fixture
def small_limits(monkeypatch):
    monkeypatch.setattr(font_kerning, "_EMBEDDED_LIMIT", 2, raising=False)
    monkeypatch.setattr(font_kerning, "_KERN_LIMIT", 2, raising=False)
    font_kerning._EMBEDDED_CACHE.clear()
    font_kerning._KERN_CACHE.clear()
    yield
    font_kerning._EMBEDDED_CACHE.clear()
    font_kerning._KERN_CACHE.clear()


def _program_keys() -> list:
    return list(font_kerning._EMBEDDED_CACHE.keys())


class TestTheEmbeddedProgramCache:
    def test_it_never_holds_more_than_its_limit(self, small_limits):
        for program in (b"first", b"second", b"third", b"fourth"):
            font_kerning._pairs_from_program(program)
            assert len(font_kerning._EMBEDDED_CACHE) <= 2
        assert len(font_kerning._EMBEDDED_CACHE) == 2

    def test_the_least_recently_used_program_goes_first(self, small_limits):
        import hashlib

        font_kerning._pairs_from_program(b"first")
        font_kerning._pairs_from_program(b"second")
        font_kerning._pairs_from_program(b"first")
        font_kerning._pairs_from_program(b"third")
        assert _program_keys() == [
            hashlib.sha1(b"first").digest(),
            hashlib.sha1(b"third").digest(),
        ]


class TestTheBundledFaceCache:
    def test_it_never_holds_more_than_its_limit(self, small_limits, tmp_dir):
        for name in ("a.ttf", "b.ttf", "c.ttf"):
            font_kerning.kern_pairs(os.path.join(tmp_dir, name))
            assert len(font_kerning._KERN_CACHE) <= 2
        assert [key[0] for key in font_kerning._KERN_CACHE] == [
            os.path.join(tmp_dir, "b.ttf"),
            os.path.join(tmp_dir, "c.ttf"),
        ]
