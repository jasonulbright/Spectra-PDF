"""§ I.6 — optional content groups (layers)."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.layers import list_layers, set_layer_visibility


def _layered_pdf(path: str, off_index: int | None = None) -> None:
    p = pikepdf.new()
    p.add_blank_page(page_size=(200, 200))
    ocg1 = p.make_indirect(Dictionary(Type=Name.OCG, Name=String("Layer One")))
    ocg2 = p.make_indirect(Dictionary(Type=Name.OCG, Name=String("Layer Two")))
    off = Array([ocg2]) if off_index == 1 else (Array([ocg1]) if off_index == 0 else Array([]))
    p.Root.OCProperties = Dictionary(OCGs=Array([ocg1, ocg2]), D=Dictionary(ON=Array([ocg1, ocg2]), OFF=off))
    p.save(path)
    p.close()


def _plain_pdf(path: str) -> None:
    p = pikepdf.new()
    p.add_blank_page(page_size=(200, 200))
    p.save(path)
    p.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestLayers:
    def test_list_all_visible(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src)
        r = list_layers(src)
        assert r["count"] == 2
        assert [(l["index"], l["name"], l["visible"]) for l in r["layers"]] == [
            (0, "Layer One", True), (1, "Layer Two", True)
        ]

    def test_list_reflects_off_array(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src, off_index=1)
        r = list_layers(src)
        assert r["layers"][0]["visible"] is True
        assert r["layers"][1]["visible"] is False

    def test_hide_then_show(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src)
        hid = os.path.join(tmp_dir, "hid.pdf")
        set_layer_visibility(src, hid, index=0, visible=False)
        assert list_layers(hid)["layers"][0]["visible"] is False
        assert list_layers(hid)["layers"][1]["visible"] is True  # sibling untouched
        shown = os.path.join(tmp_dir, "shown.pdf")
        set_layer_visibility(hid, shown, index=0, visible=True)
        assert list_layers(shown)["layers"][0]["visible"] is True

    def test_hide_moves_to_off_not_on(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        set_layer_visibility(src, out, index=1, visible=False)
        with pikepdf.open(out) as pdf:
            d = pdf.Root.OCProperties.D
            on_gens = {o.objgen for o in (d.get("/ON") or [])}
            off_gens = {o.objgen for o in (d.get("/OFF") or [])}
            target = pdf.Root.OCProperties.OCGs[1].objgen
            assert target in off_gens and target not in on_gens  # in exactly one

    def test_out_of_range_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src)
        with pytest.raises(ValueError, match="out of range"):
            set_layer_visibility(src, os.path.join(tmp_dir, "o.pdf"), index=5, visible=False)

    def test_no_layers(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _plain_pdf(src)
        assert list_layers(src) == {"layers": [], "count": 0}

    def test_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src)
        set_layer_visibility(src, src, index=0, visible=False)
        assert list_layers(src)["layers"][0]["visible"] is False
