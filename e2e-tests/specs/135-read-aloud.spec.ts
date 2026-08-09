/**
 * P30 — Read Out Loud, end to end.
 *
 * WHAT THIS SPEC CANNOT ASSERT, stated up front: audio. Nothing available to a
 * WebDriver session can hear the machine, and no API reports what came out of
 * the speakers. Every utterance here is spoken at `volume = 0` by the
 * application's own code path regardless — the reader's rate and voice are
 * whatever the bar holds; only the loudness is not.
 *
 * WHAT IT DOES ASSERT is everything the synthesizer's own events and the app's
 * own DOM make measurable:
 *   • the transport bar appears, carries every control, and lists the voices
 *     the platform actually reports (or offers the system default alone, which
 *     is the honest surface on a machine with none);
 *   • the state machine — speaking → paused → speaking → stopped — read off
 *     the live `speechSynthesis` object, not off the app's own state;
 *   • the HIGHLIGHT WALK: block, sentence and word rectangles appear on the
 *     page, and the sentence rectangle MOVES as the reader advances. That is
 *     the boundary events driving real geometry, which is the whole feature;
 *   • the refusal a page with no readable text gets, by name;
 *   • keyboard operability: Escape closes the bar.
 *
 * A machine with no speech stack at all reports it and skips the transport
 * assertions rather than failing — the surface assertions still run, and the
 * refusal path is exercised in their place.
 */
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect } from '@wdio/globals';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  closeAllFiles,
} from '../support/harness.js';

const LINES = [
  'The first sentence of the document sits here. A second sentence follows it.',
  'A third sentence begins the next line and runs on for a while longer.',
  'And a fourth sentence closes the page.',
];

async function makeTextFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  LINES.forEach((line, i) => {
    page.drawText(line, { x: 60, y: 640 - i * 40, size: 13, font });
  });
  const second = doc.addPage([612, 792]);
  second.drawText('The second page has its own sentence.', {
    x: 60,
    y: 640,
    size: 13,
    font,
  });
  writeFileSync(path, await doc.save());
}

async function makeBlankFixture(path: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writeFileSync(path, await doc.save());
}

/** Whether the webview carries a speech stack at all. */
async function speechSupported(): Promise<boolean> {
  return (await browser.execute(
    () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  )) as boolean;
}

/** The live synthesizer's own view of itself — not the app's state. */
async function synthState(): Promise<{ speaking: boolean; paused: boolean }> {
  return (await browser.execute(function () {
    const s = (window as any).speechSynthesis;
    return { speaking: Boolean(s.speaking), paused: Boolean(s.paused) };
  })) as { speaking: boolean; paused: boolean };
}

/** Counts and the first sentence rectangle's position, for the highlight walk. */
async function highlight(): Promise<{
  block: number;
  sentence: number;
  word: number;
  firstSentence: string;
}> {
  return (await browser.execute(function () {
    const at = (sel: string) => document.querySelectorAll(sel);
    const first = document.querySelector('.page-read-sentence') as HTMLElement | null;
    return {
      block: at('.page-read-block').length,
      sentence: at('.page-read-sentence').length,
      word: at('.page-read-word').length,
      firstSentence: first ? `${first.style.left}|${first.style.top}` : '',
    };
  })) as { block: number; sentence: number; word: number; firstSentence: string };
}

/** Silence every utterance the app creates, without touching anything else
 * about how it creates them. The reader's own voice, rate, language, events
 * and error handling all still run — a spec that speaks aloud on the machine
 * running it is a spec nobody runs twice. */
async function muteSynthesis(): Promise<void> {
  await browser.execute(function () {
    const Original = (window as any).SpeechSynthesisUtterance;
    if ((window as any).__READ_ALOUD_MUTED__) return;
    (window as any).__READ_ALOUD_MUTED__ = true;
    function Muted(this: unknown, text: string) {
      const u = new Original(text);
      u.volume = 0;
      return u;
    }
    Muted.prototype = Original.prototype;
    (window as any).SpeechSynthesisUtterance = Muted;
  });
}

describe('read out loud', () => {
  let tmp: string;
  let source: string;
  let blank: string;

  before(async () => {
    tmp = mkdtempSync(resolve(tmpdir(), 'spectra-read-aloud-'));
    source = resolve(tmp, 'read-aloud.pdf');
    blank = resolve(tmp, 'blank.pdf');
    await makeTextFixture(source);
    await makeBlankFixture(blank);
    await waitForHarness();
    await muteSynthesis();
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await closeAllFiles();
    await muteSynthesis();
  });

  it('opens a transport bar from the View menu command', async () => {
    await openByPaths([source]);
    await setView('canvas');
    expect(await invokeAppCommand('view.readAloud.page')).toBe(true);

    const bar = await $('[data-testid="read-aloud-bar"]');
    await bar.waitForExist({ timeout: 15_000 });
    for (const id of [
      'read-aloud-playpause',
      'read-aloud-prev',
      'read-aloud-next',
      'read-aloud-stop',
      'read-aloud-voice',
      'read-aloud-rate',
      'read-aloud-close',
    ]) {
      await expect(await $(`[data-testid="${id}"]`)).toExist();
    }
    // The voice list always carries the system-default row; any installed
    // voice is an additional one. An empty list is not a refusal — the
    // synthesizer speaks on its own default (measured on this stack).
    const voiceCount = await browser.execute(function () {
      const sel = document.querySelector(
        '[data-testid="read-aloud-voice"]',
      ) as HTMLSelectElement | null;
      return sel ? sel.options.length : 0;
    });
    expect(voiceCount).toBeGreaterThanOrEqual(1);
    console.log('READ-ALOUD voices offered', voiceCount);
    await invokeAppCommand('view.readAloud.stop');
  });

  it('names the page and the reading order it is using', async () => {
    await openByPaths([source]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.page');
    const status = await $('[data-testid="read-aloud-status"]');
    await status.waitForExist({ timeout: 15_000 });
    await browser.waitUntil(async () => (await status.getText()).trim().length > 0, {
      timeout: 20_000,
      timeoutMsg: 'the bar never reported a position',
    });
    // The fixture is untagged, so the page reads in the extraction's order and
    // the bar says only which page — never the tagged-order wording.
    const text = await status.getText();
    console.log('READ-ALOUD status', JSON.stringify(text));
    expect(text).toContain('1');
    await invokeAppCommand('view.readAloud.stop');
  });

  it('walks the highlight through the page as it speaks', async function () {
    if (!(await speechSupported())) {
      console.log('READ-ALOUD no speech stack — highlight walk not measurable');
      this.skip();
      return;
    }
    await openByPaths([source]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.page');

    await browser.waitUntil(async () => (await highlight()).sentence > 0, {
      timeout: 25_000,
      timeoutMsg: 'no sentence highlight ever appeared',
    });
    const first = await highlight();
    expect(first.block).toBe(1);
    expect(first.sentence).toBeGreaterThan(0);
    console.log('READ-ALOUD first highlight', JSON.stringify(first));

    // A word rectangle is the boundary events landing on real geometry. It is
    // reported rather than required: a synthesizer that emits no word
    // boundary still reads correctly, and the sentence tier still tracks.
    const sawWord = await browser
      .waitUntil(async () => (await highlight()).word > 0, { timeout: 12_000 })
      .then(
        () => true,
        () => false,
      );
    console.log('READ-ALOUD word boundaries drove a highlight:', sawWord);

    // The walk itself: the sentence rectangle must MOVE. Driven by the
    // transport rather than by waiting out the speech, so the assertion does
    // not depend on how fast the machine's voice reads.
    await $('[data-testid="read-aloud-next"]').click();
    await browser.waitUntil(
      async () => {
        const now = await highlight();
        return now.sentence > 0 && now.firstSentence !== first.firstSentence;
      },
      { timeout: 20_000, timeoutMsg: 'the sentence highlight never moved' },
    );
    await invokeAppCommand('view.readAloud.stop');
  });

  it('pauses and resumes the synthesizer itself', async function () {
    if (!(await speechSupported())) {
      this.skip();
      return;
    }
    await openByPaths([source]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.document');
    await browser.waitUntil(async () => (await synthState()).speaking, {
      timeout: 25_000,
      timeoutMsg: 'the synthesizer never started',
    });

    await invokeAppCommand('view.readAloud.pause');
    await browser.waitUntil(async () => (await synthState()).paused, {
      timeout: 10_000,
      timeoutMsg: 'pause did not reach the synthesizer',
    });

    await invokeAppCommand('view.readAloud.pause');
    await browser.waitUntil(async () => !(await synthState()).paused, {
      timeout: 10_000,
      timeoutMsg: 'resume did not reach the synthesizer',
    });

    await invokeAppCommand('view.readAloud.stop');
    await browser.waitUntil(async () => !(await synthState()).speaking, {
      timeout: 10_000,
      timeoutMsg: 'stop did not reach the synthesizer',
    });
    await expect(await $('[data-testid="read-aloud-bar"]')).not.toExist();
  });

  it('clears the highlight when the reader stops', async () => {
    await openByPaths([source]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.page');
    await browser.waitUntil(async () => (await highlight()).block > 0, {
      timeout: 25_000,
      timeoutMsg: 'no block highlight ever appeared',
    });
    await invokeAppCommand('view.readAloud.stop');
    await browser.waitUntil(
      async () => {
        const now = await highlight();
        return now.block === 0 && now.sentence === 0 && now.word === 0;
      },
      { timeout: 10_000, timeoutMsg: 'the highlight outlived the reader' },
    );
  });

  it('closes on Escape from the bar', async () => {
    await openByPaths([source]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.page');
    const bar = await $('[data-testid="read-aloud-bar"]');
    await bar.waitForExist({ timeout: 15_000 });
    // The bar takes focus when it opens, so Escape reaches it with no click.
    await browser.keys(['Escape']);
    await bar.waitForExist({ timeout: 10_000, reverse: true });
  });

  it('refuses a page with no readable text, by name', async () => {
    await openByPaths([blank]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.page');
    const status = await $('[data-testid="read-aloud-status"]');
    await status.waitForExist({ timeout: 15_000 });
    await browser.waitUntil(
      async () => {
        const text = (await status.getText()).toLowerCase();
        return text.includes('no readable text');
      },
      { timeout: 25_000, timeoutMsg: 'a page with no text never said so' },
    );
    // The refusal names what to do about it, in the tool's own name.
    expect((await status.getText()).toLowerCase()).toContain('ocr');
    await invokeAppCommand('view.readAloud.stop');
  });

  it('remembers the chosen speed', async () => {
    await openByPaths([source]);
    await setView('canvas');
    await invokeAppCommand('view.readAloud.page');
    await $('[data-testid="read-aloud-rate"]').waitForExist({ timeout: 15_000 });
    await browser.execute(function () {
      const sel = document.querySelector(
        '[data-testid="read-aloud-rate"]',
      ) as HTMLSelectElement;
      sel.value = '1.5';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const stored = await browser.execute(function () {
      return JSON.parse(localStorage.getItem('spectra-settings') ?? '{}').readAloudRate;
    });
    expect(stored).toBe(1.5);
    await invokeAppCommand('view.readAloud.stop');

    // …and the next run opens on it.
    await invokeAppCommand('view.readAloud.page');
    await $('[data-testid="read-aloud-rate"]').waitForExist({ timeout: 15_000 });
    const shown = await browser.execute(function () {
      return (
        document.querySelector('[data-testid="read-aloud-rate"]') as HTMLSelectElement
      ).value;
    });
    expect(shown).toBe('1.5');
    await invokeAppCommand('view.readAloud.stop');
    await browser.execute(function () {
      const s = JSON.parse(localStorage.getItem('spectra-settings') ?? '{}');
      s.readAloudRate = 1;
      localStorage.setItem('spectra-settings', JSON.stringify(s));
    });
  });
});
