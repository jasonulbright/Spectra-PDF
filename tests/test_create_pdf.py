"""Create PDF: the image arm and the door.

The pins that matter in the image half are the two measured as LIVE
defects: a multi-frame TIFF must produce one page PER FRAME (it produced one
page, full stop, in shipped batch OCR), and every page must be sized from its
own stored DPI (Pillow's `save_all` gives every frame the FIRST frame's).

The pins that matter in the door half are that assembly goes through the
SHIPPED merge (so /AcroForm survives a mixed build), that page sizing places
content without stretching it and without dropping form fields, and that a
refused source is never silent.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from engine import create_pdf as create_pdf_mod
from engine.create_pdf import (
    HEIF_SUFFIXES,
    IMAGE_SUFFIXES,
    accepted_image_suffixes,
    create_pdf,
    image_to_pdf,
    is_image,
)
from engine.extract_text import extract_text

import gs_axis


def field_names(path):
    with pikepdf.open(str(path)) as pdf:
        acroform = pdf.Root.get("/AcroForm")
        if acroform is None:
            return []
        return sorted(str(f.get("/T", "")) for f in (acroform.get("/Fields") or []))


def widget_rects(path):
    rects = []
    with pikepdf.open(str(path)) as pdf:
        for page in pdf.pages:
            for annot in page.get("/Annots") or []:
                if str(annot.get("/Subtype")) == "/Widget":
                    rects.append([round(float(v), 2) for v in annot.Rect])
    return sorted(rects)


def boxes(path) -> list[list[float]]:
    with pikepdf.open(str(path)) as pdf:
        return [[round(float(v), 2) for v in p["/MediaBox"]] for p in pdf.pages]


def first_image(path):
    """The first page's sole image XObject, as (filter, colorspace, bpc)."""
    with pikepdf.open(str(path)) as pdf:
        xo = pdf.pages[0]["/Resources"]["/XObject"]
        obj = xo[list(xo.keys())[0]]
        return str(obj.get("/Filter")), str(obj.get("/ColorSpace")), obj.get("/BitsPerComponent")


def gray(size, value=200):
    return Image.new("L", size, value)


class TestDpiHonesty:
    def test_a_300_dpi_png_becomes_a_letter_page(self, tmp_dir):
        src = Path(tmp_dir) / "scan.png"
        gray((2550, 3300)).save(src, dpi=(300, 300))
        out = Path(tmp_dir) / "scan.pdf"
        report = image_to_pdf(src, out)
        assert report["pages"] == 1
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0]]
        assert report["page_size"] == [612.0, 792.0]
        assert report["dpi"] == [300.0]

    def test_a_150_dpi_jpeg_becomes_a_double_size_page(self, tmp_dir):
        # The same physical picture at half the resolution is TWICE the page:
        # the wrap must never normalise silently to a paper size.
        src = Path(tmp_dir) / "half.jpg"
        Image.new("RGB", (2550, 3300), (240, 240, 240)).save(src, dpi=(150, 150))
        out = Path(tmp_dir) / "half.pdf"
        image_to_pdf(src, out)
        assert boxes(out) == [[0.0, 0.0, 1224.0, 1584.0]]

    def test_an_image_with_no_stored_dpi_uses_the_default(self, tmp_dir):
        src = Path(tmp_dir) / "bare.png"
        gray((400, 200)).save(src)  # no dpi written
        out = Path(tmp_dir) / "bare.pdf"
        image_to_pdf(src, out, dpi_default=100.0)
        assert boxes(out) == [[0.0, 0.0, 288.0, 144.0]]

    def test_a_placeholder_dpi_of_one_is_not_believed(self, tmp_dir):
        # TIFF writes 0/1 for "unset"; honouring it would produce a page
        # metres across.
        src = Path(tmp_dir) / "unset.tif"
        gray((400, 200)).save(src, dpi=(1, 1))
        out = Path(tmp_dir) / "unset.pdf"
        image_to_pdf(src, out, dpi_default=200.0)
        assert boxes(out) == [[0.0, 0.0, 144.0, 72.0]]

    def test_a_non_positive_default_refuses(self, tmp_dir):
        src = Path(tmp_dir) / "x.png"
        gray((10, 10)).save(src)
        with pytest.raises(ValueError, match="positive number"):
            image_to_pdf(src, Path(tmp_dir) / "x.pdf", dpi_default=0)


class TestEveryFrameIsAPage:
    def test_a_three_frame_tiff_produces_three_pages(self, tmp_dir):
        # THE pin that fails on the older code: `im.save(..., "PDF")` with no
        # save_all wrote frame 1 and silently dropped frames 2 and 3 — silent
        # data loss in the shipped batch-OCR feature, not only a Create PDF gap.
        src = Path(tmp_dir) / "fax.tif"
        frames = [gray((900, 1200), v) for v in (240, 200, 160)]
        frames[0].save(src, save_all=True, append_images=frames[1:], dpi=(300, 300))
        out = Path(tmp_dir) / "fax.pdf"
        report = image_to_pdf(src, out)
        assert report["pages"] == 3
        assert boxes(out) == [[0.0, 0.0, 216.0, 288.0]] * 3

    def test_each_frame_keeps_its_own_dpi(self, tmp_dir):
        """The discriminating case for rule 3.

        A TIFF stores resolution PER FRAME and Pillow reads it back per frame
        (measured). Frame 2 here is 300 px at 150 dpi = 144 pt; Pillow's
        `save_all` would have given it frame 1's 300 dpi and produced 72 pt.
        This test is the difference between the two implementations.
        """
        src = Path(tmp_dir) / "mixed.tif"
        a = gray((600, 600), 220)
        b = gray((300, 300), 180)
        b.encoderinfo = {"dpi": (150, 150)}
        a.save(src, save_all=True, append_images=[b], dpi=(300, 300))
        out = Path(tmp_dir) / "mixed.pdf"
        report = image_to_pdf(src, out)
        assert report["pages"] == 2
        assert report["dpi"] == [300.0, 150.0]
        assert boxes(out) == [[0.0, 0.0, 144.0, 144.0], [0.0, 0.0, 144.0, 144.0]]

    def test_a_multi_frame_source_never_reuses_a_saved_image_object(self, tmp_dir):
        """Regression for Pillow's encoderinfo leak.

        `Image.save` MERGES into a stale `encoderinfo` and the STALE value wins
        — measured: a second `save(..., resolution=150)` on an image that had
        been an `append_images` member silently used the earlier 300. Two
        frames whose page sizes differ prove each frame got a fresh object.
        """
        src = Path(tmp_dir) / "two.tif"
        gray((600, 600)).save(
            src, save_all=True, append_images=[gray((1200, 1200))], dpi=(300, 300)
        )
        out = Path(tmp_dir) / "two.pdf"
        image_to_pdf(src, out)
        assert boxes(out) == [[0.0, 0.0, 144.0, 144.0], [0.0, 0.0, 288.0, 288.0]]


class TestNormalisation:
    def test_a_bilevel_page_stays_bilevel(self, tmp_dir):
        # Mode "1" lands as CCITTFaxDecode — what a fax page should be. The old
        # wrap converted it to RGB and paid for it in every byte.
        src = Path(tmp_dir) / "bw.tif"
        Image.new("1", (800, 1000), 1).save(src, dpi=(200, 200))
        out = Path(tmp_dir) / "bw.pdf"
        image_to_pdf(src, out)
        filt, cs, bpc = first_image(out)
        assert "CCITTFaxDecode" in filt
        assert cs == "/DeviceGray" and int(bpc) == 1

    def test_a_palette_image_does_not_land_as_indexed_asciihex(self, tmp_dir):
        src = Path(tmp_dir) / "pal.png"
        Image.new("RGB", (200, 100), (200, 30, 30)).convert("P").save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "pal.pdf"
        image_to_pdf(src, out)
        filt, cs, _ = first_image(out)
        assert filt == "/DCTDecode" and cs == "/DeviceRGB"

    def test_transparency_composites_onto_white_not_onto_the_hidden_colour(self, tmp_dir):
        # A bare convert("RGB") of a fully transparent RED pixel yields opaque
        # RED (measured). A document page shows paper there.
        src = Path(tmp_dir) / "alpha.png"
        Image.new("RGBA", (64, 64), (255, 0, 0, 0)).save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "alpha.pdf"
        image_to_pdf(src, out)
        with pikepdf.open(str(out)) as pdf:
            xo = pdf.pages[0]["/Resources"]["/XObject"]
            raw = pikepdf.PdfImage(xo[list(xo.keys())[0]]).as_pil_image().convert("RGB")
        r, g, b = raw.getpixel((32, 32))
        assert r > 240 and g > 240 and b > 240, (r, g, b)

    def test_a_16_bit_image_is_scaled_not_clipped(self, tmp_dir):
        # convert("L") straight off I;16 CLIPS at 255 — a 16-bit scan would come
        # back almost entirely white (10000 -> 255 measured). Scaled: 10000 -> 39.
        src = Path(tmp_dir) / "deep.tif"
        Image.new("I;16", (32, 32), 10000).save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "deep.pdf"
        image_to_pdf(src, out)
        with pikepdf.open(str(out)) as pdf:
            xo = pdf.pages[0]["/Resources"]["/XObject"]
            pil = pikepdf.PdfImage(xo[list(xo.keys())[0]]).as_pil_image().convert("L")
        assert 30 <= pil.getpixel((16, 16)) <= 48

    def test_cmyk_stays_cmyk(self, tmp_dir):
        src = Path(tmp_dir) / "press.jpg"
        Image.new("CMYK", (200, 100), (0, 200, 200, 10)).save(src, dpi=(72, 72))
        out = Path(tmp_dir) / "press.pdf"
        image_to_pdf(src, out)
        _filt, cs, _ = first_image(out)
        assert cs == "/DeviceCMYK"


class TestAcceptedSet:
    def test_the_formats_the_bundled_pillow_already_decodes_are_accepted(self):
        # They were decodable all along and simply absent from the list —
        # WEBP, JPEG 2000 and AVIF all report available in the bundled Pillow.
        for suffix in (".webp", ".jp2", ".avif", ".gif", ".heic", ".heif"):
            assert suffix in IMAGE_SUFFIXES
        assert accepted_image_suffixes() is IMAGE_SUFFIXES

    def test_is_image_is_case_insensitive_and_excludes_pdf(self):
        assert is_image("A.TIF") and is_image(Path("b.HeIc"))
        assert not is_image("c.pdf") and not is_image("d.docx")

    @pytest.mark.parametrize("fmt,suffix", [("WEBP", ".webp"), ("JPEG2000", ".jp2")])
    def test_a_widened_format_round_trips(self, tmp_dir, fmt, suffix):
        src = Path(tmp_dir) / f"pic{suffix}"
        Image.new("RGB", (400, 200), (30, 90, 160)).save(src, format=fmt)
        out = Path(tmp_dir) / "pic.pdf"
        report = image_to_pdf(src, out, dpi_default=200.0)
        assert report["pages"] == 1
        assert boxes(out) == [[0.0, 0.0, 144.0, 72.0]]

    def test_an_animated_gif_contributes_every_frame(self, tmp_dir):
        src = Path(tmp_dir) / "anim.gif"
        f0 = Image.new("P", (120, 90))
        f0.putpalette([0, 0, 0, 255, 255, 255] + [0] * 762)
        f1 = f0.copy()
        f1.paste(1, (0, 0, 60, 45))
        f0.save(src, save_all=True, append_images=[f1])
        out = Path(tmp_dir) / "anim.pdf"
        assert image_to_pdf(src, out, dpi_default=72.0)["pages"] == 2


HEIF_CORPUS = Path(__file__).resolve().parent / "fixtures" / "heif"

# What each corpus file MEASURES, at dpi_default=200: the pages it becomes and
# the decoded mode and pixel size of every frame behind them. Regenerating the
# corpus (tests/fixtures/make_heif_corpus.py) does not move these numbers —
# they are properties of the container and of the decode, not of the encoder's
# rate control. The table is the equivalence contract a decoder swap has to
# satisfy: it was measured identical under both the encoder-carrying and the
# decode-only distribution of the plugin, byte for byte on the raw planes.
HEIF_CASES = [
    ("rgb8.heic", [("RGB", (160, 120))], 8),
    ("rgb8-chroma444.heic", [("RGB", (160, 120))], 8),
    ("gray8.heic", [("L", (160, 120))], 8),
    ("rgba8.heic", [("RGBA", (160, 120))], 8),
    ("lossless.heic", [("RGB", (160, 120))], 8),
    ("odd-dims.heic", [("RGB", (29, 100))], 8),
    # 10-bit tone-maps down to 8 bits per sample; the RGB path lands in RGB and
    # the monochrome one in I;16, which _normalise SCALES rather than clips.
    ("rgb10.heic", [("RGB", (160, 120))], 10),
    ("gray10.heic", [("I;16", (160, 120))], 10),
    # libheif turns the EXIF orientation tag into a transform it applies at
    # decode, so the raster arrives upright and the page is portrait.
    ("exif-orient6.heic", [("RGB", (120, 160))], 8),
    # Three top-level images, three pages, each at its OWN size.
    (
        "multi-3.heic",
        [("RGB", (160, 120)), ("RGB", (100, 100)), ("RGBA", (80, 60))],
        8,
    ),
    (
        "multi-primary1.heic",
        [("RGB", (160, 120)), ("RGB", (100, 100)), ("RGBA", (80, 60))],
        8,
    ),
    # A grid-derived image: tiles stitched back to full resolution. A reader
    # that returns one tile gets 128x128 here instead of 512x384.
    ("grid-tiled.heic", [("RGB", (512, 384))], 8),
    # A thumbnail is an auxiliary item, never a top-level image: one page.
    ("thumbnail.heic", [("RGB", (320, 240))], 8),
]


class TestHeif:
    def test_the_corpus_is_checked_in_and_complete(self):
        assert sorted(p.name for p in HEIF_CORPUS.glob("*.heic")) == sorted(
            name for name, _, _ in HEIF_CASES
        )

    @pytest.mark.parametrize("name,frames,bit_depth", HEIF_CASES)
    def test_a_corpus_file_becomes_the_pages_it_measures(
        self, tmp_dir, name, frames, bit_depth
    ):
        assert create_pdf_mod._register_heif(), "the HEIF plugin is not provisioned"
        src = HEIF_CORPUS / name
        out = Path(tmp_dir) / (src.stem + ".pdf")
        report = image_to_pdf(src, out, dpi_default=200.0)
        assert report["pages"] == len(frames)
        expected = [
            [0.0, 0.0, round(w * 72.0 / 200.0, 2), round(h * 72.0 / 200.0, 2)]
            for _, (w, h) in frames
        ]
        assert boxes(out) == expected

    @pytest.mark.parametrize("name,frames,bit_depth", HEIF_CASES)
    def test_a_corpus_file_decodes_to_the_modes_it_measures(
        self, name, frames, bit_depth
    ):
        from PIL import ImageSequence

        assert create_pdf_mod._register_heif(), "the HEIF plugin is not provisioned"
        with Image.open(HEIF_CORPUS / name) as im:
            assert im.info.get("bit_depth") == bit_depth
            decoded = [(f.mode, f.size) for f in ImageSequence.Iterator(im)]
        assert decoded == [(mode, size) for mode, size in frames]

    def test_alpha_is_composited_onto_white_rather_than_dropped(self):
        assert create_pdf_mod._register_heif()
        with Image.open(HEIF_CORPUS / "rgba8.heic") as im:
            normalised = create_pdf_mod._normalise(im.copy())
        assert normalised.mode == "RGB"
        # The generator's alpha ramps with the gradient, so the transparent
        # corner composites to white and the opaque one does not.
        assert normalised.getpixel((0, 0)) == (255, 255, 255)
        assert normalised.getpixel((159, 119)) != (255, 255, 255)

    def test_the_decoded_gradient_is_the_picture_and_not_a_flat_field(self):
        # Shape assertions cannot tell a decode from a blank buffer. The
        # generator writes a ramp; a working decode carries it, within the
        # tolerance a lossy encoder leaves behind.
        assert create_pdf_mod._register_heif()
        with Image.open(HEIF_CORPUS / "rgb8.heic") as im:
            picture = im.convert("RGB")
        assert picture.getpixel((0, 0))[0] < 24
        assert picture.getpixel((159, 0))[0] > 231
        assert picture.getpixel((0, 119))[1] > 231

    def test_heic_refuses_BY_NAME_when_the_plugin_is_absent(self, tmp_dir, monkeypatch):
        # Never silently skip somebody's photograph: the refusal names the
        # missing plugin and the file.
        src = Path(tmp_dir) / "photo.heic"
        src.write_bytes(b"\x00\x00\x00\x20ftypheic" + b"\x00" * 64)
        monkeypatch.setattr(create_pdf_mod, "_heif_registered", False)
        with pytest.raises(RuntimeError, match="HEIF decoder plugin"):
            image_to_pdf(src, Path(tmp_dir) / "photo.pdf")

    def test_the_heif_suffixes_are_a_subset_of_the_accepted_set(self):
        assert set(HEIF_SUFFIXES) <= set(IMAGE_SUFFIXES)

    def test_the_decoder_carries_no_encoder(self):
        # The plugin ships decode-only ON PURPOSE: the encoder-carrying build
        # links a video encoder into the engine process on every HEIF import,
        # and nothing in the product writes HEIF. A build that regained one
        # would regain that, silently.
        import pi_heif

        info = pi_heif.libheif_info()
        assert info["decoders"], "no HEVC decoder is present"
        # `mask` is libheif's built-in stub, not a codec library.
        assert set(info["encoders"]) <= {"mask"}


class TestRefusals:
    def test_a_missing_source_refuses_by_name(self, tmp_dir):
        with pytest.raises(ValueError, match="image file not found"):
            image_to_pdf(Path(tmp_dir) / "nope.png", Path(tmp_dir) / "o.pdf")

    def test_a_zero_byte_source_refuses_before_any_decoder_runs(self, tmp_dir):
        src = Path(tmp_dir) / "empty.png"
        src.write_bytes(b"")
        with pytest.raises(ValueError, match="empty"):
            image_to_pdf(src, Path(tmp_dir) / "o.pdf")

    def test_an_unreadable_image_refuses_by_name(self, tmp_dir):
        src = Path(tmp_dir) / "broken.png"
        src.write_bytes(b"\x89PNG\r\n\x1a\n not really an image")
        with pytest.raises(ValueError, match="unreadable image"):
            image_to_pdf(src, Path(tmp_dir) / "o.pdf")

    def test_nothing_is_written_when_the_source_refuses(self, tmp_dir):
        src = Path(tmp_dir) / "broken.png"
        src.write_bytes(b"\x89PNG\r\n\x1a\n nope")
        out = Path(tmp_dir) / "o.pdf"
        with pytest.raises(ValueError):
            image_to_pdf(src, out)
        assert not out.exists()


class TestBatchOcrSharesTheOneImplementation:
    def test_batch_ocr_re_exports_the_promoted_wrap(self):
        from engine import batch_ocr

        assert batch_ocr.image_to_pdf is image_to_pdf
        assert batch_ocr.IMAGE_SUFFIXES is IMAGE_SUFFIXES

    def test_the_batch_walk_now_sees_the_widened_set(self, tmp_dir):
        from engine.batch_ocr import _list_sources

        root = Path(tmp_dir) / "in"
        root.mkdir()
        for name in ("a.pdf", "b.png", "c.heic", "d.webp", "e.txt"):
            (root / name).write_bytes(b"x")
        found = sorted(rel for _p, rel in _list_sources(root, True)[0])
        assert found == ["a.pdf", "b.png", "c.heic", "d.webp"]


def test_the_module_does_not_import_pillow_at_module_scope():
    """PIL is imported inside the functions, as batch_ocr's wrap did — the
    engine's import graph stays cheap for the ops that never touch an image."""
    source = Path(create_pdf_mod.__file__).read_text(encoding="utf-8")
    top_level = [
        line
        for line in source.splitlines()
        if line.startswith(("import ", "from ")) and "PIL" in line
    ]
    assert top_level == [], top_level


def test_no_leftover_temporaries_beside_the_output(tmp_dir):
    src = Path(tmp_dir) / "s.tif"
    frames = [gray((100, 100), v) for v in (10, 20)]
    frames[0].save(src, save_all=True, append_images=frames[1:], dpi=(72, 72))
    out = Path(tmp_dir) / "nested" / "deep" / "s.pdf"
    image_to_pdf(src, out)
    assert out.is_file()
    assert sorted(os.listdir(out.parent)) == ["s.pdf"]


# --------------------------------------------------------------------------
# Slice C — the door.
# --------------------------------------------------------------------------

PS_BODY = (
    "%!PS-Adobe-3.0\n"
    "/Helvetica findfont 24 scalefont setfont\n"
    "72 700 moveto (ZQXJ-2026) show\n"
    "showpage\n"
)

REPO = Path(__file__).resolve().parent.parent
SOFFICE = REPO / "resources" / "libreoffice" / "program" / "soffice.exe"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
SOURCES = FIXTURES / "sources"

# Skip on the FILE, never on the directory: release.yml stubs `resources/` with
# EMPTY directories (the v1.0.18 dead-tag lesson).
needs_soffice = pytest.mark.skipif(
    not SOFFICE.is_file(), reason="vendored LibreOffice not provisioned"
)
GS = gs_axis.GS_PATH
needs_gs = gs_axis.requires_gs
needs_sources = pytest.mark.skipif(
    not (SOURCES / "report.docx").is_file(),
    reason="Office fixtures not built (tests/fixtures/make_sources.py)",
)


def scan_png(directory, name="scan.png", dpi=300, size=(2550, 3300)):
    path = Path(directory) / name
    Image.new("L", size, 230).save(path, dpi=(dpi, dpi))
    return path


def three_frame_tiff(directory, name="fax.tif"):
    path = Path(directory) / name
    frames = [gray((900, 1200), v) for v in (240, 200, 160)]
    frames[0].save(path, save_all=True, append_images=frames[1:], dpi=(300, 300))
    return path


def postscript(directory, name="page.ps"):
    path = Path(directory) / name
    path.write_text(PS_BODY, encoding="ascii")
    return path


class TestClassification:
    def test_every_accepted_suffix_names_an_arm(self):
        for suffix in create_pdf_mod.accepted_suffixes():
            assert create_pdf_mod.classify("x" + suffix), suffix

    def test_the_four_arms_are_reachable_by_extension(self):
        assert create_pdf_mod.classify("a.docx") == "office"
        assert create_pdf_mod.classify("b.heic") == "image"
        assert create_pdf_mod.classify("c.eps") == "postscript"
        assert create_pdf_mod.classify("d.pdf") == "pdf"

    def test_an_unconvertible_extension_classifies_to_nothing(self):
        for name in ("a.zip", "b.exe", "c.mp4", "d"):
            assert create_pdf_mod.classify(name) == "", name

    def test_images_are_never_routed_to_libreoffice(self):
        # LibreOffice's image import put a 200-dpi PNG, a 150-dpi JPEG and a
        # 300-dpi TIFF all on one Letter page (measured), so the arms must not
        # overlap on a single suffix.
        for suffix in IMAGE_SUFFIXES:
            assert suffix not in create_pdf_mod.soffice_mod.OFFICE_SUFFIXES, suffix


class TestTheBlankArm:
    def test_a_blank_member_is_one_letter_page(self, tmp_dir):
        out = Path(tmp_dir) / "blank.pdf"
        result = create_pdf([{"kind": "blank"}], str(out))
        assert result["pages"] == 1
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0]]
        assert result["sources"][0]["converter"] == "blank"

    def test_a_blank_member_takes_a_size(self, tmp_dir):
        out = Path(tmp_dir) / "blank2.pdf"
        create_pdf([{"kind": "blank", "width": 300, "height": 500}], str(out))
        assert boxes(out) == [[0.0, 0.0, 300.0, 500.0]]

    def test_a_nonsense_blank_size_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="positive width and height"):
            create_pdf(
                [{"kind": "blank", "width": 0, "height": 500}], str(Path(tmp_dir) / "x.pdf")
            )


class TestOrderAndAssembly:
    def test_sources_contribute_pages_in_the_order_given(self, tmp_dir):
        png = scan_png(tmp_dir)
        tif = three_frame_tiff(tmp_dir)
        out = Path(tmp_dir) / "ordered.pdf"
        result = create_pdf([{"path": str(png)}, {"kind": "blank"}, {"path": str(tif)}], str(out))
        assert result["pages"] == 5
        assert [row["pages"] for row in result["sources"]] == [1, 1, 3]
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0]] * 2 + [[0.0, 0.0, 216.0, 288.0]] * 3

    def test_a_single_source_goes_through_the_same_merge(self, tmp_dir, sample_pdf):
        # Rule 2: a one-member merge, so the single and multi cases cannot
        # drift. The proof is that the output is a REBUILD, not a copy.
        out = Path(tmp_dir) / "one.pdf"
        result = create_pdf([{"path": sample_pdf}], str(out))
        assert result["pages"] == 5
        assert result["sources"][0]["converter"] == "passthrough"
        assert out.read_bytes() != Path(sample_pdf).read_bytes()

    def test_a_pdf_member_passes_through_unconverted(self, tmp_dir, sample_pdf, sample_pdf2):
        out = Path(tmp_dir) / "two.pdf"
        result = create_pdf([{"path": sample_pdf}, {"path": sample_pdf2}], str(out))
        assert result["pages"] == 8
        assert [row["converter"] for row in result["sources"]] == ["passthrough"] * 2


class TestPerMemberPageRanges:
    """Combine Files' per-member range, through the one door.

    Applied AFTER that member's conversion, which is why it reads the same on
    a `.docx` as on a PDF and why no arm had to learn ranges exist.
    """

    def test_a_member_contributes_only_its_range(self, tmp_dir, sample_pdf, sample_pdf2):
        out = Path(tmp_dir) / "ranged.pdf"
        result = create_pdf(
            [{"path": sample_pdf, "pages": "2-3"}, {"path": sample_pdf2, "pages": "1"}],
            str(out),
        )
        assert result["pages"] == 3
        assert [row["pages"] for row in result["sources"]] == [2, 1]
        assert [row["page_range"] for row in result["sources"]] == ["2-3", "1"]

    def test_a_list_of_pages_and_spans_is_taken_in_the_range_order(self, tmp_dir, sample_pdf):
        out = Path(tmp_dir) / "list.pdf"
        result = create_pdf([{"path": sample_pdf, "pages": "5,1-2"}], str(out))
        assert result["pages"] == 3

    def test_a_span_end_is_clamped_to_the_document(self, tmp_dir, sample_pdf):
        out = Path(tmp_dir) / "clamped.pdf"
        assert create_pdf([{"path": sample_pdf, "pages": "1-999"}], str(out))["pages"] == 5

    def test_a_range_selecting_nothing_refuses_by_name(self, tmp_dir, sample_pdf):
        with pytest.raises(ValueError, match="selects no pages"):
            create_pdf([{"path": sample_pdf, "pages": "99"}], str(Path(tmp_dir) / "x.pdf"))

    def test_a_malformed_range_refuses_naming_what_was_typed(self, tmp_dir, sample_pdf):
        # `parse_ranges` alone would raise a bare int() ValueError naming a
        # literal the user never typed; the shape is checked first.
        for spec in ("abc", "2-", "-3", "1..3"):
            with pytest.raises(ValueError, match="is not a list of pages or ranges"):
                create_pdf(
                    [{"path": sample_pdf, "pages": spec}], str(Path(tmp_dir) / "x.pdf")
                )

    def test_a_blank_member_refuses_a_range_rather_than_ignoring_it(self, tmp_dir):
        # A range that silently does nothing is a user believing they made a
        # selection.
        with pytest.raises(ValueError, match="no pages to select a range from"):
            create_pdf([{"kind": "blank", "pages": "1"}], str(Path(tmp_dir) / "x.pdf"))

    def test_a_range_survives_page_size_normalisation(self, tmp_dir, sample_pdf):
        out = Path(tmp_dir) / "ranged-a4.pdf"
        result = create_pdf(
            [{"path": sample_pdf, "pages": "2-3"}], str(out), page_size="a4"
        )
        assert result["pages"] == 2
        assert boxes(out) == [[0.0, 0.0, 595.28, 841.89]] * 2

    def test_a_ranged_form_member_keeps_the_fields_on_its_kept_pages(self, tmp_dir):
        # A range is a SPLIT of that member, so it goes through the same
        # form-aware copy `split` uses — a bare `pages.append` would leave
        # every widget on a kept page orphaned and dead.
        form = FIXTURES / "form-pdflib.pdf"
        out = Path(tmp_dir) / "form-ranged.pdf"
        create_pdf([{"path": str(form)}, {"path": str(form), "pages": "1"}], str(out))
        assert field_names(out), "the fixture must actually carry fields"
        # Both copies' fields are registered; the collision renames rather
        # than dropping one, exactly as the shipped merge does.
        assert len(field_names(out)) == 2 * len(field_names(form))

    def test_an_image_member_takes_a_range_of_its_frames(self, tmp_dir):
        out = Path(tmp_dir) / "frames.pdf"
        result = create_pdf(
            [{"path": str(three_frame_tiff(tmp_dir)), "pages": "2-3"}], str(out)
        )
        assert result["pages"] == 2


class TestFormsSurviveTheAssembly:
    def test_a_form_member_keeps_its_fields_through_a_mixed_build(self, tmp_dir):
        # The risk the brief names for this slice: assembly MUST route through
        # the shipped merge machinery. A bare `pages.extend` imports the widget
        # objects but not their field registration, silently killing the form.
        form = FIXTURES / "form-pdflib.pdf"
        out = Path(tmp_dir) / "form-mixed.pdf"
        create_pdf(
            [{"path": str(form)}, {"path": str(scan_png(tmp_dir))}, {"kind": "blank"}], str(out)
        )
        assert field_names(out) == field_names(form)
        assert field_names(out), "the fixture must actually carry fields"

    def test_fields_survive_page_size_normalisation_too(self, tmp_dir):
        # Sizing rebuilds a page's content stream. Building a FRESH page
        # dictionary would have dropped every widget on it; the affine is
        # applied to the annotations instead, so they stay the same objects.
        form = FIXTURES / "form-pdflib.pdf"
        out = Path(tmp_dir) / "form-sized.pdf"
        create_pdf([{"path": str(form)}], str(out), page_size="a4", margin_pt=12.0)
        assert field_names(out) == field_names(form)
        assert boxes(out) == [[0.0, 0.0, 595.28, 841.89]]

    def test_a_widget_rect_moves_with_its_page(self, tmp_dir):
        form = FIXTURES / "form-pdflib.pdf"
        out = Path(tmp_dir) / "form-moved.pdf"
        before = widget_rects(form)
        create_pdf([{"path": str(form)}], str(out), page_size="a4")
        after = widget_rects(out)
        assert before and len(after) == len(before)
        assert after != before, "the widgets were left at the un-placed coordinates"
        for rect in after:
            assert 0 <= rect[0] <= 595.28 and 0 <= rect[1] <= 841.89, rect


class TestPageSizing:
    def test_auto_leaves_every_source_its_own_geometry(self, tmp_dir):
        png = scan_png(tmp_dir, dpi=300)
        small = scan_png(tmp_dir, name="small.png", dpi=600)
        out = Path(tmp_dir) / "auto.pdf"
        create_pdf([{"path": str(png)}, {"path": str(small)}], str(out))
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0], [0.0, 0.0, 306.0, 396.0]]

    def test_a_named_size_places_every_page_on_it(self, tmp_dir):
        out = Path(tmp_dir) / "letter.pdf"
        create_pdf(
            [{"path": str(scan_png(tmp_dir, dpi=600))},
             {"kind": "blank", "width": 200, "height": 300}],
            str(out),
            page_size="letter",
        )
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0]] * 2

    def test_orientation_auto_follows_each_page_own_aspect(self, tmp_dir):
        tall = scan_png(tmp_dir, name="tall.png", dpi=300, size=(600, 900))
        wide = scan_png(tmp_dir, name="wide.png", dpi=300, size=(900, 600))
        out = Path(tmp_dir) / "mixed.pdf"
        create_pdf([{"path": str(tall)}, {"path": str(wide)}], str(out), page_size="letter")
        assert boxes(out) == [[0.0, 0.0, 612.0, 792.0], [0.0, 0.0, 792.0, 612.0]]

    def test_an_explicit_orientation_overrides_the_content(self, tmp_dir):
        tall = scan_png(tmp_dir, name="tall.png", dpi=300, size=(600, 900))
        out = Path(tmp_dir) / "land.pdf"
        create_pdf([{"path": str(tall)}], str(out), page_size="letter", orientation="landscape")
        assert boxes(out) == [[0.0, 0.0, 792.0, 612.0]]

    def test_orientation_alone_turns_the_page_without_changing_its_paper(self, tmp_dir):
        tall = scan_png(tmp_dir, name="tall.png", dpi=300, size=(600, 900))
        out = Path(tmp_dir) / "turn.pdf"
        create_pdf([{"path": str(tall)}], str(out), orientation="landscape")
        # 144x216 becomes 216x144 — its own paper, turned.
        assert boxes(out) == [[0.0, 0.0, 216.0, 144.0]]

    def test_first_matches_the_first_source(self, tmp_dir):
        a = scan_png(tmp_dir, name="a.png", dpi=300, size=(600, 900))
        b = scan_png(tmp_dir, name="b.png", dpi=600, size=(600, 900))
        out = Path(tmp_dir) / "first.pdf"
        create_pdf([{"path": str(a)}, {"path": str(b)}], str(out), page_size="first")
        assert boxes(out) == [[0.0, 0.0, 144.0, 216.0]] * 2

    def test_content_is_never_stretched(self, tmp_dir):
        # A 2:1 image on a Letter page keeps its 2:1 shape — read off the
        # placement matrix the content stream actually carries.
        wide = scan_png(tmp_dir, name="w.png", dpi=300, size=(1200, 600))
        out = Path(tmp_dir) / "nostretch.pdf"
        create_pdf([{"path": str(wide)}], str(out), page_size="letter", margin_pt=36.0)
        with pikepdf.open(str(out)) as pdf:
            parts = bytes(pdf.pages[0].Contents.read_bytes()).decode("ascii").split()
        scale_x, shear_a, shear_b, scale_y = (float(parts[i]) for i in (1, 2, 3, 4))
        assert shear_a == 0 and shear_b == 0
        assert scale_x == pytest.approx(scale_y), "a non-uniform scale is a stretch"

    def test_the_margin_is_honoured(self, tmp_dir):
        square = scan_png(tmp_dir, name="sq.png", dpi=300, size=(900, 900))
        out = Path(tmp_dir) / "margin.pdf"
        create_pdf([{"path": str(square)}], str(out), page_size="letter", margin_pt=72.0)
        with pikepdf.open(str(out)) as pdf:
            scale = float(bytes(pdf.pages[0].Contents.read_bytes()).decode("ascii").split()[1])
        # 216 pt of content into 612 - 144 = 468 pt of usable width.
        assert 216.0 * scale <= 468.01

    def test_an_already_correct_page_is_not_rewritten(self, tmp_dir):
        # Never rebuild a page for nothing: a Letter source asked to be Letter
        # keeps its own content stream.
        png = scan_png(tmp_dir, dpi=300)
        sized = Path(tmp_dir) / "sized.pdf"
        create_pdf([{"path": str(png)}], str(sized), page_size="letter")
        with pikepdf.open(str(sized)) as pdf:
            assert "/SpectraPlaced" not in str(pdf.pages[0].get("/Resources"))

    def test_an_unknown_page_size_or_orientation_refuses_by_name(self, tmp_dir):
        png = scan_png(tmp_dir)
        with pytest.raises(ValueError, match="unknown page size"):
            create_pdf([{"path": str(png)}], str(Path(tmp_dir) / "o.pdf"), page_size="a9")
        with pytest.raises(ValueError, match="unknown orientation"):
            create_pdf([{"path": str(png)}], str(Path(tmp_dir) / "o.pdf"), orientation="sideways")

    def test_a_negative_margin_refuses(self, tmp_dir):
        png = scan_png(tmp_dir)
        with pytest.raises(ValueError, match="margin"):
            create_pdf(
                [{"path": str(png)}],
                str(Path(tmp_dir) / "o.pdf"),
                page_size="letter",
                margin_pt=-5,
            )


class TestDoorRefusals:
    def test_an_empty_source_list_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="at least one source"):
            create_pdf([], str(Path(tmp_dir) / "o.pdf"))

    def test_an_unconvertible_source_refuses_and_lists_what_IS_accepted(self, tmp_dir):
        bad = Path(tmp_dir) / "thing.zip"
        bad.write_bytes(b"PK")
        with pytest.raises(ValueError, match="Create PDF cannot convert") as excinfo:
            create_pdf([{"path": str(bad)}], str(Path(tmp_dir) / "o.pdf"))
        assert ".docx" in str(excinfo.value) and ".png" in str(excinfo.value)

    def test_a_directory_destination_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="is a directory"):
            create_pdf([{"path": str(scan_png(tmp_dir))}], tmp_dir)

    def test_writing_over_a_source_refuses_by_IDENTITY(self, tmp_dir, sample_pdf):
        # String comparison cannot see a UNC-vs-mapped-letter or hardlink alias
        # of one physical file, so this is os.path.samefile.
        copy = Path(tmp_dir) / "in.pdf"
        copy.write_bytes(Path(sample_pdf).read_bytes())
        with pytest.raises(ValueError, match="one of the sources"):
            create_pdf([{"path": str(copy)}], str(copy))

    def test_a_source_with_no_path_and_no_kind_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="needs a path"):
            create_pdf([{}], str(Path(tmp_dir) / "o.pdf"))

    def test_a_non_object_source_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="must be an object"):
            create_pdf(["a.png"], str(Path(tmp_dir) / "o.pdf"))

    def test_an_empty_source_file_refuses_before_any_converter_runs(self, tmp_dir):
        empty = Path(tmp_dir) / "empty.docx"
        empty.write_bytes(b"")
        with pytest.raises(ValueError, match="the input file is empty"):
            create_pdf([{"path": str(empty)}], str(Path(tmp_dir) / "o.pdf"))

    def test_nothing_is_written_when_the_run_refuses(self, tmp_dir):
        bad = Path(tmp_dir) / "thing.zip"
        bad.write_bytes(b"x")
        out = Path(tmp_dir) / "o.pdf"
        with pytest.raises(ValueError):
            create_pdf([{"path": str(scan_png(tmp_dir))}, {"path": str(bad)}], str(out))
        assert not out.exists()

    def test_an_unknown_on_unsupported_mode_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="on_unsupported"):
            create_pdf([{"kind": "blank"}], str(Path(tmp_dir) / "o.pdf"), on_unsupported="ignore")


class TestSkipMode:
    def test_a_skipped_row_is_never_silent(self, tmp_dir):
        # It is a `sources` row carrying its error AND a `warnings` entry — the
        # Combine dialog shows per-row state and the report says why.
        bad = Path(tmp_dir) / "thing.zip"
        bad.write_bytes(b"x")
        out = Path(tmp_dir) / "skip.pdf"
        result = create_pdf(
            [{"path": str(scan_png(tmp_dir))}, {"path": str(bad)}],
            str(out),
            on_unsupported="skip",
        )
        assert result["pages"] == 1
        errored = [row for row in result["sources"] if row.get("error")]
        assert len(errored) == 1
        assert "thing.zip" in errored[0]["path"]
        assert any("thing.zip" in warning for warning in result["warnings"])

    def test_skipping_EVERYTHING_still_refuses(self, tmp_dir):
        # Skip means "carry on past a bad row", never "write an empty PDF".
        bad = Path(tmp_dir) / "thing.zip"
        bad.write_bytes(b"x")
        out = Path(tmp_dir) / "none.pdf"
        with pytest.raises(RuntimeError, match="nothing could be converted"):
            create_pdf([{"path": str(bad)}], str(out), on_unsupported="skip")
        assert not out.exists()


@needs_soffice
@needs_sources
class TestTheOfficeArmThroughTheDoor:
    def test_a_docx_becomes_extractable_pages(self, tmp_dir):
        out = Path(tmp_dir) / "doc.pdf"
        result = create_pdf(
            [{"path": str(SOURCES / "report.docx")}], str(out), soffice_path=str(SOFFICE)
        )
        assert result["pages"] == 1
        assert result["sources"][0]["converter"] == "libreoffice"
        assert "ZQXJ-2026" in extract_text(str(out))["text"]

    def test_a_mixed_build_reports_every_arm_it_used(self, tmp_dir):
        out = Path(tmp_dir) / "mixed.pdf"
        result = create_pdf(
            [
                {"path": str(SOURCES / "report.docx")},
                {"path": str(scan_png(tmp_dir))},
                {"kind": "blank"},
                {"path": str(SOURCES / "deck.pptx")},
            ],
            str(out),
            soffice_path=str(SOFFICE),
        )
        assert [row["converter"] for row in result["sources"]] == [
            "libreoffice",
            "image",
            "blank",
            "libreoffice",
        ]
        assert result["pages"] == 5
        # The deck keeps its 16:9 slide box under `auto`.
        width, height = boxes(out)[-1][2], boxes(out)[-1][3]
        assert width == pytest.approx(793.76, abs=0.1)
        assert height == pytest.approx(446.51, abs=0.1)

    def test_a_substituted_font_becomes_a_warning_naming_the_face(self, tmp_dir):
        out = Path(tmp_dir) / "subs.pdf"
        result = create_pdf(
            [{"path": str(SOURCES / "fonts-missing.docx")}], str(out), soffice_path=str(SOFFICE)
        )
        assert result["sources"][0]["fonts_substituted"] == ["NoSuchFace9713"]
        assert any("NoSuchFace9713" in warning for warning in result["warnings"])

    def test_an_office_source_with_no_soffice_refuses_by_name(self, tmp_dir):
        with pytest.raises(RuntimeError, match="LibreOffice is not available"):
            create_pdf([{"path": str(SOURCES / "report.docx")}], str(Path(tmp_dir) / "o.pdf"))


@needs_gs
class TestThePostScriptArmThroughTheDoor:
    def test_a_postscript_source_distills(self, tmp_dir):
        out = Path(tmp_dir) / "ps.pdf"
        result = create_pdf([{"path": str(postscript(tmp_dir))}], str(out), gs_path=str(GS))
        assert result["pages"] == 1
        assert result["sources"][0]["converter"] == "ghostscript"
        assert "ZQXJ-2026" in extract_text(str(out))["text"]

    def test_the_quality_preset_reaches_ghostscript(self, tmp_dir):
        out = Path(tmp_dir) / "ps2.pdf"
        result = create_pdf(
            [{"path": str(postscript(tmp_dir))}],
            str(out),
            gs_path=str(GS),
            distill_preset="screen",
        )
        assert result["pages"] == 1

    def test_an_unknown_preset_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="unknown preset"):
            create_pdf(
                [{"path": str(postscript(tmp_dir))}],
                str(Path(tmp_dir) / "o.pdf"),
                gs_path=str(GS),
                distill_preset="lossless",
            )


def test_the_door_is_registered_as_one_ipc_method():
    main = (REPO / "src" / "engine" / "__main__.py").read_text(encoding="utf-8")
    assert 'server.register("create_pdf", create_pdf)' in main
