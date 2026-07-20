import * as vscode from 'vscode';
import { TraceResult } from '../types';

/**
 * EXTENSIBILITY SEAM (Phase 2 — debug mode). STUB ONLY.
 *
 * Planned behavior: while the debugger is paused on a breakpoint, take an
 * already-computed static TraceResult and decorate every node with the
 * runtime value the traced symbol currently holds.
 *
 * Implementation sketch for Phase 2:
 *  1. Read the active `vscode.debug.activeDebugSession` and fetch the paused
 *     thread's stack via DAP `stackTrace` / `scopes` / `variables` requests
 *     (session.customRequest).
 *  2. For each TraceNode, pick the stack frame whose source matches
 *     `node.location.filePath` and evaluate the traced expression there with
 *     the DAP `evaluate` request (context: 'watch').
 *  3. Write the result into `TraceNode.valueText` — the field is already in
 *     the data model and the webview already renders it, so no view or
 *     protocol changes are needed.
 */
export interface DebugValueProvider {
  /** True when a debug session is paused and values can be evaluated. */
  canEnrich(session: vscode.DebugSession | undefined): boolean;

  /** Return a copy of `result` with runtime values filled into `valueText`. */
  enrich(result: TraceResult, session: vscode.DebugSession): Promise<TraceResult>;
}

export class DebugTracer implements DebugValueProvider {
  canEnrich(): boolean {
    return false;
  }

  enrich(): Promise<TraceResult> {
    throw new Error('Debug tracing arrives in Phase 2.');
  }
}
