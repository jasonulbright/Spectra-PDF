"""PDF-page watermarks: the lift, the one-embed rule, vector preservation.

The image arm's own behaviour is covered by test_watermark_image.py and the
text arm's by TestWatermark in test_engine.py; this file covers lifting a page
of another PDF as a Form XObject — the pins being that it embeds ONCE, that
nothing is rasterized, that the source page's own /Rotate and annotations come
with it, and that the lift never aliases the source's content stream.
"""

import os
import subprocess

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.extract_text import extract_text
from engine.watermark import POSITIONS, watermark

GS_PATH = os.path.join(
    os.path.dirname(__file__), "..", "resources", "ghostscript", "gswin64c.exe"
)


@pytest.fixture
def gs():
    if not os.path.isfile(GS_PATH):
        pytest.skip("Ghostscript not available")
    return GS_PATH


# ── fixtures ───────────────────────────────────────────────────────────────


def _target(path: str, count: int = 2, size=(400, 400)) -> None:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                   Encoding=Name.WinAnsiEncoding)
    )
    for i in range(count):
        page = pdf.add_blank_page(page_size=size)
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            f"BT /F1 12 Tf 40 40 Td (ORIGINAL {i + 1}) Tj ET".encode("ascii")
        )
    pdf.save(path)
    pdf.close()


def _artwork(
    path: str,
    pages: int = 1,
    rotate: int | None = None,
    origin: tuple[float, float] = (0.0, 0.0),
    size: tuple[float, float] = (400.0, 200.0),
) -> None:
    """A board with a red bar down its LEFT third and a blue square at the
    BOTTOM-LEFT — asymmetric on both axes, so a rotation is readable — plus
    real text, so vector preservation is checkable by extraction."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica,
                   Encoding=Name.WinAnsiEncoding)
    )
    x0, y0 = origin
    w, h = size
    for i in range(pages):
        page = pdf.add_blank_page(page_size=(w, h))
        page.MediaBox = Array([x0, y0, x0 + w, y0 + h])
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = pdf.make_stream(
            (
                f"1 0 0 rg {x0} {y0} {w / 3:.2f} {h:.2f} re f "
                f"0 0 1 rg {x0 + 10} {y0 + 10} 30 30 re f "
                f"BT /F1 24 Tf {x0 + w / 2:.2f} {y0 + h / 2:.2f} Td (BOARD{i + 1}) Tj ET"
            ).encode("ascii")
        )
        if rotate is not None:
            page.Rotate = rotate
    pdf.save(path)
    pdf.close()


def _forms(page: pikepdf.Page) -> list:
    xo = page.obj.get("/Resources", {}).get("/XObject", {})
    return [f for _, f in (xo.items() if xo else []) if f.get("/Subtype") == Name.Form]


def _lifted(pdf: pikepdf.Pdf) -> list:
    """Every lifted-page form reachable through a watermark form's resources."""
    seen = {}
    for page in pdf.pages:
        for form in _forms(page):
            inner = form.get("/Resources", {}).get("/XObject", {})
            for _, candidate in (inner.items() if inner else []):
                if candidate.get("/Subtype") == Name.Form:
                    seen[candidate.objgen] = candidate
    return list(seen.values())


def _images(pdf: pikepdf.Pdf) -> list:
    found = {}

    def walk(obj, depth=0):
        if depth > 6:
            return
        xo = obj.get("/Resources", {}).get("/XObject", {})
        for _, candidate in (xo.items() if xo else []):
            if candidate.get("/Subtype") == Name.Image:
                found[candidate.objgen] = candidate
            else:
                walk(candidate, depth + 1)

    for page in pdf.pages:
        walk(page.obj)
    return list(found.values())


def _cm_operands(form) -> list[list[float]]:
    out = []
    for operands, operator in pikepdf.parse_content_stream(form):
        if str(operator) == "cm":
            out.append([float(v) for v in operands])
    return out


def _render(gs_path, source, target, dpi=36):
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         f"-r{dpi}", "-o", str(target), str(source)],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )


def _gray(path):
    import numpy as np
    from PIL import Image

    with Image.open(path) as image:
        return np.asarray(image.convert("L")).astype(np.int16)


def _ink(path):
    return _gray(path) < 200


def _quadrants(mask) -> dict:
    h, w = mask.shape
    half_h, half_w = h // 2, w // 2
    return {
        "top-left": int(mask[:half_h, :half_w].sum()),
        "top-right": int(mask[:half_h, half_w:].sum()),
        "bottom-left": int(mask[half_h:, :half_w].sum()),
        "bottom-right": int(mask[half_h:, half_w:].sum()),
    }


# ── the pin ────────────────────────────────────────────────────────────────


class TestOneEmbed:
    def test_the_page_lifts_once_for_the_whole_document(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=8)
        _artwork(art)

        result = watermark(file=src, output=out, pdf_source=art)
        assert result["pages_watermarked"] == 8
        assert result["source"] == "pdf"
        assert result["pdf_pages"] == 1
        assert result["pdf_page_used"] == 1

        with pikepdf.open(out) as pdf:
            lifted = _lifted(pdf)
            assert len(lifted) == 1, "the source page must lift exactly once"
            target = lifted[0].objgen
            for page in pdf.pages:
                form = _forms(page)[0]
                assert form.Resources.XObject.Fm0.objgen == target

    def test_the_chosen_page_is_the_one_lifted(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src)
        _artwork(art, pages=3)

        result = watermark(file=src, output=out, pdf_source=art, pdf_page=3)
        assert result["pdf_pages"] == 3
        assert result["pdf_page_used"] == 3
        assert "BOARD3" in extract_text(out)["text"]
        assert "BOARD1" not in extract_text(out)["text"]

    def test_the_original_content_survives(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src)
        _artwork(art)
        watermark(file=src, output=out, pdf_source=art)
        text = extract_text(out)["text"]
        assert "ORIGINAL 1" in text
        assert "ORIGINAL 2" in text


# ── the as_form_xobject trap ───────────────────────────────────────────────


class TestLiftDoesNotAliasTheSource:
    def test_pikepdfs_own_helper_still_tracks_the_page_content_stream(self, tmp_dir):
        """The trap the hand-built lift exists to avoid, reproduced.

        `Page.as_form_xobject()` returns a stream whose OBJGEN differs from the
        page's /Contents — an object-identity check reports "not aliased" and is
        wrong. Its DATA still follows a later replacement of the page's content.
        If this ever stops being true the lift may simplify; until then the
        by-hand build is load-bearing and this test says why.
        """
        art = os.path.join(tmp_dir, "art.pdf")
        _artwork(art)
        with pikepdf.open(art) as pdf:
            page = pdf.pages[0]
            form = pdf.make_indirect(page.as_form_xobject())
            assert form.objgen != page.obj.Contents.objgen
            page.Contents = pdf.make_stream(b"0 1 0 rg 0 0 400 200 re f")
            assert b"0 1 0 rg" in bytes(form.read_bytes())

    def test_the_lift_does_not_alias_the_source_page_content_stream(self, tmp_dir):
        """The regression: the engine's lift copies the bytes."""
        from engine.watermark import _lift_page

        art = os.path.join(tmp_dir, "art.pdf")
        _artwork(art)
        with pikepdf.open(art) as pdf:
            form, _, _ = _lift_page(pdf, 0, art, 1)
            before = bytes(form.read_bytes())
            pdf.pages[0].Contents = pdf.make_stream(b"0 1 0 rg 0 0 400 200 re f")
            assert bytes(form.read_bytes()) == before
            assert b"1 0 0 rg" in before

    def test_the_lift_leaves_the_source_resources_alone(self, tmp_dir):
        """Registering the annotation appearances must not reach the source."""
        from engine.watermark import _lift_page

        art = os.path.join(tmp_dir, "art.pdf")
        _annotated(art)
        with pikepdf.open(art) as pdf:
            before = sorted(
                str(k) for k in (pdf.pages[0].obj.Resources.get("/XObject") or {}).keys()
            )
            _lift_page(pdf, 0, art, 1)
            after = sorted(
                str(k) for k in (pdf.pages[0].obj.Resources.get("/XObject") or {}).keys()
            )
            assert before == after


# ── vector preservation ────────────────────────────────────────────────────


class TestVectorPreserved:
    def test_nothing_is_rasterized(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src)
        _artwork(art)
        watermark(file=src, output=out, pdf_source=art)
        with pikepdf.open(out) as pdf:
            assert _images(pdf) == [], "a lifted page must not become a picture"
            body = bytes(_lifted(pdf)[0].read_bytes())
            # The source's own path operators, verbatim.
            assert b" re f" in body
            assert b"1 0 0 rg" in body

    def test_the_lifted_pages_text_stays_extractable(self, tmp_dir):
        """A consequence of vector preservation, not a defect: a watermark
        drawn as real text IS real text, exactly as the text arm's is."""
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src)
        _artwork(art)
        watermark(file=src, output=out, pdf_source=art)
        assert "BOARD1" in extract_text(out)["text"]

    def test_the_lift_carries_a_transparency_group(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src)
        _artwork(art)
        watermark(file=src, output=out, pdf_source=art)
        with pikepdf.open(out) as pdf:
            group = _lifted(pdf)[0].get("/Group")
            assert group is not None
            assert group.get("/S") == Name.Transparency
            # An isolated group would REQUIRE a blending space, and naming one
            # pushes non-RGB artwork through it.
            assert "/CS" not in group

    def test_overlapping_artwork_gets_a_uniform_alpha(self, tmp_dir, gs):
        """The reason the group is there. Without it an /ExtGState alpha
        applies per painting operation and the overlap composites twice."""
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "overlap.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=1, size=(400, 200))
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        page.Contents = pdf.make_stream(
            b"0 0 0 rg 0 0 200 200 re f 0 0 0 rg 100 0 200 200 re f"
        )
        pdf.save(art)
        pdf.close()

        watermark(
            file=src, output=out, pdf_source=art, opacity=0.5, angle=0, scale=1.0
        )
        png = os.path.join(tmp_dir, "overlap.png")
        _render(gs, out, png, dpi=72)
        g = _gray(png)
        row = g.shape[0] // 2
        # The stamp spans 65% of a 400x200 page centred: x 70..330 at 72 dpi.
        single = g[row, 90:120].mean()
        double = g[row, 200:230].mean()
        assert single < 200, "the stamp did not land where the sample looks"
        assert abs(single - double) < 6, (
            f"the overlap composited twice: {single:.1f} vs {double:.1f}"
        )


# ── the source page's own /Rotate ──────────────────────────────────────────


class TestSourceRotate:
    @pytest.mark.parametrize(
        "rotate,expected",
        [(0, "left"), (90, "top"), (180, "right"), (270, "bottom")],
    )
    def test_the_sources_rotate_is_honoured(self, tmp_dir, gs, rotate, expected):
        """The red bar runs down the source's LEFT third. /Rotate turns the
        page clockwise, so the bar reads left / top / right / bottom as the
        SOURCE's own reader sees it. Rendering is the only non-circular proof
        that the /Matrix means what the code intends."""
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, f"out{rotate}.pdf")
        _target(src, count=1, size=(400, 400))
        _artwork(art, rotate=rotate)
        watermark(file=src, output=out, pdf_source=art, angle=0, opacity=1.0)
        png = os.path.join(tmp_dir, f"r{rotate}.png")
        _render(gs, out, png, dpi=72)

        import numpy as np
        from PIL import Image

        with Image.open(png) as image:
            rgb = np.asarray(image.convert("RGB")).astype(np.int16)
        red = (rgb[:, :, 0] > 180) & (rgb[:, :, 1] < 90) & (rgb[:, :, 2] < 90)
        ys, xs = np.nonzero(red)
        assert len(xs) > 100, "no red bar rendered"
        h, w = red.shape
        cx, cy = xs.mean(), ys.mean()
        # Image rows grow DOWNWARD, so a small mean row is the page's top.
        side = {
            "left": cx < w / 2 and abs(cy - h / 2) < h / 8,
            "right": cx > w / 2 and abs(cy - h / 2) < h / 8,
            "top": cy < h / 2 and abs(cx - w / 2) < w / 8,
            "bottom": cy > h / 2 and abs(cx - w / 2) < w / 8,
        }
        assert side[expected], f"/Rotate {rotate}: bar centred at ({cx:.0f}, {cy:.0f})"

    def test_a_non_zero_crop_origin_lands_identically(self, tmp_dir, gs):
        """The check that the /Matrix's translation term is not missing."""
        src = os.path.join(tmp_dir, "in.pdf")
        _target(src, count=1, size=(400, 400))
        masks = []
        for tag, origin in (("zero", (0.0, 0.0)), ("offset", (37.0, 91.0))):
            art = os.path.join(tmp_dir, f"art-{tag}.pdf")
            out = os.path.join(tmp_dir, f"out-{tag}.pdf")
            png = os.path.join(tmp_dir, f"{tag}.png")
            _artwork(art, origin=origin)
            watermark(file=src, output=out, pdf_source=art, angle=0, opacity=1.0)
            _render(gs, out, png, dpi=72)
            masks.append(_ink(png))
        assert masks[0].shape == masks[1].shape
        differing = int((masks[0] != masks[1]).sum())
        assert differing == 0, f"{differing} pixels moved with the crop origin"

    def test_the_sources_rotate_swaps_the_drawn_aspect(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out0 = os.path.join(tmp_dir, "out0.pdf")
        out90 = os.path.join(tmp_dir, "out90.pdf")
        _target(src, count=1, size=(400, 400))
        flat = os.path.join(tmp_dir, "flat.pdf")
        turned = os.path.join(tmp_dir, "turned.pdf")
        _artwork(flat)
        _artwork(turned, rotate=90)
        watermark(file=src, output=out0, pdf_source=flat, angle=0)
        watermark(file=src, output=out90, pdf_source=turned, angle=0)

        def drawn(path):
            with pikepdf.open(path) as pdf:
                form = _forms(pdf.pages[0])[0]
                lifted = form.Resources.XObject.Fm0
                bbox = [float(v) for v in lifted.BBox]
                a, b, c, d, _, _ = _cm_operands(form)[0]
                unit_w, unit_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
                return (abs(a), abs(d), unit_w, unit_h)

        wide = drawn(out0)
        tall = drawn(out90)
        # The BBox is the source's own crop box either way; the DRAWN extent
        # (matrix term x unit span) is what /Rotate swaps.
        assert wide[0] * wide[2] > wide[1] * wide[3]
        assert tall[0] * tall[3] < tall[1] * tall[2]


# ── annotations on the source page ─────────────────────────────────────────


def _annotated(path: str, hidden: bool = False) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 200))
    page.Resources = Dictionary(XObject=Dictionary())
    page.Contents = pdf.make_stream(b"0 0 1 rg 0 0 40 40 re f")
    ap = pdf.make_stream(b"1 0 0 rg 0 0 100 50 re f")
    ap.Type, ap.Subtype, ap.FormType = Name.XObject, Name.Form, 1
    ap.BBox = Array([0, 0, 100, 50])
    ap.Resources = Dictionary()
    annot = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name("/Stamp"),
            Rect=Array([200, 100, 380, 190]),
            F=2 if hidden else 4,
            AP=Dictionary(N=pdf.make_indirect(ap)),
        )
    )
    page.obj["/Annots"] = Array([annot])
    pdf.save(path)
    pdf.close()


class TestSourceAnnotations:
    def test_a_visible_annotation_is_lifted_with_the_page(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=1)
        _annotated(art)
        watermark(file=src, output=out, pdf_source=art)
        with pikepdf.open(out) as pdf:
            lifted = _lifted(pdf)[0]
            names = sorted(str(k) for k in lifted.Resources.XObject.keys())
            assert any(n.startswith("/WmAp") for n in names), names
            assert b"/WmAp0 Do" in bytes(lifted.read_bytes())

    def test_a_hidden_annotation_is_not(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=1)
        _annotated(art, hidden=True)
        watermark(file=src, output=out, pdf_source=art)
        with pikepdf.open(out) as pdf:
            assert b"/WmAp" not in bytes(_lifted(pdf)[0].read_bytes())

    def test_the_appearance_matrix_is_honoured(self, tmp_dir):
        """A freetext appearance counter-rotates through its own /Matrix, so
        the placement must transform the BBox before mapping it onto /Rect —
        the identity-Matrix shortcut would scale by the wrong span."""
        from engine.watermark import _lift_page

        art = os.path.join(tmp_dir, "art.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        ap = pdf.make_stream(b"1 0 0 rg 0 0 100 50 re f")
        ap.Type, ap.Subtype, ap.FormType = Name.XObject, Name.Form, 1
        ap.BBox = Array([0, 0, 100, 50])
        # A quarter turn: the transformed span is 50 wide by 100 tall.
        ap.Matrix = Array([0, 1, -1, 0, 0, 0])
        ap.Resources = Dictionary()
        page.obj["/Annots"] = Array([
            pdf.make_indirect(Dictionary(
                Type=Name.Annot, Subtype=Name("/Stamp"),
                Rect=Array([0, 0, 50, 100]), F=4,
                AP=Dictionary(N=pdf.make_indirect(ap)),
            ))
        ])
        pdf.save(art)
        pdf.close()

        with pikepdf.open(art) as source:
            form, _, _ = _lift_page(source, 0, art, 1)
            ops = _cm_operands(form)
        assert ops, "no appearance was placed"
        a, _, _, d, _, _ = ops[-1]
        # 50/50 and 100/100 — an identity-Matrix reading would give 0.5 and 2.
        assert a == pytest.approx(1.0, abs=1e-4)
        assert d == pytest.approx(1.0, abs=1e-4)


# ── placement, shared with the other sources ───────────────────────────────


class TestPlacement:
    @pytest.mark.parametrize(
        "position,inked,empty",
        [
            ("top-left", "top-left", "bottom-right"),
            ("bottom-right", "bottom-right", "top-left"),
        ],
    )
    def test_a_corner_position_inks_that_corner(
        self, tmp_dir, gs, position, inked, empty
    ):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, f"{position}.pdf")
        _target(src, count=1, size=(400, 400))
        _artwork(art)
        watermark(
            file=src, output=out, pdf_source=art, position=position,
            scale=0.4, angle=0, opacity=1.0,
        )
        png = os.path.join(tmp_dir, f"{position}.png")
        _render(gs, out, png, dpi=72)
        counts = _quadrants(_ink(png))
        assert counts[inked] > 500, counts
        assert counts[empty] < 50, counts

    def test_tiling_inks_every_quadrant(self, tmp_dir, gs):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "tiled.pdf")
        _target(src, count=1, size=(400, 400))
        _artwork(art)
        result = watermark(
            file=src, output=out, pdf_source=art, tile=True, scale=0.2,
            angle=0, opacity=1.0,
        )
        assert result["tiles_per_page"] > 3
        png = os.path.join(tmp_dir, "tiled.png")
        _render(gs, out, png, dpi=72)
        counts = _quadrants(_ink(png))
        assert all(v > 200 for v in counts.values()), counts

    def test_scale_multiplies_the_drawn_size_linearly(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1)
        _artwork(art)

        def drawn(scale):
            out = os.path.join(tmp_dir, f"s{scale}.pdf")
            watermark(file=src, output=out, pdf_source=art, scale=scale, angle=0)
            with pikepdf.open(out) as pdf:
                return abs(_cm_operands(_forms(pdf.pages[0])[0])[0][0])

        assert drawn(1.0) == pytest.approx(drawn(0.5) * 2, rel=1e-3)

    def test_the_under_layer_draws_beneath_the_existing_content(self, tmp_dir, gs):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1, size=(400, 400))
        _artwork(art)
        over = os.path.join(tmp_dir, "over.pdf")
        under = os.path.join(tmp_dir, "under.pdf")
        watermark(file=src, output=over, pdf_source=art, layer="over", opacity=1.0)
        watermark(file=src, output=under, pdf_source=art, layer="under", opacity=1.0)
        for path, tag in ((over, "over"), (under, "under")):
            _render(gs, path, os.path.join(tmp_dir, f"{tag}.png"), dpi=72)
        # The body text survives at full strength only when the stamp is under.
        assert _ink(os.path.join(tmp_dir, "under.png")).sum() > 0
        with pikepdf.open(over) as pdf:
            names = list(pikepdf.parse_content_stream(pdf.pages[0]))
        assert names, "the overlay wrote no content"

    def test_a_page_selection_is_honoured(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=4)
        _artwork(art)
        result = watermark(file=src, output=out, pdf_source=art, pages=[2, 4])
        assert result["pages_watermarked"] == 2
        with pikepdf.open(out) as pdf:
            assert [len(_forms(p)) for p in pdf.pages] == [0, 1, 0, 1]

    def test_every_position_is_accepted(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1)
        _artwork(art)
        for position in POSITIONS:
            out = os.path.join(tmp_dir, f"p-{position}.pdf")
            result = watermark(
                file=src, output=out, pdf_source=art, position=position, scale=0.3
            )
            assert result["pages_watermarked"] == 1


# ── nesting, and in-place output ───────────────────────────────────────────


class TestSourceShapes:
    def test_a_source_page_of_nested_forms_lifts_whole(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "nested.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=1)
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        inner = pdf.make_stream(b"1 0 0 rg 0 0 100 200 re f")
        inner.Type, inner.Subtype, inner.FormType = Name.XObject, Name.Form, 1
        inner.BBox = Array([0, 0, 400, 200])
        inner.Resources = Dictionary()
        inner = pdf.make_indirect(inner)
        mid = pdf.make_stream(b"q /In Do Q 0 0 1 rg 10 10 30 30 re f")
        mid.Type, mid.Subtype, mid.FormType = Name.XObject, Name.Form, 1
        mid.BBox = Array([0, 0, 400, 200])
        mid.Resources = Dictionary(XObject=Dictionary(In=inner))
        mid = pdf.make_indirect(mid)
        page.Resources = Dictionary(XObject=Dictionary(Mid=mid))
        page.Contents = pdf.make_stream(b"q /Mid Do Q")
        pdf.save(art)
        pdf.close()

        watermark(file=src, output=out, pdf_source=art)
        with pikepdf.open(out) as result:
            lifted = _lifted(result)[0]
            reached = lifted.Resources.XObject
            assert "/Mid" in [str(k) for k in reached.keys()]
            deepest = reached[Name("/Mid")].Resources.XObject
            assert "/In" in [str(k) for k in deepest.keys()]

    def test_a_source_page_with_inherited_resources_lifts(self, tmp_dir):
        """/Resources is an inheritable page attribute; reading page.obj alone
        would lift a page whose font resolves to nothing."""
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "inherited.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=1)
        _artwork(art)
        with pikepdf.open(art, allow_overwriting_input=True) as pdf:
            page = pdf.pages[0]
            resources = page.obj.Resources
            del page.obj["/Resources"]
            pdf.Root.Pages["/Resources"] = resources
            pdf.save(art)

        watermark(file=src, output=out, pdf_source=art)
        with pikepdf.open(out) as pdf:
            assert "/Font" in [str(k) for k in _lifted(pdf)[0].Resources.keys()]
        assert "BOARD1" in extract_text(out)["text"]

    def test_in_place_output_works(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=2)
        _artwork(art)
        result = watermark(file=src, output=src, pdf_source=art)
        assert result["pages_watermarked"] == 2
        with pikepdf.open(src) as pdf:
            assert len(_lifted(pdf)) == 1


# ── refusals ───────────────────────────────────────────────────────────────


class TestRefusals:
    def test_two_sources_refuse(self, tmp_dir):
        art = os.path.join(tmp_dir, "art.pdf")
        _artwork(art)
        with pytest.raises(ValueError, match="a watermark has one source"):
            watermark(file="x.pdf", output="y.pdf", text="X", pdf_source=art)

    def test_no_source_refuses(self):
        with pytest.raises(ValueError, match="needs text, an image or a PDF page"):
            watermark(file="x.pdf", output="y.pdf")

    def test_a_pdf_in_the_image_slot_points_at_the_pdf_source(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1)
        _artwork(art)
        with pytest.raises(ValueError, match="a watermark source of its own"):
            watermark(file=src, output=os.path.join(tmp_dir, "o.pdf"), image=art)

    def test_a_missing_source_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _target(src, count=1)
        missing = os.path.join(tmp_dir, "nope.pdf")
        with pytest.raises(ValueError, match="watermark PDF not found"):
            watermark(file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=missing)

    def test_an_empty_source_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _target(src, count=1)
        empty = os.path.join(tmp_dir, "empty.pdf")
        open(empty, "wb").close()
        with pytest.raises(ValueError, match="watermark PDF is empty"):
            watermark(file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=empty)

    def test_a_page_below_one_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1)
        _artwork(art)
        with pytest.raises(ValueError, match="must be 1 or greater"):
            watermark(
                file=src, output=os.path.join(tmp_dir, "o.pdf"),
                pdf_source=art, pdf_page=0,
            )

    def test_a_page_past_the_end_refuses_with_the_count(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1)
        _artwork(art, pages=2)
        with pytest.raises(ValueError, match="is out of range .* has 2 pages"):
            watermark(
                file=src, output=os.path.join(tmp_dir, "o.pdf"),
                pdf_source=art, pdf_page=3,
            )

    def test_a_zero_page_source_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "empty-doc.pdf")
        _target(src, count=1)
        pdf = pikepdf.new()
        pdf.save(art)
        pdf.close()
        with pytest.raises(ValueError, match="has no pages"):
            watermark(file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=art)

    def test_an_encrypted_source_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        locked = os.path.join(tmp_dir, "locked.pdf")
        _target(src, count=1)
        _artwork(art)
        with pikepdf.open(art) as pdf:
            pdf.save(locked, encryption=pikepdf.Encryption(owner="o", user="u", R=6))
        with pytest.raises(ValueError, match="password protected"):
            watermark(file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=locked)

    def test_a_non_pdf_source_refuses_as_unreadable(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        junk = os.path.join(tmp_dir, "junk.pdf")
        _target(src, count=1)
        with open(junk, "wb") as fh:
            fh.write(b"this is not a PDF at all")
        with pytest.raises(ValueError, match="unreadable watermark PDF"):
            watermark(file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=junk)

    def test_a_document_cannot_watermark_itself(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _target(src, count=1)
        with pytest.raises(ValueError, match="its own watermark source"):
            watermark(
                file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=src
            )

    def test_the_identity_check_sees_through_a_second_spelling(self, tmp_dir):
        """Identity, not a string compare: `in.pdf` and `.\\in.pdf` are one
        file, and a string guard would let the second through."""
        src = os.path.join(tmp_dir, "in.pdf")
        _target(src, count=1)
        alias = os.path.join(tmp_dir, ".", "in.pdf")
        assert alias != src
        with pytest.raises(ValueError, match="its own watermark source"):
            watermark(
                file=src, output=os.path.join(tmp_dir, "o.pdf"), pdf_source=alias
            )

    def test_the_source_cannot_be_the_output(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        art = os.path.join(tmp_dir, "art.pdf")
        _target(src, count=1)
        _artwork(art)
        with pytest.raises(ValueError, match="the same file"):
            watermark(file=src, output=art, pdf_source=art)

    def test_a_source_page_without_a_box_refuses_by_name(self, tmp_dir):
        """Driven at the lift, not through a file: qpdf writes a default
        /MediaBox back onto a boxless page at save time, so a saved fixture
        cannot carry the condition the refusal exists for."""
        from engine.watermark import _lift_page

        art = os.path.join(tmp_dir, "boxless.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        del page.obj["/MediaBox"]
        with pytest.raises(ValueError, match="has no /CropBox or /MediaBox"):
            _lift_page(pdf, 0, art, 1)
        pdf.close()

    def test_a_zero_area_source_page_refuses_by_name(self, tmp_dir):
        from engine.watermark import _lift_page

        art = os.path.join(tmp_dir, "flat.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 200))
        page.MediaBox = Array([0, 0, 400, 0])
        with pytest.raises(ValueError, match="has no area"):
            _lift_page(pdf, 0, art, 1)
        pdf.close()


# ── the other arms are untouched ───────────────────────────────────────────


class TestOtherArmsUnchanged:
    def test_the_text_arms_emission_is_unchanged(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _target(src, count=1)
        result = watermark(file=src, output=out, text="DRAFT")
        assert result["source"] == "text"
        assert result["pdf_pages"] == 0
        assert result["pdf_page_used"] == 0
        with pikepdf.open(out) as pdf:
            body = bytes(_forms(pdf.pages[0])[0].read_bytes())
        assert b"BT /F0 " in body
        assert b"(DRAFT) Tj" in body

    def test_the_image_arms_emission_is_unchanged(self, tmp_dir):
        from PIL import Image

        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _target(src, count=1)
        Image.new("RGB", (120, 60), (220, 30, 30)).save(logo)
        result = watermark(file=src, output=out, image=logo, angle=0)
        assert result["source"] == "image"
        assert result["pdf_pages"] == 0
        with pikepdf.open(out) as pdf:
            form = _forms(pdf.pages[0])[0]
            body = bytes(form.read_bytes())
            operands = _cm_operands(form)[0]
        assert b"/Im0 Do" in body
        # An Image XObject's own space IS the unit square, so the shared
        # emitter's unit normalization must divide by 1: the matrix carries the
        # DRAWN size directly, at the picture's own 2:1 aspect.
        assert operands[0] == pytest.approx(2 * operands[3], rel=1e-6)
        assert operands[0] == pytest.approx(0.65 * 400, rel=1e-6)
        assert operands[1] == 0 and operands[2] == 0
