"""One bounded XFA resource reading, two questions.

Every faithful control here is built the way ISO 32000-2 Annex K.2's own
example builds a resource — an array whose first and last packets carry the
`xdp:xdp` begin and end tags and whose middle packets are complete elements —
and its single-stream equivalent. The assertions are that the two spellings
answer identically, that every malformed spelling is refused by NAME, and that
the caller's own byte and item accounting is charged and honoured.

These controls exercise the production engine module.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import pikepdf  # noqa: E402
from lxml import etree  # noqa: E402

import engine  # noqa: E402,F401  (the package must exist before the submodule)

from engine import xfa


XDP_OPEN = b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'
XDP_CLOSE = b"</xdp:xdp>"
TEMPLATE_NS = "http://www.xfa.org/schema/xfa-template/3.3/"
DATASETS = (
    b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">'
    b"<xfa:data><note/></xfa:data></xfa:datasets>"
)
CONFIG = b'<config xmlns="http://www.xfa.org/schema/xci/1.0/"><present/></config>'


def template(*, logic: str = "", prefix: str = "") -> bytes:
    """A template packet. `prefix` spells every element with that prefix, which
    is the author's choice and not a different document."""
    p = f"{prefix}:" if prefix else ""
    ns = f"xmlns:{prefix}" if prefix else "xmlns"
    body = ""
    if logic:
        body = (
            f"<{p}{logic}><{p}script contentType=\"application/x-formcalc\">"
            f"1 + 1</{p}script></{p}{logic}>"
        )
    return (
        f'<{p}template {ns}="{TEMPLATE_NS}">'
        f'<{p}subform name="form"><{p}field name="note">{body}</{p}field>'
        f"</{p}subform></{p}template>"
    ).encode()


def as_utf16(entry_parts, *, per_part_bom: bool = False):
    """The same packets in UTF-16.

    A faithful producer writes the byte-order mark once, at the front of the
    resource, and the remaining fragments in that same byte order. Giving every
    fragment its own mark produces bytes that no longer concatenate into one
    document, which is what `per_part_bom` builds for the refusal control.
    """
    out = []
    for index, (name, data) in enumerate(entry_parts):
        codec = "utf-16" if (per_part_bom or index == 0) else "utf-16-le"
        out.append((name, data.decode("utf-8").encode(codec)))
    return out


def document(entry_parts, *, split: bool, dynamic: bool = False, fields: bool = True,
             encoding: str = "utf-8", field_count: int = 1):
    """A document whose `/XFA` is `entry_parts` in either spelling.

    `entry_parts` is a list of (name, bytes). The single spelling concatenates
    the middle packets inside one wrapper; the split spelling writes the
    wrapper fragments as their own packets, which is what Annex K.2 permits.
    """
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    if encoding != "utf-8":
        entry_parts = as_utf16(entry_parts)
    if split:
        slots = []
        for name, data in entry_parts:
            slots.append(pikepdf.String(name))
            slots.append(pdf.make_stream(data))
        entry = pikepdf.Array(slots)
    else:
        entry = pdf.make_stream(b"".join(data for _name, data in entry_parts))
    acro = {"XFA": entry}
    if fields:
        acro["Fields"] = pikepdf.Array([
            pdf.make_indirect(
                pikepdf.Dictionary(FT=pikepdf.Name.Tx, T=f"note{i}", V="")
            )
            for i in range(field_count)
        ])
    pdf.Root.AcroForm = pikepdf.Dictionary(**acro)
    pdf.Root.NeedsRendering = dynamic
    return pdf


def wrapped(*middles):
    """Annex K.2's packet sequence: begin tag, complete elements, end tag."""
    return [("xdp:xdp", XDP_OPEN), *middles, ("/xdp:xdp", XDP_CLOSE)]


def result(pdf, **kwargs):
    found = xfa.inspect(pdf, **kwargs)
    return {"class": found.form_class, "shape": found.shape}


# ── faithful resources: the two spellings answer identically ──────────────


@pytest.mark.parametrize("dynamic", [False, True])
@pytest.mark.parametrize(
    "middles",
    [
        pytest.param([("template", template())], id="template-only"),
        pytest.param(
            [("template", template()), ("datasets", DATASETS)], id="template-datasets"
        ),
        pytest.param(
            [("template", template()), ("datasets", DATASETS), ("config", CONFIG)],
            id="annex-example",
        ),
    ],
)
def test_split_and_single_classify_identically(middles, dynamic):
    parts = wrapped(*middles)
    single = result(document(parts, split=False, dynamic=dynamic))
    split = result(document(parts, split=True, dynamic=dynamic))
    expected = "dynamic" if dynamic else "static"
    assert single == {"class": expected, "shape": ""}
    assert split == single


def test_split_without_a_field_shadow_is_dynamic_like_the_single_form():
    parts = wrapped(("template", template()))
    single = result(document(parts, split=False, fields=False))
    split = result(document(parts, split=True, fields=False))
    assert single == {"class": "dynamic", "shape": ""}
    assert split == single


def test_one_packet_naming_the_whole_element_reads():
    whole = XDP_OPEN + template() + XDP_CLOSE
    pdf = document([("xdp:xdp", whole)], split=True)
    assert result(pdf) == {"class": "static", "shape": ""}


def test_a_local_wrapper_name_is_accepted_like_the_qualified_one():
    # Annex K.2's example names a prefixed element by its local name
    # (`datasets` for `xfa:datasets`), so both spellings name the element.
    parts = [("xdp", XDP_OPEN), ("template", template()), ("/xdp", XDP_CLOSE)]
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}


def test_a_prefixed_datasets_element_may_be_named_locally():
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}


def test_a_prefixed_datasets_element_may_be_named_qualified():
    parts = wrapped(("template", template()), ("xfa:datasets", DATASETS))
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}


def test_utf16_single_stream_reads():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=False, encoding="utf-16")
    assert result(pdf) == {"class": "static", "shape": ""}


def test_an_xml_declaration_on_the_whole_resource_reads():
    declared = b'<?xml version="1.0" encoding="UTF-8"?>'
    parts = [("xdp:xdp", declared + XDP_OPEN), ("template", template()),
             ("/xdp:xdp", XDP_CLOSE)]
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}


# ── malformed declarations, each refused by name ──────────────────────────


def test_a_non_stream_non_array_xfa_is_refused():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Dictionary(XFA=42)
    assert result(pdf)["shape"] == xfa.SHAPE_XFA_TYPE


@pytest.mark.parametrize(
    "slots",
    [
        pytest.param([], id="empty"),
        pytest.param(["xdp:xdp"], id="one-slot"),
        pytest.param(["xdp:xdp", None, "template"], id="three-slots"),
    ],
)
def test_an_array_that_is_not_pairs_is_refused(slots):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    built = []
    for slot in slots:
        built.append(
            pdf.make_stream(XDP_OPEN) if slot is None else pikepdf.String(slot)
        )
    pdf.Root.AcroForm = pikepdf.Dictionary(XFA=pikepdf.Array(built))
    assert result(pdf)["shape"] == xfa.SHAPE_XFA_ARRAY_LENGTH


def test_a_name_slot_that_is_not_a_string_is_refused():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Dictionary(
        XFA=pikepdf.Array([pikepdf.Name.Template, pdf.make_stream(XDP_OPEN)])
    )
    assert result(pdf)["shape"] == xfa.SHAPE_PACKET_NAME_TYPE


def test_a_packet_slot_that_is_not_a_stream_is_refused():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Dictionary(
        XFA=pikepdf.Array([pikepdf.String("xdp:xdp"), pikepdf.String("not a stream")])
    )
    assert result(pdf)["shape"] == xfa.SHAPE_PACKET_STREAM_TYPE


@pytest.mark.parametrize("split", [False, True])
def test_invalid_xml_is_refused(split):
    parts = wrapped(("template", b"<template><unclosed></template>"))
    assert result(document(parts, split=split))["shape"] == xfa.SHAPE_PACKET_XML


@pytest.mark.parametrize("split", [False, True])
def test_a_document_type_declaration_is_refused(split):
    doctype = b'<!DOCTYPE xdp:xdp [<!ENTITY x "y">]>'
    parts = [("xdp:xdp", doctype + XDP_OPEN), ("template", template()),
             ("/xdp:xdp", XDP_CLOSE)]
    assert result(document(parts, split=split))["shape"] == xfa.SHAPE_PACKET_XML


@pytest.mark.parametrize("split", [False, True])
def test_an_undefined_entity_reference_is_refused(split):
    parts = wrapped(("template", b"<template>&secret;</template>"))
    assert result(document(parts, split=split))["shape"] == xfa.SHAPE_PACKET_XML


@pytest.mark.parametrize("split", [False, True])
def test_an_external_entity_declaration_is_refused(split):
    doctype = b'<!DOCTYPE xdp:xdp [<!ENTITY ext SYSTEM "file:///etc/passwd">]>'
    parts = [("xdp:xdp", doctype + XDP_OPEN), ("template", b"<template>&ext;</template>"),
             ("/xdp:xdp", XDP_CLOSE)]
    assert result(document(parts, split=split))["shape"] == xfa.SHAPE_PACKET_XML


@pytest.mark.parametrize("split", [False, True])
def test_a_false_xdp_namespace_is_refused(split):
    # The local name alone is any producer's `xdp` in any namespace.
    fake_open = b'<xdp:xdp xmlns:xdp="http://ns.example.invalid/xdp/">'
    parts = [("xdp:xdp", fake_open), ("template", template()),
             ("/xdp:xdp", XDP_CLOSE)]
    assert result(document(parts, split=split))["shape"] == xfa.SHAPE_XDP_ROOT


def test_a_single_stream_whose_root_is_not_the_xdp_element_is_refused():
    # A single stream is the WHOLE resource, and the whole resource is one
    # `xdp:xdp` element; a bare template stream is not that.
    parts = [("template", template())]
    assert result(document(parts, split=False))["shape"] == xfa.SHAPE_XDP_ROOT


# ── bare packet lists: complete elements with no wrapper fragments ─────────


@pytest.mark.parametrize("dynamic", [False, True])
def test_a_bare_packet_list_classifies_like_its_bracketed_form(dynamic):
    # The array carries only whole elements — no `xdp:xdp` begin/end packets
    # at all. Annex K.2's example brackets the packets; files without the
    # brackets exist and the reader before this one accepted them, so they
    # are read inside the standard wrapper on the same terms.
    middles = [("template", template()), ("datasets", DATASETS), ("config", CONFIG)]
    bare = result(document(middles, split=True, dynamic=dynamic))
    bracketed = result(document(wrapped(*middles), split=True, dynamic=dynamic))
    assert bare == bracketed == {"class": "dynamic" if dynamic else "static", "shape": ""}


def test_a_bare_packet_list_of_one_whole_element_reads():
    assert result(document([("template", template())], split=True)) == {"class": "static", "shape": ""}


def test_authored_logic_is_found_in_a_bare_packet_list():
    parts = [("template", template(logic="calculate", prefix="form")), ("datasets", DATASETS)]
    assert xfa.has_authored_logic(document(parts, split=True)) is True
    assert xfa.has_authored_logic(document([("template", template())], split=True)) is False


def test_the_actual_end_to_end_xfa_fixtures_read_with_their_authored_logic():
    # The shipped e2e fixtures are exactly this shape: template, datasets and
    # two never-read packets, no wrapper fragments. Bound here so the engine
    # contract and the live spec cannot drift apart again.
    from engine.forms import read_form_fields
    root = Path(__file__).resolve().parents[1] / "e2e-tests" / "fixtures"
    for name, kind in (("xfa-static.pdf", "static"), ("xfa-dynamic.pdf", "dynamic")):
        fixture = root / name
        if not fixture.is_file():
            pytest.fail(f"missing e2e fixture {name}; run e2e-tests/fixtures/make-xfa-fixtures.py")
        reply = read_form_fields(str(fixture))
        assert reply["xfa"] == kind
        assert reply["xfa_calculations"] is True
        with pikepdf.open(fixture) as pdf:
            found = xfa.inspect(pdf)
            assert (found.form_class, found.shape) == (kind, "")


def test_a_bare_list_still_refuses_a_fragment_packet():
    # The first packet is a begin tag, not a whole element, and no wrapper
    # packet closes it: neither a bracketed list nor a bare one.
    parts = [("template", b'<template xmlns="' + TEMPLATE_NS.encode() + b'">'), ("datasets", DATASETS)]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_XML


def test_a_bare_list_still_refuses_a_packet_that_leans_on_an_undeclared_prefix():
    # Bracketed, this packet inherits the wrapper's `xdp:` prefix and reads;
    # bare, no packet declares it, so it is a fragment and refused as one.
    parts = [("xdp:template", b"<xdp:template><xdp:subform/></xdp:template>")]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_XML


def test_a_bare_list_still_refuses_two_elements_in_one_packet():
    # Two elements in the FIRST packet: it does not parse alone, so the list
    # is not bare, and without wrapper fragments the concatenation is not one
    # document either. In a LATER packet the list is bare; the resource then
    # holds one more element child than declared names, which the name/count
    # check refuses before the per-packet boundary check is reached.
    first = [("template", template() + CONFIG), ("datasets", DATASETS)]
    assert result(document(first, split=True))["shape"] == xfa.SHAPE_PACKET_XML
    later = [("template", template()), ("datasets", DATASETS + CONFIG)]
    assert result(document(later, split=True))["shape"] == xfa.SHAPE_PACKET_NAME_MISMATCH


def test_a_bare_list_still_refuses_a_document_type_declaration():
    doctype = b'<!DOCTYPE template [<!ENTITY x "y">]>'
    parts = [("template", doctype + template()), ("datasets", DATASETS)]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_XML


def test_a_middle_packet_name_that_does_not_name_its_element_is_refused():
    parts = wrapped(("config", template()))
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_NAME_MISMATCH


def test_a_middle_packet_split_across_two_streams_is_refused():
    # Annex K.2's exception is the FIRST and LAST packet only; a middle packet
    # is a complete element.
    parts = [
        ("xdp:xdp", XDP_OPEN),
        ("template", b'<template xmlns="' + TEMPLATE_NS.encode() + b'">'),
        ("template", b"</template>"),
        ("/xdp:xdp", XDP_CLOSE),
    ]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_NAME_MISMATCH


def test_an_undeclared_extra_element_is_refused():
    parts = [
        ("xdp:xdp", XDP_OPEN),
        ("template", template() + CONFIG),
        ("/xdp:xdp", XDP_CLOSE),
    ]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_NAME_MISMATCH


def test_a_closing_fragment_that_does_not_close_the_wrapper_is_refused():
    parts = [("xdp:xdp", XDP_OPEN), ("template", template()),
             ("/config", XDP_CLOSE)]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_NAME_MISMATCH


def test_reversed_wrapper_fragments_are_refused():
    parts = [("/xdp:xdp", XDP_CLOSE), ("template", template()),
             ("xdp:xdp", XDP_OPEN)]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_XML


def test_a_missing_closing_fragment_is_refused():
    parts = [("xdp:xdp", XDP_OPEN), ("template", template())]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_XML


def test_a_stream_that_will_not_read_is_refused():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True)

    def refuse(_stream):
        raise RuntimeError("filter chain")

    assert result(pdf, read_stream=refuse)["shape"] == xfa.SHAPE_PACKET_UNREADABLE


def test_a_reader_returning_something_other_than_bytes_is_refused():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True)
    assert result(pdf, read_stream=lambda _s: "text")["shape"] == xfa.SHAPE_PACKET_UNREADABLE


# ── the other typed values the classification rests on ────────────────────


def test_an_acroform_of_the_wrong_type_is_refused():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Array([])
    assert result(pdf)["shape"] == xfa.SHAPE_ACROFORM_TYPE


def test_no_acroform_is_no_form():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    assert result(pdf) == {"class": "none", "shape": ""}


def test_an_acroform_with_no_xfa_is_no_form():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([]))
    assert result(pdf) == {"class": "none", "shape": ""}


def test_a_mistyped_needs_rendering_is_refused_not_coerced():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True)
    pdf.Root.NeedsRendering = pikepdf.String("false")
    assert result(pdf)["shape"] == xfa.SHAPE_NEEDS_RENDERING_TYPE


def test_mistyped_fields_are_refused():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, fields=False)
    pdf.Root.AcroForm.Fields = pikepdf.String("two")
    assert result(pdf)["shape"] == xfa.SHAPE_FIELDS_TYPE


def test_a_direct_field_entry_is_refused():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, fields=False)
    pdf.Root.AcroForm.Fields = pikepdf.Array(
        [pikepdf.Dictionary(FT=pikepdf.Name.Tx, T="note")]
    )
    assert result(pdf)["shape"] == xfa.SHAPE_FIELD_ENTRY_REFERENCE


# ── the caller's own accounting ───────────────────────────────────────────


@pytest.mark.parametrize("split", [False, True])
def test_an_interrupted_item_charge_propagates(split):
    parts = wrapped(("template", template()))
    pdf = document(parts, split=split)

    def spent():
        raise xfa.InspectionInterrupted()

    with pytest.raises(xfa.InspectionInterrupted):
        xfa.inspect(pdf, take_item=spent)


@pytest.mark.parametrize("split", [False, True])
def test_an_interrupted_stream_read_propagates(split):
    parts = wrapped(("template", template()))
    pdf = document(parts, split=split)

    def spent(_stream):
        raise xfa.InspectionInterrupted()

    with pytest.raises(xfa.InspectionInterrupted):
        xfa.inspect(pdf, read_stream=spent)


def test_every_packet_is_charged_once_as_an_item_and_read_once():
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    items = []
    reads = []

    def charge():
        items.append(1)

    def read(stream):
        reads.append(stream)
        return stream.read_bytes()

    assert result(pdf, read_stream=read, take_item=charge)["shape"] == ""
    # Four packets: the two wrapper fragments and the two complete elements.
    # One item and one read each, plus the field entry's own item charge.
    assert len(reads) == 4
    assert len(items) == 5


def test_the_single_stream_spelling_charges_one_item_and_one_read():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=False)
    items = []
    reads = []
    assert result(
        pdf,
        read_stream=lambda s: (reads.append(s), s.read_bytes())[1],
        take_item=lambda: items.append(1),
    )["shape"] == ""
    assert len(reads) == 1
    assert len(items) == 2


def test_the_byte_ceiling_is_cumulative_not_per_packet(monkeypatch):
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    sizes = [len(data) for _name, data in parts]
    # Every packet fits under the ceiling on its own; together they do not.
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_BYTES", max(sizes))
    assert result(pdf)["shape"] == xfa.SHAPE_RESOURCE_BYTES


def test_a_resource_exactly_at_the_ceiling_reads(monkeypatch):
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    total = sum(len(data) for _name, data in parts)
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_BYTES", total)
    assert result(pdf) == {"class": "static", "shape": ""}


def test_one_byte_over_the_ceiling_is_refused(monkeypatch):
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    total = sum(len(data) for _name, data in parts)
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_BYTES", total - 1)
    assert result(pdf)["shape"] == xfa.SHAPE_RESOURCE_BYTES


def test_an_oversized_single_stream_is_refused(monkeypatch):
    parts = wrapped(("template", template()))
    pdf = document(parts, split=False)
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_BYTES", 8)
    assert result(pdf)["shape"] == xfa.SHAPE_RESOURCE_BYTES


# ── authored logic: one answer per resource, however it is spelled ────────


@pytest.mark.parametrize("split", [False, True])
@pytest.mark.parametrize("logic", ["calculate", "validate"])
@pytest.mark.parametrize("prefix", ["", "form"])
def test_authored_logic_is_found_by_element_identity(split, logic, prefix):
    parts = wrapped(("template", template(logic=logic, prefix=prefix)))
    assert xfa.has_authored_logic(document(parts, split=split)) is True


@pytest.mark.parametrize("split", [False, True])
def test_no_authored_logic_is_a_proven_false(split):
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    assert xfa.has_authored_logic(document(parts, split=split)) is False


def test_authored_logic_in_utf16_is_found():
    parts = wrapped(("template", template(logic="calculate")))
    pdf = document(parts, split=False, encoding="utf-16")
    assert xfa.has_authored_logic(pdf) is True


def test_authored_logic_in_a_prefixed_utf16_resource_is_found():
    parts = wrapped(("template", template(logic="calculate", prefix="form")))
    pdf = document(parts, split=False, encoding="utf-16")
    assert xfa.has_authored_logic(pdf) is True


def test_the_two_spellings_agree_about_authored_logic():
    parts = wrapped(("template", template(logic="calculate", prefix="form")))
    assert xfa.has_authored_logic(document(parts, split=False)) is (
        xfa.has_authored_logic(document(parts, split=True))
    )


def test_a_calculate_element_in_an_unrelated_namespace_is_not_authored_logic():
    other = (
        b'<note xmlns="http://ns.example.invalid/other/">'
        b"<calculate>not a template</calculate></note>"
    )
    parts = wrapped(("template", template()), ("note", other))
    assert xfa.has_authored_logic(document(parts, split=True)) is False


def test_a_calculate_element_in_no_namespace_is_not_authored_logic():
    parts = wrapped(("template", template()),
                    ("note", b"<note><calculate/></note>"))
    assert xfa.has_authored_logic(document(parts, split=True)) is False


def test_an_older_template_namespace_version_still_counts():
    older = (
        b'<template xmlns="http://www.xfa.org/schema/xfa-template/2.4/">'
        b"<subform><field><calculate/></field></subform></template>"
    )
    parts = wrapped(("template", older))
    assert xfa.has_authored_logic(document(parts, split=True)) is True


def test_no_xfa_is_no_authored_logic():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    assert xfa.has_authored_logic(pdf) is False


@pytest.mark.parametrize(
    "parts,shape",
    [
        pytest.param(
            [("xdp:xdp", XDP_OPEN), ("template", b"<template><oops></template>"),
             ("/xdp:xdp", XDP_CLOSE)],
            "xfa-packet-xml",
            id="invalid-xml",
        ),
        pytest.param(
            [("xdp:xdp", b'<xdp:xdp xmlns:xdp="http://ns.example.invalid/">'),
             ("template", b"<template/>"), ("/xdp:xdp", XDP_CLOSE)],
            "xfa-xdp-root",
            id="false-namespace",
        ),
        pytest.param(
            [("xdp:xdp", XDP_OPEN), ("config", template()), ("/xdp:xdp", XDP_CLOSE)],
            "xfa-packet-name-mismatch",
            id="name-mismatch",
        ),
    ],
)
def test_unreadable_authored_logic_is_named_not_false(parts, shape):
    pdf = document(parts, split=True)
    with pytest.raises(xfa.AuthoredLogicUnreadable) as caught:
        xfa.has_authored_logic(pdf)
    assert caught.value.args == (shape,)


def test_authored_logic_honours_the_caller_accounting():
    parts = wrapped(("template", template(logic="calculate")))
    pdf = document(parts, split=True)

    def spent():
        raise xfa.InspectionInterrupted()

    with pytest.raises(xfa.InspectionInterrupted):
        xfa.has_authored_logic(pdf, take_item=spent)

    reads = []

    def read(stream):
        reads.append(stream)
        return stream.read_bytes()

    assert xfa.has_authored_logic(pdf, read_stream=read) is True
    assert len(reads) == 3


# ── the lenient readers are unchanged ─────────────────────────────────────


def test_lenient_classify_still_answers_for_both_spellings():
    parts = wrapped(("template", template()))
    assert xfa.classify(document(parts, split=False)) == "static"
    assert xfa.classify(document(parts, split=True)) == "static"


def test_lenient_classify_ignores_a_malformed_packet():
    # The lenient reading answers "is there a packet source to read?", and a
    # malformed resource still has one. Unchanged from production on purpose.
    parts = wrapped(("template", b"<template><unclosed></template>"))
    assert xfa.classify(document(parts, split=True)) == "static"


def test_lenient_xfa_entry_refuses_only_a_wrong_typed_value():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Dictionary(XFA=42)
    assert xfa.xfa_entry(pdf) is None


def test_packets_still_returns_the_declared_pairs_in_order():
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    names = [name for name, _stream in xfa.packets(xfa.xfa_entry(pdf))]
    assert names == ["xdp:xdp", "template", "datasets", "/xdp:xdp"]


def test_datasets_stream_still_selects_by_name():
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    stream = xfa.datasets_stream(pdf)
    assert stream is not None
    assert stream.read_bytes() == DATASETS


def test_datasets_stream_falls_back_to_the_whole_single_stream():
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=False)
    stream = xfa.datasets_stream(pdf)
    assert stream is not None
    assert DATASETS in stream.read_bytes()


def test_never_read_packets_are_still_declared_but_not_selected():
    assert xfa.NEVER_READ == ("connectionSet", "sourceSet")


def test_an_external_doctype_is_refused_without_being_fetched():
    # The refusal comes from parsed metadata with the DTD never loaded and the
    # network disabled, so a resource naming an external grammar is refused
    # rather than resolved. A fetch would surface here as a different failure.
    doctype = b'<!DOCTYPE xdp:xdp SYSTEM "http://ns.example.invalid/x.dtd">'
    with pytest.raises(xfa._PacketShapeError):
        xfa._resource_root(doctype + XDP_OPEN + template() + XDP_CLOSE)


# ── hole 1: packet boundaries must be exact, not recovered after the fact ──


def split_across_slots():
    """The attack: two correctly NAMED whole children after concatenation,
    where neither middle packet is a whole element on its own. The template
    slot holds only an opening tag; the datasets slot closes it and then
    carries a complete datasets element."""
    return [
        ("xdp:xdp", XDP_OPEN),
        ("template", b'<template xmlns="' + TEMPLATE_NS.encode() + b'">'),
        ("datasets", b"</template>" + DATASETS),
        ("/xdp:xdp", XDP_CLOSE),
    ]


def test_a_packet_that_is_not_one_whole_element_is_refused():
    pdf = document(split_across_slots(), split=True)
    assert result(pdf)["shape"] == xfa.SHAPE_PACKET_BOUNDARY


@pytest.mark.parametrize('opening_fragment', [False, True])
def test_wrapper_fragments_cannot_contain_part_of_a_middle_element(opening_fragment):
    start = b'<template xmlns="' + TEMPLATE_NS.encode() + b'">'
    parts = [('xdp:xdp', XDP_OPEN + (start if opening_fragment else b'')),
             ('template', b'</template>' if opening_fragment else start),
             ('/xdp:xdp', (b'' if opening_fragment else b'</template>') + XDP_CLOSE)]
    assert result(document(parts, split=True))['shape'] == xfa.SHAPE_PACKET_BOUNDARY


def test_a_packet_boundary_violation_is_refused_in_utf16_too():
    pdf = document(split_across_slots(), split=True, encoding="utf-16")
    assert result(pdf)["shape"] == xfa.SHAPE_PACKET_BOUNDARY


def test_a_faithful_utf16_split_resource_reads():
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True, encoding="utf-16")
    assert result(pdf) == {"class": "static", "shape": ""}


def test_a_utf16_split_resource_with_a_mark_on_every_fragment_is_refused():
    # The stray marks decode to characters sitting beside the element, so the
    # concatenation is well-formed XML whose PACKETS are not whole elements.
    parts = as_utf16(wrapped(("template", template())), per_part_bom=True)
    pdf = document(parts, split=True)
    assert result(pdf)["shape"] == xfa.SHAPE_PACKET_BOUNDARY


def test_a_packet_using_a_prefix_the_wrapper_declares_reads():
    # The middle packet is validated in the wrapper's namespace context, so a
    # packet that inherits the wrapper's prefix is a complete element there
    # even though it would not parse alone.
    parts = [
        ("xdp:xdp", XDP_OPEN),
        ("xdp:template", b"<xdp:template><xdp:subform/></xdp:template>"),
        ("/xdp:xdp", XDP_CLOSE),
    ]
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}


def test_a_packet_carrying_two_elements_is_refused_with_the_counts_matching():
    # The case the name and count check CANNOT catch: two declared middles and
    # two element children, correctly named in order — because the first
    # packet holds both elements and the second holds nothing. Only a
    # per-packet boundary check distinguishes this from a faithful resource.
    parts = [
        ("xdp:xdp", XDP_OPEN),
        ("template", template() + CONFIG),
        ("config", b""),
        ("/xdp:xdp", XDP_CLOSE),
    ]
    found = result(document(parts, split=True))
    assert found["shape"] == xfa.SHAPE_PACKET_BOUNDARY
    # The name check passes on this resource, which is why the boundary check
    # has to exist: it is reached only because the names line up.
    assert xfa._packet_names_match(
        xfa._resource_root(b"".join(data for _name, data in parts)),
        tuple(name for name, _data in parts),
    ) is True


def test_a_packet_carrying_stray_text_is_refused():
    parts = wrapped(("template", b"stray" + template()))
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_BOUNDARY


def test_a_packet_carrying_only_whitespace_around_its_element_reads():
    parts = wrapped(("template", b"\n  " + template() + b"\n"))
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}


# ── hole 2: presence and unreadability need a strict entrance ──────────────


@pytest.mark.parametrize(
    "acroform,shape",
    [
        pytest.param(pikepdf.Dictionary(XFA=42), "xfa-type", id="xfa-number"),
        pytest.param(
            pikepdf.Dictionary(XFA=pikepdf.Name.Template), "xfa-type", id="xfa-name"
        ),
        pytest.param(pikepdf.Array([]), "acroform-type", id="acroform-array"),
        pytest.param(pikepdf.String("form"), "acroform-type", id="acroform-string"),
    ],
)
def test_authored_logic_refuses_an_unreadable_declaration(acroform, shape):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = acroform
    with pytest.raises(xfa.AuthoredLogicUnreadable) as caught:
        xfa.has_authored_logic(pdf)
    assert caught.value.args == (shape,)


def test_authored_logic_refuses_an_odd_packet_array():
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page()
    pdf.Root.AcroForm = pikepdf.Dictionary(
        XFA=pikepdf.Array([pikepdf.String("xdp:xdp")])
    )
    with pytest.raises(xfa.AuthoredLogicUnreadable) as caught:
        xfa.has_authored_logic(pdf)
    assert caught.value.args == (xfa.SHAPE_XFA_ARRAY_LENGTH,)


def test_authored_logic_is_false_only_for_a_document_with_no_form():
    bare = pikepdf.Pdf.new()
    bare.add_blank_page()
    assert xfa.has_authored_logic(bare) is False
    empty = pikepdf.Pdf.new()
    empty.add_blank_page()
    empty.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([]))
    assert xfa.has_authored_logic(empty) is False


def test_authored_logic_refuses_a_packet_boundary_violation():
    pdf = document(split_across_slots(), split=True)
    with pytest.raises(xfa.AuthoredLogicUnreadable) as caught:
        xfa.has_authored_logic(pdf)
    assert caught.value.args == (xfa.SHAPE_PACKET_BOUNDARY,)


# ── hole 3: ceilings on counts, not only on decoded bytes ─────────────────


def test_many_zero_byte_packets_are_refused_by_count(monkeypatch):
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_PACKETS", 4)
    parts = [("xdp:xdp", XDP_OPEN), *[("filler", b"")] * 8, ("/xdp:xdp", XDP_CLOSE)]
    pdf = document(parts, split=True)
    reads = []

    def read(stream):
        reads.append(stream)
        return stream.read_bytes()

    assert result(pdf, read_stream=read)["shape"] == xfa.SHAPE_RESOURCE_PACKETS
    # Refused at the ceiling, not after reading every packet.
    assert len(reads) <= 4


def test_packet_name_bytes_are_bounded(monkeypatch):
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_NAME_BYTES", 32)
    parts = [
        ("xdp:xdp", XDP_OPEN),
        ("t" * 64, template()),
        ("/xdp:xdp", XDP_CLOSE),
    ]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_RESOURCE_NAMES


@pytest.mark.parametrize("split", [False, True])
def test_xml_elements_are_bounded(monkeypatch, split):
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_ELEMENTS", 8)
    filler = b"".join(b"<field/>" for _ in range(64))
    inner = (
        b'<template xmlns="' + TEMPLATE_NS.encode() + b'"><subform>'
        + filler
        + b"</subform></template>"
    )
    parts = wrapped(("template", inner))
    assert result(document(parts, split=split))["shape"] == xfa.SHAPE_RESOURCE_ELEMENTS


def test_field_entries_are_bounded_without_a_caller_charge(monkeypatch):
    monkeypatch.setattr(xfa, "_MAX_FIELD_ITEMS", 4)
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, field_count=16)
    assert result(pdf)["shape"] == xfa.SHAPE_FIELDS_COUNT


def test_the_caller_charge_still_interrupts_before_a_ceiling(monkeypatch):
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_PACKETS", 2)
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)

    def spent():
        raise xfa.InspectionInterrupted()

    with pytest.raises(xfa.InspectionInterrupted):
        xfa.inspect(pdf, take_item=spent)


def test_authored_logic_reports_a_ceiling_as_unreadable(monkeypatch):
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_PACKETS", 2)
    parts = wrapped(("template", template()), ("datasets", DATASETS))
    pdf = document(parts, split=True)
    with pytest.raises(xfa.AuthoredLogicUnreadable) as caught:
        xfa.has_authored_logic(pdf)
    assert caught.value.args == (xfa.SHAPE_RESOURCE_PACKETS,)


def test_the_default_ceilings_admit_an_ordinary_resource():
    parts = wrapped(("template", template()), ("datasets", DATASETS), ("config", CONFIG))
    assert result(document(parts, split=True)) == {"class": "static", "shape": ""}
    assert xfa._MAX_RESOURCE_PACKETS >= 5
    assert xfa._MAX_RESOURCE_ELEMENTS >= 10000


# ── NeedsRendering beside a malformed /Fields ─────────────────────────────


def test_a_malformed_fields_array_is_refused_even_when_rendering_is_true():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, fields=False, dynamic=True)
    pdf.Root.AcroForm.Fields = pikepdf.String("two")
    assert result(pdf)["shape"] == xfa.SHAPE_FIELDS_TYPE


def test_a_direct_field_entry_is_refused_even_when_rendering_is_true():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, fields=False, dynamic=True)
    pdf.Root.AcroForm.Fields = pikepdf.Array(
        [pikepdf.Dictionary(FT=pikepdf.Name.Tx, T="note")]
    )
    assert result(pdf)["shape"] == xfa.SHAPE_FIELD_ENTRY_REFERENCE


def test_rendering_true_with_a_well_formed_fields_array_is_dynamic():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, dynamic=True)
    assert result(pdf) == {"class": "dynamic", "shape": ""}


def test_rendering_true_with_no_fields_key_is_dynamic():
    parts = wrapped(("template", template()))
    pdf = document(parts, split=True, fields=False, dynamic=True)
    assert result(pdf) == {"class": "dynamic", "shape": ""}


@pytest.mark.parametrize("extra", [b'<!--note-->stray', b'<?note value?>stray'])
def test_packet_text_cannot_hide_after_comment_or_processing_instruction(extra):
    parts = wrapped(("template", extra + template()))
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_BOUNDARY


@pytest.mark.parametrize("extra", [b'<!--note-->stray', b'<?note value?>stray'])
def test_wrapper_text_cannot_hide_after_comment_or_processing_instruction(extra):
    parts = [("xdp:xdp", XDP_OPEN + extra), ("template", template()),
             ("/xdp:xdp", XDP_CLOSE)]
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_PACKET_BOUNDARY


def test_repeated_wrapper_input_has_one_cumulative_parse_allowance(monkeypatch):
    parts = [("xdp:xdp", XDP_OPEN + b'<!--' + b'x' * 2048 + b'-->')]
    parts += [("template", template())] * 12
    parts += [("/xdp:xdp", XDP_CLOSE)]
    assert result(document(parts, split=True))["class"] == xfa.STATIC
    monkeypatch.setattr(xfa, "_MAX_PARSE_BYTES", 20_000)
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_RESOURCE_BYTES


@pytest.mark.parametrize("node", [b'<!--x-->', b'<?p x?>'])
def test_non_element_xml_nodes_share_the_tree_allocation_allowance(monkeypatch, node):
    parts = wrapped(("template", template()))
    parts[0] = (parts[0][0], parts[0][1] + node * 16)
    monkeypatch.setattr(xfa, "_MAX_RESOURCE_ELEMENTS", 8)
    assert result(document(parts, split=True))["shape"] == xfa.SHAPE_RESOURCE_ELEMENTS
