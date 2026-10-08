import { describe, it, expect } from 'vitest';
import {
  checkWebLink,
  followLabel,
  MAX_WEB_LINK_LENGTH,
  namedDestinationPage,
  planLinkFollow,
  resolveLinkedFile,
} from '../src/renderer/lib/link-follow';

const DOC_WIN = 'C:\\Users\\me\\Docs\\report.pdf';
const DOC_POSIX = '/home/me/docs/report.pdf';

describe('checkWebLink — the scheme gate', () => {
  it('offers http, https and mailto, exactly as written (only the ends trimmed)', () => {
    expect(checkWebLink('https://example.com/a?b=1&c=2#d')).toEqual({
      ok: true, url: 'https://example.com/a?b=1&c=2#d', scheme: 'https',
    });
    expect(checkWebLink('  http://example.com  ')).toEqual({ ok: true, url: 'http://example.com', scheme: 'http' });
    expect(checkWebLink('mailto:someone@example.com')).toEqual({
      ok: true, url: 'mailto:someone@example.com', scheme: 'mailto',
    });
    expect(checkWebLink('HTTPS://EXAMPLE.COM')).toMatchObject({ ok: true, scheme: 'https' });
  });

  it('refuses every other scheme, and names it', () => {
    for (const [url, scheme] of [
      ['javascript:alert(1)', 'javascript'],
      ['JavaScript:alert(1)', 'javascript'],
      ['file:///C:/Windows/System32/calc.exe', 'file'],
      ['data:text/html,<script>1</script>', 'data'],
      ['ms-settings:privacy', 'ms-settings'],
      ['ftp://example.com/x', 'ftp'],
      ['smb://host/share', 'smb'],
      ['vbscript:x', 'vbscript'],
    ] as const) {
      expect(checkWebLink(url), url).toEqual({ ok: false, url, reason: 'scheme', scheme });
    }
  });

  it('refuses an address with no scheme rather than guessing one', () => {
    expect(checkWebLink('www.example.com')).toEqual({
      ok: false, url: 'www.example.com', reason: 'scheme', scheme: null,
    });
    expect(checkWebLink('/relative/path')).toMatchObject({ ok: false, reason: 'scheme', scheme: null });
  });

  it('refuses an address whose shown form would differ from the one used', () => {
    expect(checkWebLink('')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://example.com\n\n.evil.example')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://exa mple.com')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://example.com/\u202Egpj.exe')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://bank.example@evil.example/')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https:example.com')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('mailto:')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https:\\\\evil.example')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://example.com\\@evil.example')).toMatchObject({ ok: false, reason: 'malformed' });
    expect(checkWebLink('https://example.com/­')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('caps the length at the number the Rust command enforces', () => {
    const at = `https://example.com/${'a'.repeat(MAX_WEB_LINK_LENGTH - 20)}`;
    expect(at.length).toBe(MAX_WEB_LINK_LENGTH);
    expect(checkWebLink(at)).toMatchObject({ ok: true });
    expect(checkWebLink(`${at}a`)).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

describe('planLinkFollow — routing', () => {
  it('a page in this document is a jump', () => {
    expect(planLinkFollow({ kind: 'goto', page: 3, view: { mode: 'inherit' } }, DOC_WIN)).toEqual({ kind: 'page', page: 3 });
    expect(planLinkFollow({ kind: 'goto', page: null }, DOC_WIN)).toEqual({ kind: 'pageUnresolved' });
    expect(planLinkFollow({ kind: 'goto', page: 0 }, DOC_WIN)).toEqual({ kind: 'pageUnresolved' });
  });

  it('a named destination is resolved later, against the document', () => {
    expect(planLinkFollow({ kind: 'named', name: 'chapter.2' }, DOC_WIN)).toEqual({ kind: 'named', name: 'chapter.2' });
    expect(planLinkFollow({ kind: 'named', name: '' }, DOC_WIN)).toEqual({ kind: 'none' });
  });

  it('a web address goes through the gate', () => {
    expect(planLinkFollow({ kind: 'uri', url: 'https://example.com' }, DOC_WIN)).toEqual({
      kind: 'web', url: 'https://example.com', scheme: 'https',
    });
    expect(planLinkFollow({ kind: 'uri', url: 'javascript:void(0)' }, DOC_WIN)).toEqual({
      kind: 'webRefused', url: 'javascript:void(0)', reason: 'scheme', scheme: 'javascript',
    });
  });

  it('another PDF is opened (after confirming), resolved against the document’s folder', () => {
    expect(planLinkFollow({ kind: 'file', path: 'appendix.pdf', page: 4 }, DOC_WIN)).toEqual({
      kind: 'pdf', path: 'C:\\Users\\me\\Docs\\appendix.pdf', page: 4,
    });
    expect(planLinkFollow({ kind: 'file', path: '../other/A.PDF' }, DOC_POSIX)).toEqual({
      kind: 'pdf', path: '/home/me/other/A.PDF', page: null,
    });
  });

  it('any other file is only named, and never run', () => {
    expect(planLinkFollow({ kind: 'file', path: 'setup.exe' }, DOC_WIN)).toEqual({
      kind: 'fileNotRun', path: 'C:\\Users\\me\\Docs\\setup.exe',
    });
    // A name ending in .pdf only after a dot-segment trick is still judged on
    // the resolved path.
    expect(planLinkFollow({ kind: 'file', path: 'evil.pdf.lnk' }, DOC_WIN)).toMatchObject({ kind: 'fileNotRun' });
  });

  it('a network or web location is named and never reached', () => {
    expect(planLinkFollow({ kind: 'file', path: '\\\\host\\share\\x.pdf' }, DOC_WIN)).toEqual({
      kind: 'fileRemote', path: '\\\\host\\share\\x.pdf',
    });
    expect(planLinkFollow({ kind: 'file', path: 'https://example.com/x.pdf' }, DOC_WIN)).toMatchObject({ kind: 'fileRemote' });
    expect(planLinkFollow({ kind: 'file', path: 'file:///C:/x.pdf' }, DOC_WIN)).toMatchObject({ kind: 'fileRemote' });
  });

  it('a program to launch and an unknown action are reported, never run', () => {
    expect(planLinkFollow({ kind: 'launch', path: 'calc.exe' }, DOC_WIN)).toEqual({ kind: 'launch', path: 'calc.exe' });
    expect(planLinkFollow({ kind: 'launch', path: 'other.pdf' }, DOC_WIN)).toEqual({ kind: 'launch', path: 'other.pdf' });
    expect(planLinkFollow({ kind: 'other', action: 'JavaScript' }, DOC_WIN)).toEqual({ kind: 'unsupported', action: 'JavaScript' });
    expect(planLinkFollow({ kind: 'none' }, DOC_WIN)).toEqual({ kind: 'none' });
    expect(planLinkFollow(undefined, DOC_WIN)).toEqual({ kind: 'none' });
    expect(planLinkFollow({ kind: 'file', path: '  ' }, DOC_WIN)).toEqual({ kind: 'none' });
  });
});

describe('resolveLinkedFile', () => {
  it('resolves relative, rooted and PDF-form drive paths on Windows', () => {
    expect(resolveLinkedFile(DOC_WIN, 'sub/a.pdf')).toEqual({ kind: 'local', path: 'C:\\Users\\me\\Docs\\sub\\a.pdf' });
    expect(resolveLinkedFile(DOC_WIN, '..\\..\\a.pdf')).toEqual({ kind: 'local', path: 'C:\\Users\\a.pdf' });
    expect(resolveLinkedFile(DOC_WIN, '../../../../../a.pdf')).toEqual({ kind: 'local', path: 'C:\\a.pdf' });
    expect(resolveLinkedFile(DOC_WIN, 'D:\\x\\a.pdf')).toEqual({ kind: 'local', path: 'D:\\x\\a.pdf' });
    expect(resolveLinkedFile(DOC_WIN, '/d/x/a.pdf')).toEqual({ kind: 'local', path: 'D:\\x\\a.pdf' });
    // A one-letter first segment IS the drive in the PDF form (§7.11.2.1).
    expect(resolveLinkedFile(DOC_WIN, '/x/y/a.pdf')).toEqual({ kind: 'local', path: 'X:\\y\\a.pdf' });
    expect(resolveLinkedFile(DOC_WIN, '/xy/a.pdf')).toEqual({ kind: 'local', path: 'C:\\xy\\a.pdf' });
    expect(resolveLinkedFile(DOC_WIN, 'C:a.pdf')).toEqual({ kind: 'remote' });
  });

  it('keeps a relative link on the share its document is on, and never climbs off it', () => {
    expect(resolveLinkedFile('\\\\srv\\team\\doc.pdf', '..\\..\\..\\other\\a.pdf')).toEqual({
      kind: 'local', path: '\\\\srv\\team\\other\\a.pdf',
    });
    expect(resolveLinkedFile('\\\\srv\\team\\doc.pdf', '/a.pdf')).toEqual({ kind: 'remote' });
  });

  it('resolves POSIX paths', () => {
    expect(resolveLinkedFile(DOC_POSIX, './a.pdf')).toEqual({ kind: 'local', path: '/home/me/docs/a.pdf' });
    expect(resolveLinkedFile(DOC_POSIX, '/tmp/a.pdf')).toEqual({ kind: 'local', path: '/tmp/a.pdf' });
    expect(resolveLinkedFile(DOC_POSIX, '../../../../a.pdf')).toEqual({ kind: 'local', path: '/a.pdf' });
  });

  it('refuses control characters, shares and schemes', () => {
    expect(resolveLinkedFile(DOC_WIN, 'a\u0000.pdf')).toEqual({ kind: 'remote' });
    expect(resolveLinkedFile(DOC_POSIX, '//host/share/a.pdf')).toEqual({ kind: 'remote' });
    expect(resolveLinkedFile(DOC_POSIX, 'smb://host/a.pdf')).toEqual({ kind: 'remote' });
  });
});

describe('namedDestinationPage', () => {
  const names = [
    { name: 'intro', page: 1 },
    { name: 'gone', page: null },
  ];
  it('finds the page a declared name lands on', () => {
    expect(namedDestinationPage(names, 'intro')).toBe(1);
  });
  it('is null for an unknown name or one that resolves to no page', () => {
    expect(namedDestinationPage(names, 'missing')).toBeNull();
    expect(namedDestinationPage(names, 'gone')).toBeNull();
    expect(namedDestinationPage(undefined, 'intro')).toBeNull();
  });
});

describe('followLabel', () => {
  it('names where each kind goes', () => {
    expect(followLabel({ kind: 'goto', page: 2 })).toEqual({ key: 'canvas.link.followPage', vars: { page: 2 } });
    expect(followLabel({ kind: 'named', name: 'x' })).toEqual({ key: 'canvas.link.followNamed', vars: { name: 'x' } });
    expect(followLabel({ kind: 'uri', url: ' https://e.example ' })).toEqual({
      key: 'canvas.link.followWeb', vars: { url: 'https://e.example' },
    });
    expect(followLabel({ kind: 'file', path: 'a.pdf' })).toEqual({ key: 'canvas.link.followFile', vars: { file: 'a.pdf' } });
    expect(followLabel({ kind: 'goto', page: null })).toEqual({ key: 'app.link.title', vars: {} });
    expect(followLabel({ kind: 'other', action: 'Named' })).toEqual({ key: 'app.link.title', vars: {} });
  });
});
