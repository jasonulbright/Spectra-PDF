"""Evaluator: recognized field scripts over a plain value map.

Pure over plain values — no pikepdf, no file paths — so the whole semantic
surface is testable without authoring a PDF, and so it can be pinned case for
case against `tests/fixtures/af-corpus.json` alongside the TypeScript twin
(`src/renderer/lib/af-calc.ts`). Python is authoritative for what lands in a
file; the TypeScript half is the live-preview twin and writes no bytes.

Arithmetic follows the reference implementation exactly, including the parts
that look like defects:

  * `make_number` replaces the FIRST comma with a decimal point, so `"1,234"`
    is 1.234. An evaluator that "fixed" this would produce different totals
    from every other viewer.
  * A non-finite value formats as empty, so a division by zero needs no rule
    of its own.
  * `AFSimple_Calculate` skips a name the document does not have, contributes
    zero for a non-numeric child, yields zero for an empty set, expands a
    parent to all its terminal children, and rounds to six decimals.

Two behaviours are ours rather than the reference's, both because the
reference's own is implementation-defined and therefore cannot be pinned:

  * A date string the mask cannot parse falls back to the ECMAScript Date
    Time String Format (the ISO 8601 subset the language actually specifies)
    rather than to a host's free-form `Date.parse` heuristics.
  * Keystroke scripts are evaluated at COMMIT only. Nothing in this app
    delivers a per-character change event to a document script.
"""

from __future__ import annotations

import math
import re
from decimal import Decimal, ROUND_HALF_UP

from engine.afscript import ENTRY_POINTS, dependencies, recognize, sfn_fields  # noqa: F401

DATE_FORMATS = [
    "m/d", "m/d/yy", "mm/dd/yy", "mm/yy", "d-mmm", "d-mmm-yy", "dd-mmm-yy",
    "yy-mm-dd", "mmm-yy", "mmmm-yy", "mmm d, yyyy", "mmmm d, yyyy",
    "m/d/yy h:MM tt", "m/d/yy HH:MM",
]
TIME_FORMATS = ["HH:MM", "h:MM tt", "HH:MM:ss", "h:MM:ss tt"]

#: Hard-coded English in the reference, so a `mmm-yy` mask emits `Mar-26` in
#: every viewer regardless of the reader's language. A formatted field value
#: follows the FORM's conventions, never the UI locale.
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]
DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

#: The whole i18n rule for a formatted number: a fixed five-entry table
#: selected by the form's own `sepStyle`, clamped to 0..4.
SEPARATORS = [(",", "."), ("", "."), (".", ","), ("", ","), ("'", ".")]


class Unsupported(Exception):
    """A recognized call the reference itself throws on — an unknown
    `cFunction`, a negative percent precision. The field is reported as
    carrying a script this app does not run; its neighbours still calculate.

    Not a public engine refusal: it never leaves this module's callers as a
    message, so it carries no entry in the engine message table.
    """


# ── JavaScript number ⇄ string ────────────────────────────────────────────


def number_to_string(value: float) -> str:
    """`Number.prototype.toString(10)` — the exact algorithm, because a value
    computed here is stored as text and read back by other viewers."""
    if isinstance(value, bool):
        return "true" if value else "false"
    value = float(value)
    if math.isnan(value):
        return "NaN"
    if value == 0:
        return "0"
    if value < 0:
        return "-" + number_to_string(-value)
    if math.isinf(value):
        return "Infinity"
    digits, n = _shortest_digits(value)
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    exponent = n - 1
    sign = "+" if exponent >= 0 else "-"
    head = digits[0] if k == 1 else digits[0] + "." + digits[1:]
    return f"{head}e{sign}{abs(exponent)}"


def _shortest_digits(value: float) -> tuple[str, int]:
    """(shortest round-trip digits, n) with value == 0.<digits> × 10**n."""
    text = repr(value)
    if "e" in text or "E" in text:
        mantissa, _, exponent_text = text.replace("E", "e").partition("e")
        exponent = int(exponent_text)
    else:
        mantissa, exponent = text, 0
    integer_part, _, fraction = mantissa.partition(".")
    raw = (integer_part + fraction).lstrip("0")
    trimmed = raw.rstrip("0") or "0"
    scale = exponent - len(fraction) + (len(raw) - len(trimmed))
    return trimmed, len(trimmed) + scale


def to_fixed(value: float, digits: int) -> str:
    """`Number.prototype.toFixed` — ties round away from zero on the EXACT
    binary value, which Python's own formatting (round-half-even) does not do.
    """
    if digits < 0 or digits > 100:
        raise Unsupported("precision out of range")
    sign = ""
    if value < 0:
        sign = "-"
        value = -value
    if math.isnan(value):
        return "NaN"
    if value >= 1e21 or math.isinf(value):
        return sign + number_to_string(value)
    scaled = Decimal(value).scaleb(digits).to_integral_value(rounding=ROUND_HALF_UP)
    text = str(int(scaled))
    if digits == 0:
        return sign + text
    text = text.rjust(digits + 1, "0")
    return sign + text[:-digits] + "." + text[-digits:]


def make_number(value) -> float | None:
    """`AFMakeNumber`: trim, replace the FIRST comma with a decimal point,
    `parseFloat`, and reject NaN or non-finite."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return None if (math.isnan(value) or math.isinf(value)) else float(value)
    if not isinstance(value, str):
        return None
    text = value.strip().replace(",", ".", 1)
    number = parse_float(text)
    if number is None or math.isnan(number) or math.isinf(number):
        return None
    return number


_PARSE_FLOAT = re.compile(r"[+-]?(?:Infinity|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)")


def parse_float(text: str) -> float | None:
    """`parseFloat`: the longest valid numeric prefix, else None (NaN)."""
    m = _PARSE_FLOAT.match(text.lstrip(" \t\n\r\f\v "))
    if m is None:
        return None
    return float(m.group(0))


# ── printf / printd / printx / scand ──────────────────────────────────────

_PRINTF = re.compile(r"%(,[0-4])?([+ 0#]+)?(\d+)?(\.\d+)?(.)")
_PLUS, _SPACE, _ZERO, _HASH = 1, 2, 4, 8


def printf(spec: str, *args) -> str:
    """The reference's `util.printf`, restricted to the conversions it
    implements (`d` `f` `s` `x`); any other conversion character is emitted
    verbatim, which is what makes a malformed spec deterministic."""
    state = {"i": 0}

    def one(m: re.Match) -> str:
        dec_sep, flags_text, width_text, precision_text, conv = m.groups()
        if conv not in ("d", "f", "s", "x"):
            return "%" + "".join(t for t in (dec_sep, flags_text, width_text, precision_text, conv) if t)
        state["i"] += 1
        if state["i"] > len(args):
            raise Unsupported("not enough arguments in printf")
        arg = args[state["i"] - 1]
        if conv == "s":
            return arg if isinstance(arg, str) else number_to_string(arg)
        flags = 0
        for flag in flags_text or "":
            flags |= {"+": _PLUS, " ": _SPACE, "0": _ZERO, "#": _HASH}[flag]
        width = int(width_text) if width_text else None
        value = float(arg)
        integer = float(math.trunc(value)) if not (math.isnan(value) or math.isinf(value)) else value
        if conv == "x":
            hex_text = format(abs(int(integer)), "X")
            if width is not None:
                hex_text = hex_text.rjust(width, "0" if flags & _ZERO else " ")
            return "0x" + hex_text if flags & _HASH else hex_text
        precision = int(precision_text[1:]) if precision_text else None
        thousand_sep, decimal_sep = SEPARATORS[int(dec_sep[1:]) if dec_sep else 0]
        decimals = ""
        if conv == "f":
            residue = abs(value - integer)
            decimals = to_fixed(residue, precision) if precision is not None else number_to_string(residue)
            if len(decimals) > 2:
                if re.fullmatch(r"1\.0+", decimals):
                    integer += _sign(value)
                    decimals = decimal_sep + decimals.split(".")[1]
                else:
                    decimals = decimal_sep + decimals[2:]
            else:
                if decimals == "1":
                    integer += _sign(value)
                decimals = "." if flags & _HASH else ""
        sign = ""
        if integer < 0:
            sign = "-"
            integer = -integer
        elif flags & _PLUS:
            sign = "+"
        elif flags & _SPACE:
            sign = " "
        if thousand_sep and integer >= 1000:
            groups: list[str] = []
            while True:
                groups.append(number_to_string(math.fmod(integer, 1000)).rjust(3, "0"))
                integer = float(math.trunc(integer / 1000))
                if integer < 1000:
                    groups.append(number_to_string(integer))
                    break
            body = thousand_sep.join(reversed(groups))
        else:
            body = number_to_string(integer)
        text = body + decimals
        if width is not None:
            text = text.rjust(width - len(sign), "0" if flags & _ZERO else " ")
        return sign + text

    return _PRINTF.sub(one, spec)


def _sign(value: float) -> float:
    if value > 0:
        return 1.0
    if value < 0:
        return -1.0
    return 0.0


class CivilDate:
    """A calendar instant with no time zone: JavaScript builds these with the
    local-time constructor and reads them back with local-time getters, so the
    zone cancels. Out-of-range parts normalize exactly as `new Date` does."""

    __slots__ = ("year", "month", "day", "hours", "minutes", "seconds", "day_of_week")

    def __init__(self, year: int, month: int, day: int, hours: int, minutes: int, seconds: int) -> None:
        total = seconds + minutes * 60 + hours * 3600
        extra, second_of_day = divmod(total, 86400)
        year += month // 12
        month %= 12
        epoch_day = _days_from_civil(year, month + 1, 1) + (day - 1) + extra
        self.year, self.month, self.day = _civil_from_days(epoch_day)
        self.month -= 1
        self.hours, remainder = divmod(second_of_day, 3600)
        self.minutes, self.seconds = divmod(remainder, 60)
        self.day_of_week = (epoch_day + 4) % 7  # 1970-01-01 was a Thursday


def _days_from_civil(year: int, month: int, day: int) -> int:
    year -= month <= 2
    era = (year if year >= 0 else year - 399) // 400
    yoe = year - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(days: int) -> tuple[int, int, int]:
    days += 719468
    era = (days if days >= 0 else days - 146096) // 146097
    doe = days - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    year = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + (3 if mp < 10 else -9)
    return year + (month <= 2), month, day


_PRINTD_TOKENS = re.compile(r"(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t|\\.)")


def printd(mask: str, date: CivilDate) -> str:
    if mask == 0:
        return printd("D:yyyymmddHHMMss", date)
    if mask == 1:
        return printd("yyyy.mm.dd HH:MM:ss", date)
    if mask == 2:
        return printd("m/d/yy h:MM:ss tt", date)
    handlers = {
        "mmmm": lambda d: MONTHS[d.month],
        "mmm": lambda d: MONTHS[d.month][:3],
        "mm": lambda d: str(d.month + 1).rjust(2, "0"),
        "m": lambda d: str(d.month + 1),
        "dddd": lambda d: DAYS[d.day_of_week],
        "ddd": lambda d: DAYS[d.day_of_week][:3],
        "dd": lambda d: str(d.day).rjust(2, "0"),
        "d": lambda d: str(d.day),
        "yyyy": lambda d: str(d.year).rjust(4, "0"),
        "yy": lambda d: str(d.year % 100).rjust(2, "0"),
        "HH": lambda d: str(d.hours).rjust(2, "0"),
        "H": lambda d: str(d.hours),
        "hh": lambda d: str(1 + (d.hours + 11) % 12).rjust(2, "0"),
        "h": lambda d: str(1 + (d.hours + 11) % 12),
        "MM": lambda d: str(d.minutes).rjust(2, "0"),
        "M": lambda d: str(d.minutes),
        "ss": lambda d: str(d.seconds).rjust(2, "0"),
        "s": lambda d: str(d.seconds),
        "tt": lambda d: "am" if d.hours < 12 else "pm",
        "t": lambda d: "a" if d.hours < 12 else "p",
    }

    def one(m: re.Match) -> str:
        token = m.group(0)
        handler = handlers.get(token)
        # An escaped character reaches the reference's fallback branch, which
        # emits its CHARACTER CODE. Reproduced rather than corrected: a mask
        # carrying one renders the same string in every viewer.
        return handler(date) if handler else str(ord(token[1]))

    return _PRINTD_TOKENS.sub(one, mask)


def printx(mask: str, source) -> str:
    text = "" if source is None else (source if isinstance(source, str) else number_to_string(source))
    out: list[str] = []
    i = 0
    case = 0  # 0 as-is, 1 upper, 2 lower
    escaped = False

    def cased(ch: str) -> str:
        return ch.upper() if case == 1 else ch.lower() if case == 2 else ch

    for command in mask:
        if escaped:
            out.append(command)
            escaped = False
            continue
        if i >= len(text):
            break
        if command == "?":
            out.append(cased(text[i]))
            i += 1
        elif command == "X":
            while i < len(text):
                ch = text[i]
                i += 1
                if ch.isascii() and ch.isalnum():
                    out.append(cased(ch))
                    break
        elif command == "A":
            while i < len(text):
                ch = text[i]
                i += 1
                if ch.isascii() and ch.isalpha():
                    out.append(cased(ch))
                    break
        elif command == "9":
            while i < len(text):
                ch = text[i]
                i += 1
                if "0" <= ch <= "9":
                    out.append(ch)
                    break
        elif command == "*":
            while i < len(text):
                out.append(cased(text[i]))
                i += 1
        elif command == "\\":
            escaped = True
        elif command == ">":
            case = 1
        elif command == "<":
            case = 2
        elif command == "=":
            case = 0
        else:
            out.append(command)
    return "".join(out)


_SCAND_TOKENS = re.compile(r"(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t)")
_REGEX_ESCAPE = re.compile(r"([.*+\-?^${}()|\[\]\\])")
_ISO = re.compile(
    r"([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?"
    r"(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$"
)


def _scand_parts(mask: str):
    handlers = {
        "mmmm": (f"({'|'.join(MONTHS)})", lambda v, d: d.__setitem__("month", MONTHS.index(v))),
        "mmm": (f"({'|'.join(m[:3] for m in MONTHS)})",
                lambda v, d: d.__setitem__("month", [m[:3] for m in MONTHS].index(v))),
        "mm": (r"(\d{2})", lambda v, d: d.__setitem__("month", int(v) - 1)),
        "m": (r"(\d{1,2})", lambda v, d: d.__setitem__("month", int(v) - 1)),
        # `dddd`/`ddd` assign the WEEKDAY index to the day of month in the
        # reference. Reproduced: a mask using them parses the same way here.
        "dddd": (f"({'|'.join(DAYS)})", lambda v, d: d.__setitem__("day", DAYS.index(v))),
        "ddd": (f"({'|'.join(x[:3] for x in DAYS)})",
                lambda v, d: d.__setitem__("day", [x[:3] for x in DAYS].index(v))),
        "dd": (r"(\d{2})", lambda v, d: d.__setitem__("day", int(v))),
        "d": (r"(\d{1,2})", lambda v, d: d.__setitem__("day", int(v))),
        "yyyy": (r"(\d{4})", lambda v, d: d.__setitem__("year", int(v))),
        "yy": (r"(\d{2})", lambda v, d: d.__setitem__("year", 2000 + int(v))),
        "HH": (r"(\d{2})", lambda v, d: d.__setitem__("hours", int(v))),
        "H": (r"(\d{1,2})", lambda v, d: d.__setitem__("hours", int(v))),
        "hh": (r"(\d{2})", lambda v, d: d.__setitem__("hours", int(v))),
        "h": (r"(\d{1,2})", lambda v, d: d.__setitem__("hours", int(v))),
        "MM": (r"(\d{2})", lambda v, d: d.__setitem__("minutes", int(v))),
        "M": (r"(\d{1,2})", lambda v, d: d.__setitem__("minutes", int(v))),
        "ss": (r"(\d{2})", lambda v, d: d.__setitem__("seconds", int(v))),
        "s": (r"(\d{1,2})", lambda v, d: d.__setitem__("seconds", int(v))),
        "tt": (r"([aApP][mM])", lambda v, d: d.__setitem__("am", v[0] in "aA")),
        "t": (r"([aApP])", lambda v, d: d.__setitem__("am", v in "aA")),
    }
    actions: list = []
    escaped = _REGEX_ESCAPE.sub(r"\\\1", mask)

    def one(m: re.Match) -> str:
        pattern, action = handlers[m.group(0)]
        actions.append(action)
        return pattern

    return _SCAND_TOKENS.sub(one, escaped), actions


def scand(mask: str, text: str, strict: bool = False) -> CivilDate | None:
    if mask == 0:
        return scand("D:yyyymmddHHMMss", text)
    if mask == 1:
        return scand("yyyy.mm.dd HH:MM:ss", text)
    if mask == 2:
        return scand("m/d/yy h:MM:ss tt", text)
    pattern, actions = _scand_parts(mask)
    match = re.fullmatch(pattern, text)
    if match is None or len(match.groups()) != len(actions):
        return None if strict else _guess_date(mask, text)
    data = {"year": 2000, "month": 0, "day": 1, "hours": 0, "minutes": 0, "seconds": 0, "am": None}
    for action, group in zip(actions, match.groups()):
        action(group, data)
    if data["am"] is not None:
        data["hours"] = data["hours"] % 12 + (0 if data["am"] else 12)
    return CivilDate(data["year"], data["month"], data["day"], data["hours"], data["minutes"], data["seconds"])


_GUESS_TOKENS = re.compile(r"(d+)|(m+)|(y+)|(H+)|(M+)|(s+)")


def _guess_date(mask: str, text: str) -> CivilDate | None:
    checks: list = []
    for m in _GUESS_TOKENS.finditer(mask):
        if m.group(1):
            checks.append(("day", 1, 31, 0))
        elif m.group(2):
            checks.append(("month", 1, 12, -1))
        elif m.group(3):
            checks.append(("year", None, None, None))
        elif m.group(4):
            checks.append(("hours", 0, 23, 0))
        elif m.group(5):
            checks.append(("minutes", 0, 59, 0))
        elif m.group(6):
            checks.append(("seconds", 0, 59, 0))
    data = {"year": 2026, "month": 0, "day": 1, "hours": 12, "minutes": 0, "seconds": 0}
    i = 0
    for m in re.finditer(r"\d+", text):
        if i >= len(checks):
            break
        key, low, high, offset = checks[i]
        i += 1
        n = int(m.group(0))
        if key == "year":
            data["year"] = n + 2000 if n < 50 else (n + 1900 if n < 100 else n)
            continue
        if not (low <= n <= high):
            return None
        data[key] = n + offset
    if i == 0:
        return None
    return CivilDate(data["year"], data["month"], data["day"], data["hours"], data["minutes"], data["seconds"])


def parse_date(mask: str, text: str) -> CivilDate | None:
    """The reference's `_parseDate`: the mask first, then a general parse.

    The general parse is the ECMAScript Date Time String Format only — a host
    `Date.parse` accepts whatever else it likes, and an implementation-defined
    behaviour cannot be pinned across two implementations.
    """
    try:
        date = scand(mask, text, False)
    except (ValueError, re.error):
        date = None
    if date is not None:
        return date
    match = _ISO.fullmatch(text.strip())
    if match is None:
        return None
    year, month, day, hours, minutes, seconds = match.groups()
    return CivilDate(
        int(year), int(month or 1) - 1, int(day or 1),
        int(hours or 0), int(minutes or 0), int(seconds or 0),
    )


# ── The AF* entry points ──────────────────────────────────────────────────


class Event:
    """The reference's event object, reduced to what a commit needs: this app
    delivers no per-character change event, so `willCommit` is always true."""

    __slots__ = ("value", "rc", "problem")

    def __init__(self, value) -> None:
        self.value = value
        self.rc = True
        self.problem: tuple[str, tuple] | None = None


def _clamp(value: float, low: int, high: int) -> int:
    return max(low, min(high, int(math.floor(_numeric(value)))))


def _numeric(value) -> float:
    """A numeric argument, or a refusal. The reference coerces a non-numeric
    one through `Math.floor` into NaN and then builds a format spec around it;
    that spec's output is an artefact of the regex rather than a behaviour, so
    a non-numeric argument is reported instead of imitated."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise Unsupported("numeric argument expected")
    return float(value)


def _number_format(event: Event, args: list) -> None:
    decimals, sep_style, neg_style, _curr_style, currency, prepend = args
    value = make_number(event.value)
    if value is None:
        event.value = ""
        return
    sign = _sign(value)
    parts: list[str] = []
    has_paren = False
    if sign == -1 and prepend and neg_style == 0:
        parts.append("-")
    if neg_style in (2, 3) and sign == -1:
        parts.append("(")
        has_paren = True
    if prepend:
        parts.append(str(currency))
    parts.extend(["%,", str(_clamp(sep_style, 0, 4)), ".", number_to_string(_numeric(decimals)), "f"])
    if not prepend:
        parts.append(str(currency))
    if has_paren:
        parts.append(")")
    if (neg_style != 0 or prepend) and sign == -1:
        value = -value
    event.value = printf("".join(parts), value)


def _percent_format(event: Event, args: list) -> None:
    decimals, sep_style = args[0], args[1]
    prepend = args[2] if len(args) > 2 else False
    if not isinstance(decimals, (int, float)) or isinstance(decimals, bool):
        return
    if not isinstance(sep_style, (int, float)) or isinstance(sep_style, bool):
        return
    if decimals < 0:
        raise Unsupported("invalid nDec in AFPercent_Format")
    if decimals > 512:
        event.value = "%"
        return
    value = make_number(event.value)
    if value is None:
        event.value = "%"
        return
    text = printf(f"%,{_clamp(sep_style, 0, 4)}.{int(math.floor(decimals))}f", value * 100)
    event.value = f"%{text}" if prepend else f"{text}%"


_NUMBER_COMMIT = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)")
_NUMBER_COMMIT_COMMA = re.compile(r"[+-]?(?:\d+(?:,\d*)?|,\d+)")


def _number_keystroke(event: Event, args: list) -> None:
    sep_style = args[1]
    text = event.value if isinstance(event.value, str) else number_to_string(event.value)
    if not text:
        return
    text = text.strip()
    pattern = _NUMBER_COMMIT_COMMA if isinstance(sep_style, (int, float)) and sep_style > 1 else _NUMBER_COMMIT
    if not pattern.fullmatch(text):
        event.rc = False
        event.problem = ("number", ())
        return
    if isinstance(sep_style, (int, float)) and sep_style > 1:
        event.value = parse_float(text.replace(",", ".", 1))


def _date_format_ex(event: Event, mask) -> None:
    text = event.value if isinstance(event.value, str) else number_to_string(event.value)
    if not text:
        return
    date = parse_date(mask, text)
    if date is not None:
        event.value = printd(mask, date)


def _date_keystroke_ex(event: Event, mask) -> None:
    text = event.value if isinstance(event.value, str) else number_to_string(event.value)
    if not text:
        return
    if parse_date(mask, text) is None:
        event.rc = False
        event.problem = ("date", (str(mask),))


_SPECIAL_FORMATS = {0: "99999", 1: "99999-9999", 3: "999-99-9999"}


def _special_format(event: Event, psf) -> None:
    text = event.value if isinstance(event.value, str) else number_to_string(event.value)
    if not text:
        return
    index = make_number(psf)
    if index == 2:
        mask = "(999) 999-9999" if len(printx("9999999999", text)) >= 10 else "999-9999"
    else:
        mask = _SPECIAL_FORMATS.get(int(index) if index is not None else -1)
        if mask is None:
            raise Unsupported("invalid psf in AFSpecial_Format")
    event.value = printx(mask, text)


_MASK_CHECKS = {
    "9": lambda c: "0" <= c <= "9",
    "A": lambda c: ("a" <= c <= "z") or ("A" <= c <= "Z"),
    "O": lambda c: ("a" <= c <= "z") or ("A" <= c <= "Z") or ("0" <= c <= "9"),
    "X": lambda c: True,
}


def _mask_valid(text: str, mask: str) -> bool:
    for i, ch in enumerate(text):
        expected = mask[i] if i < len(mask) else ""
        check = _MASK_CHECKS.get(expected)
        if check is not None:
            if not check(ch):
                return False
        elif expected != ch:
            return False
    return True


def _mask_keystroke(event: Event, mask: str, text: str | None) -> None:
    """`#AFSpecial_KeystrokeEx_helper` at commit: too long, too short, or a
    character the mask forbids all reject; an exact-length match pads."""
    if not mask:
        return
    value = text if text is not None else (
        event.value if isinstance(event.value, str) else number_to_string(event.value)
    )
    if not value:
        return
    if len(value) > len(mask) or len(value) < len(mask) or not _mask_valid(value, mask):
        event.rc = False
        event.problem = ("mask", (mask,))
        return
    event.value = str(event.value) + mask[len(value):]


def _special_keystroke_ex(event: Event, mask: str) -> None:
    simplified = re.sub(r"[^9AOX]", "", mask)
    _mask_keystroke(event, simplified, None)
    if event.rc:
        return
    event.rc = True
    event.problem = None
    _mask_keystroke(event, mask, None)


_SPECIAL_KEYSTROKE = {0: ("99999", None), 1: ("99999-9999", None),
                      2: ("999-9999", "(999) 999-9999"), 3: ("999-99-9999", None)}


def _special_keystroke(event: Event, psf) -> None:
    index = make_number(psf)
    entry = _SPECIAL_KEYSTROKE.get(int(index) if index is not None else -1)
    if entry is None:
        raise Unsupported("invalid psf in AFSpecial_Keystroke")
    text = event.value if isinstance(event.value, str) else number_to_string(event.value)
    masks = [m for m in entry if m]
    for mask in masks:
        _mask_keystroke(event, mask, text)
        if event.rc:
            return
        event.rc = True
        event.problem = None
    stripped = re.sub(r"[-()\s]+", "", text)
    for mask in masks:
        _mask_keystroke(event, re.sub(r"[-()\s]+", "", mask), stripped)
        if event.rc:
            return
        event.rc = True
        event.problem = None
    long_form = entry[1] and len(re.findall(r"\d", stripped)) > 7
    _special_keystroke_ex(event, entry[1] if long_form else entry[0])


def _range_validate(event: Event, args: list) -> None:
    greater, low, less, high = args
    text = event.value if isinstance(event.value, str) else number_to_string(event.value)
    if not text:
        return
    value = make_number(event.value)
    if value is None:
        return
    if greater:
        low = make_number(low)
        if low is None:
            return
    if less:
        high = make_number(high)
        if high is None:
            return
    if greater and less:
        if value < low or value > high:
            event.rc = False
            event.problem = ("range", (number_to_string(low), number_to_string(high)))
    elif greater:
        if value < low:
            event.rc = False
            event.problem = ("min", (number_to_string(low),))
    else:
        # The final branch is deliberately UNGUARDED, as in the reference:
        # with neither bound requested the upper argument is still compared,
        # so `AFRange_Validate(false, 0, false, 0)` rejects anything above
        # zero. A producer meaning "no bounds" writes no validate script.
        limit = _relational(high)
        if limit is not None and value > limit:
            event.rc = False
            event.problem = ("max", (number_to_string(limit),))


def _relational(value) -> float | None:
    """The other operand of a `<`/`>` against a number, coerced the way the
    language does. None when the coercion is NaN, which makes every
    comparison false."""
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return None if math.isnan(value) else float(value)
    if value is None:
        return 0.0
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return None
    if isinstance(value, list):
        # An array coerces through its join: empty is 0, one element is that
        # element, anything longer carries a comma and is NaN.
        if not value:
            return 0.0
        return _relational(value[0]) if len(value) == 1 else None
    return None


def _simple(function: str, first, second) -> float:
    a = make_number(first)
    if a is None:
        raise Unsupported("invalid nValue1 in AFSimple")
    b = make_number(second)
    if b is None:
        raise Unsupported("invalid nValue2 in AFSimple")
    if function == "AVG":
        return (a + b) / 2
    if function == "SUM":
        return a + b
    if function == "PRD":
        return a * b
    if function == "MIN":
        return min(a, b)
    if function == "MAX":
        return max(a, b)
    raise Unsupported("invalid cFunction in AFSimple")


def _simple_calculate(event: Event, args: list, values: dict, resolve) -> None:
    function, raw = args[0], args[1]
    if function not in ("AVG", "SUM", "PRD", "MIN", "MAX"):
        raise Unsupported("invalid function in AFSimple_Calculate")
    names = list(raw) if isinstance(raw, list) else re.split(r", ?", str(raw))
    numbers: list[float] = []
    for name in names:
        terminals = resolve(str(name))
        if not terminals:
            continue  # a name the document does not have is skipped silently
        for terminal in terminals:
            number = make_number(values.get(terminal, ""))
            numbers.append(number if number is not None else 0.0)
    if not numbers:
        event.value = 0
        return
    if function == "AVG":
        result = math.fsum(numbers) / len(numbers)
    elif function == "SUM":
        result = math.fsum(numbers)
    elif function == "PRD":
        result = 1.0
        for number in numbers:
            result *= number
    elif function == "MIN":
        result = min(numbers)
    else:
        result = max(numbers)
    event.value = _round6(result)


def _round6(value: float) -> float:
    """`Math.round(1e6 * res) / 1e6`. `Math.round` is floor(x + 0.5) — a tie
    goes toward positive infinity, not away from zero, so -2.5 rounds to -2."""
    if math.isnan(value) or math.isinf(value):
        return value
    scaled = 1e6 * value
    if math.isinf(scaled):
        return value
    return math.floor(scaled + 0.5) / 1e6


def _sfn_value(node: dict, values: dict, resolve) -> float:
    if "num" in node:
        return node["num"]
    if "field" in node:
        # An unresolvable name contributes zero — never a skip, or `A - B`
        # with B missing would silently become A.
        total = 0.0
        for terminal in resolve(node["field"]):
            number = make_number(values.get(terminal, ""))
            total += number if number is not None else 0.0
        return total
    op = node["op"]
    if op == "neg":
        return -_sfn_value(node["v"], values, resolve)
    left = _sfn_value(node["l"], values, resolve)
    right = _sfn_value(node["r"], values, resolve)
    if op == "+":
        return left + right
    if op == "-":
        return left - right
    if op == "*":
        return left * right
    if right == 0:
        # JavaScript division, faithfully: a non-finite result formats empty,
        # which is why division by zero needs no rule of its own.
        if left == 0 or math.isnan(left):
            return math.nan
        return math.copysign(math.inf, left) * math.copysign(1.0, right)
    return left / right


def _no_terminals(_name: str) -> list[str]:
    return []


def run(script: dict, value, values: dict | None = None, resolve=None) -> Event:
    """Run one recognized script over a value. `values`/`resolve` are needed
    only by the calculate kinds; everything else is a pure value transform."""
    event = Event(value)
    values = values or {}
    resolve = resolve or _no_terminals
    fn = script["fn"]
    args = script.get("args", [])
    if fn == "AFNumber_Format":
        _number_format(event, args)
    elif fn == "AFNumber_Keystroke":
        _number_keystroke(event, args)
    elif fn == "AFPercent_Format":
        _percent_format(event, args)
    elif fn == "AFPercent_Keystroke":
        _number_keystroke(event, [args[0], args[1], 0, 0, "", True])
    elif fn == "AFDate_Format":
        index = args[0]
        _date_format_ex(event, DATE_FORMATS[index] if isinstance(index, int) and 0 <= index < len(DATE_FORMATS) else index)
    elif fn in ("AFDate_FormatEx", "AFTime_FormatEx"):
        _date_format_ex(event, args[0])
    elif fn == "AFTime_Format":
        index = args[0]
        _date_format_ex(event, TIME_FORMATS[index] if isinstance(index, int) and 0 <= index < len(TIME_FORMATS) else index)
    elif fn == "AFDate_Keystroke":
        index = args[0]
        if isinstance(index, int) and 0 <= index < len(DATE_FORMATS):
            _date_keystroke_ex(event, DATE_FORMATS[index])
    elif fn == "AFTime_Keystroke":
        index = args[0]
        if isinstance(index, int) and 0 <= index < len(TIME_FORMATS):
            _date_keystroke_ex(event, TIME_FORMATS[index])
    elif fn in ("AFDate_KeystrokeEx", "AFTime_KeystrokeEx"):
        _date_keystroke_ex(event, args[0])
    elif fn == "AFSpecial_Format":
        _special_format(event, args[0])
    elif fn == "AFSpecial_Keystroke":
        _special_keystroke(event, args[0])
    elif fn == "AFSpecial_KeystrokeEx":
        _special_keystroke_ex(event, args[0])
    elif fn == "AFRange_Validate":
        _range_validate(event, args)
    elif fn == "AFSimple_Calculate":
        _simple_calculate(event, args, values, resolve)
    elif fn == "AFSimple":
        # The reference RETURNS the result; a bare call assigns nothing. Its
        # only observable effect is the throw on a non-numeric operand.
        _simple(str(args[0]), args[1], args[2])
    elif fn == "SFN":
        event.value = _sfn_value(script["expr"], values, resolve)
    else:
        raise Unsupported(f"unknown script {fn}")
    return event


#: A script whose arguments make it unrunnable for EVERY input — the reference
#: throws before it reads the value. Reported per field like any other script
#: this app does not run, rather than surfacing as a mid-fill surprise.
_ALWAYS_UNRUNNABLE = {
    "AFPercent_Format": lambda a: isinstance(a[0], (int, float))
    and not isinstance(a[0], bool)
    and a[0] < 0,
    "AFSpecial_Format": lambda a: make_number(a[0]) not in (0, 1, 2, 3),
    "AFSpecial_Keystroke": lambda a: make_number(a[0]) not in (0, 1, 2, 3),
    "AFSimple_Calculate": lambda a: a[0] not in ("AVG", "SUM", "PRD", "MIN", "MAX"),
    "AFSimple": lambda a: a[0] not in ("AVG", "SUM", "PRD", "MIN", "MAX")
    or make_number(a[1]) is None
    or make_number(a[2]) is None,
}


def unrunnable(script: dict) -> bool:
    """Whether this recognized script can never run, whatever the value."""
    check = _ALWAYS_UNRUNNABLE.get(script.get("fn", ""))
    if check is None:
        return False
    try:
        return bool(check(script.get("args", [])))
    except (TypeError, ValueError, IndexError):
        return True


def as_stored(value) -> str:
    """The RAW text a computed value is stored as in `/V` — never the
    formatted display string, which would corrupt the next calculation that
    reads it."""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    return number_to_string(value)


def format_display(script: dict | None, value: str) -> str:
    """The string the appearance draws. Without a format script the display
    IS the stored value."""
    if script is None:
        return value
    return as_stored(run(script, value).value)


def calculate(values: dict, scripts: dict, order: list, terminals: list) -> dict:
    """One pass over `/CO`, entry by entry, in the order the document declares.

    Never iterated to a fixpoint: `/CO` is the author's declared order and a
    conforming viewer runs it once. A `/CO` in the wrong order computes a
    stale value — the author's bug, faithfully reproduced. Returns the fields
    whose stored value CHANGED.
    """
    resolve = terminal_resolver(terminals)
    current = dict(values)
    changed: dict[str, str] = {}
    for name in order:
        script = (scripts.get(name) or {}).get("C")
        if script is None:
            continue
        try:
            event = run(script, current.get(name, ""), current, resolve)
        except Unsupported:
            continue
        stored = as_stored(event.value)
        if stored != current.get(name, ""):
            current[name] = stored
            changed[name] = stored
    return changed


def terminal_resolver(terminals: list):
    """`getField(name).getArray()`: a terminal resolves to itself, a parent to
    every terminal beneath it, an unknown name to nothing."""
    known = set(terminals)

    def resolve(name: str) -> list[str]:
        if name in known:
            return [name]
        prefix = name + "."
        return [t for t in terminals if t.startswith(prefix)]

    return resolve


def closure(typed: list, scripts: dict, order: list, terminals: list) -> list[str]:
    """Everything a fill of `typed` can change: the typed fields plus every
    `/CO` entry whose calculation reads something already in the set.

    This is what the signed-edit decision must be asked about. Filling an
    unlocked line item that recalculates a locked Total produces a document
    that reports as altered, and a decision taken on the typed names alone
    would never see it. A calculation is a pure function of its inputs, so a
    `/CO` entry outside the set provably cannot change; one inside it may or
    may not, and being asked about a field that turns out unchanged refuses
    honestly rather than silently.
    """
    resolve = terminal_resolver(terminals)
    reached: list[str] = []
    for name in typed:
        if name not in reached:
            reached.append(name)
    seen = set(reached)
    for name in order:
        script = (scripts.get(name) or {}).get("C")
        if script is None or name in seen:
            continue
        if any(dep in seen for dep in dependencies(script, resolve)):
            reached.append(name)
            seen.add(name)
    return reached
