"""Effective printing condition and version declarations survive page copies.

Every assertion reads SAVED bytes: a condition composed in memory and lost at
publication is the defect these cover.
"""
import hashlib
from pathlib import Path

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.create_pdf import _subset, create_pdf
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


ICC_DIR = Path(__file__).resolve().parents[1] / 'resources' / 'icc'


def real_profile(name):
    path = ICC_DIR / name
    if path.is_file():
        return path.read_bytes()
    return name.encode() * 512


SWOP = real_profile('USWebCoatedSWOP.icc')
FOGRA = real_profile('CoatedFOGRA39.icc')


def intents_file(path, entries, *, pages=2, where='catalog', version='1.4'):
    """``entries`` is a list of (subtype, condition, profile bytes)."""
    with pikepdf.Pdf.new() as pdf:
        for _ in range(pages):
            pdf.add_blank_page(page_size=(200, 200))
        array = Array([pdf.make_indirect(Dictionary(
            Type=Name.OutputIntent, S=Name('/' + subtype),
            OutputConditionIdentifier=String(condition),
            DestOutputProfile=pdf.make_stream(profile, N=4)))
            for subtype, condition, profile in entries])
        if where == 'page':
            pdf.pages[0].OutputIntents = array
        else:
            pdf.Root.OutputIntents = array
        pdf.save(path, min_version=version)


def profile_copies(pdf, profile):
    """Every saved stream whose decoded bytes are this profile."""
    return [obj for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream) and obj.read_bytes() == profile]


def conditions_of(pdf, index):
    array = pdf.pages[index].get('/OutputIntents') or pdf.Root.get('/OutputIntents')
    if array is None:
        return None
    return [(str(item.S), str(item.OutputConditionIdentifier),
             hashlib.sha256(item.DestOutputProfile.read_bytes()).hexdigest())
            for item in array]


def sha(data):
    return hashlib.sha256(data).hexdigest()


class TestCreatePdfSubset:
    def test_subset_carries_the_profile_exactly_once(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        intents_file(source, [('GTS_PDFX', 'SWOP', SWOP)], pages=4)
        assert _subset(source, output, '1,3-4', 'a.pdf') == 3
        with pikepdf.open(output) as pdf:
            assert len(profile_copies(pdf, SWOP)) == 1
            for index in range(3):
                assert pdf.pages[index].get('/OutputIntents') is None
                assert conditions_of(pdf, index) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]

    def test_subset_of_a_page_level_intent_declares_pdf_2_0(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        intents_file(source, [('GTS_PDFX', 'SWOP', SWOP)], pages=3, where='page', version='2.0')
        assert _subset(source, output, '1', 'a.pdf') == 1
        with pikepdf.open(output) as pdf:
            assert conditions_of(pdf, 0) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
            assert effective_version(pdf) >= (2, 0)
            assert len(profile_copies(pdf, SWOP)) == 1

    def test_subset_excluding_the_override_page_keeps_only_the_default(self, tmp_path):
        source, output = tmp_path / 'a.pdf', tmp_path / 'out.pdf'
        with pikepdf.Pdf.new() as pdf:
            for _ in range(2):
                pdf.add_blank_page(page_size=(200, 200))

            def intent(condition, profile):
                return Array([pdf.make_indirect(Dictionary(
                    Type=Name.OutputIntent, S=Name.GTS_PDFX,
                    OutputConditionIdentifier=String(condition),
                    DestOutputProfile=pdf.make_stream(profile, N=4)))])
            pdf.Root.OutputIntents = intent('SWOP', SWOP)
            pdf.pages[0].OutputIntents = intent('FOGRA39', FOGRA)
            pdf.Root.Version = Name('/2.0')
            pdf.save(source)
        assert _subset(source, output, '2', 'a.pdf') == 1
        with pikepdf.open(output) as pdf:
            assert conditions_of(pdf, 0) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
            assert profile_copies(pdf, FOGRA) == []
            assert len(profile_copies(pdf, SWOP)) == 1

    @pytest.mark.parametrize('page_size', ['auto', 'a4'])
    def test_create_pdf_with_a_range_keeps_intents_and_version(self, tmp_path, page_size):
        plain, paged, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        intents_file(plain, [('GTS_PDFX', 'SWOP', SWOP)], pages=3)
        intents_file(paged, [('GTS_PDFX', 'FOGRA39', FOGRA)], pages=2, where='page',
                     version='2.0')
        create_pdf([{'path': str(plain), 'pages': '2-3'}, {'path': str(paged), 'pages': '1'}],
                   str(output), page_size=page_size)
        with pikepdf.open(output) as pdf:
            assert len(pdf.pages) == 3
            assert conditions_of(pdf, 0) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
            assert conditions_of(pdf, 1) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
            assert conditions_of(pdf, 2) == [('/GTS_PDFX', 'FOGRA39', sha(FOGRA))]
            assert len(profile_copies(pdf, SWOP)) == 1
            assert len(profile_copies(pdf, FOGRA)) == 1
            assert effective_version(pdf) >= (2, 0)


class TestMixedSourceConflicts:
    def test_different_subtypes_on_one_profile_stay_with_their_pages(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        intents_file(first, [('GTS_PDFA1', 'SWOP', SWOP)])
        intents_file(second, [('GTS_PDFX', 'SWOP', SWOP)])
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is None
            for index in (0, 1):
                assert conditions_of(pdf, index) == [('/GTS_PDFA1', 'SWOP', sha(SWOP))]
            for index in (2, 3):
                assert conditions_of(pdf, index) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
            assert effective_version(pdf) >= (2, 0)

    def test_different_profiles_are_each_stored_once(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        intents_file(first, [('GTS_PDFX', 'SWOP', SWOP)], pages=3)
        intents_file(second, [('GTS_PDFX', 'FOGRA39', FOGRA)], pages=3)
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert len(profile_copies(pdf, SWOP)) == 1
            assert len(profile_copies(pdf, FOGRA)) == 1
            for index in range(3):
                assert conditions_of(pdf, index) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
                assert conditions_of(pdf, index + 3) == [('/GTS_PDFX', 'FOGRA39', sha(FOGRA))]

    def test_a_multi_intent_array_keeps_every_entry_in_order(self, tmp_path):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        entries = [('GTS_PDFA1', 'SWOP', SWOP), ('GTS_PDFX', 'FOGRA39', FOGRA)]
        intents_file(first, entries)
        intents_file(second, entries)
        merge([str(first), str(second)], str(output))
        expected = [(f'/{subtype}', condition, sha(profile))
                    for subtype, condition, profile in entries]
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is not None
            for index in range(4):
                assert pdf.pages[index].get('/OutputIntents') is None
                assert conditions_of(pdf, index) == expected
            assert len(profile_copies(pdf, SWOP)) == 1
            assert len(profile_copies(pdf, FOGRA)) == 1

    def test_a_bare_source_between_equal_defaults_drops_no_intent(self, tmp_path):
        paths = [tmp_path / f's{n}.pdf' for n in range(3)]
        intents_file(paths[0], [('GTS_PDFX', 'SWOP', SWOP)])
        conditioned(paths[1], where='none')
        intents_file(paths[2], [('GTS_PDFX', 'SWOP', SWOP)])
        output = tmp_path / 'out.pdf'
        merge([str(path) for path in paths], str(output))
        with pikepdf.open(output) as pdf:
            assert pdf.Root.get('/OutputIntents') is None
            for index in (0, 1, 4, 5):
                assert conditions_of(pdf, index) == [('/GTS_PDFX', 'SWOP', sha(SWOP))]
            assert conditions_of(pdf, 2) is None
            assert conditions_of(pdf, 3) is None
            referenced = {pdf.pages[index].OutputIntents[0].DestOutputProfile.objgen
                          for index in (0, 1, 4, 5)}
            # Recomposition leaves no stored profile that no page references.
            assert {copy.objgen for copy in profile_copies(pdf, SWOP)} == referenced
            assert len(referenced) <= 2
            assert effective_version(pdf) >= (2, 0)

    def test_a_split_part_of_a_merged_mixed_file_keeps_its_page_condition(self, tmp_path):
        first, second, merged = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'm.pdf'
        intents_file(first, [('GTS_PDFX', 'SWOP', SWOP)])
        intents_file(second, [('GTS_PDFX', 'FOGRA39', FOGRA)])
        merge([str(first), str(second)], str(merged))
        result = split(str(merged), mode='ranges', ranges='3', output_dir=str(tmp_path / 'out'))
        (part,) = result['outputs']
        with pikepdf.open(part) as pdf:
            assert conditions_of(pdf, 0) == [('/GTS_PDFX', 'FOGRA39', sha(FOGRA))]
            assert profile_copies(pdf, SWOP) == []
            assert effective_version(pdf) >= (2, 0)

    @pytest.mark.parametrize('versions', [('1.3', '2.0'), ('2.0', '1.3'), ('1.4', '1.7')])
    def test_the_effective_version_is_the_highest_requirement(self, tmp_path, versions):
        first, second, output = tmp_path / 'a.pdf', tmp_path / 'b.pdf', tmp_path / 'out.pdf'
        intents_file(first, [('GTS_PDFX', 'SWOP', SWOP)], version=versions[0])
        intents_file(second, [('GTS_PDFX', 'SWOP', SWOP)], version=versions[1])
        merge([str(first), str(second)], str(output))
        with pikepdf.open(output) as pdf:
            assert effective_version(pdf) == max(parse_version(v) for v in versions)
            assert pdf.Root.get('/OutputIntents') is not None
            assert len(profile_copies(pdf, SWOP)) == 1
