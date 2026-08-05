"""Hidden-information audit and removal.

The fixture carries one instance of every class the inventory names, so a
detector that regresses to zero fails a count assertion rather than passing
quietly.

One correction the recon fixture needed: `Tr` is a text-state parameter and
survives `ET`, so a stream that sets `3 Tr` and never restores it draws every
later run invisibly too. Each class here restores the state it changes, which
is what makes one class testable at a time.
"""

import io
import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.sanitize import audit_hidden_information, sanitize_pdf

CONTENT = """
BT /F1 12 Tf 72 720 Td (Visible paragraph one.) Tj ET
/OC /MC0 BDC
BT /F1 12 Tf 72 690 Td (HIDDEN LAYER TEXT) Tj ET
EMC
BT 3 Tr /F1 12 Tf 72 660 Td (INVISIBLE RENDER MODE TEXT) Tj 0 Tr ET
BT 1 1 1 rg /F1 12 Tf 72 630 Td (WHITE ON WHITE TEXT) Tj 0 0 0 rg ET
BT /F1 12 Tf 72 600 Td (TEXT UNDER A BOX) Tj ET
0.9 0.9 0.9 rg 60 590 300 24 re f
0 0 0 rg
BT /F1 12 Tf 72 560 Td (Visible paragraph two.) Tj ET
BT /F1 12 Tf 72 530 Td (PARTLY COVERED TEXT) Tj ET
0.85 0.85 0.85 rg 60 520 50 24 re f
0 0 0 rg
"""


def _build(path: str) -> str:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/Helvetica"),
            Encoding=Name.WinAnsiEncoding,
        )
    )
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Draft")))
    pdf.Root[Name.OCProperties] = Dictionary(
        OCGs=Array([ocg]),
        D=Dictionary(ON=Array([]), OFF=Array([ocg]), Order=Array([ocg])),
    )

    stream = pdf.make_stream(CONTENT.encode("latin-1"))
    thumb = pikepdf.Stream(pdf, b"\x00" * (16 * 16))
    thumb[Name.Type] = Name.XObject
    thumb[Name.Subtype] = Name.Image
    thumb[Name.Width] = 16
    thumb[Name.Height] = 16
    thumb[Name.ColorSpace] = Name.DeviceGray
    thumb[Name.BitsPerComponent] = 8
    page_meta = pikepdf.Stream(
        pdf,
        b'<?xpacket begin="" ?><x:xmpmeta xmlns:x="ns:meta">'
        b"<contact>j.doe@example.invalid</contact></x:xmpmeta>",
    )
    page = Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, 612, 792]),
        Resources=Dictionary(Font=Dictionary(F1=font), Properties=Dictionary(MC0=ocg)),
        Contents=stream,
        Thumb=thumb,
        Metadata=page_meta,
        PieceInfo=Dictionary(
            SomeVendor=Dictionary(
                LastModified=String("D:20260101000000Z"),
                Private=Dictionary(Note=String("internal review copy")),
            )
        ),
        AA=Dictionary(O=Dictionary(S=Name.JavaScript, JS=String("app.alert('page open');"))),
    )
    page_ref = pdf.make_indirect(page)
    pdf.pages.append(pikepdf.Page(page_ref))
    p = pdf.pages[0]

    note = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Text,
            Rect=Array([400, 700, 420, 720]),
            Contents=String("Confirm the figures before release."),
            T=String("A. Reviewer"),
        )
    )
    highlight = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Highlight,
            Rect=Array([72, 715, 200, 730]),
            QuadPoints=Array([72, 730, 200, 730, 72, 715, 200, 715]),
            Contents=String("check this"),
            T=String("A. Reviewer"),
        )
    )
    widget = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Widget,
            FT=Name.Tx,
            Rect=Array([72, 500, 300, 520]),
            T=String("Reviewer_note"),
            V=String("private draft value"),
            F=4,
            P=page_ref,
            AA=Dictionary(
                K=Dictionary(S=Name.JavaScript, JS=String("this.getField('x').value='y';"))
            ),
        )
    )
    pdf.Root[Name.AcroForm] = Dictionary(Fields=Array([widget]), DA=String("/Helv 0 Tf 0 g"))

    uri_link = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Link,
            Rect=Array([72, 470, 200, 486]),
            A=Dictionary(S=Name.URI, URI=String("https://intranet.example.invalid/secret")),
        )
    )
    launch_link = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Link,
            Rect=Array([72, 445, 200, 461]),
            A=Dictionary(S=Name.Launch, F=String("payload.exe")),
        )
    )

    payload = pikepdf.Stream(pdf, b"secret annotation payload bytes")
    payload[Name.Type] = Name.EmbeddedFile
    spec = pdf.make_indirect(
        Dictionary(
            Type=Name.Filespec,
            F=String("annot-payload.txt"),
            UF=String("annot-payload.txt"),
            EF=Dictionary(F=payload),
            Desc=String("attached through an annotation"),
        )
    )
    file_annot = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.FileAttachment,
            Rect=Array([500, 600, 520, 620]),
            FS=spec,
            Contents=String("see attached"),
            T=String("A. Reviewer"),
        )
    )
    p.obj[Name.Annots] = Array([note, highlight, widget, uri_link, launch_link, file_annot])

    pdf.attachments["names-payload.txt"] = b"secret name-tree payload bytes"

    with pdf.open_outline() as ol:
        ol.root.append(pikepdf.OutlineItem("Confidential section", 0))

    js_stream = pdf.make_stream("﻿app.alert('doc js');".encode("utf-16-be"))
    names = pdf.Root.get(Name.Names) or Dictionary()
    names[Name.JavaScript] = Dictionary(
        Names=Array([String("Startup"), Dictionary(S=Name.JavaScript, JS=js_stream)])
    )
    pdf.Root[Name.Names] = names
    pdf.Root[Name.OpenAction] = Dictionary(
        S=Name.JavaScript, JS=String("app.alert('open action');")
    )
    pdf.Root[Name.PieceInfo] = Dictionary(
        SomeVendor=Dictionary(
            LastModified=String("D:20260101000000Z"),
            Private=Dictionary(Author=String("author@example.invalid")),
        )
    )

    # The accessibility surfaces: a structure tree, a document language and an
    # article thread all carry authored text that is invisible on the page.
    struct_root = pdf.make_indirect(Dictionary(Type=Name("/StructTreeRoot")))
    struct_root[Name("/K")] = Array(
        [
            Dictionary(
                Type=Name("/StructElem"),
                S=Name("/P"),
                Alt=String("an alternate description"),
            )
        ]
    )
    pdf.Root[Name("/StructTreeRoot")] = struct_root
    pdf.Root[Name("/MarkInfo")] = Dictionary(Marked=True)
    pdf.Root[Name("/Lang")] = String("en-GB")
    pdf.Root[Name("/Threads")] = Array(
        [pdf.make_indirect(Dictionary(Type=Name("/Thread"), I=Dictionary(Title=String("Draft thread"))))]
    )

    pdf.docinfo[Name.Title] = String("Quarterly results DRAFT")
    pdf.docinfo[Name.Author] = String("Jane Doe")
    pdf.docinfo[Name.Creator] = String("Internal Tool 3.1")
    with pdf.open_metadata() as meta:
        meta["dc:title"] = "Quarterly results DRAFT"
        meta["dc:creator"] = ["Jane Doe"]

    pdf.save(path)
    return path


def _add_revision(src: str, dst: str) -> str:
    """An incremental update replacing the page content with a shorter stream.
    The original body stays present in the file's first revision."""
    from pyhanko.pdf_utils import generic
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

    writer = IncrementalPdfFileWriter(io.BytesIO(open(src, "rb").read()))
    page_ref = writer.root["/Pages"]["/Kids"][0]
    contents_ref = page_ref.get_object().raw_get("/Contents")
    writer.mark_update(contents_ref)
    writer.objects[(contents_ref.generation, contents_ref.idnum)] = generic.StreamObject(
        {}, stream_data=b"BT /F1 12 Tf 72 720 Td (Visible paragraph one.) Tj ET\n"
    )
    buf = io.BytesIO()
    writer.write(buf)
    with open(dst, "wb") as handle:
        handle.write(buf.getvalue())
    return dst


def _build_with_orphan(path: str) -> str:
    """A file whose cross-reference table lists an object the trailer graph
    cannot reach. Our own writer cannot emit one, so the bytes are hand-built:
    an unreachable object is a class inherited from other producers."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
        b"<< /Note (orphaned draft data) >>",
    ]
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    start = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        start,
    )
    with open(path, "wb") as handle:
        handle.write(bytes(out))
    return path


def _build_scan(path: str) -> str:
    """A page whose only graphic is a full-page image, with invisible text
    over it — the shape a recognized scan has."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Helvetica"))
    )
    image = pikepdf.Stream(pdf, bytes([200]) * (8 * 8))
    image[Name.Type] = Name.XObject
    image[Name.Subtype] = Name.Image
    image[Name.Width] = 8
    image[Name.Height] = 8
    image[Name.ColorSpace] = Name.DeviceGray
    image[Name.BitsPerComponent] = 8
    content = (
        b"q 612 0 0 792 0 0 cm /Im0 Do Q\n"
        b"BT 3 Tr /F1 12 Tf 72 700 Td (recognized words) Tj 0 Tr ET\n"
    )
    page = Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, 612, 792]),
        Resources=Dictionary(Font=Dictionary(F1=font), XObject=Dictionary(Im0=image)),
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    pdf.save(path)
    return path


@pytest.fixture
def hidden_pdf(tmp_dir):
    return _build(os.path.join(tmp_dir, "hidden.pdf"))


@pytest.fixture
def incremental_pdf(hidden_pdf, tmp_dir):
    return _add_revision(hidden_pdf, os.path.join(tmp_dir, "incremental.pdf"))


@pytest.fixture
def orphan_pdf(tmp_dir):
    return _build_with_orphan(os.path.join(tmp_dir, "orphan.pdf"))


@pytest.fixture
def scan_pdf(tmp_dir):
    return _build_scan(os.path.join(tmp_dir, "scan.pdf"))


def counts(result) -> dict:
    return {row["id"]: row["count"] for row in result["categories"]}


def row(result, category: str) -> dict:
    return next(r for r in result["categories"] if r["id"] == category)


class TestAuditTotality:
    def test_every_category_reports(self, hidden_pdf):
        result = audit_hidden_information(hidden_pdf)
        assert [r["id"] for r in result["categories"]] == [
            "metadata",
            "embedded_files",
            "bookmarks",
            "comments",
            "form_fields",
            "javascript",
            "hidden_layers",
            "hidden_text",
            "prior_revisions",
            "unreferenced_objects",
            "links_and_actions",
            "thumbnails",
            "attached_structure",
            "signatures",
        ]
        assert result["unreadable"] == []

    def test_the_classes_the_base_fixture_carries_are_all_found(self, hidden_pdf):
        c = counts(audit_hidden_information(hidden_pdf))
        for category in (
            "metadata",
            "embedded_files",
            "bookmarks",
            "comments",
            "form_fields",
            "javascript",
            "hidden_layers",
            "hidden_text",
            "links_and_actions",
            "thumbnails",
            "attached_structure",
        ):
            assert c[category] > 0, category

    def test_prior_revisions_and_orphans_come_from_their_own_fixtures(
        self, incremental_pdf, orphan_pdf
    ):
        assert counts(audit_hidden_information(incremental_pdf))["prior_revisions"] > 0
        assert counts(audit_hidden_information(orphan_pdf))["unreferenced_objects"] > 0


class TestEmbeddedFileReachability:
    def test_reports_both_routes_where_the_name_tree_reports_one(self, hidden_pdf):
        from engine.attachments import list_attachments

        assert list_attachments(hidden_pdf)["count"] == 1
        found = row(audit_hidden_information(hidden_pdf), "embedded_files")
        assert found["count"] == 2
        routes = {d["name"]: d["via"] for d in found["detail"]}
        assert routes == {
            "names-payload.txt": "name tree",
            "annot-payload.txt": "annotation",
        }
        sizes = {d["name"]: d["bytes"] for d in found["detail"]}
        assert sizes["annot-payload.txt"] == len(b"secret annotation payload bytes")


class TestMetadataSurfaces:
    def test_names_the_surfaces_a_docinfo_sweep_leaves(self, hidden_pdf):
        found = row(audit_hidden_information(hidden_pdf), "metadata")
        where = [d["where"] for d in found["detail"]]
        assert where.count("page 1") == 2
        assert "document info" in where
        assert "document identifier" in where
        # The identifier is reported and not counted: a writer always emits
        # one, so a counted surface could never reach zero.
        assert found["count"] == len(where) - 1

    def test_a_docinfo_only_strip_leaves_the_count_high(self, hidden_pdf, tmp_dir):
        from engine.metadata import strip_metadata

        out = os.path.join(tmp_dir, "stripped.pdf")
        strip_metadata(hidden_pdf, out)
        assert counts(audit_hidden_information(out))["metadata"] >= 3


class TestJavaScriptSites:
    def test_all_four_sites_the_name_tree_reader_misses(self, hidden_pdf):
        from engine.document_js import list_document_js

        assert list_document_js(hidden_pdf)["count"] == 1
        found = row(audit_hidden_information(hidden_pdf), "javascript")
        assert found["count"] == 4
        assert {d["site"] for d in found["detail"]} == {
            "name_tree",
            "open_action",
            "page_aa",
            "annotation_aa",
        }


class TestHiddenText:
    def test_one_pin_per_detector(self, hidden_pdf):
        found = row(audit_hidden_information(hidden_pdf), "hidden_text")
        by_text = {d["text"]: d["kind"] for d in found["detail"]}
        assert by_text["HIDDEN LAYER TEXT"] == "off_layer"
        assert by_text["INVISIBLE RENDER MODE TEXT"] == "invisible"
        assert by_text["WHITE ON WHITE TEXT"] == "background_fill"
        assert by_text["TEXT UNDER A BOX"] == "covered"
        assert by_text["PARTLY COVERED TEXT"] == "partially_covered"
        assert "Visible paragraph one." not in by_text
        assert "Visible paragraph two." not in by_text

    def test_a_recognition_layer_is_its_own_sub_class(self, scan_pdf):
        found = row(audit_hidden_information(scan_pdf), "hidden_text")
        assert [d["kind"] for d in found["detail"]] == ["ocr_layer"]

    def test_deep_text_off_reports_itself_unreadable(self, hidden_pdf):
        result = audit_hidden_information(hidden_pdf, deep_text=False)
        assert counts(result)["hidden_text"] == 0
        assert any(u["category"] == "hidden_text" for u in result["unreadable"])


class TestHiddenLayers:
    def test_the_group_and_its_content_block(self, hidden_pdf):
        found = row(audit_hidden_information(hidden_pdf), "hidden_layers")
        assert found["count"] == 1
        assert found["detail"][0]["name"] == "Draft"
        assert found["content_blocks"] == 1

    def test_hiding_a_layer_does_not_reduce_the_count(self, hidden_pdf, tmp_dir):
        from engine.layers import set_layer_visibility

        out = os.path.join(tmp_dir, "hidden-layer.pdf")
        set_layer_visibility(hidden_pdf, out, 0, False)
        assert counts(audit_hidden_information(out))["hidden_layers"] == 1


class TestPriorRevisions:
    def test_reports_the_recoverable_prefix(self, incremental_pdf):
        found = row(audit_hidden_information(incremental_pdf), "prior_revisions")
        assert found["count"] == 1
        assert found["detail"][0]["revisions"] == 2
        assert found["detail"][0]["recoverable_bytes"] > 0

    def test_the_prefix_really_is_a_readable_document(self, incremental_pdf, tmp_dir):
        from engine.extract_text import extract_text

        found = row(audit_hidden_information(incremental_pdf), "prior_revisions")
        cut = found["detail"][0]["recoverable_bytes"]
        prefix = os.path.join(tmp_dir, "revision0.pdf")
        with open(incremental_pdf, "rb") as handle:
            data = handle.read()
        with open(prefix, "wb") as handle:
            handle.write(data[:cut])
        recovered = extract_text(prefix)
        body = recovered.get("text", "") if isinstance(recovered, dict) else str(recovered)
        assert "Visible paragraph two." in body
        newest = extract_text(incremental_pdf)
        newest_body = newest.get("text", "") if isinstance(newest, dict) else str(newest)
        assert "Visible paragraph two." not in newest_body


class TestPageScope:
    def test_pages_scopes_the_report_not_the_document(self, hidden_pdf):
        result = audit_hidden_information(hidden_pdf, pages=[1])
        assert result["pages_analyzed"] == 1
        assert result["pages"] == 1


def sanitized(src: str, tmp_dir: str, categories, name="out.pdf", **kwargs) -> tuple:
    out = os.path.join(tmp_dir, name)
    result = sanitize_pdf(src, out, categories=list(categories), **kwargs)
    return out, result


def removed_counts(result) -> dict:
    return {row["id"]: row["removed"] for row in result["categories"]}


class TestSanitizeRefusals:
    def test_an_empty_selection_refuses_by_name(self, hidden_pdf, tmp_dir):
        with pytest.raises(ValueError, match="at least one category"):
            sanitized(hidden_pdf, tmp_dir, [])

    def test_an_unknown_category_lists_the_ids(self, hidden_pdf, tmp_dir):
        with pytest.raises(ValueError, match="Unknown category"):
            sanitized(hidden_pdf, tmp_dir, ["metdata"])

    def test_signatures_cannot_be_selected(self, hidden_pdf, tmp_dir):
        with pytest.raises(ValueError, match="never removed"):
            sanitized(hidden_pdf, tmp_dir, ["signatures"])

    def test_an_unreadable_category_refuses_the_whole_pass(self, hidden_pdf, tmp_dir, monkeypatch):
        import engine.sanitize as module

        def broken(*_args, **_kwargs):
            raise ValueError("the stream did not parse")

        monkeypatch.setattr(module, "analyze_page", broken)
        with pytest.raises(ValueError, match="could not read hidden_text"):
            sanitized(hidden_pdf, tmp_dir, ["metadata"])

    def test_an_xml_form_refuses_field_removal(self, hidden_pdf, tmp_dir):
        with pikepdf.open(hidden_pdf, allow_overwriting_input=True) as pdf:
            pdf.Root[Name.AcroForm][Name("/XFA")] = Array([String("x"), String("<xdp/>")])
            pdf.save(hidden_pdf)
        with pytest.raises(ValueError, match="XML form"):
            sanitized(hidden_pdf, tmp_dir, ["form_fields"])
        # Every other category is still available on the same document.
        _out, result = sanitized(hidden_pdf, tmp_dir, ["metadata"])
        assert removed_counts(result)["metadata"] > 0

    def test_an_unknown_field_mode_refuses(self, hidden_pdf, tmp_dir):
        with pytest.raises(ValueError, match="form_fields_mode"):
            sanitized(hidden_pdf, tmp_dir, ["form_fields"], form_fields_mode="bake")


def _trailer_id(path: str):
    with pikepdf.open(path) as pdf:
        ids = pdf.trailer.get("/ID")
        return [bytes(v) for v in ids] if ids is not None else None


def _page_content(path: str) -> bytes:
    with pikepdf.open(path) as pdf:
        contents = pdf.pages[0].obj["/Contents"]
        if isinstance(contents, pikepdf.Array):
            return b"".join(bytes(s.read_bytes()) for s in contents)
        return bytes(contents.read_bytes())


class TestMetadataRemoval:
    def test_every_surface_goes(self, hidden_pdf, tmp_dir):
        before_id = _trailer_id(hidden_pdf)
        out, result = sanitized(hidden_pdf, tmp_dir, ["metadata"])
        assert removed_counts(result)["metadata"] == 5
        after = audit_hidden_information(out)
        assert counts(after)["metadata"] == 0
        with pikepdf.open(out) as pdf:
            assert "/Metadata" not in pdf.Root
            assert "/PieceInfo" not in pdf.Root
            assert "/Metadata" not in pdf.pages[0].obj
            assert "/PieceInfo" not in pdf.pages[0].obj
            assert "/Info" not in pdf.trailer
        # A writer always emits a document identifier, so the pin is that the
        # one the file arrived with is no longer in it.
        assert _trailer_id(out) != before_id


class TestEmbeddedFileRemoval:
    def test_both_routes_in_one_pass(self, hidden_pdf, tmp_dir):
        out, result = sanitized(hidden_pdf, tmp_dir, ["embedded_files"])
        assert removed_counts(result)["embedded_files"] == 2
        assert counts(audit_hidden_information(out))["embedded_files"] == 0
        with pikepdf.open(out) as pdf:
            streams = sum(
                1
                for obj in pdf.objects
                if isinstance(obj, pikepdf.Stream)
                and str(obj.get("/Type", "")) == "/EmbeddedFile"
            )
        assert streams == 0


class TestCategoryIndependence:
    def test_comments_leave_the_field_and_its_value(self, hidden_pdf, tmp_dir):
        out, result = sanitized(hidden_pdf, tmp_dir, ["comments"])
        after = counts(audit_hidden_information(out))
        assert after["comments"] == 0
        assert after["form_fields"] == 1
        assert after["bookmarks"] == 1
        assert removed_counts(result)["form_fields"] == 0

    def test_fields_leave_the_comments(self, hidden_pdf, tmp_dir):
        out, _result = sanitized(hidden_pdf, tmp_dir, ["form_fields"])
        after = counts(audit_hidden_information(out))
        assert after["form_fields"] == 0
        assert after["comments"] == 3

    def test_unselected_categories_report_zero_rather_than_vanishing(self, hidden_pdf, tmp_dir):
        _out, result = sanitized(hidden_pdf, tmp_dir, ["thumbnails"])
        rows = {r["id"]: r for r in result["categories"]}
        assert set(rows) == set(counts(audit_hidden_information(hidden_pdf)))
        assert rows["thumbnails"]["selected"] is True
        assert rows["bookmarks"]["selected"] is False
        assert rows["bookmarks"]["removed"] == 0


class TestFormFieldModes:
    def test_flatten_keeps_the_look_and_drops_the_interactivity(self, hidden_pdf, tmp_dir):
        out, _result = sanitized(
            hidden_pdf, tmp_dir, ["form_fields"], form_fields_mode="flatten"
        )
        with pikepdf.open(out) as pdf:
            assert "/AcroForm" not in pdf.Root
        assert counts(audit_hidden_information(out))["form_fields"] == 0


class TestPriorRevisionRemoval:
    def test_the_collapse_is_a_full_save(self, incremental_pdf, tmp_dir):
        out, result = sanitized(incremental_pdf, tmp_dir, ["prior_revisions"])
        assert removed_counts(result)["prior_revisions"] == 1
        with open(out, "rb") as handle:
            data = handle.read()
        assert data.count(b"%%EOF") == 1
        assert counts(audit_hidden_information(out))["prior_revisions"] == 0

    def test_the_deleted_paragraph_is_gone_from_the_decompressed_stream(
        self, incremental_pdf, tmp_dir
    ):
        out, _result = sanitized(incremental_pdf, tmp_dir, ["prior_revisions"])
        # A raw byte search over the file would false-negative: streams are
        # compressed on save, so the text is not searchable in the bytes.
        assert b"Visible paragraph two" not in _page_content(out)


class TestOrphanSweep:
    def test_a_full_save_drops_what_the_trailer_cannot_reach(self, orphan_pdf, tmp_dir):
        before = counts(audit_hidden_information(orphan_pdf))["unreferenced_objects"]
        assert before > 0
        out, result = sanitized(orphan_pdf, tmp_dir, ["unreferenced_objects"])
        assert removed_counts(result)["unreferenced_objects"] == before
        assert counts(audit_hidden_information(out))["unreferenced_objects"] == 0


class TestInPlaceOutput:
    def test_output_may_be_the_input(self, hidden_pdf):
        result = sanitize_pdf(hidden_pdf, hidden_pdf, categories=["thumbnails"])
        assert result["output"] == hidden_pdf
        assert counts(audit_hidden_information(hidden_pdf))["thumbnails"] == 0
