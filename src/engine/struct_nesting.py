"""Where a standard structure type is allowed to sit.

The accessibility checker audits what an element CARRIES — alt text, language,
labels, descriptions. This module holds the other half: what the standard says
about where an element may be, compiled from ISO 32000-2 and carried as data so
every entry can name the clause it came from.

WHAT THE TEXT ACTUALLY CONSTRAINS

ISO 32000-2 14.8.4.7.1 states the default: unless restricted by their type,
structure elements inside a parent may occur in any combination and in any
order. So a category is not a placement rule. Tables 364-375 state each type's
category (Document, Grouping, Block, Inline, or a combination), and only a few
of them state placement:

  * `Internal to X` in the Category column — Table 370's `LI` and `LBody`,
    Table 371's six table types. These are the only child-side placement
    statements in 14.8.4, and they are what `CONTAINMENT` holds.
  * a content model on the container — Table 369's `Ruby` and `Warichu`, each
    of which `shall contain` a stated sequence. `CONTENT_MODEL` holds those.
  * a positional rule — Table 372's `Caption`, restated for `L` in Table 370
    and for `Table` in Table 371. `CAPTION_PARENTS` and the predicate below.
  * an inheritance rule — Table 365's `Part`, `Div` and `NonStruct` each
    inherit the containment requirements of their parent, recursing past
    further elements of their own type. `TRANSPARENT` holds those three, and
    the effective parent of an element is its nearest ancestor outside that
    set. This is why a `LI` inside a `Div` inside a `L` is placed correctly.

NAMESPACES DECIDE HOW MUCH IS KNOWN (14.8.6)

An element with no `/NS` is in the default standard structure namespace, which
14.8.6.1 defines as the PDF 1.7 one; the PDF 2.0 namespace is entered only by
naming it or by being role mapped into it. Annex L is normative and its Table
L.2 lists the acceptable parents of every type, but it scopes itself to the
PDF 2.0 namespace, so `PARENTS_2_0` is applied to elements in that namespace
alone. `MATHML` and any other namespace are uncovered by rule.

RECORDED GAP: the PDF 1.7 namespace's own definitions live in ISO 32000-1,
which this repository does not hold. Elements in that namespace are therefore
judged only by the per-type statements above, and everything else about them
is reported as uncovered rather than as verified.

Annex L reconstructs cleanly when its five columns are bound to the page's own
column anchors rather than read in stream order, and the reconstruction is
self-checking: it states every relationship twice, once as a child and once as
a parent, and the two statements agree on membership for all 682 pairs.
"""

from __future__ import annotations

# 14.8.6.1 names both standard structure namespaces; 14.8.6.3 names the one
# domain-specific namespace PDF 2.0 defines. An element with no `/NS` is in
# `SSN_1_7`, which is the DEFAULT rather than the newer of the two.
SSN_1_7 = "http://iso.org/pdf/ssn"
SSN_2_0 = "http://iso.org/pdf2/ssn"
MATHML = "http://www.w3.org/1998/Math/MathML"

# ISO 32000-2 Table 365: each of these inherits the containment requirements
# and limitations of its parent, recursing past parents of its own type. An
# element of one of these types is therefore not judged by its own position,
# and its descendants are judged against the first ancestor outside the set.
TRANSPARENT = frozenset({"Part", "Div", "NonStruct"})

# The role reported for an element whose effective parent is the tree root.
ROOT = "StructTreeRoot"

# Verdicts.
OK = "ok"
VIOLATION = "violation"
UNCOVERED = "uncovered"


class Rule:
    """One compiled placement rule and the table it was read from.

    `parents` constrains the effective parent's role; `ancestor` requires a
    role among the effective ancestors. A rule states one or the other,
    because that is how the two phrasings in 14.8.4 differ: `Internal to L
    (List) structure elements` names the container, `Internal to a Table
    structure` names the structure the element belongs to.
    """

    __slots__ = ("parents", "ancestor", "cite")

    def __init__(self, cite: str, parents=None, ancestor: str = ""):
        self.parents = frozenset(parents) if parents else None
        self.ancestor = ancestor
        self.cite = cite


# The child-side placement statements of 14.8.4, which apply to the standard
# structure types themselves and so are not scoped to one namespace.
CONTAINMENT = {
    # ISO 32000-2 Table 370, Category column.
    "LI": Rule("t370", parents={"L"}),
    "LBody": Rule("t370", parents={"LI"}),
    # ISO 32000-2 Table 371, Category column: `Internal to a Table structure`.
    "TR": Rule("t371", ancestor="Table"),
    "TH": Rule("t371", ancestor="Table"),
    "TD": Rule("t371", ancestor="Table"),
    "THead": Rule("t371", ancestor="Table"),
    "TBody": Rule("t371", ancestor="Table"),
    "TFoot": Rule("t371", ancestor="Table"),
}

# Container-side content models: a type whose own entry states what it shall
# contain. ISO 32000-2 Table 369 — `Ruby` shall contain one `RB` followed by
# either an `RT` or the sequence `RP`, `RT`, `RP`; `Warichu` shall contain the
# sequence `WP`, `WT`, `WP`. Only membership is compiled: the ORDER those
# sentences also state is a separate question this table does not answer.
CONTENT_MODEL = {
    "Ruby": (frozenset({"RB", "RT", "RP"}), "t369"),
    "Warichu": (frozenset({"WP", "WT"}), "t369"),
}

# The two parents whose own entries restate Table 372's position rule, which is
# what a finding about them cites. The rule itself is Table 372's and reaches
# any parent.
CAPTION_PARENTS = frozenset({"L", "Table"})

# The categories Tables 364-375 state, per type. Placement is not read from
# this — 14.8.4.7.1 makes a category a description rather than a restriction —
# but it records which types the tables cover at all, which is what the check's
# coverage number is counted against.
CATEGORY = {
    "Document": ("Document", "t364"),
    "DocumentFragment": ("Document", "t364"),
    "Part": ("Grouping", "t365"),
    "Sect": ("Grouping", "t365"),
    "Div": ("Grouping", "t365"),
    "Aside": ("Grouping", "t365"),
    "NonStruct": ("Grouping", "t365"),
    "P": ("Block", "t366"),
    "H": ("Block", "t366"),
    "Hn": ("Block", "t366"),
    "Title": ("Grouping or Block", "t366"),
    "FENote": ("Grouping, Block or Inline", "t366"),
    "Sub": ("Inline", "t367"),
    "Lbl": ("Inline", "t368"),
    "Span": ("Inline", "t368"),
    "Em": ("Inline", "t368"),
    "Strong": ("Inline", "t368"),
    "Link": ("Grouping, Block or Inline", "t368"),
    "Annot": ("Grouping, Block or Inline", "t368"),
    "Form": ("Grouping, Block or Inline", "t368"),
    "Ruby": ("Inline", "t369"),
    "RB": ("Inline", "t369"),
    "RT": ("Inline", "t369"),
    "RP": ("Inline", "t369"),
    "Warichu": ("Inline", "t369"),
    "WT": ("Inline", "t369"),
    "WP": ("Inline", "t369"),
    "L": ("Block or Inline", "t370"),
    "LI": ("Internal to L", "t370"),
    "LBody": ("Internal to LI", "t370"),
    "Table": ("Block", "t371"),
    "TR": ("Internal to a Table structure", "t371"),
    "TH": ("Internal to a Table structure", "t371"),
    "TD": ("Internal to a Table structure", "t371"),
    "THead": ("Internal to a Table structure", "t371"),
    "TBody": ("Internal to a Table structure", "t371"),
    "TFoot": ("Internal to a Table structure", "t371"),
    "Caption": ("Grouping or Block", "t372"),
    "Figure": ("Grouping, Block or Inline", "t373"),
    "Formula": ("Grouping, Block or Inline", "t374"),
    "Artifact": ("Grouping, Block or Inline", "t375"),
}

# The heading types Table 366 defines by pattern rather than by name: `Hn` is
# the uppercase letter H followed by an unsigned integer with no leading zero.
_HEADING_PREFIX = "H"


def heading_family(role: str) -> str:
    """`H4` reported as `Hn`, which is the name Tables 364-375 and Table L.2
    both use for the numbered headings. A malformed heading-like tag is left
    alone: it is not a standard structure type and has no entry."""
    if len(role) < 2 or role[0] != _HEADING_PREFIX:
        return role
    digits = role[1:]
    if not digits.isdigit() or digits[0] == "0":
        return role
    return "Hn"


# ISO 32000-2 Table L.2, Parents column, for elements in the PDF 2.0 standard
# structure namespace. Annex L states that an element in that namespace shall
# not have a parent that is not explicitly listed, so an absent entry is a
# violation rather than a silence. Rows the legend marks conditional — `shall
# not occur unless the parent element is used as a grouping level element` —
# are held apart in `CONDITIONAL_2_0` and never fail: whether a parent is used
# as a grouping level element is not decidable from the tree.
PARENTS_2_0 = {
    "Annot": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Part", "RB", "RP", "RT", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP", "WT"}),
    "Artifact": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Form", "Formula", "H", "Hn", "L", "LBody", "LI", "Lbl", "Link", "NonStruct", "P", "Part", "RB", "RP", "RT", "Sect", "Span", "Strong", "Sub", "TBody", "TD", "TFoot", "TH", "THead", "TR", "Table", "Title", "WP", "WT"}),
    "Aside": frozenset({"Artifact", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "Formula", "LBody", "NonStruct", "Part", "Sect", "Title"}),
    "Caption": frozenset({"Artifact", "Aside", "Div", "FENote", "Figure", "Form", "Formula", "L", "LBody", "NonStruct", "Part", "Sect", "Table", "Title"}),
    "Div": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "Form", "Formula", "LBody", "LI", "Link", "NonStruct", "Part", "Sect", "TD", "TH", "Title"}),
    "Document": frozenset({"Artifact", "Aside", "Div", "Document", "DocumentFragment", "NonStruct", "Part", "StructTreeRoot"}),
    "DocumentFragment": frozenset({"Artifact", "Aside", "Div", "Document", "DocumentFragment", "FENote", "NonStruct", "Part", "Sect"}),
    "Em": frozenset({"Annot", "Artifact", "Caption", "Div", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "RB", "RP", "RT", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP", "WT"}),
    "FENote": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Form", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Part", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title"}),
    "Figure": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Part", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP"}),
    "Form": frozenset({"Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "NonStruct", "P", "Part", "RB", "RP", "RT", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP", "WT"}),
    "Formula": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Part", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title"}),
    "H": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Figure", "Formula", "LBody", "Link", "NonStruct", "Part", "Sect", "TD", "TH"}),
    "Hn": frozenset({"Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Figure", "Formula", "LBody", "NonStruct", "Part", "Sect", "TD", "TH"}),
    "L": frozenset({"Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "Formula", "L", "LBody", "NonStruct", "P", "Part", "Sect", "Sub", "TD", "TH", "Title"}),
    "LBody": frozenset({"Artifact", "Div", "LI", "NonStruct"}),
    "LI": frozenset({"Artifact", "Div", "L", "NonStruct"}),
    "Lbl": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Em", "FENote", "Figure", "Form", "Formula", "H", "Hn", "LI", "Link", "NonStruct", "P", "Part", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title"}),
    "Link": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "NonStruct", "P", "Part", "RB", "RP", "RT", "Sect", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP", "WT"}),
    "NonStruct": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "Em", "FENote", "Figure", "Form", "Formula", "H", "Hn", "L", "LBody", "LI", "Lbl", "Link", "NonStruct", "P", "Part", "RB", "RP", "RT", "Ruby", "Sect", "Span", "Strong", "Sub", "TBody", "TD", "TFoot", "TH", "THead", "TR", "Table", "Title", "WP", "WT", "Warichu"}),
    "P": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "Formula", "LBody", "Link", "NonStruct", "Part", "Sect", "TD", "TH", "Title"}),
    "Part": frozenset({"Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "Formula", "LBody", "NonStruct", "Part", "Sect", "Title"}),
    "RB": frozenset({"Artifact", "Div", "NonStruct", "Ruby"}),
    "RP": frozenset({"Artifact", "Div", "NonStruct", "Ruby"}),
    "RT": frozenset({"Artifact", "Div", "NonStruct", "Ruby"}),
    "Ruby": frozenset({"Annot", "Artifact", "Caption", "Div", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Span", "Strong", "Sub", "TD", "TH", "Title"}),
    "Sect": frozenset({"Annot", "Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "H", "Hn", "LBody", "Link", "NonStruct", "Part", "Sect", "TD", "TH"}),
    "Span": frozenset({"Annot", "Artifact", "Caption", "Div", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "RB", "RP", "RT", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP", "WT"}),
    "Strong": frozenset({"Annot", "Artifact", "Caption", "Div", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "RB", "RP", "RT", "Span", "Strong", "Sub", "TD", "TH", "Title", "WP", "WT"}),
    "Sub": frozenset({"Annot", "Artifact", "Caption", "Div", "Em", "FENote", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Part", "RB", "RP", "RT", "Span", "Strong", "WP", "WT"}),
    "TBody": frozenset({"Artifact", "Div", "NonStruct", "Table"}),
    "TD": frozenset({"Artifact", "Div", "NonStruct", "TR"}),
    "TFoot": frozenset({"Artifact", "Div", "NonStruct", "Table"}),
    "TH": frozenset({"Artifact", "Div", "NonStruct", "TR"}),
    "THead": frozenset({"Artifact", "Div", "NonStruct", "Table"}),
    "TR": frozenset({"Artifact", "Div", "NonStruct", "TBody", "TFoot", "THead", "Table"}),
    "Table": frozenset({"Artifact", "Aside", "Caption", "Div", "Document", "DocumentFragment", "FENote", "Figure", "Form", "Formula", "LBody", "NonStruct", "Part", "Sect", "TD", "TH", "Title"}),
    "Title": frozenset({"Annot", "Artifact", "Div", "Document", "DocumentFragment", "Link", "NonStruct", "Part", "Sect"}),
    "WP": frozenset({"Artifact", "Div", "NonStruct", "Warichu"}),
    "WT": frozenset({"Artifact", "Div", "NonStruct", "Warichu"}),
    "Warichu": frozenset({"Annot", "Artifact", "Caption", "Div", "Em", "FENote", "Figure", "Formula", "H", "Hn", "LBody", "Lbl", "Link", "NonStruct", "P", "Span", "Strong", "Sub", "TD", "TH", "Title"}),
}

# (parent, child) pairs Table L.2 marks conditional. Held apart so the whitelist
# above can be read as "an absent parent is forbidden" without a conditional row
# being mistaken for one.
CONDITIONAL_2_0 = frozenset({
    ("Annot", "Aside"), ("Annot", "Caption"), ("Annot", "DocumentFragment"),
    ("Annot", "Form"), ("Annot", "Hn"), ("Annot", "L"), ("Annot", "Part"),
    ("Annot", "Table"), ("Caption", "DocumentFragment"), ("Figure", "Sub"),
    ("Form", "Figure"), ("Form", "Formula"), ("Form", "L"), ("Form", "Part"),
    ("Link", "Aside"), ("Link", "Caption"), ("Link", "DocumentFragment"),
    ("Link", "Form"), ("Link", "Hn"), ("Link", "L"), ("Link", "Part"),
    ("Link", "Table"),
})


def effective_parent(node):
    """The ancestor an element's placement is judged against.

    ISO 32000-2 Table 365: `Part`, `Div` and `NonStruct` inherit the
    containment requirements of their parent, recursing past further elements
    of their own type, so the container a containment rule addresses is the
    nearest ancestor outside `TRANSPARENT` — a `LI` inside a `Div` inside an
    `L` is inside the list. `None` when no such ancestor exists, which places
    the element at the tree root.

    Every read of a placement parent goes through here: a second walk that
    skipped the read-through would answer the same question differently.
    """
    parent = node.parent
    while parent is not None and parent.role in TRANSPARENT:
        parent = parent.parent
    return parent


def namespace_kind(uri: str) -> str:
    """Which rule set an element's own namespace admits.

    An empty URI is the absent `/NS` case, which 14.8.6.1 puts in the default
    (PDF 1.7) standard structure namespace.
    """
    if not uri or uri == SSN_1_7:
        return SSN_1_7
    if uri == SSN_2_0:
        return SSN_2_0
    return ""


def judge(edge) -> tuple[str, str, str]:
    """(verdict, citation, rule) for one parent edge.

    `edge` carries the child node, its effective parent role, the roles of the
    parent's element children and the child's index among them. The verdict is
    `UNCOVERED` wherever the compiled tables hold no rule that reaches the
    element, which is never reported as a clean result for that element.
    """
    role = heading_family(edge.role)
    parent = heading_family(edge.parent_role)
    kind = namespace_kind(edge.ns)
    if not kind:
        return UNCOVERED, "", "namespace"
    if role in TRANSPARENT:
        # Table 365: its containment is its parent's, so its own position
        # carries no requirement of its own.
        return UNCOVERED, "t365", "inherits"

    reached = ("", "")

    model = CONTENT_MODEL.get(parent)
    if model is not None:
        if role not in model[0]:
            return VIOLATION, model[1], "content_model"
        reached = (model[1], "content_model")

    rule = CONTAINMENT.get(role)
    if rule is not None:
        if rule.parents is not None:
            if parent not in rule.parents:
                return VIOLATION, rule.cite, "containment"
        elif rule.ancestor and rule.ancestor not in edge.ancestor_roles:
            return VIOLATION, rule.cite, "containment"
        reached = (rule.cite, "containment")

    if role == "Caption":
        verdict, cite = _judge_caption(edge, parent)
        if verdict is not None:
            return verdict
        if cite:
            reached = (cite, "caption")

    # Table L.2 constrains only the types it lists, and only in the namespace
    # it scopes itself to; a name it does not carry falls back to whatever the
    # per-type rules above reached.
    if kind == SSN_2_0:
        allowed = PARENTS_2_0.get(role)
        if allowed is not None:
            if parent not in allowed and (parent, role) not in CONDITIONAL_2_0:
                return VIOLATION, "L.2", "annex_l"
            return OK, "L.2", "annex_l"

    if reached[0]:
        return OK, reached[0], reached[1]
    if role in CATEGORY:
        return UNCOVERED, CATEGORY[role][1], "category_only"
    return UNCOVERED, "", "not_a_standard_type"


def _judge_caption(edge, parent: str) -> tuple:
    """(verdict or None, citation) for a `Caption`'s position.

    Table 372: a `Caption` shall be the first or the last structure element
    inside its parent, and the number of captions cannot exceed one. Table 370
    and Table 371 restate the position rule for `L` and for `Table`, which is
    what the citation follows; the count rule is stated once, by Table 372.
    """
    position = ("t370" if parent == "L" else "t371") if parent in CAPTION_PARENTS else "t372"
    siblings = edge.sibling_roles
    if sum(1 for r in siblings if r == "Caption") > 1:
        # Only Table 372 states the count; Tables 370 and 371 restate the
        # position rule alone.
        return (VIOLATION, "t372", "caption_count"), "t372"
    if siblings and edge.index not in (0, len(siblings) - 1):
        return (VIOLATION, position, "caption_position"), position
    return None, position
