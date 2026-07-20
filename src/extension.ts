import * as vscode from 'vscode';
import { TraceViewProvider } from './TraceViewProvider';
import { LanguageTracer } from './tracer/LanguageTracer';
import { ReactTracer } from './tracer/ReactTracer';

/**
 * EXTENSIBILITY SEAM (languages): the command layer picks a tracer purely by
 * `document.languageId`. To support another language, implement
 * LanguageTracer and append it here — the view and commands stay untouched.
 */
const tracers: LanguageTracer[] = [new ReactTracer()];

export function activate(context: vscode.ExtensionContext): void {
  let lastTrace: { uri: vscode.Uri; position: vscode.Position } | undefined;

  const provider = new TraceViewProvider(context.extensionUri, () => {
    void runLastTrace();
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TraceViewProvider.viewType, provider, {
      // Keep the rendered tree alive when the view is hidden (e.g. while the
      // user drags it between the panel and a sidebar).
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  async function runTrace(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
    const tracer = tracers.find((t) => t.supports(document.languageId));
    if (!tracer) {
      provider.postStatus(`Language '${document.languageId}' is not supported yet.`);
      return;
    }
    lastTrace = { uri: document.uri, position };
    provider.postStatus('Tracing…');
    try {
      const result = await tracer.trace(document, position);
      if (result) {
        provider.postRender(result);
      } else {
        provider.postStatus('Place the cursor on a prop or component and try again.');
      }
    } catch (error) {
      // The tracer itself degrades gracefully (unresolved nodes); this only
      // catches truly unexpected failures so the view never goes blank.
      provider.postStatus(
        `Trace failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function runLastTrace(): Promise<void> {
    if (!lastTrace) {
      provider.postStatus('Nothing to refresh yet — run a trace first.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(lastTrace.uri);
    await runTrace(document, lastTrace.position);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('reactPropTracer.traceAtCursor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      // Surface the view first so the result has somewhere to land.
      await vscode.commands.executeCommand('reactPropTracer.traceView.focus');
      await runTrace(editor.document, editor.selection.active);
    }),
    vscode.commands.registerCommand('reactPropTracer.refresh', () => runLastTrace()),
    vscode.commands.registerCommand('reactPropTracer.clear', () => provider.postClear())
  );
}

export function deactivate(): void {
  // Nothing to clean up: all disposables are held by the extension context.
}
