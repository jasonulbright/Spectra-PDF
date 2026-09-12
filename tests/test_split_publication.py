"""Real split outputs plus injected failures at the filesystem boundary."""
import importlib
import os
from pathlib import Path

import pikepdf
import pytest

writer = importlib.import_module('engine.split')


@pytest.fixture
def source(tmp_path):
    path = tmp_path / 'source.pdf'
    with pikepdf.Pdf.new() as pdf:
        for width in (200, 400, 600):
            pdf.add_blank_page(page_size=(width, 500))
        with pdf.open_outline() as outline:
            outline.root.extend([pikepdf.OutlineItem('First', 0), pikepdf.OutlineItem('Last', 2)])
        pdf.save(path)
    return path


MODES = [
    ('ranges', {'ranges': '1'}, 'split_1.pdf', [1]),
    ('every_n', {'every_n': 1}, 'source_1.pdf', [1, 1, 1]),
    ('size', {'max_mb': .0001}, 'source_1.pdf', [1, 1, 1]),
    ('bookmarks', {}, '001_First.pdf', [2, 1]),
]


@pytest.mark.parametrize('mode,params,first,counts', MODES)
@pytest.mark.parametrize('alias', [False, True])
def test_every_mode_preserves_source(source, mode, params, first, counts, alias):
    directory = source.parent / 'out'
    directory.mkdir()
    before = source.read_bytes()
    if alias:
        os.link(source, directory / first)
        with pytest.raises(ValueError, match='must not replace its source'):
            writer.split(str(source), output_dir=str(directory), mode=mode, **params)
        assert list(directory.iterdir()) == [directory / first]
    else:
        result = writer.split(str(source), output_dir=str(directory), mode=mode, **params)
        actual = []
        for name in result['outputs']:
            with pikepdf.open(name) as pdf:
                actual.append(len(pdf.pages))
        assert actual == counts
        assert result['retained_files'] == []
    assert source.read_bytes() == before


def test_exact_selected_name_does_not_touch_generated_sibling(source):
    sibling = source.parent / 'split_1.pdf'
    sibling.write_bytes(b'unselected existing file')
    selected = source.parent / 'Chosen report.pdf'
    result = writer.split(str(source), ranges='1', output=str(selected))
    assert result['outputs'] == [str(selected)]
    assert sibling.read_bytes() == b'unselected existing file'
    with pikepdf.open(selected) as pdf:
        assert len(pdf.pages) == 1


@pytest.mark.parametrize('hardlink', [False, True])
def test_exact_source_and_conflicting_destination_refuse(source, hardlink):
    before = source.read_bytes()
    target = source.parent / 'alias.pdf' if hardlink else source
    if hardlink:
        os.link(source, target)
    with pytest.raises(ValueError, match='must not replace its source'):
        writer.split(str(source), ranges='1', output=str(target))
    with pytest.raises(ValueError, match='either an exact'):
        writer.split(str(source), ranges='1', output=str(source), output_dir=str(source.parent))
    assert source.read_bytes() == before
    assert target.read_bytes() == before


def test_targets_cannot_alias_one_another(source):
    first = source.parent / 'source_1.pdf'
    first.write_bytes(b'existing destination')
    os.link(first, source.parent / 'source_2.pdf')
    with pytest.raises(ValueError, match='different files'):
        writer.split(str(source), output_dir=str(source.parent), mode='every_n', every_n=1)
    assert first.read_bytes() == b'existing destination'


@pytest.mark.parametrize('failure', ['render', 'publish', 'published-then-raised', 'backup-then-raised', 'restore', 'restored-then-raised'])
def test_publication_rollback_and_retained_recovery(source, monkeypatch, failure):
    directory = source.parent / 'out'
    directory.mkdir()
    originals = {directory / f'source_{n}.pdf': f'old file {n}'.encode() for n in (1, 2, 3)}
    for path, data in originals.items():
        path.write_bytes(data)
    before = source.read_bytes()
    render, replace, install = writer._render_part, os.replace, writer._install_new
    calls = {'render': 0, 'replace': 0}

    def failing_render(*args):
        calls['render'] += 1
        if failure == 'render' and calls['render'] == 2:
            raise ValueError('injected render failure')
        return render(*args)

    def failing_replace(src, dst, operation=replace):
        calls['replace'] += 1
        n = calls['replace']
        if (failure == 'published-then-raised' and n == 4 or
                failure == 'backup-then-raised' and n == 3):
            operation(src, dst)
            raise OSError('injected completed rename failure')
        if failure in ('publish', 'restore', 'restored-then-raised') and n == 4:
            raise OSError('injected publish failure')
        if failure == 'restore' and n == 5:
            raise OSError('injected restore failure')
        if failure == 'restored-then-raised' and n == 5:
            operation(src, dst)
            raise OSError('injected after completed restore')
        operation(src, dst)

    monkeypatch.setattr(writer, '_render_part', failing_render)
    monkeypatch.setattr(os, 'replace', failing_replace)
    monkeypatch.setattr(writer, '_install_new', lambda src, dst: failing_replace(src, dst, install))
    with pytest.raises((ValueError, OSError, RuntimeError)) as caught:
        writer.split(str(source), output_dir=str(directory), mode='every_n', every_n=1)
    assert source.read_bytes() == before
    for path, data in originals.items():
        if failure == 'restore' and path.name == 'source_2.pdf':
            backups = list(directory.glob('*.backup'))
            assert len(backups) == 1 and backups[0].read_bytes() == data
            assert str(backups[0]) in str(caught.value)
        else:
            assert path.read_bytes() == data
    assert not list(directory.glob('.spectra-split-*.pdf'))


@pytest.mark.parametrize('fail_render', [False, True])
def test_cleanup_cannot_hide_publication_outcome(source, monkeypatch, fail_render):
    selected = source.parent / 'result.pdf'
    selected.write_bytes(b'old result')
    unlink = Path.unlink

    def refuse_cleanup(path, *args, **kwargs):
        if path.name.startswith('.spectra-split-'):
            raise PermissionError('injected cleanup lock')
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'unlink', refuse_cleanup)
    if fail_render:
        def failed(*args):
            raise ValueError('original rendering error')
        monkeypatch.setattr(writer, '_render_part', failed)
        with pytest.raises(RuntimeError, match='retained recovery files') as caught:
            writer.split(str(source), ranges='1', output=str(selected))
        assert str(caught.value.__cause__) == 'original rendering error'
        assert selected.read_bytes() == b'old result'
    else:
        result = writer.split(str(source), ranges='1', output=str(selected))
        assert result['outputs'] == [str(selected)]
        assert any(Path(path).read_bytes() == b'old result' for path in result['retained_files'] if Path(path).exists())
        with pikepdf.open(selected) as pdf:
            assert len(pdf.pages) == 1


def test_source_change_while_staging_refuses_without_publication(source, monkeypatch):
    before = source.read_bytes()
    render = writer._render_part
    seen = []

    def changing_source(snapshot, pages):
        seen.append(snapshot)
        result = render(snapshot, pages)
        source.write_bytes(b'changed by another writer')
        return result

    monkeypatch.setattr(writer, '_render_part', changing_source)
    with pytest.raises(ValueError, match='source changed'):
        writer.split(str(source), output_dir=str(source.parent), mode='every_n', every_n=1)
    assert seen == [before] * 3
    assert not list(source.parent.glob('source_*.pdf'))
    assert source.read_bytes() == b'changed by another writer'


def test_empty_selection_never_materializes_zero_page_output(source):
    selected = source.parent / 'result.pdf'
    with pytest.raises(ValueError, match='selects no pages'):
        writer.split(str(source), ranges='99', output=str(selected))
    assert not selected.exists()


@pytest.mark.parametrize('preexisting', [False, True])
def test_newly_created_destination_is_never_overwritten(source, monkeypatch, preexisting):
    selected = source.parent / 'result.pdf'
    if preexisting:
        selected.write_bytes(b'old result')
    install = writer._install_new

    def concurrent_create(staged, target):
        target.write_bytes(b'new external file')
        install(staged, target)

    monkeypatch.setattr(writer, '_install_new', concurrent_create)
    with pytest.raises((OSError, RuntimeError)):
        writer.split(str(source), ranges='1', output=str(selected))
    assert selected.read_bytes() == b'new external file'
    backups = list(source.parent.glob('*.backup'))
    if preexisting:
        assert len(backups) == 1 and backups[0].read_bytes() == b'old result'
    else:
        assert backups == []


def test_damaged_backup_never_causes_deletion_of_the_only_surviving_output(source, monkeypatch):
    selected = source.parent / 'result.pdf'
    selected.write_bytes(b'old result')
    install = writer._install_new

    def damaged_recovery(staged, target):
        install(staged, target)
        for backup in source.parent.glob('*.backup'):
            backup.write_bytes(b'externally damaged backup')
        raise OSError('injected interrupted publication with damaged backup')

    monkeypatch.setattr(writer, '_install_new', damaged_recovery)
    with pytest.raises(RuntimeError, match='retained recovery files'):
        writer.split(str(source), ranges='1', output=str(selected))
    with pikepdf.open(selected) as pdf:
        assert len(pdf.pages) == 1
    backups = list(source.parent.glob('*.backup'))
    assert len(backups) == 1 and backups[0].read_bytes() == b'externally damaged backup'
