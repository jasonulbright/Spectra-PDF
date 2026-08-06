"""The difference policy used to judge changes against a DocMDP certification.

The bundled standard policy carries no rules for annotations: it clears form
filling and long-term-validation material, and everything else — including an
annotation a certification explicitly permits — falls through as an
unexplained change and reports as an illegal modification. Verifying a
document certified for commenting therefore has to be done against a policy
that models commenting, or every permitted comment is reported as tampering.

This module supplies that one missing rule and composes it with the standard
ones. Five invariants hold it to what the certification actually permits:

  * The annotation rule clears a page's ``/Annots`` MEMBERSHIP and the
    annotation objects it reaches, never any other page key. A cleared
    content-stream swap is exactly the change the DocMDP transform exists to
    detect, so a page whose other keys differ is not cleared at all and stays
    suspicious under the standard rules.
  * A WIDGET annotation OBJECT is never cleared here. Widgets are form fields,
    they belong to the form rules, and clearing one here would let a field
    appear on a page without its ``/AcroForm`` registration ever being vetted.
    The rule also stays out of the way entirely on a page whose only membership
    change is a widget, so that adding a signature field keeps being judged at
    the level the form rules judge it at.
  * The rule is qualified at the ANNOTATIONS level, so it changes nothing under
    a certification that permits only form filling or no changes at all — those
    verdicts compare the modification level against the permission level, and a
    change cleared only at the annotation level still exceeds a lower one.
  * The policy is used for VALIDATION only, and is passed explicitly at its one
    call site rather than installed as a default, so no other caller inherits it.
  * An object the rule cannot read is treated as one it may not clear.
"""

import logging

from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.reader import RawPdfPath
from pyhanko.sign.diff_analysis import (
    DEFAULT_DIFF_POLICY,
    FormUpdatingRule,
    GenericFieldModificationRule,
    ModificationLevel,
    SigFieldCreationRule,
    SigFieldModificationRule,
    StandardDiffPolicy,
    WhitelistRule,
)
from pyhanko.sign.diff_analysis.commons import compare_dicts
from pyhanko.sign.diff_analysis.policy_api import SuspiciousModification
from pyhanko.sign.diff_analysis.rules_api import ReferenceUpdate, RelativeContext

# With the annotation rule in force, the library's standing warning that its
# own policy was not designed for the top certification level no longer
# describes what runs. Scoped to the one module that emits it and only below
# ERROR, so genuine diagnostics still flow.
logging.getLogger("pyhanko.sign.diff_analysis.policies").setLevel(logging.ERROR)

_ANNOTS = generic.pdf_name("/Annots")
_KIDS = generic.pdf_name("/Kids")
_TYPE = generic.pdf_name("/Type")
_SUBTYPE = generic.pdf_name("/Subtype")
_PAGE = generic.pdf_name("/Page")
_PAGES = generic.pdf_name("/Pages")
_WIDGET = generic.pdf_name("/Widget")
_ACROFORM = generic.pdf_name("/AcroForm")
_FIELDS = generic.pdf_name("/Fields")
_AP = generic.pdf_name("/AP")
_AS = generic.pdf_name("/AS")
_V = generic.pdf_name("/V")

# A page tree deeper than this is not walked; the pages below it are simply not
# cleared, which reports as suspicious rather than as approved.
_MAX_PAGE_TREE_DEPTH = 64
# Likewise for the field tree: past this many nodes the walk stops, and the
# fields it did not reach are simply not cleared.
_MAX_FIELDS = 20_000


def _refs(value) -> list | None:
    """The indirect references in an array, or None when it is not an array of
    references. A direct object among them makes the array unusable for
    reference-level reasoning, which is a refusal, not a partial answer."""
    try:
        array = value.get_object()
    except Exception:
        return None
    if not isinstance(array, generic.ArrayObject):
        return None
    out = []
    for entry in array:
        if not isinstance(entry, generic.IndirectObject):
            return None
        out.append(entry.reference)
    return out


def _page_annots(page) -> tuple[list | None, object | None]:
    """``(annotation refs, the /Annots array's own reference or None)``. A page
    with no ``/Annots`` reports an empty list, which is what makes adding the
    first annotation to a page the same case as adding the second."""
    if not isinstance(page, generic.DictionaryObject):
        return None, None
    try:
        value = page.raw_get(_ANNOTS)
    except KeyError:
        return [], None
    array_ref = value.reference if isinstance(value, generic.IndirectObject) else None
    return _refs(value), array_ref


def _is_widget(resolver, ref) -> bool:
    """True for a form-field widget, and true for anything unreadable — an
    object whose kind cannot be established is one this rule may not clear."""
    try:
        obj = resolver(ref)
    except Exception:
        return True
    if not isinstance(obj, generic.DictionaryObject):
        return True
    try:
        return obj.get(_SUBTYPE) == _WIDGET
    except Exception:
        return True


class PageAnnotationRule(WhitelistRule):
    """Clears annotation membership changes on pages whose every other key is
    unchanged."""

    def apply(self, old, new):
        try:
            old_pages = old.root.raw_get(_PAGES)
            new_pages = new.root.raw_get(_PAGES)
        except Exception:
            return
        try:
            updated_in_revision = new.explicit_refs_in_revision()
        except Exception:
            updated_in_revision = set()
        yield from self._walk(
            old_pages, new_pages, old, new, updated_in_revision, set(), 0
        )

    def _walk(self, old_node, new_node, old, new, updated, seen, depth):
        if depth > _MAX_PAGE_TREE_DEPTH:
            return
        old_kids = _refs(old_node.get_object().get(_KIDS))
        new_kids = _refs(new_node.get_object().get(_KIDS))
        # A page tree whose shape moved is a structural change, not an
        # annotation one: nothing here is cleared for it.
        if old_kids is None or new_kids is None or old_kids != new_kids:
            return
        for old_ref, new_ref in zip(old_kids, new_kids):
            if old_ref in seen:
                return
            try:
                old_kid = old(old_ref)
                new_kid = new(new_ref)
                node_type = old_kid.get(_TYPE)
            except Exception:
                continue
            if node_type == _PAGES:
                yield from self._walk(
                    old_kid, new_kid, old, new, updated, seen | {old_ref}, depth + 1
                )
            elif node_type == _PAGE:
                yield from self._page(
                    old_ref, new_ref, old_kid, new_kid, old, new, updated
                )

    def _page(self, old_ref, new_ref, old_kid, new_kid, old, new, updated):
        old_annots, old_array_ref = _page_annots(old_kid)
        new_annots, new_array_ref = _page_annots(new_kid)
        if old_annots is None or new_annots is None:
            return
        added = [r for r in new_annots if r not in old_annots]
        removed = [r for r in old_annots if r not in new_annots]
        kept_and_updated = [r for r in new_annots if r in old_annots and r in updated]
        # A removed or edited widget is a form-field change wearing an
        # annotation's clothes; this rule declines the whole page rather than
        # clear the membership around it.
        if any(_is_widget(old, r) for r in removed + kept_and_updated):
            return
        if any(_is_widget(new, r) for r in kept_and_updated):
            return
        annotations = [r for r in added if not _is_widget(new, r)]
        # Nothing but widgets moved: adding a signature field is judged by the
        # form rules, at the level they judge it at, and clearing the page here
        # would raise that level for every certification.
        if not (annotations or removed or kept_and_updated):
            return
        # Every page key other than /Annots must be untouched, or nothing on
        # this page is cleared.
        if not compare_dicts(old_kid, new_kid, frozenset([_ANNOTS]), raise_exc=False):
            return

        # A page object is reachable from many places in a file and checking
        # every path creates more problems than it solves; the dictionary
        # comparison above is what makes the blanket approval safe here.
        yield ReferenceUpdate(new_ref, context_checked=None)
        if new_array_ref is not None and (
            old_array_ref == new_array_ref or old.is_ref_unassignable(new_array_ref)
        ):
            # The array is cleared only where the page reaches it: either it is
            # the same object as before, or it is an object number the prior
            # revision never assigned, so no existing object is clobbered.
            yield ReferenceUpdate(
                new_array_ref,
                context_checked=RelativeContext(old_ref, RawPdfPath("/Annots")),
            )
        # Membership is cleared above; the widget OBJECTS added alongside are
        # not, and stay unexplained unless a form rule justifies them.
        for ref in annotations + kept_and_updated:
            yield ReferenceUpdate(ref)
            yield from self._dependencies(ref, old, new)

    def _dependencies(self, ref, old, new):
        """Objects the annotation reaches that this revision introduced —
        appearance streams and their resources. Bounded to the new revision, so
        an annotation cannot clear an object that predates the signature."""
        try:
            deps = new.collect_dependencies(
                new(ref), since_revision=old.revision + 1
            )
        except Exception:
            return
        for dep in deps:
            yield ReferenceUpdate(dep)


class FieldWidgetAppearanceRule(WhitelistRule):
    """Clears the appearance update of a widget that is a form field's KID.

    A text field can carry its widget either merged into the field dictionary
    or as a separate ``/Kids`` entry. The standard form rules model the merged
    shape only: they clear the field's own ``/AP`` update, and a widget held
    under ``/Kids`` is never mentioned by any rule, so filling such a field
    leaves its appearance stream unexplained and the whole revision reads as a
    suspicious modification — for a fill, which is the least a certification
    ever permits.

    The clearance is deliberately narrow, and each condition is a way this
    could be written too loosely:

      * the widget object must be the SAME object in both revisions, so a
        substituted widget is never cleared;
      * every key on it except ``/AP`` and ``/AS`` must be unchanged — a moved
        ``/Rect``, a re-pointed ``/Parent`` or a changed ``/F`` falls through
        to the standard rules;
      * its owning field's ``/V`` must have changed, so an appearance rewritten
        without a fill is not cleared;
      * only objects the new appearance stream introduces IN THIS REVISION are
        pulled in, so an appearance cannot reach back and clear an object that
        predates the signature.

    Qualified at the form-filling level, so it cannot clear anything under a
    certification that permits no changes at all.
    """

    def apply(self, old, new):
        try:
            updated = new.explicit_refs_in_revision()
        except Exception:
            return
        old_parents = _widget_parents(old)
        new_parents = _widget_parents(new)
        for ref, parent_ref in new_parents.items():
            if ref not in updated or old_parents.get(ref) != parent_ref:
                continue
            try:
                old_widget = old(ref)
                new_widget = new(ref)
            except Exception:
                continue
            if not (
                isinstance(old_widget, generic.DictionaryObject)
                and isinstance(new_widget, generic.DictionaryObject)
                and old_widget.get(_SUBTYPE) == _WIDGET
                and new_widget.get(_SUBTYPE) == _WIDGET
            ):
                continue
            if not compare_dicts(
                old_widget, new_widget, frozenset([_AP, _AS]), raise_exc=False
            ):
                continue
            if not _field_value_changed(old, new, parent_ref):
                continue
            yield ReferenceUpdate(ref)
            yield from _appearance_dependencies(old, new, new_widget)


def _widget_parents(resolver) -> dict:
    """``{widget reference: owning field reference}`` for every widget held
    under a form field's ``/Kids``. A merged field-widget is deliberately
    absent: the standard rules already model that shape."""
    out: dict = {}
    try:
        acroform = resolver.root.get(_ACROFORM)
        fields = _refs(acroform.get_object().raw_get(_FIELDS))
    except Exception:
        return out
    if not fields:
        return out
    seen: set = set()
    queue = list(fields)
    while queue:
        field_ref = queue.pop()
        if field_ref in seen or len(seen) > _MAX_FIELDS:
            continue
        seen.add(field_ref)
        try:
            field = resolver(field_ref)
        except Exception:
            continue
        if not isinstance(field, generic.DictionaryObject):
            continue
        kids = _refs(field.get(_KIDS))
        if not kids:
            continue
        for kid_ref in kids:
            try:
                kid = resolver(kid_ref)
            except Exception:
                continue
            if not isinstance(kid, generic.DictionaryObject):
                continue
            if kid.get(_SUBTYPE) == _WIDGET:
                out[kid_ref] = field_ref
            else:
                queue.append(kid_ref)
    return out


def _field_value_changed(old, new, field_ref) -> bool:
    try:
        old_field = old(field_ref)
        new_field = new(field_ref)
    except Exception:
        return False
    if not (
        isinstance(old_field, generic.DictionaryObject)
        and isinstance(new_field, generic.DictionaryObject)
    ):
        return False
    return old_field.get(_V) != new_field.get(_V)


def _appearance_dependencies(old, new, widget):
    """The widget's own ``/AP`` reference when it is indirect, and everything
    the new appearance reaches that this revision introduced."""
    try:
        raw = widget.raw_get(_AP)
    except KeyError:
        return
    if isinstance(raw, generic.IndirectObject):
        yield ReferenceUpdate(raw.reference)
    try:
        deps = new.collect_dependencies(
            raw.get_object(), since_revision=old.revision + 1
        )
    except Exception:
        return
    for dep in deps:
        yield ReferenceUpdate(dep)


class _TolerantSigFieldCreationRule(SigFieldCreationRule):
    """The signature-field creation rule, minus its refusal to coexist with an
    annotation it does not model.

    That rule walks the page tree whenever a revision adds a signature field,
    and REFUSES the whole document when the same revision also added an
    annotation it does not recognise — which is the ordinary shape of
    counter-signing a document and then commenting on it. The refusal aborts
    the entire analysis before any other rule is consulted, so the annotation
    rule below never gets to adjudicate the comment.

    Stopping at the refusal instead of propagating it is FAIL-CLOSED: every
    clearance the rule would have produced after that point is simply not
    produced, so the objects it would have cleared stay unexplained and the
    revision still reports as suspicious. Nothing is approved that the rule
    did not approve itself."""

    def apply(self, context):
        source = super().apply(context)
        while True:
            try:
                update = next(source)
            except StopIteration:
                return
            except SuspiciousModification:
                return
            yield update


class LockedFieldModification(SuspiciousModification):
    """A revision updated a form field a signature's ``/FieldMDP`` locks.

    Carries the field NAMES, so the verdict crosses the IPC boundary as data.
    The library's own refusal for this case is a message naming an object
    number, which is not user information and would have to be parsed to be
    useful."""

    def __init__(self, fields):
        super().__init__("a locked form field was updated")
        self.fields = list(fields)


class LockAwareDiffPolicy(StandardDiffPolicy):
    """The standard policy, reporting a locked-field update as its own kind.

    The check itself is the standard policy's — it raises when a form update
    that is not valid-when-locked touches a locked field. Only the FAILURE path
    is re-examined here, so the ordinary verdict costs nothing extra, and a
    suspicious modification that is not a lock violation propagates unchanged
    rather than being relabelled as one.
    """

    def apply(self, old, new, field_mdp_spec=None, doc_mdp=None):
        try:
            return super().apply(
                old, new, field_mdp_spec=field_mdp_spec, doc_mdp=doc_mdp
            )
        except SuspiciousModification:
            if field_mdp_spec is None:
                raise
            locked = self._locked_fields_touched(old, new, field_mdp_spec)
            if not locked:
                raise
            raise LockedFieldModification(locked) from None

    def _locked_fields_touched(self, old, new, field_mdp_spec) -> list:
        if self.form_rule is None:
            return []
        found: list = []
        try:
            for _level, update in self.form_rule.apply(old, new):
                name = update.field_name
                if name is None or update.valid_when_locked or name in found:
                    continue
                if field_mdp_spec.is_locked(name):
                    found.append(name)
        except Exception:
            # The form rule refusing mid-walk leaves whatever it had already
            # reported; naming fewer fields is honest, naming none is the
            # unchanged verdict.
            return found
        return found


ANNOTATION_RULE = PageAnnotationRule()
WIDGET_APPEARANCE_RULE = FieldWidgetAppearanceRule()


def build_diff_policy() -> StandardDiffPolicy:
    """The standard rules plus the two this build supplies, each qualified at
    the lowest level that describes what it clears."""
    return LockAwareDiffPolicy(
        global_rules=[
            *DEFAULT_DIFF_POLICY.global_rules,
            WIDGET_APPEARANCE_RULE.as_qualified(ModificationLevel.FORM_FILLING),
            ANNOTATION_RULE.as_qualified(ModificationLevel.ANNOTATIONS),
        ],
        form_rule=FormUpdatingRule(
            field_rules=[
                _TolerantSigFieldCreationRule(),
                SigFieldModificationRule(),
                GenericFieldModificationRule(),
            ],
        ),
    )


DIFF_POLICY = build_diff_policy()
