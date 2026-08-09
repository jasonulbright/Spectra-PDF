// Read Out Loud: the synthesizer half.
//
// The reading MODEL — what to say, in what order, and which rectangles name a
// character range — is `lib/read-aloud.ts`, which has no speech API in it and
// is where vitest holds this feature. This hook is the part only a browser can
// run: voices, utterances, the transport, and the events that drive the
// highlight.
//
// Three facts measured against the built binary (WebView2 Edg/151), each of
// which the code below depends on:
//
//   1. `voiceschanged` fires MORE THAN ONCE and the FIRST one can carry an
//      empty list. The list is therefore re-read on every event for as long as
//      the hook lives and is never latched.
//   2. An utterance with NO voice assigned still speaks, on the platform
//      default. An empty voice list is not a refusal.
//   3. A 500-character utterance spoke for 29 seconds without truncation, so
//      nothing here chunks a long sentence.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PageGeometry } from '../lib/redaction';
import {
  fetchReadAloudPage,
  normalizeRate,
  pickVoice,
  rectsForRange,
  utterancesForPage,
  type NormRect,
  type ReadPage,
  type Utterance,
} from '../lib/read-aloud';

export type ReadAloudStatus = 'idle' | 'loading' | 'speaking' | 'paused' | 'error';
export type ReadAloudScope = 'page' | 'document';

/** One page the reader can reach, in the focused document's own order. */
export interface ReadAloudTarget {
  pageId: string;
  workingPath: string;
  /** 1-based position within that file's committed page order. */
  pageNumber: number;
}

export interface ReadAloudHighlight {
  pageId: string;
  block: NormRect | null;
  sentence: NormRect[];
  word: NormRect[];
}

export interface ReadAloudVoice {
  voiceURI: string;
  name: string;
  lang: string;
}

export interface ReadAloudApi {
  open: boolean;
  status: ReadAloudStatus;
  scope: ReadAloudScope;
  /** A refusal, as a catalog key — never an English string built here. */
  errorKey: string | null;
  /** Which reading order the page being read was listed in. */
  order: 'structure' | 'layout' | null;
  pageNumber: number | null;
  voices: readonly ReadAloudVoice[];
  voice: string;
  rate: number;
  highlight: ReadAloudHighlight | null;
  supported: boolean;
  start: (scope: ReadAloudScope) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  setVoice: (voiceURI: string) => void;
  setRate: (rate: number) => void;
}

interface Options {
  engineCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** The focused document's pages, in document order. Empty disables the
   * reader — there is nothing to read. */
  targets: readonly ReadAloudTarget[];
  geometryOf: (target: ReadAloudTarget) => Promise<PageGeometry>;
  /** 0-based index into `targets` of the page on screen. */
  currentIndex: number;
  /** The tag sentence segmentation and voice matching run under, resolved
   * when a run STARTS rather than held as a value: it depends on the
   * document's own `/Lang`, which costs a file read, and a reader nobody
   * opened must not make the app read every document it shows. */
  resolveLocale: () => Promise<string>;
  /** Bring a page into view as the reader reaches it. */
  onShowPage?: (pageId: string) => void;
  /** Persist a voice/rate the user chose in the bar. */
  onPersist?: (settings: { voice?: string; rate?: number }) => void;
  initialVoice: string;
  initialRate: number;
}

/** The synthesizer error values that are OURS — a cancel and the interruption
 * a cancel causes — and must never surface as a refusal. */
const SELF_INFLICTED = new Set(['interrupted', 'canceled', 'cancelled']);

const ERROR_KEYS: Record<string, string> = {
  'synthesis-unavailable': 'canvas.readAloud.errorUnavailable',
  'synthesis-failed': 'canvas.readAloud.errorFailed',
  'language-unavailable': 'canvas.readAloud.errorLanguage',
  'voice-unavailable': 'canvas.readAloud.errorVoice',
  'audio-busy': 'canvas.readAloud.errorBusy',
  'audio-hardware': 'canvas.readAloud.errorBusy',
};

interface Session {
  scope: ReadAloudScope;
  /** Index into `targets` this run started at. */
  from: number;
  /** Pages already listed, by index into `targets`. */
  pages: Map<number, ReadPage>;
  /** The flat utterance list, grown a page at a time. */
  queue: Utterance[];
  /** How far into `targets` the queue has been built. */
  built: number;
  cursor: number;
  /** Bumped on every stop/restart; a handler from an older token is stale. */
  token: number;
}

export function useReadAloud(options: Options): ReadAloudApi {
  const {
    engineCall,
    targets,
    geometryOf,
    currentIndex,
    resolveLocale,
    onShowPage,
    onPersist,
    initialVoice,
    initialRate,
  } = options;

  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window;

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ReadAloudStatus>('idle');
  const [scope, setScope] = useState<ReadAloudScope>('page');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [order, setOrder] = useState<'structure' | 'layout' | null>(null);
  const [pageNumber, setPageNumber] = useState<number | null>(null);
  const [voices, setVoices] = useState<readonly ReadAloudVoice[]>([]);
  const [voice, setVoiceState] = useState(initialVoice);
  const [rate, setRateState] = useState(() => normalizeRate(initialRate));
  const [highlight, setHighlight] = useState<ReadAloudHighlight | null>(null);

  const sessionRef = useRef<Session | null>(null);
  // Live copies for the speak loop, which runs from synthesizer callbacks and
  // would otherwise close over the values of the render that started it.
  const rateRef = useRef(rate);
  const voiceRef = useRef(voice);
  const localeRef = useRef('');
  const targetsRef = useRef(targets);
  rateRef.current = rate;
  voiceRef.current = voice;
  targetsRef.current = targets;

  // Rule 1: re-read on EVERY notification, never latch the first.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const read = () => {
      setVoices(
        synth.getVoices().map((v) => ({
          voiceURI: v.voiceURI,
          name: v.name,
          lang: v.lang,
        })),
      );
    };
    read();
    synth.addEventListener('voiceschanged', read);
    return () => synth.removeEventListener('voiceschanged', read);
  }, [supported]);

  const clearSpeech = useCallback(() => {
    if (!supported) return;
    const session = sessionRef.current;
    if (session) session.token += 1;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* A synthesizer that cannot be cancelled is already not speaking. */
    }
  }, [supported]);

  const stop = useCallback(() => {
    clearSpeech();
    sessionRef.current = null;
    setStatus('idle');
    setHighlight(null);
    setOpen(false);
    setErrorKey(null);
    setOrder(null);
    setPageNumber(null);
  }, [clearSpeech]);

  // The reader is transient view state bound to bytes: it stops when the set
  // of pages under it changes identity, which is what a commit, an undo or an
  // operation does. A highlight over blocks that no longer exist must never
  // be drawn.
  useEffect(() => {
    stop();
    // `targets` is rebuilt whenever the focused document's page list changes.
  }, [targets, stop]);

  useEffect(() => () => clearSpeech(), [clearSpeech]);

  const paint = useCallback((session: Session, charIndex: number, charLength: number) => {
    const utterance = session.queue[session.cursor];
    if (!utterance) return;
    const page = session.pages.get(utterance.pageIndex);
    const block = page?.blocks[utterance.blockIndex];
    const target = targetsRef.current[utterance.pageIndex];
    if (!page || !block || !target) return;
    const word =
      charLength > 0
        ? rectsForRange(
            block,
            utterance.start + charIndex,
            utterance.start + charIndex + charLength,
          )
        : [];
    setHighlight({
      pageId: target.pageId,
      block: block.rect,
      sentence: rectsForRange(block, utterance.start, utterance.end),
      word,
    });
  }, []);

  // The loop is mutually recursive — a sentence ending advances, advancing
  // speaks — so the two halves reach each other through refs rather than
  // through a closure over a not-yet-declared binding.
  const advanceRef = useRef<(session: Session) => Promise<void>>(async () => {});

  const speak = useCallback(
    (session: Session) => {
      const utterance = session.queue[session.cursor];
      if (!utterance) {
        stop();
        return;
      }
      const target = targetsRef.current[utterance.pageIndex];
      if (target && onShowPage) onShowPage(target.pageId);
      const page = session.pages.get(utterance.pageIndex);
      if (page) {
        setOrder(page.order);
        setPageNumber(target ? target.pageNumber : null);
      }
      paint(session, 0, 0);
      const token = session.token;
      const spoken = new SpeechSynthesisUtterance(utterance.text);
      spoken.rate = rateRef.current;
      const chosen = pickVoice(voices, localeRef.current, voiceRef.current);
      const match = window.speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === chosen);
      if (match) spoken.voice = match;
      // The language rides the utterance even when no voice was matched: it is
      // what a platform-default voice uses to choose its pronunciation. An
      // empty tag is not a language and is never assigned — the synthesizer's
      // own default is the honest answer there.
      if (localeRef.current) spoken.lang = localeRef.current;
      spoken.onboundary = (event) => {
        if (session.token !== token) return;
        const length =
          typeof event.charLength === 'number' && event.charLength > 0
            ? event.charLength
            : wordLengthAt(utterance.text, event.charIndex);
        paint(session, event.charIndex, length);
      };
      spoken.onend = () => {
        if (session.token !== token) return;
        session.cursor += 1;
        void advanceRef.current(session);
      };
      spoken.onerror = (event) => {
        if (session.token !== token) return;
        const reason = String((event as SpeechSynthesisErrorEvent).error ?? '');
        if (SELF_INFLICTED.has(reason)) return;
        setErrorKey(ERROR_KEYS[reason] ?? 'canvas.readAloud.errorFailed');
        setStatus('error');
        setHighlight(null);
      };
      setStatus('speaking');
      window.speechSynthesis.speak(spoken);
    },
    [paint, stop, voices, onShowPage],
  );

  const speakRef = useRef(speak);
  speakRef.current = speak;

  /** Fill the queue up to and including page `index`, listing pages as it
   * goes. A page with no readable text is SKIPPED and counted, never treated
   * as the end of the document. */
  const build = useCallback(
    async (session: Session, index: number): Promise<void> => {
      const list = targetsRef.current;
      while (session.built <= index && session.built < list.length) {
        const at = session.built;
        const target = list[at];
        try {
          const geometry = await geometryOf(target);
          const page = await fetchReadAloudPage(
            engineCall,
            target.workingPath,
            target.pageNumber,
            geometry,
          );
          session.pages.set(at, page);
          session.queue.push(...utterancesForPage(page, at, localeRef.current));
        } catch {
          // A page that cannot be listed is a page with nothing to say. The
          // run continues; refusing the whole document because one page is
          // unreadable would be worse than reading the rest of it.
          session.pages.set(at, {
            page: target.pageNumber,
            order: 'layout',
            reason: 'unreadable',
            artifacts: 0,
            blocks: [],
          });
        }
        session.built = at + 1;
      }
    },
    [engineCall, geometryOf],
  );

  const advance = useCallback(
    async (session: Session): Promise<void> => {
      if (sessionRef.current !== session) return;
      const list = targetsRef.current;
      const last = session.scope === 'page' ? session.from : list.length - 1;
      while (session.cursor >= session.queue.length) {
        if (session.built > last) {
          stop();
          return;
        }
        setStatus('loading');
        await build(session, session.built);
        if (sessionRef.current !== session) return;
      }
      speakRef.current(session);
    },
    [build, stop],
  );

  advanceRef.current = advance;

  const start = useCallback(
    (nextScope: ReadAloudScope) => {
      if (!supported) {
        setOpen(true);
        setStatus('error');
        setErrorKey('canvas.readAloud.errorUnsupported');
        return;
      }
      if (targetsRef.current.length === 0) return;
      clearSpeech();
      const from = Math.min(
        Math.max(currentIndex, 0),
        targetsRef.current.length - 1,
      );
      const session: Session = {
        scope: nextScope,
        from,
        pages: new Map(),
        queue: [],
        built: from,
        cursor: 0,
        token: 0,
      };
      sessionRef.current = session;
      setScope(nextScope);
      setOpen(true);
      setErrorKey(null);
      setStatus('loading');
      void (async () => {
        const last = nextScope === 'page' ? from : targetsRef.current.length - 1;
        try {
          localeRef.current = await resolveLocale();
        } catch {
          localeRef.current = '';
        }
        if (sessionRef.current !== session) return;
        await build(session, from);
        if (sessionRef.current !== session) return;
        while (session.queue.length === 0 && session.built <= last) {
          await build(session, session.built);
          if (sessionRef.current !== session) return;
        }
        if (session.queue.length === 0) {
          setStatus('error');
          setErrorKey('canvas.readAloud.errorNoText');
          return;
        }
        speakRef.current(session);
      })();
    },
    [supported, clearSpeech, currentIndex, build, resolveLocale],
  );

  const pause = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.pause();
    setStatus('paused');
  }, [supported]);

  const resume = useCallback(() => {
    if (!supported) return;
    window.speechSynthesis.resume();
    setStatus('speaking');
  }, [supported]);

  /** Move the cursor by `delta` sentences and speak from there. A cancel is
   * required first — the synthesizer queues, and speaking without one would
   * play the new sentence AFTER the current one finished. */
  const step = useCallback(
    (delta: number) => {
      const session = sessionRef.current;
      if (!session) return;
      const at = session.cursor + delta;
      if (at < 0) return;
      clearSpeech();
      session.cursor = at;
      void advanceRef.current(session);
    },
    [clearSpeech],
  );

  const setVoice = useCallback(
    (voiceURI: string) => {
      setVoiceState(voiceURI);
      onPersist?.({ voice: voiceURI });
      // A voice change takes effect on the NEXT sentence: the Web Speech API
      // has no way to re-voice an utterance already being spoken, and
      // restarting the sentence would repeat words the listener just heard.
    },
    [onPersist],
  );

  const setRate = useCallback(
    (next: number) => {
      const clamped = normalizeRate(next);
      setRateState(clamped);
      onPersist?.({ rate: clamped });
    },
    [onPersist],
  );

  return useMemo(
    () => ({
      open,
      status,
      scope,
      errorKey,
      order,
      pageNumber,
      voices,
      voice,
      rate,
      highlight,
      supported,
      start,
      pause,
      resume,
      stop,
      next: () => step(1),
      previous: () => step(-1),
      setVoice,
      setRate,
    }),
    [
      open,
      status,
      scope,
      errorKey,
      order,
      pageNumber,
      voices,
      voice,
      rate,
      highlight,
      supported,
      start,
      pause,
      resume,
      stop,
      step,
      setVoice,
      setRate,
    ],
  );
}

/** How many characters the word beginning at `at` runs for. Used only when the
 * synthesizer reports a boundary with no length — the shipping webview reports
 * one, and a build that does not must still highlight something exact. */
function wordLengthAt(text: string, at: number): number {
  if (at < 0 || at >= text.length) return 0;
  let end = at;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return end - at;
}
