"""Effective printing condition and version declarations survive page copies.

Every assertion reads SAVED bytes: a condition composed in memory and lost at
publication is the defect these cover.
"""
import hashlib

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.create_pdf import _subset
from engine.merge import merge
from engine.page_copy import copy_pages_with_forms
from engine.pdf_save import save_pdf
from engine.pdf_version import effective_version, parse_version
from engine.split import split

PROFILE = b'profile-bytes' * 512
OTHER_PROFILE = b'other-profile' * 512
PROFILE_SHA = hashlib.sha256(PROFILE).hexdigest()


def conditioned(path, *, pages=2, profile=PROFILE, condition='U.S. Web Coated (SWOP)',
                where='catalog', version=None, catalog_version=None, extensions=None,
                damage=None):
    with pikepdf.Pdf.new() as pdf:
        for _ in range(pages):
            page = pdf.add_blank_page(page_size=(200, 200))
            page.Contents = pdf.make_stream(b'0 0.5 0.5 0.1 k 20 20 160 160 re f')
        if where != 'none':
            stream = pdf.make_stream(profile, N=4)
            intent = pdf.make_indirect(Dictionary(
                Type=Name.OutputIntent, S=Name.GTS_PDFX,
                OutputConditionIdentifier=String(condition),
                Info=String('Preserved output color condition'),
                DestOutputProfile=stream))
            if damage == 'not-an-array':
                pdf.Root.OutputIntents = intent
            elif damage == 'empty':
                pdf.Root.OutputIntents = Array([])
            elif damage == 'no-subtype':
                del intent['/S']
                pdf.Root.OutputIntents = Array([intent])
            elif damage == 'profile-not-a-stream':
                intent.DestOutputProfile = Dictionary(N=4)
                pdf.Root.OutputIntents = Array([intent])
            elif damage == 'wrong-type':
                intent.Type = Name.Annot
                pdf.Root.OutputIntents = Array([intent])
            elif where == 'page':
                pdf.pages[0].OutputIntents = Array([intent])
            elif where == 'both':
                array = pdf.make_indirect(Array([intent]))
                pdf.Root.OutputIntents = array
                pdf.pages[0].OutputIntents = array
            else:
                pdf.Root.OutputIntents = Array([intent])
        if extensions is not None:
            pdf.Root.Extensions = extensions(pdf)
        if catalog_version is not None:
            pdf.Root.Version = Name('/' + catalog_version)
        pdf.save(path, min_version=version or '1.4')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def outlined(path):
    conditioned(path, pages=3)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        with pdf.open_outline() as outline:
            for index in range(3):
                outline.root.append(pikepdf.OutlineItem(f'part {index}', index))
        pdf.save(path)


def condition_of(pdf, index):
    """The effective condition of one saved page (ISO 32000-2, 14.11.5)."""
    array = pdf.pages[index].get('/OutputIntents') or pdf.Root.get('/OutputIntents')
    if array is None:
        return None
    intent = array[0]
    return (str(intent.OutputConditionIdentifier),
            hashlib.sha256(intent.DestOutputProfile.read_bytes()).hexdigest())


class TestDocumentDefaultCarry:
    def test_merge_of_one_source_keeps_the_document_condition(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        digest = conditioned(source)
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is not None
            for index in range(2):
                assert condition_of(pdf, index) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)
        assert hashlib.sha256(source.read_bytes()).hexdigest() == digest

    @pytest.mark.parametrize('mode,kwargs', [
        ('ranges', {'ranges': '1'}),
        ('every_n', {'every_n': 1}),
        ('size', {'max_mb': 0.001}),
        ('bookmarks', {}),
    ])
    def test_every_split_mode_keeps_the_document_condition(self, tmp_path, mode, kwargs):
        source = tmp_path / 'a.pdf'
        if mode == 'bookmarks':
            outlined(source)
        else:
            conditioned(source, pages=3)
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        result = split(str(source), mode=mode, output_dir=str(tmp_path / 'out'), **kwargs)
        assert result['outputs']
        for part in result['outputs']:
            with pikepdf.open(part) as pdf:
                for index in range(len(pdf.pages)):
                    assert condition_of(pdf, index) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)
        assert hashlib.sha256(source.read_bytes()).hexdigest() == digest

    def test_subset_keeps_the_document_condition(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, pages=3)
        assert _subset(source, output, '2-3', 'a.pdf') == 2
        with pikepdf.open(output) as pdf:
            assert condition_of(pdf, 0) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)

    def test_absence_stays_absent(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, where='none')
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is None
            assert condition_of(pdf, 0) is None
            assert effective_version(pdf) == (1, 4)

    def test_page_override_wins_over_the_document_default(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        with pikepdf.Pdf.new() as pdf:
            for _ in range(2):
                pdf.add_blank_page(page_size=(200, 200))
            def intent(profile):
                return pdf.make_indirect(Dictionary(
                    Type=Name.OutputIntent, S=Name.GTS_PDFX,
                    OutputConditionIdentifier=String('page condition' if profile is OTHER_PROFILE else 'doc condition'),
                    DestOutputProfile=pdf.make_stream(profile, N=4)))
            pdf.Root.OutputIntents = Array([intent(PROFILE)])
            pdf.pages[0].OutputIntents = Array([intent(OTHER_PROFILE)])
            pdf.Root.Version = Name('/2.0')
            pdf.save(source)
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert condition_of(pdf, 0)[0] == 'page condition'
            assert condition_of(pdf, 1)[0] == 'doc condition'

    def test_a_shared_array_is_not_forked_into_two_profiles(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, where='both')
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.pages[0].OutputIntents.objgen == pdf.Root.OutputIntents.objgen

    def test_repeated_and_reordered_pages_each_keep_their_condition(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, pages=2)
        with pikepdf.open(source) as src, pikepdf.Pdf.new() as dst:
            copy_pages_with_forms(dst, src, pages=[1, 0, 0])
            save_pdf(dst, str(output), drop_encryption=True)
        with pikepdf.open(output) as pdf:
            assert len(pdf.pages) == 3
            for index in range(3):
                assert condition_of(pdf, index) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)


class TestMixedSources:
    def test_equal_defaults_compose_into_one_document_condition(self, tmp_path):
        sources = [tmp_path / f's{n}.pdf' for n in range(2)]
        for path in sources:
            conditioned(path)
        output = tmp_path / 'out.pdf'
        merge([str(path) for path in sources], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is not None
            for index in range(4):
                assert pdf.pages[index].get('/OutputIntents') is None
                assert condition_of(pdf, index) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)

    def test_differing_defaults_stay_with_their_own_pages(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        conditioned(first)
        conditioned(second, profile=OTHER_PROFILE, condition='Coated FOGRA39')
        merge([str(first), str(second)], str(output))
        other = hashlib.sha256(OTHER_PROFILE).hexdigest()
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is None
            assert condition_of(pdf, 0) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)
            assert condition_of(pdf, 1) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)
            assert condition_of(pdf, 2) == ('Coated FOGRA39', other)
            assert condition_of(pdf, 3) == ('Coated FOGRA39', other)
            # A page-level entry is a PDF 2.0 feature (Table 31).
            assert effective_version(pdf) >= (2, 0)

    def test_a_source_without_a_condition_does_not_acquire_one(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        conditioned(first)
        conditioned(second, where='none')
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is None
            assert condition_of(pdf, 0) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)
            assert condition_of(pdf, 2) is None
            assert condition_of(pdf, 3) is None

    def test_an_overridden_source_contributes_no_default_requirement(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        conditioned(first)
        conditioned(second, pages=1, where='page', profile=OTHER_PROFILE,
                    condition='Coated FOGRA39', version='2.0')
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is not None
            assert condition_of(pdf, 0) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)
            assert condition_of(pdf, 2)[0] == 'Coated FOGRA39'

    @pytest.mark.parametrize('damage', [
        'not-an-array', 'empty', 'no-subtype', 'profile-not-a-stream', 'wrong-type'])
    def test_a_malformed_graph_refuses(self, tmp_path, damage):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        digest = conditioned(source, damage=damage)
        with pytest.raises(ValueError, match='output intent'):
            merge([str(source)], str(output))
        assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
        assert not output.exists()


class TestVersionDeclarations:
    @pytest.mark.parametrize('header,catalog,expected', [
        ('2.0', None, (2, 0)),
        ('1.4', '2.0', (2, 0)),
        ('1.7', None, (1, 7)),
    ])
    def test_a_contributing_version_is_never_downgraded(self, tmp_path, header, catalog, expected):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, where='page' if expected >= (2, 0) else 'catalog',
                    version=header, catalog_version=catalog)
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert effective_version(pdf) >= expected
            assert condition_of(pdf, 0) == ('U.S. Web Coated (SWOP)', PROFILE_SHA)

    def test_the_highest_contributing_version_wins(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        conditioned(first, version='1.4')
        conditioned(second, version='1.7')
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert effective_version(pdf) >= parse_version('1.7')

    def test_no_layer_is_needed_for_a_version_to_carry(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, where='none', version='1.7')
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OCProperties') is None
            assert effective_version(pdf) >= (1, 7)

    def test_a_plain_old_source_is_not_inflated(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, where='none', version='1.3')
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert effective_version(pdf) == (1, 3)


def extension(level, base='1.7', url=None):
    def build(pdf):
        declaration = Dictionary(BaseVersion=Name('/' + base), ExtensionLevel=level)
        if url is not None:
            declaration.URL = String(url)
        return Dictionary(SPCT=pdf.make_indirect(declaration))
    return build


class TestExtensionDeclarations:
    def test_a_declaration_is_carried(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, extensions=extension(3))
        merge([str(source)], str(output))
        with pikepdf.open(output) as pdf:
            assert int(pdf.Root.Extensions.SPCT.ExtensionLevel) == 3
            assert str(pdf.Root.Extensions.SPCT.BaseVersion) == '/1.7'
            assert effective_version(pdf) >= (1, 7)

    def test_the_higher_extension_level_supersedes(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        conditioned(first, extensions=extension(3))
        conditioned(second, extensions=extension(8))
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert int(pdf.Root.Extensions.SPCT.ExtensionLevel) == 8

    @pytest.mark.parametrize('other', [extension(3, base='2.0'), extension(3, url='http://x')])
    def test_one_prefix_claimed_by_two_extensions_refuses(self, tmp_path, other):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        conditioned(first, extensions=extension(3))
        conditioned(second, extensions=other)
        with pytest.raises(ValueError, match='version declarations'):
            merge([str(first), str(second)], str(output))
        assert not output.exists()

    def test_a_malformed_declaration_refuses(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        conditioned(source, extensions=lambda pdf: Dictionary(SPCT=Dictionary(
            BaseVersion=Name('/1.7'), ExtensionLevel=String('three'))))
        with pytest.raises(ValueError, match='version declarations'):
            merge([str(source)], str(output))
