import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { expect } from '@wdio/globals';
import { closeAllFiles, invokeAppCommand, openByPaths, waitForHarness } from '../support/harness.js';

const XDP = '<x:xdp xmlns:x="http://ns.adobe.com/xdp/">';
const END = '</x:xdp>';
const template = (logic: boolean) => '<t:template xmlns:t="http://www.xfa.org/schema/xfa-template/3.3/">'
  + '<t:subform><t:field name="value">' + (logic ? '<t:calculate>1</t:calculate>' : '')
  + '</t:field></t:subform></t:template>';

describe('XFA facts reach the Forms and Health surfaces', () => {
  beforeEach(async () => { await waitForHarness(); await closeAllFiles(); });
  afterEach(async () => { await closeAllFiles(); });
  for (const shape of ['prefixed', 'utf16', 'split', 'no-logic', 'malformed'] as const) {
    it(`reports ${shape} in the live application`, async () => {
      const directory = mkdtempSync(resolve(__dirname, '../../xfa-facts.local.d-'));
      const path = resolve(directory, `${shape}.pdf`);
      const pdf = await PDFDocument.create(); const page = pdf.addPage([300, 400]);
      const form = pdf.getForm(), field = form.createTextField('value');
      field.setText('Unchanged'); field.addToPage(page, { x: 20, y: 20, width: 120, height: 25 });
      const stream = (bytes: Uint8Array) => pdf.context.register(pdf.context.flateStream(bytes));
      const utf8 = (value: string) => Buffer.from(value, 'utf8');
      if (shape === 'split') {
        form.acroForm.dict.set(PDFName.of('XFA'), pdf.context.obj([
          PDFString.of('x:xdp'), stream(utf8(XDP)),
          PDFString.of('template'), stream(utf8(template(true))),
          PDFString.of('/x:xdp'), stream(utf8(END)),
        ]));
      } else {
        const xml = shape === 'malformed' ? 'not XML' : XDP + template(shape !== 'no-logic') + END;
        const bytes = shape === 'utf16' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]) : utf8(xml);
        form.acroForm.dict.set(PDFName.of('XFA'), stream(bytes));
      }
      writeFileSync(path, await pdf.save({ updateFieldAppearances: false }));
      await openByPaths([path]);
      expect(await invokeAppCommand('tools.panel.forms')).toBe(true);
      await $('[data-testid="forms-xfa-static"]').waitForDisplayed({ timeout: 20000 });
      if (shape === 'malformed') {
        await $('[data-testid="forms-xfa-calculations-unknown"]').waitForDisplayed();
        expect(await $('[data-testid="forms-xfa-calculations"]').isExisting()).toBe(false);
      } else if (shape === 'no-logic') {
        expect(await $('[data-testid="forms-xfa-calculations"]').isExisting()).toBe(false);
        expect(await $('[data-testid="forms-xfa-calculations-unknown"]').isExisting()).toBe(false);
      } else {
        await $('[data-testid="forms-xfa-calculations"]').waitForDisplayed();
        expect(await $('[data-testid="forms-xfa-calculations-unknown"]').isExisting()).toBe(false);
      }
      if (shape === 'split') {
        // The fixture deliberately uses the standard, unembedded Helvetica.
        // Both readers must finish with the missing/substituted-font facts,
        // not an XFA refusal.
        const toggle = $('[data-testid="doc-health-toggle"]');
        await browser.waitUntil(async () => await toggle.getAttribute('data-verdict') === 'facts',
          { timeout: 40000, timeoutMsg: 'valid split XFA did not finish with the known font warning' });
        await toggle.click();
        const facts = await $$('.doc-health-fact');
        const messages: string[] = [];
        for (const fact of facts) messages.push(await fact.$('.doc-health-message').getText());
        // Keep the full observed list in any failure; do not hide an extra fact.
        expect(messages.sort()).toEqual([
          'This font is not embedded in the document, so a substitute face stands in for it.',
          'The viewer found no embedded program for this font and drew a substitute face.',
        ].sort());
        await toggle.click();
      }
    });
  }
});
