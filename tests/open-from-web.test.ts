// File ▸ Open from Web Address — the decisions, without a network or a DOM.
//
// Three of them are load-bearing:
//   • which typed strings become a request, and what exactly gets requested;
//   • where File ▸ Save goes for a document whose path is a temp download;
//   • that a downloaded document's recent entry carries where it came from,
//     because re-opening one re-asks instead of re-fetching.
import { describe, expect, it, vi } from 'vitest';
import {
  WEB_URL_REFUSAL_KEYS,
  downloadStem,
  isPrivateHost,
  routeWebResponse,
  readWebUrl,
  saveRouteFor,
} from '../src/renderer/lib/web-open';
import { firstWebUri } from '../src/renderer/components/DropZone';
import { parseRecent, sameRecent, withRecent } from '../src/renderer/lib/recent-files';

describe('readWebUrl', () => {
  it('accepts http and https and reports the exact address to be fetched', () => {
    const https = readWebUrl(' https://example.com/a.pdf ');
    expect(https).toEqual({
      ok: true,
      url: 'https://example.com/a.pdf',
      host: 'example.com',
      insecure: false,
    });
    const http = readWebUrl('http://example.com/a.pdf');
    expect(http.ok && http.insecure).toBe(true);
  });

  it('completes a bare address to https rather than guessing http', () => {
    const read = readWebUrl('example.com/report.pdf');
    expect(read).toEqual({
      ok: true,
      url: 'https://example.com/report.pdf',
      host: 'example.com',
      insecure: false,
    });
  });

  it('refuses every non-web scheme instead of rewriting it', () => {
    for (const raw of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'data:text/html,x',
      'mailto:a@b.c',
      'ftp://example.com/a.pdf',
    ]) {
      const read = readWebUrl(raw);
      expect(read.ok, raw).toBe(false);
      expect(!read.ok && read.reason).toBe('scheme');
    }
  });

  it('refuses an empty field, an address with spaces, and one with no host', () => {
    expect(readWebUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(readWebUrl('https://example.com/a b.pdf')).toEqual({ ok: false, reason: 'spaces' });
    expect(readWebUrl('https:///a.pdf')).toEqual({ ok: false, reason: 'host' });
  });

  it('refuses an address carrying credentials rather than showing or sending them', () => {
    expect(readWebUrl('https://user:secret@example.com/a.pdf')).toEqual({
      ok: false,
      reason: 'host',
    });
  });

  it('names a string for every refusal reason', () => {
    for (const raw of ['', 'a b', 'ftp://x/y', 'https:///a']) {
      const read = readWebUrl(raw);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(WEB_URL_REFUSAL_KEYS[read.reason]).toBeTruthy();
    }
  });
});

describe('isPrivateHost', () => {
  it('flags literal loopback, RFC1918, and link-local addresses', () => {
    for (const h of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.5',
      '169.254.169.254', // cloud metadata
      '0.0.0.0',
      '[::1]',
      '::1',
      '[fe80::1]',
      'fc00::1',
      'fd12::1',
      '192.168.1.5:8080',
    ]) {
      expect(isPrivateHost(h)).toBe(true);
    }
  });

  it('does not flag public literals or hostnames it cannot resolve', () => {
    for (const h of [
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1', // just past 172.16/12
      'example.com',
      'localhost', // a name, not a literal — Rust resolves and decides
      'intranet.corp',
      '2606:4700::1111',
    ]) {
      expect(isPrivateHost(h)).toBe(false);
    }
  });
});

describe('downloadStem', () => {
  it('names the copy after the address, without the extension', () => {
    expect(downloadStem('https://example.com/docs/Report%20Q3.pdf')).toBe('Report Q3');
    expect(downloadStem('https://example.com/docs/')).toBe('docs');
    expect(downloadStem('https://example.com')).toBe('example.com');
    expect(downloadStem('not a url')).toBe('download');
  });
});

describe('downloaded response ownership', () => {
  const response = (changes: Partial<{
    status: number;
    bytes: number;
    path: string;
    finalUrl: string;
  }> = {}) => ({
    status: 200,
    bytes: 12,
    path: 'C:\\Temp\\spectrapdf\\net\\report-1-abcdef01.1234.pdf',
    finalUrl: 'https://example.com/report.pdf',
    ...changes,
  });

  it('discards an unsuccessful response without opening it', async () => {
    const open = vi.fn(async () => ({ kind: 'opened' as const }));
    const discard = vi.fn(async () => {});
    const result = await routeWebResponse(response({ status: 503 }), 'https://typed.test/', {
      isAbandoned: () => false,
      open,
      discard,
    });

    expect(result).toEqual({ kind: 'rejected', status: 503 });
    expect(open).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith(response().path);
  });

  it('discards empty and abandoned responses', async () => {
    const discard = vi.fn(async () => {});
    const open = vi.fn(async () => ({ kind: 'opened' as const }));

    await expect(
      routeWebResponse(response({ bytes: 0 }), 'https://typed.test/', {
        isAbandoned: () => false,
        open,
        discard,
      }),
    ).resolves.toEqual({ kind: 'empty' });
    await expect(
      routeWebResponse(response(), 'https://typed.test/', {
        isAbandoned: () => true,
        open,
        discard,
      }),
    ).resolves.toEqual({ kind: 'abandoned' });

    expect(open).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledTimes(2);
  });

  it('discards a refused response but retains one the open funnel accepts', async () => {
    const discard = vi.fn(async () => {});
    const refuse = await routeWebResponse(response(), 'https://typed.test/', {
      isAbandoned: () => false,
      open: vi.fn(async () => ({ kind: 'refused' as const, detail: 'not a PDF' })),
      discard,
    });
    expect(refuse).toEqual({ kind: 'refused', detail: 'not a PDF' });
    expect(discard).toHaveBeenCalledTimes(1);

    const accept = await routeWebResponse(response(), 'https://typed.test/', {
      isAbandoned: () => false,
      open: vi.fn(async () => ({ kind: 'opened' as const })),
      discard,
    });
    expect(accept).toEqual({ kind: 'opened' });
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('keeps the source if cancellation arrives while the open funnel is running', async () => {
    let abandoned = false;
    const discard = vi.fn(async () => {});
    const result = await routeWebResponse(response(), 'https://typed.test/', {
      isAbandoned: () => abandoned,
      open: async () => {
        abandoned = true;
        return { kind: 'opened' };
      },
      discard,
    });

    expect(result).toEqual({ kind: 'opened' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('does not let a replacement request revive a canceled response', async () => {
    const canceledRun = { abandoned: true };
    let currentRun = canceledRun;
    const originalRun = currentRun;
    currentRun = { abandoned: false };
    const open = vi.fn(async () => ({ kind: 'opened' as const }));
    const discard = vi.fn(async () => {});

    const result = await routeWebResponse(response(), 'https://typed.test/', {
      isAbandoned: () => originalRun.abandoned,
      open,
      discard,
    });

    expect(currentRun.abandoned).toBe(false);
    expect(result).toEqual({ kind: 'abandoned' });
    expect(open).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith(response().path);
  });

  it('discards a response when an open prompt was canceled without opening', async () => {
    const discard = vi.fn(async () => {});
    const result = await routeWebResponse(response(), 'https://typed.test/', {
      isAbandoned: () => false,
      open: async () => ({ kind: 'notOpened' }),
      discard,
    });

    expect(result).toEqual({ kind: 'notOpened' });
    expect(discard).toHaveBeenCalledWith(response().path);
  });

  it('discards the response if handing it to the open funnel throws', async () => {
    const discard = vi.fn(async () => {});
    await expect(
      routeWebResponse(response(), 'https://typed.test/', {
        isAbandoned: () => false,
        open: async () => {
          throw new Error('open failed');
        },
        discard,
      }),
    ).rejects.toThrow('open failed');
    expect(discard).toHaveBeenCalledWith(response().path);
  });
});

describe('saveRouteFor', () => {
  // The precedent is the ghost guard in state/selectors.ts: a path that is not
  // the user's file is never written to without asking. Here the path is a
  // temp download, so Save routes to Save As — and keeps routing there, since
  // Save As leaves the document on that same temp path.
  it('sends a downloaded document to Save As, every time', () => {
    const downloaded = { webOrigin: 'https://example.com/a.pdf' };
    expect(saveRouteFor(downloaded)).toBe('saveAs');
    expect(saveRouteFor(downloaded)).toBe('saveAs');
  });

  it('leaves an ordinary open file on plain Save', () => {
    expect(saveRouteFor({})).toBe('save');
    expect(saveRouteFor(null)).toBe('save');
    expect(saveRouteFor(undefined)).toBe('save');
  });

  it('still routes to Save As after a cross-window hand-off reconstructs the origin', () => {
    // The move carries the temp path only; the receiving window recovers the
    // address by path (Rust `web_origins_for`) and rebuilds this state. The
    // reconstructed webOrigin is what keeps Save routed to Save As there — the
    // temp copy is never silently overwritten in the second window.
    const reconstructed = { webOrigin: 'https://example.com/a.pdf' };
    expect(saveRouteFor(reconstructed)).toBe('saveAs');
  });

  it('a normal open moved to a second window recovers no origin and stays on Save', () => {
    expect(saveRouteFor({ webOrigin: undefined })).toBe('save');
  });
});

describe('recent provenance survives a re-open with no address', () => {
  it('keeps the recorded sourceUrl when the move re-records the open', () => {
    // The receiving window recovers the origin and re-records the open; even a
    // fold that supplies no address must not erase the provenance already on
    // the recent row (the withRecent erasure defect).
    const before = [
      { path: 'C:\\Temp\\net\\a-1.pdf', openedAt: 1, sourceUrl: 'https://example.com/a.pdf' },
    ];
    expect(withRecent(before, 'C:\\Temp\\net\\a-1.pdf', 9)[0]).toEqual({
      path: 'C:\\Temp\\net\\a-1.pdf',
      openedAt: 9,
      sourceUrl: 'https://example.com/a.pdf',
    });
  });
});

describe('recent-list provenance', () => {
  it('records the source address beside the local copy', () => {
    const list = withRecent([], 'C:\\Temp\\net\\a-1.pdf', 10, 'https://example.com/a.pdf');
    expect(list[0]).toEqual({
      path: 'C:\\Temp\\net\\a-1.pdf',
      openedAt: 10,
      sourceUrl: 'https://example.com/a.pdf',
    });
  });

  it('leaves an ordinary open with no provenance at all', () => {
    expect(withRecent([], 'C:\\docs\\a.pdf', 10)[0]).toEqual({
      path: 'C:\\docs\\a.pdf',
      openedAt: 10,
    });
  });

  it('reads a stored address back, and drops one of the wrong shape', () => {
    expect(
      parseRecent('[{"path":"a.pdf","openedAt":1,"sourceUrl":"https://example.com/a.pdf"}]'),
    ).toEqual([{ path: 'a.pdf', openedAt: 1, sourceUrl: 'https://example.com/a.pdf' }]);
    // Not a string, and an empty string, both read as "no provenance" — this
    // value drives a pre-filled request.
    expect(parseRecent('[{"path":"a.pdf","openedAt":1,"sourceUrl":42}]')).toEqual([
      { path: 'a.pdf', openedAt: 1 },
    ]);
    expect(parseRecent('[{"path":"a.pdf","openedAt":1,"sourceUrl":""}]')).toEqual([
      { path: 'a.pdf', openedAt: 1 },
    ]);
  });

  it('sees a provenance change as a change', () => {
    const a = [{ path: 'a.pdf', openedAt: 1 }];
    const b = [{ path: 'a.pdf', openedAt: 1, sourceUrl: 'https://example.com/a.pdf' }];
    expect(sameRecent(a, a)).toBe(true);
    expect(sameRecent(a, b)).toBe(false);
  });
});

describe('firstWebUri', () => {
  it('reads the first address out of a uri-list, skipping its comments', () => {
    expect(firstWebUri('# comment\r\nhttps://example.com/a.pdf\r\n')).toBe(
      'https://example.com/a.pdf',
    );
    expect(firstWebUri('http://example.com/a.pdf')).toBe('http://example.com/a.pdf');
  });

  it('yields nothing for a drop that is not a web address', () => {
    expect(firstWebUri('')).toBeNull();
    expect(firstWebUri('file:///C:/a.pdf')).toBeNull();
    expect(firstWebUri('some dragged text')).toBeNull();
  });
});
