// A form submission leaves none of the user's form data in the temp tree once
// the run is done with it. The payload goes when it is abandoned (a declined
// consent, a saved copy, a failed build); once it is handed to the request,
// the Rust client removes it whatever the outcome. The reply goes once it is
// imported, saved, declined, empty or rejected, and stays only as the path of
// a document it opened as.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSubmission, type SubmissionIo, type SubmissionReply, type SubmitAction } from '../src/renderer/lib/form-submission';

const PAYLOAD = 'C:/Temp/spectrapdf/net/invoice-submission-1.42.fdf';
const REPLY = 'C:/Temp/spectrapdf/net/invoice-reply-1.42.pdf';

interface Script {
  proceed?: boolean;
  consent?: 'submit' | 'save' | 'cancel';
  saveTarget?: string | null;
  copyUrl?: boolean;
  build?: () => Promise<{ count?: number }>;
  reply?: SubmissionReply | Error;
  routeAnswer?: boolean;
  opened?: boolean;
  importFails?: boolean;
}

/** An IO that answers from `script` and records every effect in order. */
function io(script: Script): { io: SubmissionIo; log: string[] } {
  const log: string[] = [];
  let confirms = 0;
  return {
    log,
    io: {
      confirm: async () => {
        confirms += 1;
        log.push(`confirm ${confirms}`);
        if (confirms === 1) return script.proceed ?? true;
        return script.routeAnswer ?? script.copyUrl ?? false;
      },
      notice: async (_title, message) => void log.push(`notice ${message.slice(0, 20)}`),
      consent: async () => {
        log.push('consent');
        return script.consent ?? 'submit';
      },
      payloadPath: async () => {
        log.push('payloadPath');
        return PAYLOAD;
      },
      buildPayload: async (output) => {
        log.push(`build ${output}`);
        return script.build ? script.build() : { count: 2 };
      },
      payloadBytes: async () => new TextEncoder().encode('%FDF-1.2'),
      send: async (request) => {
        log.push(`send ${request.bodyPath}`);
        if (script.reply instanceof Error) throw script.reply;
        return script.reply ?? { status: 200, contentType: 'application/pdf', path: REPLY, bytes: 10 };
      },
      saveTarget: async () => {
        log.push('saveTarget');
        return script.saveTarget === undefined ? 'C:/Users/me/kept.fdf' : script.saveTarget;
      },
      copyFile: async (from, to) => void log.push(`copy ${from} -> ${to}`),
      copyToClipboard: async () => void log.push('clipboard'),
      importFormData: async (data) => {
        log.push(`import ${data}`);
        if (script.importFails) throw new Error('import failed');
      },
      openDocument: async (path) => {
        log.push(`open ${path}`);
        return script.opened ?? true;
      },
      remove: async (path) => void log.push(`remove ${path}`),
    },
  };
}

const action = (url: string, format: SubmitAction['format'] = 'fdf'): SubmitAction => ({
  url, format, method: 'post', fields: null, exclude: false, includeEmpty: false,
});

const run = (fake: SubmissionIo, url = 'https://forms.example/submit'): Promise<void> =>
  runSubmission(fake, { field: 'Send', stem: 'invoice', action: action(url) });

const removed = (log: string[]): string[] => log.filter((l) => l.startsWith('remove ')).map((l) => l.slice(7));

describe('the payload', () => {
  it('is never made when the first question is declined', async () => {
    const { io: fake, log } = io({ proceed: false });
    await run(fake);
    expect(log).toEqual(['confirm 1']);
  });

  it('goes after a copy is saved for a destination with no transport', async () => {
    const { io: fake, log } = io({});
    await run(fake, 'mailto:forms@example.com');
    expect(log).not.toContain(`send ${PAYLOAD}`);
    expect(log.indexOf(`remove ${PAYLOAD}`)).toBeGreaterThan(log.indexOf(`copy ${PAYLOAD} -> C:/Users/me/kept.fdf`));
    expect(removed(log)).toEqual([PAYLOAD]);
  });

  it('goes when the save dialog is cancelled too', async () => {
    const { io: fake, log } = io({ saveTarget: null });
    await run(fake, '');
    expect(removed(log)).toEqual([PAYLOAD]);
  });

  it('goes when the consent is cancelled, and nothing is sent', async () => {
    const { io: fake, log } = io({ consent: 'cancel' });
    await run(fake);
    expect(log).not.toContain(`send ${PAYLOAD}`);
    expect(removed(log)).toEqual([PAYLOAD]);
  });

  it('goes after the consent’s Save answer saves a copy, and nothing is sent', async () => {
    const { io: fake, log } = io({ consent: 'save' });
    await run(fake);
    expect(log).not.toContain(`send ${PAYLOAD}`);
    expect(log.indexOf(`remove ${PAYLOAD}`)).toBeGreaterThan(log.indexOf(`copy ${PAYLOAD} -> C:/Users/me/kept.fdf`));
    expect(removed(log)).toEqual([PAYLOAD]);
  });

  it('goes when the build fails, and the failure still reaches the caller', async () => {
    const { io: fake, log } = io({ build: async () => { throw new Error('engine refused'); } });
    await expect(run(fake)).rejects.toThrow('engine refused');
    expect(removed(log)).toEqual([PAYLOAD]);
  });

  it('is left to the request once it is sent, even when the request fails', async () => {
    const { io: fake, log } = io({ reply: new Error('connection refused') });
    await run(fake);
    expect(log).toContain(`send ${PAYLOAD}`);
    expect(log.some((l) => l.startsWith('notice '))).toBe(true);
    expect(removed(log)).toEqual([]);
  });
});

describe('the reply', () => {
  const reply = (over: Partial<SubmissionReply>): SubmissionReply => ({
    status: 200, contentType: 'application/pdf', path: REPLY, bytes: 10, ...over,
  });

  it('stays as the path of the document it opened as', async () => {
    const { io: fake, log } = io({ routeAnswer: true, opened: true });
    await run(fake);
    expect(log).toContain(`open ${REPLY}`);
    expect(removed(log)).toEqual([]);
  });

  it('goes when it did not open as a document', async () => {
    const { io: fake, log } = io({ routeAnswer: true, opened: false });
    await run(fake);
    expect(log).toContain(`open ${REPLY}`);
    expect(removed(log)).toEqual([REPLY]);
  });

  it('goes when the offer to open it is declined', async () => {
    const { io: fake, log } = io({ routeAnswer: false });
    await run(fake);
    expect(log).not.toContain(`open ${REPLY}`);
    expect(removed(log)).toEqual([REPLY]);
  });

  it('goes once form data it carried is imported, and after the import', async () => {
    const { io: fake, log } = io({ routeAnswer: true, reply: reply({ contentType: 'application/vnd.fdf' }) });
    await run(fake);
    expect(log.indexOf(`remove ${REPLY}`)).toBeGreaterThan(log.indexOf(`import ${REPLY}`));
    expect(removed(log)).toEqual([REPLY]);
  });

  it('goes when the import of its form data fails, and the failure still reaches the caller', async () => {
    const { io: fake, log } = io({ routeAnswer: true, importFails: true, reply: reply({ contentType: 'application/vnd.fdf' }) });
    await expect(run(fake)).rejects.toThrow('import failed');
    expect(removed(log)).toEqual([REPLY]);
  });

  it('goes when an import is declined', async () => {
    const { io: fake, log } = io({ routeAnswer: false, reply: reply({ contentType: 'application/vnd.adobe.xfdf' }) });
    await run(fake);
    expect(removed(log)).toEqual([REPLY]);
  });

  it('goes after a copy of any other reply is saved, or when that is declined', async () => {
    const saved = io({ routeAnswer: true, reply: reply({ contentType: 'text/html' }) });
    await run(saved.io);
    expect(saved.log.indexOf(`remove ${REPLY}`)).toBeGreaterThan(saved.log.indexOf(`copy ${REPLY} -> C:/Users/me/kept.fdf`));
    expect(removed(saved.log)).toEqual([REPLY]);
    const declined = io({ routeAnswer: false, reply: reply({ contentType: 'text/html' }) });
    await run(declined.io);
    expect(removed(declined.log)).toEqual([REPLY]);
  });

  it('goes when it is empty, and when the server rejected the submission', async () => {
    const empty = io({ reply: reply({ bytes: 0 }) });
    await run(empty.io);
    expect(removed(empty.log)).toEqual([REPLY]);
    const rejected = io({ reply: reply({ status: 500, contentType: 'text/html' }) });
    await run(rejected.io);
    expect(rejected.log).toContain(`copy ${REPLY} -> C:/Users/me/kept.fdf`);
    expect(removed(rejected.log)).toEqual([REPLY]);
  });

  it('never takes the payload with it: the request already did', async () => {
    const { io: fake, log } = io({ routeAnswer: false });
    await run(fake);
    expect(removed(log)).not.toContain(PAYLOAD);
  });
});

describe('a temp file already gone', () => {
  it('is not an error: the run ends as it would have', async () => {
    const { io: fake, log } = io({ consent: 'cancel' });
    const failing: SubmissionIo = {
      ...fake,
      remove: async (path) => {
        log.push(`remove ${path}`);
        throw new Error('The system cannot find the file specified.');
      },
    };
    await expect(run(failing)).resolves.toBeUndefined();
    expect(removed(log)).toEqual([PAYLOAD]);
  });
});

describe('the App', () => {
  const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('runs every form-button submission through the flow, with the scoped remove', () => {
    expect(app).toContain('await runSubmission(');
    expect(app).toContain('remove: (scratch) => file.remove(scratch),');
    expect(app).not.toContain('const saveBuiltCopy = async');
  });

  it('keeps a reply only while it is a document of this window', () => {
    expect(app).toContain(
      'return !!readState().files.get(opened) && !readState().files.get(opened)?.importOnly;',
    );
  });
});
