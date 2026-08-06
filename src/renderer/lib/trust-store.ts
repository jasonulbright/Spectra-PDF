// The signature-verification trust configuration: the user's own CA anchors
// and the opt-in to the operating system's certificate store.
//
// A leaf module (no React, no Tauri) because two surfaces consume it — the
// signing panel and the nav-pane status readout — and there is no DOM test
// environment, so the decision logic has to live somewhere a test can import.
// The two panels must not be able to disagree about what the trust
// configuration is; sharing this module is what prevents it.

import type { VerifyResult } from './signatures';

const ANCHORS_KEY = 'spectra.trustAnchors';
const SYSTEM_STORE_KEY = 'spectra.trustSystemStore';

/** Which anchor set a chain terminated at, as the engine reports it. */
export type TrustSource = 'user' | 'system';

export interface TrustConfig {
  /** CA certificate files (PEM/DER) the user picked. */
  anchors: string[];
  /** Also anchor on the OS certificate store. OFF unless the user turned it
   * on: without it, only anchors the user chose can make a signature trusted. */
  systemStore: boolean;
}

export const NO_TRUST_CONFIG: TrustConfig = { anchors: [], systemStore: false };

export function loadTrustConfig(): TrustConfig {
  let anchors: string[] = [];
  let systemStore: boolean;
  try {
    const raw = localStorage.getItem(ANCHORS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) anchors = parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    anchors = [];
  }
  try {
    systemStore = localStorage.getItem(SYSTEM_STORE_KEY) === 'true';
  } catch {
    systemStore = false;
  }
  return { anchors, systemStore };
}

/** Persistence is best-effort on both writes: the session state still holds
 * the value, and a failed write must not lose the user's click. */
export function saveTrustAnchors(anchors: string[]): void {
  try {
    localStorage.setItem(ANCHORS_KEY, JSON.stringify(anchors));
  } catch {
    /* empty */
  }
}

export function saveSystemStore(on: boolean): void {
  try {
    localStorage.setItem(SYSTEM_STORE_KEY, String(on));
  } catch {
    /* empty */
  }
}

/** Whether any anchor source is configured at all. With none, `trusted` is
 * deterministically false and the result says nothing about identity. */
export function hasTrustSource(config: TrustConfig): boolean {
  return config.anchors.length > 0 || config.systemStore;
}

/** The verify/sign params for this configuration. An unset system-store
 * preference emits NO key, so the engine's default path — which reads no
 * certificate store at all — is what runs. */
export function trustVerifyParams(config: TrustConfig): Record<string, unknown> {
  return {
    ...(config.anchors.length > 0 ? { trust_roots: config.anchors } : {}),
    ...(config.systemStore ? { system_trust: true } : {}),
  };
}

/** What the aggregate trust box should say. `failed` and `none` are different
 * results: one is a chain that reached no configured anchor, the other is no
 * anchor having been configured. */
export type TrustSummary = 'none' | 'failed' | 'user' | 'system' | 'mixed';

export function trustSummary(config: TrustConfig, result: VerifyResult | null): TrustSummary {
  if (!hasTrustSource(config)) return 'none';
  if (!result || !result.summary.trust_verified) return 'failed';
  const sources = new Set<string>();
  for (const sig of result.signatures) {
    if (sig.trusted) sources.add(sig.trust_source ?? 'user');
  }
  if (sources.size > 1) return 'mixed';
  return sources.has('system') ? 'system' : 'user';
}

/** True when the store was asked for and the platform exposes none — which is
 * a different thing from a store that anchors nothing. */
export function systemStoreUnavailable(result: VerifyResult | null): boolean {
  const report = result?.system_trust;
  return report?.requested === true && report.available === false;
}

/** Per-signature wording naming which set vouched for the chain. */
export const TRUST_SOURCE_LABEL = {
  user: 'panel.sig.trustedViaAnchor',
  system: 'panel.sig.trustedViaSystem',
} as const satisfies Record<TrustSource, string>;
