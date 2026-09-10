"""Optional content groups (layers)."""

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
    on = Array([g for g in (ocg1, ocg2) if g.objgen not in {r.objgen for r in off}])
    p.Root.OCProperties = Dictionary(OCGs=Array([ocg1, ocg2]), D=Dictionary(ON=on, OFF=off))
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
        assert list_layers(src) == {"layers": [], "count": 0,
                                    "processing_step_count": 0}

    def test_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _layered_pdf(src)
        set_layer_visibility(src, src, index=0, visible=False)
        assert list_layers(src)["layers"][0]["visible"] is False


@pytest.mark.parametrize('mode', ['scalar-root', 'missing-groups', 'scalar-groups', 'bad-group', 'duplicate',
                                 'missing-config', 'scalar-config', 'base-off', 'unknown-base', 'bad-name',
                                 'bad-on', 'foreign-off', 'overlap', 'bad-locked', 'bad-radio'])
def test_strict_layer_read_and_write_preserve_malformed_input(tmp_path, mode):
    src, output = tmp_path / 'source.pdf', tmp_path / 'output.pdf'
    _layered_pdf(str(src))
    with pikepdf.open(src) as pdf:
        ocp = pdf.Root.OCProperties
        if mode == 'scalar-root': pdf.Root.OCProperties = 42
        elif mode == 'missing-groups': del ocp.OCGs
        elif mode == 'scalar-groups': ocp.OCGs = 42
        elif mode == 'bad-group': ocp.OCGs[1] = 42
        elif mode == 'duplicate': ocp.OCGs.append(ocp.OCGs[0])
        elif mode == 'missing-config': del ocp.D
        elif mode == 'scalar-config': ocp.D = 42
        elif mode == 'base-off': ocp.D.BaseState = Name.OFF
        elif mode == 'unknown-base': ocp.D.BaseState = Name.Unknown
        elif mode == 'bad-name': ocp.OCGs[0].Name = 42
        elif mode == 'bad-on': ocp.D.ON = 42
        elif mode == 'foreign-off': ocp.D.OFF = Array([pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String('Foreign')))])
        elif mode == 'overlap': ocp.D.OFF = Array([ocp.OCGs[0]])
        elif mode == 'bad-locked': ocp.D.Locked = Array([42])
        elif mode == 'bad-radio': ocp.D.RBGroups = Array([42])
        pdf.save(output)
    malformed = output.read_bytes(); src.write_bytes(malformed); output.write_bytes(b'existing output')
    assert list_layers(str(src), for_edit=True)['complete'] is False
    with pytest.raises(ValueError, match='cannot be read completely'):
        set_layer_visibility(str(src), str(output), 0, False)
    assert src.read_bytes() == malformed and output.read_bytes() == b'existing output'


def test_strict_empty_and_duplicate_names(tmp_path):
    src = tmp_path / 'source.pdf'; _plain_pdf(str(src))
    assert list_layers(str(src), True) == {'layers': [], 'count': 0, 'processing_step_count': 0, 'complete': True}
    _layered_pdf(str(src))
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.Root.OCProperties.OCGs[1].Name = pdf.Root.OCProperties.OCGs[0].Name; pdf.save(src)
    assert list_layers(str(src), True)['complete'] is True
    set_layer_visibility(str(src), str(src), 1, False)
    assert [l['visible'] for l in list_layers(str(src), True)['layers']] == [True, False]


@pytest.mark.parametrize('index,visible', [(True, False), (0.1, False), ('0', False), (0, 'false'), (0, 0)])
def test_typed_layer_gesture(tmp_path, index, visible):
    src, out = tmp_path / 'source.pdf', tmp_path / 'output.pdf'; _layered_pdf(str(src)); out.write_bytes(b'kept')
    with pytest.raises(ValueError): set_layer_visibility(str(src), str(out), index, visible)
    assert out.read_bytes() == b'kept'


def test_locked_and_radio_group(tmp_path):
    src = tmp_path / 'source.pdf'; _layered_pdf(str(src), 1)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        ocp = pdf.Root.OCProperties; ocp.D.Locked = Array([ocp.OCGs[0]]); ocp.D.RBGroups = Array([ocp.OCGs]); pdf.save(src)
    before = src.read_bytes()
    assert list_layers(str(src), True)['layers'][0]['locked'] is True
    with pytest.raises(ValueError, match='locked'): set_layer_visibility(str(src), str(src), 0, False)
    with pytest.raises(ValueError, match='locked'): set_layer_visibility(str(src), str(src), 1, True)
    assert src.read_bytes() == before
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        del pdf.Root.OCProperties.D.Locked; pdf.save(src)
    set_layer_visibility(str(src), str(src), 1, True)
    assert [l['visible'] for l in list_layers(str(src), True)['layers']] == [False, True]


def test_locked_radio_peer_already_off_is_unchanged(tmp_path):
    src = tmp_path / 'source.pdf'; _layered_pdf(str(src), 0)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        ocp = pdf.Root.OCProperties; ocp.D.Locked = Array([ocp.OCGs[0]]); ocp.D.RBGroups = Array([ocp.OCGs]); pdf.save(src)
    set_layer_visibility(str(src), str(src), 1, True)
    assert [l['visible'] for l in list_layers(str(src), True)['layers']] == [False, True]


def test_aggregate_radio_reference_budget(tmp_path):
    src = tmp_path / 'source.pdf'; _layered_pdf(str(src))
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        ocp = pdf.Root.OCProperties
        for i in range(2): ocp.OCGs.append(pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String(str(i)))))
        ocp.D.RBGroups = Array([ocp.OCGs] * 8000); pdf.save(src)
    assert list_layers(str(src), True)['complete'] is False
