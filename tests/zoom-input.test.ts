import { describe, expect, it } from 'vitest';
import {
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
  parseZoomPercentInput,
} from '../src/renderer/lib/zoom-input';

describe('parseZoomPercentInput', () => {
  it('reads a bare number and the percent sign in either position', () => {
    expect(parseZoomPercentInput('125', 'en')).toBe(125);
    expect(parseZoomPercentInput('125%', 'en')).toBe(125);
    expect(parseZoomPercentInput('125 %', 'en')).toBe(125);
    expect(parseZoomPercentInput('  125  ', 'en')).toBe(125);
    expect(parseZoomPercentInput('%125', 'tr')).toBe(125);
    expect(parseZoomPercentInput('125 %', 'fr')).toBe(125);
    expect(parseZoomPercentInput('125 %', 'fr')).toBe(125);
  });

  it('reads what the box itself shows, for every shipped locale', () => {
    const locales = [
      'ar', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hu', 'it', 'ja',
      'ko', 'nb', 'nl', 'pl', 'pt-BR', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'zh-CN',
      'zh-TW', 'ar-EG', 'fa',
    ];
    for (const locale of locales) {
      for (const percent of [1, 50, 125, 1250, 6400]) {
        const shown = new Intl.NumberFormat(locale, { style: 'percent' }).format(percent / 100);
        expect(parseZoomPercentInput(shown, locale), `${locale} ${shown}`).toBe(percent);
      }
    }
  });

  it('reads the locale digits', () => {
    expect(parseZoomPercentInput('١٢٥٪', 'ar-EG')).toBe(125);
    expect(parseZoomPercentInput('۱۲۵', 'fa')).toBe(125);
    expect(parseZoomPercentInput('१२५', 'hi')).toBe(125);
    expect(parseZoomPercentInput('１２５％', 'ja')).toBe(125);
  });

  it('reads the locale decimal separator', () => {
    expect(parseZoomPercentInput('12.5', 'en')).toBe(12.5);
    expect(parseZoomPercentInput('12,5', 'de')).toBe(12.5);
    expect(parseZoomPercentInput('12,5 %', 'fr')).toBe(12.5);
    expect(parseZoomPercentInput('١٢٫٥', 'ar-EG')).toBe(12.5);
    expect(parseZoomPercentInput('.5', 'en')).toBe(ZOOM_PERCENT_MIN);
    expect(parseZoomPercentInput('2.', 'en')).toBe(2);
  });

  it('reads a full stop as the decimal separator where the locale does not group with it', () => {
    expect(parseZoomPercentInput('12.5', 'fr')).toBe(12.5);
    expect(parseZoomPercentInput('12.5', 'ru')).toBe(12.5);
  });

  it('drops the locale group separator', () => {
    expect(parseZoomPercentInput('1,250%', 'en')).toBe(1250);
    expect(parseZoomPercentInput('1.250', 'de')).toBe(1250);
    expect(parseZoomPercentInput('1 250 %', 'fr')).toBe(1250);
  });

  it('clamps to the zoom range', () => {
    expect(parseZoomPercentInput('0', 'en')).toBe(ZOOM_PERCENT_MIN);
    expect(parseZoomPercentInput('0.25', 'en')).toBe(ZOOM_PERCENT_MIN);
    expect(parseZoomPercentInput('6400', 'en')).toBe(ZOOM_PERCENT_MAX);
    expect(parseZoomPercentInput('99999', 'en')).toBe(ZOOM_PERCENT_MAX);
    expect(parseZoomPercentInput('9'.repeat(400), 'en')).toBe(ZOOM_PERCENT_MAX);
    expect(parseZoomPercentInput('0.' + '0'.repeat(400) + '1', 'en')).toBe(ZOOM_PERCENT_MIN);
  });

  it('refuses entries that are not a number', () => {
    for (const text of ['', ' ', '%', 'abc', '12a', '-50', '+50', '1.2.3', '1e3', '12 5x', 'Infinity', 'NaN']) {
      expect(parseZoomPercentInput(text, 'en'), JSON.stringify(text)).toBeNull();
    }
  });

  it('falls back to English separators for a tag Intl refuses', () => {
    expect(parseZoomPercentInput('12.5%', 'qps-rtl')).toBe(12.5);
  });
});
