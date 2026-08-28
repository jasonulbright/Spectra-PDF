// The Read Out Loud transport. Floating over the canvas on the FindBar's own
// z-layer and idiom, bottom-centred so it never covers the top of the page it
// is reading.
//
// Voice and rate live HERE rather than in Preferences because they are
// adjusted while listening: a rate you cannot change without leaving the
// document is a rate you do not change.
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { READ_ALOUD_RATES } from '../../lib/read-aloud';
import { TOOL_DEFS } from '../../commands/tools';
import type { ReadAloudApi } from '../../hooks/useReadAloud';
import { tChrome, tNumber, tToolTitle } from '../../i18n';
import { ChromeIcon } from '../chrome-icons';

// The English fallback tToolTitle needs, taken from the tool table itself so
// the two can never name the tool differently.
const OCR_TOOL_TITLE = TOOL_DEFS.find((t) => t.id === 'ocr')?.title ?? '';

// The four transport controls draw from the app's own icon set rather than
// from the transport CHARACTERS. ⏮ and ⏭ carry an emoji presentation, and the
// platform resolved them to its colour-emoji face: two of four peer buttons
// rendered as white glyphs on a blue rounded plate, which reads as a
// permanently active state, while ⏸/⏹ resolved to the monochrome face.
// Equal-sized icon buttons also make the four read as one group.
const BUTTON =
  'inline-flex items-center justify-center w-7 h-6 bg-neutral-700 hover:bg-neutral-600 disabled:opacity-60 rounded';

export function ReadAloudBar({ reader }: { reader: ReadAloudApi }): React.ReactElement {
  useTranslation();
  const barRef = useRef<HTMLDivElement>(null);

  // The BAR takes focus when it opens, not its first button: the transport
  // controls are disabled while the pages are being listed, and a disabled
  // button cannot take focus — Escape would then go to the document and the
  // bar would be unclosable by keyboard for exactly as long as it was busy.
  // Focusing the container keeps the key handler below live in every state,
  // and the buttons keep their own places in the tab ring.
  useEffect(() => {
    barRef.current?.focus();
  }, []);

  const speaking = reader.status === 'speaking';
  const busy = reader.status === 'loading';
  const failed = reader.status === 'error';

  return (
    <div
      ref={barRef}
      data-testid="read-aloud-bar"
      role="group"
      tabIndex={-1}
      aria-label={tChrome('canvas.readAloud.barLabel')}
      className="absolute bottom-6 start-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-2 bg-neutral-800/95 border border-neutral-700 rounded-lg shadow-xl"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          reader.stop();
        }
      }}
    >
      <button
        data-testid="read-aloud-playpause"
        className={BUTTON}
        // Nothing to pause or resume until a run is actually speaking:
        // enabling it while the pages are still being listed would let a press
        // claim a state the synthesizer is not in.
        disabled={failed || busy}
        aria-label={tChrome(speaking ? 'canvas.readAloud.pause' : 'canvas.readAloud.resume')}
        title={tChrome(speaking ? 'canvas.readAloud.pause' : 'canvas.readAloud.resume')}
        onClick={() => (speaking ? reader.pause() : reader.resume())}
      >
        <ChromeIcon icon={speaking ? 'pause' : 'play'} size={13} />
      </button>
      <button
        data-testid="read-aloud-prev"
        className={BUTTON}
        disabled={failed || busy}
        aria-label={tChrome('canvas.readAloud.previous')}
        title={tChrome('canvas.readAloud.previous')}
        onClick={reader.previous}
      >
        <ChromeIcon icon="previous" size={13} />
      </button>
      <button
        data-testid="read-aloud-next"
        className={BUTTON}
        disabled={failed || busy}
        aria-label={tChrome('canvas.readAloud.next')}
        title={tChrome('canvas.readAloud.next')}
        onClick={reader.next}
      >
        <ChromeIcon icon="next" size={13} />
      </button>
      <button
        data-testid="read-aloud-stop"
        className={BUTTON}
        aria-label={tChrome('canvas.readAloud.stop')}
        title={tChrome('canvas.readAloud.stop')}
        onClick={reader.stop}
      >
        <ChromeIcon icon="stop" size={13} />
      </button>

      <span
        data-testid="read-aloud-status"
        className={`text-xs whitespace-nowrap ${failed ? 'text-red-400' : 'text-neutral-400'}`}
        aria-live="polite"
      >
        {failed && reader.errorKey
          ? tChrome(reader.errorKey as Parameters<typeof tChrome>[0], {
              tool: tToolTitle('ocr', OCR_TOOL_TITLE),
            })
          : busy
            ? tChrome('canvas.readAloud.preparing')
            : reader.pageNumber !== null
              ? tChrome(
                  reader.order === 'structure'
                    ? 'canvas.readAloud.onPageTagged'
                    : 'canvas.readAloud.onPage',
                  { page: tNumber(reader.pageNumber) },
                )
              : ''}
      </span>

      <label className="flex items-center gap-1 text-xs text-neutral-400">
        <span>{tChrome('canvas.readAloud.voice')}</span>
        <select
          data-testid="read-aloud-voice"
          className="px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-xs max-w-44"
          value={reader.voice}
          onChange={(e) => reader.setVoice(e.target.value)}
        >
          <option value="">{tChrome('canvas.readAloud.voiceDefault')}</option>
          {reader.voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-xs text-neutral-400">
        <span>{tChrome('canvas.readAloud.rate')}</span>
        <select
          data-testid="read-aloud-rate"
          className="px-1.5 py-0.5 bg-neutral-900 border border-neutral-700 rounded text-xs"
          value={String(reader.rate)}
          onChange={(e) => reader.setRate(Number(e.target.value))}
        >
          {READ_ALOUD_RATES.map((value) => (
            <option key={value} value={String(value)}>
              {tChrome('canvas.readAloud.rateValue', { rate: tNumber(value) })}
            </option>
          ))}
        </select>
      </label>

      <button
        data-testid="read-aloud-close"
        className="px-1.5 py-0.5 text-xs text-neutral-400 hover:text-neutral-200"
        aria-label={tChrome('canvas.readAloud.close')}
        title={tChrome('canvas.readAloud.close')}
        onClick={reader.stop}
      >
        ×
      </button>
    </div>
  );
}
