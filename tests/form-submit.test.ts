import { describe, expect, it } from 'vitest';
import {
  SUBMIT_CONTENT_TYPE,
  SUBMIT_EXTENSION,
  destinationRefusal,
  isPlainHttp,
  payloadPreview,
  responseRoute,
  statusAccepted,
  submitRequest,
} from '../src/renderer/lib/form-submit';
import { SUBMIT_FORMATS, type SubmitFormat } from '../src/renderer/lib/field-actions';

// The two decisions a submission makes: what is sent, and what is done with
// what comes back. Both are the security posture rather than plumbing, so both
// are pinned here rather than by clicking through the dialog.

describe('what gets sent', () => {
  it('gives every format a content type and an extension', () => {
    for (const format of SUBMIT_FORMATS) {
      expect(SUBMIT_CONTENT_TYPE[format]).toBeTruthy();
      expect(SUBMIT_EXTENSION[format].startsWith('.')).toBe(true);
    }
  });

  it('posts the built payload file under the format its own content type', () => {
    const request = submitRequest(
      { url: 'https://forms.example/submit', format: 'xfdf', method: 'post' },
      'C:/temp/spectrapdf/net/payload.xfdf',
      'invoice',
    );
    expect(request).toEqual({
      url: 'https://forms.example/submit',
      method: 'post',
      bodyPath: 'C:/temp/spectrapdf/net/payload.xfdf',
      contentType: 'application/vnd.adobe.xfdf',
      fileName: 'invoice',
      // A document-chosen destination always refuses a private target.
      refusePrivate: true,
    });
  });

  it('carries the action′s own method rather than assuming POST', () => {
    const request = submitRequest(
      { url: 'https://forms.example/q', format: 'html', method: 'get' },
      'C:/temp/p.txt',
      'q',
    );
    expect(request.method).toBe('get');
    expect(request.contentType).toBe('application/x-www-form-urlencoded');
  });

  it('names a plain-http destination as one, and only by its scheme', () => {
    expect(isPlainHttp('http://forms.example/submit')).toBe(true);
    expect(isPlainHttp('  HTTP://forms.example/submit')).toBe(true);
    expect(isPlainHttp('https://forms.example/submit')).toBe(false);
    // Not a scheme match, however the host is spelled.
    expect(isPlainHttp('https://http.example/submit')).toBe(false);
  });
});

describe('destinations with no transport', () => {
  it('refuses an empty address, a mailto and a non-web scheme by key', () => {
    expect(destinationRefusal('')).toBe('app.formButton.submitNoUrl');
    expect(destinationRefusal('   ')).toBe('app.formButton.submitNoUrl');
    expect(destinationRefusal('mailto:forms@example.test')).toBe(
      'app.formButton.submitMailto',
    );
    expect(destinationRefusal('MAILTO:forms@example.test')).toBe(
      'app.formButton.submitMailto',
    );
    expect(destinationRefusal('ftp://files.example/drop')).toBe(
      'app.formButton.submitNotWeb',
    );
    expect(destinationRefusal('javascript:alert(1)')).toBe('app.formButton.submitNotWeb');
    expect(destinationRefusal('/relative/submit')).toBe('app.formButton.submitNotWeb');
  });

  it('admits http and https', () => {
    expect(destinationRefusal('https://forms.example/submit')).toBeNull();
    expect(destinationRefusal('http://forms.example/submit')).toBeNull();
  });
});

describe('the payload preview', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('shows text formats as their exact bytes', () => {
    for (const format of ['fdf', 'xfdf', 'html'] as SubmitFormat[]) {
      const preview = payloadPreview(format, bytes('name=Ada&city=Lovelace'));
      expect(preview.kind).toBe('text');
      if (preview.kind !== 'text') throw new Error('unreachable');
      expect(preview.text).toBe('name=Ada&city=Lovelace');
      expect(preview.bytes).toBe(22);
    }
  });

  it('decodes non-ASCII rather than dropping it', () => {
    const preview = payloadPreview('fdf', bytes('/V (Åsa Ünal)'));
    if (preview.kind !== 'text') throw new Error('unreachable');
    expect(preview.text).toContain('Åsa Ünal');
  });

  it('summarizes a PDF submission instead of rendering it as text', () => {
    const preview = payloadPreview('pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0]));
    expect(preview).toEqual({ kind: 'document', bytes: 5 });
  });
});

describe('what comes back', () => {
  it('sends form data to the form-data import door', () => {
    expect(responseRoute('application/vnd.fdf')).toBe('formData');
    expect(responseRoute('application/vnd.adobe.xfdf')).toBe('formData');
    expect(responseRoute('application/xfdf+xml')).toBe('formData');
    // Parameters and casing are the server's business, not the routing's.
    expect(responseRoute('Application/VND.FDF; charset=UTF-8')).toBe('formData');
  });

  it('sends a PDF to the ordinary open funnel', () => {
    expect(responseRoute('application/pdf')).toBe('document');
    expect(responseRoute('application/pdf;charset=binary')).toBe('document');
  });

  it('sends HTML to the saved-file door, never to a renderer', () => {
    expect(responseRoute('text/html')).toBe('file');
    expect(responseRoute('text/html; charset=utf-8')).toBe('file');
    expect(responseRoute('application/xhtml+xml')).toBe('file');
  });

  it('sends an unknown or absent type to the door that interprets nothing', () => {
    expect(responseRoute('')).toBe('file');
    expect(responseRoute('application/octet-stream')).toBe('file');
    expect(responseRoute('text/plain')).toBe('file');
    expect(responseRoute('application/json')).toBe('file');
    // A type that merely CONTAINS a known one is not that type: routing is by
    // the media type, never by substring.
    expect(responseRoute('text/html+application/pdf')).toBe('file');
  });

  it('calls only a 2xx an acceptance', () => {
    for (const ok of [200, 201, 204, 299]) expect(statusAccepted(ok)).toBe(true);
    for (const no of [100, 301, 302, 400, 403, 404, 500, 503]) {
      expect(statusAccepted(no)).toBe(false);
    }
  });
});
