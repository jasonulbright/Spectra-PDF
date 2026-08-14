import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRY_POINTS, recognize, type FieldScript } from '../src/renderer/lib/af-script';
import {
  CycleError,
  EmitError,
  actionsFromScripts,
  calculateInputs,
  calculationOrder,
  emittedScripts,
  type FieldCalculate,
  type FieldFormat,
  type FieldValidate,
} from '../src/renderer/lib/af-emit';
import {
  DATE_FORMATS,
  TIME_FORMATS,
  asStored,
  calculate,
  closure,
  formatDisplay,
  run,
  unrunnable,
  type AfProblem,
  type FieldActions,
} from '../src/renderer/lib/af-calc';

// The renderer half of the shared field-script pin. The SAME JSON drives
// tests/test_afcalc.py: the fill computes in the engine and the canvas
// previews here, so the two must answer alike or a Total the user watched
// appear differs from the one the file was saved with.
//
// Every expectation in the corpus was checked against the reference
// implementation extracted from the AcroForm scripting host that ships,
// unused, inside the pdf.js dependency — so a row that looks wrong is the
// reference being reproduced, not a transcription error.

interface RecognizeCase {
  name: string;
  js: string;
  script: FieldScript | null;
}
interface FormatCase {
  name: string;
  js: string;
  value: string;
  shown: string;
}
interface CommitCase {
  name: string;
  js: string;
  value: string;
  ok: boolean;
  stored?: string;
  problem: AfProblem | null;
}
interface EvaluateCase {
  name: string;
  fields: Record<string, string>;
  terminals: string[];
  scripts: Record<string, Record<string, string>>;
  co: string[];
  expect: Record<string, string>;
  shown: Record<string, string>;
  unrecognized: string[];
}
interface ClosureCase {
  name: string;
  typed: string[];
  scripts: Record<string, Record<string, string>>;
  co: string[];
  terminals: string[];
  transitive: string[];
}
/** The corpus speaks the ENGINE's key spelling; the renderer spec is the same
 * data under camelCase names, exactly as field-spec-corpus.test.ts converts. */
interface CorpusEmitSpec {
  format?: Record<string, unknown>;
  validate?: FieldValidate;
  calculate?: FieldCalculate;
}
interface EmitCase {
  name: string;
  spec: CorpusEmitSpec;
  scripts?: Record<string, string>;
  inputs?: string[];
  refuses?: boolean;
}
interface OrderCase {
  name: string;
  existing: string[];
  existing_inputs: Record<string, string[]>;
  new: [string, string[]][];
  order?: string[];
  cycle?: boolean;
  chain?: string[];
}

const corpus = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'af-corpus.json'), 'utf8')) as {
  entry_points: string[];
  date_formats: string[];
  time_formats: string[];
  recognize: RecognizeCase[];
  format: FormatCase[];
  keystroke: CommitCase[];
  validate: CommitCase[];
  evaluate: EvaluateCase[];
  closure: ClosureCase[];
  round_trip: string[];
  emit: EmitCase[];
  order: OrderCase[];
};

function asFormat(raw: Record<string, unknown>): FieldFormat {
  return {
    kind: raw.kind,
    decimals: raw.decimals,
    sepStyle: raw.sep_style,
    negStyle: raw.neg_style,
    currency: raw.currency,
    currencyPrepend: raw.currency_prepend,
    prepend: raw.prepend,
    mask: raw.mask,
    psf: raw.psf,
  } as unknown as FieldFormat;
}

function asEmitSpec(spec: CorpusEmitSpec): Parameters<typeof emittedScripts>[0] {
  return {
    ...(spec.format !== undefined ? { format: asFormat(spec.format) } : {}),
    ...(spec.validate !== undefined ? { validate: spec.validate } : {}),
    ...(spec.calculate !== undefined ? { calculate: spec.calculate } : {}),
  };
}

/** The corpus' `{field: {trigger: js}}` recognized, plus the fields whose
 * script this app does not run. */
function scriptsOf(raw: Record<string, Record<string, string>>): {
  scripts: Record<string, FieldActions>;
  unrecognized: string[];
} {
  const scripts: Record<string, FieldActions> = {};
  const unrecognized = new Set<string>();
  for (const [field, actions] of Object.entries(raw)) {
    const entry: FieldActions = {};
    for (const [trigger, js] of Object.entries(actions)) {
      const script = recognize(js);
      if (script === null || unrunnable(script)) {
        unrecognized.add(field);
        continue;
      }
      (entry as Record<string, FieldScript>)[trigger] = script;
    }
    scripts[field] = entry;
  }
  return { scripts, unrecognized: [...unrecognized].sort() };
}

describe('recognizer', () => {
  for (const testCase of corpus.recognize) {
    it(testCase.name, () => {
      expect(recognize(testCase.js)).toEqual(testCase.script);
    });
  }

  it('accepts every script this app writes', () => {
    for (const js of corpus.round_trip) expect(recognize(js), js).not.toBeNull();
  });

  // A new function cannot join the table without a corpus row — the same
  // coverage contract field-spec-corpus.test.ts carries.
  it('covers every entry point', () => {
    const covered = new Set(
      corpus.recognize.filter((c) => c.script !== null).map((c) => recognize(c.js)?.fn),
    );
    for (const name of Object.keys(ENTRY_POINTS)) expect(covered.has(name), name).toBe(true);
    expect(covered.has('SFN')).toBe(true);
    expect(corpus.entry_points).toEqual(Object.keys(ENTRY_POINTS).sort());
  });

  it('pins both mask tables', () => {
    expect(corpus.date_formats).toEqual(DATE_FORMATS);
    expect(corpus.time_formats).toEqual(TIME_FORMATS);
  });
});

describe('format', () => {
  for (const testCase of corpus.format) {
    it(testCase.name, () => {
      const script = recognize(testCase.js);
      expect(script).not.toBeNull();
      expect(asStored(run(script as FieldScript, testCase.value).value)).toBe(testCase.shown);
    });
  }

  it('pins every separator style', () => {
    const shown = new Set(
      corpus.format.filter((c) => c.name.startsWith('separator style')).map((c) => c.shown),
    );
    expect([...shown].sort()).toEqual(["1'234.50", '1,234.50', '1.234,50', '1234,50', '1234.50']);
  });
});

describe('keystroke', () => {
  for (const testCase of corpus.keystroke) {
    it(testCase.name, () => {
      const script = recognize(testCase.js);
      expect(script).not.toBeNull();
      const event = run(script as FieldScript, testCase.value);
      expect(event.rc).toBe(testCase.ok);
      expect(asStored(event.value)).toBe(testCase.stored);
      expect(event.problem).toEqual(testCase.problem);
    });
  }
});

describe('validate', () => {
  for (const testCase of corpus.validate) {
    it(testCase.name, () => {
      const script = recognize(testCase.js);
      expect(script).not.toBeNull();
      const event = run(script as FieldScript, testCase.value);
      expect(event.rc).toBe(testCase.ok);
      expect(event.problem).toEqual(testCase.problem);
    });
  }
});

describe('calculation pass', () => {
  for (const testCase of corpus.evaluate) {
    it(testCase.name, () => {
      const { scripts, unrecognized } = scriptsOf(testCase.scripts);
      expect(unrecognized).toEqual(testCase.unrecognized);
      const changed = calculate(testCase.fields, scripts, testCase.co, testCase.terminals);
      expect(changed).toEqual(testCase.expect);
      const shown: Record<string, string> = {};
      for (const [name, value] of Object.entries(changed)) {
        shown[name] = formatDisplay(scripts[name]?.F ?? null, value);
      }
      expect(shown).toEqual(testCase.shown);
    });
  }
});

describe('transitive closure', () => {
  for (const testCase of corpus.closure) {
    it(testCase.name, () => {
      const { scripts } = scriptsOf(testCase.scripts);
      expect(closure(testCase.typed, scripts, testCase.co, testCase.terminals)).toEqual(
        testCase.transitive,
      );
    });
  }
});

// ── the authoring half ────────────────────────────────────────────────────

describe('emission', () => {
  for (const testCase of corpus.emit) {
    it(testCase.name, () => {
      const spec = asEmitSpec(testCase.spec);
      if (testCase.refuses) {
        expect(() => emittedScripts(spec)).toThrow(EmitError);
        return;
      }
      const scripts = emittedScripts(spec);
      expect(scripts).toEqual(testCase.scripts);
      // Every body this app writes is a body this app runs — asserted, not
      // hoped for. A viewer that executes the stock call gets the same answer
      // the fill computes.
      for (const [trigger, js] of Object.entries(scripts)) {
        expect(recognize(js), `${trigger}: ${js}`).not.toBeNull();
      }
      if (testCase.inputs !== undefined) {
        expect(calculateInputs(testCase.spec.calculate as FieldCalculate)).toEqual(testCase.inputs);
      }
      // The reader is the emitter's inverse: a field opened in the properties
      // editor and applied again unchanged writes the same bytes. An inverse
      // that lost a member would silently edit an existing form into a
      // different one.
      const readBack = actionsFromScripts(scripts, DATE_FORMATS, TIME_FORMATS);
      expect(emittedScripts(readBack)).toEqual(scripts);
    });
  }

  it('covers every format kind and every calculation', () => {
    const kinds = new Set(
      corpus.emit.filter((c) => !c.refuses && c.spec.format).map((c) => c.spec.format!.kind),
    );
    expect(kinds).toEqual(new Set(['number', 'percent', 'date', 'time', 'special', 'mask']));
    const ops = new Set(
      corpus.emit
        .filter((c) => !c.refuses && c.spec.calculate && 'op' in c.spec.calculate)
        .map((c) => (c.spec.calculate as { op: string }).op),
    );
    expect(ops).toEqual(new Set(['SUM', 'PRD', 'AVG', 'MIN', 'MAX']));
    expect(corpus.emit.some((c) => c.refuses)).toBe(true);
  });
});

describe('calculation order', () => {
  for (const testCase of corpus.order) {
    it(testCase.name, () => {
      const existing = new Map(Object.entries(testCase.existing_inputs));
      const run = (): string[] =>
        calculationOrder(testCase.existing, existing, testCase.new);
      if (testCase.cycle) {
        expect(run).toThrow(CycleError);
        let chain: readonly string[] = [];
        try {
          run();
        } catch (err) {
          chain = err instanceof CycleError ? err.chain : [];
        }
        expect(chain).toEqual(testCase.chain);
        return;
      }
      expect(run()).toEqual(testCase.order);
    });
  }
});
