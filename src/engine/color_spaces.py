"""Resolve a PDF colour to approximate sRGB [r, g, b] for the vector swatch
(§ I.0 S5).

`page_vectors` resolves device colours (`g`/`rg`/`k`) inline; THIS module
resolves the named/complex spaces a `cs`/`scn` selects — ICCBased, Indexed,
Separation, DeviceN, CalGray/CalRGB, Lab — by threading the page/form
`/Resources /ColorSpace` and evaluating any tint-transform FUNCTION (types
0/2/3/4). Before S5 those vectors returned None ("unknown") and could not show
a swatch; now they resolve to a display colour.

Honest-unknown discipline (unchanged from before S5): anything we cannot
resolve — a Pattern fill, an unparseable/unsupported function, a malformed
space — returns None. The swatch shows "unknown", never a WRONG colour.

NOT colour-managed. ICCBased is interpreted by its `/N` component count (the
device approximation a viewer falls back to without a CMM), not through the
embedded profile — a swatch wants a fast, close display colour. Exact ICC
transforms are the prepress domain (Ghostscript + LittleCMS, the
Convert-to-CMYK path). Lab uses the D50 white point PDF assumes.
"""

import math

import pikepdf

_MAX_DEPTH = 8  # colour-space / function nesting guard (cyclic or hostile input)


# ── numeric helpers ────────────────────────────────────────────────────────


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _nums(seq) -> list | None:
    try:
        return [float(v) for v in seq]
    except (TypeError, ValueError):
        return None


def _cmyk_to_rgb(c: float, m: float, y: float, k: float) -> list:
    return [
        _clamp01((1 - c) * (1 - k)),
        _clamp01((1 - m) * (1 - k)),
        _clamp01((1 - y) * (1 - k)),
    ]


def _lab_to_rgb(lstar: float, astar: float, bstar: float, wp=(0.9642, 1.0, 0.8249)) -> list:
    """CIE L*a*b* → sRGB under the given white point (PDF's default is D50).
    Clamped; out-of-gamut components fold into [0,1]."""
    fy = (lstar + 16.0) / 116.0
    fx = fy + astar / 500.0
    fz = fy - bstar / 200.0

    def inv(t: float) -> float:
        return t**3 if t**3 > 0.008856 else (t - 16.0 / 116.0) / 7.787

    x = wp[0] * inv(fx)
    y = wp[1] * inv(fy)
    z = wp[2] * inv(fz)
    # XYZ (D50) → linear sRGB via the Bradford-adapted D65 matrix is overkill
    # for a swatch; the standard D50→sRGB matrix is close enough.
    r = x * 3.1338561 - y * 1.6168667 - z * 0.4906146
    g = x * -0.9787684 + y * 1.9161415 + z * 0.0334540
    b = x * 0.0719453 - y * 0.2289914 + z * 1.4052427

    def gamma(u: float) -> float:
        u = max(0.0, u)
        return 1.055 * (u ** (1 / 2.4)) - 0.055 if u > 0.0031308 else 12.92 * u

    return [_clamp01(gamma(r)), _clamp01(gamma(g)), _clamp01(gamma(b))]


# ── PDF functions (ISO 32000 §7.10) ────────────────────────────────────────


def build_function(obj, depth: int = 0):
    """A callable `f(inputs: list[float]) -> list[float] | None` for a PDF
    function object, or an ARRAY of 1-output functions (Separation/DeviceN may
    supply one per alternate component). Returns None for an unsupported or
    malformed function — the caller then reports the colour as unknown."""
    if depth > _MAX_DEPTH or obj is None:
        return None
    try:
        if isinstance(obj, pikepdf.Array):
            fns = [build_function(el, depth + 1) for el in obj]
            if not fns or any(f is None for f in fns):
                return None

            def _call_array(inputs, _fns=fns):
                out = []
                for f in _fns:
                    r = f(inputs)
                    if r is None:
                        return None
                    out.extend(r)
                return out

            return _call_array

        ftype = int(obj.get("/FunctionType"))
        domain = _nums(obj.get("/Domain") or [])
        if domain is None or len(domain) < 2 or len(domain) % 2 != 0:
            return None
        if ftype == 2:
            return _fn_exponential(obj, domain)
        if ftype == 3:
            return _fn_stitching(obj, domain, depth)
        if ftype == 0:
            return _fn_sampled(obj, domain)
        if ftype == 4:
            return _fn_postscript(obj, domain)
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
        return None
    return None


def _clip_domain(inputs: list, domain: list) -> list:
    out = []
    for i, x in enumerate(inputs):
        lo, hi = domain[2 * i], domain[2 * i + 1]
        out.append(lo if x < lo else hi if x > hi else x)
    return out


def _interp(x, xmin, xmax, ymin, ymax):
    if xmax == xmin:
        return ymin
    return ymin + (x - xmin) * (ymax - ymin) / (xmax - xmin)


def _fn_exponential(obj, domain):
    c0 = _nums(obj.get("/C0") or [0.0])
    c1 = _nums(obj.get("/C1") or [1.0])
    n = float(obj.get("/N"))
    if c0 is None or c1 is None or len(c0) != len(c1):
        return None

    def f(inputs, _c0=c0, _c1=c1, _n=n, _dom=domain):
        if not inputs:
            return None
        x = _clip_domain(inputs, _dom)[0]
        try:
            xn = x**_n
        except (ValueError, OverflowError):
            return None
        return [_c0[i] + xn * (_c1[i] - _c0[i]) for i in range(len(_c0))]

    return f


def _fn_stitching(obj, domain, depth):
    subs = [build_function(el, depth + 1) for el in (obj.get("/Functions") or [])]
    bounds = _nums(obj.get("/Bounds") or [])
    encode = _nums(obj.get("/Encode") or [])
    k = len(subs)
    if k == 0 or any(s is None for s in subs) or bounds is None or encode is None:
        return None
    if len(bounds) != k - 1 or len(encode) != 2 * k:
        return None

    def f(inputs, _subs=subs, _b=bounds, _e=encode, _dom=domain):
        if not inputs:
            return None
        x = _clip_domain(inputs, _dom)[0]
        d0, d1 = _dom[0], _dom[1]
        i = 0
        while i < len(_b) and x >= _b[i]:
            i += 1
        lo = d0 if i == 0 else _b[i - 1]
        hi = d1 if i == len(_b) else _b[i]
        xe = _interp(x, lo, hi, _e[2 * i], _e[2 * i + 1])
        return _subs[i]([xe])

    return f


def _fn_sampled(obj, domain):
    if not isinstance(obj, pikepdf.Stream):
        return None
    size = [int(v) for v in (obj.get("/Size") or [])]
    bps = int(obj.get("/BitsPerSample"))
    rng = _nums(obj.get("/Range") or [])
    m = len(size)
    if m == 0 or rng is None or len(rng) < 2 or len(rng) % 2 != 0:
        return None
    n = len(rng) // 2
    if any(s < 1 for s in size) or bps not in (1, 2, 4, 8, 12, 16, 24, 32):
        return None
    encode = _nums(obj.get("/Encode") or [])
    if not encode:
        encode = []
        for s in size:
            encode.extend([0.0, float(s - 1)])
    decode = _nums(obj.get("/Decode") or [])
    if not decode:
        decode = list(rng)
    if len(encode) != 2 * m or len(decode) != 2 * n:
        return None
    try:
        data = obj.read_bytes()
    except Exception:
        return None
    total_samples = 1
    for s in size:
        total_samples *= s
    maxval = (1 << bps) - 1
    if len(data) * 8 < total_samples * n * bps:
        return None

    def sample_at(flat_index, out_i, _data=data, _bps=bps, _n=n):
        bit = (flat_index * _n + out_i) * _bps
        val = 0
        for _ in range(_bps):
            byte = _data[bit >> 3]
            val = (val << 1) | ((byte >> (7 - (bit & 7))) & 1)
            bit += 1
        return val

    def flat(coords, _size=size):
        # First dimension varies fastest (ISO 32000 §7.10.2).
        idx = 0
        mult = 1
        for j in range(len(coords)):
            idx += coords[j] * mult
            mult *= _size[j]
        return idx

    def f(inputs, _dom=domain, _size=size, _enc=encode, _dec=decode, _rng=rng, _max=maxval):
        if len(inputs) != m:
            return None
        clipped = _clip_domain(inputs, _dom)
        # Encode each input to sample space, clamp to [0, size-1].
        e = []
        for j in range(m):
            ej = _interp(clipped[j], _dom[2 * j], _dom[2 * j + 1], _enc[2 * j], _enc[2 * j + 1])
            ej = 0.0 if ej < 0 else float(_size[j] - 1) if ej > _size[j] - 1 else ej
            e.append(ej)
        lows = [int(math.floor(v)) for v in e]
        fracs = [v - lo for v, lo in zip(e, lows)]
        # Multilinear interpolation over the 2^m surrounding corners.
        out = [0.0] * n
        for corner in range(1 << m):
            weight = 1.0
            coords = []
            for j in range(m):
                hi = (corner >> j) & 1
                c = lows[j] + hi
                if c > _size[j] - 1:
                    c = _size[j] - 1
                coords.append(c)
                weight *= fracs[j] if hi else (1.0 - fracs[j])
            if weight == 0.0:
                continue
            fi = flat(coords)
            for oi in range(n):
                out[oi] += weight * sample_at(fi, oi)
        # Decode from [0, 2^bps-1] to the output Range.
        return [
            _interp(out[oi], 0.0, _max, _dec[2 * oi], _dec[2 * oi + 1]) for oi in range(n)
        ]

    return f


# --- Type 4: PostScript calculator ------------------------------------------


def _tokenize_ps(text: str) -> list:
    """Tokens of a Type-4 program: `{`, `}`, numbers, and operator names."""
    toks = []
    i, ln = 0, len(text)
    while i < ln:
        ch = text[i]
        if ch in " \t\r\n\f\0":
            i += 1
        elif ch in "{}":
            toks.append(ch)
            i += 1
        elif ch == "%":  # comment to end of line
            while i < ln and text[i] not in "\r\n":
                i += 1
        else:
            j = i
            while j < ln and text[j] not in " \t\r\n\f\0{}%":
                j += 1
            toks.append(text[i:j])
            i = j
    return toks


def _parse_ps(tokens: list, pos: int, depth: int = 0):
    """Parse one `{ ... }` block into a nested list of ops/sub-blocks. Numbers
    become floats; operator names stay strings; sub-blocks become lists.
    `depth` caps nesting so a hostile/malformed program (thousands of unbalanced
    `{`) returns None instead of blowing the Python recursion limit and
    escaping as an uncaught RecursionError into the vector walk."""
    if depth > 100 or pos >= len(tokens) or tokens[pos] != "{":
        return None, pos
    prog = []
    pos += 1
    while pos < len(tokens):
        t = tokens[pos]
        if t == "}":
            return prog, pos + 1
        if t == "{":
            block, pos = _parse_ps(tokens, pos, depth + 1)
            if block is None:
                return None, pos
            prog.append(block)
            continue
        try:
            prog.append(float(t))
        except ValueError:
            prog.append(t)
        pos += 1
    return None, pos  # unterminated


def _run_ps(prog: list, stack: list, depth: int = 0) -> bool:
    """Execute a parsed Type-4 program against `stack`. Returns False on any
    error (unknown op, underflow, bad type) so the caller reports unknown."""
    if depth > 100:
        return False
    i = 0
    while i < len(prog):
        tok = prog[i]
        i += 1
        if isinstance(tok, (int, float)):
            stack.append(float(tok))
            continue
        if isinstance(tok, list):
            stack.append(tok)  # a procedure literal (consumed by if/ifelse)
            continue
        try:
            if not _ps_op(tok, stack, depth):
                return False
        except (IndexError, ValueError, TypeError, OverflowError, ZeroDivisionError):
            return False
    return True


def _ps_op(op: str, st: list, depth: int) -> bool:
    def pop_num():
        v = st.pop()
        if isinstance(v, list):
            raise TypeError("expected number, got procedure")
        return float(v)

    if op in ("add", "sub", "mul", "div", "idiv", "mod", "atan", "exp"):
        b = pop_num()
        a = pop_num()
        if op == "add":
            st.append(a + b)
        elif op == "sub":
            st.append(a - b)
        elif op == "mul":
            st.append(a * b)
        elif op == "div":
            st.append(a / b)
        elif op == "idiv":
            st.append(float(int(a) // int(b)))
        elif op == "mod":
            st.append(float(int(a) % int(b)))
        elif op == "atan":
            deg = math.degrees(math.atan2(a, b))
            st.append(deg + 360.0 if deg < 0 else deg)
        elif op == "exp":
            st.append(a**b)
        return True
    if op in ("neg", "abs", "sqrt", "sin", "cos", "ln", "log", "cvi", "cvr",
              "ceiling", "floor", "round", "truncate", "not"):
        a = pop_num()
        if op == "neg":
            st.append(-a)
        elif op == "abs":
            st.append(abs(a))
        elif op == "sqrt":
            st.append(math.sqrt(a) if a >= 0 else float("nan"))
        elif op == "sin":
            st.append(math.sin(math.radians(a)))
        elif op == "cos":
            st.append(math.cos(math.radians(a)))
        elif op == "ln":
            st.append(math.log(a))
        elif op == "log":
            st.append(math.log10(a))
        elif op == "cvi" or op == "truncate":
            st.append(float(math.trunc(a)))
        elif op == "cvr":
            st.append(float(a))
        elif op == "ceiling":
            st.append(math.ceil(a))
        elif op == "floor":
            st.append(math.floor(a))
        elif op == "round":
            # PostScript rounds a .5 toward +infinity (round(2.5)=3,
            # round(-2.5)=-2), NOT Python 3's round-half-to-even.
            st.append(math.floor(a + 0.5))
        elif op == "not":
            st.append(0.0 if a != 0.0 else 1.0)
        return True
    if op in ("eq", "ne", "gt", "ge", "lt", "le", "and", "or", "xor"):
        b = pop_num()
        a = pop_num()
        if op == "eq":
            r = a == b
        elif op == "ne":
            r = a != b
        elif op == "gt":
            r = a > b
        elif op == "ge":
            r = a >= b
        elif op == "lt":
            r = a < b
        elif op == "le":
            r = a <= b
        elif op == "and":
            r = int(a) & int(b)
        elif op == "or":
            r = int(a) | int(b)
        else:
            r = int(a) ^ int(b)
        st.append(float(int(r)))
        return True
    if op == "true":
        st.append(1.0)
        return True
    if op == "false":
        st.append(0.0)
        return True
    if op == "pop":
        st.pop()
        return True
    if op == "exch":
        st[-1], st[-2] = st[-2], st[-1]
        return True
    if op == "dup":
        st.append(st[-1])
        return True
    if op == "copy":
        n = int(pop_num())
        if n < 0 or n > len(st):
            return False  # stack underflow — a malformed program, not a colour
        if n > 0:
            st.extend(st[-n:])
        return True
    if op == "index":
        n = int(pop_num())
        if n < 0 or n >= len(st):
            return False
        st.append(st[-1 - n])
        return True
    if op == "roll":
        j = int(pop_num())
        n = int(pop_num())
        if n < 0 or n > len(st):
            return False  # negative slicing would silently clamp → wrong result
        if n > 0:
            j %= n
            part = st[-n:]
            del st[-n:]
            st.extend(part[-j:] + part[:-j])
        return True
    if op == "if":
        proc = st.pop()
        cond = pop_num()
        if not isinstance(proc, list):
            return False
        if cond != 0.0:
            return _run_ps(proc, st, depth + 1)
        return True
    if op == "ifelse":
        proc2 = st.pop()
        proc1 = st.pop()
        cond = pop_num()
        if not isinstance(proc1, list) or not isinstance(proc2, list):
            return False
        return _run_ps(proc1 if cond != 0.0 else proc2, st, depth + 1)
    if op == "bitshift":
        shift = int(pop_num())
        val = int(pop_num())
        st.append(float(val << shift if shift >= 0 else val >> -shift))
        return True
    return False  # unknown operator


def _fn_postscript(obj, domain):
    if not isinstance(obj, pikepdf.Stream):
        return None
    rng = _nums(obj.get("/Range") or [])
    if rng is None or len(rng) < 2 or len(rng) % 2 != 0:
        return None
    n = len(rng) // 2
    try:
        text = obj.read_bytes().decode("latin-1")
    except Exception:
        return None
    tokens = _tokenize_ps(text)
    prog, _ = _parse_ps(tokens, 0)
    if prog is None:
        return None

    def f(inputs, _prog=prog, _dom=domain, _rng=rng, _n=n):
        stack = list(_clip_domain(inputs, _dom))
        if not _run_ps(_prog, stack, 0):
            return None
        if len(stack) < _n:
            return None
        out = stack[-_n:]
        try:
            out = [float(v) for v in out]
        except (TypeError, ValueError):
            return None
        # Clip each output to its Range.
        return [
            max(_rng[2 * i], min(_rng[2 * i + 1], out[i])) for i in range(_n)
        ]

    return f


# ── colour spaces (ISO 32000 §8.6) ─────────────────────────────────────────

_DEVICE_COMPONENTS = {"/DeviceGray": 1, "/DeviceRGB": 3, "/DeviceCMYK": 4}


def _device_resolver(name: str):
    if name in ("/DeviceGray", "/CalGray", "/G"):
        return lambda c: [_clamp01(c[0])] * 3 if len(c) >= 1 else None
    if name in ("/DeviceRGB", "/CalRGB", "/RGB"):
        return lambda c: [_clamp01(c[0]), _clamp01(c[1]), _clamp01(c[2])] if len(c) >= 3 else None
    if name in ("/DeviceCMYK", "/CMYK"):
        return lambda c: _cmyk_to_rgb(c[0], c[1], c[2], c[3]) if len(c) >= 4 else None
    return None


def build_resolver(cs, resources, depth: int = 0):
    """Return `resolve(comps: list[float]) -> [r,g,b] | None` for a colour
    space `cs` (a Name string, a pikepdf Name, or an Array), or None when the
    space is unsupported (Pattern) or malformed. `resources` resolves a named
    space against `/Resources /ColorSpace`."""
    if depth > _MAX_DEPTH:
        return None
    # A bare name: a device space, or a key into /Resources /ColorSpace.
    if isinstance(cs, (str, pikepdf.Name)):
        name = str(cs)
        dev = _device_resolver(name)
        if dev is not None:
            return dev
        if name == "/Pattern":
            return None  # a pattern is not a flat colour
        if name in ("/DeviceGray", "/DeviceRGB", "/DeviceCMYK"):
            return _device_resolver(name)
        # A named resource space.
        if resources is not None:
            try:
                csdict = resources.get("/ColorSpace")
                if csdict is not None:
                    target = csdict.get(pikepdf.Name(name))
                    if target is not None:
                        return build_resolver(target, resources, depth + 1)
            except (AttributeError, KeyError):
                return None
        return None
    # An array: [family ...].
    if isinstance(cs, pikepdf.Array):
        if len(cs) == 0:
            return None
        family = str(cs[0])
        if family == "/ICCBased":
            return _icc_resolver(cs, resources, depth)
        if family == "/Indexed" or family == "/I":
            return _indexed_resolver(cs, resources, depth)
        if family == "/Separation":
            return _separation_resolver(cs, resources, depth)
        if family == "/DeviceN":
            return _devicen_resolver(cs, resources, depth)
        if family in ("/CalGray",):
            return _device_resolver("/DeviceGray")
        if family in ("/CalRGB",):
            return _device_resolver("/DeviceRGB")
        if family == "/Lab":
            return _lab_resolver(cs)
        if family == "/Pattern":
            return None
        if family in ("/DeviceGray", "/DeviceRGB", "/DeviceCMYK"):
            return _device_resolver(family)
    return None


def _icc_resolver(cs, resources, depth):
    if len(cs) < 2:
        return None
    stream = cs[1]
    try:
        n = int(stream.get("/N"))
    except (TypeError, ValueError, AttributeError):
        n = None
    if n == 1:
        return _device_resolver("/DeviceGray")
    if n == 3:
        return _device_resolver("/DeviceRGB")
    if n == 4:
        return _device_resolver("/DeviceCMYK")
    # Fall back to the /Alternate space when /N is absent/unusual.
    try:
        alt = stream.get("/Alternate")
    except AttributeError:
        alt = None
    if alt is not None:
        return build_resolver(alt, resources, depth + 1)
    return None


def _lab_resolver(cs):
    rng = None
    try:
        params = cs[1]
        rng = _nums(params.get("/Range") or [-100.0, 100.0, -100.0, 100.0])
        wp = _nums(params.get("/WhitePoint") or [0.9642, 1.0, 0.8249])
    except (AttributeError, IndexError):
        rng, wp = [-100.0, 100.0, -100.0, 100.0], [0.9642, 1.0, 0.8249]
    if wp is None or len(wp) < 3:
        wp = [0.9642, 1.0, 0.8249]

    def resolve(c, _wp=tuple(wp[:3])):
        if len(c) < 3:
            return None
        return _lab_to_rgb(c[0], c[1], c[2], _wp)

    return resolve


def _indexed_resolver(cs, resources, depth):
    # [/Indexed base hival lookup]
    if len(cs) < 4:
        return None
    base = build_resolver(cs[1], resources, depth + 1)
    if base is None:
        return None
    try:
        hival = int(cs[2])
    except (TypeError, ValueError):
        return None
    base_ncomp = _base_component_count(cs[1], resources, depth)
    if base_ncomp is None or base_ncomp < 1:
        return None
    lookup = cs[3]
    try:
        if isinstance(lookup, pikepdf.Stream):
            table = lookup.read_bytes()
        elif isinstance(lookup, pikepdf.String):
            table = bytes(lookup)
        else:
            table = bytes(lookup)
    except Exception:
        return None

    def resolve(c, _base=base, _tab=table, _nc=base_ncomp, _hi=hival):
        if not c:
            return None
        idx = int(round(c[0]))
        idx = 0 if idx < 0 else _hi if idx > _hi else idx
        start = idx * _nc
        if start + _nc > len(_tab):
            return None
        comps = [_tab[start + j] / 255.0 for j in range(_nc)]
        return _base(comps)

    return resolve


def _separation_resolver(cs, resources, depth):
    # [/Separation name alternate tintTransform]
    if len(cs) < 4:
        return None
    alt = build_resolver(cs[2], resources, depth + 1)
    tint = build_function(cs[3])
    if alt is None or tint is None:
        return None

    def resolve(c, _alt=alt, _tint=tint):
        if not c:
            return None
        out = _tint([c[0]])
        return _alt(out) if out is not None else None

    return resolve


def _devicen_resolver(cs, resources, depth):
    # [/DeviceN names alternate tintTransform (attributes)]
    if len(cs) < 4:
        return None
    try:
        names = list(cs[1])
    except TypeError:
        return None
    ncomp = len(names)
    alt = build_resolver(cs[2], resources, depth + 1)
    tint = build_function(cs[3])
    if alt is None or tint is None or ncomp < 1:
        return None

    def resolve(c, _alt=alt, _tint=tint, _n=ncomp):
        if len(c) < _n:
            return None
        out = _tint(list(c[:_n]))
        return _alt(out) if out is not None else None

    return resolve


def _base_component_count(cs, resources, depth) -> int | None:
    """Number of colour components a space consumes — needed to stride an
    Indexed lookup table."""
    if isinstance(cs, (str, pikepdf.Name)):
        name = str(cs)
        if name in _DEVICE_COMPONENTS:
            return _DEVICE_COMPONENTS[name]
        if resources is not None:
            try:
                csdict = resources.get("/ColorSpace")
                if csdict is not None:
                    target = csdict.get(pikepdf.Name(name))
                    if target is not None:
                        return _base_component_count(target, resources, depth + 1)
            except (AttributeError, KeyError):
                return None
        return None
    if isinstance(cs, pikepdf.Array) and len(cs) > 0:
        family = str(cs[0])
        if family in _DEVICE_COMPONENTS:
            return _DEVICE_COMPONENTS[family]
        if family == "/ICCBased" and len(cs) >= 2:
            try:
                return int(cs[1].get("/N"))
            except (TypeError, ValueError, AttributeError):
                return None
        if family in ("/CalGray",):
            return 1
        if family in ("/CalRGB", "/Lab"):
            return 3
        if family == "/DeviceN" and len(cs) >= 2:
            try:
                return len(list(cs[1]))
            except TypeError:
                return None
        if family == "/Separation":
            return 1
    return None


# ── top level ──────────────────────────────────────────────────────────────


def resolve_color(space_op, value_op, resources, pdf=None):
    """Best-effort sRGB [r, g, b] for a captured (space_op, value_op) colour in
    a NON-device space, or None (unknown). Device g/rg/k are resolved by the
    caller inline; this handles `cs`/`scn` (and `CS`/`SCN`) against a named
    colour space. A Pattern scn (a name operand) is unknown."""
    if value_op is None:
        return None
    op, vals = value_op
    if op.lower() not in ("sc", "scn"):
        return None
    if space_op is None:
        return None
    sname_op, sname_vals = space_op[0], space_op[1]
    if sname_op.lower() not in ("cs",) or not sname_vals:
        return None
    space_name = sname_vals[0]
    if not isinstance(space_name, str):
        return None
    # A trailing name operand ⇒ a pattern (coloured or uncoloured) — unknown.
    if any(isinstance(v, str) for v in vals):
        return None
    comps = [float(v) for v in vals if isinstance(v, (int, float))]
    try:
        resolver = build_resolver(space_name, resources)
        if resolver is None:
            return None
        rgb = resolver(comps)
    except (IndexError, ValueError, TypeError, ZeroDivisionError, OverflowError, RecursionError):
        return None
    if rgb is None or len(rgb) != 3:
        return None
    return [_clamp01(float(rgb[0])), _clamp01(float(rgb[1])), _clamp01(float(rgb[2]))]
