import { describe, expect, it } from 'vitest';
import {
  CERTIFICATION_LEVEL_LABEL,
  classifySignature,
  MODIFICATION_LEVEL_LABEL,
  modificationLevelLabel,
  policyVerdict,
  POLICY_VERDICT_LABEL,
  signatureKind,
  signedEditDecision,
  SIGNATURE_KIND_LABEL,
  SIGNATURE_STATUS_LABEL,
  type CertificationLevel,
  type EditClass,
  type SignatureEntry,
  type SignaturePolicy,
  type SignedEditKey,
} from '../src/renderer/lib/signatures';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import { WORKBENCH_STRINGS } from '../src/renderer/i18n-workbench';

// The one valid/modified/invalid decision shared by the Tools and nav-pane
// Signatures panels — so they can't disagree on what "valid" is.

function sig(partial: Partial<SignatureEntry>): SignatureEntry {
  return {
    field: 'Sig1',
    signer: 'Test Signer',
    valid: true,
    intact: true,
    trusted: false,
    coverage: 'whole',
    covers_whole_document: true,
    modified_after_signing: false,
    digest_algorithm: 'sha256',
    signing_time: null,
    ...partial,
  };
}

describe('classifySignature', () => {
  it('valid + intact + unmodified → valid', () => {
    expect(classifySignature(sig({}))).toBe('valid');
  });

  it('modified after signing (still cryptographically valid) → modified', () => {
    expect(classifySignature(sig({ modified_after_signing: true }))).toBe('modified');
  });

  it('not cryptographically valid → invalid (regardless of modified flag)', () => {
    expect(classifySignature(sig({ valid: false }))).toBe('invalid');
    expect(classifySignature(sig({ valid: false, modified_after_signing: true }))).toBe('invalid');
  });

  it('valid signature over a broken byte range → invalid', () => {
    expect(classifySignature(sig({ intact: false }))).toBe('invalid');
  });

  it('every status has a label (labels are catalog keys; the wording pin follows them into the record)', () => {
    expect(PANEL_STRINGS[SIGNATURE_STATUS_LABEL.valid]).toContain('valid');
    expect(PANEL_STRINGS[SIGNATURE_STATUS_LABEL.modified]).toContain('changed after signing');
    expect(PANEL_STRINGS[SIGNATURE_STATUS_LABEL.invalid]).toBe('Invalid');
  });
});

// Certification is a second axis. These cases exist to prove it does not
// disturb the first: every classifySignature case above runs unchanged.

const LEVELS: (CertificationLevel | null)[] = [null, 'none', 'form-fill', 'annotate'];

describe('signatureKind', () => {
  it('an absent or null level is an approval signature', () => {
    expect(signatureKind(sig({}))).toBe('approval');
    expect(signatureKind(sig({ certification_level: null }))).toBe('approval');
  });

  it('any declared level is a certification signature', () => {
    for (const level of LEVELS.filter((l) => l !== null)) {
      expect(signatureKind(sig({ certification_level: level }))).toBe('certification');
    }
  });

  it('the kind is independent of validity and of the policy verdict', () => {
    expect(
      signatureKind(sig({ certification_level: 'none', valid: false, policy_ok: false })),
    ).toBe('certification');
    expect(classifySignature(sig({ certification_level: 'none', valid: false }))).toBe('invalid');
  });
});

describe('policyVerdict', () => {
  it('an unjudged verdict outranks the pass/fail question', () => {
    expect(policyVerdict(sig({ policy_judged: false, policy_ok: null }))).toBe('unjudged');
    expect(policyVerdict(sig({ policy_judged: false, policy_ok: false }))).toBe('unjudged');
    expect(policyVerdict(sig({ policy_judged: false, policy_ok: true }))).toBe('unjudged');
  });

  it('an absent judged flag is unjudged, never a silent pass', () => {
    expect(policyVerdict(sig({}))).toBe('unjudged');
  });

  it('judged false is a violation, judged true is within policy', () => {
    expect(policyVerdict(sig({ policy_judged: true, policy_ok: false }))).toBe('violates-policy');
    expect(policyVerdict(sig({ policy_judged: true, policy_ok: true }))).toBe('within-policy');
  });

  it('covers the full cross-product of level, judged and ok', () => {
    for (const level of LEVELS) {
      for (const judged of [true, false]) {
        for (const ok of [true, false, null]) {
          const verdict = policyVerdict(
            sig({ certification_level: level, policy_judged: judged, policy_ok: ok }),
          );
          expect(verdict).toBe(
            !judged ? 'unjudged' : ok === false ? 'violates-policy' : 'within-policy',
          );
        }
      }
    }
  });
});

describe('the second axis label maps', () => {
  it('every kind, verdict and level resolves to a catalog string', () => {
    for (const key of Object.values(SIGNATURE_KIND_LABEL)) {
      expect(PANEL_STRINGS[key]).toBeTruthy();
    }
    for (const key of Object.values(POLICY_VERDICT_LABEL)) {
      expect(PANEL_STRINGS[key]).toBeTruthy();
    }
    for (const key of Object.values(CERTIFICATION_LEVEL_LABEL)) {
      expect(PANEL_STRINGS[key]).toBeTruthy();
    }
    for (const key of Object.values(MODIFICATION_LEVEL_LABEL)) {
      expect(PANEL_STRINGS[key]).toBeTruthy();
    }
  });

  it('the three levels are worded by what they permit, not by their wire value', () => {
    expect(PANEL_STRINGS[CERTIFICATION_LEVEL_LABEL.none]).toBe('No changes allowed');
    expect(PANEL_STRINGS[CERTIFICATION_LEVEL_LABEL['form-fill']]).toContain('Form filling');
    expect(PANEL_STRINGS[CERTIFICATION_LEVEL_LABEL.annotate]).toContain('commenting');
  });

  it('an unknown or absent modification level resolves to nothing, never a guess', () => {
    expect(modificationLevelLabel(null)).toBeNull();
    expect(modificationLevelLabel(undefined)).toBeNull();
    expect(modificationLevelLabel('SOMETHING_NEW')).toBeNull();
    expect(modificationLevelLabel('FORM_FILLING')).toBe(MODIFICATION_LEVEL_LABEL.FORM_FILLING);
  });
});

describe('signedEditDecision', () => {
  const policy = (partial: Partial<SignaturePolicy>): SignaturePolicy => ({
    signed: true,
    count: 1,
    certified: false,
    level: null,
    ...partial,
  });
  const CLASSES: EditClass[] = ['form-fill', 'annotate', 'structural'];

  it('an unsigned, uncertified document proceeds silently for every class', () => {
    for (const editClass of CLASSES) {
      expect(
        signedEditDecision(policy({ signed: false, count: 0 }), editClass).kind,
      ).toBe('proceed');
    }
  });

  it('a signed, uncertified document warns only for the classes the append tier cannot carry', () => {
    expect(signedEditDecision(policy({}), 'form-fill').kind).toBe('proceed');
    expect(signedEditDecision(policy({}), 'annotate').kind).toBe('proceed');
    const decision = signedEditDecision(policy({}), 'structural');
    expect(decision.kind).toBe('warn');
    if (decision.kind !== 'proceed') {
      expect(decision.bodyKey).toBe('app.signedEdit.body');
    }
  });

  it('a no-changes certification refuses every class, and never merely warns', () => {
    for (const editClass of CLASSES) {
      const decision = signedEditDecision(
        policy({ certified: true, level: 'none' }),
        editClass,
      );
      expect(decision.kind).toBe('refuse');
      if (decision.kind !== 'proceed') {
        expect(decision.bodyKey).toBe('app.signedEdit.certifiedRefused');
      }
    }
  });

  it('the refusal names the way forward', () => {
    expect(WORKBENCH_STRINGS['app.signedEdit.certifiedRefused']).toContain('Save a copy');
  });

  it('a form-filling certification permits filling and warns on the rest', () => {
    const p = policy({ certified: true, level: 'form-fill' });
    expect(signedEditDecision(p, 'form-fill').kind).toBe('proceed');
    expect(signedEditDecision(p, 'annotate').kind).toBe('warn');
    expect(signedEditDecision(p, 'structural').kind).toBe('warn');
  });

  it('an annotating certification permits filling and commenting, and warns on structure', () => {
    const p = policy({ certified: true, level: 'annotate' });
    expect(signedEditDecision(p, 'form-fill').kind).toBe('proceed');
    expect(signedEditDecision(p, 'annotate').kind).toBe('proceed');
    expect(signedEditDecision(p, 'structural').kind).toBe('warn');
  });

  it('a certification whose level is unrecognised permits nothing and says so', () => {
    const p = policy({ certified: true, level: null });
    for (const editClass of CLASSES) {
      const decision = signedEditDecision(p, editClass);
      expect(decision.kind).toBe('warn');
      if (decision.kind !== 'proceed') {
        expect(decision.bodyKey).toBe('app.signedEdit.certifiedWarnUnknown');
      }
    }
  });

  it('a structural edit never proceeds silently on a signed document', () => {
    // The property every content-rewriting call site depends on: page
    // surgery, content edits and applying redactions all coalesce the file
    // and break every byte range, whatever any certification permits.
    const states: Partial<SignaturePolicy>[] = [
      {},
      { certified: true, level: 'none' },
      { certified: true, level: 'form-fill' },
      { certified: true, level: 'annotate' },
      { certified: true, level: null },
    ];
    for (const state of states) {
      expect(signedEditDecision(policy(state), 'structural').kind).not.toBe('proceed');
    }
  });

  it('a certification on a document reporting no filled field is still honoured', () => {
    const decision = signedEditDecision(
      policy({ signed: false, count: 0, certified: true, level: 'none' }),
      'annotate',
    );
    expect(decision.kind).toBe('refuse');
  });

  it('every key a decision can name exists in the catalog', () => {
    const keys: SignedEditKey[] = [
      'app.signedEdit.title',
      'app.signedEdit.body',
      'app.signedEdit.certifiedTitle',
      'app.signedEdit.certifiedRefused',
      'app.signedEdit.certifiedWarnFormFill',
      'app.signedEdit.certifiedWarnAnnotate',
      'app.signedEdit.certifiedWarnUnknown',
    ];
    for (const key of keys) expect(WORKBENCH_STRINGS[key]).toBeTruthy();
  });
});
