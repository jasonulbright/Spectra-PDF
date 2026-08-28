import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useActiveFile } from '../hooks/useActiveFile';
import { useEngine } from '../hooks/useEngine';
import { useOperations } from '../hooks/useOperations';
import { NoFileOpen } from '../components/NoFileOpen';
import { useTranslation } from 'react-i18next';
import { tChrome, tChromeCount, tLanguageName, currentLanguage } from '../i18n';
import { app, dialog, file } from '../lib/tauri-bridge';
import { loadSettings, saveSettings } from '../lib/app-settings';
import { EDIT_DECLINED } from '../lib/edit-text';
import type { EditSpan } from '../lib/edit-paragraphs';
import {
  AUTO_LANGUAGE,
  addCustomWord,
  groupByWord,
  loadCustomWords,
  occurrencesDescending,
  paragraphFix,
  removeCustomWord,
  replaceRange,
  resolveSpellLanguage,
  saveCustomWords,
  wordAt,
  type DictionaryEntry,
  type FixOutcome,
  type SpellIssue,
  type SpellReport,
  type SpellSource,
} from '../lib/spellcheck';

// The Spelling pane — the document-wide check.
//
// Shape: choose a dictionary, choose what to walk, check, then work the list.
// The list is grouped BY WORD because that is what "change all" acts on, and
// each entry expands to its individual occurrences because that is what a
// single change acts on.
//
// Suggestions are fetched for ONE selected word at a time, never for the whole
// list: a lookup is microseconds but a suggestion is milliseconds on English
// and over a second on a compounding language, so eager suggestions would turn
// a two-second check into a minutes-long one.
//
// NOTHING here writes bytes. A page-text change goes through the paragraph
// editor's own engine call with its own fingerprint, a comment change through
// the annotation tier, a field change through the form fill — so each is an
// ordinary undoable edit and inherits every guarantee its surface already has.

const ALL_SOURCES: SpellSource[] = ['text', 'comments', 'fields'];

export function SpellingPanel(): React.ReactElement {
  useTranslation();
  const { activeFile, openNewFiles, state, dispatch } = useActiveFile();
  const { call } = useEngine();
  const { performOperation, confirmSignedEdit } = useOperations();

  const [dictionaries, setDictionaries] = useState<DictionaryEntry[]>([]);
  const [preference, setPreference] = useState<string>(() => loadSettings().spellLanguage);
  const [sources, setSources] = useState<SpellSource[]>(ALL_SOURCES);
  const [ignoreUppercase, setIgnoreUppercase] = useState(true);
  const [ignoreWithDigits, setIgnoreWithDigits] = useState(true);
  const [report, setReport] = useState<SpellReport | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [replacement, setReplacement] = useState('');
  const [ignored, setIgnored] = useState<string[]>([]);
  const [custom, setCustom] = useState<string[]>(() => loadCustomWords());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const workingPath = activeFile?.workingPath ?? null;
  const filePath = activeFile?.path ?? null;

  // The vendored dictionary directory and the user's own are resolved once —
  // they are Rust-owned paths that cannot change while the app runs.
  const [dirs, setDirs] = useState<{ bundled: string; user: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [bundled, user] = await Promise.all([app.getDictionaryPath(), app.userDictionaryDir()]);
      if (!cancelled) setDirs({ bundled, user });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDictionaries = useCallback(async () => {
    if (!dirs) return;
    const res = (await call('list_dictionaries', {
      dictionary_dir: dirs.bundled,
      user_dictionary_dir: dirs.user,
    })) as unknown as { dictionaries: DictionaryEntry[] };
    setDictionaries(res.dictionaries ?? []);
  }, [call, dirs]);

  useEffect(() => {
    void refreshDictionaries();
  }, [refreshDictionaries]);

  // The document's own /Lang, read when the file changes rather than learned
  // from the first report — a French document opened in an English interface
  // must be checked in French on the FIRST run, not the second.
  const [docLanguage, setDocLanguage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDocLanguage(null);
    if (!workingPath) return;
    void call('document_language', { file: workingPath })
      .then((res) => {
        if (!cancelled) setDocLanguage((res as unknown as { language: string | null }).language);
      })
      .catch(() => {
        if (!cancelled) setDocLanguage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workingPath, call]);

  const engineParams = useMemo(() => {
    if (!dirs) return null;
    const language = resolveSpellLanguage(
      preference,
      docLanguage,
      currentLanguage(),
      dictionaries,
    );
    return {
      dictionary_dir: dirs.bundled,
      user_dictionary_dir: dirs.user,
      language,
      custom_words: custom,
    };
  }, [dirs, preference, dictionaries, custom, docLanguage]);

  const visible = useMemo(
    () => (report?.issues ?? []).filter((i) => !ignored.includes(i.word)),
    [report, ignored],
  );
  const groups = useMemo(() => groupByWord(visible), [visible]);

  const check = useCallback(async () => {
    if (!workingPath || !engineParams) return;
    setBusy(true);
    setStatus(tChrome('panel.spelling.checking'));
    try {
      const res = (await call('check_spelling', {
        file: workingPath,
        ...engineParams,
        sources,
        ignore_uppercase: ignoreUppercase,
        ignore_with_digits: ignoreWithDigits,
      })) as unknown as SpellReport;
      setReport(res);
      setSelected(null);
      setSuggestions([]);
      setStatus('');
    } catch (e: unknown) {
      setReport(null);
      setStatus(
        tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
      );
    } finally {
      setBusy(false);
    }
  }, [workingPath, call, engineParams, sources, ignoreUppercase, ignoreWithDigits]);

  // A word's suggestions, on selection. See the cost note at the top.
  const selectWord = useCallback(
    async (word: string) => {
      setSelected(word);
      setSuggestions([]);
      setReplacement('');
      if (!engineParams) return;
      try {
        const res = (await call('spelling_suggestions', {
          word,
          language: engineParams.language,
          dictionary_dir: engineParams.dictionary_dir,
          user_dictionary_dir: engineParams.user_dictionary_dir,
          custom_words: engineParams.custom_words,
        })) as unknown as { suggestions: string[] };
        setSuggestions(res.suggestions ?? []);
        setReplacement(res.suggestions?.[0] ?? '');
      } catch {
        // A word with no suggestions is an ordinary outcome, not an error:
        // the panel shows the typed-replacement field either way.
        setSuggestions([]);
      }
    },
    [call, engineParams],
  );

  // ── the three fix paths ──────────────────────────────────────────────────
  //
  // Each re-reads its own surface and verifies the word is still where the
  // report said before writing. A document that moved underneath refuses by
  // name rather than correcting a different word.

  const fixPageText = useCallback(
    async (issue: SpellIssue, word: string): Promise<FixOutcome> => {
      if (!filePath || !workingPath || issue.page === undefined || issue.paragraph === undefined) {
        return { issue, ok: false, reason: tChrome('panel.spelling.reasonGone') };
      }
      const listing = (await call('list_text_paragraphs', {
        file: workingPath,
        page: issue.page,
      })) as unknown as {
        paragraphs: Array<{ index: number; runs: number[]; text: string; spans: EditSpan[] }>;
      };
      const para = listing.paragraphs.find((p) => p.index === issue.paragraph);
      if (!para) return { issue, ok: false, reason: tChrome('panel.spelling.reasonGone') };
      const fix = paragraphFix(para.text, para.spans, { ...issue, word }, replacement, para.runs[0]);
      if (!fix) return { issue, ok: false, reason: tChrome('panel.spelling.reasonMoved') };
      // A correction is a content edit, so it answers to the document's own
      // signatures exactly as the canvas editor's does — decided inside
      // performOperation, from the op's own edit class.
      const r = await performOperation(filePath, 'replace_paragraph_text', {
        page: issue.page,
        paragraph_index: para.index,
        new_text: fix.text,
        spans: fix.spans.map((s) => ({ start: s.start, end: s.end, run: s.run })),
        // The fingerprint the paragraph editor sends: the engine re-derives
        // its grouping from these and REFUSES a stale view rather than
        // silently retargeting a heuristic.
        expected_runs: para.runs,
        expected_text: para.text,
        font_path: await app.getEditFontPath(),
      });
      if (r === EDIT_DECLINED) {
        return { issue, ok: false, reason: tChrome('panel.spelling.reasonDeclined') };
      }
      return { issue, ok: true };
    },
    [filePath, workingPath, call, performOperation, replacement],
  );

  const fixComment = useCallback(
    (issue: SpellIssue, word: string): FixOutcome => {
      // Comments are addressed by their TEXT within their page, not by the
      // engine listing's index: the workspace annotation tier is a separate
      // listing, and pairing two listings by ordinal is a silent mis-fix
      // waiting for the first document whose orders differ.
      for (const doc of state.workspace.documents) {
        if (doc.path !== filePath) continue;
        for (const page of doc.pages) {
          const hit = (page.annotations ?? []).find((a) => a.note === issue.annotation_text);
          if (!hit) continue;
          if (wordAt(hit.note ?? '', issue.start, issue.end) !== word) {
            return { issue, ok: false, reason: tChrome('panel.spelling.reasonMoved') };
          }
          dispatch({
            type: 'UPDATE_ANNOTATION',
            docId: doc.id,
            pageId: page.id,
            annotationId: hit.id,
            note: replaceRange(hit.note ?? '', issue.start, issue.end, replacement),
          });
          return { issue, ok: true };
        }
      }
      return { issue, ok: false, reason: tChrome('panel.spelling.reasonGone') };
    },
    [state.workspace.documents, filePath, dispatch, replacement],
  );

  const fixField = useCallback(
    async (issue: SpellIssue, word: string): Promise<FixOutcome> => {
      if (!activeFile || !issue.field) {
        return { issue, ok: false, reason: tChrome('panel.spelling.reasonGone') };
      }
      const read = (await call('read_form_fields', { file: activeFile.workingPath })) as unknown as {
        fields: Array<{ name: string; value: unknown }>;
      };
      const field = read.fields.find((f) => f.name === issue.field);
      const value = typeof field?.value === 'string' ? field.value : null;
      if (value === null) return { issue, ok: false, reason: tChrome('panel.spelling.reasonGone') };
      if (wordAt(value, issue.start, issue.end) !== word) {
        return { issue, ok: false, reason: tChrome('panel.spelling.reasonMoved') };
      }
      if (
        !(await confirmSignedEdit(activeFile.path, activeFile.workingPath, 'form-fill', [
          issue.field,
        ]))
      ) {
        return { issue, ok: false, reason: tChrome('panel.spelling.reasonDeclined') };
      }
      // The shipped fill shape: snapshot (runs the commit gate) → engine fill
      // → reload → UPDATE_FILE, so the change is one ordinary undo entry.
      const snapshotPath = await file.snapshot(activeFile.workingPath);
      await call('fill_form_fields', {
        file: activeFile.workingPath,
        output: activeFile.workingPath,
        edits: { [issue.field]: replaceRange(value, issue.start, issue.end, replacement) },
        font_dir: await app.getEditFontPath(),
      });
      const buffer = await file.readBuffer(activeFile.workingPath);
      dispatch({
        type: 'UPDATE_FILE',
        path: activeFile.path,
        pageCount: activeFile.pageCount,
        buffer,
        snapshotPath,
      });
      return { issue, ok: true };
    },
    [activeFile, call, confirmSignedEdit, dispatch, replacement],
  );

  const applyOne = useCallback(
    async (issue: SpellIssue, word: string): Promise<FixOutcome> => {
      if (issue.source === 'text') return fixPageText(issue, word);
      if (issue.source === 'comments') return fixComment(issue, word);
      return fixField(issue, word);
    },
    [fixPageText, fixComment, fixField],
  );

  const runFix = useCallback(
    async (targets: SpellIssue[], word: string) => {
      if (!replacement.trim()) return;
      setBusy(true);
      setStatus(tChrome('panel.spelling.changing'));
      const outcomes: FixOutcome[] = [];
      try {
        for (const issue of targets) {
          outcomes.push(await applyOne(issue, word));
        }
      } catch (e: unknown) {
        setStatus(
          tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
        );
        setBusy(false);
        return;
      }
      const failed = outcomes.filter((o) => !o.ok);
      // Per instance, never one aggregate verdict: a run whose third
      // occurrence had moved must not report a whole-document success.
      setStatus(
        failed.length === 0
          ? tChromeCount('panel.spelling.changed', outcomes.length)
          : tChrome('panel.spelling.changedPartly', {
              done: outcomes.length - failed.length,
              failed: failed.length,
              reason: failed[0].reason ?? '',
            }),
      );
      setBusy(false);
      await check();
    },
    [applyOne, replacement, check],
  );

  const addToDictionary = useCallback(
    (word: string) => {
      const next = addCustomWord(custom, word);
      setCustom(next);
      saveCustomWords(next);
      setSelected(null);
    },
    [custom],
  );

  const addDictionary = useCallback(async () => {
    if (!dirs) return;
    const picked = await dialog.pickDictionaryFiles();
    if (!picked || picked.length === 0) return;
    const aff = picked.find((p: string) => p.toLowerCase().endsWith('.aff'));
    const dic = picked.find((p: string) => p.toLowerCase().endsWith('.dic'));
    if (!aff || !dic) {
      setStatus(tChrome('panel.spelling.pairNeeded'));
      return;
    }
    try {
      const added = (await call('add_user_dictionary', {
        aff,
        dic,
        user_dictionary_dir: dirs.user,
        dictionary_dir: dirs.bundled,
      })) as unknown as DictionaryEntry;
      await refreshDictionaries();
      setPreference(added.tag);
      saveSettings({ ...loadSettings(), spellLanguage: added.tag });
      setStatus(tChrome('panel.spelling.dictionaryAdded', { name: tLanguageName(added.bcp47) }));
    } catch (e: unknown) {
      setStatus(
        tChrome('panel.common.error', { message: e instanceof Error ? e.message : String(e) }),
      );
    }
  }, [dirs, call, refreshDictionaries]);

  const toggleSource = (source: SpellSource) =>
    setSources((prev) =>
      prev.includes(source) ? prev.filter((s) => s !== source) : [...prev, source],
    );

  if (!activeFile) {
    return <NoFileOpen onOpen={openNewFiles} message={tChrome('panel.spelling.open')} />;
  }

  const selectedIssues = selected ? occurrencesDescending(visible, selected) : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm text-neutral-400">
        {tChrome('panel.common.workingOn')}{' '}
        <span className="text-neutral-200">{activeFile.name}</span>
      </div>
      <p className="text-xs text-neutral-500">{tChrome('panel.spelling.blurb')}</p>

      <label className="flex items-center gap-2 text-xs text-neutral-500">
        {tChrome('panel.spelling.languageLabel')}
        <select
          data-testid="spelling-language"
          className="px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
          value={preference}
          onChange={(e) => {
            setPreference(e.target.value);
            saveSettings({ ...loadSettings(), spellLanguage: e.target.value });
          }}
        >
          <option value={AUTO_LANGUAGE}>{tChrome('panel.spelling.languageAuto')}</option>
          {dictionaries.map((d) => (
            <option key={d.tag} value={d.tag}>
              {tLanguageName(d.bcp47)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        data-testid="spelling-add-dictionary"
        className="self-start px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-neutral-200"
        onClick={() => void addDictionary()}
      >
        {tChrome('panel.spelling.addDictionary')}
      </button>

      <div className="flex flex-col gap-1">
        {ALL_SOURCES.map((source) => (
          <label key={source} className="flex items-center gap-2 text-xs text-neutral-500">
            <input
              type="checkbox"
              data-testid={`spelling-source-${source}`}
              checked={sources.includes(source)}
              onChange={() => toggleSource(source)}
            />
            {tChrome(`panel.spelling.source.${source}` as 'panel.spelling.source.text')}
          </label>
        ))}
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="spelling-ignore-uppercase"
            checked={ignoreUppercase}
            onChange={(e) => setIgnoreUppercase(e.target.checked)}
          />
          {tChrome('panel.spelling.ignoreUppercase')}
        </label>
        <label className="flex items-center gap-2 text-xs text-neutral-500">
          <input
            type="checkbox"
            data-testid="spelling-ignore-digits"
            checked={ignoreWithDigits}
            onChange={(e) => setIgnoreWithDigits(e.target.checked)}
          />
          {tChrome('panel.spelling.ignoreWithDigits')}
        </label>
      </div>

      <button
        type="button"
        data-testid="spelling-check"
        className="self-start px-3 py-1 text-sm bg-neutral-800 border border-neutral-700 rounded text-neutral-100 disabled:opacity-60"
        disabled={busy || sources.length === 0}
        onClick={() => void check()}
      >
        {tChrome('panel.spelling.check')}
      </button>

      {report !== null && (
        <div className="flex flex-col gap-1" data-testid="spelling-report">
          <div className="text-sm text-neutral-200" data-testid="spelling-count">
            {visible.length === 0
              ? tChrome('panel.spelling.clean')
              : tChromeCount('panel.spelling.found', visible.length)}
          </div>
          <div className="text-xs text-neutral-500" data-testid="spelling-scanned">
            {tChrome('panel.spelling.scanned', {
              words: report.words,
              language: tLanguageName(report.bcp47),
            })}
          </div>
          {report.skipped_paragraphs > 0 && (
            <div className="text-xs text-neutral-500" data-testid="spelling-skipped">
              {tChrome('panel.spelling.skipped', { count: report.skipped_paragraphs })}
            </div>
          )}
          {report.truncated && (
            <div className="text-xs text-amber-400" data-testid="spelling-truncated">
              {tChrome('panel.spelling.truncated')}
            </div>
          )}
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="spelling-list">
          {groups.map((g) => (
            <button
              key={g.word}
              type="button"
              data-testid={`spelling-word-${g.word}`}
              className={`flex items-center justify-between px-2 py-1 text-xs rounded border ${
                selected === g.word
                  ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                  : 'border-neutral-800 text-neutral-300'
              }`}
              onClick={() => void selectWord(g.word)}
            >
              <span>{g.word}</span>
              <span className="text-neutral-500">{g.count}</span>
            </button>
          ))}
        </div>
      )}

      {selected !== null && (
        <div className="flex flex-col gap-2" data-testid="spelling-detail">
          <div className="text-xs text-neutral-500" data-testid="spelling-context">
            {selectedIssues[selectedIssues.length - 1]?.context ?? ''}
          </div>
          <div className="flex flex-col gap-1" data-testid="spelling-suggestions">
            {suggestions.length === 0 ? (
              <div className="text-xs text-neutral-500">
                {tChrome('panel.spelling.noSuggestions')}
              </div>
            ) : (
              suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-testid={`spelling-suggestion-${s}`}
                  className={`px-2 py-1 text-xs text-start rounded border ${
                    replacement === s
                      ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                      : 'border-neutral-800 text-neutral-300'
                  }`}
                  onClick={() => setReplacement(s)}
                >
                  {s}
                </button>
              ))
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-500">
            {tChrome('panel.spelling.replaceWith')}
            <input
              type="text"
              data-testid="spelling-replacement"
              className="flex-1 px-1 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-neutral-200"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              data-testid="spelling-change"
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-neutral-100 disabled:opacity-60"
              disabled={busy || !replacement.trim() || selectedIssues.length === 0}
              onClick={() => void runFix(selectedIssues.slice(-1), selected)}
            >
              {tChrome('panel.spelling.change')}
            </button>
            <button
              type="button"
              data-testid="spelling-change-all"
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-neutral-100 disabled:opacity-60"
              disabled={busy || !replacement.trim() || selectedIssues.length === 0}
              onClick={() => void runFix(selectedIssues, selected)}
            >
              {tChrome('panel.spelling.changeAll', { count: selectedIssues.length })}
            </button>
            <button
              type="button"
              data-testid="spelling-ignore"
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-neutral-300"
              onClick={() => {
                setIgnored((prev) => [...prev, selected]);
                setSelected(null);
              }}
            >
              {tChrome('panel.spelling.ignore')}
            </button>
            <button
              type="button"
              data-testid="spelling-add-word"
              className="px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-neutral-300"
              onClick={() => addToDictionary(selected)}
            >
              {tChrome('panel.spelling.addWord')}
            </button>
          </div>
        </div>
      )}

      {custom.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="spelling-custom">
          <div className="text-xs text-neutral-500">
            {tChrome('panel.spelling.customWords', { count: custom.length })}
          </div>
          <div className="flex flex-wrap gap-1">
            {custom.map((w) => (
              <button
                key={w}
                type="button"
                data-testid={`spelling-custom-${w}`}
                title={tChrome('panel.spelling.removeWord', { word: w })}
                className="px-2 py-0.5 text-xs bg-neutral-900 border border-neutral-800 rounded text-neutral-300"
                onClick={() => {
                  const next = removeCustomWord(custom, w);
                  setCustom(next);
                  saveCustomWords(next);
                }}
              >
                {w} ×
              </button>
            ))}
          </div>
        </div>
      )}

      {status && (
        <div className="text-xs text-neutral-400" data-testid="spelling-status">
          {status}
        </div>
      )}
    </div>
  );
}
