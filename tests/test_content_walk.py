"""Direct tests for the shared state machine's 7.5 additions (Tr/Ts and
opaque color capture). The pre-7.5 tracking is pinned through the client
suites (redact / page_images / text_runs) — the no-drift proof — so this
file covers only the new fields' semantics."""

from engine.content_walk import (
    DEFAULT_COLOR,
    IDENTITY,
    ClipTracker,
    GraphicsTextState,
    rects_intersect,
)


def _fed(ops):
    s = GraphicsTextState(IDENTITY)
    for operator, operands in ops:
        s.feed(operator, operands)
    return s


class TestRenderModeAndRise:
    def test_defaults(self):
        s = GraphicsTextState(IDENTITY)
        assert s.render_mode == 0
        assert s.rise == 0.0

    def test_tr_ts_tracked(self):
        s = _fed([("Tr", [3]), ("Ts", [4.5])])
        assert s.render_mode == 3
        assert s.rise == 4.5

    def test_malformed_operands_leave_state(self):
        s = _fed([("Tr", []), ("Ts", ["x"])])
        assert s.render_mode == 0
        assert s.rise == 0.0

    def test_q_stack_restores(self):
        s = _fed([("Tr", [3]), ("q", []), ("Tr", [1]), ("Ts", [2]), ("Q", [])])
        assert s.render_mode == 3
        assert s.rise == 0.0


class TestColorCapture:
    def test_default_is_sentinel(self):
        s = GraphicsTextState(IDENTITY)
        assert s.fill_color == DEFAULT_COLOR
        assert s.stroke_color == DEFAULT_COLOR

    def test_device_ops_stand_alone(self):
        s = _fed([("rg", [0, 0, 1])])
        assert s.fill_color == (None, ("rg", (0.0, 0.0, 1.0)))
        assert s.stroke_color == DEFAULT_COLOR

    def test_cs_scn_pair_kept_together(self):
        s = _fed([("cs", ["/Sep1"]), ("scn", [0.8])])
        assert s.fill_color == (("cs", ("/Sep1",)), ("scn", (0.8,)))

    def test_cs_resets_the_value_slot(self):
        s = _fed([("cs", ["/A"]), ("scn", [0.5]), ("cs", ["/B"])])
        assert s.fill_color == (("cs", ("/B",)), None)

    def test_device_op_clears_a_cs_prefix(self):
        s = _fed([("cs", ["/A"]), ("scn", [0.5]), ("g", [0])])
        assert s.fill_color == (None, ("g", (0.0,)))

    def test_stroke_and_fill_independent(self):
        s = _fed([("RG", [1, 0, 0]), ("g", [0.5])])
        assert s.stroke_color == (None, ("RG", (1.0, 0.0, 0.0)))
        assert s.fill_color == (None, ("g", (0.5,)))

    def test_pattern_name_operand_survives_as_string(self):
        s = _fed([("cs", ["/Pattern"]), ("scn", ["/P1"])])
        assert s.fill_color == (("cs", ("/Pattern",)), ("scn", ("/P1",)))

    def test_q_stack_restores_colors(self):
        s = _fed([("rg", [1, 0, 0]), ("q", []), ("g", [0]), ("Q", [])])
        assert s.fill_color == (None, ("rg", (1.0, 0.0, 0.0)))


def _clip_fed(ops, ctm=IDENTITY, base_clip=None):
    """Feed (operator, operands) pairs to a ClipTracker under a fixed ctm."""
    c = ClipTracker(base_clip)
    for operator, operands in ops:
        c.feed(operator, operands, ctm)
    return c


class TestClipTracker:
    def test_default_unbounded_never_clips(self):
        c = ClipTracker()
        assert c.clip is None
        assert c.clips_away((0, 0, 1, 1)) is False
        assert c.clips_away((1e9, 1e9, 1e9 + 1, 1e9 + 1)) is False

    def test_base_clip_seeds_region(self):
        c = ClipTracker((10, 10, 60, 60))
        assert c.clip == (10, 10, 60, 60)
        assert c.clips_away((100, 100, 140, 140)) is True   # outside
        assert c.clips_away((40, 40, 50, 50)) is False       # inside

    def test_re_W_n_sets_clip_to_path_bbox(self):
        c = _clip_fed([("re", [10, 10, 50, 50]), ("W", []), ("n", [])])
        assert c.clip == (10.0, 10.0, 60.0, 60.0)
        assert c.clips_away((100, 100, 140, 140)) is True
        assert c.clips_away((40, 40, 50, 50)) is False

    def test_painted_path_without_W_sets_no_clip(self):
        # A normal fill (no W before the paint) must NOT become a clip: the
        # path points accumulate then reset on the paint, clip stays None.
        c = _clip_fed([("re", [10, 10, 50, 50]), ("f", [])])
        assert c.clip is None
        assert c.clips_away((100, 100, 140, 140)) is False

    def test_moveto_lineto_clip_via_S_like_end(self):
        # A triangular clip built from m/l and ended by `s` (closepath-stroke,
        # a path-ending op) still bounds to the point bbox.
        c = _clip_fed(
            [("m", [0, 0]), ("l", [30, 0]), ("l", [0, 40]), ("W", []), ("n", [])]
        )
        assert c.clip == (0.0, 0.0, 30.0, 40.0)

    def test_nested_clip_intersects(self):
        c = _clip_fed(
            [
                ("re", [0, 0, 100, 100]),
                ("W", []),
                ("n", []),
                ("re", [50, 50, 100, 100]),  # → [50,50,150,150]
                ("W", []),
                ("n", []),
            ]
        )
        # Intersection of [0,0,100,100] and [50,50,150,150].
        assert c.clip == (50.0, 50.0, 100.0, 100.0)

    def test_q_Q_save_restore_clip(self):
        c = _clip_fed(
            [
                ("re", [0, 0, 200, 200]),
                ("W", []),
                ("n", []),
                ("q", []),
                ("re", [0, 0, 10, 10]),  # tighter clip inside the q…Q
                ("W", []),
                ("n", []),
                ("Q", []),
            ]
        )
        # The inner clip is discarded on Q; the outer [0,0,200,200] restored.
        assert c.clip == (0.0, 0.0, 200.0, 200.0)

    def test_ctm_transforms_clip_points(self):
        # A 2× scale + translate CTM maps the unit rect [0,0,1,1] to
        # [10,20,12,22]: points go through a*x+c*y+e, b*x+d*y+f.
        c = _clip_fed([("re", [0, 0, 1, 1]), ("W", []), ("n", [])], ctm=(2, 0, 0, 2, 10, 20))
        assert c.clip == (10.0, 20.0, 12.0, 22.0)

    def test_edge_touch_counts_as_clipped_away(self):
        # bbox right edge exactly at the clip left edge → zero-area overlap →
        # treated as separated (the shared `<=` predicate), safe because the
        # clip bbox is a SUPERSET of the true clip region.
        c = ClipTracker((10, 10, 60, 60))
        assert c.clips_away((0, 10, 10, 60)) is True   # touches x=10
        assert c.clips_away((9, 10, 11, 60)) is False  # overlaps by 1

    def test_malformed_path_operands_do_not_crash(self):
        c = _clip_fed([("re", ["x", "y"]), ("W", []), ("n", [])])
        # No usable points → clip stays unbounded.
        assert c.clip is None

    def test_empty_pending_clip_leaves_unbounded(self):
        # W with no path points before the end op must not set a degenerate clip.
        c = _clip_fed([("W", []), ("n", [])])
        assert c.clip is None


class TestRectsIntersect:
    def test_overlap(self):
        assert rects_intersect((0, 0, 10, 10), (5, 5, 15, 15)) is True

    def test_disjoint(self):
        assert rects_intersect((0, 0, 10, 10), (20, 20, 30, 30)) is False

    def test_edge_touch_is_not_intersection(self):
        assert rects_intersect((0, 0, 10, 10), (10, 0, 20, 10)) is False
