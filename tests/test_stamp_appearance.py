"""The visible signature stamp's appearance.

Two things are under test and they are different things: the APPEARANCE
BUILDER (what gets drawn, and that it draws the same bytes twice), and the
THREADING (that the appearance reaches every placement a signature has —
a new visible stamp, an existing-field fill, and the incremental append onto
a document that already carries a signature).

The determinism assertions are the `recalcTimestamp=False` invariant in its
stamp form: an appearance whose bytes differ run to run turns an in-place save
and its control into an order-dependent byte diff. A signed FILE legitimately
differs run to run (the signing time, the key's own randomness), so these
assert on the appearance content, which is the part that must not.
"""

import base64
import io
import os

import pikepdf
import pytest
from PIL import Image
from pyhanko.pdf_utils import layout
from pyhanko.pdf_utils.writer import PdfFileWriter

from engine import stamp_appearance as sa
from engine.signatures import sign_pdf, verify_signatures

from test_engine import _blank_pdf, _make_test_pfx, _pdf_with_sig_field  # noqa: F401

FONT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts")
BUNDLED_FACE = "GreatVibes-Regular.ttf"

needs_bundled_face = pytest.mark.skipif(
    not os.path.isfile(os.path.join(FONT_DIR, BUNDLED_FACE)),
    reason="capability axis: the bundled signature faces are not provisioned",
)


def _png(width: int = 120, height: int = 40, colour=(200, 30, 30)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), colour).save(buf, "PNG")
    return buf.getvalue()


def _png_b64(**kwargs) -> str:
    return base64.b64encode(_png(**kwargs)).decode("ascii")


def _render(spec, width=240, height=80, reason=None, location=None, signer="Jane Doe"):
    """The stamp's own content stream, drawn exactly as signing draws it."""
    appearance = sa.parse_appearance(spec, FONT_DIR)
    style = sa.stamp_style(reason, location, appearance)
    writer = PdfFileWriter()
    drawn = style.create_stamp(
        writer, layout.BoxConstraints(width, height), {"signer": signer}
    )
    return drawn.render()


class TestSpecification:
    def test_no_spec_is_the_stamp_signing_always_drew(self):
        # The one case that must produce the OLD style object rather than a
        # new one: an unconfigured signature is byte-for-byte what it was.
        from pyhanko.stamp import TextStampStyle

        style = sa.stamp_style("why", "where", sa.parse_appearance(None))
        assert type(style) is TextStampStyle
        assert style.stamp_text == (
            "Digitally signed by %(signer)s\n%(ts)s\nReason: why\nLocation: where"
        )

    def test_percent_in_user_text_cannot_reach_the_interpolation(self):
        style = sa.stamp_style("100% reviewed", None, sa.parse_appearance(None))
        assert "100%% reviewed" in style.stamp_text
        # And it survives the interpolation as one percent sign.
        assert (style.stamp_text % {"signer": "S", "ts": "T"}).endswith("100% reviewed")

    def test_the_request_chooses_the_lines_and_their_order(self):
        spec = {"fields": ["label", "name"], "label": "Approved"}
        style = sa.stamp_style("why", None, sa.parse_appearance(spec))
        assert style.stamp_text == "Approved\nDigitally signed by %(signer)s"

    def test_a_line_whose_value_is_empty_is_not_rendered_blank(self):
        spec = {"fields": ["name", "reason", "location", "label"]}
        style = sa.stamp_style(None, None, sa.parse_appearance(spec))
        assert style.stamp_text == "Digitally signed by %(signer)s"

    @pytest.mark.parametrize(
        "spec, fragment",
        [
            ({"fields": ["bogus"]}, "not a signature stamp line"),
            ({"layout": "sideways"}, "The stamp layout must be one of"),
            ({"image_position": "diagonal"}, "The image position must be one of"),
            ({"image": {"path": "no-such-file.png"}}, "could not be read"),
            ({"image": {"data": "not base64 at all!!"}}, "not valid image data"),
            ({"signature": {"form": "vector", "aspect": 0.4, "paths": []}}, "no strokes to draw"),
            ({"signature": {"form": "vector", "aspect": 0, "paths": [[0, 0, 1, 1]]}}, "no usable shape"),
            (
                {"signature": {"form": "typed", "aspect": 0.3, "typed": {"text": "x", "fontFile": "Nope.ttf"}}},
                "could not be read from the app's fonts folder",
            ),
            (
                {"signature": {"form": "typed", "aspect": 0.3, "typed": {"text": "x", "fontFile": "../escape.ttf"}}},
                "not one of the signature faces that ship with the app",
            ),
        ],
    )
    def test_every_refusal_is_named(self, spec, fragment):
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            sa.parse_appearance(spec, FONT_DIR)
        assert fragment in str(excinfo.value)

    def test_a_readable_raster_we_will_not_embed_is_its_own_refusal(self, tmp_path):
        gif = tmp_path / "logo.gif"
        Image.new("RGB", (8, 8), (0, 0, 0)).save(gif, "GIF")
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            sa.parse_appearance({"image": {"path": str(gif)}}, FONT_DIR)
        assert "is a GIF file" in str(excinfo.value)


class TestAppearanceBuilder:
    def test_an_over_layout_raster_becomes_the_background(self):
        style = sa.stamp_style(
            None, None, sa.parse_appearance({"image": {"data": _png_b64()}, "layout": "over"})
        )
        assert style.background is not None
        assert style.sidecars == ()

    def test_a_beside_layout_raster_becomes_a_sidecar(self):
        style = sa.stamp_style(
            None,
            None,
            sa.parse_appearance(
                {"image": {"data": _png_b64()}, "layout": "beside", "image_position": "right"}
            ),
        )
        assert style.background is None
        assert len(style.sidecars) == 1
        assert style.sidecars[0].position == "right"

    def test_the_raster_keeps_its_aspect_in_the_sidecar_band(self):
        # 120x40 is 3:1; the band's aspect is height/width.
        style = sa.stamp_style(
            None, None, sa.parse_appearance({"image": {"data": _png_b64(width=120, height=40)}, "layout": "beside"})
        )
        assert style.sidecars[0].aspect == pytest.approx(40 / 120)

    def test_a_signature_face_and_a_beside_raster_are_two_bands(self):
        spec = {
            "image": {"data": _png_b64()},
            "layout": "beside",
            "image_position": "right",
            "signature": {"form": "vector", "aspect": 0.4, "paths": [[0, 0, 0.5, 1, 1, 0]]},
            "signature_position": "left",
        }
        style = sa.stamp_style(None, None, sa.parse_appearance(spec))
        assert [s.position for s in style.sidecars] == ["left", "right"]

    def test_vector_ink_renders_as_vector_content_not_a_raster(self):
        spec = {"signature": {"form": "vector", "aspect": 0.4, "paths": [[0, 0, 0.5, 1, 1, 0]]}}
        face = sa.parse_appearance(spec).signature
        drawn = sa._FaceContent(face, 100.0, 40.0).render()
        # Path construction and a stroke, and no image XObject anywhere.
        assert b" m " in drawn and b" l " in drawn and drawn.rstrip().endswith(b"Q")
        assert b"S" in drawn
        assert b"Do" not in drawn

    def test_the_ink_is_stroked_in_the_display_orientation(self):
        # y is DOWN in the asset store and UP in PDF: the first point of a
        # stroke that starts at the artwork's top-left must land at the box's
        # top-left, not its bottom-left.
        spec = {"signature": {"form": "vector", "aspect": 1.0, "paths": [[0, 0, 1, 1]]}}
        face = sa.parse_appearance(spec).signature
        drawn = sa._FaceContent(face, 100.0, 40.0).render().decode("ascii")
        assert "0 40 m" in drawn
        assert "100 0 l" in drawn

    @needs_bundled_face
    def test_a_typed_face_draws_the_bundled_faces_outlines(self):
        spec = {
            "signature": {
                "form": "typed",
                "aspect": 0.3,
                "typed": {"text": "Jane Doe", "fontFile": BUNDLED_FACE},
            }
        }
        face = sa.parse_appearance(spec, FONT_DIR).signature
        drawn = sa._FaceContent(face, 120.0, 36.0).render()
        # Filled outlines: curves and a fill, and no font resource — nothing
        # about the face's own program travels into the document, so there is
        # no `head.modified` in it to freeze.
        assert b" c " in drawn
        assert drawn.rstrip().endswith(b"Q")
        assert b"Tf" not in drawn and b"BT" not in drawn

    @needs_bundled_face
    def test_a_typed_face_the_font_cannot_set_refuses(self):
        spec = {
            "signature": {
                "form": "typed",
                "aspect": 0.3,
                "typed": {"text": "日本語", "fontFile": BUNDLED_FACE},
            }
        }
        face = sa.parse_appearance(spec, FONT_DIR).signature
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            sa._FaceContent(face, 120.0, 36.0).render()
        assert "cannot set that name" in str(excinfo.value)

    def test_an_image_face_embeds_the_raster(self):
        spec = {
            "signature": {
                "form": "image",
                "aspect": 0.4,
                "image": {"data": _png_b64()},
            }
        }
        face = sa.parse_appearance(spec).signature
        writer = PdfFileWriter()
        item = sa._FaceContent(face, 100.0, 40.0)
        item.set_writer(writer)
        assert b"Do" in item.render()

    def test_a_box_too_small_for_its_parts_refuses_by_name(self):
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            _render({"fields": ["name", "date"]}, width=20, height=8)
        assert "does not fit in that box" in str(excinfo.value)

    def test_a_box_the_library_calls_a_layout_error_refuses_the_same_way(self):
        # A box that cannot even hold the stamp's margins reaches the fit
        # refusal by the library's road rather than this module's; it must
        # arrive as the same sentence, not as a library string.
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            _render({"fields": ["name"]}, width=1, height=1)
        assert "does not fit in that box" in str(excinfo.value)


class TestDeterminism:
    """Two runs of one request draw the same bytes. See the module docstring."""

    def test_a_vector_face_is_byte_identical_across_runs(self):
        spec = {"signature": {"form": "vector", "aspect": 0.4, "paths": [[0, 0, 0.5, 1, 1, 0]]}}
        face = sa.parse_appearance(spec).signature
        first = sa._FaceContent(face, 100.0, 40.0).render()
        second = sa._FaceContent(sa.parse_appearance(spec).signature, 100.0, 40.0).render()
        assert first == second

    @needs_bundled_face
    def test_a_typed_face_is_byte_identical_across_runs(self):
        # The invariant this test exists for: a face opened twice must not
        # compile two different byte strings.
        spec = {
            "signature": {
                "form": "typed",
                "aspect": 0.3,
                "typed": {"text": "Jane Doe", "fontFile": BUNDLED_FACE},
            }
        }
        renders = [
            sa._FaceContent(sa.parse_appearance(spec, FONT_DIR).signature, 120.0, 36.0).render()
            for _ in range(2)
        ]
        assert renders[0] == renders[1]

    def test_a_whole_stamp_is_byte_identical_across_runs(self):
        spec = {
            "fields": ["name", "label"],
            "label": "Approved",
            "image": {"data": _png_b64()},
            "layout": "beside",
            "signature": {"form": "vector", "aspect": 0.4, "paths": [[0, 0, 0.5, 1, 1, 0]]},
        }
        assert _render(spec) == _render(spec)

    def test_an_images_resource_name_comes_from_its_bytes(self):
        # Not from a fresh uuid: a name that changes run to run is exactly the
        # kind of order-dependent byte diff this discipline exists to prevent.
        data = _png_b64()
        style = sa.stamp_style(None, None, sa.parse_appearance({"image": {"data": data}}))
        other = sa.stamp_style(None, None, sa.parse_appearance({"image": {"data": data}}))
        assert style.background.name == other.background.name
        assert style.background.name != sa.stamp_style(
            None, None, sa.parse_appearance({"image": {"data": _png_b64(colour=(1, 2, 3))}})
        ).background.name


class TestPreview:
    def test_the_preview_is_a_one_page_pdf_at_the_stamp_box(self):
        res = sa.preview_appearance(220, 70, signer="Jane Doe", timestamp="2026-01-01 00:00")
        pdf = base64.b64decode(res["pdf"])
        with pikepdf.open(io.BytesIO(pdf)) as doc:
            assert len(doc.pages) == 1
            box = [float(v) for v in doc.pages[0].MediaBox]
            assert box == [0, 0, 220, 70]

    def test_the_preview_refuses_exactly_what_signing_would_refuse(self):
        with pytest.raises(sa.StampAppearanceRefusal):
            sa.preview_appearance(
                20, 8, signer="J", timestamp="t", stamp_style_spec={"fields": ["name", "date"]}
            )

    def test_a_fixed_timestamp_holds_the_preview_still(self):
        spec = {"fields": ["name", "date"], "label": ""}
        a = sa.preview_appearance(220, 70, signer="J", timestamp="2026-01-01 00:00", stamp_style_spec=spec)
        b = sa.preview_appearance(220, 70, signer="J", timestamp="2026-01-01 00:00", stamp_style_spec=spec)
        # The document id and xref offsets are the writer's, not the
        # appearance's; the drawn page content is what must agree.
        def content(res):
            with pikepdf.open(io.BytesIO(base64.b64decode(res["pdf"]))) as doc:
                page = doc.pages[0]
                xobjects = page.Resources.XObject
                return [bytes(xobjects[k].read_bytes()) for k in xobjects.keys()]

        assert content(a) == content(b)

    def test_a_percent_in_the_fixed_timestamp_cannot_reach_the_interpolation(self):
        sa.preview_appearance(220, 70, signer="J", timestamp="100% done", stamp_style_spec={"fields": ["date"]})


class TestFaceFromFile:
    """The CLI's door into a personal signature. The app's own store lives in
    the renderer's local settings, which a command-line run has no window to
    read — so the CLI names a FILE."""

    def test_a_png_file_is_the_mark_itself(self, tmp_path):
        png = tmp_path / "sig.png"
        png.write_bytes(_png(200, 50))
        face = sa.parse_appearance({"signature": {"file": str(png)}}, FONT_DIR).signature
        assert face.form == "image"
        assert face.aspect == pytest.approx(50 / 200)

    def test_a_json_file_is_the_resolved_face_the_surfaces_build(self, tmp_path):
        import json

        exported = tmp_path / "jane.json"
        exported.write_text(
            json.dumps({"form": "vector", "aspect": 0.4, "paths": [[0, 0, 0.5, 1, 1, 0]]}),
            encoding="utf-8",
        )
        face = sa.parse_appearance({"signature": {"file": str(exported)}}, FONT_DIR).signature
        assert face.form == "vector"
        assert len(face.paths) == 1

    def test_a_file_that_is_neither_refuses_by_name(self, tmp_path):
        junk = tmp_path / "notes.txt"
        junk.write_bytes(b"this is not a signature")
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            sa.parse_appearance({"signature": {"file": str(junk)}}, FONT_DIR)
        assert "not a readable PNG, JPEG, or exported signature" in str(excinfo.value)

    def test_a_missing_file_refuses_by_name(self, tmp_path):
        with pytest.raises(sa.StampAppearanceRefusal) as excinfo:
            sa.parse_appearance({"signature": {"file": str(tmp_path / "gone.json")}}, FONT_DIR)
        assert "could not be read" in str(excinfo.value)


def _stamp_streams(path: str) -> list[bytes]:
    """Every appearance stream the file's signature widgets wear, plus the
    form XObjects they draw — the appearance, as the file actually carries
    it."""
    out: list[bytes] = []
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            for annot in page.get("/Annots", []):
                ap = annot.get("/AP")
                if ap is None:
                    continue
                normal = ap.get("/N")
                if normal is None:
                    continue
                out.append(bytes(normal.read_bytes()))
                resources = normal.get("/Resources")
                xobjects = resources.get("/XObject") if resources is not None else None
                for key in list(xobjects.keys()) if xobjects is not None else []:
                    out.append(bytes(xobjects[key].read_bytes()))
    return out


APPEARANCE = {
    "fields": ["name", "label"],
    "label": "Approved for release",
    "signature": {"form": "vector", "aspect": 0.4, "paths": [[0, 0, 0.5, 1, 1, 0]]},
    "signature_position": "left",
}


class TestTheAppearanceTravelsEveryPlacement:
    """One author, every door. Each placement is signed for real and the
    APPEARANCE IS READ BACK OUT OF THE WRITTEN FILE — never echoed from the
    request, which would prove only that the parameter was accepted."""

    def test_a_new_visible_stamp_carries_it(self, tmp_path):
        pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "pw")
        src = _blank_pdf(str(tmp_path / "in.pdf"))
        out = str(tmp_path / "out.pdf")
        r = sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw",
            appearance={"page": 1, "rect": [40, 40, 260, 110]},
            stamp_style=APPEARANCE, font_dir=FONT_DIR,
        )
        assert r["valid"] and r["intact"]
        drawn = b"".join(_stamp_streams(out))
        assert b"Approved for release" in drawn
        # The vector face travelled as vector content.
        assert b" m " in drawn and b"S" in drawn

    def test_an_existing_field_fill_carries_it(self, tmp_path):
        pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "pw")
        src = _pdf_with_sig_field(str(tmp_path / "in.pdf"), name="approval", rect=(60, 60, 320, 150))
        out = str(tmp_path / "out.pdf")
        r = sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw",
            existing_field="approval", stamp_style=APPEARANCE, font_dir=FONT_DIR,
        )
        assert r["field"] == "approval" and r["valid"]
        assert b"Approved for release" in b"".join(_stamp_streams(out))

    def test_the_incremental_append_onto_a_signed_document_carries_it(self, tmp_path):
        # The second signature appends a revision to a file that already
        # carries one — the placement the appearance is most likely to be
        # dropped by, because nothing about it is rebuilt.
        pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "pw")
        src = _blank_pdf(str(tmp_path / "in.pdf"))
        once = str(tmp_path / "once.pdf")
        twice = str(tmp_path / "twice.pdf")
        sign_pdf(file=src, output=once, pfx_path=pfx, password="pw")
        r = sign_pdf(
            file=once, output=twice, pfx_path=pfx, password="pw",
            appearance={"page": 1, "rect": [40, 150, 260, 220]},
            stamp_style=APPEARANCE, font_dir=FONT_DIR,
        )
        assert r["signature_count"] == 2
        v = verify_signatures(twice)
        assert all(s["valid"] and s["intact"] for s in v["signatures"])
        assert b"Approved for release" in b"".join(_stamp_streams(twice))

    def test_in_place_signing_carries_it(self, tmp_path):
        pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "pw")
        src = _blank_pdf(str(tmp_path / "in.pdf"))
        r = sign_pdf(
            file=src, output=src, pfx_path=pfx, password="pw", allow_in_place=True,
            appearance={"page": 1, "rect": [40, 40, 260, 110]},
            stamp_style=APPEARANCE, font_dir=FONT_DIR,
        )
        assert r["valid"] and r["intact"]
        assert b"Approved for release" in b"".join(_stamp_streams(src))

    def test_a_certification_signature_carries_it(self, tmp_path):
        pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "pw")
        src = _blank_pdf(str(tmp_path / "in.pdf"))
        out = str(tmp_path / "out.pdf")
        r = sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw", certify=True,
            appearance={"page": 1, "rect": [40, 40, 260, 110]},
            stamp_style=APPEARANCE, font_dir=FONT_DIR,
        )
        assert r["certified"] is True
        assert b"Approved for release" in b"".join(_stamp_streams(out))

    def test_an_unconfigured_signature_sends_no_appearance_at_all(self, tmp_path):
        pfx = _make_test_pfx(str(tmp_path / "signer.pfx"), "pw")
        src = _blank_pdf(str(tmp_path / "in.pdf"))
        out = str(tmp_path / "out.pdf")
        sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw",
            appearance={"page": 1, "rect": [40, 40, 260, 110]},
        )
        drawn = b"".join(_stamp_streams(out))
        assert b"Digitally signed by" in drawn
        assert b"Sidecar" not in drawn

    def test_the_appearance_refuses_before_any_signer_is_opened(self, tmp_path):
        # A refusal must not cost a hardware key its consent prompt: it is
        # raised while the request is still being validated. A signer file
        # that does not exist proves the order — the appearance's refusal is
        # what comes back, not the signer's.
        src = _blank_pdf(str(tmp_path / "in.pdf"))
        with pytest.raises(sa.StampAppearanceRefusal):
            sign_pdf(
                file=src, output=str(tmp_path / "out.pdf"),
                pfx_path=str(tmp_path / "no-such-signer.pfx"), password="pw",
                stamp_style={"image": {"path": str(tmp_path / "no-such-logo.png")}},
                font_dir=FONT_DIR,
            )
