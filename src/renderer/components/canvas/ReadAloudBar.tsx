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

// The English fallback tToolTitle needs, taken from the tool table itself so
// the two can never name the tool differently.
const OCR_TOOL_TITLE = TOOL_DEFS.find((t) => t.id === 'ocr')?.title ?? '';

const BUTTON =
  'px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 rounded';

export function ReadAloudBar({ reader }: { reader: ReadAloudApi }): React.ReactElement {
  useTranslation();
  const firstRef = useRef<HTMLButtonElement>(null);

  // The bar takes focus when it opens, so the transport is operable by keys
  // from the moment it exists (spec 96's contract) without the reader having
  // to hunt for it in the tab ring.
  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const speaking = reader.status === 'speaking';
  const busy = reader.status === 'loading';
  const failed = reader.status === 'error';

  return (
    <div
      data-testid="read-aloud-bar"
      role="group"
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
        ref={firstRef}
        data-testid="read-aloud-playpause"
        className={BUTTON}
        disabled={failed}
        aria-label={tChrome(speaking ? 'canvas.readAloud.pause' : 'canvas.readAloud.resume')}
        title={tChrome(speaking ? 'canvas.readAloud.pause' : 'canvas.readAloud.resume')}
        onClick={() => (speaking ? reader.pause() : reader.resume())}
      >
        {speaking ? '❚❚' : '▶'}
      </button>
      <button
        data-testid="read-aloud-prev"
        className={BUTTON}
        disabled={failed}
        aria-label={tChrome('canvas.readAloud.previous')}
        title={tChrome('canvas.readAloud.previous')}
        onClick={reader.previous}
      >
        ⏮
      </button>
      <button
        data-testid="read-aloud-next"
        className={BUTTON}
        disabled={failed}
        aria-label={tChrome('canvas.readAloud.next')}
        title={tChrome('canvas.readAloud.next')}
        onClick={reader.next}
      >
        ⏭
      </button>
      <button
        data-testid="read-aloud-stop"
        className={BUTTON}
        aria-label={tChrome('canvas.readAloud.stop')}
        title={tChrome('canvas.readAloud.stop')}
        onClick={reader.stop}
      >
        ■
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
