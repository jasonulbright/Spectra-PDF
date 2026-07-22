"""§ I.0 S5 — resolve non-device vector colours to approximate sRGB.

Covers the PDF function evaluator (types 0/2/3/4) and the colour-space
resolvers (Device/Cal*/Lab/ICCBased/Indexed/Separation/DeviceN), plus the
honest-unknown contract (a pattern or an unsupported function → None).
"""

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.color_spaces import build_function, build_resolver, resolve_color


@pytest.fixture
def pdf():
    p = pikepdf.new()
    yield p
    p.close()


def _approx(a, b, tol=1e-6):
    return a is not None and b is not None and all(abs(x - y) <= tol for x, y in zip(a, b))


# ── PDF functions ──────────────────────────────────────────────────────────


class TestFunctions:
    def test_type2_exponential(self, pdf):
        fn = build_function(pdf.make_indirect(Dictionary(
            FunctionType=2, Domain=[0.0, 1.0], N=1.0, C0=[0.0, 0.0], C1=[1.0, 0.5])))
        assert _approx(fn([0.0]), [0.0, 0.0])
        assert _approx(fn([1.0]), [1.0, 0.5])
        assert _approx(fn([0.5]), [0.5, 0.25])

    def test_type2_clips_input_to_domain(self, pdf):
        fn = build_function(pdf.make_indirect(Dictionary(
            FunctionType=2, Domain=[0.0, 1.0], N=1.0, C0=[0.0], C1=[1.0])))
        assert _approx(fn([2.0]), [1.0])  # clamped to domain hi
        assert _approx(fn([-1.0]), [0.0])

    def test_type3_stitching(self, pdf):
        sub0 = Dictionary(FunctionType=2, Domain=[0.0, 1.0], N=1.0, C0=[0.0], C1=[1.0])
        sub1 = Dictionary(FunctionType=2, Domain=[0.0, 1.0], N=1.0, C0=[1.0], C1=[0.0])
        fn = build_function(pdf.make_indirect(Dictionary(
            FunctionType=3, Domain=[0.0, 1.0], Functions=Array([sub0, sub1]),
            Bounds=[0.5], Encode=[0.0, 1.0, 0.0, 1.0])))
        # x=0.25 → sub0 encoded to 0.5 → 0.5
        assert _approx(fn([0.25]), [0.5])
        # x=0.75 → sub1 encoded to 0.5 → 0.5 (sub1 is 1->0, at 0.5 → 0.5)
        assert _approx(fn([0.75]), [0.5])
        # x=0.0 → sub0 at 0 → 0 ; x=1.0 → sub1 at 1 → 0
        assert _approx(fn([0.0]), [0.0])
        assert _approx(fn([1.0]), [0.0])

    def test_type4_postscript_arithmetic(self, pdf):
        s = pdf.make_stream(b"{ add 2 div }")
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0, 0.0, 1.0]
        s["/Range"] = [0.0, 1.0]
        fn = build_function(s)
        assert _approx(fn([0.4, 0.6]), [0.5])  # (0.4+0.6)/2

    def test_type4_ifelse_and_stack_ops(self, pdf):
        # if input > 0.5 return 1 else 0 (via dup, gt, ifelse)
        s = pdf.make_stream(b"{ dup 0.5 gt { pop 1 } { pop 0 } ifelse }")
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0]
        s["/Range"] = [0.0, 1.0]
        fn = build_function(s)
        assert _approx(fn([0.8]), [1.0])
        assert _approx(fn([0.2]), [0.0])

    def test_type4_roll_and_index(self, pdf):
        # 3 1 roll then output top three: verifies roll/copy don't crash
        s = pdf.make_stream(b"{ 3 1 roll }")
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
        s["/Range"] = [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
        fn = build_function(s)
        # inputs a,b,c → roll right by 1 → c,a,b
        assert _approx(fn([0.1, 0.2, 0.3]), [0.3, 0.1, 0.2])

    def test_type4_output_clipped_to_range(self, pdf):
        s = pdf.make_stream(b"{ pop 5 }")  # outputs 5, Range clips to 1
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0]
        s["/Range"] = [0.0, 1.0]
        fn = build_function(s)
        assert _approx(fn([0.5]), [1.0])

    def test_type4_unknown_operator_returns_none(self, pdf):
        s = pdf.make_stream(b"{ frobnicate }")
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0]
        s["/Range"] = [0.0, 1.0]
        fn = build_function(s)
        assert fn([0.5]) is None  # unknown op → unknown colour, never a guess

    def test_type0_sampled_identity(self, pdf):
        # 1-in 1-out, 2 samples [0, 255] over 8 bits → linear 0..1 identity.
        s = pdf.make_stream(bytes([0, 255]))
        s["/FunctionType"] = 0
        s["/Domain"] = [0.0, 1.0]
        s["/Range"] = [0.0, 1.0]
        s["/Size"] = [2]
        s["/BitsPerSample"] = 8
        fn = build_function(s)
        assert _approx(fn([0.0]), [0.0])
        assert _approx(fn([1.0]), [1.0])
        assert _approx(fn([0.5]), [0.5], tol=1e-3)  # interpolated midpoint

    def test_type4_deeply_nested_returns_none_not_recursionerror(self, pdf):
        # Review CRITICAL: a hostile/malformed program with thousands of nested
        # `{` must degrade to None, NEVER escape as an uncaught RecursionError
        # that aborts the whole vector listing.
        s = pdf.make_stream(("{ " * 3000).encode("latin-1"))
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0]
        s["/Range"] = [0.0, 1.0]
        assert build_function(s) is None

    def test_type4_stack_underflow_returns_none(self, pdf):
        # Review MEDIUM: roll/copy with n > stack depth must FAIL (→ unknown),
        # not silently clamp via negative slicing to a bogus colour.
        for prog in (b"{ 5 1 roll }", b"{ 5 copy }", b"{ 3 index }"):
            s = pdf.make_stream(prog)
            s["/FunctionType"] = 4
            s["/Domain"] = [0.0, 1.0, 0.0, 1.0]
            s["/Range"] = [0.0, 1.0]
            assert build_function(s)([0.2, 0.4]) is None

    def test_type4_round_is_half_up_not_bankers(self, pdf):
        s = pdf.make_stream(b"{ round }")
        s["/FunctionType"] = 4
        s["/Domain"] = [-10.0, 10.0]
        s["/Range"] = [-10.0, 10.0]
        fn = build_function(s)
        assert _approx(fn([0.5]), [1.0])   # PostScript: .5 rounds up
        assert _approx(fn([2.5]), [3.0])   # not banker's 2.0
        assert _approx(fn([-2.5]), [-2.0])  # toward +infinity

    def test_unsupported_type_returns_none(self, pdf):
        assert build_function(pdf.make_indirect(Dictionary(
            FunctionType=9, Domain=[0.0, 1.0]))) is None

    def test_array_of_functions(self, pdf):
        f0 = Dictionary(FunctionType=2, Domain=[0.0, 1.0], N=1.0, C0=[0.0], C1=[1.0])
        f1 = Dictionary(FunctionType=2, Domain=[0.0, 1.0], N=1.0, C0=[1.0], C1=[0.0])
        fn = build_function(pdf.make_indirect(Array([f0, f1])))
        assert _approx(fn([0.25]), [0.25, 0.75])


# ── colour spaces ──────────────────────────────────────────────────────────


class TestResolvers:
    def test_device_spaces(self):
        assert _approx(build_resolver("/DeviceGray", None)([0.4]), [0.4, 0.4, 0.4])
        assert _approx(build_resolver("/DeviceRGB", None)([0.1, 0.2, 0.3]), [0.1, 0.2, 0.3])
        # CMYK (0,1,1,0) → magenta+yellow full, no black → red.
        assert _approx(build_resolver("/DeviceCMYK", None)([0.0, 1.0, 1.0, 0.0]), [1.0, 0.0, 0.0])

    def test_icc_by_component_count(self, pdf):
        for n, comps, want in [(1, [0.5], [0.5, 0.5, 0.5]),
                               (3, [0.1, 0.2, 0.3], [0.1, 0.2, 0.3]),
                               (4, [0.0, 1.0, 1.0, 0.0], [1.0, 0.0, 0.0])]:
            st = pdf.make_stream(b"\x00")
            st["/N"] = n
            r = build_resolver(Array([Name("/ICCBased"), st]), None)
            assert _approx(r(comps), want)

    def test_icc_falls_back_to_alternate(self, pdf):
        st = pdf.make_stream(b"\x00")
        st["/Alternate"] = Name("/DeviceRGB")  # no /N
        r = build_resolver(Array([Name("/ICCBased"), st]), None)
        assert _approx(r([0.2, 0.4, 0.6]), [0.2, 0.4, 0.6])

    def test_indexed_over_rgb(self):
        cs = Array([Name("/Indexed"), Name("/DeviceRGB"), 1,
                    String(bytes([0, 255, 0, 0, 0, 255]))])
        r = build_resolver(cs, None)
        assert _approx(r([0]), [0.0, 1.0, 0.0])  # green
        assert _approx(r([1]), [0.0, 0.0, 1.0])  # blue
        assert _approx(r([9]), [0.0, 0.0, 1.0])  # clamped to hival

    def test_separation_type2(self, pdf):
        tint = Dictionary(FunctionType=2, Domain=[0.0, 1.0], N=1.0,
                          C0=[0.0, 0.0, 0.0, 0.0], C1=[0.0, 1.0, 1.0, 0.0])
        cs = Array([Name("/Separation"), Name("/Spot"), Name("/DeviceCMYK"),
                    pdf.make_indirect(tint)])
        r = build_resolver(cs, None)
        assert _approx(r([1.0]), [1.0, 0.0, 0.0])  # full tint → red-ish
        assert _approx(r([0.0]), [1.0, 1.0, 1.0])  # no tint → white

    def test_devicen_type4(self, pdf):
        s = pdf.make_stream(b"{ pop pop 0.2 0.4 0.6 }")
        s["/FunctionType"] = 4
        s["/Domain"] = [0.0, 1.0, 0.0, 1.0]
        s["/Range"] = [0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
        cs = Array([Name("/DeviceN"), Array([Name("/A"), Name("/B")]),
                    Name("/DeviceRGB"), s])
        r = build_resolver(cs, None)
        assert _approx(r([0.3, 0.7]), [0.2, 0.4, 0.6])

    def test_lab_black_and_white(self):
        cs = Array([Name("/Lab"), Dictionary(WhitePoint=[0.9505, 1.0, 1.089],
                                             Range=[-128, 127, -128, 127])])
        r = build_resolver(cs, None)
        white = r([100.0, 0.0, 0.0])
        black = r([0.0, 0.0, 0.0])
        assert white[0] > 0.9 and white[1] > 0.9 and white[2] > 0.9
        assert black[0] < 0.1 and black[1] < 0.1 and black[2] < 0.1

    def test_pattern_space_is_none(self):
        assert build_resolver("/Pattern", None) is None

    def test_named_space_via_resources(self, pdf):
        st = pdf.make_stream(b"\x00")
        st["/N"] = 3
        resources = Dictionary(ColorSpace=Dictionary(CS0=Array([Name("/ICCBased"), st])))
        r = build_resolver("/CS0", resources)
        assert _approx(r([0.5, 0.5, 0.5]), [0.5, 0.5, 0.5])

    def test_unknown_named_space_returns_none(self):
        assert build_resolver("/DoesNotExist", Dictionary(ColorSpace=Dictionary())) is None


# ── resolve_color (the page_vectors entry point) ───────────────────────────


class TestResolveColor:
    def test_scn_in_separation(self, pdf):
        tint = Dictionary(FunctionType=2, Domain=[0.0, 1.0], N=1.0,
                          C0=[0.0, 0.0, 0.0, 0.0], C1=[0.0, 1.0, 1.0, 0.0])
        resources = Dictionary(ColorSpace=Dictionary(
            SEP=Array([Name("/Separation"), Name("/Spot"), Name("/DeviceCMYK"),
                       pdf.make_indirect(tint)])))
        got = resolve_color(("cs", ("/SEP",)), ("scn", (1.0,)), resources)
        assert _approx(got, [1.0, 0.0, 0.0])

    def test_scn_with_pattern_name_is_none(self):
        # scn with a trailing name operand ⇒ a pattern; unknown, never guessed.
        assert resolve_color(("cs", ("/P",)), ("scn", ("/P0",)), None) is None

    def test_stroke_cs_scn_uppercase_resolved(self, pdf):
        # A stroke colour is captured as CS/SCN (uppercase); resolve_color
        # normalises case so a stroked non-device path gets a swatch too.
        st = pdf.make_stream(b"\x00")
        st["/N"] = 3
        resources = Dictionary(ColorSpace=Dictionary(ICC=Array([Name("/ICCBased"), st])))
        got = resolve_color(("CS", ("/ICC",)), ("SCN", (0.2, 0.4, 0.6)), resources)
        assert _approx(got, [0.2, 0.4, 0.6])

    def test_no_space_op_is_none(self):
        assert resolve_color(None, ("scn", (0.5,)), None) is None

    def test_device_op_not_handled_here(self):
        # g/rg/k are resolved inline by page_vectors, not here.
        assert resolve_color(None, ("rg", (1.0, 0.0, 0.0)), None) is None
