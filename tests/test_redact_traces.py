"""Everything besides pixels that can hand back what a redaction removed.

ISO 32000-2 §12.5.6.23 asks a redactor to remove all traces of the content
under a mark, and to be diligent about every place content can live. Each
test here builds a document that keeps a marker somewhere a page rewrite does
not reach by itself — a form drawing its image through the page's own
resources, a structure element pointing at the original, an image inside a
pattern cell or a soft mask, a copy's metadata, the page's private data, the
text a reader would substitute, a field's value, a path drawn under the mark —
redacts it, and requires the marker to be gone from the saved file.
"""

from __future__ import annotations

import base64
import os
import zlib

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine import redact_geometry
from engine.redact import redact

W = H = 8


def _secret_rgb() -> bytes:
    out = bytearray()
    for row in range(H):
        for col in range(W):
            out += bytes([row * 16 + col, 200, 100])
    return bytes(out)


SECRET = _secret_rgb()
MARKER = b"SSN-123-45-6789"


def _image(doc, data: bytes = SECRET, **extra):
    stream = doc.make_stream(zlib.compress(data))
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = W
    stream["/Height"] = H
    stream["/ColorSpace"] = Name("/DeviceRGB")
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name("/FlateDecode")
    for key, value in extra.items():
        stream[Name("/" + key)] = value
    return doc.make_indirect(stream)


def _form(doc, content: bytes, resources=None, **extra):
    form = doc.make_stream(content)
    form["/Type"] = Name("/XObject")
    form["/Subtype"] = Name("/Form")
    form["/BBox"] = Array([0, 0, 100, 100])
    if resources is not None:
        form["/Resources"] = resources
    for key, value in extra.items():
        form[Name("/" + key)] = value
    return doc.make_indirect(form)


def _helvetica():
    return Dictionary(Type=Name("/Font"), Subtype=Name("/Type1"), BaseFont=Name("/Helvetica"))


def _save(doc, path: str) -> str:
    doc.save(path)
    doc.close()
    return path


def _anywhere(path: str, needle: bytes) -> bool:
    """Is `needle` in the file's bytes, in any stream decoded or raw, or in any
    object as written?"""
    if needle in open(path, "rb").read():
        return True
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream):
                for reader in ("read_bytes", "read_raw_bytes"):
                    try:
                        if needle in bytes(getattr(obj, reader)()):
                            return True
                        break
                    except Exception:
                        continue
            try:
                if needle in obj.unparse():
                    return True
            except Exception:
                continue
    return False


def _run(tmp_dir, doc, rect, name="in"):
    src = _save(doc, os.path.join(tmp_dir, f"{name}.pdf"))
    out = os.path.join(tmp_dir, f"{name}_out.pdf")
    result = redact(file=src, output=out, regions=[{"page": 1, "rect": rect}])
    return src, out, result


# ── forms and inherited resources ─────────────────────────────────────────


class TestFormsWithoutResources:
    """A form without /Resources draws with its caller's names (ISO 32000-2
    §7.8.3). Listed on the page after its copy replaced it, it kept the
    page's image alive through the resource sweep."""

    @pytest.mark.parametrize("rect,outcome", [([10, 10, 50, 50], "images_modified"), ([0, 0, 100, 100], "images_removed")])
    def test_the_page_names_a_form_draws_leave_with_it(self, tmp_dir, rect, outcome):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        form = _form(doc, b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        page.Resources = Dictionary(XObject=Dictionary(Im0=_image(doc), Fm0=form))
        page.Contents = doc.make_stream(b"/Fm0 Do")

        _src, out, result = _run(tmp_dir, doc, rect)

        assert result[outcome] == 1
        assert not _anywhere(out, SECRET)
        assert not _anywhere(out, zlib.compress(SECRET))

    def test_a_form_inside_a_form_without_resources(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        inner = _form(doc, b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        outer = _form(doc, b"/FmB Do", Dictionary(XObject=Dictionary(Im0=_image(doc), FmB=inner)))
        page.Resources = Dictionary(XObject=Dictionary(FmA=outer))
        page.Contents = doc.make_stream(b"/FmA Do")

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        assert not _anywhere(out, zlib.compress(SECRET))

    def test_resources_inherited_from_the_page_tree(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        form = _form(doc, b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        doc.Root.Pages["/Resources"] = doc.make_indirect(Dictionary(XObject=Dictionary(Fm0=form, Im0=_image(doc))))
        del page.obj["/Resources"]
        page.Contents = doc.make_stream(b"/Fm0 Do")

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        assert not _anywhere(out, zlib.compress(SECRET))
        with pikepdf.open(out) as pdf:
            assert "/Resources" not in pdf.Root.Pages


class TestSharedResources:
    """One resource dictionary shared by every page — by reference, inherited,
    or handed to a form — lists every page's pictures. A page the mark never
    reached still LISTS the original the redacted page replaced, and a listing
    keeps it in the saved file."""

    OTHER = bytes(range(W * H * 3))

    def _two_pages(self, doc, how: str):
        first = doc.add_blank_page(page_size=(100, 100))
        second = doc.add_blank_page(page_size=(100, 100))
        shared = doc.make_indirect(Dictionary(XObject=Dictionary(Im0=_image(doc), Im1=_image(doc, self.OTHER))))
        first.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        if how == "inherited":
            doc.Root.Pages["/Resources"] = shared
            for page in (first, second):
                del page.obj["/Resources"]
            second.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im1 Do Q")
        elif how == "by reference":
            first.obj["/Resources"] = shared
            second.obj["/Resources"] = shared
            second.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im1 Do Q")
        else:
            first.obj["/Resources"] = shared
            form = _form(doc, b"q 80 0 0 80 10 10 cm /Im1 Do Q", shared)
            second.obj["/Resources"] = Dictionary(XObject=Dictionary(Fm0=form))
            second.Contents = doc.make_stream(b"/Fm0 Do")

    @pytest.mark.parametrize("how", ["inherited", "by reference", "through a form"])
    def test_a_page_that_does_not_draw_the_original_stops_listing_it(self, tmp_dir, how):
        doc = pikepdf.new()
        self._two_pages(doc, how)

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        assert not _anywhere(out, zlib.compress(SECRET))
        assert _anywhere(out, zlib.compress(self.OTHER)), "the other page keeps its own picture"

    def test_a_page_that_draws_the_original_outside_the_mark_keeps_it(self, tmp_dir):
        doc = pikepdf.new()
        first = doc.add_blank_page(page_size=(100, 100))
        second = doc.add_blank_page(page_size=(100, 100))
        shared = doc.make_indirect(Dictionary(XObject=Dictionary(Im0=_image(doc))))
        first.obj["/Resources"] = shared
        second.obj["/Resources"] = shared
        first.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        second.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")

        _src, out, _result = _run(tmp_dir, doc, [10, 10, 50, 50])

        with pikepdf.open(out) as pdf:
            drawn = pdf.pages[1].Resources.XObject[Name("/Im0")]
            assert bytes(drawn.read_bytes()) == SECRET


class TestFormCopyKeys:
    @pytest.mark.parametrize("key", ["/Metadata", "/PieceInfo", "/LastModified", "/AF", "/OPI", "/Ref", "/PtData", "/Private"])
    def test_a_form_copy_carries_nothing_that_describes_the_original(self, tmp_dir, key):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        carrier = doc.make_stream(MARKER)
        payload = {
            "/Metadata": carrier,
            "/LastModified": String(MARKER.decode()),
            "/AF": Array([Dictionary(Type=Name("/Filespec"), F=String("src.ai"), EF=Dictionary(F=carrier))]),
        }.get(key, Dictionary(Data=carrier))
        form = _form(doc, b"q 80 0 0 80 10 10 cm /Im0 Do Q", Dictionary(XObject=Dictionary(Im0=_image(doc))))
        form[Name(key)] = payload
        page.Resources = Dictionary(XObject=Dictionary(Fm0=form))
        page.Contents = doc.make_stream(b"/Fm0 Do")

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0].Resources.XObject
            copy = xobjects[next(k for k in xobjects.keys() if str(k).startswith("/RdxFm"))]
            assert key not in copy
        assert not _anywhere(out, MARKER)


# ── structure ─────────────────────────────────────────────────────────────


def _tagged(doc, page, kids, alt="Photo of passport number X1234567", parent_tree=None):
    figure = doc.make_indirect(
        Dictionary(Type=Name("/StructElem"), S=Name("/Figure"), Alt=String(alt), Pg=page.obj, K=kids)
    )
    root = Dictionary(Type=Name("/StructTreeRoot"), K=figure)
    if parent_tree is not None:
        root["/ParentTree"] = Dictionary(Nums=Array(parent_tree(figure)))
        root["/ParentTreeNextKey"] = 1
    root = doc.make_indirect(root)
    figure["/P"] = root
    doc.Root["/StructTreeRoot"] = root
    doc.Root["/MarkInfo"] = Dictionary(Marked=True)
    return figure


class TestStructure:
    def test_an_image_that_is_a_structure_item_is_rebound_to_its_copy(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        image = _image(doc, StructParent=0)
        page.Resources = Dictionary(XObject=Dictionary(Im0=image))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        _tagged(doc, page, Dictionary(Type=Name("/OBJR"), Obj=image, Pg=page.obj), parent_tree=lambda fig: [0, fig])

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        with pikepdf.open(out) as pdf:
            copy = pdf.pages[0].Resources.XObject[Name("/RdxIm0")]
            figure = pdf.Root.StructTreeRoot.K
            assert figure.K.Obj.objgen == copy.objgen
            assert int(copy["/StructParent"]) == 0
            assert "/Alt" not in figure
        assert not _anywhere(out, zlib.compress(SECRET))
        assert not _anywhere(out, b"X1234567")

    def test_a_structure_item_removed_whole_leaves_the_tree(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        image = _image(doc, StructParent=0)
        page.Resources = Dictionary(XObject=Dictionary(Im0=image))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        _tagged(doc, page, Dictionary(Type=Name("/OBJR"), Obj=image, Pg=page.obj), parent_tree=lambda fig: [0, fig])

        _src, out, result = _run(tmp_dir, doc, [0, 0, 100, 100])

        assert result["images_removed"] == 1
        with pikepdf.open(out) as pdf:
            assert "/K" not in pdf.Root.StructTreeRoot.K
        assert not _anywhere(out, zlib.compress(SECRET))

    def test_only_the_first_copy_keeps_the_structure_key(self, tmp_dir):
        """Two placements with different marks make two copies; a structure
        parent key names ONE object, so the second copy gives it up."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        image = _image(doc, StructParent=0)
        page.Resources = Dictionary(XObject=Dictionary(Im0=image))
        page.Contents = doc.make_stream(b"q 40 0 0 40 0 0 cm /Im0 Do Q q 40 0 0 40 60 60 cm /Im0 Do Q")
        _tagged(doc, page, Dictionary(Type=Name("/OBJR"), Obj=image, Pg=page.obj), parent_tree=lambda fig: [0, fig])
        src = _save(doc, os.path.join(tmp_dir, "in.pdf"))
        out = os.path.join(tmp_dir, "out.pdf")

        redact(file=src, output=out, regions=[{"page": 1, "rect": [0, 0, 10, 10]}, {"page": 1, "rect": [90, 90, 100, 100]}])

        with pikepdf.open(out) as pdf:
            xobjects = pdf.pages[0].Resources.XObject
            keyed = [k for k in xobjects.keys() if "/StructParent" in xobjects[k]]
            assert len(keyed) == 1
            assert pdf.Root.StructTreeRoot.K.K.Obj.objgen == xobjects[keyed[0]].objgen

    @pytest.mark.parametrize("parent_tree", [True, False], ids=["parent-tree", "k-only"])
    def test_a_description_of_redacted_content_goes(self, tmp_dir, parent_tree):
        """The element's /Alt describes the picture it tags, including the part
        under the mark. It is found through the parent tree, or through the
        element's own /K where the file has no parent tree."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        page.Resources = Dictionary(XObject=Dictionary(Im0=_image(doc)))
        page.Contents = doc.make_stream(b"/Figure <</MCID 0>> BDC q 80 0 0 80 10 10 cm /Im0 Do Q EMC")
        if parent_tree:
            page.obj["/StructParents"] = 0
            _tagged(doc, page, 0, parent_tree=lambda fig: [0, Array([fig])])
        else:
            _tagged(doc, page, 0)

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        assert not _anywhere(out, b"X1234567")

    def test_an_element_whose_content_the_mark_missed_keeps_its_description(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(200, 100))
        page.Resources = Dictionary(XObject=Dictionary(Im0=_image(doc)))
        page.Contents = doc.make_stream(b"/Figure <</MCID 0>> BDC q 80 0 0 80 110 10 cm /Im0 Do Q EMC")
        _tagged(doc, page, 0)

        _src, out, _result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert _anywhere(out, b"X1234567")

    def test_an_annotation_under_the_mark_leaves_the_structure_too(self, tmp_dir):
        """A link's structure element points at the annotation with an OBJR;
        left in place it keeps the emptied annotation — and anything the
        emptying missed — reachable."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        link = doc.make_indirect(
            Dictionary(
                Type=Name("/Annot"),
                Subtype=Name("/Link"),
                Rect=Array([20, 20, 40, 40]),
                A=Dictionary(S=Name("/URI"), URI=String("https://example.invalid/" + MARKER.decode())),
                StructParent=0,
            )
        )
        page.obj["/Annots"] = Array([link])
        page.Contents = doc.make_stream(b"")
        element = doc.make_indirect(
            Dictionary(Type=Name("/StructElem"), S=Name("/Link"), Pg=page.obj, K=Dictionary(Type=Name("/OBJR"), Obj=link))
        )
        root = doc.make_indirect(
            Dictionary(Type=Name("/StructTreeRoot"), K=element, ParentTree=Dictionary(Nums=Array([0, element])))
        )
        element["/P"] = root
        doc.Root["/StructTreeRoot"] = root

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["annotations_removed"] == 1
        assert not _anywhere(out, MARKER)
        with pikepdf.open(out) as pdf:
            assert "/K" not in pdf.Root.StructTreeRoot.K


# ── images painted by patterns and soft masks ─────────────────────────────


class TestPatternsAndSoftMasks:
    def test_an_image_in_a_pattern_cell_is_redacted(self, tmp_dir):
        """A picture fill: the shape is filled with a tiling pattern whose cell
        draws the image. The fill under the mark is cut, and the cell the
        remaining fill still paints loses the marked pixels too."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        cell = doc.make_stream(b"q 80 0 0 80 0 0 cm /Im0 Do Q")
        cell["/Type"] = Name("/Pattern")
        cell["/PatternType"] = 1
        cell["/PaintType"] = 1
        cell["/TilingType"] = 1
        cell["/BBox"] = Array([0, 0, 80, 80])
        cell["/XStep"] = 80
        cell["/YStep"] = 80
        cell["/Matrix"] = Array([1, 0, 0, 1, 10, 10])
        cell["/Resources"] = Dictionary(XObject=Dictionary(Im0=_image(doc)))
        page.Resources = Dictionary(Pattern=Dictionary(P0=doc.make_indirect(cell)))
        page.Contents = doc.make_stream(b"/Pattern cs /P0 scn 10 10 80 80 re f")

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        assert not _anywhere(out, zlib.compress(SECRET))
        with pikepdf.open(out) as pdf:
            patterns = pdf.pages[0].Resources.Pattern
            names = [str(k) for k in patterns.keys()]
            assert names == ["/RdxPt0"] or all(n.startswith("/RdxPt") for n in names), names
            image = next(iter(patterns[Name(names[0])].Resources.XObject.values()))
            data = bytes(image.read_bytes())
        # The mark covers the cell's bottom-left 4x4 pixels (40 of its 80
        # points); everything else is the picture.
        for row in range(H):
            for col in range(W):
                pixel = data[(row * W + col) * 3 : (row * W + col) * 3 + 3]
                if row >= 4 and col < 4:
                    assert pixel == bytes([0, 0, 0]), (row, col)
                else:
                    assert pixel == SECRET[(row * W + col) * 3 : (row * W + col) * 3 + 3], (row, col)

    def test_an_image_in_a_soft_mask_group_is_redacted(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(100, 100))
        group = _form(
            doc,
            b"q 80 0 0 80 10 10 cm /Im0 Do Q",
            Dictionary(XObject=Dictionary(Im0=_image(doc))),
            Group=Dictionary(S=Name("/Transparency"), CS=Name("/DeviceGray")),
        )
        state = Dictionary(Type=Name("/ExtGState"), SMask=Dictionary(Type=Name("/Mask"), S=Name("/Luminosity"), G=group))
        page.Resources = Dictionary(ExtGState=Dictionary(GS0=state))
        page.Contents = doc.make_stream(b"q /GS0 gs 0 0 1 rg 10 10 80 80 re f Q")

        _src, out, result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert result["images_modified"] == 1
        assert not _anywhere(out, zlib.compress(SECRET))
        with pikepdf.open(out) as pdf:
            states = [str(k) for k in pdf.pages[0].Resources.ExtGState.keys()]
        assert len(states) == 1 and states[0].startswith("/RdxGs"), states


# ── page and document derivatives ─────────────────────────────────────────


def _xmp_with_thumbnail(payload: bytes) -> bytes:
    image = base64.b64encode(payload).decode("ascii")
    return (
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
        'xmlns:xmpGImg="http://ns.adobe.com/xap/1.0/g/img/" xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:format>application/pdf</dc:format>"
        "<xmp:Thumbnails><rdf:Alt><rdf:li rdf:parseType=\"Resource\"><xmpGImg:format>JPEG</xmpGImg:format>"
        f"<xmpGImg:image>{image}</xmpGImg:image></rdf:li></rdf:Alt></xmp:Thumbnails>"
        '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    ).encode("ascii")


class TestDerivatives:
    def _page_with_image(self, doc, size=(100, 100)):
        page = doc.add_blank_page(page_size=size)
        page.Resources = Dictionary(XObject=Dictionary(Im0=_image(doc)))
        page.Contents = doc.make_stream(b"q 80 0 0 80 10 10 cm /Im0 Do Q")
        return page

    @pytest.mark.parametrize("key", ["/PieceInfo", "/Metadata", "/AF", "/LastModified"])
    def test_a_redacted_page_loses_every_copy_of_itself(self, tmp_dir, key):
        doc = pikepdf.new()
        page = self._page_with_image(doc)
        carrier = doc.make_stream(MARKER)
        page.obj[key] = {
            "/PieceInfo": Dictionary(App=Dictionary(LastModified=String("D:20260101"), Private=carrier)),
            "/Metadata": carrier,
            "/AF": Array([Dictionary(Type=Name("/Filespec"), F=String("page.ai"), EF=Dictionary(F=carrier))]),
            "/LastModified": String(MARKER.decode()),
        }[key]

        _src, out, _result = _run(tmp_dir, doc, [10, 10, 50, 50])

        with pikepdf.open(out) as pdf:
            assert key not in pdf.pages[0].obj
        assert not _anywhere(out, MARKER)

    def test_the_document_thumbnail_and_private_data_go(self, tmp_dir):
        doc = pikepdf.new()
        self._page_with_image(doc)
        doc.Root["/Metadata"] = doc.make_stream(_xmp_with_thumbnail(MARKER))
        doc.Root["/PieceInfo"] = Dictionary(App=Dictionary(Private=doc.make_stream(MARKER)))

        _src, out, _result = _run(tmp_dir, doc, [10, 10, 50, 50])

        assert not _anywhere(out, base64.b64encode(MARKER))
        assert not _anywhere(out, MARKER)
        with pikepdf.open(out) as pdf:
            assert b"application/pdf" in bytes(pdf.Root.Metadata.read_bytes())
            assert "/PieceInfo" not in pdf.Root


# ── text a reader substitutes ─────────────────────────────────────────────


class TestReplacementText:
    @pytest.mark.parametrize("key", ["/ActualText", "/Alt", "/E"])
    def test_an_inline_property_list_loses_it(self, tmp_dir, key):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(200, 100))
        page.Resources = Dictionary(Font=Dictionary(F1=_helvetica()))
        page.Contents = doc.make_stream(
            b"/Span <<" + key.encode() + b" (" + MARKER + b")>> BDC BT /F1 12 Tf 10 40 Td (" + MARKER + b") Tj ET EMC"
        )

        _src, out, result = _run(tmp_dir, doc, [0, 30, 200, 60])

        assert result["text_runs_removed"] == 1
        assert not _anywhere(out, MARKER)

    def test_a_named_property_list_is_replaced_not_edited(self, tmp_dir):
        """A named property list is a shared resource: the redacted stream
        points at a cleaned copy, and the original leaves the page."""
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(200, 100))
        props = doc.make_indirect(Dictionary(ActualText=String(MARKER.decode()), Lang=String("en")))
        page.Resources = Dictionary(Font=Dictionary(F1=_helvetica()), Properties=Dictionary(P0=props))
        page.Contents = doc.make_stream(b"/Span /P0 BDC BT /F1 12 Tf 10 40 Td (" + MARKER + b") Tj ET EMC")

        _src, out, _result = _run(tmp_dir, doc, [0, 30, 200, 60])

        assert not _anywhere(out, MARKER)
        with pikepdf.open(out) as pdf:
            properties = pdf.pages[0].Resources.Properties
            assert [str(k) for k in properties.keys()] == ["/RdxMc0"]
            assert str(properties[Name("/RdxMc0")].Lang) == "en"

    def test_a_sequence_the_mark_missed_keeps_it(self, tmp_dir):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(200, 200))
        page.Resources = Dictionary(Font=Dictionary(F1=_helvetica()))
        page.Contents = doc.make_stream(
            b"/Span <</ActualText (KEPT-TEXT)>> BDC BT /F1 12 Tf 10 150 Td (KEPT) Tj ET EMC "
            b"BT /F1 12 Tf 10 40 Td (" + MARKER + b") Tj ET"
        )

        _src, out, _result = _run(tmp_dir, doc, [0, 30, 200, 60])

        assert _anywhere(out, b"KEPT-TEXT")


# ── form fields ───────────────────────────────────────────────────────────


class TestFields:
    def _field_doc(self, merged: bool, xfa: bool = False):
        doc = pikepdf.new()
        page = doc.add_blank_page(page_size=(200, 200))
        appearance = _form(doc, b"/Tx BMC BT /Helv 10 Tf 2 5 Td (" + MARKER + b") Tj ET EMC")
        widget = Dictionary(
            Type=Name("/Annot"),
            Subtype=Name("/Widget"),
            Rect=Array([10, 40, 160, 60]),
            AP=Dictionary(N=appearance),
            P=page.obj,
        )
        kept_widget = doc.make_indirect(
            Dictionary(
                Type=Name("/Annot"), Subtype=Name("/Widget"), FT=Name("/Tx"), T=String("name"),
                V=String("KEPT-VALUE"), Rect=Array([10, 150, 160, 170]), P=page.obj,
            )
        )
        if merged:
            widget["/FT"] = Name("/Tx")
            widget["/T"] = String("ssn")
            widget["/V"] = String(MARKER.decode())
            widget["/DV"] = String(MARKER.decode())
            widget = doc.make_indirect(widget)
            fields = [widget, kept_widget]
        else:
            widget = doc.make_indirect(widget)
            field = doc.make_indirect(
                Dictionary(FT=Name("/Tx"), T=String("ssn"), V=String(MARKER.decode()), Kids=Array([widget]))
            )
            widget["/Parent"] = field
            fields = [field, kept_widget]
        page.obj["/Annots"] = Array([widget, kept_widget])
        acroform = Dictionary(Fields=Array(fields), DA=String("/Helv 0 Tf 0 g"))
        if xfa:
            acroform["/XFA"] = doc.make_stream(b"<xdp:xdp><datasets><ssn>" + MARKER + b"</ssn></datasets></xdp:xdp>")
        doc.Root["/AcroForm"] = acroform
        return doc

    @pytest.mark.parametrize("merged", [True, False], ids=["merged", "kid-widget"])
    def test_a_field_under_the_mark_loses_its_value_and_leaves_the_form(self, tmp_dir, merged):
        doc = self._field_doc(merged)

        _src, out, result = _run(tmp_dir, doc, [0, 30, 200, 70])

        assert result["annotations_removed"] == 1
        assert not _anywhere(out, MARKER)
        with pikepdf.open(out) as pdf:
            names = [str(f.get("/T")) for f in pdf.Root.AcroForm.Fields]
            assert names == ["name"]
            assert str(pdf.Root.AcroForm.Fields[0].V) == "KEPT-VALUE"

    def test_the_xfa_copy_of_every_value_goes_with_it(self, tmp_dir):
        doc = self._field_doc(True, xfa=True)

        _src, out, _result = _run(tmp_dir, doc, [0, 30, 200, 70])

        assert not _anywhere(out, MARKER)
        with pikepdf.open(out) as pdf:
            assert "/XFA" not in pdf.Root.AcroForm


# ── paths ─────────────────────────────────────────────────────────────────

MARK = (40.0, 40.0, 60.0, 60.0)


def _painted(path: str) -> list:
    """`(paint operator, [device polygon, ...], line width)` for every path
    painted on page 1 before the redaction overlay, curves taken by their
    control polygon (which contains them)."""
    with pikepdf.open(path) as pdf:
        instructions = list(pikepdf.parse_content_stream(pdf.pages[0]))
    out = []
    ctm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    stack = []
    width = 1.0
    polygons: list = []
    current: list = []

    def apply(x, y):
        a, b, c, d, e, f = ctm
        return (a * x + c * y + e, b * x + d * y + f)

    for ins in instructions:
        op = str(ins.operator)
        args = [float(v) for v in ins.operands] if op not in ("d", "BDC", "Tf", "Tj", "TJ", "Do", "cs", "scn", "gs") else []
        if op == "q":
            stack.append((ctm, width))
        elif op == "Q":
            ctm, width = stack.pop()
        elif op == "cm":
            a, b, c, d, e, f = args
            A, B, C, D, E, F = ctm
            ctm = (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)
        elif op == "w":
            width = args[0]
        elif op == "m":
            current = [apply(*args)]
            polygons.append(current)
        elif op == "l":
            current.append(apply(*args))
        elif op in ("c", "v", "y"):
            for index in range(0, len(args), 2):
                current.append(apply(args[index], args[index + 1]))
        elif op == "re":
            x, y, w, h = args
            polygons.append([apply(x, y), apply(x + w, y), apply(x + w, y + h), apply(x, y + h)])
        elif op in ("f", "F", "f*", "S", "s", "B", "B*", "b", "b*", "n", "W", "W*"):
            if op in ("W", "W*"):
                out.append((op, [list(p) for p in polygons], width))
                continue
            out.append((op, polygons, width))
            polygons = []
            current = []
    # The redaction box is the page's last fill.
    return out[:-1]


def _area_inside(polygon, rect) -> float:
    return redact_geometry.area(redact_geometry.clip_to_rect(list(polygon), rect))


def _near(point, rect, reach) -> bool:
    x, y = point
    return rect[0] - reach < x < rect[2] + reach and rect[1] - reach < y < rect[3] + reach


class TestPaths:
    def _page(self, tmp_dir, content: bytes, rect=MARK, name="in"):
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(100, 100)).Contents = doc.make_stream(content)
        return _run(tmp_dir, doc, list(rect), name)

    def test_a_fill_loses_exactly_the_marked_area(self, tmp_dir):
        _src, out, result = self._page(tmp_dir, b"0 0 1 rg 10 10 80 80 re f")

        assert result["paths_redacted"] == 1
        [(op, polygons, _w)] = _painted(out)
        assert op == "f"
        assert all(_area_inside(p, MARK) < 1e-9 for p in polygons)
        assert abs(sum(redact_geometry.area(p) for p in polygons) - (80 * 80 - 20 * 20)) < 1e-6

    def test_an_even_odd_fill_with_a_hole_keeps_its_rule(self, tmp_dir):
        _src, out, _result = self._page(tmp_dir, b"10 10 80 80 re 30 30 40 40 re f*")

        [(op, polygons, _w)] = _painted(out)
        assert op == "f*"
        assert all(_area_inside(p, MARK) < 1e-9 for p in polygons)

    def test_a_curve_through_the_mark_is_cut_there(self, tmp_dir):
        _src, out, _result = self._page(tmp_dir, b"10 50 m 30 90 70 10 90 50 c 90 10 l 10 10 l h f")

        [(op, polygons, _w)] = _painted(out)
        assert all(_area_inside(p, MARK) < 1e-9 for p in polygons)

    def test_a_stroke_stops_short_of_the_mark_by_its_own_reach(self, tmp_dir):
        _src, out, result = self._page(tmp_dir, b"4 w 10 50 m 90 50 l S")

        assert result["paths_redacted"] == 1
        [(op, polygons, width)] = _painted(out)
        assert op == "S"
        assert len(polygons) == 2
        # Half the width, and the corner of a square cap.
        reach = width / 2 * 2 ** 0.5
        for polygon in polygons:
            assert not any(_near(point, MARK, reach) for point in polygon)
        xs = sorted(point[0] for polygon in polygons for point in polygon)
        assert xs[0] == 10 and xs[-1] == 90

    def test_a_dashed_stroke_keeps_its_phase_after_the_cut(self, tmp_dir):
        _src, out, _result = self._page(tmp_dir, b"[6 3] 1 d 10 50 m 90 50 l S")

        with pikepdf.open(out) as pdf:
            instructions = list(pikepdf.parse_content_stream(pdf.pages[0]))
        phases = []
        starts = []
        for index, ins in enumerate(instructions[:-1]):
            if str(ins.operator) == "d" and str(instructions[index + 1].operator) == "m":
                phases.append(float(ins.operands[1]))
                starts.append(float(instructions[index + 1].operands[0]))
        assert len(phases) == 2
        for phase, start in zip(phases, starts):
            assert abs(phase - (1 + (start - 10))) < 1e-6

    def test_a_clip_loses_the_marked_area_and_never_becomes_no_clip(self, tmp_dir):
        _src, out, _result = self._page(tmp_dir, b"q 30 30 40 40 re W n 0 g 0 0 100 100 re f Q")

        painted = _painted(out)
        clips = [polygons for op, polygons, _w in painted if op == "W"]
        assert clips and all(_area_inside(p, MARK) < 1e-9 for p in clips[0])

    def test_a_clip_inside_the_mark_becomes_an_empty_clip(self, tmp_dir):
        _src, out, _result = self._page(tmp_dir, b"q 45 45 10 10 re W n 0 g 0 0 100 100 re f Q")

        with pikepdf.open(out) as pdf:
            body = bytes(pdf.pages[0].Contents.read_bytes())
        assert b"0 0 0 0 re" in body
        assert b"W" in body

    def test_an_unpainted_path_under_the_mark_is_dropped(self, tmp_dir):
        _src, out, _result = self._page(tmp_dir, b"45 45 m 55 55 l n 0 g 0 0 5 5 re f")

        with pikepdf.open(out) as pdf:
            body = bytes(pdf.pages[0].Contents.read_bytes())
        assert b"45 45 m" not in body

    def test_a_path_the_mark_does_not_reach_is_kept_as_written(self, tmp_dir):
        _src, out, result = self._page(tmp_dir, b"0 0 1 rg 10 10 m 20 10 l 20 20 l h f")

        assert result["paths_redacted"] == 0
        with pikepdf.open(out) as pdf:
            ops = [str(i.operator) for i in pikepdf.parse_content_stream(pdf.pages[0])]
        assert ops[:6] == ["rg", "m", "l", "l", "h", "f"]
