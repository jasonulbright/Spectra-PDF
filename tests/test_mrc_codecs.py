"""O8 slice B — the MRC layer codecs.

The pins here are the ones that would have caught the four rules the recon
earned, every one of which was a live bug first and every one of which passed
a naive size-and-renders check:

  1. multi-strip group 4 (decodes progressively wrong, LOOKS like erosion)
  2. stencil polarity (renders solid black; OCR still returns words from it)
  3. refinement coding (crashes the industry-standard reader)
  4. symbol substitution (a lossless-sounding preset silently altering glyphs)

The decode-back pins are skip-if-absent on Ghostscript (the standing
precedent), and the JBIG2 pins are skip-if-absent on the vendored encoder.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from engine import budget
from engine.mrc_codecs import (
    CCITT_G4,
    JBIG2_GENERIC,
    JBIG2_SYMBOL,
    MASK_CODECS,
    encode_layer_jpeg,
    encode_layer_jpx,
    encode_mask,
    encode_mask_ccitt_g4,
    encode_masks_jbig2,
    jbig2_available,
    jbig2_candidates,
    mask_ink_fraction,
    resolve_jbig2,
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

    def test_missing_ghostscript_refuses_by_name(self):
        stream = encode_mask_ccitt_g4(make_mask())
        with pytest.raises(RuntimeError, match="Ghostscript is not available"):
            verify_mask_stream(stream, "")

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
        # The reason the encoder is vendored at all (§ 2.3): generic-region
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
    """§ 5.5 — a fixed wall-clock budget fails on exactly the documents the
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
    """§ 5.5 — the defect fixed at the FAMILY, so it cannot be half-landed."""

    def test_the_floor_is_never_lower_than_the_constant_it_replaced(self, tmp_dir):
        # The bug was "too little time for a big file", never "too much for a
        # small one": every input must still get at least the old 300 s.
        tiny = os.path.join(tmp_dir, "tiny.pdf")
        with open(tiny, "wb") as fh:
            fh.write(b"%PDF-1.7\n")
        assert budget.derive(base=300.0, size_bytes=os.path.getsize(tiny), pages=1,
                             per_mb=12.0, per_page=1.5) >= 300.0

    def test_the_reported_case_now_gets_proportional_time(self):
        # Issue #5: a 50 MB scan died at the fixed 300 s.
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
