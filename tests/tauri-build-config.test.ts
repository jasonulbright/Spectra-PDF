import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type TauriConfig = { build: Record<string, unknown> };
type PackageJson = { scripts: Record<string, string> };
const readJson = <T,>(path: string) => JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T;
const productionConfig = readJson<TauriConfig>('src-tauri/tauri.conf.json');
const developmentConfig = readJson<TauriConfig>('src-tauri/tauri.dev.conf.json');
const packageJson = readJson<PackageJson>('package.json');

describe('Tauri frontend build configuration', () => {
  it('keeps the Vite dev server URL out of packaged app configuration', () => {
    expect(productionConfig.build).not.toHaveProperty('devUrl');
  });

  it('adds the Vite dev server URL only to the development command', () => {
    expect(developmentConfig.build.devUrl).toBe('http://localhost:5173');
    expect(packageJson.scripts.dev).toContain('--config src-tauri/tauri.dev.conf.json');
  });
});
