// Command execution context — module-level slots the mounted surfaces fill
// (the testHarness registerCanvas* idiom): App registers its handler bundle
// and the live state source; the canvas view registers its camera + find
// services while mounted. invokeCommand() is the ONE entry point every
// caller shares — keymap, UI buttons, menus (M2), and the e2e harness.
import { COMMANDS, type CommandId } from './registry';
import { drainPendingFind } from './find-intent';
import type { AppCommandHandlers, CanvasServices, CommandContext } from './types';
import type { AppAction, AppState } from '../state/types';
import type { Dispatch } from 'react';

type StateSource = () => { state: AppState; dispatch: Dispatch<AppAction> };

let stateSource: StateSource | null = null;
let appHandlers: AppCommandHandlers | null = null;
let canvasServices: CanvasServices | null = null;

/** App.tsx keeps this pointed at the current state/dispatch (ref-backed). */
export function setCommandStateSource(source: StateSource | null): void {
  stateSource = source;
}

export function registerAppCommandHandlers(handlers: AppCommandHandlers | null): void {
  appHandlers = handlers;
}

export function registerCanvasServices(services: CanvasServices | null): void {
  canvasServices = services;
  // Registration happens in the canvas view's mount effect — exactly the moment
  // a parked Find request becomes servable. See commands/find-intent.
  drainPendingFind(services);
}

/** The board's live canvas services (camera + find), or null when the board
 * isn't mounted. Nav-pane panels use it to drive centerOn navigation. */
export function getCanvasServices(): CanvasServices | null {
  return canvasServices;
}

/** Null until App mounts — command invocation is impossible before then. */
export function getCommandContext(): CommandContext | null {
  if (!stateSource) return null;
  const { state, dispatch } = stateSource();
  return { state, dispatch, app: appHandlers, canvas: canvasServices };
}

export function isCommandEnabled(id: CommandId): boolean {
  const ctx = getCommandContext();
  if (!ctx) return false;
  const cmd = COMMANDS[id];
  return cmd.when ? cmd.when(ctx) : true;
}

/**
 * Run a command if its enablement predicate passes. Returns true when the
 * command ran (async runs are fire-and-forget — every existing handler
 * reports its own failures, e.g. via the commit-error banner or panel state).
 */
export function invokeCommand(id: CommandId): boolean {
  const ctx = getCommandContext();
  if (!ctx) return false;
  const cmd = COMMANDS[id];
  if (cmd.when && !cmd.when(ctx)) return false;
  void cmd.run(ctx);
  return true;
}

// --- Escape interceptors -------------------------------------------------
//
// Transient interaction surfaces (an in-flight page drag, an open context
// menu) own Escape while they are active. They register here instead of
// adding their own window keydown listeners; the keymap dispatcher runs the
// stack LIFO (most recent surface wins) before the rest of the Escape chain
// (exit tool → clear selection — § 4.4). A handler returns true to consume
// the key. The surfaces themselves stay component-local (§ 4.3 — ephemeral
// interaction state has no command consumers); only the *key routing* is
// centralized.
export type EscapeInterceptor = () => boolean;

const escapeInterceptors: EscapeInterceptor[] = [];

/** Register an interceptor; returns its unregister function. */
export function pushEscapeInterceptor(handler: EscapeInterceptor): () => void {
  escapeInterceptors.push(handler);
  return () => {
    const i = escapeInterceptors.lastIndexOf(handler);
    if (i !== -1) escapeInterceptors.splice(i, 1);
  };
}

/** Run the stack LIFO; true if any interceptor consumed the key. */
export function runEscapeInterceptors(): boolean {
  for (let i = escapeInterceptors.length - 1; i >= 0; i--) {
    if (escapeInterceptors[i]()) return true;
  }
  return false;
}

/** Test-only: the current stack depth. */
export function escapeInterceptorCount(): number {
  return escapeInterceptors.length;
}
