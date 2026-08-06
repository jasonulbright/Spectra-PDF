"""Per-category byte attribution.

The identity every assertion here defends: the category rows, `overhead`
included, sum to the file size EXACTLY. It holds for a plain file, for one
whose objects live in an object stream, for a linearized file and for an
incrementally updated one, because the residual is computed by subtraction
rather than assembled from parts.

The fixtures are built at the byte level rather than reused from the shipped
corpus so each one isolates a single accounting case.
"""

import io
import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.optimize import optimize
from engine.space_audit import CATEGORY_IDS, audit_space_usage

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def row(report, category):
    for entry in report["categories"]:
        if entry["id"] == category:
            return entry
    raise AssertionError(f"no row for {category}")


def part(report, kind):
    for entry in row(report, "overhead")["detail"]:
        if entry["kind"] == kind:
            return entry["bytes"]
    raise AssertionError(f"no residual part {kind}")


def assert_accounts(report):
    """Every byte in exactly one row, and no row in deficit."""
    total = sum(entry["bytes"] for entry in report["categories"])
    assert total == report["file_size"]
    assert report["total"] == report["file_size"]
    for entry in report["categories"]:
        assert entry["bytes"] >= 0, entry["id"]
        assert 0.0 <= entry["share"] <= 1.0, entry["id"]


def _carrier(path, *, font=True, image=True, bookmark=True, attachment=True):
    pdf = pikepdf.new()
    helv = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/Helvetica"),
            Encoding=Name.WinAnsiEncoding,
        )
    )
    resources = Dictionary()
    if font:
        resources[Name.Font] = Dictionary(F1=helv)
    if image:
        pixels = pikepdf.Stream(pdf, bytes(range(256)) * 40)
        pixels[Name.Type] = Name.XObject
        pixels[Name.Subtype] = Name.Image
        pixels[Name.Width] = 80
        pixels[Name.Height] = 128
        pixels[Name.ColorSpace] = Name.DeviceGray
        pixels[Name.BitsPerComponent] = 8
        resources[Name.XObject] = Dictionary(Im0=pdf.make_indirect(pixels))
    content = b"BT /F1 12 Tf 72 720 Td (Visible paragraph.) Tj ET\n"
    if image:
        content += b"q 200 0 0 320 72 300 cm /Im0 Do Q\n"
    page = Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, 612, 792]),
        Resources=resources,
        Contents=pdf.make_stream(content),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    if bookmark:
        with pdf.open_outline() as outline:
            outline.root.append(pikepdf.OutlineItem("Chapter one", 0))
    if attachment:
        payload = pikepdf.Stream(pdf, b"attached payload bytes " * 40)
        payload[Name.Type] = Name("/EmbeddedFile")
        spec = pdf.make_indirect(
            Dictionary(
                Type=Name("/Filespec"),
                F=String("payload.txt"),
                UF=String("payload.txt"),
                EF=Dictionary(F=pdf.make_indirect(payload)),
            )
        )
        pdf.Root[Name.Names] = Dictionary(
            EmbeddedFiles=Dictionary(Names=Array([String("payload.txt"), spec]))
        )
    pdf.save(path)
    return str(path)


@pytest.fixture
def carrier(tmp_path):
    return _carrier(tmp_path / "carrier.pdf")


def test_every_byte_lands_in_exactly_one_row(carrier):
    assert_accounts(audit_space_usage(carrier))


@pytest.mark.parametrize(
    "linearize,streams",
    [
        (False, pikepdf.ObjectStreamMode.disable),
        (False, pikepdf.ObjectStreamMode.generate),
        (True, pikepdf.ObjectStreamMode.disable),
        (True, pikepdf.ObjectStreamMode.generate),
    ],
)
def test_the_identity_survives_every_storage_layout(carrier, tmp_path, linearize, streams):
    out = tmp_path / f"variant-{linearize}-{streams}.pdf"
    with pikepdf.open(carrier) as pdf:
        pdf.save(out, linearize=linearize, object_stream_mode=streams)
    assert_accounts(audit_space_usage(str(out)))


@pytest.mark.parametrize(
    "name",
    ["sample.pdf", "sample2.pdf", "form-pdflib.pdf", "scan-form.pdf"],
)
def test_the_identity_holds_on_the_shipped_corpus(name):
    assert_accounts(audit_space_usage(os.path.join(FIXTURES, name)))


def test_the_row_order_is_stable_and_complete(carrier):
    report = audit_space_usage(carrier)
    assert [entry["id"] for entry in report["categories"]] == list(CATEGORY_IDS)
    assert row(report, "overhead")["residual"] is True


def test_no_object_is_charged_twice(carrier):
    report = audit_space_usage(carrier)
    assert report["unmeasured_objects"] == 0
    charged = sum(entry["objects"] for entry in report["categories"] if entry["id"] != "overhead")
    assert charged + row(report, "overhead")["objects"] <= report["objects"]


def test_a_categorys_detail_never_claims_more_than_the_category(carrier):
    report = audit_space_usage(carrier)
    for entry in report["categories"]:
        if entry["id"] == "overhead":
            assert sum(d["bytes"] for d in entry["detail"]) == entry["bytes"]
            continue
        listed = sum(d["bytes"] for d in entry["detail"])
        if entry.get("detail_truncated"):
            assert listed <= entry["bytes"]
        else:
            assert listed == entry["bytes"], entry["id"]


def test_the_image_dominates_a_document_that_is_mostly_image(carrier):
    report = audit_space_usage(carrier)
    images = row(report, "images")
    assert images["bytes"] > 0
    assert images["bytes"] == max(entry["bytes"] for entry in report["categories"])
    assert images["knob"] == "compress"
    assert images["detail"][0]["page"] == 1
    assert images["detail"][0]["name"] == "/Im0"


def test_the_attachment_is_charged_to_embedded_files(carrier):
    report = audit_space_usage(carrier)
    assert row(report, "embedded_files")["bytes"] > 0
    assert row(report, "embedded_files")["knob"] == "sanitize_embedded_files"


def test_the_bookmarks_are_charged_to_bookmarks(carrier):
    report = audit_space_usage(carrier)
    assert row(report, "bookmarks")["bytes"] > 0


def test_the_font_is_charged_to_fonts_and_names_no_knob(carrier):
    report = audit_space_usage(carrier)
    fonts = row(report, "fonts")
    assert fonts["bytes"] > 0
    assert "knob" not in fonts


def test_a_packed_object_costs_what_the_file_spends_on_it(carrier, tmp_path):
    """An object inside an object stream is charged its share of what that
    stream occupies, never what it would take to write the object out."""
    packed_path = tmp_path / "packed.pdf"
    loose_path = tmp_path / "loose.pdf"
    with pikepdf.open(carrier) as pdf:
        pdf.save(packed_path, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    with pikepdf.open(carrier) as pdf:
        pdf.save(loose_path, object_stream_mode=pikepdf.ObjectStreamMode.disable)

    with pikepdf.open(packed_path) as pdf:
        table = pdf.get_xref_table()
        members = [og for og, entry in table.items() if entry.type == 2]
        assert members, "the fixture produced no object stream to measure"
        unparsed = sum(len(pdf.get_object(n, g).unparse(resolved=True)) for n, g in members)
        streams = {entry.obj_stream_number for entry in table.values() if entry.type == 2}
        stored = sum(len(pdf.get_object(n, 0).read_raw_bytes()) for n in streams)
    assert stored < unparsed, "the fixture's object stream did not compress"

    packed = audit_space_usage(str(packed_path))
    loose = audit_space_usage(str(loose_path))
    assert_accounts(packed)
    assert_accounts(loose)
    def charged(report):
        return sum(e["bytes"] for e in report["categories"] if e["id"] != "overhead")

    # The same objects, charged less because the file spends less on them.
    # Charging a member its unparsed length instead would push the charged
    # total past the file size and make `assert_accounts` fail on a negative
    # residual, which is what makes this pair the mutation check.
    assert charged(packed) < charged(loose)
    assert packed["file_size"] < loose["file_size"]


def _add_revision(src, dst):
    """An incremental update replacing the page content with a shorter
    stream. The original body stays present in the file's first revision."""
    from pyhanko.pdf_utils import generic
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

    writer = IncrementalPdfFileWriter(io.BytesIO(open(src, "rb").read()))
    page_ref = writer.root["/Pages"]["/Kids"][0]
    contents_ref = page_ref.get_object().raw_get("/Contents")
    writer.mark_update(contents_ref)
    writer.objects[(contents_ref.generation, contents_ref.idnum)] = generic.StreamObject(
        {}, stream_data=b"BT /F1 12 Tf 72 720 Td (Shorter.) Tj ET\n"
    )
    buf = io.BytesIO()
    writer.write(buf)
    open(dst, "wb").write(buf.getvalue())
    return str(dst)


def test_a_second_revision_is_reported_and_reclaimed(carrier, tmp_path):
    original = open(carrier, "rb").read()
    updated = _add_revision(carrier, tmp_path / "updated.pdf")
    assert open(updated, "rb").read().startswith(original)

    report = audit_space_usage(str(updated))
    assert_accounts(report)
    assert report["revisions"] == 2
    assert part(report, "superseded") > 0

    rewritten = tmp_path / "rewritten.pdf"
    optimize(str(updated), str(rewritten))
    after = audit_space_usage(str(rewritten))
    assert_accounts(after)
    assert after["revisions"] == 1
    assert part(after, "superseded") == 0


def test_an_unreachable_object_is_named_and_charged_to_nobody(tmp_path):
    """An object no reader can find still occupies the file. Our own writer
    will not emit one, so the bytes are hand-built — an unreachable object is
    a class inherited from other producers, and it belongs under the residual
    rather than inflating a content category."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
        b"<< /Note (orphaned draft data that nothing references at all) >>",
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
    orphan = tmp_path / "orphan.pdf"
    orphan.write_bytes(bytes(out))

    report = audit_space_usage(str(orphan))
    assert_accounts(report)
    assert part(report, "unreferenced") > 0
    assert row(report, "overhead")["objects"] == 1
    assert row(report, "other_objects")["bytes"] == 0


def test_an_encrypted_file_refuses_exactly_as_the_optimizer_does(tmp_path):
    locked = os.path.join(
        os.path.dirname(__file__), "..", "e2e-tests", "fixtures", "encrypted.pdf"
    )
    with pytest.raises(Exception) as audit_error:
        audit_space_usage(locked)
    with pytest.raises(Exception) as optimize_error:
        optimize(locked, str(tmp_path / "out.pdf"))
    assert type(audit_error.value) is type(optimize_error.value)
    assert str(audit_error.value) == str(optimize_error.value)


def test_a_damaged_file_refuses_exactly_as_the_optimizer_does(tmp_path):
    broken = os.path.join(
        os.path.dirname(__file__), "..", "e2e-tests", "fixtures", "malformed.pdf"
    )
    with pytest.raises(Exception) as audit_error:
        audit_space_usage(broken)
    with pytest.raises(Exception) as optimize_error:
        optimize(broken, str(tmp_path / "out.pdf"))
    assert type(audit_error.value) is type(optimize_error.value)
