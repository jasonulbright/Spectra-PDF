"""Text a redaction removed from a page, still spelled elsewhere in the file.

Each test draws a secret on page 1, keeps the same words in one place outside
page content, redacts the secret, and checks three outcomes: the redaction
reports the place, `remove_redaction_residue` removes the words when asked
for that kind, and the words stay when it is not asked.
"""

from __future__ import annotations

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.merge import merge
from engine.redact import redact
from engine.redact_document import remove_redaction_residue

SECRET = "SSN 123-45-6789"
MARK = [90, 690, 400, 730]


def _doc(text: str = SECRET):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    page = pdf.pages[0]
    page.obj.Resources = Dictionary(Font=Dictionary(F1=font))
    page.obj.Contents = pdf.make_stream(
        b"BT /F1 24 Tf 100 700 Td (" + text.encode("latin-1") + b") Tj ET "
        b"BT /F1 12 Tf 100 400 Td (Public text) Tj ET"
    )
    return pdf


def _outline(pdf, title=SECRET):
    with pdf.open_outline() as ol:
        ol.root.append(pikepdf.OutlineItem(title, 0))


def _thread(pdf, title=SECRET):
    thread = pdf.make_indirect(Dictionary(Type=Name.Thread, I=Dictionary(Title=String(title))))
    bead = pdf.make_indirect(Dictionary(Type=Name.Bead, T=thread, P=pdf.pages[0].obj,
                                        R=Array([0, 0, 100, 100])))
    bead.N = bead
    bead.V = bead
    thread.F = bead
    pdf.pages[0].obj.B = Array([bead])
    pdf.Root.Threads = Array([thread])


def _dest(pdf, name=SECRET):
    dest = Array([pdf.pages[0].obj, Name.XYZ, 0, 792, 0])
    pdf.Root.Names = Dictionary(Dests=Dictionary(Names=Array([String(name), dest])))
    link = Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array([0, 0, 50, 50]),
                      A=Dictionary(S=Name.GoTo, D=String(name)))
    pdf.pages[0].obj.Annots = pdf.make_indirect(Array([pdf.make_indirect(link)]))


def _label(pdf, prefix=SECRET):
    pdf.Root.PageLabels = Dictionary(Nums=Array([0, Dictionary(S=Name.D, P=String(prefix))]))


def _info(pdf, value=SECRET):
    pdf.docinfo[Name.Subject] = String(value)


def _xmp(pdf, value=SECRET):
    with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
        meta["dc:description"] = value


def _annotation(pdf, value=SECRET):
    note = Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=Array([500, 100, 520, 120]),
                      Contents=String(value))
    pdf.pages[0].obj.Annots = pdf.make_indirect(Array([pdf.make_indirect(note)]))


BUILDERS = {
    "outline": _outline,
    "thread": _thread,
    "dest_name": _dest,
    "page_label": _label,
    "metadata": lambda pdf: (_info(pdf), _xmp(pdf)),
    "annotation": _annotation,
}


def _strings(path: str) -> str:
    """Every decoded text string and name in the file, and the XMP."""
    out: list[str] = []
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            stack = [obj]
            while stack:
                item = stack.pop()
                if isinstance(item, pikepdf.String):
                    out.append(str(item))
                elif isinstance(item, pikepdf.Name):
                    out.append(str(item))
                elif isinstance(item, pikepdf.Array):
                    stack.extend(list(item))
                elif isinstance(item, (pikepdf.Dictionary, pikepdf.Stream)):
                    if item is not obj and item.is_indirect:
                        continue
                    stack.extend(item.get(k) for k in item.keys())
                    if isinstance(item, pikepdf.Stream) and item.get("/Type") == Name.Metadata:
                        out.append(item.read_bytes().decode("utf-8", "replace"))
    return "\n".join(out)


def _redacted(tmp_dir, build, name="in"):
    pdf = _doc()
    build(pdf)
    src = os.path.join(tmp_dir, f"{name}.pdf")
    pdf.save(src)
    pdf.close()
    out = os.path.join(tmp_dir, f"{name}_out.pdf")
    result = redact(src, out, [{"page": 1, "rect": MARK}])
    return out, result


@pytest.mark.parametrize("kind", sorted(BUILDERS))
def test_residue_is_reported_and_removed_on_request(tmp_dir, kind):
    out, result = _redacted(tmp_dir, BUILDERS[kind], kind)
    assert SECRET in result["removed_text"]
    assert {entry["kind"] for entry in result["residue"]} == {kind}
    assert SECRET in _strings(out)

    clean = os.path.join(tmp_dir, f"{kind}_clean.pdf")
    removed = remove_redaction_residue(out, clean, result["removed_text"], [kind])
    assert removed["residue_removed"] >= 1
    assert removed["residue"] == []
    assert "123-45-6789" not in _strings(clean)


@pytest.mark.parametrize("kind", sorted(BUILDERS))
def test_a_kind_not_asked_for_is_left_alone(tmp_dir, kind):
    out, result = _redacted(tmp_dir, BUILDERS[kind], kind)
    other = [k for k in BUILDERS if k != kind]
    kept = os.path.join(tmp_dir, f"{kind}_kept.pdf")
    removed = remove_redaction_residue(out, kept, result["removed_text"], other)
    assert removed["residue_removed"] == 0
    assert {entry["kind"] for entry in removed["residue"]} == {kind}
    assert SECRET in _strings(kept)


def test_a_renamed_destination_keeps_its_link(tmp_dir):
    out, result = _redacted(tmp_dir, _dest)
    clean = os.path.join(tmp_dir, "clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["dest_name"])
    with pikepdf.open(clean) as pdf:
        names = pdf.Root.Names.Dests.Names
        new_name = str(names[0])
        assert "6789" not in new_name
        link = pdf.pages[0].obj.Annots[0]
        assert str(link.A.D) == new_name


def test_matching_follows_the_search_normalization(tmp_dir):
    """Case, NFKC (a ligature) and a UTF-16 string all match the page text."""
    def build(pdf):
        with pdf.open_outline() as ol:
            ol.root.append(pikepdf.OutlineItem("ssn 123-45-6789", 0))
            ol.root.append(pikepdf.OutlineItem("ﬁle – SSN 123-45-6789 中", 0))

    out, result = _redacted(tmp_dir, build)
    assert len(result["residue"]) == 2
    clean = os.path.join(tmp_dir, "clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], None)
    with pikepdf.open(clean) as pdf:
        with pdf.open_outline() as ol:
            titles = [item.title for item in ol.root]
    assert all("6789" not in t for t in titles)
    assert titles[1].startswith("ﬁle – ")
    assert titles[1].endswith(" 中")


def test_a_merge_of_the_cleaned_file_carries_nothing(tmp_dir):
    def build(pdf):
        _outline(pdf)
        _info(pdf)
        _label(pdf)

    out, result = _redacted(tmp_dir, build)
    clean = os.path.join(tmp_dir, "clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], None)
    other = os.path.join(tmp_dir, "other.pdf")
    blank = pikepdf.new()
    blank.add_blank_page()
    blank.save(other)
    merged = os.path.join(tmp_dir, "merged.pdf")
    merge([other, clean], merged)
    assert "123-45-6789" not in _strings(merged)


def test_text_outside_every_mark_is_not_a_term(tmp_dir):
    out, result = _redacted(tmp_dir, lambda pdf: _outline(pdf, "Public text"))
    assert result["residue"] == []
    assert "Public text" not in result["removed_text"]


def test_an_unknown_kind_is_refused(tmp_dir):
    out, result = _redacted(tmp_dir, _outline)
    with pytest.raises(ValueError):
        remove_redaction_residue(out, os.path.join(tmp_dir, "x.pdf"), result["removed_text"], ["bogus"])


def _field(pdf, value=SECRET):
    face = pdf.make_stream(b"/Tx BMC BT /Helv 10 Tf 2 5 Td (" + value.encode() + b") Tj ET EMC")
    face.Type = Name.XObject
    face.Subtype = Name.Form
    face.BBox = Array([0, 0, 200, 20])
    helv = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    widget = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, T=String("id"), V=String(value),
        Rect=Array([100, 100, 300, 120]), P=pdf.pages[0].obj, DA=String("/Helv 10 Tf 0 g"),
        AP=Dictionary(N=face),
    ))
    pdf.pages[0].obj.Annots = pdf.make_indirect(Array([widget]))
    pdf.Root.AcroForm = Dictionary(Fields=Array([widget]), DA=String("/Helv 10 Tf 0 g"),
                                   DR=Dictionary(Font=Dictionary(Helv=helv)))


def _attachment(pdf, name=SECRET):
    data = pdf.make_stream(b"x")
    data.Type = Name.EmbeddedFile
    spec = pdf.make_indirect(Dictionary(Type=Name.Filespec, F=String(name + ".txt"),
                                        UF=String(name + ".txt"), EF=Dictionary(F=data)))
    pdf.Root.Names = Dictionary(EmbeddedFiles=Dictionary(Names=Array([String(name), spec])))


def _script(pdf, value=SECRET):
    action = pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String(f"app.alert('{value}');")))
    pdf.Root.Names = Dictionary(JavaScript=Dictionary(Names=Array([String("init"), action])))


@pytest.mark.parametrize("kind,build", [("field", _field), ("embedded_file", _attachment), ("javascript", _script)])
def test_other_places_are_reported_and_removed(tmp_dir, kind, build):
    out, result = _redacted(tmp_dir, build, kind)
    assert result["residue"] and {entry["kind"] for entry in result["residue"]} == {kind}
    kept = os.path.join(tmp_dir, f"{kind}_kept.pdf")
    remove_redaction_residue(out, kept, result["removed_text"], [k for k in BUILDERS])
    assert SECRET in _strings(kept)
    clean = os.path.join(tmp_dir, f"{kind}_clean.pdf")
    removed = remove_redaction_residue(out, clean, result["removed_text"], [kind])
    assert removed["residue"] == []
    assert "123-45-6789" not in _strings(clean)


def test_a_changed_field_value_gets_a_new_appearance(tmp_dir):
    out, result = _redacted(tmp_dir, _field)
    clean = os.path.join(tmp_dir, "clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["field"])
    with pikepdf.open(clean) as pdf:
        widget = pdf.Root.AcroForm.Fields[0]
        face = widget.AP.N.read_bytes()
    assert b"6789" not in face


def test_an_unattended_redaction_reports_unless_told_to_remove(tmp_dir):
    from engine.search_redact import search_and_redact

    pdf = _doc()
    _outline(pdf)
    _info(pdf)
    src = os.path.join(tmp_dir, "u.pdf")
    pdf.save(src)
    pdf.close()
    reported = search_and_redact(src, os.path.join(tmp_dir, "r.pdf"), query="123-45-6789")
    assert reported["residue_removed"] == 0
    assert {e["kind"] for e in reported["residue"]} == {"outline", "metadata"}
    removed = search_and_redact(src, os.path.join(tmp_dir, "x.pdf"), query="123-45-6789",
                                remove_residue="all")
    assert removed["residue_removed"] >= 2 and removed["residue"] == []
    assert "123-45-6789" not in _strings(os.path.join(tmp_dir, "x.pdf"))
    only = redact(src, os.path.join(tmp_dir, "o.pdf"), [{"page": 1, "rect": MARK}], remove_residue="outline")
    assert [e["kind"] for e in only["residue"]] == ["metadata"]
    with pytest.raises(ValueError):
        redact(src, os.path.join(tmp_dir, "b.pdf"), [{"page": 1, "rect": MARK}], remove_residue="bogus")


# ── review findings ───────────────────────────────────────────────────────


def _redacted_word(tmp_dir, page_text, rect, build, name):
    pdf = _doc(page_text)
    build(pdf)
    src = os.path.join(tmp_dir, f"{name}.pdf")
    pdf.save(src)
    pdf.close()
    out = os.path.join(tmp_dir, f"{name}_out.pdf")
    return out, redact(src, out, [{"page": 1, "rect": rect}])


@pytest.mark.parametrize("word,title,expected", [
    ("cats", "catsup and cats", "catsup and ***"),
    ("John", "Johnson and John", "Johnson and ***"),
    ("catalog", 'this.getField("catalogue"); catalog', 'this.getField("catalogue"); ***'),
])
def test_a_term_matches_whole_words_only(tmp_dir, word, title, expected):
    """A redacted "cat" leaves "category" alone; "John" leaves "Johnson"."""
    def build(pdf):
        with pdf.open_outline() as ol:
            ol.root.append(pikepdf.OutlineItem(title, 0))

    out, result = _redacted_word(tmp_dir, word, [90, 690, 400, 730], build, "words")
    clean = os.path.join(tmp_dir, "words_clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], None)
    with pikepdf.open(clean) as pdf:
        with pdf.open_outline() as ol:
            assert [item.title for item in ol.root] == [expected]


def test_a_clipped_word_is_not_a_term(tmp_dir):
    """The mark covers "SSN 123-45-6789" and one glyph of "Public"; the
    clipped word never becomes a term."""
    pdf = _doc("SSN 123-45-6789 Publicly")
    _outline(pdf, "Publicly known")
    src = os.path.join(tmp_dir, "clip.pdf")
    pdf.save(src)
    pdf.close()
    out = os.path.join(tmp_dir, "clip_out.pdf")
    result = redact(src, out, [{"page": 1, "rect": [90, 690, 320, 730]}])
    assert sorted(result["removed_text"]) == ["123-45-6789", "SSN 123-45-6789"]
    assert result["residue"] == []


def test_scripts_are_never_edited_only_removed_whole(tmp_dir):
    def build(pdf):
        _script(pdf)
        action = pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String(f"var s = '{SECRET}';")))
        pdf.Root.OpenAction = action

    out, result = _redacted(tmp_dir, build, "js")
    assert [e["kind"] for e in result["residue"]] == ["javascript", "javascript"]
    kept = os.path.join(tmp_dir, "js_kept.pdf")
    remove_redaction_residue(out, kept, result["removed_text"], ["outline"])
    with pikepdf.open(kept) as pdf:
        assert str(pdf.Root.Names.JavaScript.Names[1].JS) == f"app.alert('{SECRET}');"
        assert str(pdf.Root.OpenAction.JS) == f"var s = '{SECRET}';"
    clean = os.path.join(tmp_dir, "js_clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["javascript"])
    with pikepdf.open(clean) as pdf:
        assert len(pdf.Root.Names.JavaScript.Names) == 0
        assert "/OpenAction" not in pdf.Root
    assert "***" not in _strings(clean)


def test_field_names_are_reported_and_never_renamed(tmp_dir):
    def build(pdf):
        _field(pdf, value="SSN 123-45-6789")
        pdf.Root.AcroForm.Fields[0].T = String("123-45-6789")
        pdf.Root.AcroForm.CO = Array([pdf.Root.AcroForm.Fields[0]])

    out, result = _redacted(tmp_dir, build, "fname")
    assert sorted(e["kind"] for e in result["residue"]) == ["field", "field_name"]
    clean = os.path.join(tmp_dir, "fname_clean.pdf")
    removed = remove_redaction_residue(out, clean, result["removed_text"], ["field"])
    with pikepdf.open(clean) as pdf:
        field = pdf.Root.AcroForm.Fields[0]
        assert str(field.T) == "123-45-6789"
        assert str(field.V) == "***"
    assert [(e["kind"], e["where"]) for e in removed["residue"]] == [("field_name", "123-45-6789")]


def test_dates_stay_and_info_and_xmp_stay_in_sync(tmp_dir):
    def build(pdf):
        pdf.docinfo[Name.Title] = String(SECRET)
        pdf.docinfo[Name.CreationDate] = String("D:20240101000000Z")
        with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
            meta["dc:title"] = SECRET
            meta["xmp:CreateDate"] = "2024-01-01T00:00:00Z"

    out, result = _redacted(tmp_dir, build, "meta")
    clean = os.path.join(tmp_dir, "meta_clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["metadata"])
    with pikepdf.open(clean) as pdf:
        assert str(pdf.docinfo.Title) == "***"
        assert str(pdf.docinfo.CreationDate) == "D:20240101000000Z"
        meta = pdf.open_metadata()
        assert meta["dc:title"] == "***"
        assert meta["xmp:CreateDate"] == "2024-01-01T00:00:00Z"
    with pytest.raises(ValueError):
        remove_redaction_residue(out, clean, result["removed_text"], ["info"])


def test_counts_cover_rows_past_the_report_cap(tmp_dir, monkeypatch):
    from engine import redact_document

    monkeypatch.setattr(redact_document, "MAX_REPORT", 1)

    def build(pdf):
        with pdf.open_outline() as ol:
            for _ in range(3):
                ol.root.append(pikepdf.OutlineItem(SECRET, 0))
        _info(pdf)

    out, result = _redacted(tmp_dir, build, "cap")
    assert result["residue_truncated"] is True
    assert len(result["residue"]) == 1
    assert result["residue_counts"] == {"outline": 3, "metadata": 1}


def test_a_renamed_destination_is_counted(tmp_dir):
    out, result = _redacted(tmp_dir, _dest, "dcount")
    clean = os.path.join(tmp_dir, "dcount_clean.pdf")
    removed = remove_redaction_residue(out, clean, result["removed_text"], ["dest_name"])
    assert removed["renamed_destinations"] == 1


# ── re-review findings ────────────────────────────────────────────────────


def test_a_short_lone_word_is_not_a_term(tmp_dir):
    """Redacting "of" alone must not replace every "of" in the file."""
    def build(pdf):
        with pdf.open_outline() as ol:
            ol.root.append(pikepdf.OutlineItem("table of contents", 0))

    out, result = _redacted_word(tmp_dir, "of", [90, 690, 400, 730], build, "short")
    assert result["removed_text"] == []
    assert result["residue"] == []


def _chain_doc(pdf):
    js = lambda code: pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String(code)))
    uri = lambda n: pdf.make_indirect(Dictionary(S=Name.URI, URI=String(f"https://example.test/{n}")))
    first, middle, last = uri("first"), js(f"var s = '{SECRET}';"), uri("last")
    middle.Next = last
    first.Next = Array([middle, uri("sibling")])
    head = js(f"app.alert('{SECRET}');")
    head.Next = first
    pdf.Root.OpenAction = head
    return first


def test_a_removed_action_hands_its_slot_to_its_successors(tmp_dir):
    out, result = _redacted(tmp_dir, _chain_doc, "chain")
    assert result["residue_counts"]["javascript"] == 2
    clean = os.path.join(tmp_dir, "chain_clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["javascript"])
    with pikepdf.open(clean) as pdf:
        head = pdf.Root.OpenAction
        assert str(head.URI).endswith("/first")
        chain = [str(a.URI).rsplit("/", 1)[1] for a in head.Next]
        assert chain == ["last", "sibling"]
    assert "***" not in _strings(clean)


def test_xmp_dates_and_identifiers_are_never_scrubbed(tmp_dir):
    """A date value is skipped whatever its property name, and so is an
    identifier, even when a term would match inside it."""
    def build(pdf):
        with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
            meta["dc:title"] = SECRET
        body = pdf.Root.Metadata.read_bytes().decode("utf-8")
        extra = (
            '<rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"'
            ' xmlns:x1="urn:example:x1" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"'
            ' xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">'
            '<photoshop:DateCreated>2024-01-01</photoshop:DateCreated>'
            '<x1:recorded>2024-01-01T10:00:00Z</x1:recorded>'
            '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource">'
            '<stEvt:when>2024-01-01T10:00:00Z</stEvt:when>'
            '<stEvt:instanceID>uuid:2024-6789</stEvt:instanceID>'
            '</rdf:li></rdf:Seq></xmpMM:History></rdf:Description>'
        )
        body = body.replace("</rdf:RDF>", extra + "</rdf:RDF>")
        pdf.Root.Metadata.write(body.encode("utf-8"))

    pdf = _doc("SSN 123-45-6789 2024-01-01")
    build(pdf)
    src = os.path.join(tmp_dir, "dates.pdf")
    pdf.save(src)
    pdf.close()
    out = os.path.join(tmp_dir, "dates_out.pdf")
    result = redact(src, out, [{"page": 1, "rect": [90, 690, 600, 730]}])
    assert "2024-01-01" in result["removed_text"]
    clean = os.path.join(tmp_dir, "dates_clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["metadata"])
    with pikepdf.open(clean) as pdf:
        xmp = pdf.Root.Metadata.read_bytes().decode("utf-8")
    assert "<photoshop:DateCreated>2024-01-01</photoshop:DateCreated>" in xmp
    assert "<x1:recorded>2024-01-01T10:00:00Z</x1:recorded>" in xmp
    assert "<stEvt:when>2024-01-01T10:00:00Z</stEvt:when>" in xmp
    assert "uuid:2024-6789" in xmp
    assert SECRET not in xmp


def _cjk_doc(pdf_text_bytes: bytes):
    """A page drawing Han characters through a Type 0 font with an Identity
    ToUnicode map, so the walk reads them."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    cmap = pdf.make_stream(
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap "
        b"/CMapName /U def 1 begincodespacerange <0000> <FFFF> endcodespacerange "
        b"1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap "
        b"CMapName currentdict /CMap defineresource pop end end"
    )
    descendant = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.CIDFontType2, BaseFont=Name("/X"),
        CIDSystemInfo=Dictionary(Registry=String("Adobe"), Ordering=String("Identity"), Supplement=0),
        DW=1000,
    ))
    font = pdf.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type0, BaseFont=Name("/X"), Encoding=Name("/Identity-H"),
        DescendantFonts=Array([descendant]), ToUnicode=cmap,
    ))
    pdf.pages[0].obj.Resources = Dictionary(Font=Dictionary(F1=font))
    pdf.pages[0].obj.Contents = pdf.make_stream(b"BT /F1 20 Tf 100 700 Td <" + pdf_text_bytes + b"> Tj ET")
    return pdf


def test_a_fully_removed_han_sequence_is_a_term_without_word_boundaries(tmp_dir):
    text = "秘密計畫公開"  # six Han characters
    pdf = _cjk_doc(text.encode("utf-16-be").hex().encode())
    with pdf.open_outline() as ol:
        ol.root.append(pikepdf.OutlineItem("関連秘密計畫資料", 0))
    src = os.path.join(tmp_dir, "cjk.pdf")
    pdf.save(src)
    pdf.close()
    out = os.path.join(tmp_dir, "cjk_out.pdf")
    # 20 pt per character from x=100: the mark covers the first four.
    result = redact(src, out, [{"page": 1, "rect": [95, 690, 179, 730]}])
    assert result["removed_text"] == ["秘密計畫"]
    assert [e["kind"] for e in result["residue"]] == ["outline"]
    clean = os.path.join(tmp_dir, "cjk_clean.pdf")
    remove_redaction_residue(out, clean, result["removed_text"], ["outline"])
    with pikepdf.open(clean) as pdf:
        with pdf.open_outline() as ol:
            assert [i.title for i in ol.root] == ["関連***資料"]


def test_counts_are_occurrences_and_field_names_are_report_only(tmp_dir):
    def build(pdf):
        _field(pdf, value="SSN 123-45-6789")
        pdf.Root.AcroForm.Fields[0].T = String("123-45-6789")
        with pdf.open_outline() as ol:
            ol.root.append(pikepdf.OutlineItem(f"{SECRET} and {SECRET}", 0))

    out, result = _redacted(tmp_dir, build, "occ")
    assert result["residue_counts"]["outline"] == 2
    assert result["residue_report_only"] == {"field_name": 1}
    assert "field_name" not in result["residue_counts"]
