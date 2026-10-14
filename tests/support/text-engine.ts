import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TextBoxAnswer, TextBoxEngine } from '../../src/renderer/lib/text-box-engine';
import { testPython } from './python';

export const FONT_DIR = join(__dirname, '..', '..', 'resources', 'fonts');

/** The bundled faces are provisioned: tested on the files themselves, since
 *  a stub directory holds none. */
export const HAS_BUNDLED_FACES = [
  'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSerif-Regular.ttf', 'NotoSansCJKsc-Regular.otf',
  'NotoSansHebrew-Regular.ttf', 'IBMPlexSansArabic-Regular.ttf',
].every((name) => existsSync(join(FONT_DIR, name)));

const SCRIPT = [
  'import sys, json',
  "sys.path.insert(0, 'src')",
  'from engine.text_box import text_box_appearance',
  "request = json.loads(sys.stdin.buffer.read().decode('utf-8'))",
  "answer = text_box_appearance(request['blocks'], request['font_path'], request['draw'], request['draw'])",
  "sys.stdout.buffer.write(json.dumps(answer).encode('utf-8'))",
].join('\n');

let python: string | undefined;
export const engineCalls: { blocks: number; draw: boolean }[] = [];

/** The engine method itself, run in the test interpreter. */
export const pythonTextEngine: TextBoxEngine = async (blocks, draw) => {
  python ??= testPython();
  engineCalls.push({ blocks: blocks.length, draw });
  const out = execFileSync(python, ['-B', '-c', SCRIPT], {
    input: JSON.stringify({ blocks, font_path: FONT_DIR, draw }),
    cwd: join(__dirname, '..', '..'),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  return JSON.parse(out.toString('utf8')) as TextBoxAnswer;
};
