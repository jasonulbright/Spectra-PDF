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
    DEFAULT_DPI,
    compute_regions,
    drop_dead_frames,
    flatten_transparency,
    list_transparency,
    page_objects,
    snap_to_pixel,
)
from transparency_builders import (
    blend_mode_pdf,
    opaque_only_pdf,
    pattern_under_alpha_pdf,
    soft_mask_pdf,
    stacked_alpha_pdf,
    text_and_alpha_square_pdf,
    transparency_group_form_pdf,
    two_alpha_squares_pdf,
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
        objects = page_objects(pdf, page)
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
        objects = page_objects(pdf, page)
        plan = compute_regions(objects, [0.0, 0.0, 612.0, 792.0], 0.0, 150)
    assert plan["passes"] < 8
    assert len(plan["regions"]) == 2
