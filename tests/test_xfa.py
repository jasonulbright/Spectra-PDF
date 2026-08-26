"""Static XFA forms: classification, datasets read/write, refusals.

Fixtures are synthesized with pikepdf so the suite carries no wild corpus.
Their shapes are the ones the wild population actually uses: the line-broken
tag style, a datasets tree FLATTER than the field names, both `/XFA`
spellings, and packets (`xfdf`, `connectionSet`, `sourceSet`) the fill must
leave alone.
"""

import os

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine import xfa
from engine.acroform import refuse_if_xfa
from engine.forms import fill_form_fields, read_form_fields
from engine.xfa_datasets import DatasetsError, DatasetsPacket, parse_som_path
# Sibling helper, imported BARE like every other one in this suite — a
# `tests.` prefix resolves against whichever `tests` package is on sys.path
# first, and an installed dependency that ships one shadows this directory.
from test_pades import _build_pki

_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("xfa-pki")))
    return _PKI

# The wild datasets style: every tag broken before its `>`.
FLAT_DATASETS = (
    b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"\n'
    b"><xfa:data\n"
    b"><topmostSubform\n"
    b"><name1\n"
    b">Ada</name1\n"
    b"><name2\n"
    b"/><group1 xfa:dataNode=\"dataGroup\"\n"
    b"><inner1\n"
    b"/></group1\n"
    b"></topmostSubform\n"
    b"></xfa:data\n"
    b"></xfa:datasets\n"
    b">"
)

# The same style, but with the container the field names walk through present
# only as a self-closing tag: it has no content region, so every value and
# every created child under it has to compose into ONE rewrite of its span.
EMPTY_HOLDER_DATASETS = (
    b'<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"\n'
    b"><xfa:data\n"
    b"><topmostSubform\n"
    b"><Page1\n"
    b"/></topmostSubform\n"
    b"></xfa:data\n"
    b"></xfa:datasets\n"
    b">"
)

TEMPLATE = (
    b'<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">'
    b'<subform name="topmostSubform"><field name="name1"><calculate>'
    b"<script>1</script></calculate></field></subform></template>"
)

CONNECTION_SET = (
    b'<connectionSet xmlns="http://www.xfa.org/schema/xfa-connection-set/2.8/">'
    b'<wsdlConnection name="svc" dataDescription="d"><wsdlAddress>'
    b"http://example.invalid/svc</wsdlAddress></wsdlConnection></connectionSet>"
)

XFDF = b'<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots/></xfdf>'

FIELD_NAMES = (
    "topmostSubform[0].Page1[0].name1[0]",
    "topmostSubform[0].Page1[0].name2[0]",
    "topmostSubform[0].Page1[0].group1[0].inner1[0]",
)


def _hybrid(
    path,
    datasets=FLAT_DATASETS,
    single_stream=False,
    needs_rendering=False,
    fields=True,
    extra_packets=True,
):
    """A hybrid static XFA form: real page content, a complete AcroForm
    shadow, and an `/XFA` entry in whichever spelling the caller asks for."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    page.Contents = pdf.make_stream(b"BT ET")
    helv = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.Helvetica,
            Encoding=Name.WinAnsiEncoding,
        )
    )
    widgets = []
    for i, name in enumerate(FIELD_NAMES):
        widget = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Widget,
                Rect=[40, 340 - i * 40, 300, 364 - i * 40],
                F=4,
                P=page.obj,
                T=pikepdf.String(name),
                FT=Name.Tx,
                DA=pikepdf.String("/Helv 10 Tf 0 g"),
            )
        )
        widgets.append(widget)
    page.obj["/Annots"] = pikepdf.Array(widgets)

    if single_stream:
        body = (
            b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'
            + TEMPLATE
            + datasets
            + b"</xdp:xdp>"
        )
        entry = pdf.make_stream(body)
    else:
        pairs = [
            pikepdf.String("template"),
            pdf.make_stream(TEMPLATE),
            pikepdf.String("datasets"),
            pdf.make_stream(datasets),
        ]
        if extra_packets:
            pairs += [
                pikepdf.String("xfdf"),
                pdf.make_stream(XFDF),
                pikepdf.String("connectionSet"),
                pdf.make_stream(CONNECTION_SET),
            ]
        entry = pikepdf.Array(pairs)

    pdf.Root["/AcroForm"] = pdf.make_indirect(
        Dictionary(
            Fields=pikepdf.Array(widgets if fields else []),
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
            DR=Dictionary(Font=Dictionary(Helv=helv)),
            XFA=entry,
        )
    )
    if needs_rendering:
        pdf.Root["/NeedsRendering"] = True
    pdf.save(str(path))
    pdf.close()
    return str(path)


def _datasets_bytes(path) -> bytes:
    with pikepdf.open(path) as pdf:
        return xfa.datasets_stream(pdf).read_bytes()


def _packet(path, name) -> bytes | None:
    with pikepdf.open(path) as pdf:
        for pname, stream in xfa.packets(xfa.xfa_entry(pdf)):
            if pname == name:
                return stream.read_bytes()
    return None


class TestClassification:
    """ISO 32000-2 Table 29 plus the AcroForm shadow — never a template regex."""

    def test_hybrid_is_static(self, tmp_path):
        with pikepdf.open(_hybrid(tmp_path / "a.pdf")) as pdf:
            assert xfa.classify(pdf) == xfa.STATIC

    def test_needs_rendering_is_dynamic(self, tmp_path):
        path = _hybrid(tmp_path / "b.pdf", needs_rendering=True)
        with pikepdf.open(path) as pdf:
            assert xfa.classify(pdf) == xfa.DYNAMIC

    def test_no_field_shadow_is_dynamic(self, tmp_path):
        path = _hybrid(tmp_path / "c.pdf", fields=False)
        with pikepdf.open(path) as pdf:
            assert xfa.classify(pdf) == xfa.DYNAMIC

    def test_no_xfa_is_none(self, tmp_path):
        pdf = pikepdf.new()
        pdf.add_blank_page()
        pdf.save(str(tmp_path / "d.pdf"))
        pdf.close()
        with pikepdf.open(str(tmp_path / "d.pdf")) as opened:
            assert xfa.classify(opened) == xfa.NONE

    def test_single_stream_spelling_is_read(self, tmp_path):
        """Annex K's other spelling: one stream holding the whole xdp:xdp."""
        path = _hybrid(tmp_path / "e.pdf", single_stream=True)
        with pikepdf.open(path) as pdf:
            assert xfa.classify(pdf) == xfa.STATIC
            assert xfa.datasets_stream(pdf) is not None

    def test_authored_logic_is_reported(self, tmp_path):
        with pikepdf.open(_hybrid(tmp_path / "f.pdf")) as pdf:
            assert xfa.has_authored_logic(pdf) is True


class TestSomPaths:
    """XFA 3.3 ch. 2 "Field Names", ch. 3 "Scripting Object Model"."""

    def test_index_defaults_to_zero(self):
        assert parse_som_path("a.b") == [("a", 0), ("b", 0)]

    def test_occurrence_index_is_parsed(self):
        assert parse_som_path("a[0].b[2]") == [("a", 0), ("b", 2)]

    def test_form_dom_root_is_dropped(self):
        assert parse_som_path("form.a[0]") == [("a", 0)]

    def test_escaped_period_stays_in_the_name(self):
        assert parse_som_path("a[0].f3_166\\.[0]") == [("a", 0), ("f3_166.", 0)]


class TestDatasetsPacket:
    def test_flatter_tree_resolves_through_the_missing_step(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.get("topmostSubform[0].Page1[0].name1[0]") == "Ada"

    def test_empty_element_reads_as_empty(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.get("topmostSubform[0].Page1[0].name2[0]") == ""

    def test_no_edit_is_byte_identical(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.bytes() is FLAT_DATASETS

    def test_writing_the_same_value_changes_nothing(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.set("topmostSubform[0].Page1[0].name1[0]", "Ada") is False
        assert packet.bytes() == FLAT_DATASETS

    def test_empty_element_becomes_a_pair(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.set("topmostSubform[0].Page1[0].name2[0]", "Lovelace") is True
        assert b"<name2>Lovelace</name2>" in packet.bytes()
        assert DatasetsPacket(packet.bytes()).get(
            "topmostSubform[0].Page1[0].name2[0]"
        ) == "Lovelace"

    def test_only_the_named_leaf_moves(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        packet.set("topmostSubform[0].Page1[0].name1[0]", "Grace")
        out = packet.bytes()
        assert b"<name2\n/>" in out
        assert b'xfa:dataNode="dataGroup"' in out

    def test_markup_in_a_value_is_escaped(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        packet.set("topmostSubform[0].Page1[0].name1[0]", "a<b&c")
        assert DatasetsPacket(packet.bytes()).get(
            "topmostSubform[0].Page1[0].name1[0]"
        ) == "a<b&c"

    def test_absent_node_is_created_under_its_holder(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.set("topmostSubform[0].fresh[0]", "x", create=True) is True
        assert DatasetsPacket(packet.bytes()).get("topmostSubform[0].fresh[0]") == "x"

    def test_two_absent_nodes_under_one_empty_holder_compose(self):
        """Two creates under a self-closing holder each rewrote that holder's
        whole tag span, so the second was applied against bytes the first had
        already changed and ate the neighbouring tag."""
        packet = DatasetsPacket(EMPTY_HOLDER_DATASETS)
        assert packet.set("topmostSubform[0].Page1[0].name1[0]", "Alice", create=True)
        assert packet.set("topmostSubform[0].Page1[0].name2[0]", "Bob", create=True)
        out = DatasetsPacket(packet.bytes())
        assert out.get("topmostSubform[0].Page1[0].name1[0]") == "Alice"
        assert out.get("topmostSubform[0].Page1[0].name2[0]") == "Bob"

    def test_many_absent_nodes_under_one_empty_holder_compose(self):
        packet = DatasetsPacket(EMPTY_HOLDER_DATASETS)
        for i in range(1, 6):
            assert packet.set(
                f"topmostSubform[0].Page1[0].f{i}[0]", f"v{i}", create=True
            )
        out = DatasetsPacket(packet.bytes())
        for i in range(1, 6):
            assert out.get(f"topmostSubform[0].Page1[0].f{i}[0]") == f"v{i}"

    def test_a_value_on_an_empty_holder_composes_with_a_create_under_it(self):
        """The holder is itself a field's node AND another field's parent: the
        value edit and the created child share one tag-span rewrite."""
        packet = DatasetsPacket(EMPTY_HOLDER_DATASETS)
        assert packet.set("topmostSubform[0].Page1[0]", "held")
        assert packet.set("topmostSubform[0].Page1[0].name1[0]", "Alice", create=True)
        out = DatasetsPacket(packet.bytes())
        assert out.get("topmostSubform[0].Page1[0].name1[0]") == "Alice"

    def test_two_creates_under_one_non_empty_holder_keep_their_order(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.set("topmostSubform[0].alpha[0]", "1", create=True)
        assert packet.set("topmostSubform[0].beta[0]", "2", create=True)
        raw = packet.bytes()
        assert raw.index(b"<alpha>") < raw.index(b"<beta>")
        out = DatasetsPacket(raw)
        assert out.get("topmostSubform[0].alpha[0]") == "1"
        assert out.get("topmostSubform[0].beta[0]") == "2"

    def test_a_utf16_packet_refuses(self):
        """`_declared_encoding` byte-scans for an ASCII `encoding=`, which a
        UTF-16 declaration can never match; the BOM is what says so."""
        raw = '<?xml version="1.0" encoding="UTF-16"?><xfa:data/>'.encode("utf-16")
        with pytest.raises(DatasetsError):
            DatasetsPacket(raw)

    def test_absent_node_without_create_is_not_written(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.set("topmostSubform[0].fresh[0]", "x") is False
        assert packet.bytes() == FLAT_DATASETS

    def test_a_data_group_is_not_a_value(self):
        packet = DatasetsPacket(FLAT_DATASETS)
        assert packet.get("topmostSubform[0].group1[0]") is None

    def test_a_non_utf8_packet_refuses(self):
        raw = b'<?xml version="1.0" encoding="ISO-8859-1"?><xfa:data/>'
        with pytest.raises(DatasetsError):
            DatasetsPacket(raw)

    def test_malformed_xml_refuses(self):
        with pytest.raises(DatasetsError):
            DatasetsPacket(b"<a><b></a>")

    def test_attribute_containing_a_bracket_does_not_end_the_tag(self):
        raw = b'<xfa:data><a note="1&gt;0">v</a></xfa:data>'
        packet = DatasetsPacket(raw)
        assert packet.get("a[0]") == "v"
        packet.set("a[0]", "w")
        assert DatasetsPacket(packet.bytes()).get("a[0]") == "w"


class TestBackFill:
    """The defect: a value in the datasets packet that `/V` does not carry."""

    def test_read_reports_the_datasets_value(self, tmp_path):
        result = read_form_fields(_hybrid(tmp_path / "a.pdf"))
        by_name = {f["name"]: f for f in result["fields"]}
        field = by_name["topmostSubform[0].Page1[0].name1[0]"]
        assert field["value"] == "Ada"
        assert field["value_from_xfa"] is True

    def test_a_field_with_no_datasets_value_stays_blank(self, tmp_path):
        result = read_form_fields(_hybrid(tmp_path / "a.pdf"))
        by_name = {f["name"]: f for f in result["fields"]}
        assert by_name["topmostSubform[0].Page1[0].name2[0]"]["value"] == ""
        assert "value_from_xfa" not in by_name["topmostSubform[0].Page1[0].name2[0]"]

    def test_the_read_states_the_kind_and_the_unrun_logic(self, tmp_path):
        result = read_form_fields(_hybrid(tmp_path / "a.pdf"))
        assert result["xfa"] == "static"
        assert result["xfa_calculations"] is True

    def test_an_unreadable_packet_is_reported_by_the_read(self, tmp_path):
        """A packet this build cannot parse must not read as "static XFA, no
        XFA values" — that presented a broken resource as an absence."""
        path = _hybrid(tmp_path / "u.pdf", datasets=b"<xfa:data><a></xfa:data>")
        result = read_form_fields(path)
        assert result["xfa"] == "static"
        assert result["xfa_datasets_unreadable"] is True
        assert all("value_from_xfa" not in f for f in result["fields"])

    def test_a_readable_packet_reports_no_unreadable_key(self, tmp_path):
        assert "xfa_datasets_unreadable" not in read_form_fields(_hybrid(tmp_path / "a.pdf"))

    def test_a_dynamic_form_is_not_back_filled(self, tmp_path):
        """Its state is not in the PDF field objects, so reporting a datasets
        value against them would describe a document nothing renders."""
        path = _hybrid(tmp_path / "b.pdf", needs_rendering=True)
        result = read_form_fields(path)
        assert result["xfa"] == "dynamic"
        assert all("value_from_xfa" not in f for f in result["fields"])


class TestDualWrite:
    def test_fill_writes_both_v_and_the_datasets_leaf(self, tmp_path):
        src = _hybrid(tmp_path / "a.pdf")
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            src, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"}
        )
        assert result["xfa"] == "static"
        assert result["xfa_datasets_updated"] == 1
        assert result["xfa_stripped"] is False
        with pikepdf.open(out) as pdf:
            assert xfa.classify(pdf) == xfa.STATIC
            field = pdf.Root.AcroForm.Fields[1]
            assert str(field.get("/V")) == "Hopper"
        assert DatasetsPacket(_datasets_bytes(out)).get(
            "topmostSubform[0].Page1[0].name2[0]"
        ) == "Hopper"

    def test_the_other_packets_are_untouched(self, tmp_path):
        src = _hybrid(tmp_path / "a.pdf")
        out = str(tmp_path / "out.pdf")
        fill_form_fields(src, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"})
        assert _packet(out, "template") == TEMPLATE
        assert _packet(out, "xfdf") == XFDF
        # Web-service bindings are never read and never acted on.
        assert _packet(out, "connectionSet") == CONNECTION_SET

    def test_a_zero_change_fill_leaves_the_packet_byte_identical(self, tmp_path):
        src = _hybrid(tmp_path / "a.pdf")
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            src, out, {"topmostSubform[0].Page1[0].name1[0]": "Ada"}
        )
        assert result["xfa_datasets_updated"] == 0
        assert _datasets_bytes(out) == FLAT_DATASETS

    def test_a_field_with_no_data_node_gets_one(self, tmp_path):
        src = _hybrid(tmp_path / "a.pdf")
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            src, out, {"topmostSubform[0].Page1[0].group1[0].inner1[0]": "z"}
        )
        assert "xfa_datasets_unbound" not in result
        assert DatasetsPacket(_datasets_bytes(out)).get(
            "topmostSubform[0].Page1[0].group1[0].inner1[0]"
        ) == "z"

    def test_single_stream_spelling_round_trips(self, tmp_path):
        src = _hybrid(tmp_path / "a.pdf", single_stream=True)
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            src, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"}
        )
        assert result["xfa_datasets_updated"] == 1
        with pikepdf.open(out) as pdf:
            body = xfa.datasets_stream(pdf).read_bytes()
        assert b"<xdp:xdp" in body
        assert DatasetsPacket(body).get("topmostSubform[0].Page1[0].name2[0]") == "Hopper"

    def test_two_fields_under_one_empty_holder_fill_well_formed(self, tmp_path):
        """Through the real door: the reported success has to be a packet an
        XFA-aware reader can still parse."""
        src = _hybrid(tmp_path / "a.pdf", datasets=EMPTY_HOLDER_DATASETS)
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            src,
            out,
            {
                "topmostSubform[0].Page1[0].name1[0]": "Alice",
                "topmostSubform[0].Page1[0].name2[0]": "Bob",
            },
        )
        assert result["xfa_datasets_updated"] == 2
        packet = DatasetsPacket(_datasets_bytes(out))
        assert packet.get("topmostSubform[0].Page1[0].name1[0]") == "Alice"
        assert packet.get("topmostSubform[0].Page1[0].name2[0]") == "Bob"

    def test_the_filled_value_reads_back_from_v_not_the_packet(self, tmp_path):
        src = _hybrid(tmp_path / "a.pdf")
        out = str(tmp_path / "out.pdf")
        fill_form_fields(src, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"})
        by_name = {f["name"]: f for f in read_form_fields(out)["fields"]}
        entry = by_name["topmostSubform[0].Page1[0].name2[0]"]
        assert entry["value"] == "Hopper"
        assert "value_from_xfa" not in entry


class TestRefusals:
    def test_a_dynamic_form_refuses_to_fill_by_name(self, tmp_path):
        path = _hybrid(tmp_path / "b.pdf", needs_rendering=True)
        with pytest.raises(ValueError, match="dynamic XML form"):
            fill_form_fields(path, str(tmp_path / "o.pdf"), {"x": "y"})

    def test_page_surgery_still_refuses_on_a_filled_xfa_document(self, tmp_path):
        """The packets now SURVIVE a fill, which makes this refusal stronger:
        the template lays out its own pages, so after page surgery the packet
        and the pages would describe two different documents."""
        src = _hybrid(tmp_path / "a.pdf")
        out = str(tmp_path / "out.pdf")
        fill_form_fields(src, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"})
        with pikepdf.open(out) as pdf:
            with pytest.raises(ValueError, match="XML form"):
                refuse_if_xfa(pdf, out, "deleting pages")


class TestSignedDocuments:
    def test_a_fill_on_a_signed_form_appends_and_keeps_the_packets(
        self, tmp_path, pki
    ):
        from engine.signatures import sign_pdf, verify_signatures

        src = _hybrid(tmp_path / "a.pdf")
        signed = str(tmp_path / "signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")
        original = open(signed, "rb").read()
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            signed, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"}
        )
        assert result.get("signatures_preserved") is True
        assert result["xfa_datasets_updated"] == 1
        # Original bytes verbatim + one appended revision.
        assert open(out, "rb").read().startswith(original)
        assert all(s["valid"] for s in verify_signatures(out)["signatures"])
        assert DatasetsPacket(_datasets_bytes(out)).get(
            "topmostSubform[0].Page1[0].name2[0]"
        ) == "Hopper"
        assert _packet(out, "template") == TEMPLATE

    def test_a_fill_on_a_signed_single_stream_form_appends_and_verifies(
        self, tmp_path, pki
    ):
        """The single-stream `xdp:xdp` spelling is not an Array, so the /XFA
        packet-wise delta declines it. Skipping the key instead of falling
        back to the whole-value materialization dropped the datasets update
        AND left /AcroForm unmarked, which broke the signature."""
        from engine.signatures import sign_pdf, verify_signatures

        src = _hybrid(tmp_path / "a.pdf", single_stream=True)
        signed = str(tmp_path / "signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")
        original = open(signed, "rb").read()
        out = str(tmp_path / "out.pdf")
        result = fill_form_fields(
            signed, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"}
        )
        assert result.get("signatures_preserved") is True
        assert result["xfa_datasets_updated"] == 1
        assert open(out, "rb").read().startswith(original)
        assert all(s["valid"] for s in verify_signatures(out)["signatures"])
        assert DatasetsPacket(_datasets_bytes(out)).get(
            "topmostSubform[0].Page1[0].name2[0]"
        ) == "Hopper"

    def test_the_appended_revision_carries_only_the_changed_packet(
        self, tmp_path, pki
    ):
        """The template packet alone runs to hundreds of kilobytes in a real
        form; re-listing the unchanged packets by the original's own object
        references is what keeps a fill from appending a copy of all of them."""
        from engine.signatures import sign_pdf

        src = _hybrid(tmp_path / "a.pdf")
        signed = str(tmp_path / "signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")
        out = str(tmp_path / "out.pdf")
        fill_form_fields(signed, out, {"topmostSubform[0].Page1[0].name2[0]": "Hopper"})
        appended = open(out, "rb").read()[os.path.getsize(signed):]
        assert TEMPLATE not in appended
        assert CONNECTION_SET not in appended
        assert b"Hopper" in appended
