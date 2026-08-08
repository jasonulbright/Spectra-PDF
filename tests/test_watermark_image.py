"""Image watermarks: one embed per document, placement, tiling.

The text arm's own behaviour is covered by TestWatermark in test_engine.py;
this file covers the image source, the placement controls both sources now
share, and the pin the whole design exists for — ONE Image XObject in the
file however many pages reference it.
"""

import os
import subprocess

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.extract_text import extract_text
from engine.watermark import MAX_TILES, POSITIONS, watermark

GS_PATH = os.path.join(
    os.path.dirname(__file__), "..", "resources", "ghostscript", "gswin64c.exe"
)


@pytest.fixture
def gs():
    if not os.path.isfile(GS_PATH):
        pytest.skip("Ghostscript not available")
    return GS_PATH


def _pages(path: str, count: int = 2, size=(400, 400), rotate: int | None = None) -> None:
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
        if rotate is not None:
            page.Rotate = rotate
    pdf.save(path)
    pdf.close()


def _logo(path: str, size=(120, 60), color=(220, 30, 30), frames: int = 1) -> None:
    from PIL import Image

    # Distinct frames: an encoder that sees identical ones may write a single
    # frame, and the fixture would stop testing what it claims to.
    images = [
        Image.new("RGB", size, (color[0], color[1], (color[2] + 40 * i) % 256))
        for i in range(max(frames, 1))
    ]
    if frames > 1:
        images[0].save(path, save_all=True, append_images=images[1:])
    else:
        images[0].save(path)


def _image_xobjects(pdf: pikepdf.Pdf) -> list:
    """Every Image XObject reachable from any page's form resources."""
    seen = {}
    for page in pdf.pages:
        xo = page.obj.get("/Resources", {}).get("/XObject", {})
        for _, form in (xo.items() if xo else []):
            inner = form.get("/Resources", {}).get("/XObject", {})
            for _, candidate in (inner.items() if inner else []):
                if candidate.get("/Subtype") == Name.Image:
                    seen[candidate.objgen] = candidate
    return list(seen.values())


def _forms(page: pikepdf.Page) -> list:
    xo = page.obj.get("/Resources", {}).get("/XObject", {})
    return [f for _, f in (xo.items() if xo else []) if f.get("/Subtype") == Name.Form]


def _cm_operands(form) -> list[list[float]]:
    out = []
    for operands, operator in pikepdf.parse_content_stream(form):
        if str(operator) == "cm":
            out.append([float(v) for v in operands])
    return out


# ── the pin ───────────────────────────────────────────────────────────────


class TestOneEmbed:
    def test_the_image_embeds_once_for_the_whole_document(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=8)
        _logo(logo)

        result = watermark(file=src, output=out, image=logo)
        assert result["pages_watermarked"] == 8
        assert result["source"] == "image"

        with pikepdf.open(out) as pdf:
            images = _image_xobjects(pdf)
            assert len(images) == 1, "the picture must embed exactly once"
            # Every page's form points at THAT object, not a copy of it.
            target = images[0].objgen
            for page in pdf.pages:
                form = _forms(page)[0]
                assert form.Resources.XObject.Im0.objgen == target

    def test_the_original_content_survives(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src)
        _logo(logo)
        watermark(file=src, output=out, image=logo)
        text = extract_text(out)["text"]
        assert "ORIGINAL 1" in text
        assert "ORIGINAL 2" in text


# ── round trip ────────────────────────────────────────────────────────────


class TestImageRoundTrip:
    def test_opacity_lands_in_the_shared_extgstate(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        watermark(file=src, output=out, image=logo, opacity=0.4)
        with pikepdf.open(out) as pdf:
            gs = _forms(pdf.pages[0])[0].Resources.ExtGState.GS0
            assert float(gs.ca) == pytest.approx(0.4)
            assert float(gs.CA) == pytest.approx(0.4)

    def test_scale_multiplies_the_drawn_size_linearly(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        sizes = []
        for scale in (0.5, 1.0):
            out = os.path.join(tmp_dir, f"out{scale}.pdf")
            watermark(file=src, output=out, image=logo, angle=0, scale=scale)
            with pikepdf.open(out) as pdf:
                a, b, c, d, _, _ = _cm_operands(_forms(pdf.pages[0])[0])[0]
                sizes.append((a, d))
        assert sizes[1][0] == pytest.approx(sizes[0][0] * 2, rel=1e-3)
        assert sizes[1][1] == pytest.approx(sizes[0][1] * 2, rel=1e-3)

    def test_the_aspect_ratio_is_preserved(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo, size=(200, 50))
        watermark(file=src, output=out, image=logo, angle=0)
        with pikepdf.open(out) as pdf:
            a, _, _, d, _, _ = _cm_operands(_forms(pdf.pages[0])[0])[0]
            assert a / d == pytest.approx(200 / 50, rel=1e-3)

    def test_the_matrix_carries_the_requested_rotation(self, tmp_dir):
        import math

        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo, size=(100, 100))
        watermark(file=src, output=out, image=logo, angle=30)
        with pikepdf.open(out) as pdf:
            a, b, _, _, _, _ = _cm_operands(_forms(pdf.pages[0])[0])[0]
            assert math.degrees(math.atan2(b, a)) == pytest.approx(30, abs=0.05)

    def test_a_rotated_page_takes_the_angle_as_given(self, tmp_dir):
        """`add_overlay` supplies the /Rotate part of the turn in its
        placement matrix, so the stamp is drawn at the requested angle and
        nothing else — adding /Rotate here would turn it twice."""
        import math

        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1, rotate=90)
        _logo(logo, size=(100, 100))
        watermark(file=src, output=out, image=logo, angle=0)
        with pikepdf.open(out) as pdf:
            a, b, _, _, _, _ = _cm_operands(_forms(pdf.pages[0])[0])[0]
            assert math.degrees(math.atan2(b, a)) == pytest.approx(0, abs=0.05)

    def test_the_form_box_is_the_displayed_box(self, tmp_dir):
        """A BBox in un-rotated dimensions makes qpdf fit the form by
        min(W/H, H/W) on a rotated non-square page — the stamp shrinks."""
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _logo(logo)
        for rotate, expected in ((0, [600, 400]), (90, [400, 600]),
                                 (180, [600, 400]), (270, [400, 600])):
            _pages(src, count=1, size=(600, 400), rotate=rotate)
            out = os.path.join(tmp_dir, f"box{rotate}.pdf")
            watermark(file=src, output=out, image=logo)
            with pikepdf.open(out) as pdf:
                box = [float(v) for v in _forms(pdf.pages[0])[0].BBox]
                assert box[2:] == expected, rotate
                # Fit-scale 1: the placement matrix carries no scale term.
                page_cm = [
                    ops for ops, op in pikepdf.parse_content_stream(pdf.pages[0])
                    if str(op) == "cm"
                ]
                for ops in page_cm:
                    a, b, c, d = (float(v) for v in ops[:4])
                    assert max(abs(a), abs(b)) == pytest.approx(1.0)
                    assert max(abs(c), abs(d)) == pytest.approx(1.0)

    def test_under_layer_keeps_the_content_on_top(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        result = watermark(file=src, output=out, image=logo, layer="under")
        assert result["layer"] == "under"
        assert "ORIGINAL 1" in extract_text(out)["text"]

    def test_a_multi_frame_source_uses_the_first_and_says_so(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.gif")
        _pages(src, count=1)
        _logo(logo, frames=3)
        result = watermark(file=src, output=out, image=logo)
        assert result["image_frames"] == 3
        with pikepdf.open(out) as pdf:
            assert len(_image_xobjects(pdf)) == 1

    def test_the_page_selection_still_applies(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=3)
        _logo(logo)
        result = watermark(file=src, output=out, image=logo, pages=[2])
        assert result["pages_watermarked"] == 1
        with pikepdf.open(out) as pdf:
            assert _forms(pdf.pages[0]) == []
            assert len(_forms(pdf.pages[1])) == 1

    def test_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        watermark(file=src, output=src, image=logo)
        with pikepdf.open(src) as pdf:
            assert len(_image_xobjects(pdf)) == 1


# ── placement, proved by rendering ────────────────────────────────────────


def _render(gs_path, source, target, dpi=72):
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         f"-r{dpi}", "-o", str(target), str(source)],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )


def _quadrant_ink(png: str) -> dict:
    """Non-white pixel counts per quadrant of the rendered page."""
    import numpy as np
    from PIL import Image

    with Image.open(png) as image:
        grey = np.asarray(image.convert("L")).astype(np.int16)
    ink = grey < 240
    h, w = ink.shape
    mh, mw = h // 2, w // 2
    return {
        "top-left": int(ink[:mh, :mw].sum()),
        "top-right": int(ink[:mh, mw:].sum()),
        "bottom-left": int(ink[mh:, :mw].sum()),
        "bottom-right": int(ink[mh:, mw:].sum()),
    }


class TestPlacement:
    """Rendering is the only non-circular proof that the matrix means what
    the code intends: a sign error in the displayed-to-user mapping produces
    a perfectly well-formed `cm` that puts the logo in the wrong corner."""

    def _ink(self, gs, tmp_dir, tag, **kwargs):
        src = os.path.join(tmp_dir, f"{tag}_in.pdf")
        out = os.path.join(tmp_dir, f"{tag}_out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        png = os.path.join(tmp_dir, f"{tag}.png")
        _pages(src, count=1, size=(400, 400))
        if not os.path.isfile(logo):
            _logo(logo, size=(100, 100))
        # A blank page: the only ink in the render is the stamp itself.
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            del pdf.pages[0].obj["/Contents"]
            pdf.save(src + ".blank.pdf")
        watermark(file=src + ".blank.pdf", output=out, image=logo, angle=0,
                  opacity=1.0, scale=0.4, **kwargs)
        _render(gs, out, png)
        return _quadrant_ink(png)

    @pytest.mark.parametrize(
        "position,expected,empty",
        [
            ("top-left", "top-left", "bottom-right"),
            ("top-right", "top-right", "bottom-left"),
            ("bottom-left", "bottom-left", "top-right"),
            ("bottom-right", "bottom-right", "top-left"),
        ],
    )
    def test_a_corner_position_puts_the_ink_in_that_corner(
        self, gs, tmp_dir, position, expected, empty
    ):
        ink = self._ink(gs, tmp_dir, position, position=position)
        assert ink[expected] > 0
        assert ink[empty] == 0
        assert ink[expected] == max(ink.values())

    def test_center_lands_in_no_corner_alone(self, gs, tmp_dir):
        ink = self._ink(gs, tmp_dir, "center", position="center")
        # A centred stamp straddles the midlines, so every quadrant carries
        # part of it and none carries all of it.
        assert min(ink.values()) > 0
        assert max(ink.values()) - min(ink.values()) <= 2

    def test_tiling_covers_every_quadrant(self, gs, tmp_dir):
        ink = self._ink(gs, tmp_dir, "tiled", tile=True)
        assert min(ink.values()) > 0
        untiled = self._ink(gs, tmp_dir, "untiled", position="center")
        assert sum(ink.values()) > sum(untiled.values())

    def test_a_rotated_page_names_the_corner_the_reader_sees(self, gs, tmp_dir):
        """`top-left` is the reader's top-left. On a /Rotate 90 page that is
        a different corner of user space, and the render is what proves the
        mapping rather than the arithmetic restating itself."""
        src = os.path.join(tmp_dir, "rot_in.pdf")
        out = os.path.join(tmp_dir, "rot_out.pdf")
        logo = os.path.join(tmp_dir, "rot_logo.png")
        png = os.path.join(tmp_dir, "rot.png")
        _logo(logo, size=(100, 100))
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 400))
        page.Rotate = 90
        pdf.save(src)
        pdf.close()
        watermark(file=src, output=out, image=logo, angle=0, opacity=1.0,
                  scale=0.4, position="top-left")
        _render(gs, out, png)
        ink = _quadrant_ink(png)
        assert ink["top-left"] > 0
        assert ink["bottom-right"] == 0


class TestTilingBounds:
    def test_a_tile_count_past_the_cap_refuses_by_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1, size=(2000, 2000))
        _logo(logo, size=(10, 10))
        with pytest.raises(ValueError, match=f"more than the {MAX_TILES} allowed"):
            watermark(file=src, output=out, image=logo, tile=True, scale=0.01,
                      tile_gap=0)

    def test_the_tile_count_is_reported(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        result = watermark(file=src, output=out, image=logo, tile=True, scale=0.25)
        assert result["tiles_per_page"] > 1
        with pikepdf.open(out) as pdf:
            assert len(_cm_operands(_forms(pdf.pages[0])[0])) == result["tiles_per_page"]


# ── the text arm keeps its shipped shape ──────────────────────────────────


class TestTextArmUnchanged:
    def test_the_default_emission_is_the_shipped_one(self, tmp_dir):
        """Default placement is centre, untiled — the shipped geometry, and
        the shipped content stream down to the operator sequence."""
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _pages(src, count=1)
        watermark(file=src, output=out, text="CONFIDENTIAL")
        with pikepdf.open(out) as pdf:
            body = _forms(pdf.pages[0])[0].read_bytes()
        assert body.startswith(b"q /GS0 gs ")
        assert body.endswith(b" ET Q")
        assert b") Tj" in body
        assert body.count(b"BT ") == 1

    def test_the_text_arm_takes_position_and_tiling_too(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _pages(src, count=1)
        result = watermark(file=src, output=out, text="DRAFT", tile=True,
                           font_size=10, angle=0)
        assert result["tiles_per_page"] > 1
        with pikepdf.open(out) as pdf:
            assert _forms(pdf.pages[0])[0].read_bytes().count(b"BT ") == result["tiles_per_page"]

    def test_a_corner_position_moves_the_text_matrix(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _pages(src, count=1)
        matrices = {}
        for position in ("center", "top-left", "bottom-right"):
            out = os.path.join(tmp_dir, f"{position}.pdf")
            watermark(file=src, output=out, text="DRAFT", font_size=12, angle=0,
                      position=position)
            with pikepdf.open(out) as pdf:
                for operands, operator in pikepdf.parse_content_stream(_forms(pdf.pages[0])[0]):
                    if str(operator) == "Tm":
                        matrices[position] = (float(operands[4]), float(operands[5]))
        assert matrices["top-left"][1] > matrices["center"][1] > matrices["bottom-right"][1]
        assert matrices["top-left"][0] < matrices["bottom-right"][0]


# ── refusals ──────────────────────────────────────────────────────────────


class TestRefusals:
    def test_both_sources_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        with pytest.raises(ValueError, match="either text or an image, not both"):
            watermark(file=src, output=src, text="X", image=logo)

    def test_no_source_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _pages(src, count=1)
        with pytest.raises(ValueError, match="needs text or an image"):
            watermark(file=src, output=src)
        with pytest.raises(ValueError, match="needs text or an image"):
            watermark(file=src, output=src, text="   ")

    def test_a_missing_image_refuses_by_path(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        _pages(src, count=1)
        with pytest.raises(ValueError, match="watermark image not found"):
            watermark(file=src, output=src, image=os.path.join(tmp_dir, "nope.png"))

    def test_an_empty_image_file_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "empty.png")
        _pages(src, count=1)
        open(logo, "wb").close()
        with pytest.raises(ValueError, match="watermark image is empty"):
            watermark(file=src, output=src, image=logo)

    def test_an_unsupported_type_refuses_and_names_the_accepted_set(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        other = os.path.join(tmp_dir, "note.txt")
        _pages(src, count=1)
        with open(other, "w") as fh:
            fh.write("not a picture")
        with pytest.raises(ValueError, match="watermark image type not supported"):
            watermark(file=src, output=src, image=other)

    def test_an_undecodable_image_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "broken.png")
        _pages(src, count=1)
        with open(logo, "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n" + b"garbage" * 4)
        with pytest.raises(ValueError, match="unreadable watermark image"):
            watermark(file=src, output=src, image=logo)

    @pytest.mark.parametrize("bad", [0, -1, "wide"])
    def test_a_bad_scale_refuses(self, tmp_dir, bad):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        with pytest.raises(ValueError, match="watermark scale must be"):
            watermark(file=src, output=src, image=logo, scale=bad)

    def test_a_bad_position_refuses_and_names_the_choices(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        with pytest.raises(ValueError, match="watermark position must be one of"):
            watermark(file=src, output=src, image=logo, position="middle")

    def test_negative_margin_and_gap_refuse(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        with pytest.raises(ValueError, match="margin must not be negative"):
            watermark(file=src, output=src, image=logo, margin=-1)
        with pytest.raises(ValueError, match="tile gap must not be negative"):
            watermark(file=src, output=src, image=logo, tile_gap=-1)

    def test_a_refusal_writes_nothing(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _pages(src, count=1)
        with pytest.raises(ValueError):
            watermark(file=src, output=out, image=os.path.join(tmp_dir, "nope.png"))
        assert not os.path.exists(out)

    def test_every_named_position_is_accepted(self, tmp_dir):
        src = os.path.join(tmp_dir, "in.pdf")
        logo = os.path.join(tmp_dir, "logo.png")
        _pages(src, count=1)
        _logo(logo)
        for position in POSITIONS:
            out = os.path.join(tmp_dir, f"p_{position}.pdf")
            result = watermark(file=src, output=out, image=logo, position=position)
            assert result["pages_watermarked"] == 1
