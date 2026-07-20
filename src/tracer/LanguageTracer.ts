import * as vscode from 'vscode';
import { TraceResult } from '../types';

/**
 * EXTENSIBILITY SEAM (languages).
 *
 * All language-specific analysis lives behind this interface. The command
 * layer (src/extension.ts) picks a tracer by `document.languageId` and the
 * view layer only ever sees the language-agnostic `TraceResult` tree.
 *
 * Adding support for a second language (Vue, Svelte, SwiftUI, ...) means
 * writing one more implementation of this interface and appending it to the
 * `tracers` registry in extension.ts — no changes to the view or command code.
 */
export interface LanguageTracer {
  /** Whether this tracer can handle the given VS Code language id. */
  supports(languageId: string): boolean;

  /**
   * Trace the symbol at `position`. Resolves to `undefined` when there is
   * nothing traceable at the cursor (the command layer then shows a friendly
   * "place the cursor on a prop" status instead of an error).
   */
  trace(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<TraceResult | undefined>;
}
