import io

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine.merge import merge
from engine.split import _render_part


def _js(pdf, code):
    return pdf.make_indirect(Dictionary(S=Name.JavaScript, JS=String(code)))


def _goto(pdf, page):
    return pdf.make_indirect(Dictionary(S=Name.GoTo, D=Array([pdf.pages[page].obj, Name.Fit])))


def _behaving(path, tag, n=3, open_page=None, open_action=None):
    pdf = pikepdf.Pdf.new()
    for _ in range(n):
        pdf.add_blank_page(page_size=(200, 200))
    jump = _goto(pdf, n - 1)
    jump.Next = _js(pdf, f'{tag}-after-jump')
    pdf.Root.Names = Dictionary(JavaScript=Dictionary(Names=Array([
        String('init'), _js(pdf, f'{tag}-init'),
        String('jump'), jump,
        String('only-jump'), _goto(pdf, n - 1),
    ])))
    pdf.Root.AA = Dictionary(WC=_js(pdf, f'{tag}-close'), DS=_goto(pdf, n - 1))
    if open_page is not None:
        pdf.Root.OpenAction = Array([pdf.pages[open_page].obj, Name.XYZ, 0, 200, 0])
    if open_action is not None:
        pdf.Root.OpenAction = open_action(pdf)
    pdf.save(path)


def _scripts(pdf):
    names = pdf.Root.Names.JavaScript.Names
    return {str(names[i]): names[i + 1] for i in range(0, len(names), 2)}


def _chain(action):
    out = []
    while isinstance(action, Dictionary):
        out.append(str(action.JS) if action.S == Name.JavaScript else ('goto', action.D[0].objgen))
        nxt = action.get('/Next')
        action = nxt[0] if isinstance(nxt, Array) and len(nxt) == 1 else nxt
    return out


def _index(pdf, page):
    return [p.obj.objgen for p in pdf.pages].index(page.objgen)


def test_merge_carries_scripts_with_suffix_on_collision(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _behaving(a, 'A')
    _behaving(b, 'B')
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        scripts = _scripts(pdf)
        assert sorted(scripts) == ['init', 'init.1', 'jump', 'jump.1', 'only-jump', 'only-jump.1']
        assert str(scripts['init'].JS) == 'A-init'
        assert str(scripts['init.1'].JS) == 'B-init'
        assert _index(pdf, scripts['jump.1'].D[0]) == 5


def test_merge_chains_document_events_in_contribution_order(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _behaving(a, 'A')
    _behaving(b, 'B')
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert _chain(pdf.Root.AA.WC) == ['A-close', 'B-close']
        ds = pdf.Root.AA.DS
        assert _index(pdf, ds.D[0]) == 2
        assert _index(pdf, ds.Next[0].D[0]) == 5


def test_merge_open_action_is_first_definer_and_retargeted(tmp_path):
    a, b, out = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
    _behaving(a, 'A', n=2)
    _behaving(b, 'B', open_page=1)
    merge([str(a), str(b)], str(out))
    with pikepdf.open(out) as pdf:
        assert _index(pdf, pdf.Root.OpenAction[0]) == 3
        assert pdf.Root.OpenAction[1] == Name.XYZ


def test_split_drops_jumps_to_removed_pages_and_keeps_the_rest(tmp_path):
    src = tmp_path / 'src.pdf'
    _behaving(src, 'A', open_page=2)
    with pikepdf.open(io.BytesIO(_render_part(str(src), [0, 1]))) as pdf:
        scripts = _scripts(pdf)
        assert sorted(scripts) == ['init', 'jump']
        assert _chain(scripts['jump']) == ['A-after-jump']
        assert _chain(pdf.Root.AA.WC) == ['A-close']
        assert '/DS' not in pdf.Root.AA
        assert '/OpenAction' not in pdf.Root


def test_split_keeps_an_open_action_on_a_kept_page(tmp_path):
    src = tmp_path / 'src.pdf'
    _behaving(src, 'A', open_action=lambda pdf: _goto(pdf, 2))
    with pikepdf.open(io.BytesIO(_render_part(str(src), [2]))) as pdf:
        assert _index(pdf, pdf.Root.OpenAction.D[0]) == 0
        assert sorted(_scripts(pdf)) == ['init', 'jump', 'only-jump']
        assert _chain(pdf.Root.AA.WC) == ['A-close']
        assert _index(pdf, pdf.Root.AA.DS.D[0]) == 0


def _with_scripts(path, build):
    pdf = pikepdf.Pdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(200, 200))
    pdf.Root.Names = Dictionary(JavaScript=Dictionary(Names=Array(build(pdf))))
    pdf.save(path)


def _members(action):
    seen, stack = set(), [action]
    while stack:
        item = stack.pop()
        if isinstance(item, Dictionary) and item.objgen not in seen:
            seen.add(item.objgen)
            nxt = item.get('/Next')
            stack.extend(list(nxt) if isinstance(nxt, Array) else [nxt] if nxt is not None else [])
    return seen


def test_cyclic_and_diamond_next_graphs_settle_once_per_action(tmp_path):
    src = tmp_path / 'src.pdf'

    def build(pdf):
        loop = _js(pdf, 'loop')
        loop.Next = Array([loop, loop])
        nodes = [_js(pdf, f'n{i}') for i in range(60)]
        for i in range(59):
            nodes[i].Next = Array([nodes[i + 1], nodes[i + 1]])
        nodes[59].Next = _goto(pdf, 2)
        return [String('diamond'), nodes[0], String('loop'), loop]

    _with_scripts(src, build)
    with pikepdf.open(io.BytesIO(_render_part(str(src), [0]))) as pdf:
        scripts = _scripts(pdf)
        loop = scripts['loop']
        assert [n.objgen for n in loop.Next] == [loop.objgen, loop.objgen]
        assert len(_members(scripts['diamond'])) == 60


def test_pruning_one_chain_leaves_a_shared_head_unchanged(tmp_path):
    src = tmp_path / 'src.pdf'

    def build(pdf):
        head, tail = _js(pdf, 'head'), _js(pdf, 'tail')
        jump = _goto(pdf, 2)
        jump.Next = Array([head, tail])
        return [String('a-head'), head, String('b-jump'), jump]

    _with_scripts(src, build)
    with pikepdf.open(io.BytesIO(_render_part(str(src), [0]))) as pdf:
        scripts = _scripts(pdf)
        assert '/Next' not in scripts['a-head']
        assert _chain(scripts['b-jump']) == ['head', 'tail']


def test_same_open_contributed_twice_settles_each_contribution_separately(tmp_path):
    from engine.page_copy import copy_pages_with_forms
    path = tmp_path / 'src.pdf'
    _behaving(path, 'A')
    with pikepdf.open(path) as src, pikepdf.Pdf.new() as dst:
        copy_pages_with_forms(dst, src, pages=[0])
        copy_pages_with_forms(dst, src, pages=[2])
        scripts = _scripts(dst)
        assert _chain(scripts['jump']) == ['A-after-jump']
        second = scripts['jump.1']
        assert second.S == Name.GoTo and _index(dst, second.D[0]) == 1
        assert _chain(dst.Root.AA.WC) == ['A-close', 'A-close']
