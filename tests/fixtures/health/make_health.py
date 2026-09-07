"""Regenerates the document-health fixtures.

    .venv/Scripts/python.exe tests/fixtures/health/make_health.py

The PDFs are committed; this script exists so the damage in them is described
rather than only observed. Each fixture carries exactly one class of defect the
health ledger has to report:

``damaged-xref.pdf``
    A valid one-page document whose ``startxref`` offset points past the end of
    the file, so qpdf must reconstruct the cross-reference table to read it.
    Its only font is a non-embedded /Helvetica, so the same fixture proves both
    the qpdf-boundary recovery fact and the engine-boundary substitution fact.

``broken-content.pdf``
    A one-page document whose content stream is not a parseable sequence of
    operators, so the page's content will not read while everything around it
    does.

``form-hosted-image.pdf``
    A one-page document whose only damaged image is not on the page: the page
    draws a Form XObject, and the image with the undecodable filter lives in
    THAT form's resources. A traversal that reads only the page's own
    ``/XObject`` entries reports this document as clean.
"""

import io
import pathlib

import pikepdf

HERE = pathlib.Path(__file__).resolve().parent


def _one_page_with_unembedded_font() -> bytes:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name("/Helvetica"),
            Encoding=pikepdf.Name("/WinAnsiEncoding"),
        )
    )
    page.obj["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.contents_add(pikepdf.Stream(pdf, b"BT /F1 12 Tf 20 100 Td (Hello) Tj ET"))
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def _break_startxref(raw: bytes) -> bytes:
    """Point the trailing startxref offset past the end of the file."""
    marker = raw.rfind(b"startxref")
    line = raw.find(b"\n", marker)
    after = raw.find(b"\n", line + 1)
    return raw[: line + 1] + b"999999\n" + raw[after + 1 :]


def _broken_content() -> bytes:
    """A page whose content stream declares /FlateDecode over bytes that are
    not deflate data, written by hand because a library that round-trips the
    file would fix the very defect the fixture exists to carry.

    Not a malformed OPERATOR sequence: qpdf's tokenizer stops at the first
    unparseable token and reports what it read, so a bad operator is a
    truncation the reader recovers from rather than a stream that will not
    read. What the ledger has to report is the second thing.
    """
    junk = b"this is not deflate data"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
        b"/Resources << >> /Contents 4 0 R >>",
        b"<< /Length "
        + str(len(junk)).encode()
        + b" /Filter /FlateDecode >>\nstream\n"
        + junk
        + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(objects) + 1)
    out += b"startxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


def _form_hosted_image() -> bytes:
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    image = pdf.make_stream(b"these bytes decode under no filter")
    image["/Type"] = pikepdf.Name.XObject
    image["/Subtype"] = pikepdf.Name.Image
    image["/Width"] = 8
    image["/Height"] = 8
    image["/ColorSpace"] = pikepdf.Name.DeviceGray
    image["/BitsPerComponent"] = 8
    image["/Filter"] = pikepdf.Name("/NoSuchDecode")
    form = pdf.make_stream(b"q 8 0 0 8 0 0 cm /Im0 Do Q")
    form["/Type"] = pikepdf.Name.XObject
    form["/Subtype"] = pikepdf.Name.Form
    form["/BBox"] = pikepdf.Array([0, 0, 8, 8])
    form["/Resources"] = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
    )
    page.obj["/Resources"] = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form))
    )
    page.contents_add(pikepdf.Stream(pdf, b"q 100 0 0 100 50 50 cm /Fm0 Do Q"))
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def main() -> None:
    (HERE / "damaged-xref.pdf").write_bytes(
        _break_startxref(_one_page_with_unembedded_font())
    )
    (HERE / "broken-content.pdf").write_bytes(_broken_content())
    (HERE / "form-hosted-image.pdf").write_bytes(_form_hosted_image())


if __name__ == "__main__":
    main()
