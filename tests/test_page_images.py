"""Tests for page-image editing (Phase 7.1 — list/delete/replace/extract)."""

import os
import zlib

import pikepdf
from pikepdf import Dictionary, Name
import pytest

from engine.page_images import (
    add_page_image,
    delete_page_image,
    extract_page_image,
    list_page_images,
    replace_page_image,
    transform_page_image,
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


def _matrix_of(path, index):
    return list_page_images(path, 1)["images"][index]["matrix"]


def _page_with_degenerate_image(path):
    """One draw whose CTM collapses the image to zero area — malformed, but
    the transform op must fail closed rather than divide by a zero det."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    im = _rgb_image(pdf, 255, 0, 0)
    page.obj["/Resources"] = Dictionary(XObject=Dictionary(ImA=im))
    page.Contents = pdf.make_stream(b"q 0 0 0 0 50 600 cm /ImA Do Q")
    pdf.save(path)
    pdf.close()


class TestTransformPageImage:
    def test_lists_the_placement_matrix(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        # The CTM from the fixture's `100 0 0 80 50 600 cm`.
        assert _matrix_of(src, 0) == pytest.approx([100, 0, 0, 80, 50, 600])
        assert _matrix_of(src, 2) == pytest.approx([200, 0, 0, 150, 50, 300])

    def test_move_translates_only_the_target(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        # ImA placement 0 → shifted +100 x, +50 y (same size).
        transform_page_image(src, out, 1, 0, [100, 0, 0, 80, 150, 650])
        imgs = list_page_images(out, 1)["images"]
        assert imgs[0]["matrix"] == pytest.approx([100, 0, 0, 80, 150, 650])
        assert imgs[0]["rect"] == pytest.approx([150, 650, 250, 730])
        # The OTHER ImA placement (shared XObject) is untouched.
        assert imgs[1]["matrix"] == pytest.approx([100, 0, 0, 80, 300, 600])
        assert imgs[2]["matrix"] == pytest.approx([200, 0, 0, 150, 50, 300])

    def test_resize_scales_the_placement(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        transform_page_image(src, out, 1, 2, [400, 0, 0, 300, 50, 300])  # ImB, doubled
        imgs = list_page_images(out, 1)["images"]
        assert imgs[2]["matrix"] == pytest.approx([400, 0, 0, 300, 50, 300])
        assert imgs[2]["rect"] == pytest.approx([50, 300, 450, 600])

    def test_rotate_reorients_the_placement(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        # A rotation/scale with non-zero off-diagonals (b, c). Unit square →
        # corners (150,600),(150,700),(70,600),(70,700): bbox [70,600,150,700].
        target = [0, 100, -80, 0, 150, 600]
        transform_page_image(src, out, 1, 0, target)
        imgs = list_page_images(out, 1)["images"]
        assert imgs[0]["matrix"] == pytest.approx(target)
        assert imgs[0]["rect"] == pytest.approx([70, 600, 150, 700])

    def test_form_nested_transform_copies_the_form(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        _page_with_form_image(src)
        out = os.path.join(tmp_dir, "o.pdf")
        # Nested placement 0 (inside Fm1, drawn twice) → moved. Only that one.
        transform_page_image(src, out, 1, 0, [100, 0, 0, 100, 200, 500])
        imgs = list_page_images(out, 1)["images"]
        assert imgs[0]["matrix"] == pytest.approx([100, 0, 0, 100, 200, 500])
        assert imgs[1]["matrix"] == pytest.approx([100, 0, 0, 100, 300, 200])
        # The form was COPIED, not mutated: the page draws two DIFFERENT form
        # names now (the edited copy + the original).
        names = [n for n in _names_in_page_stream(out)]
        assert len(set(names)) == 2

    def test_degenerate_current_matrix_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "deg.pdf")
        _page_with_degenerate_image(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="degenerate"):
            transform_page_image(src, out, 1, 0, [100, 0, 0, 80, 50, 600])

    def test_index_out_of_range_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="out of range"):
            transform_page_image(src, out, 1, 9, [1, 0, 0, 1, 0, 0])

    def test_bad_matrix_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="matrix"):
            transform_page_image(src, out, 1, 0, [1, 0, 0, 1])


def _blank_page_pdf(path, size=(612, 792)):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=size)
    pdf.save(path)
    pdf.close()


def _raw_source(tmp_dir):
    path = os.path.join(tmp_dir, "add.raw")
    with open(path, "wb") as f:
        f.write(bytes([200, 60, 60]) * 4)  # 2x2 RGB
    return {"raw_path": path, "width": 2, "height": 2, "channels": 3}


class TestAddPageImage:
    def test_adds_an_image_at_the_box(self, tmp_dir):
        src = os.path.join(tmp_dir, "blank.pdf")
        _blank_page_pdf(src)  # a blank page has no image resources yet
        out = os.path.join(tmp_dir, "o.pdf")
        add_page_image(src, out, 1, [100, 500, 300, 650], _raw_source(tmp_dir))
        imgs = list_page_images(out, 1)["images"]
        assert len(imgs) == 1
        assert imgs[0]["rect"] == pytest.approx([100, 500, 300, 650])
        # cm = [w, 0, 0, h, x0, y0] maps the unit image square onto the box.
        assert imgs[0]["matrix"] == pytest.approx([200, 0, 0, 150, 100, 500])
        assert imgs[0]["native_width"] == 2

    def test_added_image_is_an_ordinary_placement(self, tmp_dir):
        # Add, then TRANSFORM it (C1) — proves the added image is a normal
        # placement the rest of the pipeline sees with no special case.
        src = os.path.join(tmp_dir, "blank.pdf")
        _blank_page_pdf(src)
        mid = os.path.join(tmp_dir, "mid.pdf")
        add_page_image(src, mid, 1, [100, 500, 200, 600], _raw_source(tmp_dir))
        out = os.path.join(tmp_dir, "o.pdf")
        transform_page_image(mid, out, 1, 0, [120, 0, 0, 120, 300, 300])
        imgs = list_page_images(out, 1)["images"]
        assert imgs[0]["matrix"] == pytest.approx([120, 0, 0, 120, 300, 300])

    def test_does_not_disturb_existing_images(self, tmp_dir):
        src = os.path.join(tmp_dir, "imgs.pdf")
        _page_with_images(src)  # three existing placements
        out = os.path.join(tmp_dir, "o.pdf")
        add_page_image(src, out, 1, [420, 400, 520, 500], _raw_source(tmp_dir))
        imgs = list_page_images(out, 1)["images"]
        assert len(imgs) == 4
        # Appended AFTER the existing draws (last in DFS order).
        assert imgs[3]["rect"] == pytest.approx([420, 400, 520, 500])
        # The originals are untouched.
        assert imgs[0]["rect"] == [50, 600, 150, 680]

    def test_jpeg_source(self, tmp_dir):
        src = os.path.join(tmp_dir, "blank.pdf")
        _blank_page_pdf(src)
        jpath = os.path.join(tmp_dir, "t.jpg")
        with open(jpath, "wb") as f:
            f.write(_tiny_jpeg())
        out = os.path.join(tmp_dir, "o.pdf")
        add_page_image(src, out, 1, [100, 500, 200, 600], {"jpeg_path": jpath})
        assert len(list_page_images(out, 1)["images"]) == 1

    def test_degenerate_box_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "blank.pdf")
        _blank_page_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="too small"):
            add_page_image(src, out, 1, [100, 500, 100, 500], _raw_source(tmp_dir))

    def test_bad_rect_refuses(self, tmp_dir):
        src = os.path.join(tmp_dir, "blank.pdf")
        _blank_page_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="rect"):
            add_page_image(src, out, 1, [1, 2, 3], _raw_source(tmp_dir))

    def test_does_not_leak_into_a_sibling_sharing_resources(self, tmp_dir):
        # Two pages share ONE /Resources object (a generator that hoisted a
        # single /Resources — the shape qpdf flattens onto each page BY
        # REFERENCE). Adding an image to page 1 must NOT leak the entry into
        # page 2's /XObject (review-caught: registering on the shared dict).
        src = os.path.join(tmp_dir, "shared.pdf")
        pdf = pikepdf.new()
        im = _rgb_image(pdf, 10, 20, 30)
        shared_res = pdf.make_indirect(Dictionary(XObject=Dictionary(Im0=im)))
        p1 = pdf.add_blank_page(page_size=(400, 400))
        p2 = pdf.add_blank_page(page_size=(400, 400))
        p1.obj["/Resources"] = shared_res
        p2.obj["/Resources"] = shared_res
        p1.Contents = pdf.make_stream(b"q 50 0 0 50 10 10 cm /Im0 Do Q")
        p2.Contents = pdf.make_stream(b"q 50 0 0 50 10 10 cm /Im0 Do Q")
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        add_page_image(src, out, 1, [100, 100, 200, 200], _raw_source(tmp_dir))
        with pikepdf.open(out) as opdf:
            p1_names = {str(k) for k in opdf.pages[0].obj["/Resources"]["/XObject"].keys()}
            p2_names = {str(k) for k in opdf.pages[1].obj["/Resources"]["/XObject"].keys()}
        assert any(n.startswith("/EditIm") for n in p1_names)  # page 1 got it
        assert not any(n.startswith("/EditIm") for n in p2_names)  # page 2 did NOT
        assert "/Im0" in p1_names and "/Im0" in p2_names  # both keep the original

    def test_replace_does_not_leak_into_a_sibling_sharing_resources(self, tmp_dir):
        # The same page-local-/Resources guard, for replace: replacing page 1's
        # image must NOT register the new /EditImN into page 2's shared /XObject.
        src = os.path.join(tmp_dir, "shared.pdf")
        pdf = pikepdf.new()
        im = _rgb_image(pdf, 10, 20, 30)
        shared_res = pdf.make_indirect(Dictionary(XObject=Dictionary(Im0=im)))
        p1 = pdf.add_blank_page(page_size=(400, 400))
        p2 = pdf.add_blank_page(page_size=(400, 400))
        p1.obj["/Resources"] = shared_res
        p2.obj["/Resources"] = shared_res
        p1.Contents = pdf.make_stream(b"q 50 0 0 50 10 10 cm /Im0 Do Q")
        p2.Contents = pdf.make_stream(b"q 50 0 0 50 10 10 cm /Im0 Do Q")
        pdf.save(src)
        pdf.close()
        raw = os.path.join(tmp_dir, "px.raw")
        with open(raw, "wb") as f:
            f.write(bytes([9, 9, 9]) * 4)  # 2x2 RGB
        out = os.path.join(tmp_dir, "o.pdf")
        replace_page_image(
            src, out, 1, 0, {"raw_path": raw, "width": 2, "height": 2, "channels": 3}
        )
        with pikepdf.open(out) as opdf:
            p2_names = {str(k) for k in opdf.pages[1].obj["/Resources"]["/XObject"].keys()}
        assert not any(n.startswith("/EditIm") for n in p2_names)  # no leak
        assert "/Im0" in p2_names  # page 2's image intact


def _ops_in_page_stream(path):
    with pikepdf.open(path) as pdf:
        return [
            (str(i.operator), [str(o) for o in i.operands])
            for i in pikepdf.parse_content_stream(pdf.pages[0])
        ]


class TestCropPageImage:
    """Phase 9.C3 — crop = a unit-space clip at the target draw."""

    def test_crop_wraps_the_target_draw(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import crop_page_image

        crop_page_image(src, out, 1, 0, [0.25, 0.25, 0.75, 0.75])
        ops = _ops_in_page_stream(out)
        # The clip lands directly before the FIRST /ImA Do, inside q/Q.
        i_re = next(i for i, (op, _) in enumerate(ops) if op == "re" and _[0].startswith("0.25"))
        assert ops[i_re + 1][0] == "W"
        assert ops[i_re + 2][0] == "n"
        assert ops[i_re + 3] == ("Do", ["/ImA"])
        # All three draws survive; the placements' matrices are unchanged
        # (crop clips — it never moves anything).
        before = list_page_images(src, 1)["images"]
        after = list_page_images(out, 1)["images"]
        assert len(after) == 3
        for b, a in zip(before, after):
            assert a["matrix"] == pytest.approx(b["matrix"], abs=1e-6)

    def test_crop_then_transform_compose(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_images(src)
        cropped = os.path.join(tmp_dir, "c.pdf")
        moved = os.path.join(tmp_dir, "m.pdf")
        from engine.page_images import crop_page_image

        crop_page_image(src, cropped, 1, 0, [0.0, 0.0, 0.5, 0.5])
        m = list_page_images(cropped, 1)["images"][0]["matrix"]
        target = list(m)
        target[4] += 40  # translate x
        transform_page_image(cropped, moved, 1, 0, target)
        after = list_page_images(moved, 1)["images"]
        assert after[0]["matrix"][4] == pytest.approx(m[4] + 40, abs=1e-4)
        # Both wraps present: the clip re and the delta cm.
        ops = _ops_in_page_stream(moved)
        assert any(op == "re" for op, _ in ops)
        assert any(op == "W" for op, _ in ops)

    def test_form_nested_crop_copies_the_form(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_form_image(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import crop_page_image

        crop_page_image(src, out, 1, 0, [0.1, 0.1, 0.9, 0.9])
        names = _names_in_page_stream(out)
        assert len(names) == 2
        assert names[0] != "/Fm1"  # first draw renamed to the copy
        assert names[1] == "/Fm1"  # second draw untouched
        # The copy's stream carries the clip; the original form's does not.
        with pikepdf.open(out) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            copy_ops = [
                str(i.operator) for i in pikepdf.parse_content_stream(xo[Name(names[0])])
            ]
            orig_ops = [
                str(i.operator) for i in pikepdf.parse_content_stream(xo[Name("/Fm1")])
            ]
        assert "W" in copy_ops
        assert "W" not in orig_ops

    def test_crop_validation_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import crop_page_image

        with pytest.raises(ValueError, match="within the image"):
            crop_page_image(src, out, 1, 0, [-0.2, 0, 1, 1])
        with pytest.raises(ValueError, match="degenerate"):
            crop_page_image(src, out, 1, 0, [0.5, 0.5, 0.5, 0.9])
        with pytest.raises(ValueError, match="rect must be"):
            crop_page_image(src, out, 1, 0, [0.1, 0.2, 0.3])
        with pytest.raises(ValueError, match="out of range"):
            crop_page_image(src, out, 1, 9, [0.1, 0.1, 0.9, 0.9])
        assert not os.path.exists(out)


class TestSetImageOpacity:
    """Phase 9.C3 — opacity = a page-local ExtGState at the target draw."""

    def test_opacity_registers_page_local_extgstate(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import set_image_opacity

        set_image_opacity(src, out, 1, 0, 0.5)
        with pikepdf.open(out) as pdf:
            egs = pdf.pages[0].obj["/Resources"]["/ExtGState"]
            entry = egs[Name("/EditGS0")]
            assert float(entry["/ca"]) == pytest.approx(0.5)
            assert float(entry["/CA"]) == pytest.approx(0.5)
        ops = _ops_in_page_stream(out)
        i_gs = next(i for i, (op, args) in enumerate(ops) if op == "gs")
        assert ops[i_gs][1] == ["/EditGS0"]
        assert ops[i_gs + 1] == ("Do", ["/ImA"])

    def test_opacity_lists_back_as_seed_and_touches_one_placement(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import set_image_opacity

        set_image_opacity(src, out, 1, 1, 0.3)  # the SECOND /ImA placement
        listed = list_page_images(out, 1)["images"]
        assert listed[0]["opacity"] == pytest.approx(1.0)  # shared XObject, untouched draw
        assert listed[1]["opacity"] == pytest.approx(0.3)
        assert listed[2]["opacity"] == pytest.approx(1.0)

    def test_nested_opacity_registers_on_the_form_copy(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_form_image(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import set_image_opacity

        set_image_opacity(src, out, 1, 0, 0.4)
        names = _names_in_page_stream(out)
        assert names[0] != "/Fm1" and names[1] == "/Fm1"
        with pikepdf.open(out) as pdf:
            xo = pdf.pages[0].obj["/Resources"]["/XObject"]
            copy_res = xo[Name(names[0])].get("/Resources")
            orig_res = xo[Name("/Fm1")].get("/Resources")
            assert "/EditGS0" in {str(k) for k in copy_res["/ExtGState"].keys()}
            orig_egs = orig_res.get("/ExtGState")
            assert orig_egs is None or "/EditGS0" not in {str(k) for k in orig_egs.keys()}
        listed = list_page_images(out, 1)["images"]
        assert listed[0]["opacity"] == pytest.approx(0.4)
        assert listed[1]["opacity"] == pytest.approx(1.0)

    def test_opacity_does_not_leak_into_sibling_sharing_resources(self, tmp_dir):
        # The C2 sibling-leak shape, for /ExtGState: two pages share ONE
        # /Resources object; dimming page 1's image must not surface the
        # /EditGS entry on page 2.
        src = os.path.join(tmp_dir, "shared.pdf")
        pdf = pikepdf.new()
        im = _rgb_image(pdf, 10, 20, 30)
        shared_res = pdf.make_indirect(Dictionary(XObject=Dictionary(Im0=im)))
        p1 = pdf.add_blank_page(page_size=(400, 400))
        p2 = pdf.add_blank_page(page_size=(400, 400))
        p1.obj["/Resources"] = shared_res
        p2.obj["/Resources"] = shared_res
        p1.Contents = pdf.make_stream(b"q 50 0 0 50 10 10 cm /Im0 Do Q")
        p2.Contents = pdf.make_stream(b"q 50 0 0 50 10 10 cm /Im0 Do Q")
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import set_image_opacity

        set_image_opacity(src, out, 1, 0, 0.5)
        with pikepdf.open(out) as opdf:
            p1_res = opdf.pages[0].obj["/Resources"]
            p2_res = opdf.pages[1].obj["/Resources"]
            p1_egs = p1_res.get("/ExtGState")
            p2_egs = p2_res.get("/ExtGState")
            assert p1_egs is not None and "/EditGS0" in {str(k) for k in p1_egs.keys()}
            assert p2_egs is None or "/EditGS0" not in {str(k) for k in p2_egs.keys()}

    def test_opacity_name_never_shadows_an_existing_entry(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 400))
        im = _rgb_image(pdf, 200, 100, 0)
        taken = pdf.make_indirect(Dictionary(Type=Name("/ExtGState"), ca=0.9))
        page.obj["/Resources"] = Dictionary(
            XObject=Dictionary(Im0=im), ExtGState=Dictionary(EditGS0=taken)
        )
        page.Contents = pdf.make_stream(b"q /EditGS0 gs 50 0 0 50 10 10 cm /Im0 Do Q")
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import set_image_opacity

        set_image_opacity(src, out, 1, 0, 0.2)
        with pikepdf.open(out) as opdf:
            egs = opdf.pages[0].obj["/Resources"]["/ExtGState"]
            names = {str(k) for k in egs.keys()}
            assert "/EditGS0" in names  # the document's own, untouched
            assert "/EditGS1" in names  # ours, allocated past the collision
            assert float(egs[Name("/EditGS0")]["/ca"]) == pytest.approx(0.9)
            assert float(egs[Name("/EditGS1")]["/ca"]) == pytest.approx(0.2)

    def test_opacity_validation_fails_closed(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _page_with_images(src)
        out = os.path.join(tmp_dir, "o.pdf")
        from engine.page_images import set_image_opacity

        with pytest.raises(ValueError, match="between 0 and 1"):
            set_image_opacity(src, out, 1, 0, 1.5)
        with pytest.raises(ValueError, match="between 0 and 1"):
            set_image_opacity(src, out, 1, 0, -0.1)
        with pytest.raises(ValueError, match="must be a number"):
            set_image_opacity(src, out, 1, 0, "solid")
        assert not os.path.exists(out)

    def test_walker_alpha_respects_q_scope(self, tmp_dir):
        # A gs inside q/Q must not bleed into a later draw; a draw inside
        # the scope reports the dimmed alpha.
        src = os.path.join(tmp_dir, "s.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(400, 400))
        im = _rgb_image(pdf, 5, 5, 5)
        half = pdf.make_indirect(Dictionary(Type=Name("/ExtGState"), ca=0.5))
        page.obj["/Resources"] = Dictionary(
            XObject=Dictionary(Im0=im), ExtGState=Dictionary(GHalf=half)
        )
        page.Contents = pdf.make_stream(
            b"q /GHalf gs 50 0 0 50 10 10 cm /Im0 Do Q "
            b"q 50 0 0 50 200 10 cm /Im0 Do Q"
        )
        pdf.save(src)
        pdf.close()
        listed = list_page_images(src, 1)["images"]
        assert listed[0]["opacity"] == pytest.approx(0.5)
        assert listed[1]["opacity"] == pytest.approx(1.0)
