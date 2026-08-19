"""MRC layer codec regression coverage.

These cases verify six constraints that a size-and-renders check cannot prove:

  1. multi-strip group 4 (decodes progressively wrong, LOOKS like erosion)
  2. stencil polarity (renders solid black; OCR still returns words from it)
  3. refinement coding (crashes the industry-standard reader)
  4. symbol substitution (a lossless-sounding preset silently altering glyphs)
  5. grain routed away from the shared symbol dictionary (a document whose
     stencils are grain costs the SQUARE of its marks in symbol mode)
  6. every arm degrades rather than refuses (a codec is a preference;
     finishing is not)

The decode-back pins are skip-if-absent on Ghostscript (the standing
precedent), and the JBIG2 pins are skip-if-absent on the vendored encoder.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw

from engine import budget
from engine import mrc_codecs
from engine.mrc_codecs import (
    CCITT_G4,
    JBIG2_GENERIC,
    JBIG2_SYMBOL,
    MASK_CODEC_MIXED,
    MASK_CODECS,
    SYMBOL_MIN_MARK_AREA,
    MaskProfile,
    encode_layer_jpeg,
    encode_layer_jpx,
    encode_mask,
    encode_mask_ccitt_g4,
    encode_masks_jbig2,
    jbig2_available,
    jbig2_candidates,
    mask_ink_fraction,
    resolve_jbig2,
    symbol_mode_suits,
    verify_mask_stream,
)

# Tall enough that Pillow's ~205-row default strip height would produce
# SEVERAL strips — a short fixture would pass the single-strip pin by accident.
W, H = 850, 1400

needs_jbig2 = pytest.mark.skipif(
    not jbig2_available(), reason="jbig2enc not vendored (scripts/bundle-jbig2enc.ps1)"
)


def make_mask(seed: int = 0) -> Image.Image:
    """A text-like stencil under the module's convention: 0 = ink, 1 = paper."""
    im = Image.new("1", (W, H), 1)
    d = ImageDraw.Draw(im)
    d.rectangle([60, 60, W - 60, 130], fill=0)
    y = 200
    for i in range(14):
        d.rectangle([60, y, W - 80 - ((i + seed) % 5) * 40, y + 22], fill=0)
        y += 70
    d.ellipse([80, H - 260, 300, H - 60], fill=0)
    return im


def grain_mask(seed: int, marks: int = 9000) -> Image.Image:
    """A stencil of `marks` individually-unique little blobs — grain, not type.

    IRREGULAR on purpose: a field of rectangles of a given size correlates
    perfectly with every other rectangle of that size, so jbig2enc collapses it
    to a few dozen templates and the fixture would measure nothing about a
    dictionary that grows. Random 6x6 bit patterns each become their own
    template, which is exactly what a page of sensor grain does.
    """
    rng = np.random.default_rng(seed)
    ink = np.zeros((H, W), dtype=bool)
    ys = rng.integers(2, H - 8, marks)
    xs = rng.integers(2, W - 8, marks)
    pats = rng.random((marks, 6, 6)) < 0.6
    for y, x, pat in zip(ys.tolist(), xs.tolist(), pats):
        ink[y : y + 6, x : x + 6] |= pat
    return Image.fromarray(np.logical_not(ink))


#: Profiles for the two fixture populations, at the fixtures' own resolution.
#: Written as multiples of the floor so the pins state the RELATION they are
#: about rather than restating the constant.
TYPE_PROFILE = MaskProfile(mark_area_mean=SYMBOL_MIN_MARK_AREA * 8, dpi=300)
GRAIN_PROFILE = MaskProfile(mark_area_mean=SYMBOL_MIN_MARK_AREA / 4, dpi=300)


def gray_page() -> Image.Image:
    """A continuous-tone layer for the JPEG / JPEG2000 pins.

    Deliberately DETAILED (a deterministic pseudo-noise field over a gradient):
    a smooth gradient compresses to the codec's floor at every setting, so a
    rate pin written against one would compare two identical files and pass
    whatever the parameter meant.
    """
    w, h = W // 4, H // 4
    grad = Image.linear_gradient("L").resize((w, h))
    noise = Image.frombytes(
        "L", (w, h), bytes(((x * 97 + y * 57 + x * y * 13) % 256) for y in range(h) for x in range(w))
    )
    return Image.merge("RGB", (grad, noise, Image.blend(grad, noise, 0.5)))


class TestMaskConvention:
    def test_ink_fraction_counts_dark_pixels(self):
        mask = make_mask()
        frac = mask_ink_fraction(mask)
        # Sanity band: the fixture is text-like, not a solid fill.
        assert 0.02 < frac < 0.40

    def test_a_non_1bit_image_is_refused_by_name(self):
        with pytest.raises(ValueError, match="1-bit image"):
            encode_mask_ccitt_g4(make_mask().convert("L"))


class TestCcittG4:
    def test_encodes_as_exactly_one_strip(self):
        # Rule 1. Pillow's default strip height (~205 rows) would split this
        # 1400-row page into seven strips, each restarting the G4 reference
        # line; the encoder forces ROWSPERSTRIP = height and asserts it.
        stream = encode_mask_ccitt_g4(make_mask())
        assert stream.codec == CCITT_G4
        assert stream.width == W and stream.height == H
        assert len(stream.data) > 0

    def test_carries_the_decode_parms_the_filter_needs(self):
        stream = encode_mask_ccitt_g4(make_mask())
        assert stream.decode_parms == {"K": -1, "Columns": W, "Rows": H, "BlackIs1": False}
        # Rule 2: the polarity is recorded, not left to the reader.
        assert stream.decode is not None

    def test_records_the_source_ink_fraction(self):
        mask = make_mask()
        stream = encode_mask_ccitt_g4(mask)
        assert stream.ink_fraction == pytest.approx(mask_ink_fraction(mask))

    def test_beats_the_raw_bitmap(self):
        stream = encode_mask_ccitt_g4(make_mask())
        assert len(stream.data) < (W * H) // 8


class TestVerification:
    """Rule 2 as a round trip, through an INDEPENDENT decoder."""

    def test_ccitt_stencil_decodes_back_to_its_own_coverage(self, gs_path):
        stream = encode_mask_ccitt_g4(make_mask())
        got = verify_mask_stream(stream, gs_path)
        assert got == pytest.approx(stream.ink_fraction, abs=0.001)

    def test_an_inverted_stencil_is_caught(self, gs_path):
        # The failure this exists for: flip the /Decode array and the page
        # renders as the negative. Coverage catches it; "does it render" and a
        # size check both pass, and Tesseract returns plausible words.
        stream = encode_mask_ccitt_g4(make_mask())
        flipped = stream.__class__(**{**stream.__dict__, "decode": (0, 1) if stream.decode == (1, 0) else (1, 0)})
        with pytest.raises(RuntimeError, match="mask verification failed"):
            verify_mask_stream(flipped, gs_path)

    def test_missing_ghostscript_refuses_by_name(self, tmp_path):
        # An EXPLICIT path naming no program. "" now means "resolve one" and
        # would find an installed Ghostscript, which would test the machine
        # rather than the refusal; an explicit path never falls through to
        # discovery. The message is the capability authority's own — there is
        # one wording for "no usable Ghostscript", not one per door.
        stream = encode_mask_ccitt_g4(make_mask())
        absent = str(tmp_path / "nowhere" / "gswin64c.exe")
        with pytest.raises(RuntimeError, match="Ghostscript is required for this operation"):
            verify_mask_stream(stream, absent)

    @needs_jbig2
    def test_jbig2_generic_stencil_decodes_back(self, gs_path):
        (stream,) = encode_masks_jbig2([make_mask()], mode=JBIG2_GENERIC)
        got = verify_mask_stream(stream, gs_path)
        assert got == pytest.approx(stream.ink_fraction, abs=0.001)

    @needs_jbig2
    def test_jbig2_symbol_stencil_decodes_back(self, gs_path):
        (stream,) = encode_masks_jbig2([make_mask()], mode=JBIG2_SYMBOL)
        # Symbol mode substitutes shapes, so the tolerance is the encoder's,
        # not the bitmap's — but it is still a fraction of a percent.
        got = verify_mask_stream(stream, gs_path, tolerance=0.005)
        assert got == pytest.approx(stream.ink_fraction, abs=0.005)


class TestJbig2:
    def test_locates_the_bundled_binary_never_path(self):
        # An explicit path that is not a file resolves to nothing rather than
        # falling through to a machine-local install of unknown provenance.
        assert resolve_jbig2("C:/definitely/not/here/jbig2.exe") == ""

    def test_both_vendored_layouts_are_searched(self, tmp_dir):
        # The SHIPPED layout (<resources>/engine beside <resources>/jbig2enc)
        # is the one that matters in production and cannot be exercised by
        # running the dev tree, so the candidate list is tested directly.
        root = Path(tmp_dir)
        shipped = jbig2_candidates(root / "resources" / "engine")
        assert shipped[0] == root / "resources" / "jbig2enc" / "jbig2.exe"
        dev = jbig2_candidates(root / "src" / "engine")
        assert dev[1] == root / "resources" / "jbig2enc" / "jbig2.exe"

    def test_the_bundled_encoder_is_the_one_found(self):
        # Whichever layout this checkout is, the resolved path must be inside
        # the repo's own resources tree — never a machine-local install.
        found = resolve_jbig2()
        if not found:
            pytest.skip("jbig2enc not vendored")
        assert Path(found).parent.name == "jbig2enc"

    def test_missing_encoder_refuses_by_name(self):
        from engine.mrc_codecs import _require_jbig2

        with pytest.raises(RuntimeError, match="JBIG2 encoder is not available"):
            _require_jbig2("C:/definitely/not/here/jbig2.exe")

    def test_unknown_mode_refused(self):
        with pytest.raises(ValueError, match="unknown JBIG2 mode"):
            encode_masks_jbig2([make_mask()], mode="refined")

    def test_an_out_of_range_symbol_threshold_is_refused_in_our_words(self):
        # Matrix-caught: an archival preset asked for symbol mode BY NAME sent
        # 0.98, and jbig2enc answered "Invalid value for threshold" — about a
        # flag the caller never wrote. The range is restated so the refusal
        # names OUR parameter, and it is checked before the encoder is spawned
        # (so a machine without the encoder still gets the right refusal).
        with pytest.raises(ValueError, match="JBIG2 symbol threshold must be"):
            encode_masks_jbig2([make_mask()], mode="jbig2_symbol", symbol_threshold=0.98)
        with pytest.raises(ValueError, match="JBIG2 symbol threshold must be"):
            encode_masks_jbig2([make_mask()], mode="jbig2_symbol", symbol_threshold=0.1)

    def test_no_masks_is_not_an_error(self):
        assert encode_masks_jbig2([]) == []

    @needs_jbig2
    def test_symbol_mode_shares_one_globals_stream_across_pages(self):
        # The reason the unit of work is the DOCUMENT: one symbol dictionary
        # serves every page, and a per-page call would throw that away.
        pages = [make_mask(0), make_mask(1), make_mask(2)]
        streams = encode_masks_jbig2(pages, mode=JBIG2_SYMBOL)
        assert len(streams) == 3
        assert all(s.globals_data is not None for s in streams)
        assert len({id(s.globals_data) for s in streams}) == 1 or len(
            {s.globals_data for s in streams}
        ) == 1

    @needs_jbig2
    def test_generic_mode_emits_no_globals(self):
        streams = encode_masks_jbig2([make_mask(), make_mask(1)], mode=JBIG2_GENERIC)
        assert len(streams) == 2
        assert all(s.globals_data is None for s in streams)

    @needs_jbig2
    def test_jbig2_needs_no_decode_array(self):
        # Measured, not deduced: a jbig2enc stream embeds as an /ImageMask with
        # the filter's natural polarity. Adding /Decode [1 0] renders the
        # negative — the inverted-stencil pin above is the same rule from the
        # other side.
        (stream,) = encode_masks_jbig2([make_mask()], mode=JBIG2_GENERIC)
        assert stream.decode is None
        assert stream.decode_parms is None

    @needs_jbig2
    def test_jbig2_beats_ccitt_on_the_same_mask(self):
        # The reason the encoder is vendored at all: generic-region
        # arithmetic coding against a 1980s run-length code.
        mask = make_mask()
        g4 = encode_mask_ccitt_g4(mask)
        (jb,) = encode_masks_jbig2([mask], mode=JBIG2_GENERIC)
        assert len(jb.data) < len(g4.data)


class TestCodecSelection:
    def test_unknown_codec_refused_by_name(self):
        with pytest.raises(ValueError, match="unknown mask codec"):
            encode_mask([make_mask()], codec="jbig2_refined")

    def test_every_named_codec_is_reachable(self):
        assert set(MASK_CODECS) == {JBIG2_SYMBOL, JBIG2_GENERIC, CCITT_G4}

    def test_ccitt_needs_no_encoder(self):
        streams, used = encode_mask([make_mask()], codec=CCITT_G4)
        assert used == CCITT_G4 and len(streams) == 1

    def test_absent_encoder_falls_back_and_says_so(self):
        # A missing vendored tool is a PROVISIONING fault, not a document
        # fault — but the swap is never silent, because a silent one would
        # make the size claim untrue.
        streams, used = encode_mask(
            [make_mask()], codec=JBIG2_SYMBOL, jbig2_path="C:/definitely/not/here/jbig2.exe"
        )
        assert used == CCITT_G4
        assert streams[0].codec == CCITT_G4

    def test_an_explicitly_named_codec_refuses_instead_of_substituting(self):
        with pytest.raises(RuntimeError, match="JBIG2 encoder is not available"):
            encode_mask(
                [make_mask()],
                codec=JBIG2_GENERIC,
                jbig2_path="C:/definitely/not/here/jbig2.exe",
                allow_fallback=False,
            )


class TestSymbolRouting:
    """Rule 5. Grain never enters the shared symbol dictionary.

    Symbol mode's cost is the SQUARE of the document's unmatched marks, and the
    quadratic term lives in the DOCUMENT, not the page — which is why no
    per-page timeout catches it and why the routing is measured against the
    mark SIZE rather than the mark count.
    """

    def test_the_floor_is_an_area_so_it_scales_with_the_square_of_dpi(self):
        # An ink area measured at 600 dpi is four times the same mark's area at
        # 300; a floor that did not square would demote every high-resolution
        # scan in the corpus this feature exists for.
        at_300 = MaskProfile(mark_area_mean=SYMBOL_MIN_MARK_AREA * 1.5, dpi=300)
        same_mark_at_600 = MaskProfile(mark_area_mean=at_300.mark_area_mean * 4, dpi=600)
        assert symbol_mode_suits(at_300)
        assert symbol_mode_suits(same_mark_at_600)
        # ...and the same PIXEL count at 600 dpi is a quarter-size mark.
        assert not symbol_mode_suits(MaskProfile(at_300.mark_area_mean, dpi=600))

    def test_an_empty_stencil_stays_with_the_document(self):
        # A blank page has no marks to route and must not split the codec
        # report on its own.
        assert symbol_mode_suits(MaskProfile(mark_area_mean=0.0, dpi=300))

    def test_a_profile_per_mask_is_required_or_it_refuses(self):
        with pytest.raises(ValueError, match="one mask profile per mask"):
            encode_mask(
                [make_mask(), make_mask(1)], codec=CCITT_G4, profiles=[TYPE_PROFILE]
            )

    @needs_jbig2
    def test_grain_is_routed_off_the_shared_dictionary_and_type_is_not(self):
        grain = [grain_mask(i) for i in range(3)]
        streams, used = encode_mask(
            grain, codec=JBIG2_SYMBOL, profiles=[GRAIN_PROFILE] * 3
        )
        assert used == JBIG2_GENERIC
        assert [s.codec for s in streams] == [JBIG2_GENERIC] * 3
        assert all(s.globals_data is None for s in streams)

        typed = [make_mask(i) for i in range(3)]
        streams, used = encode_mask(typed, codec=JBIG2_SYMBOL, profiles=[TYPE_PROFILE] * 3)
        assert used == JBIG2_SYMBOL
        assert [s.codec for s in streams] == [JBIG2_SYMBOL] * 3

    @needs_jbig2
    def test_a_mixed_document_keeps_page_order_and_reports_mixed(self):
        # The partition reassembles by index, and an off-by-one there would
        # hand a page someone else's stencil — which renders as a plausible
        # page of the wrong words.
        masks = [make_mask(0), grain_mask(1), make_mask(2), grain_mask(3)]
        profiles = [TYPE_PROFILE, GRAIN_PROFILE, TYPE_PROFILE, GRAIN_PROFILE]
        streams, used = encode_mask(masks, codec=JBIG2_SYMBOL, profiles=profiles)
        assert used == MASK_CODEC_MIXED
        assert [s.codec for s in streams] == [
            JBIG2_SYMBOL, JBIG2_GENERIC, JBIG2_SYMBOL, JBIG2_GENERIC
        ]
        assert [(s.width, s.height) for s in streams] == [(W, H)] * 4
        for stream, mask in zip(streams, masks):
            assert stream.ink_fraction == pytest.approx(mask_ink_fraction(mask))

    @needs_jbig2
    def test_routing_grain_off_the_dictionary_is_the_faster_arm(self):
        # The measurement the routing exists for, at a size a suite can afford.
        # The gap is quadratic in the page count, so three pages understates it
        # by two orders against the reported 272-page document; a factor of two
        # is asserted because a loaded CI box is not a stopwatch.
        grain = [grain_mask(i) for i in range(3)]
        t0 = time.perf_counter()
        encode_mask(grain, codec=JBIG2_SYMBOL, profiles=[GRAIN_PROFILE] * 3)
        routed = time.perf_counter() - t0
        t0 = time.perf_counter()
        encode_mask(grain, codec=JBIG2_SYMBOL)
        unrouted = time.perf_counter() - t0
        assert routed * 2 < unrouted

    @needs_jbig2
    def test_generic_mode_is_never_routed_because_it_has_no_dictionary(self):
        grain = [grain_mask(i) for i in range(2)]
        streams, used = encode_mask(
            grain, codec=JBIG2_GENERIC, profiles=[GRAIN_PROFILE] * 2
        )
        assert used == JBIG2_GENERIC and len(streams) == 2


class TestDegradationLadder:
    """Rule 6. A codec is a preference; finishing is not.

    A 272-page photographic scan spent two hours inside one symbol-mode
    invocation and then lost every page to the timeout — with CCITT G4, which
    encodes the same stencils in milliseconds, available the whole time.
    """

    @pytest.fixture
    def starve(self, monkeypatch):
        """Give an arm a budget nothing can finish inside."""

        def apply(*, symbol: bool = False, generic: bool = False) -> None:
            if symbol:
                monkeypatch.setattr(mrc_codecs, "SYMBOL_BASE", 1e-6)
                monkeypatch.setattr(mrc_codecs, "SYMBOL_PER_MB", 0.0)
                monkeypatch.setattr(mrc_codecs, "SYMBOL_PER_PAGE", 0.0)
                monkeypatch.setattr(mrc_codecs, "SYMBOL_CAP", 1e-6)
            if generic:
                monkeypatch.setattr(mrc_codecs, "GENERIC_BASE", 1e-6)
                monkeypatch.setattr(mrc_codecs, "GENERIC_PER_MB", 0.0)
                monkeypatch.setattr(mrc_codecs, "GENERIC_CAP", 1e-6)

        return apply

    @needs_jbig2
    def test_a_starved_symbol_run_completes_in_generic_and_says_so(self, starve):
        starve(symbol=True)
        masks = [make_mask(i) for i in range(3)]
        streams, used = encode_mask(masks, codec=JBIG2_SYMBOL, profiles=[TYPE_PROFILE] * 3)
        assert used == JBIG2_GENERIC
        assert [s.codec for s in streams] == [JBIG2_GENERIC] * 3
        assert all(s.data for s in streams)

    @needs_jbig2
    def test_a_starved_run_still_produces_a_smaller_stencil_than_the_bitmap(self, starve):
        # "It completed" is not the claim — the output has to be worth having.
        starve(symbol=True, generic=True)
        mask = make_mask()
        streams, used = encode_mask([mask], codec=JBIG2_SYMBOL, profiles=[TYPE_PROFILE])
        assert used == CCITT_G4
        assert len(streams[0].data) < (W * H) // 8

    @needs_jbig2
    def test_the_bottom_rung_needs_no_subprocess_and_cannot_time_out(self, starve):
        starve(symbol=True, generic=True)
        masks = [make_mask(i) for i in range(2)]
        streams, used = encode_mask(masks, codec=JBIG2_SYMBOL, profiles=[TYPE_PROFILE] * 2)
        assert used == CCITT_G4
        # G4's polarity pairing is the measured one, not the deduced one — a
        # degraded page must embed as correctly as a chosen one.
        assert streams[0].decode == (1, 0)
        assert streams[0].decode_parms["BlackIs1"] is False

    @needs_jbig2
    def test_a_breach_degrades_where_a_broken_encoder_still_refuses(self, monkeypatch):
        # The distinction the exception type exists for: a budget is a
        # judgement about time, a non-zero exit is a fault, and swallowing the
        # second would ship whatever the encoder half-wrote.
        import subprocess

        real = mrc_codecs.budget.run

        def fail(cmd, **kw):
            result = real(cmd, **kw)
            return subprocess.CompletedProcess(cmd, 1, b"", b"synthetic encoder fault")

        monkeypatch.setattr(mrc_codecs.budget, "run", fail)
        with pytest.raises(RuntimeError, match="The JBIG2 encoder failed"):
            encode_mask([make_mask()], codec=JBIG2_SYMBOL, profiles=[TYPE_PROFILE])

    def test_a_timeout_is_its_own_exception_type(self):
        # Control flow matches the TYPE, never the message text.
        err = budget.timed_out("The JBIG2 encoder", 7200.0, size_bytes=202 << 20, pages=272)
        assert isinstance(err, budget.TimeBudgetExceeded)
        assert isinstance(err, RuntimeError)

    def test_the_symbol_budget_is_bounded_far_below_the_shared_cap(self):
        # The reported document: 272 pages, ~193 MB of 1-bit samples. It was
        # given the family's 7200 s cap and spent all of it before reporting.
        allowed = budget.derive(
            base=mrc_codecs.SYMBOL_BASE,
            size_bytes=202 << 20,
            pages=272,
            per_mb=mrc_codecs.SYMBOL_PER_MB,
            per_page=mrc_codecs.SYMBOL_PER_PAGE,
            cap=mrc_codecs.SYMBOL_CAP,
        )
        assert allowed < 1200.0

    @needs_jbig2
    def test_the_symbol_budget_still_clears_honest_work_by_an_order(self):
        masks = [make_mask(i) for i in range(4)]
        t0 = time.perf_counter()
        encode_masks_jbig2(masks, mode=JBIG2_SYMBOL)
        spent = time.perf_counter() - t0
        allowed = budget.derive(
            base=mrc_codecs.SYMBOL_BASE,
            size_bytes=sum(m.width * m.height for m in masks) // 8,
            pages=len(masks),
            per_mb=mrc_codecs.SYMBOL_PER_MB,
            per_page=mrc_codecs.SYMBOL_PER_PAGE,
            cap=mrc_codecs.SYMBOL_CAP,
        )
        assert allowed > spent * 10

    @needs_jbig2
    def test_generic_mode_charges_each_page_its_own_budget(self, monkeypatch):
        # One budget shared across every generic invocation would let an early
        # page spend what a later one needs — and generic mode carries no
        # cross-page state that could justify the sharing.
        seen: list[float] = []
        real = mrc_codecs.budget.run

        def record(cmd, **kw):
            seen.append(kw["budget"])
            return real(cmd, **kw)

        monkeypatch.setattr(mrc_codecs.budget, "run", record)
        encode_masks_jbig2([make_mask(0), make_mask(1)], mode=JBIG2_GENERIC)
        assert len(seen) == 2 and seen[0] == seen[1]
        one_page = budget.derive(
            base=mrc_codecs.GENERIC_BASE, size_bytes=(W * H) // 8, pages=1,
            per_mb=mrc_codecs.GENERIC_PER_MB, cap=mrc_codecs.GENERIC_CAP,
        )
        assert seen[0] == pytest.approx(one_page)


class TestContinuousToneLayers:
    def test_jpeg_layer_round_trips(self):
        data = encode_layer_jpeg(gray_page(), quality=45)
        assert data[:2] == b"\xff\xd8"
        with Image.open(__import__("io").BytesIO(data)) as im:
            assert im.size == (W // 4, H // 4)

    def test_jpeg_quality_is_bounded(self):
        with pytest.raises(ValueError, match="JPEG quality"):
            encode_layer_jpeg(gray_page(), quality=0)

    def test_jpx_layer_round_trips(self):
        data = encode_layer_jpx(gray_page(), rate=60)
        with Image.open(__import__("io").BytesIO(data)) as im:
            assert im.size == (W // 4, H // 4)

    def test_jpx_rate_is_a_ratio_not_a_quality(self):
        # Larger rate = smaller file, the opposite sense to JPEG quality. The
        # pin exists because the two parameters read alike at a call site.
        small = encode_layer_jpx(gray_page(), rate=120)
        large = encode_layer_jpx(gray_page(), rate=10)
        assert len(small) < len(large)

    def test_jpx_rate_is_bounded(self):
        with pytest.raises(ValueError, match="JPEG2000 rate"):
            encode_layer_jpx(gray_page(), rate=0)


class TestBudget:
    """A fixed wall-clock budget fails on exactly the documents the
    feature exists for. The budget scales, and names itself when it fires."""

    def test_scales_with_size_and_pages(self):
        small = budget.derive(base=60, size_bytes=1 << 20, pages=1, per_mb=20, per_page=15)
        big = budget.derive(base=60, size_bytes=50 << 20, pages=200, per_mb=20, per_page=15)
        assert big > small > 60

    def test_has_a_floor(self):
        assert budget.derive(base=60, size_bytes=0, pages=0, per_mb=20) == 60

    def test_is_capped(self):
        assert budget.derive(base=60, size_bytes=1 << 40, per_mb=20, cap=7200) == 7200

    def test_a_zero_floor_is_refused(self):
        with pytest.raises(ValueError, match="positive floor"):
            budget.derive(base=0, size_bytes=1 << 20, per_mb=20)

    def test_the_timeout_message_names_the_budget(self):
        err = budget.timed_out("Ghostscript", 940.0, size_bytes=52 << 20, pages=210)
        text = str(err)
        assert "940s" in text and "52.0 MB" in text and "210 pages" in text

    def test_for_file_reads_the_size(self, tmp_dir):
        path = os.path.join(tmp_dir, "x.bin")
        with open(path, "wb") as fh:
            fh.write(b"\0" * (2 << 20))
        assert budget.for_file(path, base=10, per_mb=100) == pytest.approx(210.0, abs=1.0)

    def test_a_missing_file_still_gets_the_floor(self, tmp_dir):
        assert budget.for_file(os.path.join(tmp_dir, "nope"), base=10, per_mb=100) == 10


class TestGhostscriptBudgetFamily:
    """The defect fixed at the FAMILY, so it cannot be half-landed."""

    def test_the_floor_is_never_lower_than_the_constant_it_replaced(self, tmp_dir):
        # The bug was "too little time for a big file", never "too much for a
        # small one": every input must still get at least the old 300 s.
        tiny = os.path.join(tmp_dir, "tiny.pdf")
        with open(tiny, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        assert budget.derive(base=300.0, size_bytes=os.path.getsize(tiny), pages=1,
                             per_mb=12.0, per_page=1.5) >= 300.0

    def test_the_reported_case_now_gets_proportional_time(self):
        # A 50 MB scan died at the fixed 300 s.
        allowed = budget.derive(
            base=300.0, size_bytes=50 << 20, pages=60, per_mb=12.0, per_page=1.5
        )
        assert allowed > 900.0

    def test_no_engine_module_still_hard_codes_a_whole_document_gs_timeout(self):
        # A grep pin, because the failure mode is a SIBLING left behind: the
        # same constant sat in seven modules and fixing one would have read as
        # done. Only the ops that render a whole document are in scope —
        # prepress's 60 s ROM-profile extraction is not one of them.
        engine_dir = Path(__file__).resolve().parent.parent / "src" / "engine"
        offenders = []
        for path in sorted(engine_dir.glob("*.py")):
            if path.name == "budget.py":
                continue  # its docstring quotes the constant it abolished
            for line in path.read_text(encoding="utf-8").splitlines():
                if "timeout=300" in line or "timeout=600" in line:
                    offenders.append(f"{path.name}: {line.strip()}")
        assert not offenders, offenders
