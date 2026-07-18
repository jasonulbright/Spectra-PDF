"""Tests for page-image editing (Phase 7.1 — list/delete/replace/extract)."""

import os
import zlib

import pikepdf
from pikepdf import Dictionary, Name
import pytest

from engine.page_images import (
    delete_page_image,
    extract_page_image,
    list_page_images,
    replace_page_image,
)


def _rgb_image(pdf, r, g, b, w=4, h=4):
    """A tiny flate RGB image XObject."""
    stream = pdf.make_stream(zlib.compress(bytes([r, g, b]) * (w * h)))
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = w
    stream["/Height"] = h
    stream["/ColorSpace"] = Name("/DeviceRGB")
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name("/FlateDecode")
    return pdf.make_indirect(stream)


def _page_with_images(path):
    """One page, three draws: /ImA at (50,600,100x80), /ImA AGAIN at
    (300,600,100x80) (shared XObject, two placements), /ImB at
    (50,300,200x150)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    im_a = _rgb_image(pdf, 255, 0, 0)
    im_b = _rgb_image(pdf, 0, 0, 255)
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(ImA=im_a, ImB=im_b))
    page.Contents = pdf.make_stream(
        b"q 100 0 0 80 50 600 cm /ImA Do Q "
        b"q 100 0 0 80 300 600 cm /ImA Do Q "
        b"q 200 0 0 150 50 300 cm /ImB Do Q"
    )
    pdf.save(path)
    pdf.close()


def _page_with_form_image(path):
    """/ImF drawn INSIDE a Form XObject; the form is drawn TWICE on the page
    (so per-placement edits must copy the form, not mutate it)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    im_f = _rgb_image(pdf, 0, 255, 0)
    form = pdf.make_stream(b"q 100 0 0 100 0 0 cm /ImF Do Q")
    form["/Type"] = Name("/XObject")
    form["/Subtype"] = Name("/Form")
    form["/BBox"] = pikepdf.Array([0, 0, 100, 100])
    form["/Resources"] = Dictionary(XObject=Dictionary(ImF=im_f))
    form_i = pdf.make_indirect(form)
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Fm1=form_i))
    page.Contents = pdf.make_stream(
        b"q 1 0 0 1 50 500 cm /Fm1 Do Q q 1 0 0 1 300 200 cm /Fm1 Do Q"
    )
    pdf.save(path)
    pdf.close()


def _names_in_page_stream(path):
    with pikepdf.open(path) as pdf:
        return [
            str(i.operands[0])
            for i in pikepdf.parse_content_stream(pdf.pages[0])
            if str(i.operator) == "Do"
        ]


class TestListPageImages:
    def test_lists_in_draw_order_with_geometry(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        r = list_page_images(src, 1)
        assert [i["index"] for i in r["images"]] == [0, 1, 2]
        assert [i["name"] for i in r["images"]] == ["/ImA", "/ImA", "/ImB"]
        assert r["images"][0]["rect"] == [50, 600, 150, 680]
        assert r["images"][1]["rect"] == [300, 600, 400, 680]
        assert r["images"][2]["rect"] == [50, 300, 250, 450]
        assert all(not i["nested"] for i in r["images"])
        assert r["images"][0]["native_width"] == 4

    def test_form_nested_listed_with_composed_ctm(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        _page_with_form_image(src)
        r = list_page_images(src, 1)
        assert len(r["images"]) == 2
        assert all(i["nested"] for i in r["images"])
        assert r["images"][0]["rect"] == [50, 500, 150, 600]
        assert r["images"][1]["rect"] == [300, 200, 400, 300]

    def test_page_out_of_range_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        with pytest.raises(ValueError, match="out of range"):
            list_page_images(src, 9)


class TestDeletePageImage:
    def test_deletes_one_placement_of_a_shared_image(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _page_with_images(src)
        delete_page_image(src, out, 1, 0)  # first /ImA draw
        r = list_page_images(out, 1)
        assert [i["name"] for i in r["images"]] == ["/ImA", "/ImB"]
        assert r["images"][0]["rect"] == [300, 600, 400, 680]  # the OTHER draw
        # Shared XObject survives (still referenced by the second draw).
        with pikepdf.open(out) as pdf:
            assert Name("/ImA") in pdf.pages[0].obj["/Resources"]["/XObject"]

    def test_prunes_the_xobject_when_last_reference_goes(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        mid = os.path.join(tmp_dir, "mid.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _page_with_images(src)
        delete_page_image(src, mid, 1, 2)  # the only /ImB draw
        with pikepdf.open(mid) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            assert Name("/ImB") not in xo  # orphaned → pruned
            assert Name("/ImA") in xo
        # And deleting both /ImA placements prunes it too.
        delete_page_image(mid, out, 1, 0)
        delete_page_image(out, out, 1, 0)  # in-place second delete
        with pikepdf.open(out) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            assert Name("/ImA") not in xo
        assert list_page_images(out, 1)["images"] == []

    def test_form_nested_delete_copies_the_form(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _page_with_form_image(src)
        delete_page_image(src, out, 1, 0)  # image inside the FIRST form draw
        r = list_page_images(out, 1)
        # The second draw of the form still shows its image.
        assert len(r["images"]) == 1
        assert r["images"][0]["rect"] == [300, 200, 400, 300]
        # The page now draws one copy + the original form.
        names = _names_in_page_stream(out)
        assert len(names) == 2 and len(set(names)) == 2

    def test_index_out_of_range_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        with pytest.raises(ValueError, match="out of range"):
            delete_page_image(src, os.path.join(tmp_dir, "o.pdf"), 1, 3)


class TestReplacePageImage:
    def test_raw_replace_preserves_placement_and_other_draws(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        raw = os.path.join(tmp_dir, "px.raw")
        _page_with_images(src)
        with open(raw, "wb") as f:
            f.write(bytes([1, 2, 3]) * 4)  # 2x2 RGB
        replace_page_image(src, out, 1, 0, {"raw_path": raw, "width": 2, "height": 2, "channels": 3})
        r = list_page_images(out, 1)
        # Same geometry (CTM preserved), same order; first draw now a new name.
        assert r["images"][0]["rect"] == [50, 600, 150, 680]
        assert r["images"][0]["name"].startswith("/EditIm")
        assert r["images"][0]["native_width"] == 2
        assert r["images"][1]["name"] == "/ImA"  # sibling placement untouched
        with pikepdf.open(out) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            assert Name("/ImA") in xo  # original object kept (still drawn)

    def test_rgba_raw_gains_an_smask(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        raw = os.path.join(tmp_dir, "px.raw")
        _page_with_images(src)
        with open(raw, "wb") as f:
            f.write(bytes([10, 20, 30, 128]) * 4)  # 2x2 RGBA
        replace_page_image(src, out, 1, 2, {"raw_path": raw, "width": 2, "height": 2, "channels": 4})
        with pikepdf.open(out) as pdf:
            name = list_page_images(out, 1)["images"][2]["name"]
            xobj = pdf.pages[0].obj["/Resources"]["/XObject"][Name(name)]
            assert "/SMask" in xobj
            smask = xobj["/SMask"]
            assert int(smask["/Width"]) == 2 and int(smask["/Height"]) == 2
            # Alpha plane round-trips.
            assert smask.read_bytes() == bytes([128] * 4)
            assert xobj.read_bytes() == bytes([10, 20, 30]) * 4

    def test_jpeg_passthrough_byte_identical_stream(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        jpg = os.path.join(tmp_dir, "in.jpg")
        _page_with_images(src)
        jpeg_bytes = _tiny_jpeg()
        with open(jpg, "wb") as f:
            f.write(jpeg_bytes)
        replace_page_image(src, out, 1, 1, {"jpeg_path": jpg})
        with pikepdf.open(out) as pdf:
            name = list_page_images(out, 1)["images"][1]["name"]
            xobj = pdf.pages[0].obj["/Resources"]["/XObject"][Name(name)]
            assert str(xobj["/Filter"]) == "/DCTDecode"
            # Zero re-encode: the embedded stream IS the input file.
            assert xobj.read_raw_bytes() == jpeg_bytes

    def test_form_nested_replace_touches_one_draw(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        raw = os.path.join(tmp_dir, "px.raw")
        _page_with_form_image(src)
        with open(raw, "wb") as f:
            f.write(bytes([9, 9, 9]) * 4)
        replace_page_image(src, out, 1, 1, {"raw_path": raw, "width": 2, "height": 2, "channels": 3})
        r = list_page_images(out, 1)
        assert len(r["images"]) == 2
        assert r["images"][0]["name"] == "/ImF"  # first draw untouched
        assert r["images"][1]["name"].startswith("/EditIm")
        assert r["images"][1]["rect"] == [300, 200, 400, 300]  # geometry kept

    def test_bad_raw_fails_closed_before_touching_output(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        raw = os.path.join(tmp_dir, "px.raw")
        _page_with_images(src)
        with open(raw, "wb") as f:
            f.write(b"\x00\x00")  # wrong length
        with pytest.raises(ValueError, match="expected"):
            replace_page_image(src, out, 1, 0, {"raw_path": raw, "width": 2, "height": 2, "channels": 3})
        assert not os.path.exists(out)


class TestExtractPageImage:
    def test_extracts_bytes(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        r = extract_page_image(src, 1, 2, os.path.join(tmp_dir, "picked"))
        assert os.path.exists(r["output"])
        assert r["name"] == "/ImB"
        assert r["width"] == 4 and r["height"] == 4
        assert os.path.getsize(r["output"]) > 0


def _tiny_jpeg() -> bytes:
    """A minimal valid 1x1 grayscale baseline JPEG (hand-assembled)."""
    return bytes.fromhex(
        "ffd8"  # SOI
        "ffdb004300"  # DQT
        + "10" * 64
        + "ffc0000b08000100010101001100"  # SOF0: 1x1, 1 component
        "ffc4001f0000010501010101010100000000000000000102030405060708090a0b"  # DHT (DC)
        "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa"  # DHT (AC)
        "ffda0008010100003f00"  # SOS
        "7f"  # entropy data
        "ffd9"  # EOI
    )


def _page_with_single_form_image(path):
    """The form (with its OWN /Resources holding /ImF) drawn exactly ONCE —
    the prune-completeness case: deleting its lone image must leave NO image
    bytes in the file (review-caught: the superseded form kept them)."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    im_f = _rgb_image(pdf, 7, 7, 7)
    form = pdf.make_stream(b"q 100 0 0 100 0 0 cm /ImF Do Q")
    form["/Type"] = Name("/XObject")
    form["/Subtype"] = Name("/Form")
    form["/BBox"] = pikepdf.Array([0, 0, 100, 100])
    form["/Resources"] = Dictionary(XObject=Dictionary(ImF=im_f))
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(Fm1=pdf.make_indirect(form)))
    page.Contents = pdf.make_stream(b"q 1 0 0 1 50 500 cm /Fm1 Do Q")
    pdf.save(path)
    pdf.close()


def _count_images_everywhere(path) -> int:
    with pikepdf.open(path) as pdf:
        return sum(
            1
            for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream) and str(obj.get("/Subtype", "")) == "/Image"
        )


class TestReachabilityCleanup:
    def test_single_placement_nested_delete_leaves_no_image_bytes(self, tmp_dir):
        src = os.path.join(tmp_dir, "one-form.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _page_with_single_form_image(src)
        assert _count_images_everywhere(src) == 1
        delete_page_image(src, out, 1, 0)
        assert list_page_images(out, 1)["images"] == []
        assert _count_images_everywhere(out) == 0  # genuinely absent, not undrawn

    def test_replace_prunes_the_superseded_original(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        raw = os.path.join(tmp_dir, "px.raw")
        _page_with_images(src)  # ImA drawn twice, ImB once => 2 image objects
        with open(raw, "wb") as f:
            f.write(bytes([1, 2, 3]) * 4)
        # Replace the ONLY ImB draw: original ImB must vanish from the file.
        replace_page_image(src, out, 1, 2, {"raw_path": raw, "width": 2, "height": 2, "channels": 3})
        with pikepdf.open(out) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            assert Name("/ImB") not in xo
            assert Name("/ImA") in xo
        assert _count_images_everywhere(out) == 2  # ImA + the replacement

    def test_replace_keeps_a_still_shared_original(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        raw = os.path.join(tmp_dir, "px.raw")
        _page_with_images(src)
        with open(raw, "wb") as f:
            f.write(bytes([1, 2, 3]) * 4)
        # Replace the FIRST ImA draw: the second still needs the original.
        replace_page_image(src, out, 1, 0, {"raw_path": raw, "width": 2, "height": 2, "channels": 3})
        with pikepdf.open(out) as pdf:
            assert Name("/ImA") in pdf.pages[0].obj["/Resources"]["/XObject"]
        assert _count_images_everywhere(out) == 3  # ImA, ImB, replacement


class TestWalkerAgreement:
    def _mixed_page(self, path):
        """[top image, form(image, inner-form(image)), top image] — the
        DFS-order-agreement shape; pinned so a future walker change that
        skews lister/rewriter order goes red."""
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        im1 = _rgb_image(pdf, 10, 0, 0)
        im2 = _rgb_image(pdf, 0, 20, 0)
        im3 = _rgb_image(pdf, 0, 0, 30)
        im4 = _rgb_image(pdf, 40, 40, 40)
        inner = pdf.make_stream(b"q 10 0 0 10 0 0 cm /Im3 Do Q")
        inner["/Type"] = Name("/XObject")
        inner["/Subtype"] = Name("/Form")
        inner["/BBox"] = pikepdf.Array([0, 0, 10, 10])
        inner["/Resources"] = Dictionary(XObject=Dictionary(Im3=im3))
        outer = pdf.make_stream(b"q 10 0 0 10 0 0 cm /Im2 Do Q q 1 0 0 1 20 0 cm /Fi Do Q")
        outer["/Type"] = Name("/XObject")
        outer["/Subtype"] = Name("/Form")
        outer["/BBox"] = pikepdf.Array([0, 0, 40, 10])
        outer["/Resources"] = Dictionary(
            XObject=Dictionary(Im2=im2, Fi=pdf.make_indirect(inner))
        )
        page.obj["/Resources"] = Dictionary(
            XObject=Dictionary(Im1=im1, Fo=pdf.make_indirect(outer), Im4=im4)
        )
        page.Contents = pdf.make_stream(
            b"q 50 0 0 50 0 700 cm /Im1 Do Q "
            b"q 1 0 0 1 100 400 cm /Fo Do Q "
            b"q 50 0 0 50 500 100 cm /Im4 Do Q"
        )
        pdf.save(path)
        pdf.close()

    def test_lister_and_rewriter_agree_on_mixed_nesting(self, tmp_dir):
        src = os.path.join(tmp_dir, "mixed.pdf")
        self._mixed_page(src)
        r = list_page_images(src, 1)
        assert [i["name"] for i in r["images"]] == ["/Im1", "/Im2", "/Im3", "/Im4"]
        assert [i["nested"] for i in r["images"]] == [False, True, True, False]
        # Delete index 2 (the DOUBLY-nested /Im3): exactly it disappears.
        out = os.path.join(tmp_dir, "out.pdf")
        delete_page_image(src, out, 1, 2)
        after = list_page_images(out, 1)
        assert [i["name"] for i in after["images"]] == ["/Im1", "/Im2", "/Im4"]
        assert _count_images_everywhere(out) == 3  # Im3's bytes pruned too

    def test_extract_agrees_with_the_lister_on_nesting(self, tmp_dir):
        src = os.path.join(tmp_dir, "mixed.pdf")
        self._mixed_page(src)
        r = extract_page_image(src, 1, 1, os.path.join(tmp_dir, "nested"))
        assert r["name"] == "/Im2"
        assert os.path.exists(r["output"])

    def test_depth_cap_agreement(self, tmp_dir):
        """A chain deeper than MAX_FORM_DEPTH: the lister and the mutators
        must bottom out IDENTICALLY (a divergence would edit the wrong
        image — the module's stated worst case)."""
        from engine.redact import MAX_FORM_DEPTH

        src = os.path.join(tmp_dir, "deep.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        depth_total = MAX_FORM_DEPTH + 3
        # Innermost first: each level draws one image then the next form.
        prev_form = None
        for level in range(depth_total - 1, -1, -1):
            im = _rgb_image(pdf, level % 256, 0, 0)
            xo = Dictionary(Im=im)
            content = b"q 10 0 0 10 0 0 cm /Im Do Q"
            if prev_form is not None:
                xo["/Fn"] = prev_form
                content += b" q 1 0 0 1 12 0 cm /Fn Do Q"
            form = pdf.make_stream(content)
            form["/Type"] = Name("/XObject")
            form["/Subtype"] = Name("/Form")
            form["/BBox"] = pikepdf.Array([0, 0, 1000, 10])
            form["/Resources"] = Dictionary(XObject=xo)
            prev_form = pdf.make_indirect(form)
        page.obj["/Resources"] = Dictionary(XObject=Dictionary(F0=prev_form))
        page.Contents = pdf.make_stream(b"q 1 0 0 1 10 700 cm /F0 Do Q")
        pdf.save(src)
        pdf.close()

        listed = list_page_images(src, 1)["images"]
        # The page walks at depth 0 and a form recurses iff depth <
        # MAX_FORM_DEPTH, so images live at depths 1..MAX_FORM_DEPTH —
        # exactly MAX_FORM_DEPTH visible.
        assert len(listed) == MAX_FORM_DEPTH
        # Deleting the LAST visible one must remove exactly one image.
        out = os.path.join(tmp_dir, "out.pdf")
        delete_page_image(src, out, 1, len(listed) - 1)
        assert len(list_page_images(out, 1)["images"]) == len(listed) - 1


class TestJpegInfoRobustness:
    def test_fill_bytes_before_markers_parse(self, tmp_dir):
        # Spec-legal 0xFF padding between segments (T.81 B.1.1.2).
        from engine.page_images import _jpeg_info

        base = _tiny_jpeg()
        padded = base[:2] + b"\xff" + base[2:]  # fill byte right after SOI
        w, h, c = _jpeg_info(padded)
        assert (w, h, c) == (1, 1, 1)

    def test_truncated_sof_raises_valueerror_not_struct_error(self, tmp_dir):
        from engine.page_images import _jpeg_info

        truncated = b"\xff\xd8\xff\xc0\x00\x0b\x08"
        with pytest.raises(ValueError):
            _jpeg_info(truncated)


class TestInlineImages:
    def test_inline_image_round_trips_through_a_rewrite(self, tmp_dir):
        """BI/ID/EI blocks are never listed and must survive a rewrite
        byte-safe (they pass through unparse untouched)."""
        src = os.path.join(tmp_dir, "inline.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        im = _rgb_image(pdf, 200, 0, 0)
        page.obj["/Resources"] = Dictionary(XObject=Dictionary(ImA=im))
        page.Contents = pdf.make_stream(
            b"q 20 0 0 20 30 700 cm BI /W 1 /H 1 /CS /G /BPC 8 ID \x7f EI Q "
            b"q 100 0 0 80 50 600 cm /ImA Do Q"
        )
        pdf.save(src)
        pdf.close()

        r = list_page_images(src, 1)
        assert len(r["images"]) == 1  # the XObject only, never the inline
        delete_page_image(src, out, 1, 0)
        assert list_page_images(out, 1)["images"] == []
        with pikepdf.open(out) as pdf2:
            content = pikepdf.unparse_content_stream(
                pikepdf.parse_content_stream(pdf2.pages[0])
            )
            assert b"BI" in content and b"EI" in content  # inline survived
