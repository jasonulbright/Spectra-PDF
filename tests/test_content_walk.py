"""Direct tests for the shared state machine's 7.5 additions (Tr/Ts and
opaque color capture). The pre-7.5 tracking is pinned through the client
suites (redact / page_images / text_runs) — the no-drift proof — so this
file covers only the new fields' semantics."""

from engine.content_walk import DEFAULT_COLOR, IDENTITY, GraphicsTextState


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
