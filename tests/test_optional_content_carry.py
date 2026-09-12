"""Layer semantics survive engine copies, not just the catalog key."""
import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.merge import merge
from engine.page_copy import copy_pages_with_forms
from engine.optional_content import Budget, read_optional_content
from engine.split import split


def layered(path, *, off_base=False, alternate=True, aliases=False):
    with pikepdf.Pdf.new() as pdf:
        hidden = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String('same layer name')))
        shown = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String('visible')))
        membership = pdf.make_indirect(Dictionary(Type=Name.OCMD, OCGs=Array([hidden, shown]),
            P=Name.AllOn, VE=Array([Name.And, hidden, shown])))
        page = pdf.add_blank_page(page_size=(200, 200))
        form = pdf.make_stream(b'/OC /M BDC 1 0 0 rg 20 20 160 160 re f EMC',
            Type=Name.XObject, Subtype=Name.Form, BBox=Array([0, 0, 200, 200]),
            Resources=Dictionary(Properties=Dictionary(M=membership)))
        page.Resources = Dictionary(Properties=Dictionary(H=hidden), XObject=Dictionary(F=form))
        page.Contents = pdf.make_stream(b'/F Do')
        page.Annots = Array([pdf.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Square,
            Rect=Array([0, 0, 30, 30]), OC=hidden))])
        hidden.Usage = Dictionary(Export=Dictionary(ExportState=Name.OFF))
        default = pdf.make_indirect(Dictionary(BaseState=Name.OFF if off_base else Name.ON,
            ON=pdf.make_indirect(Array([shown])), OFF=pdf.make_indirect(Array([hidden])),
            Order=pdf.make_indirect(Array([Array([String(b'\xfe\xff\x00L'), hidden, shown])])),
            AS=pdf.make_indirect(Array([Dictionary(Event=Name.Export, Category=Array([Name.Export]), OCGs=Array([hidden])),
                                      Dictionary(Event=Name.View, Category=Array([Name.Zoom]))])),
            RBGroups=pdf.make_indirect(Array([Array([hidden, shown])])), Locked=pdf.make_indirect(Array([shown]))))
        configs = Array([pdf.make_indirect(Dictionary(Name='show hidden', BaseState=Name.ON,
            OFF=Array([shown]), ON=Array([hidden])))]) if alternate else Array()
        properties = pdf.make_indirect(Dictionary(OCGs=pdf.make_indirect(Array([hidden, shown])),
            D=default, Configs=pdf.make_indirect(configs)))
        pdf.Root.OCProperties = properties
        if aliases:
            shared = pdf.make_indirect(Dictionary(Owner=properties, Defaults=default, Hidden=default.OFF))
            shared.Self = shared
            hidden.Private = shared
            shown.Private = shared
        pdf.save(path)


def inspect(path):
    with pikepdf.open(path) as pdf:
        props = pdf.Root.OCProperties
        registered = {group.objgen for group in props.OCGs}
        hidden = []
        for page in pdf.pages:
            group = page.Resources.Properties.H
            assert group.objgen in registered
            assert page.Annots[0].OC.objgen == group.objgen
            member = page.Resources.XObject.F.Resources.Properties.M
            assert member.OCGs[0].objgen == group.objgen
            assert member.VE[1].objgen == group.objgen
            hidden.append(group.objgen)
        return dict(groups=registered, hidden=hidden, off={obj.objgen for obj in props.D.OFF},
                    configs=len(props.Configs))


@pytest.mark.parametrize('operation', ['merge', 'split'])
@pytest.mark.parametrize('off_base', [False, True])
def test_single_source_keeps_state_and_actual_identities(tmp_path, operation, off_base):
    source, output = tmp_path / 'source.pdf', tmp_path / 'output.pdf'
    layered(source, off_base=off_base, aliases=True)
    original = source.read_bytes()
    if operation == 'merge':
        merge([str(source)], str(output))
    else:
        split(str(source), ranges='1,1', output=str(output))
    result = inspect(output)
    assert set(result['hidden']) <= result['off']
    with pikepdf.open(output) as pdf:
        props = pdf.Root.OCProperties
        assert props.D.BaseState == (Name.OFF if off_base else Name.ON)
        assert props.OCGs[0].Private.Owner.objgen == props.objgen
        assert props.OCGs[0].Private.Defaults.objgen == props.D.objgen
        assert props.OCGs[0].Private.Hidden.objgen == props.D.OFF.objgen
        assert props.OCGs[0].Private.Self.objgen == props.OCGs[1].Private.objgen
        assert bytes(props.D.Order[0][0]) == b'\xfe\xff\x00L'
    assert source.read_bytes() == original


@pytest.mark.parametrize('number', [2, 3])
def test_combines_defaults_alternates_usage_and_aliases(tmp_path, number):
    sources = [tmp_path / f'source-{n}.pdf' for n in range(number)]
    for index, path in enumerate(sources):
        layered(path, off_base=bool(index % 2), aliases=True)
    originals = [path.read_bytes() for path in sources]
    output = tmp_path / 'combined.pdf'
    merge(list(map(str, sources)), str(output))
    result = inspect(output)
    assert len(result['groups']) == 2 * number
    assert len(set(result['hidden'])) == number
    assert set(result['hidden']) == result['off']
    assert result['configs'] == number
    with pikepdf.open(output) as pdf:
        props = pdf.Root.OCProperties
        assert len(props.D.AS) == 2 * number
        assert all('/OCGs' not in props.D.AS[n] for n in range(1, 2 * number, 2))
        assert len(props.D.RBGroups) == number and len(props.D.Locked) == number
        for index, config in enumerate(props.Configs):
            groups = {g.objgen for g in config.OFF}
            assert groups == (set(result['hidden']) - {result['hidden'][index]}) | {props.OCGs[index * 2 + 1].objgen}
            assert len(config.Order) == number and len(config.RBGroups) == number
            assert len(config.Locked) == number - 1  # no inheritance for alternate Locked
        for group in props.OCGs:
            assert group.Private.Owner.objgen == props.objgen
            assert group.Private.Defaults.objgen == props.D.objgen
            assert group.Private.Hidden.objgen == props.D.OFF.objgen
            assert group.Private.Self.objgen == group.Private.objgen
    assert [path.read_bytes() for path in sources] == originals


@pytest.mark.parametrize('mutation', ['unknown-base', 'unchanged-default', 'bad-base-type', 'conflicting-state',
    'unregistered-group', 'bad-membership', 'bad-usage', 'bad-order', 'bad-event', 'bad-category',
    'bad-locks', 'missing-default', 'page-payload', 'action-payload'])
def test_malformed_authority_refuses_without_touching_output(tmp_path, mutation):
    source, output = tmp_path / 'source.pdf', tmp_path / 'output.pdf'
    layered(source)
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        props, page = pdf.Root.OCProperties, pdf.pages[0]
        if mutation == 'unknown-base': props.D.BaseState = Name.Nonsense
        if mutation == 'unchanged-default': props.D.BaseState = Name.Unchanged
        if mutation == 'bad-base-type': props.D.BaseState = False
        if mutation == 'conflicting-state': props.D.ON = props.D.OFF
        if mutation == 'unregistered-group': props.OCGs = Array([props.OCGs[1]])
        if mutation == 'bad-membership': page.Resources.XObject.F.Resources.Properties.M.VE = Array([Name.Not, props.OCGs[0], props.OCGs[1]])
        if mutation == 'bad-usage': props.OCGs[0].Usage.View = Dictionary(ViewState=42)
        if mutation == 'bad-order': props.D.Order = 42
        if mutation == 'bad-event': props.D.AS[0].Event = Name.Nonsense
        if mutation == 'bad-category': props.D.AS[0].Category = Name.Export
        if mutation == 'bad-locks': props.D.Locked = Array([String('not a group')])
        if mutation == 'missing-default': del props['/D']
        if mutation == 'page-payload': props.Private = page.obj
        if mutation == 'action-payload': props.Private = Dictionary(S=Name.JavaScript, JS='do not run')
        pdf.save(source)
    original = source.read_bytes()
    output.write_bytes(b'unmodified destination')
    with pytest.raises(ValueError, match='Optional-content'):
        merge([str(source)], str(output))
    assert output.read_bytes() == b'unmodified destination'
    assert source.read_bytes() == original


@pytest.mark.parametrize('conflict', ['list-mode', 'intent', 'extension'])
def test_global_conflicts_refuse_before_publication(tmp_path, conflict):
    a, b, output = (tmp_path / name for name in ('a.pdf', 'b.pdf', 'out.pdf'))
    layered(a); layered(b)
    with pikepdf.open(a, allow_overwriting_input=True) as pdf:
        if conflict == 'list-mode': pdf.Root.OCProperties.D.ListMode = Name.VisiblePages
        if conflict == 'intent': pdf.Root.OCProperties.Configs[0].Intent = Array()
        if conflict == 'extension': pdf.Root.OCProperties.Custom = String('first meaning')
        pdf.save(a)
    if conflict == 'extension':
        with pikepdf.open(b, allow_overwriting_input=True) as pdf:
            pdf.Root.OCProperties.Custom = String('second meaning')
            pdf.save(b)
    output.write_bytes(b'old destination')
    with pytest.raises(ValueError, match='Optional-content'):
        merge([str(a), str(b)], str(output))
    assert output.read_bytes() == b'old destination'


def test_unlayered_copy_and_null_optional_values(tmp_path):
    source = tmp_path / 'source.pdf'
    layered(source)
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        props = pdf.Root.OCProperties
        props.OCGs.append(None)
        props.D.Locked = Array([None])
        props.D.AS.append(None)
        pdf.save(source)
    with pikepdf.open(source) as src, pikepdf.Pdf.new() as dst:
        copy_pages_with_forms(dst, src)
        assert dst.Root.OCProperties.OCGs[-1] is None
    with pikepdf.Pdf.new() as src, pikepdf.Pdf.new() as dst:
        src.add_blank_page()
        copy_pages_with_forms(dst, src)
        assert '/OCProperties' not in dst.Root


@pytest.mark.parametrize('kind', ['work', 'bytes', 'depth'])
def test_budget_exhaustion_is_a_refusal(tmp_path, kind):
    source = tmp_path / 'source.pdf'; layered(source)
    with pikepdf.open(source) as src:
        budget = Budget(work=5 if kind == 'work' else 200000, remaining_bytes=1 if kind == 'bytes' else 64000000)
        if kind == 'depth':
            node = String('leaf')
            for _ in range(70): node = Array([node])
            src.Root.OCProperties.Deep = node
        with pytest.raises(ValueError, match='Optional-content'):
            read_optional_content(src, list(src.pages), budget)


def test_equal_semantic_roles_remain_one_object(tmp_path):
    sources = [tmp_path / f'alias-{n}.pdf' for n in range(3)]
    for path in sources:
        layered(path, alternate=False)
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            props = pdf.Root.OCProperties
            props.D.Locked = props.D.ON
            props.OCGs[0].Alias = props.D.ON
            pdf.save(path)
    output = tmp_path / 'combined.pdf'
    merge(list(map(str, sources)), str(output))
    with pikepdf.open(output) as pdf:
        props = pdf.Root.OCProperties
        assert props.D.ON.objgen == props.D.Locked.objgen
        assert all(g.Alias.objgen == props.D.ON.objgen for g in props.OCGs[::2])


def test_layer_toggle_action_uses_the_registered_group(tmp_path):
    source, output = tmp_path / 'source.pdf', tmp_path / 'out.pdf'
    layered(source)
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        group = pdf.Root.OCProperties.OCGs[0]
        pdf.pages[0].Annots[0].A = pdf.make_indirect(Dictionary(
            S=Name.SetOCGState, State=Array([Name.Toggle, group]), PreserveRB=False))
        pdf.save(source)
    merge([str(source), str(source)], str(output))
    with pikepdf.open(output) as pdf:
        for index, page in enumerate(pdf.pages):
            action = page.Annots[0].A
            assert action.S == Name.SetOCGState and action.PreserveRB is False
            assert action.State[0] == Name.Toggle
            assert action.State[1].objgen == pdf.Root.OCProperties.OCGs[index * 2].objgen


def test_create_pdf_subset_uses_the_same_layer_authority(tmp_path):
    from engine.create_pdf import _subset
    source, output = tmp_path / 'source.pdf', tmp_path / 'out.pdf'
    layered(source)
    assert _subset(source, output, '1,1', 'source') == 2
    result = inspect(output)
    assert set(result['hidden']) == result['off']


def test_unchanged_alternate_preserves_only_its_unmentioned_groups(tmp_path):
    a, b, output = (tmp_path / n for n in ('a.pdf', 'b.pdf', 'out.pdf'))
    layered(a); layered(b)
    with pikepdf.open(a, allow_overwriting_input=True) as pdf:
        config = pdf.Root.OCProperties.Configs[0]
        config.BaseState = Name.Unchanged
        del config['/OFF']
        pdf.save(a)
    merge([str(a), str(b)], str(output))
    with pikepdf.open(output) as pdf:
        props = pdf.Root.OCProperties
        config = props.Configs[0]
        assert config.BaseState == Name.Unchanged
        assert {g.objgen for g in config.ON} == {props.OCGs[0].objgen, props.OCGs[3].objgen}
        assert {g.objgen for g in config.OFF} == {props.OCGs[2].objgen}


@pytest.mark.parametrize('role', ['membership', 'usage', 'radio', 'order'])
def test_scoped_group_array_cannot_expand_through_a_semantic_alias(tmp_path, role):
    a, b, output = (tmp_path / n for n in ('a.pdf', 'b.pdf', 'out.pdf'))
    layered(a); layered(b)
    with pikepdf.open(a, allow_overwriting_input=True) as pdf:
        props = pdf.Root.OCProperties
        shared = props.D.OFF
        if role == 'membership':
            member = pdf.pages[0].Resources.XObject.F.Resources.Properties.M
            member.OCGs = shared
            del member['/VE']
        if role == 'usage': props.D.AS[0].OCGs = shared
        if role == 'radio': props.D.RBGroups = Array([shared])
        if role == 'order': props.D.Order = Array([shared])
        pdf.save(a)
    original = a.read_bytes()
    output.write_bytes(b'preserve destination')
    # Alone, no expansion occurs and every original alias is faithful.
    merge([str(a)], str(tmp_path / 'faithful.pdf'))
    with pytest.raises(ValueError, match='Optional-content'):
        merge([str(a), str(b)], str(output))
    assert output.read_bytes() == b'preserve destination'
    assert a.read_bytes() == original


@pytest.mark.parametrize('declared', ['1.6', '2.0'])
def test_copied_layer_features_keep_their_effective_version(tmp_path, declared):
    from engine.pdf_version import effective_version, parse_version
    source, output = tmp_path / 'source.pdf', tmp_path / 'out.pdf'
    layered(source)
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        pdf.Root.Version = Name('/' + declared)
        pdf.save(source)
    merge([str(source)], str(output))
    with pikepdf.open(output) as pdf:
        assert effective_version(pdf) >= parse_version(declared)


@pytest.mark.parametrize('location', ['root', 'default', 'alternate'])
def test_equal_extension_data_compares_after_semantic_rebinding(tmp_path, location):
    sources = [tmp_path / f'extras-{n}.pdf' for n in range(3)]
    for path in sources:
        layered(path, alternate=location == 'alternate')
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            props = pdf.Root.OCProperties
            payload = pdf.make_indirect(Dictionary(Owner=props, Label=String('same meaning')))
            payload.Self = payload
            target = props if location == 'root' else props.D
            target.Custom = Dictionary(Inner=payload)
            if location == 'alternate': props.Configs[0].Custom = target.Custom
            props.OCGs[0].CustomAlias = payload
            pdf.save(path)
    output = tmp_path / 'out.pdf'
    merge(list(map(str, sources)), str(output))
    with pikepdf.open(output) as pdf:
        props = pdf.Root.OCProperties
        target = props if location == 'root' else props.D
        for group in props.OCGs[::2]:
            assert group.CustomAlias.Owner.objgen == props.objgen
            assert group.CustomAlias.objgen == target.Custom.Inner.objgen
            assert group.CustomAlias.Self.objgen == group.CustomAlias.objgen
