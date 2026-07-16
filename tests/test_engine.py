"""Tests for all 10 SpectraPDF Python engine operations + inspect/validate."""

import os
import re
import shutil

import pikepdf
import pytest

from engine.merge import merge
from engine.split import split
from engine.rotate import rotate
from engine.delete import delete
from engine.compress import compress
from engine.pdfa import convert_pdfa
from engine.encrypt import encrypt, decrypt
from engine.extract_text import extract_text
from engine.metadata import get_metadata, set_metadata
from engine.inspect import get_page_count, get_page_info, check_encrypted, unlock
from engine.reversion import get_pdf_version, set_pdf_version
from engine.validate import validate_pdf
from engine.redact import redact
from engine.watermark import watermark
from engine.compare import compare_text, compare_visual
import engine.compare as compare_mod
from engine.signatures import verify_signatures, sign_pdf
from pikepdf import Name, Dictionary


# ── Merge ─────────────────────────────────────────────────────────────────


class TestMerge:
    def test_merge_two_files(self, sample_pdf, sample_pdf2, tmp_dir):
        out = os.path.join(tmp_dir, "merged.pdf")
        result = merge(files=[sample_pdf, sample_pdf2], output=out)
        assert result["pages"] == 8  # 5 + 3
        assert result["output"] == out
        assert os.path.isfile(out)
        assert result["size_bytes"] > 0

    def test_merge_single_file(self, sample_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "merged.pdf")
        result = merge(files=[sample_pdf], output=out)
        assert result["pages"] == 5

    def test_merge_same_file_twice(self, sample_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "merged.pdf")
        result = merge(files=[sample_pdf, sample_pdf], output=out)
        assert result["pages"] == 10


# ── Split ─────────────────────────────────────────────────────────────────


class TestSplit:
    def test_split_single_range(self, sample_pdf, tmp_dir):
        result = split(file=sample_pdf, ranges="1-3", output_dir=tmp_dir)
        assert result["pages_extracted"] == 3
        assert len(result["outputs"]) == 1
        assert os.path.isfile(result["outputs"][0])

    def test_split_multiple_ranges(self, sample_pdf, tmp_dir):
        result = split(file=sample_pdf, ranges="1-2,4-5", output_dir=tmp_dir)
        assert result["pages_extracted"] == 4

    def test_split_single_page(self, sample_pdf, tmp_dir):
        result = split(file=sample_pdf, ranges="3", output_dir=tmp_dir)
        assert result["pages_extracted"] == 1

    def test_split_out_of_range_clamped(self, sample_pdf, tmp_dir):
        result = split(file=sample_pdf, ranges="1-100", output_dir=tmp_dir)
        assert result["pages_extracted"] == 5  # clamped to max


# ── Rotate ────────────────────────────────────────────────────────────────


class TestRotate:
    def test_rotate_single_page(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "rotated.pdf")
        result = rotate(file=tmp_pdf, pages=[1], angle=90, output=out)
        assert result["pages_rotated"] == 1
        assert result["angle"] == 90
        with pikepdf.open(out) as pdf:
            assert int(pdf.pages[0].get("/Rotate", 0)) == 90

    def test_rotate_all_pages(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "rotated.pdf")
        result = rotate(file=tmp_pdf, pages="all", angle=180, output=out)
        assert result["pages_rotated"] == 5

    def test_rotate_in_place(self, tmp_pdf):
        result = rotate(file=tmp_pdf, pages=[1, 2], angle=270, output=tmp_pdf)
        assert result["pages_rotated"] == 2

    def test_rotate_invalid_pages_filtered(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "rotated.pdf")
        result = rotate(file=tmp_pdf, pages=[1, 99], angle=90, output=out)
        assert result["pages_rotated"] == 1  # page 99 filtered out


# ── Delete ────────────────────────────────────────────────────────────────


class TestDelete:
    def test_delete_single_page(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "deleted.pdf")
        result = delete(file=tmp_pdf, pages=[3], output=out)
        assert result["pages_deleted"] == 1
        assert result["pages_remaining"] == 4

    def test_delete_multiple_pages(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "deleted.pdf")
        result = delete(file=tmp_pdf, pages=[1, 3, 5], output=out)
        assert result["pages_deleted"] == 3
        assert result["pages_remaining"] == 2

    def test_delete_in_place(self, tmp_pdf):
        result = delete(file=tmp_pdf, pages=[1], output=tmp_pdf)
        assert result["pages_remaining"] == 4

    def test_delete_invalid_pages_filtered(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "deleted.pdf")
        result = delete(file=tmp_pdf, pages=[1, 99], output=out)
        assert result["pages_deleted"] == 1
        assert result["pages_remaining"] == 4

    def test_delete_duplicate_pages(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "deleted.pdf")
        result = delete(file=tmp_pdf, pages=[1, 1, 1], output=out)
        assert result["pages_deleted"] == 1  # deduped


# ── Compress ──────────────────────────────────────────────────────────────


class TestCompress:
    def test_compress_ebook(self, tmp_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "compressed.pdf")
        result = compress(file=tmp_pdf, output=out, quality="ebook", gs_path=gs_path)
        assert result["quality"] == "ebook"
        assert os.path.isfile(out)
        assert result["compressed_size"] > 0

    def test_compress_screen(self, tmp_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "compressed.pdf")
        result = compress(file=tmp_pdf, output=out, quality="screen", gs_path=gs_path)
        assert result["quality"] == "screen"

    def test_compress_default_quality(self, tmp_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "compressed.pdf")
        result = compress(file=tmp_pdf, output=out, gs_path=gs_path)
        assert result["quality"] == "ebook"


# ── PDF/A ─────────────────────────────────────────────────────────────────


class TestPdfa:
    def test_pdfa_2b(self, tmp_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "pdfa.pdf")
        result = convert_pdfa(file=tmp_pdf, output=out, level="2b", gs_path=gs_path)
        assert "2b" in result["level"]
        assert os.path.isfile(out)

    def test_pdfa_1b(self, tmp_pdf, tmp_dir, gs_path):
        out = os.path.join(tmp_dir, "pdfa.pdf")
        result = convert_pdfa(file=tmp_pdf, output=out, level="1b", gs_path=gs_path)
        assert "1b" in result["level"]


# ── Encrypt / Decrypt ────────────────────────────────────────────────────


class TestEncryptDecrypt:
    def test_encrypt_with_password(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "encrypted.pdf")
        result = encrypt(file=tmp_pdf, output=out, user_password="secret")
        assert result["encryption"] == "AES-256"
        assert result["has_user_password"] is True
        # Verify it's actually encrypted
        enc_check = check_encrypted(file=out)
        assert enc_check["encrypted"] is True

    def test_decrypt(self, tmp_pdf, tmp_dir):
        enc = os.path.join(tmp_dir, "encrypted.pdf")
        dec = os.path.join(tmp_dir, "decrypted.pdf")
        encrypt(file=tmp_pdf, output=enc, user_password="secret")
        result = decrypt(file=enc, output=dec, password="secret")
        assert result["decrypted"] is True
        # Verify it's no longer encrypted
        enc_check = check_encrypted(file=dec)
        assert enc_check["encrypted"] is False

    def test_decrypt_wrong_password(self, tmp_pdf, tmp_dir):
        enc = os.path.join(tmp_dir, "encrypted.pdf")
        dec = os.path.join(tmp_dir, "decrypted.pdf")
        encrypt(file=tmp_pdf, output=enc, user_password="secret")
        with pytest.raises(Exception):
            decrypt(file=enc, output=dec, password="wrong")


# ── Extract Text ──────────────────────────────────────────────────────────


class TestExtractText:
    def test_extract_all(self, sample_pdf):
        result = extract_text(file=sample_pdf)
        assert result["pages_extracted"] == "all"
        assert isinstance(result["text"], str)
        assert result["length"] >= 0

    def test_extract_specific_pages(self, sample_pdf):
        result = extract_text(file=sample_pdf, pages=[1, 2])
        assert result["pages_extracted"] == 2


# ── Metadata ──────────────────────────────────────────────────────────────


class TestMetadata:
    def test_get_metadata(self, sample_pdf):
        result = get_metadata(file=sample_pdf)
        assert result["title"] == "Test Document"
        # XMP dc:creator is a list; engine may return list or joined string
        author = result["author"]
        assert "Test Author" in (author if isinstance(author, list) else [author])
        assert result["subject"] == "Test Subject"
        assert result["keywords"] == "test, fixture"
        assert result["pages"] == 5

    def test_set_metadata(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "meta.pdf")
        result = set_metadata(
            file=tmp_pdf, output=out, title="New Title", author="New Author"
        )
        assert "title" in result["updated_fields"]
        assert "author" in result["updated_fields"]
        # Verify round-trip
        meta = get_metadata(file=out)
        assert meta["title"] == "New Title"
        author = meta["author"]
        assert "New Author" in (author if isinstance(author, list) else [author])

    def test_set_metadata_partial(self, tmp_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "meta.pdf")
        result = set_metadata(file=tmp_pdf, output=out, title="Only Title")
        assert result["updated_fields"] == ["title"]


# ── Inspect ───────────────────────────────────────────────────────────────


class TestInspect:
    def test_page_count(self, sample_pdf):
        result = get_page_count(file=sample_pdf)
        assert result["pages"] == 5
        assert len(result["page_sizes"]) == 5
        assert result["page_sizes"][0]["width"] == 612.0
        assert result["page_sizes"][0]["height"] == 792.0

    def test_page_info(self, sample_pdf):
        result = get_page_info(file=sample_pdf, page=1)
        assert result["page"] == 1
        assert result["width"] == 612.0
        assert result["height"] == 792.0
        assert result["rotation"] == 0

    def test_page_info_out_of_range(self, sample_pdf):
        with pytest.raises(ValueError, match="out of range"):
            get_page_info(file=sample_pdf, page=99)

    def test_check_encrypted_unencrypted(self, sample_pdf):
        result = check_encrypted(file=sample_pdf)
        assert result["encrypted"] is False

    def test_unlock(self, tmp_pdf, tmp_dir):
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt(file=tmp_pdf, output=enc, user_password="test123")
        result = unlock(file=enc, password="test123")
        assert result["unlocked"] is True
        # Verify it's now readable without password
        assert check_encrypted(file=enc)["encrypted"] is False


# ── Validate ──────────────────────────────────────────────────────────────


class TestValidate:
    def test_validate_good_pdf(self, sample_pdf):
        result = validate_pdf(sample_pdf)
        assert result["pages"] == 5
        assert result["size_bytes"] > 0

    def test_validate_nonexistent(self):
        with pytest.raises(Exception):
            validate_pdf("/nonexistent/file.pdf")


# ── Redact ────────────────────────────────────────────────────────────────


def _make_redact_fixture(path: str) -> None:
    """A 400x400 page: "SECRET DATA" near (50,300), a 3x3 red image placed at
    (200,50)-(300,150), and unrelated "KEEP ME" text near (50,50) — built
    directly via pikepdf's low-level object API (no reportlab dependency)."""
    doc = pikepdf.new()
    page = doc.add_blank_page(page_size=(400, 400))
    font = doc.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )
    img_stream = doc.make_stream(bytes([255, 0, 0] * 9))
    img_stream.Type = Name.XObject
    img_stream.Subtype = Name.Image
    img_stream.Width = 3
    img_stream.Height = 3
    img_stream.BitsPerComponent = 8
    img_stream.ColorSpace = Name.DeviceRGB
    page.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(Im0=img_stream))
    content = (
        b"BT /F1 12 Tf 50 300 Td (SECRET DATA) Tj ET "
        b"q 100 0 0 100 200 50 cm /Im0 Do Q "
        b"BT /F1 12 Tf 50 50 Td (KEEP ME) Tj ET"
    )
    page.Contents = doc.make_stream(content)
    doc.save(path)
    doc.close()


def _all_form_streams(pdf) -> list:
    """Every reachable /Form XObject stream in the document, walking page and
    nested-form /Resources. Used to assert redacted form COPIES decode cleanly
    — a copy that keeps the original's /Filter over freshly-written raw bytes
    is a corrupt stream a real reader can't inflate."""
    seen: set = set()
    out: list = []

    def visit(res):
        if res is None:
            return
        xo = res.get("/XObject")
        if xo is None:
            return
        for key in xo.keys():
            stream = xo[key]
            ident = stream.objgen if getattr(stream, "is_indirect", False) else id(stream)
            if ident in seen:
                continue
            seen.add(ident)
            if stream.get("/Subtype") == Name.Form:
                out.append(stream)
                visit(stream.get("/Resources"))

    for page in pdf.pages:
        visit(page.get("/Resources"))
    return out


def _stream_contains(obj, needle: bytes) -> bool:
    """True if `needle` is in the object's DECODED bytes, falling back to its
    RAW bytes if decoding fails — so a (buggy) undecodable stream can never
    silently hide a secret from the scan."""
    for reader in ("read_bytes", "read_raw_bytes"):
        try:
            if needle in bytes(getattr(obj, reader)()):
                return True
            return False  # decoded fine, needle absent — done
        except Exception:
            continue
    return False


class TestRedact:
    def test_redact_removes_text_and_image_keeps_unrelated_content(self, tmp_dir):
        src = os.path.join(tmp_dir, "redact_in.pdf")
        out = os.path.join(tmp_dir, "redact_out.pdf")
        _make_redact_fixture(src)

        result = redact(
            file=src,
            output=out,
            regions=[
                {"page": 1, "rect": [40, 290, 250, 320]},
                {"page": 1, "rect": [190, 40, 310, 160]},
            ],
        )
        assert result["pages_redacted"] == 1
        assert result["regions_applied"] == 2
        assert result["text_runs_removed"] == 1
        assert result["images_removed"] == 1

        # Non-circular verification: pdfminer, independent of pikepdf/our own
        # content-stream walk, must no longer find the redacted text.
        text = extract_text(out)["text"]
        assert "SECRET DATA" not in text
        assert "KEEP ME" in text

        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0].get("/Resources", {}).get("/XObject", {})
            assert list(xobjects.keys() if xobjects else []) == []

    def test_redact_region_with_no_overlap_is_a_no_op_on_content(self, tmp_dir):
        src = os.path.join(tmp_dir, "redact_in2.pdf")
        out = os.path.join(tmp_dir, "redact_out2.pdf")
        _make_redact_fixture(src)

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 10, 10]}])
        assert result["text_runs_removed"] == 0
        assert result["images_removed"] == 0

        text = extract_text(out)["text"]
        assert "SECRET DATA" in text
        assert "KEEP ME" in text

    def test_redact_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "redact_in3.pdf")
        _make_redact_fixture(src)

        redact(file=src, output=src, regions=[{"page": 1, "rect": [40, 290, 250, 320]}])
        text = extract_text(src)["text"]
        assert "SECRET DATA" not in text
        assert "KEEP ME" in text

    def test_redact_out_of_range_page_is_ignored(self, tmp_dir):
        src = os.path.join(tmp_dir, "redact_in4.pdf")
        out = os.path.join(tmp_dir, "redact_out4.pdf")
        _make_redact_fixture(src)

        result = redact(file=src, output=out, regions=[{"page": 99, "rect": [0, 0, 10, 10]}])
        assert result["pages_redacted"] == 0
        text = extract_text(out)["text"]
        assert "SECRET DATA" in text

    def test_redact_finds_images_via_inherited_resources(self, tmp_dir):
        # Regression: a page whose /Resources lives on an ancestor /Pages
        # node (common generator output — a single shared /Resources dict
        # rather than one duplicated per page) must still have its images
        # found and redacted. Missing this was a false negative: the
        # dangerous failure direction for a redaction tool.
        src = os.path.join(tmp_dir, "redact_inherited.pdf")
        out = os.path.join(tmp_dir, "redact_inherited_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        img_stream = doc.make_stream(bytes([255, 0, 0] * 9))
        img_stream.Type = Name.XObject
        img_stream.Subtype = Name.Image
        img_stream.Width = 3
        img_stream.Height = 3
        img_stream.BitsPerComponent = 8
        img_stream.ColorSpace = Name.DeviceRGB
        # No page.Resources at all — put it on the Pages node instead.
        # (add_blank_page auto-assigns an empty /Resources dict directly on
        # the page; delete it so the inheritance walk is actually exercised.)
        del page.obj["/Resources"]
        doc.Root.Pages.Resources = Dictionary(XObject=Dictionary(Im0=img_stream))
        page.Contents = doc.make_stream(b"q 100 0 0 100 200 50 cm /Im0 Do Q")
        doc.save(src)
        doc.close()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [190, 40, 310, 160]}])
        assert result["images_removed"] == 1
        with pikepdf.open(out) as pdf:
            # The page still has no /Resources of its own; walk to the
            # inherited one the same way production code does.
            node = pdf.pages[0].obj
            while "/Resources" not in node:
                node = node.Parent
            xobjects = node.Resources.get("/XObject", {})
            assert list(xobjects.keys() if xobjects else []) == []

    def test_redact_drops_the_whole_instruction_on_partial_overlap(self, tmp_dir):
        # A region overlapping only PART of a large image/text run must
        # still remove the entire instruction — the module's documented
        # "over-redact rather than risk a false negative" behavior.
        src = os.path.join(tmp_dir, "redact_partial.pdf")
        out = os.path.join(tmp_dir, "redact_partial_out.pdf")
        _make_redact_fixture(src)

        # The image spans (200,50)-(300,150); this region only clips its
        # bottom-left corner.
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [190, 40, 220, 70]}])
        assert result["images_removed"] == 1
        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0].get("/Resources", {}).get("/XObject", {})
            assert list(xobjects.keys() if xobjects else []) == []

    def test_redact_tracks_rotated_cm_and_multiple_text_lines(self, tmp_dir):
        # A rotated cm (image placement) and two Td-separated lines of text
        # exercise matrix composition beyond the axis-aligned single-Td cases
        # the other tests cover.
        src = os.path.join(tmp_dir, "redact_rotated.pdf")
        out = os.path.join(tmp_dir, "redact_rotated_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        img_stream = doc.make_stream(bytes([0, 255, 0] * 9))
        img_stream.Type = Name.XObject
        img_stream.Subtype = Name.Image
        img_stream.Width = 3
        img_stream.Height = 3
        img_stream.BitsPerComponent = 8
        img_stream.ColorSpace = Name.DeviceRGB
        page.Resources = Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(Im0=img_stream))
        # 45-degree-rotated 50x50 image placement centered near (300,300),
        # plus two lines of text reached via two separate Td moves.
        content = (
            b"q 35.36 35.36 -35.36 35.36 300 265 cm /Im0 Do Q "
            b"BT /F1 12 Tf 50 300 Td (LINE ONE) Tj 0 -20 Td (LINE TWO) Tj ET"
        )
        page.Contents = doc.make_stream(content)
        doc.save(src)
        doc.close()

        # Region around the rotated image's bounding box.
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [260, 260, 340, 340]}])
        assert result["images_removed"] == 1

        # Region around the SECOND text line only (first Td at y=300, second
        # at y=280 after the relative -20 move) — must not remove LINE ONE.
        result2 = redact(file=src, output=out, regions=[{"page": 1, "rect": [40, 270, 150, 290]}])
        text = extract_text(out)["text"]
        assert "LINE ONE" in text
        assert "LINE TWO" not in text

    def test_redact_descends_into_form_xobject_and_spares_shared_uses(self, tmp_dir):
        # 2i: text drawn via a Form XObject under a region must be removed from
        # the OUTPUT BYTES, not just visually covered. And a form shared with a
        # second, non-overlapping placement must NOT lose its content there —
        # the redaction operates on a per-page copy, never the shared original.
        src = os.path.join(tmp_dir, "redact_form.pdf")
        out = os.path.join(tmp_dir, "redact_form_out.pdf")
        doc = pikepdf.new()
        p1 = doc.add_blank_page(page_size=(400, 400))
        p2 = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        # Two runs in the same form: FORMSECRET (will fall in the region) and
        # FORMKEEP (won't). FORMKEEP surviving as EXTRACTABLE text proves the
        # redacted copy is a valid, decodable stream — a copy that wrongly
        # inherits the original's /Filter over raw bytes would be corrupt and
        # FORMKEEP would be unreadable.
        form = doc.make_stream(b"BT /F1 12 Tf 10 40 Td (FORMSECRET) Tj 0 -35 Td (FORMKEEP) Tj ET")
        form.Type = Name.XObject
        form.Subtype = Name.Form
        form.BBox = [0, 0, 200, 60]
        form.Resources = Dictionary(Font=Dictionary(F1=font))
        form = doc.make_indirect(form)
        # Same form object on both pages: in-region on p1 (placed at 50,250),
        # far out of the redaction region on p2 (placed at 50,20).
        p1.Resources = Dictionary(XObject=Dictionary(Fm0=form))
        p1.Contents = doc.make_stream(b"q 1 0 0 1 50 250 cm /Fm0 Do Q")
        p2.Resources = Dictionary(XObject=Dictionary(Fm0=form))
        p2.Contents = doc.make_stream(b"q 1 0 0 1 50 20 cm /Fm0 Do Q")
        doc.save(src)
        doc.close()

        # FORMSECRET at form-y=40 → device y≈290 on p1 (in region); FORMKEEP at
        # form-y=5 → device y≈255 (below the region).
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [55, 285, 180, 305]}])
        assert result["text_runs_removed"] == 1

        text = extract_text(out)["text"]
        # Page 1's FORMSECRET gone; page 2's still there once; FORMKEEP kept on
        # both pages (2×) — the latter fails if the redacted copy is corrupt.
        assert text.count("FORMSECRET") == 1
        assert text.count("FORMKEEP") == 2

        with pikepdf.open(out) as pdf:
            # Every redacted form COPY must decode without error.
            for stream in _all_form_streams(pdf):
                stream.read_bytes()  # raises DataDecodingError on a corrupt copy
            # Byte-level (decode-or-raw): FORMSECRET must survive in exactly ONE
            # stream (page 2's untouched original) — proving page 1's copy
            # really dropped it and the shared original was not over-redacted.
            streams_with = sum(1 for obj in pdf.objects if _stream_contains(obj, b"FORMSECRET"))
            assert streams_with == 1

    def test_redact_removes_image_inside_form_and_prunes_its_bytes(self, tmp_dir):
        # 2i: an image drawn inside a Form XObject under a region must be gone
        # from the file, not merely undrawn — its XObject bytes must be pruned.
        src = os.path.join(tmp_dir, "redact_formimg.pdf")
        out = os.path.join(tmp_dir, "redact_formimg_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        img = doc.make_stream(bytes([7, 7, 7] * 9))
        img.Type = Name.XObject
        img.Subtype = Name.Image
        img.Width = 3
        img.Height = 3
        img.BitsPerComponent = 8
        img.ColorSpace = Name.DeviceRGB
        img = doc.make_indirect(img)
        form = doc.make_stream(b"q 40 0 0 40 5 5 cm /ImF Do Q")
        form.Type = Name.XObject
        form.Subtype = Name.Form
        form.BBox = [0, 0, 50, 50]
        form.Resources = Dictionary(XObject=Dictionary(ImF=img))
        form = doc.make_indirect(form)
        page.Resources = Dictionary(XObject=Dictionary(Fm0=form))
        # Form placed at (100,100); its image spans ~ (105,105)-(145,145).
        page.Contents = doc.make_stream(b"q 1 0 0 1 100 100 cm /Fm0 Do Q")
        doc.save(src)
        doc.close()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [110, 110, 140, 140]}])
        assert result["images_removed"] == 1

        # No Image XObject may remain reachable in the saved file.
        with pikepdf.open(out) as pdf:
            images = [
                obj
                for obj in pdf.objects
                if obj.get("/Type") == Name.XObject and obj.get("/Subtype") == Name.Image
            ]
            assert images == []
            # The redacted form copy must decode cleanly (guards the /Filter-
            # mismatch corruption class).
            for stream in _all_form_streams(pdf):
                stream.read_bytes()

    def test_redact_tracks_leading_based_lines(self, tmp_dir):
        # 2i: text laid out with TL + T* (leading-based next-line moves), not
        # explicit per-line Td, must track line positions so only the line
        # under the region is removed. The old walker ignored T*/leading and
        # collapsed every line onto the first line's origin.
        src = os.path.join(tmp_dir, "redact_leading.pdf")
        out = os.path.join(tmp_dir, "redact_leading_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        # LEADA at y=320, then T* (leading 14) → LEADB y=306, T* → LEADC y=292.
        page.Contents = doc.make_stream(
            b"BT /F1 12 Tf 14 TL 50 320 Td (LEADA) Tj T* (LEADB) Tj T* (LEADC) Tj ET"
        )
        doc.save(src)
        doc.close()

        # Region straddles only the middle line's band (y 306..318).
        redact(file=src, output=out, regions=[{"page": 1, "rect": [45, 307, 120, 317]}])
        text = extract_text(out)["text"]
        assert "LEADA" in text
        assert "LEADB" not in text
        assert "LEADC" in text

    def test_redact_strips_overlapping_annotations(self, tmp_dir):
        # 2i: an annotation whose /Rect overlaps a region is removed; one that
        # doesn't is kept. Content-stream stripping never touches annotation
        # appearances, so this is a separate removal path.
        src = os.path.join(tmp_dir, "redact_annot.pdf")
        out = os.path.join(tmp_dir, "redact_annot_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        a_over = doc.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.FreeText, Rect=[50, 250, 200, 290], Contents="hidden")
        )
        a_far = doc.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.FreeText, Rect=[50, 20, 200, 60], Contents="visible")
        )
        page.Annots = pikepdf.Array([a_over, a_far])
        page.Contents = doc.make_stream(b"")
        doc.save(src)
        doc.close()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [60, 255, 180, 285]}])
        assert result["annotations_removed"] == 1
        with pikepdf.open(out) as pdf:
            annots = pdf.pages[0].obj.get("/Annots")
            assert annots is not None and len(annots) == 1
            assert [float(v) for v in annots[0].Rect] == [50, 20, 200, 60]

    def test_redact_cascades_to_linked_popup_annotations(self, tmp_dir):
        # 2i review finding: removing a markup annotation whose /Popup sits at a
        # non-overlapping /Rect must ALSO remove the popup — its /Parent keeps
        # the "removed" markup object (and its secret /Contents) reachable
        # otherwise. Verified by a full-object byte scan of the output.
        src = os.path.join(tmp_dir, "redact_popup.pdf")
        out = os.path.join(tmp_dir, "redact_popup_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        markup = doc.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=[50, 250, 80, 280], Contents="TOPSECRETCOMMENT")
        )
        popup = doc.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.Popup, Rect=[350, 350, 395, 395], Parent=markup)
        )
        markup.Popup = popup
        page.Annots = pikepdf.Array([markup, popup])
        page.Contents = doc.make_stream(b"")
        doc.save(src)
        doc.close()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [40, 240, 90, 290]}])
        assert result["annotations_removed"] == 2  # markup + cascaded popup
        with pikepdf.open(out) as pdf:
            assert pdf.pages[0].obj.get("/Annots") is None
            for obj in pdf.objects:
                try:
                    contents = obj.get("/Contents")
                except Exception:
                    continue
                assert contents is None or "TOPSECRETCOMMENT" not in str(contents)

    def test_redact_restores_font_size_across_q_q(self, tmp_dir):
        # 2i review finding: text-state (font size / leading) is part of the
        # graphics state and must be restored by Q. A transient small font
        # inside q..Q must not leave a stale size that under-sizes a later
        # bbox — that under-estimate is an under-redaction leak.
        src = os.path.join(tmp_dir, "redact_fontstate.pdf")
        out = os.path.join(tmp_dir, "redact_fontstate_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        # Establish 40pt, transiently override to 8pt inside q..Q, then show
        # text relying on the restored 40pt. Only the true 40pt width reaches
        # into the region below.
        page.Contents = doc.make_stream(
            b"BT /F1 40 Tf ET q BT /F1 8 Tf ET Q BT 10 300 Td (SECRETBIG) Tj ET"
        )
        doc.save(src)
        doc.close()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [100, 295, 190, 320]}])
        assert result["text_runs_removed"] == 1
        assert "SECRETBIG" not in extract_text(out)["text"]

    def test_redact_survives_malformed_content_and_annots(self, tmp_dir):
        # 2i review finding: adversarial/malformed input must not crash the
        # whole operation. A 1-operand Td, a non-array TJ, and a null /Annots
        # entry are all tolerated; a valid region on the page still redacts.
        src = os.path.join(tmp_dir, "redact_malformed.pdf")
        out = os.path.join(tmp_dir, "redact_malformed_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(
            b"BT /F1 12 Tf 50 Td (BADTD) Tj 5 TJ 60 300 Td (REALSECRET) Tj ET"
        )
        page.Annots = pikepdf.Array([pikepdf.Object.parse(b"null")])
        doc.save(src)
        doc.close()

        # Must not raise, and must still remove the intersecting real text.
        # (The malformed `5 TJ` is preserved verbatim, so pdfminer can't parse
        # the output — scan the raw stream bytes for the secret instead.)
        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [55, 295, 200, 315]}])
        assert result["text_runs_removed"] >= 1
        with pikepdf.open(out) as pdf:
            for obj in pdf.objects:
                try:
                    data = obj.read_bytes()
                except Exception:
                    continue
                assert b"REALSECRET" not in data

    def test_redact_form_nesting_past_depth_cap_fails_closed(self, tmp_dir):
        # 2i re-review finding: a Form chain deeper than MAX_FORM_DEPTH must
        # NOT leave content intact — and the drop must be SIGNALLED so it isn't
        # silently reverted by an enclosing form bottoming out. A 20-wrapper
        # chain (deeper than the cap) around a secret, all placed inside the
        # region, must come back with the secret gone.
        src = os.path.join(tmp_dir, "redact_deep.pdf")
        out = os.path.join(tmp_dir, "redact_deep_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )

        def _make_form(content, resources):
            f = doc.make_stream(content)
            f.Type = Name.XObject
            f.Subtype = Name.Form
            f.BBox = [0, 0, 200, 200]
            f.Resources = resources
            return doc.make_indirect(f)

        cur = _make_form(b"BT /F1 12 Tf 5 5 Td (DEEPSECRET) Tj ET", Dictionary(Font=Dictionary(F1=font)))
        for _ in range(20):
            cur = _make_form(b"/Fm Do", Dictionary(XObject=Dictionary(Fm=cur)))
        page.Resources = Dictionary(XObject=Dictionary(Top=cur))
        page.Contents = doc.make_stream(b"q 1 0 0 1 50 50 cm /Top Do Q")
        doc.save(src)
        doc.close()

        # Region overlaps every placed bbox (form at (50,50), BBox 0..200).
        redact(file=src, output=out, regions=[{"page": 1, "rect": [40, 40, 160, 160]}])
        assert "DEEPSECRET" not in extract_text(out)["text"]
        with pikepdf.open(out) as pdf:
            for obj in pdf.objects:
                try:
                    data = obj.read_bytes()
                except Exception:
                    continue
                assert b"DEEPSECRET" not in data

    def test_redact_accounts_for_horizontal_scaling(self, tmp_dir):
        # 2i re-review finding: Tz (horizontal scaling) > 100 makes text WIDER
        # than the flat width estimate; the bbox must fold it in so expanded
        # text that reaches into a region is still caught.
        src = os.path.join(tmp_dir, "redact_tz.pdf")
        out = os.path.join(tmp_dir, "redact_tz_out.pdf")
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(400, 400))
        font = doc.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
        )
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        # 400% horizontal scaling: unscaled width ~54pt (from x=10) reaches to
        # ~64; the true 4x width reaches to ~226, into the region at x>=150.
        page.Contents = doc.make_stream(b"BT /F1 12 Tf 400 Tz 10 300 Td (SECRETTAG) Tj ET")
        doc.save(src)
        doc.close()

        result = redact(file=src, output=out, regions=[{"page": 1, "rect": [150, 295, 220, 320]}])
        assert result["text_runs_removed"] == 1
        assert "SECRETTAG" not in extract_text(out)["text"]


# ── Watermark ─────────────────────────────────────────────────────────────


def _make_watermark_fixture(path: str, page_count: int = 2, rotate: int | None = None, rotate_on_tree: bool = False) -> None:
    """Pages with per-page ORIGINAL <n> text. `rotate` lands on each page's
    own dict, or (rotate_on_tree) on the /Pages root so it must be resolved
    via the inheritance walk."""
    doc = pikepdf.new()
    font = doc.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )
    for i in range(page_count):
        page = doc.add_blank_page(page_size=(400, 400))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        page.Contents = doc.make_stream(f"BT /F1 12 Tf 50 300 Td (ORIGINAL {i + 1}) Tj ET".encode("ascii"))
        if rotate is not None and not rotate_on_tree:
            page.Rotate = rotate
    if rotate is not None and rotate_on_tree:
        doc.Root.Pages.Rotate = rotate
    doc.save(path)
    doc.close()


def _find_watermark_forms(page: pikepdf.Page) -> list:
    """The overlay Form XObjects our watermark attached to this page —
    identified by their private /F0 Helvetica resource."""
    forms = []
    xobjects = page.obj.get("/Resources", {}).get("/XObject", {})
    for _, candidate in (xobjects.items() if xobjects else []):
        if candidate.get("/Subtype") == Name.Form and "/F0" in candidate.get("/Resources", {}).get("/Font", {}):
            forms.append(candidate)
    return forms


def _tm_operands(form) -> list[float]:
    """Operands of the Tm operator inside a watermark form's stream."""
    for operands, operator in pikepdf.parse_content_stream(form):
        if str(operator) == "Tm":
            return [float(v) for v in operands]
    raise AssertionError("no Tm operator found in watermark form")


class TestWatermark:
    def test_watermark_stamps_every_page_and_keeps_content(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in.pdf")
        out = os.path.join(tmp_dir, "wm_out.pdf")
        _make_watermark_fixture(src)

        result = watermark(file=src, output=out, text="CONFIDENTIAL")
        assert result["pages_watermarked"] == 2
        assert result["font_size_applied"] > 0

        # Non-circular verification via pdfminer — which also proves the text
        # inside the overlay Form XObject's `Do` is really reachable content
        # (pdfminer descends into forms).
        text = extract_text(out)["text"]
        assert text.count("CONFIDENTIAL") == 2
        assert "ORIGINAL 1" in text
        assert "ORIGINAL 2" in text

    def test_watermark_pages_subset(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in2.pdf")
        out = os.path.join(tmp_dir, "wm_out2.pdf")
        _make_watermark_fixture(src)

        result = watermark(file=src, output=out, text="DRAFT", pages=[2])
        assert result["pages_watermarked"] == 1
        assert "DRAFT" not in extract_text(out, pages=[1])["text"]
        assert "DRAFT" in extract_text(out, pages=[2])["text"]

    def test_watermark_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in3.pdf")
        _make_watermark_fixture(src)

        watermark(file=src, output=src, text="STAMPED")
        text = extract_text(src)["text"]
        assert "STAMPED" in text
        assert "ORIGINAL 1" in text

    def test_watermark_opacity_lands_in_extgstate(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in4.pdf")
        out = os.path.join(tmp_dir, "wm_out4.pdf")
        _make_watermark_fixture(src, page_count=1)

        watermark(file=src, output=out, text="X", opacity=0.25)
        with pikepdf.open(out) as pdf:
            forms = _find_watermark_forms(pdf.pages[0])
            assert len(forms) == 1
            gs = forms[0].Resources.ExtGState.GS0
            assert float(gs.ca) == pytest.approx(0.25)
            assert float(gs.CA) == pytest.approx(0.25)

    def test_watermark_rotated_page_composes_the_display_angle(self, tmp_dir):
        # angle=0 on a /Rotate 90 page must be DRAWN at 90° in user space so
        # it reads horizontally in the displayed orientation.
        src = os.path.join(tmp_dir, "wm_rot.pdf")
        out = os.path.join(tmp_dir, "wm_rot_out.pdf")
        _make_watermark_fixture(src, page_count=1, rotate=90)

        watermark(file=src, output=out, text="SIDEWAYS", angle=0)
        with pikepdf.open(out) as pdf:
            a, b, c, d, _, _ = _tm_operands(_find_watermark_forms(pdf.pages[0])[0])
        assert a == pytest.approx(0.0, abs=1e-4)  # cos 90
        assert b == pytest.approx(1.0, abs=1e-4)  # sin 90
        assert c == pytest.approx(-1.0, abs=1e-4)
        assert d == pytest.approx(0.0, abs=1e-4)
        assert "SIDEWAYS" in extract_text(out)["text"]

    def test_watermark_honors_inherited_rotate(self, tmp_dir):
        # /Rotate hoisted onto the /Pages root (inheritable per spec) must be
        # found by the /Parent-chain walk — same generator pattern the redact
        # inherited-resources regression covered.
        src = os.path.join(tmp_dir, "wm_rot_inh.pdf")
        out = os.path.join(tmp_dir, "wm_rot_inh_out.pdf")
        _make_watermark_fixture(src, page_count=1, rotate=90, rotate_on_tree=True)

        watermark(file=src, output=out, text="SIDEWAYS", angle=0)
        with pikepdf.open(out) as pdf:
            a, b, _, _, _, _ = _tm_operands(_find_watermark_forms(pdf.pages[0])[0])
        assert a == pytest.approx(0.0, abs=1e-4)
        assert b == pytest.approx(1.0, abs=1e-4)

    def test_watermark_helvetica_widths_match_pdfminer(self):
        # The embedded ASCII advance table must agree with pdfminer's own
        # Helvetica AFM metrics (an independent source, already a test dep).
        # A wrong width regresses both auto-sizing and centering — the 0.5-em
        # average this table replaced underestimated uppercase text by ~40%
        # and pushed long stamps past the form BBox (caught live by the
        # watermark e2e as a clipped stamp tail).
        from pdfminer.fontmetrics import FONT_METRICS

        from engine.watermark import _HELVETICA_ASCII_WIDTHS

        _, char_widths = FONT_METRICS["Helvetica"]  # keyed by character
        for code in range(32, 127):
            ch = chr(code)
            assert _HELVETICA_ASCII_WIDTHS[code - 32] == char_widths[ch], (
                f"width mismatch for {ch!r}"
            )

    def test_watermark_long_uppercase_text_stays_inside_the_box(self, tmp_dir):
        # Regression for the e2e-caught overflow: auto-sized long uppercase
        # text on a Letter page at 45° must keep the whole baseline inside
        # the crop box (the form BBox clips whatever crosses it).
        from engine.watermark import _text_width_em

        src = os.path.join(tmp_dir, "wm_fit.pdf")
        out = os.path.join(tmp_dir, "wm_fit_out.pdf")
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(612, 792))
        doc.save(src)
        doc.close()

        text = "E2E-WATERMARK"
        result = watermark(file=src, output=out, text=text)
        size = result["font_size_applied"]
        with pikepdf.open(out) as pdf:
            a, b, _, _, tx, ty = _tm_operands(_find_watermark_forms(pdf.pages[0])[0])
        end_x = tx + _text_width_em(text) * size * a  # a = cos(theta)
        end_y = ty + _text_width_em(text) * size * b  # b = sin(theta)
        for v, hi in ((tx, 612), (end_x, 612), (ty, 792), (end_y, 792)):
            assert 0 <= v <= hi, f"baseline point {v} outside [0, {hi}]"

    def test_watermark_auto_size_shrinks_for_longer_text(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in5.pdf")
        _make_watermark_fixture(src, page_count=1)

        short = watermark(file=src, output=os.path.join(tmp_dir, "s.pdf"), text="HI")
        long = watermark(
            file=src,
            output=os.path.join(tmp_dir, "l.pdf"),
            text="THIS IS A MUCH LONGER WATERMARK LINE",
        )
        assert long["font_size_applied"] < short["font_size_applied"]

    def test_watermark_under_layer(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in6.pdf")
        out = os.path.join(tmp_dir, "wm_out6.pdf")
        _make_watermark_fixture(src, page_count=1)

        result = watermark(file=src, output=out, text="BEHIND", layer="under")
        assert result["layer"] == "under"
        text = extract_text(out)["text"]
        assert "BEHIND" in text
        assert "ORIGINAL 1" in text

    def test_watermark_out_of_range_pages_ignored(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in7.pdf")
        out = os.path.join(tmp_dir, "wm_out7.pdf")
        _make_watermark_fixture(src)

        result = watermark(file=src, output=out, text="X", pages=[99])
        assert result["pages_watermarked"] == 0
        assert "X" not in extract_text(out)["text"]

    def test_watermark_explicit_empty_pages_means_zero_pages_not_all(self, tmp_dir):
        # Review-caught: `if pages:` treated [] like None, so an empty
        # selection (e.g. from a caller whose page parse dropped every bad
        # token) silently widened to the WHOLE document. [] must match
        # rotate.py's convention: operate on zero pages.
        src = os.path.join(tmp_dir, "wm_in9.pdf")
        out = os.path.join(tmp_dir, "wm_out9.pdf")
        _make_watermark_fixture(src)

        result = watermark(file=src, output=out, text="X", pages=[])
        assert result["pages_watermarked"] == 0
        assert "X" not in extract_text(out)["text"]

    def test_watermark_glyph_metrics_match_pdfminer_descriptor(self):
        # _GLYPH_HEIGHT_EM is Ascent + |Descent| from the Helvetica AFM —
        # pinned against pdfminer's descriptor like the advance table.
        from pdfminer.fontmetrics import FONT_METRICS

        from engine.watermark import _GLYPH_HEIGHT_EM

        descriptor, _ = FONT_METRICS["Helvetica"]
        expected = (descriptor["Ascent"] + abs(descriptor["Descent"])) / 1000.0
        assert _GLYPH_HEIGHT_EM == pytest.approx(expected)

    def test_watermark_auto_size_respects_the_perpendicular_axis(self, tmp_dir):
        # Review-caught: the baseline crossing degenerates to a single term
        # at axis-aligned angles, so a banner-shaped box got a size that
        # ignored its height entirely and clipped vertically. The glyph box
        # must fit the box's thickness too, and the size must actually
        # respond to it.
        from engine.watermark import _GLYPH_HEIGHT_EM, MIN_AUTO_FONT_SIZE

        sizes = {}
        for h in (30, 60, 200):
            src = os.path.join(tmp_dir, f"wm_banner_{h}.pdf")
            out = os.path.join(tmp_dir, f"wm_banner_{h}_out.pdf")
            doc = pikepdf.new()
            doc.add_blank_page(page_size=(1500, h))
            doc.save(src)
            doc.close()
            result = watermark(
                file=src, output=out, text="CONFIDENTIAL BANNER STRIP", angle=0
            )
            size = result["font_size_applied"]
            sizes[h] = size
            assert (
                size * _GLYPH_HEIGHT_EM <= h or size == MIN_AUTO_FONT_SIZE
            ), f"glyph box {size * _GLYPH_HEIGHT_EM:.1f}pt overflows {h}pt-tall page"
        assert sizes[30] < sizes[60] < sizes[200], f"size must track the box height: {sizes}"

    def test_watermark_rejects_bad_args(self, tmp_dir):
        src = os.path.join(tmp_dir, "wm_in8.pdf")
        out = os.path.join(tmp_dir, "wm_out8.pdf")
        _make_watermark_fixture(src, page_count=1)

        with pytest.raises(ValueError):
            watermark(file=src, output=out, text="   ")
        with pytest.raises(ValueError):
            watermark(file=src, output=out, text="X", color="red")
        with pytest.raises(ValueError):
            watermark(file=src, output=out, text="X", opacity=0)
        with pytest.raises(ValueError):
            watermark(file=src, output=out, text="X", layer="sideways")



# ── Compare ───────────────────────────────────────────────────────────────


def _make_text_pdf(path: str, pages: list[list[str]]) -> None:
    """Build a PDF from `pages` (list of pages, each a list of text lines) —
    one `BT .. Tj ET` per line at a descending y, so pdfminer extracts them as
    distinct lines top-to-bottom. Same reportlab-free style as the redaction
    fixtures."""
    doc = pikepdf.new()
    font = doc.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )
    for lines in pages:
        page = doc.add_blank_page(page_size=(400, 600))
        page.Resources = Dictionary(Font=Dictionary(F1=font))
        parts = []
        y = 550
        for line in lines:
            esc = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            parts.append(f"BT /F1 12 Tf 50 {y} Td ({esc}) Tj ET".encode("latin-1"))
            y -= 16
        page.Contents = doc.make_stream(b"\n".join(parts))
    doc.save(path)
    doc.close()


class TestCompare:
    def test_identical_files(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [["alpha", "beta", "gamma"]])
        _make_text_pdf(b, [["alpha", "beta", "gamma"]])
        r = compare_text(a, b)
        assert r["summary"]["identical"] is True
        assert r["summary"]["similarity"] == 1.0
        assert r["summary"]["lines_added"] == 0
        assert r["summary"]["lines_removed"] == 0
        assert all(row["type"] == "context" for row in r["rows"])

    def test_insertion(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [["alpha", "beta", "gamma"]])
        _make_text_pdf(b, [["alpha", "beta", "delta", "gamma"]])
        r = compare_text(a, b)
        assert r["summary"]["identical"] is False
        assert r["summary"]["lines_added"] == 1
        assert r["summary"]["lines_removed"] == 0
        assert any(row["type"] == "add" and row["text"] == "delta" for row in r["rows"])

    def test_deletion(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [["alpha", "beta", "gamma"]])
        _make_text_pdf(b, [["alpha", "gamma"]])
        r = compare_text(a, b)
        assert r["summary"]["lines_removed"] == 1
        assert r["summary"]["lines_added"] == 0
        assert any(row["type"] == "remove" and row["text"] == "beta" for row in r["rows"])

    def test_replacement(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [["alpha", "beta", "gamma"]])
        _make_text_pdf(b, [["alpha", "BETA", "gamma"]])
        r = compare_text(a, b)
        assert r["summary"]["identical"] is False
        assert r["summary"]["lines_added"] == 1
        assert r["summary"]["lines_removed"] == 1
        assert any(row["type"] == "remove" and row["text"] == "beta" for row in r["rows"])
        assert any(row["type"] == "add" and row["text"] == "BETA" for row in r["rows"])

    def test_change_is_attributed_to_its_page(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [["page one line"], ["page two original"]])
        _make_text_pdf(b, [["page one line"], ["page two changed"]])
        r = compare_text(a, b)
        removed = [row for row in r["rows"] if row["type"] == "remove"]
        added = [row for row in r["rows"] if row["type"] == "add"]
        assert removed and removed[0]["text"] == "page two original"
        assert removed[0]["page"] == 2
        assert added and added[0]["text"] == "page two changed"
        assert added[0]["page"] == 2

    def test_differing_page_counts(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [["only page"]])
        _make_text_pdf(b, [["only page"], ["brand new page"]])
        r = compare_text(a, b)
        assert r["summary"]["pages_a"] == 1
        assert r["summary"]["pages_b"] == 2
        assert r["summary"]["lines_added"] == 1
        assert any(row.get("text") == "brand new page" and row["page"] == 2 for row in r["rows"])

    def test_both_empty_text_is_identical(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [[]])  # a blank page, no text
        _make_text_pdf(b, [[]])
        r = compare_text(a, b)
        assert r["summary"]["identical"] is True
        assert r["summary"]["similarity"] == 1.0
        assert r["rows"] == []

    def test_truncation_caps_rows_but_not_counts(self, tmp_dir, monkeypatch):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        _make_text_pdf(a, [[f"a-line-{i}" for i in range(20)]])
        _make_text_pdf(b, [[f"b-line-{i}" for i in range(20)]])  # every line differs
        monkeypatch.setattr(compare_mod, "MAX_ROWS", 5)
        r = compare_text(a, b)
        assert r["summary"]["truncated"] is True
        assert len(r["rows"]) == 5
        # Counts reflect the FULL diff even though rows were capped.
        assert r["summary"]["lines_removed"] == 20
        assert r["summary"]["lines_added"] == 20

    def test_intraline_segments_mark_only_the_changed_word(self, tmp_dir):
        # 2j: a similar replaced-line pair carries word-level segments on both
        # rows; joining segment texts reconstructs each line, and only the
        # edited word is flagged changed.
        a = os.path.join(tmp_dir, "il_a.pdf")
        b = os.path.join(tmp_dir, "il_b.pdf")
        _make_text_pdf(a, [["the quick brown fox jumps"]])
        _make_text_pdf(b, [["the quick red fox jumps"]])
        r = compare_text(a, b)
        remove = next(row for row in r["rows"] if row["type"] == "remove")
        add = next(row for row in r["rows"] if row["type"] == "add")
        assert "".join(t for t, _ in remove["segments"]) == "the quick brown fox jumps"
        assert "".join(t for t, _ in add["segments"]) == "the quick red fox jumps"
        assert [t for t, changed in remove["segments"] if changed] == ["brown"]
        assert [t for t, changed in add["segments"] if changed] == ["red"]
        # Counts/summary semantics unchanged by segments.
        assert r["summary"]["lines_removed"] == 1
        assert r["summary"]["lines_added"] == 1

    def test_intraline_skipped_for_dissimilar_replacement(self, tmp_dir):
        # A replace pair with nothing in common stays whole-line (no segments)
        # — word-level confetti would be noise, not signal.
        a = os.path.join(tmp_dir, "ild_a.pdf")
        b = os.path.join(tmp_dir, "ild_b.pdf")
        _make_text_pdf(a, [["context line", "aaaa bbbb cccc"]])
        _make_text_pdf(b, [["context line", "zzzz yyyy xxxx qqqq"]])
        r = compare_text(a, b)
        remove = next(row for row in r["rows"] if row["type"] == "remove")
        add = next(row for row in r["rows"] if row["type"] == "add")
        assert "segments" not in remove
        assert "segments" not in add


# ── Visual compare ──────────────────────────────────────────────────────────


def _make_square_pdf(path: str, pages: list[int | None], size: int = 60) -> None:
    """One page per entry: a red square at x=<entry> (y fixed at 300 in a
    400×400 page), or a blank page for None. Image-only content — invisible
    to the text diff, exactly what the visual diff exists to catch."""
    doc = pikepdf.new()
    for x in pages:
        page = doc.add_blank_page(page_size=(400, 400))
        if x is None:
            page.Contents = doc.make_stream(b"")
            continue
        img = doc.make_stream(bytes([255, 0, 0] * 9))
        img.Type = Name.XObject
        img.Subtype = Name.Image
        img.Width = 3
        img.Height = 3
        img.BitsPerComponent = 8
        img.ColorSpace = Name.DeviceRGB
        page.Resources = Dictionary(XObject=Dictionary(Im0=img))
        page.Contents = doc.make_stream(f"q {size} 0 0 {size} {x} 300 cm /Im0 Do Q".encode("ascii"))
    doc.save(path)
    doc.close()


class TestCompareVisual:
    def test_identical_files_visually_identical(self, tmp_dir, gs_path):
        a = os.path.join(tmp_dir, "va.pdf")
        b = os.path.join(tmp_dir, "vb.pdf")
        _make_square_pdf(a, [50, 200])
        _make_square_pdf(b, [50, 200])
        r = compare_visual(a, b, gs_path=gs_path)
        assert r["summary"]["identical"] is True
        assert r["summary"]["pairs_differing"] == 0
        assert all(p["identical"] for p in r["pages"])
        assert all(p["regions"] == [] for p in r["pages"])

    def test_image_only_change_caught_visually_but_not_by_text(self, tmp_dir, gs_path):
        # THE acceptance scenario for 2j: content with no extractable text —
        # the text diff reads both files as identical; the visual diff must
        # flag the moved square and localize it.
        a = os.path.join(tmp_dir, "va.pdf")
        b = os.path.join(tmp_dir, "vb.pdf")
        _make_square_pdf(a, [50, 200])
        _make_square_pdf(b, [250, 200])  # page 1 square moved, page 2 unchanged
        assert compare_text(a, b)["summary"]["identical"] is True

        r = compare_visual(a, b, gs_path=gs_path)
        assert r["summary"]["identical"] is False
        assert r["summary"]["pairs_differing"] == 1
        p1 = next(p for p in r["pages"] if p["page"] == 1)
        p2 = next(p for p in r["pages"] if p["page"] == 2)
        assert p1["identical"] is False and p2["identical"] is True
        # Exactly the two 60×60 squares' pixels differ (old + new position).
        assert p1["diff_pixels"] == 2 * 60 * 60
        # Region(s) cover both positions: x spans 50..310, y band 40..100
        # (top-down raster space: page height 400, square top at 400-360=40).
        assert p1["regions"], "changed regions must be reported"
        x0 = min(reg["x"] for reg in p1["regions"])
        x1 = max(reg["x"] + reg["w"] for reg in p1["regions"])
        y0 = min(reg["y"] for reg in p1["regions"])
        y1 = max(reg["y"] + reg["h"] for reg in p1["regions"])
        assert abs(x0 - 50) <= 2 and abs(x1 - 310) <= 2
        assert abs(y0 - 40) <= 2 and abs(y1 - 100) <= 2
        # Regions are in-bounds page points.
        assert p1["width_pts"] == 400 and p1["height_pts"] == 400
        for reg in p1["regions"]:
            assert 0 <= reg["x"] <= 400 and 0 <= reg["y"] <= 400

    def test_page_count_mismatch_reports_unpaired(self, tmp_dir, gs_path):
        a = os.path.join(tmp_dir, "va.pdf")
        b = os.path.join(tmp_dir, "vb.pdf")
        _make_square_pdf(a, [50])
        _make_square_pdf(b, [50, 200, None])
        r = compare_visual(a, b, gs_path=gs_path)
        assert r["summary"]["identical"] is False  # counts differ
        assert r["summary"]["pairs_compared"] == 1
        assert r["summary"]["unpaired_b"] == 2
        unpaired = [p for p in r["pages"] if p.get("only_in") == "b"]
        assert [p["page"] for p in unpaired] == [2, 3]

    def test_size_mismatch_is_a_visual_difference(self, tmp_dir, gs_path):
        # Same content, different page size: the non-overlap band differs by
        # construction (white pad vs nothing is still a mismatch in dims —
        # the pair must not read identical).
        a = os.path.join(tmp_dir, "va.pdf")
        b = os.path.join(tmp_dir, "vb.pdf")
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(400, 400)).Contents = doc.make_stream(b"q 0 0 0 rg 10 10 50 50 re f Q")
        doc.save(a)
        doc.close()
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(400, 500)).Contents = doc.make_stream(b"q 0 0 0 rg 10 10 50 50 re f Q")
        doc.save(b)
        doc.close()
        r = compare_visual(a, b, gs_path=gs_path)
        p1 = r["pages"][0]
        assert p1["identical"] is False
        # The compare space is the union of both sizes.
        assert p1["width_pts"] == 400 and p1["height_pts"] == 500

    def test_dpi_validation(self, tmp_dir, gs_path):
        a = os.path.join(tmp_dir, "va.pdf")
        _make_square_pdf(a, [50])
        with pytest.raises(ValueError):
            compare_visual(a, a, dpi=10, gs_path=gs_path)
        with pytest.raises(ValueError):
            compare_visual(a, a, dpi=1200, gs_path=gs_path)

    def test_read_ppm_is_strict(self, tmp_dir):
        # Review-driven (two rounds): tolerance for non-conformant PPM framing
        # is provably unsound — front surplus (CRLF separator) and trailing
        # surplus (appended newline) are indistinguishable whenever the first
        # pixel byte is whitespace-valued, and guessing wrong silently shifts
        # the buffer into a bogus diff. So: strict, loud, no recovery.
        from engine.compare import _read_ppm

        def probe(name, content):
            p = os.path.join(tmp_dir, name)
            with open(p, "wb") as f:
                f.write(content)
            return _read_ppm(__import__("pathlib").Path(p))

        body = bytes([0xAB] * 6)
        # Conformant (with and without the gs comment line) parses exactly.
        assert probe("ok.ppm", b"P6\n2 1\n255\n" + body) == (2, 1, body)
        assert probe("okc.ppm", b"P6\n# gs\n2 1\n255\n" + body) == (2, 1, body)
        # Every non-strict framing raises — never a shifted buffer.
        for name, content in [
            ("crlf.ppm", b"P6\n2 1\n255\r\n" + body),  # 2-byte separator
            ("trail.ppm", b"P6\n2 1\n255\n" + body + b"\n"),  # trailing junk
            ("trunc.ppm", b"P6\n2 1\n255\n" + body[:-1]),  # short body
            ("garb.ppm", b"P6\n2 1\n255\nZ" + body),  # non-ws surplus
            ("eof.ppm", b"P6\n2 1\n255"),  # ends at maxval
            ("maxval.ppm", b"P6\n2 1\n65535\n" + body),  # 16-bit
        ]:
            with pytest.raises(ValueError):
                probe(name, content)

    def test_garbage_input_raises_never_identical(self, tmp_dir, gs_path):
        # Review round 3: page counts must come from the RENDERING mechanism.
        # A soft-failing counter (gs pdfpagecount prints an error + fallback
        # "0" and exits 0 on garbage) once made two unreadable files compare
        # "identical: true" — the worst possible output for a compare tool.
        # Garbage input must raise loud instead.
        g1 = os.path.join(tmp_dir, "garbage1.pdf")
        g2 = os.path.join(tmp_dir, "garbage2.pdf")
        v = os.path.join(tmp_dir, "valid.pdf")
        with open(g1, "wb") as f:
            f.write(b"this is not a pdf at all")
        with open(g2, "wb") as f:
            f.write(b"different garbage entirely")
        _make_square_pdf(v, [50])
        # Garbage now fails at the structural pre-count (pikepdf.PdfError) —
        # the same loud behavior compare_text has for unreadable files; had it
        # reached rendering, the gs nonzero-exit raise (RuntimeError) catches
        # it. Either way: an exception, never a bogus "identical" report.
        with pytest.raises((RuntimeError, pikepdf.PdfError)):
            compare_visual(g1, g2, gs_path=gs_path)
        with pytest.raises((RuntimeError, pikepdf.PdfError)):
            compare_visual(g1, v, gs_path=gs_path)

    def test_semicolon_filenames_compare_fine(self, tmp_dir, gs_path):
        # Review round 3: gs's --permit-file-read splits its value on the OS
        # path-list separator (';' on Windows), so the pdfpagecount approach
        # broke legitimate semicolon filenames. The rendering mechanism passes
        # the path as a plain positional argument — must just work.
        a = os.path.join(tmp_dir, "Quarterly Report; Draft.pdf")
        b = os.path.join(tmp_dir, "Quarterly Report; Final.pdf")
        _make_square_pdf(a, [50])
        _make_square_pdf(b, [250])
        r = compare_visual(a, b, gs_path=gs_path)
        assert r["summary"]["pairs_differing"] == 1

    def test_damaged_page_tree_refuses_instead_of_truncating(self, tmp_dir, gs_path):
        # Review round 4: gs's page-tree walk halts SILENTLY (rc 0) at a
        # damaged interior node — indistinguishable from document end — so a
        # 5-page file with a corrupted 3rd /Kids entry renders only 2 pages
        # and would compare as a 2-page document, reporting real pages 3-5 as
        # missing with no error. The structural-count disagreement detector
        # must refuse loudly instead (this app repairs damaged PDFs; comparing
        # them is a first-class scenario, not an edge case).
        broken = os.path.join(tmp_dir, "broken5.pdf")
        healthy = os.path.join(tmp_dir, "healthy5.pdf")
        doc = pikepdf.new()
        for _ in range(5):
            doc.add_blank_page(page_size=(200, 200))
        doc.Root.Pages.Kids[2] = doc.make_indirect(Dictionary())  # bare dict, no /Type
        doc.save(broken)
        doc.close()
        _make_square_pdf(healthy, [50, 50, 50, 50, 50])

        with pytest.raises(RuntimeError, match="damaged"):
            compare_visual(broken, healthy, gs_path=gs_path)
        # Order-independent: the damaged file as B must refuse too.
        with pytest.raises(RuntimeError, match="damaged"):
            compare_visual(healthy, broken, gs_path=gs_path)

    def test_tail_damage_refuses_both_files_never_identical(self, tmp_dir, gs_path):
        # Post-commit review of the first 2j commit: TAIL-positioned damage —
        # where nothing real follows the break — made pikepdf's lenient
        # recovery count and gs's halt-at-damage count COINCIDE, so two
        # damaged files compared identical:true with zero signal. The strict
        # tree walk must refuse this exact construction (4 real pages + a
        # sibling /Pages branch lying Count=3 over genuinely empty Kids).
        def build(path):
            doc = pikepdf.new()
            for _ in range(4):
                doc.add_blank_page(page_size=(200, 200))
            liar = doc.make_indirect(
                Dictionary(Type=Name.Pages, Count=3, Kids=pikepdf.Array([]), Parent=doc.Root.Pages)
            )
            doc.Root.Pages.Kids.append(liar)
            doc.save(path)
            doc.close()

        a = os.path.join(tmp_dir, "hole_a.pdf")
        b = os.path.join(tmp_dir, "hole_b.pdf")
        build(a)
        build(b)
        # The lenient walk sees 4 (skips the lying branch) — the exact
        # agreement that previously waved the pair through.
        from engine.compare import _page_count

        assert _page_count(a) == 4
        with pytest.raises(RuntimeError, match="malformed"):
            compare_visual(a, b, gs_path=gs_path)

    def test_count_consistent_tail_damage_caught_by_render_crosscheck(self, tmp_dir, gs_path):
        # Layered defense, second layer: damage qpdf REPAIRS into a self-
        # consistent tree (bare dict kid healed into a /Page, root Count made
        # consistent) passes the strict walk — but gs still halts at the
        # damaged node on disk, so the render count cross-check refuses.
        p = os.path.join(tmp_dir, "tailc.pdf")
        healthy = os.path.join(tmp_dir, "healthy4.pdf")
        doc = pikepdf.new()
        for _ in range(4):
            doc.add_blank_page(page_size=(200, 200))
        doc.Root.Pages.Kids.append(doc.make_indirect(Dictionary()))
        doc.Root.Pages.Count = 5  # consistent with the repair-materialized view
        doc.save(p)
        doc.close()
        _make_square_pdf(healthy, [50, 50, 50, 50])
        with pytest.raises(RuntimeError, match="damaged"):
            compare_visual(p, healthy, gs_path=gs_path)

    def test_spec_violating_count_refuses_even_when_renderable(self, tmp_dir, gs_path):
        # Behavior change vs. the earlier negative control: a lying interior
        # /Count (says 3, five real kids) renders fully in BOTH engines, but
        # the strict walk refuses anyway — a compare cannot certify
        # completeness on a structure it cannot certify, and repair exists.
        p = os.path.join(tmp_dir, "liedcount.pdf")
        doc = pikepdf.new()
        for _ in range(5):
            doc.add_blank_page(page_size=(200, 200))
        doc.Root.Pages.Count = 3
        doc.save(p)
        doc.close()
        with pytest.raises(RuntimeError, match="malformed"):
            compare_visual(p, p, gs_path=gs_path)

    def test_initial_chunk_pages_scales_with_dpi(self):
        # Post-commit review note: a fixed 8-page probe overshot the byte
        # budget ~1.5x at the dpi ceiling. The probe must scale down with dpi
        # (budget is TOTAL in-flight bytes across both sides).
        from engine.compare import _initial_chunk_pages, CHUNK_BYTE_BUDGET, CHUNK_PROBE_PAGES

        assert _initial_chunk_pages(72) == CHUNK_PROBE_PAGES  # classic probe intact
        probe_300 = _initial_chunk_pages(300)
        assert 1 <= probe_300 < CHUNK_PROBE_PAGES
        letter_300 = int(8.5 * 300) * int(11 * 300) * 3
        assert 2 * probe_300 * letter_300 <= CHUNK_BYTE_BUDGET

    def test_asymmetric_lengths_report_exact_counts(self, tmp_dir, gs_path, monkeypatch):
        # The longer side's tail count is discovered by rendering too
        # (_count_pages_by_rendering). Force tiny chunks so the tail path
        # actually runs (paired loop exits at A's end inside chunk 1's range,
        # B continues) and assert exact counts + unpaired listing.
        import engine.compare as cmp_mod

        monkeypatch.setattr(cmp_mod, "CHUNK_PROBE_PAGES", 2)
        monkeypatch.setattr(cmp_mod, "CHUNK_MAX_PAGES", 2)
        monkeypatch.setattr(cmp_mod, "TAIL_COUNT_CHUNK", 2)
        a = os.path.join(tmp_dir, "short.pdf")
        b = os.path.join(tmp_dir, "long.pdf")
        _make_square_pdf(a, [50])
        _make_square_pdf(b, [50, 200, 200, 200, 200])
        r = compare_visual(a, b, gs_path=gs_path)
        assert r["summary"]["pages_a"] == 1
        assert r["summary"]["pages_b"] == 5
        assert r["summary"]["pairs_compared"] == 1
        assert r["summary"]["identical"] is False
        unpaired = [p["page"] for p in r["pages"] if p.get("only_in") == "b"]
        assert unpaired == [2, 3, 4, 5]

    def test_chunked_rendering_attributes_pages_correctly(self, tmp_dir, gs_path, monkeypatch):
        # Rendering happens in bounded chunks (gs -dFirstPage/-dLastPage) and
        # gs's %d file counter restarts at 1 per invocation — the chunk→page
        # mapping must not drift. Force 2-page chunks over a 5-page doc where
        # ONLY pages 2 and 5 differ (each lands in a different chunk, page 5
        # in a partial final chunk) and assert exactly those are flagged.
        import engine.compare as cmp_mod

        monkeypatch.setattr(cmp_mod, "CHUNK_PROBE_PAGES", 2)
        monkeypatch.setattr(cmp_mod, "CHUNK_MAX_PAGES", 2)
        a = os.path.join(tmp_dir, "va.pdf")
        b = os.path.join(tmp_dir, "vb.pdf")
        _make_square_pdf(a, [50, 50, 50, 50, 50])
        _make_square_pdf(b, [50, 250, 50, 50, 250])
        r = compare_visual(a, b, gs_path=gs_path)
        flags = {p["page"]: p["identical"] for p in r["pages"]}
        assert flags == {1: True, 2: False, 3: True, 4: True, 5: False}
        assert r["summary"]["pairs_differing"] == 2
        # Regions still localized on the differing pages.
        p2 = next(p for p in r["pages"] if p["page"] == 2)
        assert p2["regions"] and abs(min(reg["x"] for reg in p2["regions"]) - 50) <= 2


# ── Verify signatures ───────────────────────────────────────────────────────


_SIGNER = None


def _self_signed_signer():
    """A pyHanko signer backed by a fresh 100-year self-signed cert (test
    fixtures only — the app ships verification, not signing)."""
    import datetime
    import tempfile

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID
    from pyhanko.sign import signers

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Spectra Test Signer")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2000, 1, 1))
        .not_valid_after(datetime.datetime(2100, 1, 1))
        .sign(key, hashes.SHA256())
    )
    pfx = pkcs12.serialize_key_and_certificates(
        b"t", key, cert, None, serialization.BestAvailableEncryption(b"pw")
    )
    p = tempfile.mktemp(suffix=".pfx")
    with open(p, "wb") as f:
        f.write(pfx)
    return signers.SimpleSigner.load_pkcs12(p, passphrase=b"pw")


def _signer():
    global _SIGNER
    if _SIGNER is None:
        _SIGNER = _self_signed_signer()  # one keygen per test session
    return _SIGNER


def _sign_into(path: str, field_name: str) -> None:
    """Sign the PDF at `path` in place, adding a signature field."""
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import signers

    with open(path, "rb") as inf:
        writer = IncrementalPdfFileWriter(inf)
        out = signers.sign_pdf(
            writer, signers.PdfSignatureMetadata(field_name=field_name), signer=_signer()
        )
    with open(path, "wb") as f:
        f.write(out.getvalue())


def _make_signed_pdf(path: str, field_name: str = "Sig1") -> None:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(400, 400))
    doc.save(path)
    doc.close()
    _sign_into(path, field_name)


class TestVerifySignatures:
    def test_unsigned_pdf_reports_not_signed(self, tmp_dir):
        p = os.path.join(tmp_dir, "unsigned.pdf")
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(200, 200))
        doc.save(p)
        doc.close()
        r = verify_signatures(p)
        assert r["signed"] is False
        assert r["signatures"] == []
        assert r["summary"]["all_valid"] is False

    def test_valid_signature(self, tmp_dir):
        p = os.path.join(tmp_dir, "signed.pdf")
        _make_signed_pdf(p)
        r = verify_signatures(p)
        assert r["signed"] is True
        assert r["signature_count"] == 1
        s = r["signatures"][0]
        assert s["valid"] is True
        assert s["intact"] is True
        assert s["covers_whole_document"] is True
        assert s["modified_after_signing"] is False
        assert s["trusted"] is False  # single-cert: no trust store consulted
        assert "Spectra Test Signer" in (s["signer"] or "")
        assert s["digest_algorithm"] == "sha256"
        assert r["summary"]["all_valid"] is True
        # We NEVER claim trust — even a cryptographically valid signature.
        assert r["summary"]["trust_verified"] is False

    def test_tampered_covered_byte_breaks_integrity(self, tmp_dir):
        p = os.path.join(tmp_dir, "signed.pdf")
        _make_signed_pdf(p)
        with open(p, "rb") as f:
            data = bytearray(f.read())
        data[100] ^= 0xFF  # flip a byte inside the signed byte range
        with open(p, "wb") as f:
            f.write(bytes(data))
        r = verify_signatures(p)
        # The security-critical property: a tampered doc is never reported OK.
        assert r["summary"]["all_valid"] is False
        assert r["signatures"][0]["intact"] is False

    def test_modification_after_signing_detected(self, tmp_dir):
        p = os.path.join(tmp_dir, "signed.pdf")
        _make_signed_pdf(p)
        with open(p, "ab") as f:
            f.write(b"\n% appended after signing\n")
        r = verify_signatures(p)
        s = r["signatures"][0]
        assert s["modified_after_signing"] is True
        assert s["covers_whole_document"] is False
        assert r["summary"]["any_modified_after_signing"] is True

    def test_multiple_signatures(self, tmp_dir):
        p = os.path.join(tmp_dir, "signed.pdf")
        _make_signed_pdf(p, field_name="Sig1")
        _sign_into(p, "Sig2")  # second signature, incremental
        r = verify_signatures(p)
        assert r["signature_count"] == 2
        assert {s["field"] for s in r["signatures"]} == {"Sig1", "Sig2"}
        assert all(s["valid"] for s in r["signatures"])

    def test_pyhanko_can_report_trusted_as_a_positive_control(self, tmp_dir):
        # Proves the mechanism CAN return trusted=True — so trusted=False from
        # verify_signatures is a deliberate empty-trust choice, not merely an
        # un-anchorable cert. Validates the SAME signature directly with the
        # signer's own cert supplied AS a trust root.
        import io

        from pyhanko.pdf_utils.reader import PdfFileReader
        from pyhanko.sign.validation import validate_pdf_signature
        from pyhanko_certvalidator import ValidationContext

        p = os.path.join(tmp_dir, "signed.pdf")
        _make_signed_pdf(p)
        with open(p, "rb") as f:
            esig = PdfFileReader(io.BytesIO(f.read())).embedded_signatures[0]
        status = validate_pdf_signature(
            esig,
            signer_validation_context=ValidationContext(trust_roots=[_signer().signing_cert]),
        )
        assert status.trusted is True

    def test_trusted_stays_false_even_if_signer_is_an_os_trust_root(self, tmp_dir, monkeypatch):
        # The security invariant this whole feature rests on. If the handler
        # passed signer_validation_context=None, pyHanko would fall back to the
        # OS certificate store, and a signer whose cert lives there (any real
        # commercial CA) would report trusted=True — machine-dependent and
        # contradicting our "identity NOT verified" promise. We pass an explicit
        # EMPTY trust context, so even with the signer's own cert injected into
        # the OS store, trusted must stay False. (This test FAILS on a revert to
        # None; the plain valid-signature test would not.)
        import oscrypto.trust_list as os_trust

        p = os.path.join(tmp_dir, "signed.pdf")
        _make_signed_pdf(p)
        signer_cert = _signer().signing_cert  # asn1crypto x509.Certificate
        monkeypatch.setattr(
            os_trust, "get_list", lambda *a, **k: [(signer_cert, set(), set())]
        )
        r = verify_signatures(p)
        s = r["signatures"][0]
        assert s["valid"] is True and s["intact"] is True  # crypto still fine
        assert s["trusted"] is False  # but the OS store is never consulted
        assert r["summary"]["trust_verified"] is False


# ── Sign ────────────────────────────────────────────────────────────────────


def _make_test_pfx(path: str, password: str = "testpw") -> str:
    """Write a self-signed, 100-year PKCS#12 signer to `path`."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Spectra Test Signer")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime(2000, 1, 1))
        .not_valid_after(datetime.datetime(2100, 1, 1))
        .sign(key, hashes.SHA256())
    )
    enc = (
        serialization.BestAvailableEncryption(password.encode())
        if password
        else serialization.NoEncryption()
    )
    with open(path, "wb") as f:
        f.write(pkcs12.serialize_key_and_certificates(b"test", key, cert, None, enc))
    return path


def _blank_pdf(path: str) -> str:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(300, 300))
    doc.save(path)
    doc.close()
    return path


def _make_test_pem(tmp_dir: str, key_password: str | None = None, with_chain: bool = False):
    """Write PEM signer materials: (key_path, cert_path). With `with_chain`,
    cert_path is a FULLCHAIN file (leaf first, then the intermediate that
    issued it) — the ubiquitous fullchain.pem layout."""
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    def make_cert(subject_cn, issuer_name, issuer_key, key, ca=False):
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject_cn)])
        builder = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer_name if issuer_name is not None else subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime(2000, 1, 1))
            .not_valid_after(datetime.datetime(2100, 1, 1))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        )
        return builder.sign(issuer_key if issuer_key is not None else key, hashes.SHA256()), subject

    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    chain_pem = b""
    if with_chain:
        inter_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        inter_cert, inter_name = make_cert("Spectra Test Intermediate", None, None, inter_key, ca=True)
        leaf_cert, _ = make_cert("Spectra PEM Signer", inter_name, inter_key, leaf_key)
        chain_pem = inter_cert.public_bytes(serialization.Encoding.PEM)
    else:
        leaf_cert, _ = make_cert("Spectra PEM Signer", None, None, leaf_key)

    enc = (
        serialization.BestAvailableEncryption(key_password.encode())
        if key_password
        else serialization.NoEncryption()
    )
    key_path = os.path.join(tmp_dir, "signer.key.pem")
    cert_path = os.path.join(tmp_dir, "signer.crt.pem")
    with open(key_path, "wb") as f:
        f.write(
            leaf_key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, enc
            )
        )
    with open(cert_path, "wb") as f:
        f.write(leaf_cert.public_bytes(serialization.Encoding.PEM) + chain_pem)
    return key_path, cert_path


class TestSignPdf:
    def test_sign_then_verify_roundtrip(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, pfx_path=pfx, password="pw")
        assert os.path.isfile(out)
        # The engine self-verifies and echoes the result.
        assert r["valid"] is True
        assert r["intact"] is True
        assert r["covers_whole_document"] is True
        assert "Spectra Test Signer" in (r["signer"] or "")
        # And our own verify handler agrees on the produced file.
        v = verify_signatures(out)
        assert v["signed"] is True
        assert v["summary"]["all_valid"] is True

    def test_tampered_signed_output_fails_verification(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        sign_pdf(file=src, output=out, pfx_path=pfx, password="pw")
        with open(out, "rb") as f:
            data = bytearray(f.read())
        data[100] ^= 0xFF  # flip a byte inside the signed byte range
        with open(out, "wb") as f:
            f.write(bytes(data))
        assert verify_signatures(out)["summary"]["all_valid"] is False

    def test_wrong_password_raises_and_writes_no_output(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "correct")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="wrong")
        # Fail closed — no partial/omit-the-signature output.
        assert not os.path.exists(out)

    def test_in_place_output_is_rejected(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        with pytest.raises(ValueError):
            sign_pdf(file=src, output=src, pfx_path=pfx, password="pw")

    def test_result_never_contains_the_password(self, tmp_dir):
        token = "unique-secret-9f3a2b"
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), token)
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, pfx_path=pfx, password=token)
        assert token not in str(r)  # password appears nowhere in the report

    def test_reason_and_location_accepted(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw",
            reason="I approve this document", location="Cleveland, OH",
        )
        assert r["valid"] is True

    # ── 2k: PEM signer source ────────────────────────────────────────────

    def test_pem_signer_roundtrip(self, tmp_dir):
        key_path, cert_path = _make_test_pem(tmp_dir)
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, key_path=key_path, cert_path=cert_path, password="")
        assert r["valid"] is True and r["intact"] is True
        assert r["signer"] == "Spectra PEM Signer"
        v = verify_signatures(out)
        assert v["summary"]["all_valid"] is True

    def test_pem_encrypted_key_roundtrip_and_wrong_passphrase(self, tmp_dir):
        key_path, cert_path = _make_test_pem(tmp_dir, key_password="s3cret")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, key_path=key_path, cert_path=cert_path, password="s3cret")
        assert r["valid"] is True

        # Wrong passphrase: generic error (no secret echoed), no output file.
        out2 = os.path.join(tmp_dir, "out2.pdf")
        with pytest.raises(ValueError) as exc:
            sign_pdf(file=src, output=out2, key_path=key_path, cert_path=cert_path, password="WRONG")
        assert "WRONG" not in str(exc.value)
        assert not os.path.exists(out2)

    def test_pem_fullchain_embeds_intermediate(self, tmp_dir):
        key_path, cert_path = _make_test_pem(tmp_dir, with_chain=True)
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, key_path=key_path, cert_path=cert_path, password="")
        assert r["valid"] is True
        # Independent check: the CMS SignedData carries the intermediate too.
        from pyhanko.pdf_utils.reader import PdfFileReader

        with open(out, "rb") as f:
            emb = list(PdfFileReader(f).embedded_signatures)[0]
            certs = emb.signed_data["certificates"]
            assert len(certs) >= 2

    def test_pem_reversed_chain_still_signs_as_the_key_holder(self, tmp_dir):
        # 2k review (HIGH): the signer certificate is selected by MATCHING THE
        # KEY, never positionally. A root-first bundle (the other common
        # chain-file convention) used to claim the CA as the signer and write
        # a cryptographically INVALID signature with exit 0.
        key_path, cert_path = _make_test_pem(tmp_dir, with_chain=True)
        # Reverse the bundle: intermediate first, leaf second.
        with open(cert_path, "rb") as f:
            pem = f.read()
        blocks = pem.split(b"-----END CERTIFICATE-----")
        blocks = [b + b"-----END CERTIFICATE-----" for b in blocks if b.strip()]
        assert len(blocks) == 2
        reversed_path = os.path.join(tmp_dir, "reversed.crt.pem")
        with open(reversed_path, "wb") as f:
            f.write(blocks[1] + b"\n" + blocks[0])

        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, key_path=key_path, cert_path=reversed_path, password="")
        assert r["signer"] == "Spectra PEM Signer"  # the leaf, not the CA
        assert r["valid"] is True and r["intact"] is True

    def test_pem_cert_not_matching_key_fails_closed(self, tmp_dir):
        # A cert file with NO certificate matching the key must refuse and
        # write nothing — never sign with a mismatched identity.
        key_path, _ = _make_test_pem(tmp_dir)
        other_dir = os.path.join(tmp_dir, "other")
        os.makedirs(other_dir)
        _, other_cert = _make_test_pem(other_dir)  # different keypair's cert
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="Could not load the signer"):
            sign_pdf(file=src, output=out, key_path=key_path, cert_path=other_cert, password="")
        assert not os.path.exists(out)

    def test_signer_source_validation(self, tmp_dir):
        key_path, cert_path = _make_test_pem(tmp_dir)
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="ONE signer source"):
            sign_pdf(file=src, output=out, pfx_path=pfx, key_path=key_path, cert_path=cert_path, password="pw")
        with pytest.raises(ValueError, match="both the key file and the certificate"):
            sign_pdf(file=src, output=out, key_path=key_path, password="")
        with pytest.raises(ValueError, match="No signer"):
            sign_pdf(file=src, output=out, password="")
        assert not os.path.exists(out)

    # ── 2k: visible appearance ───────────────────────────────────────────

    def test_visible_appearance_lands_on_requested_page_and_rect(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = os.path.join(tmp_dir, "in.pdf")
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(300, 300))
        doc.add_blank_page(page_size=(300, 300))
        doc.save(src)
        doc.close()
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw",
            reason="Approved", appearance={"page": 2, "rect": [40, 40, 220, 110]},
        )
        assert r["valid"] is True and r["intact"] is True and r["covers_whole_document"] is True
        # Independent pikepdf check: the widget annotation sits on PAGE 2 at
        # the requested rect with a generated appearance stream; page 1 clean.
        with pikepdf.open(out) as pdf:
            assert pdf.pages[0].get("/Annots") is None
            annots = pdf.pages[1].get("/Annots")
            assert annots is not None and len(annots) == 1
            widget = annots[0]
            assert widget.Subtype == Name.Widget
            assert [round(float(v)) for v in widget.Rect] == [40, 40, 220, 110]
            assert "/N" in widget.AP
            assert widget.AP.N.read_bytes()  # non-empty appearance stream

    def test_visible_appearance_validation(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="out of range"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw",
                     appearance={"page": 99, "rect": [10, 10, 100, 60]})
        with pytest.raises(ValueError, match="empty"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw",
                     appearance={"page": 1, "rect": [10, 10, 10, 60]})
        with pytest.raises(ValueError, match="appearance"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw",
                     appearance={"page": 1})
        # Non-integral page rejects instead of silently truncating (1.7 → 1).
        with pytest.raises(ValueError, match="appearance"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw",
                     appearance={"page": 1.7, "rect": [10, 10, 100, 60]})
        assert not os.path.exists(out)

    def test_percent_in_reason_does_not_break_visible_stamp(self, tmp_dir):
        # pyHanko stamp text is %-interpolated; a literal % in user text must
        # be escaped, not crash (or worse, interpolate).
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(
            file=src, output=out, pfx_path=pfx, password="pw",
            reason="100% reviewed", location="50% off %(signer)s",
            appearance={"page": 1, "rect": [20, 20, 260, 90]},
        )
        assert r["valid"] is True


def _pdf_with_sig_field(path: str, name: str = "sigf", rect=(100, 100, 300, 160), filled: bool = False, as_text: bool = False) -> str:
    """A one-page PDF carrying one form field named ``name``: an empty (or
    pre-'signed') signature field, or — with ``as_text`` — a TEXT field of
    the same name (for the wrong-type refusal case)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    ft = pikepdf.Name.Tx if as_text else pikepdf.Name.Sig
    w = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Widget,
            FT=ft,
            Rect=list(rect),
            F=4,
            P=page.obj,
        )
    )
    w["/T"] = pikepdf.String(name)
    if filled:
        w["/V"] = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Sig))
    page.obj["/Annots"] = pikepdf.Array([w])
    acro = pikepdf.Dictionary(Fields=pikepdf.Array([w]))
    if not as_text:
        acro["/SigFlags"] = 1
    pdf.Root["/AcroForm"] = pdf.make_indirect(acro)
    pdf.save(path)
    pdf.close()
    return path


class TestSignExistingField:
    """2n.4d — filling an existing empty signature field by name. The field's
    own widget /Rect provides the visible appearance; a zero-size widget
    signs invisibly; anything else refuses before signing work starts."""

    def test_fills_the_named_empty_field_with_a_visible_stamp(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _pdf_with_sig_field(os.path.join(tmp_dir, "in.pdf"), name="approval")
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, pfx_path=pfx, password="pw", existing_field="approval")
        assert r["valid"] is True and r["intact"] is True
        assert r["field"] == "approval"
        assert r["covers_whole_document"] is True
        v = verify_signatures(out)
        assert v["signature_count"] == 1
        assert v["signatures"][0]["field"] == "approval"
        # The signature landed IN the existing field (no second field
        # appended), its widget kept its rect, and a visible appearance
        # stream was generated into it.
        with pikepdf.open(out) as pdf:
            sig_fields = [
                f for f in pdf.Root["/AcroForm"]["/Fields"] if f.get("/FT") == pikepdf.Name.Sig
            ]
            assert len(sig_fields) == 1
            field = sig_fields[0]
            assert str(field["/T"]) == "approval"
            assert field.get("/V") is not None
            assert [round(float(x)) for x in field["/Rect"]] == [100, 100, 300, 160]
            ap = field.get("/AP")
            assert ap is not None and ap.get("/N") is not None
            assert len(ap["/N"].read_bytes()) > 0  # a real stamp, not a stub

    def test_zero_size_field_signs_invisibly(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _pdf_with_sig_field(os.path.join(tmp_dir, "in.pdf"), rect=(0, 0, 0, 0))
        out = os.path.join(tmp_dir, "out.pdf")
        r = sign_pdf(file=src, output=out, pfx_path=pfx, password="pw", existing_field="sigf")
        assert r["valid"] is True and r["intact"] is True
        assert verify_signatures(out)["summary"]["all_valid"] is True

    def test_missing_field_refuses_and_writes_nothing(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _pdf_with_sig_field(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="No empty signature field"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw", existing_field="nope")
        assert not os.path.exists(out)

    def test_already_signed_field_refuses(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _pdf_with_sig_field(os.path.join(tmp_dir, "in.pdf"), filled=True)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="already signed"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw", existing_field="sigf")
        assert not os.path.exists(out)

    def test_non_signature_field_of_that_name_refuses(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _pdf_with_sig_field(os.path.join(tmp_dir, "in.pdf"), as_text=True)
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="No empty signature field"):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="pw", existing_field="sigf")
        assert not os.path.exists(out)

    def test_existing_field_conflicts_with_appearance(self, tmp_dir):
        pfx = _make_test_pfx(os.path.join(tmp_dir, "signer.pfx"), "pw")
        src = _pdf_with_sig_field(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError, match="ONE placement"):
            sign_pdf(
                file=src, output=out, pfx_path=pfx, password="pw",
                existing_field="sigf", appearance={"page": 1, "rect": [10, 10, 60, 40]},
            )
        assert not os.path.exists(out)


class TestGenerateSigner:
    def test_generate_then_sign_then_verify(self, tmp_dir):
        from engine.signatures import generate_signer

        pfx = os.path.join(tmp_dir, "me.pfx")
        token = "GEN-Xq7-UNIQUE"
        r = generate_signer("Jason Test Identity", pfx, token, org="Spectra QA")
        assert r["output"] == pfx and os.path.exists(pfx)
        assert r["common_name"] == "Jason Test Identity"
        assert r["fingerprint_sha256"] and len(r["fingerprint_sha256"]) == 64
        # The password never appears anywhere in the result.
        assert token not in str(r)

        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        s = sign_pdf(file=src, output=out, pfx_path=pfx, password=token)
        assert s["valid"] is True and s["signer"] == "Jason Test Identity"
        # Verification of a self-signed identity still reports untrusted.
        v = verify_signatures(out)
        assert v["summary"]["trust_verified"] is False

    def test_refuses_overwrite_without_flag(self, tmp_dir):
        from engine.signatures import generate_signer

        pfx = os.path.join(tmp_dir, "me.pfx")
        generate_signer("A", pfx, "pw1")
        with pytest.raises(ValueError, match="already exists"):
            generate_signer("B", pfx, "pw2")
        # Explicit overwrite replaces it (new CN provable via signing name).
        r = generate_signer("B", pfx, "pw2", overwrite=True)
        assert r["common_name"] == "B"

    def test_generation_input_validation(self, tmp_dir):
        from engine.signatures import generate_signer

        pfx = os.path.join(tmp_dir, "me.pfx")
        with pytest.raises(ValueError, match="common name"):
            generate_signer("   ", pfx, "pw")
        with pytest.raises(ValueError, match="password"):
            generate_signer("Name", pfx, "")
        with pytest.raises(ValueError, match="Validity"):
            generate_signer("Name", pfx, "pw", valid_days=0)
        assert not os.path.exists(pfx)

    def test_wrong_password_on_generated_pfx_fails_closed(self, tmp_dir):
        from engine.signatures import generate_signer

        pfx = os.path.join(tmp_dir, "me.pfx")
        generate_signer("C", pfx, "rightpw")
        src = _blank_pdf(os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")
        with pytest.raises(ValueError):
            sign_pdf(file=src, output=out, pfx_path=pfx, password="wrongpw")
        assert not os.path.exists(out)


# ── PDF version ───────────────────────────────────────────────────────────


class TestPdfVersion:
    """`get_pdf_version` had NO test, and shipped returning "1.." for every
    file: `pdf_version` is a string like "1.7", and the code indexed it as if
    it were a (major, minor) tuple, so it took the first two characters —
    '1' + '.' + '.'. It was on screen in the Optimize pane's "Current version"
    the whole time. Nothing asserted the value, so nothing noticed."""

    def test_reads_the_real_version(self, sample_pdf):
        r = get_pdf_version(file=sample_pdf)
        assert r["version"] == pikepdf.open(sample_pdf).pdf_version
        # The shape a PDF version actually has — the old formula gave "1..".
        assert re.fullmatch(r"\d+\.\d+", r["version"]), r["version"]
        assert r["pages"] == 5

    def test_round_trips_through_set_pdf_version(self, sample_pdf, tmp_dir):
        out = os.path.join(tmp_dir, "v17.pdf")
        set_pdf_version(file=sample_pdf, output=out, version="1.7")
        assert get_pdf_version(file=out)["version"] == "1.7"
