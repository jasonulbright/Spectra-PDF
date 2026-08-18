"""The widget appearance faces, through the two non-prepress Ghostscript ops.

`engine/widget_faces.py` stages every widget appearance face as a page of its
own so the op's own producer pass transforms it, instead of the producer
flattening a copy into the page content while the field reattach puts the
original appearance back beside it. Both halves were live defects here:

  - grayscale left the field painted twice AND the surviving `/AP` in
    DeviceRGB, so "convert to grayscale" returned a document with red in it;
  - compress left the field painted twice.

A widget carrying NO appearance was the same defect one step further along:
the producer synthesized one from `/V` and `/DA` and flattened THAT, and the
reattach restored the widget over it — so the flatten outlived the value it
was drawn from, and a later fill left the page painting the old value for
good. `regenerate_appearances_file` gives such a widget its appearance first,
through the emitters the fill uses, and it then rides the staging like any
other face: one author, one transform.

The prepress side of the same mechanism is pinned in `test_prepress.py`
(`TestFormAppearances`).
"""

import os
import subprocess
from pathlib import Path

import pikepdf
import pytest

from engine.compress import compress
from engine.grayscale import grayscale


def _content(path):
    with pikepdf.open(path) as pdf:
        return bytes(pdf.pages[0].Contents.read_bytes())


def _widgets(path):
    """{field name: {"value", "faces", "idents"}} — read out of the file rather
    than held open, so every assertion is about bytes on disk."""
    found = {}
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            for annot in list(page.obj.get("/Annots") or []):
                if annot.get("/Subtype") != pikepdf.Name("/Widget"):
                    continue
                faces, idents = {}, {}
                ap = annot.get("/AP")
                for key in list((ap or {}).keys()):
                    entry = ap[key]
                    streams = ([(key, entry)] if isinstance(entry, pikepdf.Stream)
                               else [(f"{key}{s}", entry[s])
                                     for s in list(entry.keys())])
                    for name, stream in streams:
                        faces[name] = bytes(stream.read_bytes())
                        idents[name] = (stream.objgen if stream.is_indirect
                                        else id(stream))
                found[str(annot.get("/T"))] = {
                    "value": str(annot.get("/V")),
                    "faces": faces,
                    "idents": idents,
                }
    return found


def _without_form(src, dest):
    """The same document with no /AcroForm — nothing is staged and nothing is
    reattached, which is the producer's own output: the control for what the
    transformed field is supposed to look like."""
    import warnings

    with pikepdf.open(src) as pdf:
        del pdf.Root["/AcroForm"]
        with warnings.catch_warnings():
            # The orphan widget left behind is the POINT of this control.
            warnings.simplefilter("ignore", pikepdf.PageCopyWarning)
            pdf.save(str(dest))
    return str(dest)


def _raster(path, gs_path, out_dir, resolution: int = 72):
    """Page 1 as the producer draws it, appearances included."""
    np = pytest.importorskip("numpy")
    Image = pytest.importorskip("PIL.Image")

    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(str(out_dir), "page-%d.png")
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         f"-r{resolution}", f"-sOutputFile={target}", str(path)],
        check=True, capture_output=True, stdin=subprocess.DEVNULL, timeout=300,
    )
    with Image.open(Path(out_dir) / "page-1.png") as im:
        return np.asarray(im.convert("RGB"), dtype=np.int16)


def _gray(src, dest, gs_path):
    grayscale(src, str(dest), gs_path=gs_path)
    return str(dest)


def _small(src, dest, gs_path):
    compress(src, str(dest), quality="ebook", gs_path=gs_path)
    return str(dest)


class TestGrayscaleWidgetFaces:
    def test_the_field_is_painted_once_and_in_gray(self, tmp_path, gs_path):
        from separation_builders import (FORM_FILL_GRAY, FORM_FILL_RGB,
                                         FORM_PAGE_GRAY, FORM_TEXT_GRAY,
                                         FORM_TEXT_RGB, form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        page = _content(out)
        # The page converted — the control that says the pass ran.
        assert FORM_PAGE_GRAY in page
        # …and it carries no copy of the field. The flattened copy used to sit
        # here, under the appearance's own /Tx marked content.
        assert FORM_FILL_GRAY not in page, "the field is painted twice"
        assert FORM_TEXT_GRAY not in page, "the field is painted twice"
        assert b"/Tx BMC" not in page

        field = _widgets(out)["field1"]
        faces = field["faces"]
        assert list(faces) == ["/N"]
        # The one painter left carries gray operands and no DeviceRGB at all:
        # this is the half that used to come back verbatim.
        assert FORM_FILL_GRAY in faces["/N"]
        assert FORM_TEXT_GRAY in faces["/N"]
        assert FORM_FILL_RGB not in faces["/N"]
        assert FORM_TEXT_RGB not in faces["/N"]
        assert b" rg" not in faces["/N"]
        assert field["value"] == "Hello"
        with pikepdf.open(out) as pdf:
            assert len(pdf.Root.AcroForm.Fields) == 1
            assert len(pdf.pages) == 1, "a staged appearance page was left behind"

    def test_the_appearance_lands_where_the_producer_put_it(
            self, tmp_path, gs_path):
        # The producer's own flattened output is the reference rendering of the
        # converted field: same command, same transform, no staging and no
        # reattach. A harvested appearance that moved, scaled or changed colour
        # shows up as a pixel difference here.
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)
        control = _gray(_without_form(src, tmp_path / "noform.pdf"),
                        tmp_path / "flat-gray.pdf", gs_path)

        produced = _raster(out, gs_path, tmp_path / "r-after")
        reference = _raster(control, gs_path, tmp_path / "r-control")
        assert produced.shape == reference.shape
        assert int(abs(produced - reference).max()) == 0, (
            "the converted field did not land where the producer put it"
        )

    def test_every_face_is_converted_not_only_the_drawn_one(
            self, tmp_path, gs_path):
        # The producer flattens only the face /AS selects, so a mechanism built
        # on the flatten alone would leave every other face in DeviceRGB.
        from separation_builders import (FORM_DOWN_GRAY, FORM_FILL_GRAY,
                                         FORM_OFF_GRAY, FORM_TEXT_GRAY,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "states.pdf", "states")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        faces = _widgets(out)["check"]["faces"]
        assert sorted(faces) == ["/D/Off", "/D/On", "/N/Off", "/N/On"]
        expected = {"/N/On": FORM_FILL_GRAY, "/N/Off": FORM_OFF_GRAY,
                    "/D/On": FORM_DOWN_GRAY, "/D/Off": FORM_TEXT_GRAY}
        for name, body in faces.items():
            assert b" rg" not in body, f"{name} was never converted"
            assert expected[name] in body, f"{name} is not the producer's gray"
        assert b" rg" not in _content(out)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1, "four staged pages, none removed"

    def test_a_field_with_no_appearance_is_given_one_and_the_page_stays_clean(
            self, tmp_path, gs_path):
        # The widget is given the appearance its own field states BEFORE the
        # pass, so the producer has none to synthesize and flatten. What used
        # to be two painters — a flattened copy in the page and a restored
        # widget over it — is one, and it is the converted one.
        from separation_builders import (FORM_PAGE_GRAY, FORM_TEXT_GRAY,
                                         FORM_TEXT_RGB, form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        page = _content(out)
        assert FORM_PAGE_GRAY in page
        assert b"(Hello)" not in page, "the value is still flattened into the page"
        assert b"Tj" not in page
        assert b"/Tx BMC" not in page

        field = _widgets(out)["bare"]
        assert list(field["faces"]) == ["/N"]
        assert b"(Hello)" in field["faces"]["/N"]
        # The one painter went through the pass: the /DA colour arrives as the
        # producer's gray, never as the DeviceRGB it was written in.
        assert FORM_TEXT_GRAY in field["faces"]["/N"]
        assert FORM_TEXT_RGB not in field["faces"]["/N"]
        assert b" rg" not in field["faces"]["/N"]
        assert field["value"] == "Hello"
        with pikepdf.open(out) as pdf:
            assert len(pdf.Root.AcroForm.Fields) == 1
            assert len(pdf.pages) == 1, "a staged appearance page was left behind"

    def test_a_bare_field_carries_no_stale_value_after_a_refill(
            self, tmp_path, gs_path):
        # The defect this replaces: the producer flattened the value the field
        # held AT CONVERSION TIME, and the reattach restored the widget over
        # it, so the flatten outlived the value it was drawn from. Refilling
        # moved the /AP and left the page painting the old one for good.
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"bare": "Ashgray"})

        page = _content(filled)
        assert b"(Hello)" not in page, "the page still paints the value it converted"
        assert b"(Ashgray)" not in page
        assert b"Tj" not in page
        field = _widgets(filled)["bare"]
        assert field["value"] == "Ashgray"
        assert b"(Ashgray)" in field["faces"]["/N"]

    def test_a_bare_field_with_nothing_to_show_is_left_alone(
            self, tmp_path, gs_path):
        # An empty value and no chrome is nothing to draw, and the producer
        # synthesizes nothing for it (measured) — so there is no flatten to
        # replace and no appearance worth inventing.
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "empty.pdf", "bare-empty")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        assert b"Tj" not in _content(out)
        field = _widgets(out)["bare"]
        assert field["faces"] == {}
        assert field["value"] == ""

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"bare": "Ashgray"})
        assert b"Tj" not in _content(filled), "the empty field left a painter behind"
        assert b"(Ashgray)" in _widgets(filled)["bare"]["faces"]["/N"]

    def test_a_bare_field_keeps_the_chrome_the_flatten_carried(
            self, tmp_path, gs_path):
        # /MK states a background and a border independently of any value
        # (ISO 32000-2 12.5.6.19), and the producer flattens those too. An
        # appearance regenerated without them would take the widget out of the
        # producer's input and lose the box it was authored with.
        from separation_builders import (FORM_BG_GRAY, FORM_BORDER_GRAY,
                                         FORM_TEXT_GRAY, form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "chrome.pdf", "bare-chrome")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        assert b"Tj" not in _content(out)
        face = _widgets(out)["bare"]["faces"]["/N"]
        assert FORM_BG_GRAY in face, "the background the producer flattened is gone"
        assert FORM_BORDER_GRAY in face, "the border the producer flattened is gone"
        assert FORM_TEXT_GRAY in face
        assert b" rg" not in face and b" RG" not in face

    def test_a_bare_choice_draws_every_row_the_flatten_never_had(
            self, tmp_path, gs_path):
        # The producer synthesizes only the SELECTED row of a list box
        # (measured), so an appearance taken from that flatten is missing every
        # row the user can scroll to. The field's own emitter draws the list.
        from separation_builders import (FORM_OPTIONS, FORM_TEXT_GRAY,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "choice.pdf", "bare-choice")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        page = _content(out)
        widgets = _widgets(out)
        for option in FORM_OPTIONS:
            assert f"({option})".encode("ascii") not in page
        assert b"(Beta)" in widgets["combo"]["faces"]["/N"]
        rows = widgets["list"]["faces"]["/N"]
        for option in FORM_OPTIONS:
            assert f"({option})".encode("ascii") in rows, f"{option} is not drawn"
        assert FORM_TEXT_GRAY in rows
        assert b" rg" not in rows

    def test_bare_buttons_keep_the_producers_own_nothing(
            self, tmp_path, gs_path):
        # A check box or radio button draws through the /AP states it was
        # authored with and states nothing a value could be drawn from. The
        # producer synthesizes nothing for one carrying none (measured), so
        # there is no flatten here and no appearance to invent.
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "buttons.pdf", "bare-button")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        assert b"Tj" not in _content(out)
        widgets = _widgets(out)
        assert widgets["check"]["faces"] == {}
        assert widgets["radio"]["faces"] == {}
        assert widgets["check"]["value"] == "/Yes"
        assert widgets["radio"]["value"] == "/A"

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"check": False})
        assert b"Tj" not in _content(filled)
        assert _widgets(filled)["check"]["value"] == "/Off"

    def test_a_shared_appearance_is_converted_once(self, tmp_path, gs_path):
        # Two widgets wearing one stream is one appearance: staged once,
        # converted once, and still one object afterwards.
        from separation_builders import FORM_FILL_GRAY, form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "shared.pdf", "shared")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        widgets = _widgets(out)
        assert sorted(widgets) == ["first", "second"]
        assert (widgets["first"]["idents"]["/N"]
                == widgets["second"]["idents"]["/N"])
        assert FORM_FILL_GRAY in widgets["first"]["faces"]["/N"]
        assert FORM_FILL_GRAY not in _content(out)

    def test_the_field_still_fills_after_the_conversion(self, tmp_path, gs_path):
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _gray(src, tmp_path / "gray.pdf", gs_path)

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"field1": "Goodbye"})
        field = _widgets(filled)["field1"]
        assert field["value"] == "Goodbye"
        assert b"(Goodbye)" in field["faces"]["/N"]


class TestCompressWidgetFaces:
    """Compress runs no colour conversion, so what it does to a staged face is
    a RE-ENCODE: the producer renormalizes the content (a leading
    `0.1` scale with the coordinates multiplied out, its own resource names,
    `Td` rewritten as `Tm`) and recompresses it, and every colour operand comes
    through in the same space. The defect here was the double paint alone.

    The operands are requantized onto the producer's own 16-bit grid, so these
    fixtures paint in exact 0 and 1 components: `0.9` comes back `0.900391`.
    """

    def test_the_field_is_painted_once(self, tmp_path, gs_path):
        from separation_builders import (FORM_FILL_RGB, FORM_PAGE_RGB,
                                         FORM_TEXT_RGB, form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        page = _content(out)
        assert FORM_PAGE_RGB in page, "the page's own paint did not survive"
        assert FORM_FILL_RGB not in page, "the field is painted twice"
        assert FORM_TEXT_RGB not in page, "the field is painted twice"
        assert b"/Tx BMC" not in page

        field = _widgets(out)["field1"]
        assert list(field["faces"]) == ["/N"]
        assert field["value"] == "Hello"
        with pikepdf.open(out) as pdf:
            assert len(pdf.Root.AcroForm.Fields) == 1
            assert len(pdf.pages) == 1, "a staged appearance page was left behind"

    def test_the_face_is_re_encoded_and_keeps_its_operands(
            self, tmp_path, gs_path):
        # The measurement this op's adoption rests on: a staged face comes back
        # through the producer with the SAME colour operands and DIFFERENT
        # bytes. Same operands would be no reason to route it through at all if
        # the bytes were also the same — but they are the producer's, which is
        # what makes the harvested face the one the page would have carried.
        from separation_builders import (FORM_FILL_RGB, FORM_TEXT_RGB,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        original = _widgets(src)["field1"]["faces"]["/N"]
        face = _widgets(out)["field1"]["faces"]["/N"]
        assert FORM_FILL_RGB in face
        assert FORM_TEXT_RGB in face
        assert b" k" not in face and b" g\n" not in face
        assert face != original, "the face never went through the producer"
        assert b"/Helv" not in face, "the producer renames its own resources"

    def test_the_appearance_lands_where_the_producer_put_it(
            self, tmp_path, gs_path):
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _small(src, tmp_path / "small.pdf", gs_path)
        control = _small(_without_form(src, tmp_path / "noform.pdf"),
                         tmp_path / "flat-small.pdf", gs_path)

        produced = _raster(out, gs_path, tmp_path / "r-after")
        reference = _raster(control, gs_path, tmp_path / "r-control")
        assert produced.shape == reference.shape
        assert int(abs(produced - reference).max()) == 0, (
            "the recompressed field did not land where the producer put it"
        )

    def test_every_face_comes_through_not_only_the_drawn_one(
            self, tmp_path, gs_path):
        from separation_builders import (FORM_DOWN_RGB, FORM_FILL_RGB,
                                         FORM_OFF_RGB, FORM_TEXT_RGB,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "states.pdf", "states")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        faces = _widgets(out)["check"]["faces"]
        assert sorted(faces) == ["/D/Off", "/D/On", "/N/Off", "/N/On"]
        expected = {"/N/On": FORM_FILL_RGB, "/N/Off": FORM_OFF_RGB,
                    "/D/On": FORM_DOWN_RGB, "/D/Off": FORM_TEXT_RGB}
        for name, body in faces.items():
            assert expected[name] in body, f"{name} lost its own paint"
        # Only the page's own fill is left in the page content.
        assert _content(out).count(b" rg") == 1
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1, "four staged pages, none removed"

    def test_a_field_with_no_appearance_is_given_one_and_the_page_stays_clean(
            self, tmp_path, gs_path):
        from separation_builders import (FORM_PAGE_RGB, FORM_TEXT_RGB,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        page = _content(out)
        assert FORM_PAGE_RGB in page
        assert b"(Hello)" not in page, "the value is still flattened into the page"
        assert b"Tj" not in page
        assert b"/Tx BMC" not in page

        field = _widgets(out)["bare"]
        assert list(field["faces"]) == ["/N"]
        assert b"(Hello)" in field["faces"]["/N"]
        # Compress converts nothing, so the /DA colour comes back in its own
        # space — the single painter is the point here, not a changed operand.
        assert FORM_TEXT_RGB in field["faces"]["/N"]
        assert field["value"] == "Hello"
        with pikepdf.open(out) as pdf:
            assert len(pdf.Root.AcroForm.Fields) == 1
            assert len(pdf.pages) == 1, "a staged appearance page was left behind"

    def test_a_bare_field_carries_no_stale_value_after_a_refill(
            self, tmp_path, gs_path):
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"bare": "Squeezed"})

        page = _content(filled)
        assert b"(Hello)" not in page, "the page still paints the value it compressed"
        assert b"(Squeezed)" not in page
        assert b"Tj" not in page
        field = _widgets(filled)["bare"]
        assert field["value"] == "Squeezed"
        assert b"(Squeezed)" in field["faces"]["/N"]

    def test_a_bare_field_with_nothing_to_show_is_left_alone(
            self, tmp_path, gs_path):
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "empty.pdf", "bare-empty")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        assert b"Tj" not in _content(out)
        field = _widgets(out)["bare"]
        assert field["faces"] == {}
        assert field["value"] == ""

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"bare": "Squeezed"})
        assert b"Tj" not in _content(filled), "the empty field left a painter behind"
        assert b"(Squeezed)" in _widgets(filled)["bare"]["faces"]["/N"]

    def test_a_bare_field_keeps_the_chrome_the_flatten_carried(
            self, tmp_path, gs_path):
        from separation_builders import (FORM_BG_RGB, FORM_BORDER_RGB,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "chrome.pdf", "bare-chrome")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        assert b"Tj" not in _content(out)
        face = _widgets(out)["bare"]["faces"]["/N"]
        assert FORM_BG_RGB in face, "the background the producer flattened is gone"
        assert FORM_BORDER_RGB in face, "the border the producer flattened is gone"

    def test_a_bare_choice_draws_every_row_the_flatten_never_had(
            self, tmp_path, gs_path):
        from separation_builders import FORM_OPTIONS, form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "choice.pdf", "bare-choice")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        page = _content(out)
        widgets = _widgets(out)
        for option in FORM_OPTIONS:
            assert f"({option})".encode("ascii") not in page
        assert b"(Beta)" in widgets["combo"]["faces"]["/N"]
        rows = widgets["list"]["faces"]["/N"]
        for option in FORM_OPTIONS:
            assert f"({option})".encode("ascii") in rows, f"{option} is not drawn"

    def test_bare_buttons_keep_the_producers_own_nothing(
            self, tmp_path, gs_path):
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "buttons.pdf", "bare-button")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        assert b"Tj" not in _content(out)
        widgets = _widgets(out)
        assert widgets["check"]["faces"] == {}
        assert widgets["radio"]["faces"] == {}
        assert widgets["check"]["value"] == "/Yes"
        assert widgets["radio"]["value"] == "/A"

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"check": False})
        assert b"Tj" not in _content(filled)
        assert _widgets(filled)["check"]["value"] == "/Off"

    def test_a_shared_appearance_comes_through_once(self, tmp_path, gs_path):
        from separation_builders import FORM_FILL_RGB, form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "shared.pdf", "shared")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        widgets = _widgets(out)
        assert sorted(widgets) == ["first", "second"]
        assert (widgets["first"]["idents"]["/N"]
                == widgets["second"]["idents"]["/N"])
        assert FORM_FILL_RGB in widgets["first"]["faces"]["/N"]
        assert FORM_FILL_RGB not in _content(out)

    def test_the_field_still_fills_after_the_compression(self, tmp_path, gs_path):
        from engine.forms import fill_form_fields
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        out = _small(src, tmp_path / "small.pdf", gs_path)

        filled = str(tmp_path / "filled.pdf")
        fill_form_fields(out, filled, {"field1": "Goodbye"})
        field = _widgets(filled)["field1"]
        assert field["value"] == "Goodbye"
        assert b"(Goodbye)" in field["faces"]["/N"]


class TestStagingIsScaffoldingOnly:
    """A document with no form field must reach the producer untouched — the
    staging is the only thing standing between these ops and their old
    behaviour, and it has to be inert wherever there is nothing to stage."""

    def test_a_document_with_no_form_stages_nothing(self, tmp_path):
        from engine.widget_faces import stage_appearances_file
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        _without_form(src, tmp_path / "noform.pdf")
        staged, boxes = stage_appearances_file(
            Path(tmp_path / "noform.pdf"), tmp_path)
        assert staged is None and boxes == []
        assert not (tmp_path / "staged.pdf").exists()

    def test_a_form_with_no_appearance_stages_nothing_until_it_has_one(
            self, tmp_path):
        # Staging pairs pages back to FACES, so a widget carrying none has
        # nothing to stage. Regenerating first is what gives it one — the two
        # steps are ordered, not merged, because the regenerated file is also
        # what every later read of the document takes.
        from engine.widget_faces import (regenerate_appearances_file,
                                         stage_appearances_file)
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        staged, boxes = stage_appearances_file(Path(src), tmp_path)
        assert staged is None and boxes == []

        regenerated = regenerate_appearances_file(Path(src), tmp_path)
        assert regenerated is not None
        staged, boxes = stage_appearances_file(regenerated, tmp_path)
        assert staged is not None and len(boxes) == 1

    def test_a_document_with_no_form_regenerates_nothing(self, tmp_path):
        from engine.widget_faces import regenerate_appearances_file
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        _without_form(src, tmp_path / "noform.pdf")
        assert regenerate_appearances_file(
            Path(tmp_path / "noform.pdf"), tmp_path) is None
        assert not (tmp_path / "regenerated.pdf").exists()

    def test_a_widget_that_already_has_an_appearance_regenerates_nothing(
            self, tmp_path):
        # The regeneration is for the widget that states no appearance at all.
        # One that has an /AP already has its author, and re-authoring it would
        # replace the document's own drawing with this app's idea of it.
        from engine.widget_faces import regenerate_appearances_file
        from separation_builders import form_appearance_pdf

        for kind in ("text", "states", "shared"):
            src = form_appearance_pdf(tmp_path / f"{kind}.pdf", kind)
            assert regenerate_appearances_file(Path(src), tmp_path) is None, kind

    def test_a_bare_button_regenerates_nothing(self, tmp_path):
        from engine.widget_faces import regenerate_appearances_file
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "buttons.pdf", "bare-button")
        assert regenerate_appearances_file(Path(src), tmp_path) is None

    def test_grayscale_in_place_harvests_and_keeps_the_form(self, tmp_path, gs_path):
        # In-place, the producer writes a STAGED target and the original stays
        # readable until the rename — which is what both the harvest's source
        # copy and the field reattach read.
        from separation_builders import (FORM_FILL_GRAY, FORM_FILL_RGB,
                                         form_appearance_pdf)

        src = form_appearance_pdf(tmp_path / "form.pdf")
        grayscale(src, src, gs_path=gs_path)

        page = _content(src)
        assert b"/Tx BMC" not in page and FORM_FILL_GRAY not in page
        field = _widgets(src)["field1"]
        assert FORM_FILL_GRAY in field["faces"]["/N"]
        assert FORM_FILL_RGB not in field["faces"]["/N"]
        assert field["value"] == "Hello"

    def test_compress_in_place_harvests_and_keeps_the_form(self, tmp_path, gs_path):
        from separation_builders import FORM_FILL_RGB, form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "form.pdf")
        compress(src, src, quality="ebook", gs_path=gs_path)

        page = _content(src)
        assert b"/Tx BMC" not in page and FORM_FILL_RGB not in page
        field = _widgets(src)["field1"]
        assert FORM_FILL_RGB in field["faces"]["/N"]
        assert field["value"] == "Hello"

    def test_a_bare_field_survives_an_in_place_conversion(self, tmp_path, gs_path):
        # The regeneration reads the input BEFORE the producer runs and writes
        # its copy into the scratch dir, so in place the original is still the
        # only readable source at that moment and the copy — not the file being
        # written over — is what every later read takes.
        from separation_builders import FORM_TEXT_GRAY, form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        grayscale(src, src, gs_path=gs_path)

        page = _content(src)
        assert b"(Hello)" not in page and b"Tj" not in page
        field = _widgets(src)["bare"]
        assert b"(Hello)" in field["faces"]["/N"]
        assert FORM_TEXT_GRAY in field["faces"]["/N"]
        assert field["value"] == "Hello"

    def test_a_bare_field_survives_an_in_place_compression(self, tmp_path, gs_path):
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "bare.pdf", "bare")
        compress(src, src, quality="ebook", gs_path=gs_path)

        page = _content(src)
        assert b"(Hello)" not in page and b"Tj" not in page
        field = _widgets(src)["bare"]
        assert b"(Hello)" in field["faces"]["/N"]
        assert field["value"] == "Hello"

    def test_staging_drops_the_widget_and_adds_one_page_per_face(self, tmp_path):
        from engine.widget_faces import stage_appearances_file
        from separation_builders import form_appearance_pdf

        src = form_appearance_pdf(tmp_path / "states.pdf", "states")
        staged, boxes = stage_appearances_file(Path(src), tmp_path)
        assert len(boxes) == 4
        with pikepdf.open(str(staged)) as pdf:
            assert len(pdf.pages) == 5
            assert list(pdf.pages[0].obj.get("/Annots") or []) == []
            for page in list(pdf.pages)[1:]:
                # ISO 32000-2 7.7.3.4: written, never inherited — an inherited
                # /Rotate turns the appearance sideways and an inherited
                # /CropBox cuts it.
                assert int(page.obj["/Rotate"]) == 0
                assert [float(v) for v in page.obj["/CropBox"]] == [0, 0, 40, 40]
