/**
 * Shared data model for the trace tree and the extension <-> webview protocol.
 *
 * Phase 2 note (extensibility seam): `TraceNode.valueText` today holds the
 * *static* source text of an expression. The DebugTracer will overwrite it
 * with the *runtime* value evaluated via the Debug Adapter Protocol while
 * paused on a breakpoint — no schema change required.
 */

export type TraceNodeKind =
  | 'selection'        // the prop/component the user clicked
  | 'state-hook' | 'hook' | 'local-variable' | 'import' | 'from-parent-prop'
  | 'received-param' | 'props-access' | 're-passed-prop'
  | 'component-definition'
  | 'unresolved';

export interface TraceLocation {
  filePath: string;
  line: number;      // 0-based
  character: number; // 0-based
  endLine: number;
  endCharacter: number;
}

export interface TraceNode {
  id: string;
  label: string;         // e.g. "value" or "Counter"
  kind: TraceNodeKind;
  direction: 'upstream' | 'downstream' | 'selection';
  location: TraceLocation;
  snippet: string;       // one line of source for context
  valueText?: string;    // the expression text, e.g. "count"
  unresolvedReason?: string;
  children: TraceNode[];
}

export interface TraceResult {
  root: TraceNode;       // kind 'selection'
  generatedAt: number;
  warnings: string[];
}

/** Messages the extension posts into the webview. */
export type ExtensionToWebviewMessage =
  | { type: 'render'; result: TraceResult }
  | { type: 'status'; text: string }
  | { type: 'clear' };

/** Messages the webview posts back to the extension. */
export type WebviewToExtensionMessage =
  | { type: 'reveal'; location: TraceLocation }
  | { type: 'refresh' };
