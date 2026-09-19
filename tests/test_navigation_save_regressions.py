"""Saved navigation, version declarations, and recovered trailers."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.links import set_link_target
from engine.merge import merge
from engine.outline import get_outline
from engine.pdf_save import save_pdf


@pytest.mark.parametrize('as_action', [False, True])
@pytest.mark.parametrize('wrapped', [False, True])
def test_legacy_bookmark_resolves_page_and_view(tmp_path, as_action, wrapped):
    pdf = pikepdf.new()
    pdf.add_blank_page()
    target = pdf.add_blank_page()
    destination = Array([target.obj, Name.XYZ, 12, 345, 1.5])
    pdf.Root.Dests = Dictionary(chapter=Dictionary(D=destination) if wrapped else destination)
    with pdf.open_outline() as outline:
        item = pikepdf.OutlineItem('Chapter')
        if as_action:
            item.action = Dictionary(S=Name.GoTo, D=Name('/chapter'))
        else:
            item.destination = Name('/chapter')
        outline.root.append(item)
    path = tmp_path / 'bookmarks.pdf'
    pdf.save(path)
    assert get_outline(str(path))['outline'] == [
        {'title': 'Chapter', 'page': 2, 'children': [], 'left': 12, 'top': 345, 'zoom': 1.5}]


@pytest.mark.parametrize('tree', [False, True])
def test_authored_destination_uses_its_declared_storage(tmp_path, tree):
    pdf = pikepdf.new()
    page = pdf.add_blank_page()
    other = pdf.add_blank_page()
    name = 'chapitre été'
    pdf.Root.Dests = Dictionary()
    pdf.Root.Dests['/' + name] = Array([other.obj, Name.Fit])
    if tree:
        names = pikepdf.NameTree.new(pdf)
        names[name] = Array([page.obj, Name.Fit])
        pdf.Root.Names = Dictionary(Dests=names.obj)
    page.Annots = Array([pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link,
        Rect=[0, 0, 10, 10], A=Dictionary(S=Name.URI, URI=String('https://example.com'))))])
    source, out = tmp_path / 'source.pdf', tmp_path / 'out.pdf'
    pdf.save(source)
    set_link_target(str(source), str(out), 1, 0, {'kind': 'named', 'name': name})
    with pikepdf.open(out) as saved:
        link = saved.pages[0].Annots[0]
        assert '/A' not in link
        if tree:
            assert isinstance(link.Dest, String)
            resolved = pikepdf.NameTree(saved.Root.Names.Dests)[str(link.Dest)]
            expected_page = saved.pages[0]
        else:
            assert isinstance(link.Dest, Name)
            resolved = saved.Root.Dests.get(link.Dest)
            expected_page = saved.pages[1]
        assert resolved[0].objgen == expected_page.obj.objgen


def test_merge_keeps_adbe_base_version_and_extension_level(tmp_path):
    sources = []
    for i, level in enumerate([3, 5]):
        pdf = pikepdf.new()
        pdf.add_blank_page()
        pdf.Root.Extensions = Dictionary(ADBE=Dictionary(BaseVersion=Name('/1.7'), ExtensionLevel=level))
        path = tmp_path / f'{i}.pdf'
        pdf.save(path, min_version=('1.7', level))
        sources.append(str(path))
    out = tmp_path / 'merged.pdf'
    merge(sources, str(out))
    with pikepdf.open(out) as pdf:
        assert pdf.pdf_version == '1.7'
        assert pdf.Root.Extensions.ADBE.BaseVersion == Name('/1.7')
        assert pdf.Root.Extensions.ADBE.ExtensionLevel == 5
        assert len(pdf.pages) == 2


@pytest.mark.parametrize('mode', [pikepdf.ObjectStreamMode.disable, pikepdf.ObjectStreamMode.generate])
def test_recovered_missing_size_is_written_as_the_actual_xref_size(mode):
    raw = (b'%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n'
           b'2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n'
           b'3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >> endobj\n'
           b'trailer << /Root 1 0 R >>\n%%EOF\n')
    with pikepdf.open(io.BytesIO(raw)) as pdf:
        assert '/Size' not in pdf.trailer
        out = io.BytesIO()
        save_pdf(pdf, out, object_stream_mode=mode)
    with pikepdf.open(out) as saved:
        assert saved.trailer.Size == max(obj.objgen[0] for obj in saved.objects) + 1
        assert len(saved.pages) == 1
    from pyhanko.pdf_utils.reader import PdfFileReader
    out.seek(0)
    assert PdfFileReader(out).root['/Pages']['/Count'] == 1


def test_action_audit_order_is_stable_across_processes(tmp_path):
    pdf = pikepdf.new()
    page = pdf.add_blank_page()
    def actions():
        return Dictionary({f'/{key}': Dictionary(S=Name.JavaScript, JS=String(key))
                           for key in ['U', 'D', 'O', 'C', 'Fo', 'Bl', 'E', 'X']})
    pdf.Root.AA = actions()
    page.AA = actions()
    page.Annots = Array([pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text,
        Rect=[0, 0, 10, 10], AA=actions()))])
    path = tmp_path / 'actions.pdf'
    pdf.save(path)
    code = ('import json,sys; from engine.sanitize import audit_hidden_information; '
            'r=audit_hidden_information(sys.argv[1],deep_text=False); '
            'print(json.dumps([c for c in r["categories"] if c["id"] in ("javascript","links_and_actions")],sort_keys=True))')
    outputs = []
    for seed in ['1', '2', '3']:
        env = {**os.environ, 'PYTHONHASHSEED': seed, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')}
        run = subprocess.run([sys.executable, '-c', code, str(path)], env=env,
                             capture_output=True, text=True, timeout=30)
        assert run.returncode == 0, run.stderr
        outputs.append(json.loads(run.stdout))
    assert outputs[0] == outputs[1] == outputs[2]
    assert next(c for c in outputs[0] if c['id'] == 'javascript')['count'] == 24
