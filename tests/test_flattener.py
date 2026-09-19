"""Region flattening: what participates, what rasterizes, and the seam.

The measurement the whole design rests on is the last one here. A region whose
boundary snaps to whole device pixels leaves a flattened page that renders
IDENTICALLY to the original; the same region left off the pixel grid draws a
seam of over a hundred levels along its edge. The snap is not a precaution, it
is the difference between a flatten and a visible artifact, and the pin proves
both halves.
"""

import os
import subprocess

import pikepdf
import pytest

from engine.flattener import (
    DEFAULT_BALANCE,
    DEFAULT_DPI,
    compute_regions,
    drop_dead_frames,
    flatten_transparency,
    list_transparency,
    merge_gap,
    page_objects,
    snap_to_pixel,
)
from text_state_shapes import INK_BOX, shape_pdf
from transparency_builders import (
    blend_mode_pdf,
    no_bbox_form_pdf,
    over_depth_forms_pdf,
    opaque_only_pdf,
    pattern_under_alpha_pdf,
    soft_mask_pdf,
    stacked_alpha_pdf,
    text_and_alpha_square_pdf,
    transparency_group_form_pdf,
    two_alpha_squares_pdf,
    unreadable_child_subtype_pdf,
    unreadable_form_gstate_pdf,
    unreadable_form_resources_pdf,
    unreadable_page_gstate_pdf,
)

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def _page(report, index=0):
    return report["pages"][index]


def _render(gs_path, source, target, dpi=DEFAULT_DPI):
    subprocess.run(
        [gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q", "-sDEVICE=png16m",
         f"-r{dpi}", "-o", str(target), str(source)],
        check=True, stdin=subprocess.DEVNULL, capture_output=True,
    )


def _raster_delta(a, b):
    import numpy as np
    from PIL import Image

    with Image.open(a) as ia, Image.open(b) as ib:
        left = np.asarray(ia.convert("RGB")).astype(np.int16)
        right = np.asarray(ib.convert("RGB")).astype(np.int16)
    assert left.shape == right.shape
    return np.abs(left - right).max(axis=2)


def _content(path, page=0):
    with pikepdf.open(path) as pdf:
        return bytes(pdf.pages[page].Contents.read_bytes())


def _resource_names(path, key, page=0):
    with pikepdf.open(path) as pdf:
        table = pdf.pages[page].Resources.get(key)
        return [str(name) for name in table.keys()] if table is not None else []


# ── classification ─────────────────────────────────────────────────────────


def test_constant_alpha_is_transparent(tmp_dir):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    transparent = [o for o in page["objects"] if o["transparent"]]
    assert len(transparent) == 1
    assert transparent[0]["kind"] == "fill"
    assert page["counts"]["transparent"] == 1


def test_blend_mode_alone_is_transparent(tmp_dir):
    source = blend_mode_pdf(os.path.join(tmp_dir, "b.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    assert page["counts"]["transparent"] == 1


def test_soft_mask_alone_is_transparent(tmp_dir):
    source = soft_mask_pdf(os.path.join(tmp_dir, "s.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    assert page["counts"]["transparent"] == 1


def test_transparency_group_form_is_transparent(tmp_dir):
    source = transparency_group_form_pdf(os.path.join(tmp_dir, "g.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    groups = [o for o in page["objects"] if o["kind"] == "form"]
    assert len(groups) == 1
    assert groups[0]["transparent"] is True


def test_object_under_a_transparent_one_is_affected(tmp_dir):
    source = stacked_alpha_pdf(os.path.join(tmp_dir, "st.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    affected = [o for o in page["objects"] if "affected" in o["categories"]]
    assert len(affected) == 1
    # The lower bar sits far from the square and must NOT be classified: an
    # over-broad affected set is what turns a preview into a scare.
    assert affected[0]["rect"][3] > 300


def test_a_pattern_a_region_covers_is_an_expanded_pattern(tmp_dir):
    source = pattern_under_alpha_pdf(os.path.join(tmp_dir, "p.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    assert page["counts"]["expanded_patterns"] == 1


def test_an_opaque_page_reports_no_transparency_and_no_regions(tmp_dir):
    source = opaque_only_pdf(os.path.join(tmp_dir, "o.pdf"))
    report = list_transparency(source, balance=0.0)
    assert report["transparent_pages"] == []
    assert _page(report)["regions"] == []


# ── regions ────────────────────────────────────────────────────────────────


def test_region_boundaries_land_on_whole_device_pixels(tmp_dir):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    for dpi in (96, 150, 300):
        page = _page(list_transparency(source, balance=0.0, dpi=dpi))
        for region in page["regions"]:
            for edge in region:
                pixels = edge * dpi / 72.0
                assert abs(pixels - round(pixels)) < 1e-6


def test_the_snap_only_ever_grows_a_region():
    assert snap_to_pixel(400.0, 150, False) <= 400.0
    assert snap_to_pixel(400.0, 150, True) >= 400.0
    assert snap_to_pixel(480.0, 150, True) == 480.0


def test_the_merge_gap_spreads_the_useful_distances_across_the_control():
    """A linear gap makes almost the whole control useless: half a page
    diagonal already merges everything on a letter page, so every setting past
    about a tenth rasterizes the lot."""
    diagonal = 1000.0
    assert merge_gap(0.0, diagonal) == 0.0
    assert merge_gap(1.0, diagonal) == diagonal
    # The middle of the travel is a distance a page has, not a page and a half.
    assert 20.0 < merge_gap(0.5, diagonal) < 80.0
    previous = -1.0
    for step in range(11):
        current = merge_gap(step / 10.0, diagonal)
        assert current > previous
        previous = current


def test_the_default_balance_leaves_text_clear_of_the_region_live(tmp_dir):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    page = _page(list_transparency(source, balance=DEFAULT_BALANCE))
    assert page["counts"]["outlined_text"] == 0
    assert page["whole_page"] is False


def test_balance_toward_vector_keeps_the_regions_apart(tmp_dir):
    source = two_alpha_squares_pdf(os.path.join(tmp_dir, "two.pdf"))
    page = _page(list_transparency(source, balance=0.0))
    assert len(page["regions"]) == 2
    assert page["counts"]["outlined_text"] == 0


def test_balance_toward_raster_merges_them_into_one(tmp_dir):
    source = two_alpha_squares_pdf(os.path.join(tmp_dir, "two.pdf"))
    page = _page(list_transparency(source, balance=1.0))
    assert len(page["regions"]) == 1
    assert page["whole_page"] is True
    # The text between the two squares is inside the merged region, so the
    # balance really did trade live text for fewer regions.
    assert page["counts"]["outlined_text"] == 1


def test_every_object_a_region_touches_is_absorbed(tmp_dir):
    source = stacked_alpha_pdf(os.path.join(tmp_dir, "st.pdf"))
    report = list_transparency(source, balance=0.0)
    page = _page(report)
    region = page["regions"][0]
    members = set(page["region_members"][0])
    for obj in page["objects"]:
        overlaps = not (
            obj["rect"][2] < region[0] or region[2] < obj["rect"][0]
            or obj["rect"][3] < region[1] or region[3] < obj["rect"][1]
        )
        if overlaps:
            assert obj["index"] in members


def test_a_page_with_no_usable_media_box_refuses():
    from engine.flattener import _page_box

    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    page.obj["/MediaBox"] = pikepdf.Array([0, 0])
    with pytest.raises(ValueError, match="no media box"):
        _page_box(page)


def test_a_page_outside_the_document_refuses(tmp_dir):
    source = opaque_only_pdf(os.path.join(tmp_dir, "o.pdf"))
    with pytest.raises(ValueError, match="not in this document"):
        list_transparency(source, pages=[9])


def test_the_region_pixel_cap_refuses_rather_than_asking_for_it(tmp_dir, gs_path):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    with pytest.raises(ValueError, match="would need"):
        flatten_transparency(
            source, os.path.join(tmp_dir, "out.pdf"),
            balance=1.0, dpi=4800, gs_path=gs_path,
        )


# ── the dead-frame sweep ───────────────────────────────────────────────────


def _instructions(body: bytes):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(100, 100))
    page.Contents = pdf.make_stream(body)
    return list(pikepdf.parse_content_stream(page))


def test_a_frame_that_paints_nothing_is_removed():
    kept = drop_dead_frames(_instructions(b"q /GA gs 1 0 0 rg Q 0 0 1 rg 0 0 5 5 re f"))
    assert [str(i.operator) for i in kept] == ["rg", "re", "f"]


def test_a_frame_that_still_paints_survives():
    kept = drop_dead_frames(_instructions(b"q /GA gs 0 0 5 5 re f Q"))
    assert [str(i.operator) for i in kept] == ["q", "gs", "re", "f", "Q"]


def test_emptying_an_inner_frame_empties_its_parent():
    assert drop_dead_frames(_instructions(b"q q /GA gs Q Q")) == []


# ── the apply ──────────────────────────────────────────────────────────────


def test_text_outside_every_region_stays_live_text(tmp_dir, gs_path):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    output = os.path.join(tmp_dir, "flat.pdf")
    flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
    assert _content(source).count(b"BT") == 30
    assert _content(output).count(b"BT") == 30
    assert _resource_names(output, "/Font") == ["/F0"]


def test_a_flattened_page_carries_no_transparency_construct(tmp_dir, gs_path):
    for builder in (text_and_alpha_square_pdf, stacked_alpha_pdf, blend_mode_pdf,
                    soft_mask_pdf, pattern_under_alpha_pdf):
        source = builder(os.path.join(tmp_dir, f"{builder.__name__}.pdf"))
        output = os.path.join(tmp_dir, f"{builder.__name__}-flat.pdf")
        flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
        after = _page(list_transparency(output, balance=0.0))
        assert after["counts"]["transparent"] == 0, builder.__name__
        assert _resource_names(output, "/ExtGState") == [], builder.__name__


def test_the_page_box_is_untouched(tmp_dir, gs_path):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    output = os.path.join(tmp_dir, "flat.pdf")
    flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
    with pikepdf.open(source) as before, pikepdf.open(output) as after:
        assert ([float(v) for v in before.pages[0].obj["/MediaBox"]]
                == [float(v) for v in after.pages[0].obj["/MediaBox"]])


def test_a_page_with_no_transparency_is_left_alone(tmp_dir, gs_path):
    source = opaque_only_pdf(os.path.join(tmp_dir, "o.pdf"))
    output = os.path.join(tmp_dir, "flat.pdf")
    result = flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
    assert result["regions"] == 0
    assert _content(output) == _content(source)


def test_the_placement_is_a_pure_translation(tmp_dir, gs_path):
    """A scale in the placement would resample the raster the snap was
    computed to keep at 1:1, which is the seam by another route."""
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    output = os.path.join(tmp_dir, "flat.pdf")
    flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
    body = _content(output).decode("latin-1")
    assert "1 0 0 1 399.84 639.84 cm /FlatR0 Do" in body


# ── the seam ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("dpi", [96, 150, 300])
def test_a_snapped_flatten_renders_identically_to_the_original(tmp_dir, gs_path, dpi):
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    output = os.path.join(tmp_dir, f"flat-{dpi}.pdf")
    flatten_transparency(source, output, balance=0.0, dpi=dpi, gs_path=gs_path)
    before = os.path.join(tmp_dir, f"before-{dpi}.png")
    after = os.path.join(tmp_dir, f"after-{dpi}.png")
    _render(gs_path, source, before, dpi)
    _render(gs_path, output, after, dpi)
    assert int(_raster_delta(before, after).max()) == 0


def test_an_unsnapped_region_boundary_draws_the_seam(tmp_dir, gs_path):
    """The counterfactual, and the reason the snap is in the design.

    The same region is rasterized and placed twice — once on the pixel grid,
    once a third of a pixel off it. On the grid the page is identical; off it
    the boundary carries a difference of more than a hundred levels over
    hundreds of pixels, which is a visible line.
    """
    import numpy as np

    dpi = 150
    source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "a.pdf"))
    before = os.path.join(tmp_dir, "before.png")
    _render(gs_path, source, before, dpi)

    def place(region, tag):
        output = os.path.join(tmp_dir, f"{tag}.pdf")
        _flatten_at(source, output, region, dpi, gs_path)
        rendered = os.path.join(tmp_dir, f"{tag}.png")
        _render(gs_path, output, rendered, dpi)
        return _raster_delta(before, rendered)

    on_grid = place((399.84, 639.84, 480.0, 720.0), "snapped")
    off_grid = place((399.63, 639.63, 480.37, 720.37), "unsnapped")
    assert int(on_grid.max()) == 0
    assert int(off_grid.max()) > 100
    assert int(np.count_nonzero(off_grid > 8)) > 100


def _flatten_at(source, output, region, dpi, gs_path):
    """Flatten the fixture's one transparent object into an EXPLICIT region,
    bypassing the snap, so the counterfactual measures the boundary alone."""
    import tempfile
    from pathlib import Path

    from engine import flattener

    work = Path(tempfile.mkdtemp())
    with pikepdf.open(source) as pdf:
        page = pdf.pages[0]
        objects, _unknowns = page_objects(pdf, page)
        target = next(o for o in objects if o["transparent"])
        instructions = list(pikepdf.parse_content_stream(page))
        kept = flattener.drop_dead_frames([
            ins for i, ins in enumerate(instructions) if i not in set(target["drop_idxs"])
        ])
        region_src = flattener._region_source(pdf, 1, list(region), work, 0)
        raster = work / "raster.pdf"
        flattener._rasterize_region(region_src, raster, dpi, gs_path, "probe")
        with pikepdf.open(raster) as raster_pdf:
            xobj = flattener._xobject_for(pdf, raster_pdf, 0, {})
            flattener._prune_resources(pdf, page, kept, {"/FlatR0"})
            resources = page.obj["/Resources"]
            if "/XObject" not in resources:
                resources["/XObject"] = pikepdf.Dictionary()
            resources["/XObject"][pikepdf.Name("/FlatR0")] = xobj
            placement = (f"\nq 1 0 0 1 {region[0]:.6f} {region[1]:.6f} cm /FlatR0 Do Q\n")
            page.Contents = pdf.make_stream(
                pikepdf.unparse_content_stream(kept) + placement.encode("ascii")
            )
            pdf.save(output)


def test_compute_regions_settles_rather_than_running_to_its_cap(tmp_dir):
    source = two_alpha_squares_pdf(os.path.join(tmp_dir, "two.pdf"))
    with pikepdf.open(source) as pdf:
        page = pdf.pages[0]
        objects, _unknowns = page_objects(pdf, page)
        plan = compute_regions(objects, [0.0, 0.0, 612.0, 792.0], 0.0, 150)
    assert plan["passes"] < 8
    assert len(plan["regions"]) == 2


class TestUnjudgeableObjects:
    """Every branch that used to answer "no transparency" when it meant "I
    could not tell".

    Each fixture places one object the walk cannot read. Before this class
    existed, all six classified as opaque, produced no region, and flattened
    to a SUCCESS report over content that may still composite. The claim
    pinned here is the opposite one: the classification names the object, and
    the flatten refuses by name rather than writing that file.
    """

    CASES = (
        ("resources", unreadable_form_resources_pdf, "cannot read"),
        ("gstate", unreadable_form_gstate_pdf, "graphics state"),
        ("child", unreadable_child_subtype_pdf, "cannot read"),
        ("bbox", no_bbox_form_pdf, "/BBox cannot be measured"),
        ("depth", over_depth_forms_pdf, "nests form XObjects deeper than"),
        ("page_gstate", unreadable_page_gstate_pdf, "graphics state"),
    )

    @pytest.mark.parametrize("name,build,fragment", CASES)
    def test_the_classification_reports_it_rather_than_passing(
        self, tmp_dir, name, build, fragment
    ):
        source = build(os.path.join(tmp_dir, f"{name}.pdf"))
        report = list_transparency(source)
        page = report["pages"][0]
        assert page["unknown"], "an object that could not be judged must be named"
        assert fragment in page["unknown"][0]
        assert page["counts"]["unknown"] == 1
        assert report["unknown_pages"] == [1]

    @pytest.mark.parametrize("name,build,fragment", CASES)
    def test_the_flatten_refuses_by_name(self, tmp_dir, name, build, fragment):
        source = build(os.path.join(tmp_dir, f"{name}.pdf"))
        output = os.path.join(tmp_dir, f"{name}-out.pdf")
        with pytest.raises(ValueError, match="unknown|deeper than"):
            flatten_transparency(source, output)
        assert not os.path.exists(output), "a refusal writes nothing"

    def test_the_refusal_and_the_report_say_the_same_thing(self, tmp_dir):
        source = no_bbox_form_pdf(os.path.join(tmp_dir, "bbox.pdf"))
        predicted = list_transparency(source)["pages"][0]["unknown"][0]
        with pytest.raises(ValueError) as raised:
            flatten_transparency(source, os.path.join(tmp_dir, "out.pdf"))
        assert str(raised.value) == predicted

    def test_an_unjudged_object_seeds_no_region(self, tmp_dir):
        """It cannot be claimed transparent, so it cannot grow a plan the
        flatten will refuse to carry out."""
        source = unreadable_form_resources_pdf(os.path.join(tmp_dir, "r.pdf"))
        page = list_transparency(source)["pages"][0]
        assert page["regions"] == []
        assert page["counts"]["transparent"] == 0

    def test_a_no_bbox_form_is_still_listed(self, tmp_dir):
        """The `Do` used to emit nothing at all: the object landed in no
        region and was not weighed as preserved either."""
        source = no_bbox_form_pdf(os.path.join(tmp_dir, "bbox.pdf"))
        page = list_transparency(source)["pages"][0]
        forms = [o for o in page["objects"] if o["kind"] == "form"]
        assert len(forms) == 1
        assert forms[0]["unknown"] is True

    def test_a_readable_document_claims_nothing_unknown(self, tmp_dir):
        source = text_and_alpha_square_pdf(os.path.join(tmp_dir, "clean.pdf"))
        report = list_transparency(source)
        assert report["unknown_pages"] == []
        assert report["pages"][0]["counts"]["unknown"] == 0
        assert all(o["unknown"] is False for o in report["pages"][0]["objects"])


# ── the text state ─────────────────────────────────────────────────────────


def _state_page(path, content: bytes, extra_resources=None) -> str:
    """One 400 x 400 page with Helvetica as /F0, a half-transparent /GA, an
    opaque /GO and a 20-point line width /GW, drawing `content`."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400.0, 400.0))
    resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F0=pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1,
            BaseFont=pikepdf.Name.Helvetica, Encoding=pikepdf.Name.WinAnsiEncoding))),
        ExtGState=pikepdf.Dictionary(
            GA=pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, ca=0.5, CA=0.5),
            GO=pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, ca=1.0, CA=1.0),
            GW=pikepdf.Dictionary(Type=pikepdf.Name.ExtGState, LW=20),
        ),
    )
    for key, value in (extra_resources or {}).items():
        resources[key] = value
    page.Resources = resources
    page.Contents = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()
    return str(path)


class TestTheTextState:
    """A text block's box is the ink of the font the text state holds (ISO
    32000-2 §9.3.1): the one `Tf` names, or the one an ExtGState /Font entry
    sets (Table 57), measured to that font's own ascent and descent. Shape B's
    page has one text block, and it draws nothing."""

    @pytest.mark.parametrize("label", ("A", "A2"))
    def test_the_text_block_covers_the_drawn_font_s_ink(self, tmp_dir, label):
        page = _page(list_transparency(shape_pdf(tmp_dir, label)))
        (text,) = [o for o in page["objects"] if o["kind"] == "text"]
        assert text["rect"] == pytest.approx(INK_BOX, abs=0.01)

    def test_a_text_block_that_draws_nothing_is_no_object(self, tmp_dir):
        page = _page(list_transparency(shape_pdf(tmp_dir, "B")))
        assert [o["kind"] for o in page["objects"]] == ["form"]

    def test_a_block_that_selects_a_font_claims_no_area(self, tmp_dir):
        # An empty block that claims the page box makes every region absorb
        # it and grow to the whole page, taking the live line with it.
        source = _state_page(
            os.path.join(tmp_dir, "empty.pdf"),
            b"BT /F0 12 Tf ET q /GA gs 1 0 0 rg 300 300 50 50 re f Q "
            b"BT /F0 12 Tf 60 100 Td (LIVE) Tj ET",
        )
        page = _page(list_transparency(source))
        assert page["whole_page"] is False
        (region,) = page["regions"]
        assert region[0] >= 299.0 and region[1] >= 299.0
        assert page["counts"]["outlined_text"] == 0

    def test_the_font_an_absorbed_block_selects_still_draws_the_text_after_it(
        self, tmp_dir, gs_path
    ):
        pytest.importorskip("numpy")
        # Block one sits under the square and is absorbed; block two lies far
        # from it and draws with the font block one selected.
        source = _state_page(
            os.path.join(tmp_dir, "state.pdf"),
            b"BT /F0 12 Tf 60 300 Td (AAA) Tj ET "
            b"q /GA gs 1 0 0 rg 55 295 40 20 re f Q "
            b"BT 60 100 Td (BBB) Tj ET",
        )
        output = os.path.join(tmp_dir, "flat.pdf")
        result = flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
        assert result["regions"] == 1
        before, after = os.path.join(tmp_dir, "b.png"), os.path.join(tmp_dir, "a.png")
        _render(gs_path, source, before, dpi=72)
        _render(gs_path, output, after, dpi=72)
        delta = _raster_delta(before, after)
        # Rows 280..310 from the top are y 90..120 on the page: the live line.
        assert int(delta[280:310, 40:120].max()) == 0
        from PIL import Image
        import numpy as np

        with Image.open(after) as image:
            line = np.asarray(image.convert("L"))[280:310, 40:120]
        assert int((line < 128).sum()) > 0

    def test_alpha_set_and_reset_inside_a_text_block_is_transparency(self, tmp_dir):
        # The run draws at half alpha; the ExtGState after it restores full
        # alpha before ET, which is where the old walk looked.
        source = _state_page(
            os.path.join(tmp_dir, "alpha.pdf"),
            b"BT /F0 12 Tf /GA gs 60 300 Td (AAA) Tj /GO gs ET",
        )
        page = _page(list_transparency(source))
        (text,) = [o for o in page["objects"] if o["kind"] == "text"]
        assert text["transparent"] is True
        assert len(page["regions"]) == 1

    def test_an_extgstate_line_width_widens_the_stroke(self, tmp_dir):
        source = _state_page(os.path.join(tmp_dir, "lw.pdf"), b"q /GW gs 100 200 m 300 200 l S Q")
        page = _page(list_transparency(source))
        (stroke,) = [o for o in page["objects"] if o["kind"] == "stroke"]
        assert stroke["rect"] == pytest.approx([90.0, 190.0, 310.0, 210.0])

    def test_a_vertical_run_is_a_column(self, tmp_dir):
        from test_search_regions import _cid_font

        pdf = pikepdf.new()
        font = _cid_font(
            pdf, {1: 1000, 2: 1000, 3: 1000, 4: 1000}, {1: "上", 2: "下", 3: "左", 4: "右"},
            encoding="Identity-V", vertical_advances={1: 1000, 2: 1000, 3: 1000, 4: 1000},
        )
        page = pdf.add_blank_page(page_size=(400.0, 400.0))
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(b"BT /F1 20 Tf 200 300 Td <0001000200030004> Tj ET")
        source = os.path.join(tmp_dir, "vertical.pdf")
        pdf.save(source)
        pdf.close()
        (text,) = [o for o in _page(list_transparency(source))["objects"] if o["kind"] == "text"]
        # Four 20-point glyphs down from y 300, one em wide around x 200.
        assert text["rect"] == pytest.approx([190.0, 220.0, 210.0, 300.0], abs=0.01)

    def test_a_glyph_the_pen_moved_back_over_is_inside_the_box(self, tmp_dir):
        # [(AB) 1200 (C)]: B draws x 67.2..74.4, past the net advance of 7.2.
        from test_redact_text_state import _page as _state_doc_page, _simple_font

        pdf = pikepdf.new()
        _state_doc_page(
            pdf,
            pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=_simple_font(pdf, 600, "Wide"))),
            b"BT /F1 12 Tf 60 300 Td [(AB) 1200 (C)] TJ ET",
        )
        source = os.path.join(tmp_dir, "back.pdf")
        pdf.save(source)
        pdf.close()
        (text,) = [o for o in _page(list_transparency(source))["objects"] if o["kind"] == "text"]
        assert text["rect"] == pytest.approx([60.0, 296.4, 74.4, 312.0], abs=0.01)

    def test_a_show_that_draws_no_glyph_is_no_object(self, tmp_dir):
        source = _state_page(os.path.join(tmp_dir, "kern.pdf"), b"BT /F0 12 Tf 60 300 Td [-500] TJ ET")
        assert _page(list_transparency(source))["objects"] == []

    def test_the_spacing_an_absorbed_quote_operator_sets_still_spaces_the_text_after_it(
        self, tmp_dir, gs_path
    ):
        pytest.importorskip("numpy")
        # `aw ac string "` sets Tw and Tc for good. Block one is absorbed;
        # block two lies far from the square and spaces its characters by the
        # 20 units of Tc block one set.
        source = _state_page(
            os.path.join(tmp_dir, "quote.pdf"),
            b"BT /F0 12 Tf 14 TL 60 314 Td 0 20 (AAA) \" ET "
            b"q /GA gs 1 0 0 rg 55 295 40 20 re f Q "
            b"BT 60 100 Td (B B) Tj ET",
        )
        output = os.path.join(tmp_dir, "flat.pdf")
        flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
        before, after = os.path.join(tmp_dir, "b.png"), os.path.join(tmp_dir, "a.png")
        _render(gs_path, source, before, dpi=72)
        _render(gs_path, output, after, dpi=72)
        assert int(_raster_delta(before, after)[280:310, 40:200].max()) == 0

    def test_alpha_on_any_painted_run_makes_the_block_transparent(self, tmp_dir):
        source = _state_page(
            os.path.join(tmp_dir, "alpha-two.pdf"),
            b"BT /F0 12 Tf /GA gs 60 300 Td (AAA) Tj /GO gs (BBB) Tj ET",
        )
        (text,) = [o for o in _page(list_transparency(source))["objects"] if o["kind"] == "text"]
        assert text["transparent"] is True

    def test_a_block_of_invisible_text_is_no_object_and_survives_the_flatten(
        self, tmp_dir, gs_path
    ):
        # A recognition layer draws in mode 3. It paints nothing, so no region
        # absorbs it and it stays searchable under the raster.
        source = _state_page(
            os.path.join(tmp_dir, "ocr.pdf"),
            b"BT 3 Tr /F0 12 Tf 60 300 Td (recognized words) Tj ET "
            b"q /GA gs 1 0 0 rg 55 295 60 20 re f Q",
        )
        page = _page(list_transparency(source))
        assert [o["kind"] for o in page["objects"]] == ["fill"]
        output = os.path.join(tmp_dir, "flat.pdf")
        flatten_transparency(source, output, balance=0.0, gs_path=gs_path)
        assert b"(recognized words) Tj" in _content(output)
