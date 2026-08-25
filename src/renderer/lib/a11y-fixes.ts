// Which accessibility findings the report can repair, and how.
//
// The ENGINE owns what an automatic fix does (`engine/accessibility_fixes.py`
// is the one table of check → door, shared by this panel and the command
// line). This table owns the other half — what the SURFACE offers: whether a
// check gets a button or a field, whose value it takes, and which door an
// authored value goes to. The two halves answer different questions, and
// `tests/a11y-fixes.test.ts` pins this one against the engine module's own
// lists so a check cannot be automatic in one and authored in the other.
//
// A fix is offered only where it can actually run. `bookmarks` is the case
// that makes the rule concrete: deriving bookmarks from headings refuses on a
// document that has none, and a button whose only outcome is a refusal is
// worse than the route to the panel that can do the work.
import type { Check, Finding } from './accessibility-report';
import type { OpMethod } from './op-edit-class';

/** How a check is repaired. */
export type FixKind = 'auto' | 'authored';

/** What an authored fix asks for. */
export type FixInput = 'text' | 'language' | 'role';

export interface AuthoredFix {
  /** The control the value is typed into. */
  input: FixInput;
  /** Whether the value repairs the whole check at once or one finding. */
  scope: 'check' | 'finding';
  /** Catalog suffix for the field's label and its placeholder. */
  field: 'alt' | 'summary' | 'description' | 'title' | 'lang' | 'role';
}

/** The two answers binding untagged content takes. There is no third: content
 * a reader should hear, or page furniture it should not. */
export const CONTENT_ROLES = ['P', 'Artifact'] as const;

export interface FixOffer {
  kind: FixKind;
  authored?: AuthoredFix;
}

/**
 * The engine's automatic set, mirrored (`AUTOMATIC_CHECKS`). Every one of
 * these is repaired by one `apply_accessibility_fixes` call naming the check,
 * which is what makes a whole check's findings one undoable act.
 */
export const AUTOMATIC_CHECKS: readonly string[] = [
  'permissions',
  'tagged',
  'suspects',
  'title',
  'bookmarks',
  'tab_order',
  'heading_nesting',
  'table_headers',
  'nested_alt',
  'alt_hides_annotation',
  // Binding an annotation into the tree needs no value from anyone: the
  // element's role follows from the annotation's own subtype.
  'tagged_annotations',
  'tagged_multimedia',
  'tagged_form_fields',
  // An attachment's two file names are the SAME name in two encodings, so
  // either one supplies the other. Nothing is authored and nothing is guessed;
  // a specification carrying neither is left standing.
  'embedded_file_names',
];

/** The engine's authored set, mirrored (`AUTHORED_CHECKS`). */
export const AUTHORED_CHECKS: readonly string[] = [
  'lang',
  'tagged_content',
  'title',
  'field_descriptions',
  'figures_alt',
  'table_summary',
];

const AUTHORED: Record<string, AuthoredFix> = {
  lang: { input: 'language', scope: 'check', field: 'lang' },
  tagged_content: { input: 'role', scope: 'finding', field: 'role' },
  title: { input: 'text', scope: 'check', field: 'title' },
  field_descriptions: { input: 'text', scope: 'finding', field: 'description' },
  figures_alt: { input: 'text', scope: 'finding', field: 'alt' },
  table_summary: { input: 'text', scope: 'finding', field: 'summary' },
};

/** The verdicts a fix is offered against — the engine's `_FIXABLE_STATES`. */
export function isFixableStatus(status: string): boolean {
  return status === 'fail' || status === 'warn';
}

/**
 * What this check offers right now, or null for nothing.
 *
 * `title` is the check that needs the document's own state to answer: a title
 * that is merely not SHOWN needs no value from anyone, and a missing title
 * needs the one thing a machine must never invent. That is the same split the
 * engine's door makes, read off the verdict rather than duplicated.
 */
export function fixFor(check: Check): FixOffer | null {
  if (!isFixableStatus(check.status)) return null;
  if (check.id === 'title') {
    return check.status === 'warn' ? { kind: 'auto' } : { kind: 'authored', authored: AUTHORED.title };
  }
  if (check.id === 'bookmarks') {
    // `outline_from_structure` needs headings to derive from. Without them
    // this is a route to the Bookmarks panel, not a fix.
    const headings = Number((check.data ?? {}).headings ?? 0);
    return headings > 0 ? { kind: 'auto' } : null;
  }
  if (AUTOMATIC_CHECKS.includes(check.id)) return { kind: 'auto' };
  const authored = AUTHORED[check.id];
  return authored ? { kind: 'authored', authored } : null;
}

/** The engine call one authored value becomes. `method` is the operation
 * roster's key type, not a free string: every door here runs through
 * `performOperation`, which takes the signed-document decision from the op's
 * own edit class — a door added without one would not compile. */
export interface AuthoredCall {
  method: OpMethod;
  params: Record<string, unknown>;
}

/**
 * The door an authored value goes to. Returns null when the finding cannot
 * carry the value — an address the current report no longer resolves is a
 * stale-address refusal, never a silent retarget.
 *
 * `allowSigned` is the caller's already-taken signed-document decision, and it
 * rides only on the doors that ACCEPT it: the three catalog and form doors
 * take the decision, `set_struct_props` has never had one, and passing a
 * parameter a door does not declare is a type error at the engine rather than
 * a no-op.
 */
export function authoredCall(
  checkId: string,
  finding: Finding | null,
  value: string,
  allowSigned: boolean,
): AuthoredCall | null {
  const text = value.trim();
  const signed = { allow_signed: allowSigned };
  switch (checkId) {
    case 'lang':
      return text
        ? { method: 'set_document_language', params: { lang: text, ...signed } }
        : null;
    case 'title':
      return text
        ? { method: 'set_document_title', params: { title: text, display: true, ...signed } }
        : null;
    case 'field_descriptions': {
      const field = finding?.address.field;
      if (!field || !text) return null;
      return {
        method: 'set_field_description',
        params: { field, description: text, ...signed },
      };
    }
    case 'figures_alt': {
      const path = finding?.address.path;
      if (!path || !text) return null;
      return { method: 'set_struct_props', params: { path, props: { alt: text } } };
    }
    case 'table_summary': {
      const path = finding?.address.path;
      if (!path || !text) return null;
      return { method: 'set_struct_props', params: { path, props: { summary: text } } };
    }
    case 'tagged_content': {
      const page = finding?.address.page;
      const run = finding?.address.run;
      if (typeof page !== 'number' || typeof run !== 'number') return null;
      if (!(CONTENT_ROLES as readonly string[]).includes(text)) return null;
      return {
        method: 'tag_page_content',
        params: { page, targets: [{ run }], role: text, ...signed },
      };
    }
    default:
      return null;
  }
}

/** The draft key one editor writes under. Check-scope fixes have one editor
 * for the whole check; finding-scope fixes have one per row. */
export function draftKey(checkId: string, findingIndex: number | null): string {
  return findingIndex === null ? checkId : `${checkId}:${findingIndex}`;
}

/**
 * What a finding-scope editor starts with.
 *
 * A field's own NAME is offered as a suggestion for its description and is
 * never written without the user seeing it — a description that repeats
 * `Text1` is the same failure wearing a different key, so it is a placeholder
 * and not a value.
 */
export function suggestionFor(checkId: string, finding: Finding | null): string {
  if (checkId === 'field_descriptions') return finding?.address.field ?? '';
  return '';
}

/**
 * "Declare the rest decoration" — every untagged run this check named, as
 * artifacts, ONE CALL PER PAGE.
 *
 * Per page because marked-content ids are page-scoped: a single call spanning
 * two pages would have to allocate two numbering spaces, which is the rule the
 * door exists to keep. Each page is therefore its own undoable step, and a
 * page of running heads — the case this action exists for — is one step.
 */
export function artifactCalls(check: Check, allowSigned: boolean): AuthoredCall[] {
  const byPage = new Map<number, number[]>();
  for (const item of check.findings) {
    const page = item.address.page;
    const run = item.address.run;
    if (item.address.kind !== 'content') continue;
    if (typeof page !== 'number' || typeof run !== 'number') continue;
    const runs = byPage.get(page) ?? [];
    runs.push(run);
    byPage.set(page, runs);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([page, runs]) => ({
      method: 'tag_page_content',
      params: {
        page,
        targets: [...new Set(runs)].sort((a, b) => a - b).map((run) => ({ run })),
        role: 'Artifact',
        allow_signed: allowSigned,
      },
    }));
}
