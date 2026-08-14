"""Recognizer: an AcroForm field `/JS` body → a typed script, or None.

No JavaScript engine, no `eval`, no dynamic code path. A body is accepted
only when it is exactly one of two shapes:

  * a call to one of the 18 authored `AF*` entry points whose arguments are
    all literals (number, string, boolean, null, array), or
  * ``event.value = <expr>`` where `<expr>` is the Simplified Field Notation
    arithmetic grammar (the shape a producer expands an SFN entry into).

Anything else returns None. A field whose script is not accepted keeps its
`/JS` bytes untouched and is reported by name; the rest of the form still
calculates.

The result is plain JSON data (`{"fn": ..., "args": [...]}` or
`{"fn": "SFN", "expr": {...}}`) so it can be pinned case for case against
`tests/fixtures/af-corpus.json` alongside the TypeScript twin
(`src/renderer/lib/af-script.ts`).
"""

from __future__ import annotations

import re

#: The authored entry points — what a producer writes into `/AA`. The value is
#: the arity range the reference accepts; an argument count outside it is not
#: the call the reference would run, so the body is not recognized.
ENTRY_POINTS: dict[str, tuple[int, int]] = {
    "AFNumber_Format": (6, 6),
    "AFNumber_Keystroke": (6, 6),
    "AFPercent_Format": (2, 3),
    "AFPercent_Keystroke": (2, 2),
    "AFDate_Format": (1, 1),
    "AFDate_FormatEx": (1, 1),
    "AFDate_Keystroke": (1, 1),
    "AFDate_KeystrokeEx": (1, 1),
    "AFTime_Format": (1, 1),
    "AFTime_FormatEx": (1, 1),
    "AFTime_Keystroke": (1, 1),
    "AFTime_KeystrokeEx": (1, 1),
    "AFSpecial_Format": (1, 1),
    "AFSpecial_Keystroke": (1, 1),
    "AFSpecial_KeystrokeEx": (1, 1),
    "AFSimple_Calculate": (2, 2),
    "AFSimple": (3, 3),
    "AFRange_Validate": (4, 4),
}

_COMMENTS = re.compile(r"//[^\n\r]*|/\*.*?\*/", re.DOTALL)
_STRING_OR_COMMENT = re.compile(r"\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|//[^\n\r]*|/\*.*?\*/", re.DOTALL)
_NUMBER = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
_IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def _strip_comments(text: str) -> str:
    """Comments removed, string literals preserved verbatim."""
    out: list[str] = []
    pos = 0
    for m in _STRING_OR_COMMENT.finditer(text):
        token = m.group(0)
        out.append(text[pos:m.start()])
        if token[0] in "\"'":
            out.append(token)
        else:
            out.append(" ")
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


class _Cursor:
    __slots__ = ("text", "pos")

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def skip(self) -> None:
        while self.pos < len(self.text) and self.text[self.pos] in " \t\r\n\f\v":
            self.pos += 1

    def peek(self) -> str:
        self.skip()
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def take(self, literal: str) -> bool:
        self.skip()
        if self.text.startswith(literal, self.pos):
            self.pos += len(literal)
            return True
        return False

    def at_end(self) -> bool:
        self.skip()
        return self.pos >= len(self.text)


class _Reject(Exception):
    """The body is not one of the accepted shapes."""


_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def _string_literal(cur: _Cursor) -> str:
    quote = cur.peek()
    if quote not in "\"'":
        raise _Reject
    i = cur.pos + 1
    out: list[str] = []
    text = cur.text
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 1
            if i >= len(text):
                raise _Reject
            esc = text[i]
            if esc == "u" and i + 4 < len(text):
                try:
                    out.append(chr(int(text[i + 1: i + 5], 16)))
                except ValueError:
                    raise _Reject from None
                i += 5
                continue
            if esc == "x" and i + 2 < len(text):
                try:
                    out.append(chr(int(text[i + 1: i + 3], 16)))
                except ValueError:
                    raise _Reject from None
                i += 3
                continue
            out.append(_ESCAPES.get(esc, esc))
            i += 1
            continue
        if ch == quote:
            cur.pos = i + 1
            return "".join(out)
        out.append(ch)
        i += 1
    raise _Reject


def _literal(cur: _Cursor):
    """One literal argument: number, string, boolean, null, or array."""
    ch = cur.peek()
    if ch in "\"'":
        return _string_literal(cur)
    if ch == "[":
        cur.pos += 1
        return _literal_list(cur, "]")
    if ch == "-" or ch == "+":
        cur.pos += 1
        value = _literal(cur)
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise _Reject
        return -value if ch == "-" else value
    m = _NUMBER.match(cur.text, cur.pos)
    if m:
        cur.pos = m.end()
        return _js_number(m.group(0))
    m = _IDENT.match(cur.text, cur.pos)
    if m:
        word = m.group(0)
        cur.pos = m.end()
        if word == "true":
            return True
        if word == "false":
            return False
        if word in ("null", "undefined"):
            return None
        if word == "Array" or word == "new":
            # `new Array(a, b)` — `new` was consumed as the identifier, so the
            # constructor name follows; a bare `Array(a, b)` call is the same
            # array in the reference and is accepted alike.
            if word == "new":
                cur.skip()
                m2 = _IDENT.match(cur.text, cur.pos)
                if m2 is None or m2.group(0) != "Array":
                    raise _Reject
                cur.pos = m2.end()
            if not cur.take("("):
                raise _Reject
            return _literal_list(cur, ")")
        raise _Reject
    raise _Reject


def _literal_list(cur: _Cursor, closer: str) -> list:
    out: list = []
    if cur.take(closer):
        return out
    while True:
        out.append(_literal(cur))
        if cur.take(","):
            if cur.take(closer):  # trailing comma
                return out
            continue
        if cur.take(closer):
            return out
        raise _Reject


def _js_number(text: str) -> float | int:
    value = float(text)
    if value.is_integer() and abs(value) < 2**53 and "e" not in text and "E" not in text and "." not in text:
        return int(value)
    return value


# ── Simplified Field Notation ─────────────────────────────────────────────
#
#   expr    := term (('+' | '-') term)*
#   term    := factor (('*' | '/') factor)*
#   factor  := NUMBER | FIELDNAME | '(' expr ')' | '-' factor
#
# FIELDNAME is a fully-qualified name: dotted identifier parts, or the quoted
# form a producer writes when a name carries spaces or operators.


def _sfn_expr(cur: _Cursor) -> dict:
    node = _sfn_term(cur)
    while True:
        cur.skip()
        ch = cur.peek()
        if ch not in "+-":
            return node
        cur.pos += 1
        node = {"op": ch, "l": node, "r": _sfn_term(cur)}


def _sfn_term(cur: _Cursor) -> dict:
    node = _sfn_factor(cur)
    while True:
        ch = cur.peek()
        if ch not in "*/":
            return node
        cur.pos += 1
        node = {"op": ch, "l": node, "r": _sfn_factor(cur)}


def _sfn_factor(cur: _Cursor) -> dict:
    ch = cur.peek()
    if ch == "-":
        cur.pos += 1
        return {"op": "neg", "v": _sfn_factor(cur)}
    if ch == "+":
        cur.pos += 1
        return _sfn_factor(cur)
    if ch == "(":
        cur.pos += 1
        node = _sfn_expr(cur)
        if not cur.take(")"):
            raise _Reject
        return node
    if ch in "\"'":
        return {"field": _string_literal(cur)}
    m = _NUMBER.match(cur.text, cur.pos)
    if m:
        cur.pos = m.end()
        return {"num": float(m.group(0))}
    m = _IDENT.match(cur.text, cur.pos)
    if m:
        start = cur.pos
        cur.pos = m.end()
        while cur.pos < len(cur.text) and cur.text[cur.pos] == ".":
            nxt = _IDENT.match(cur.text, cur.pos + 1) or _NUMBER.match(cur.text, cur.pos + 1)
            if nxt is None:
                raise _Reject
            cur.pos = nxt.end()
        return {"field": cur.text[start:cur.pos]}
    raise _Reject


def sfn_fields(node: dict) -> list[str]:
    """Every field name the expression reads, in first-appearance order."""
    out: list[str] = []

    def walk(n: dict) -> None:
        if "field" in n:
            if n["field"] not in out:
                out.append(n["field"])
        elif "num" in n:
            return
        elif n.get("op") == "neg":
            walk(n["v"])
        else:
            walk(n["l"])
            walk(n["r"])

    walk(node)
    return out


def recognize(js: str) -> dict | None:
    """The typed script for a `/JS` body, or None when it is not one of the
    accepted shapes. Never raises on arbitrary input."""
    if not isinstance(js, str):
        return None
    text = _strip_comments(js)
    cur = _Cursor(text)
    try:
        if cur.take("event.value"):
            if not cur.take("="):
                return None
            if cur.peek() == "=":  # `==` is a comparison, not an assignment
                return None
            expr = _sfn_expr(cur)
            cur.take(";")
            if not cur.at_end():
                return None
            return {"fn": "SFN", "expr": expr}
        cur.skip()
        m = _IDENT.match(cur.text, cur.pos)
        if m is None:
            return None
        name = m.group(0)
        arity = ENTRY_POINTS.get(name)
        if arity is None:
            return None
        cur.pos = m.end()
        if not cur.take("("):
            return None
        args = _literal_list(cur, ")")
        cur.take(";")
        if not cur.at_end():
            return None
        if not (arity[0] <= len(args) <= arity[1]):
            return None
        return {"fn": name, "args": args}
    except _Reject:
        return None
    except RecursionError:
        return None


def dependencies(script: dict, resolve) -> list[str]:
    """The terminal field names a CALCULATE script reads.

    `resolve(name)` expands one authored name to the terminal fields it
    covers — a parent contributes every child, which is what the reference's
    `getArray()` does and what an unresolvable name must NOT silently become.
    """
    fn = script.get("fn")
    if fn == "SFN":
        names = sfn_fields(script["expr"])
    elif fn == "AFSimple_Calculate":
        raw = script["args"][1]
        names = list(raw) if isinstance(raw, list) else re.split(r", ?", str(raw))
    else:
        return []
    out: list[str] = []
    for name in names:
        for terminal in resolve(str(name)):
            if terminal not in out:
                out.append(terminal)
    return out
