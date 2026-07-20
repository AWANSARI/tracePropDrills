import * as vscode from 'vscode';
import {
  ExtensionToWebviewMessage,
  TraceLocation,
  TraceResult,
  WebviewToExtensionMessage,
} from './types';

/**
 * Owns the "Trace" webview view. Because it is a *contributed* view (see
 * package.json `viewsContainers` / `views`), VS Code gives it the standard
 * drag-between-regions behavior for free: it defaults to the bottom panel and
 * the user can drag it into the primary (left) or secondary (right) sidebar.
 */
export class TraceViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'reactPropTracer.traceView';

  private view: vscode.WebviewView | undefined;
  /** Messages posted before the view first resolves are held and replayed. */
  private pending: ExtensionToWebviewMessage | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onRefreshRequested: () => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      if (message.type === 'reveal') {
        void this.reveal(message.location);
      } else if (message.type === 'refresh') {
        this.onRefreshRequested();
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    if (this.pending) {
      void webviewView.webview.postMessage(this.pending);
      this.pending = undefined;
    }
  }

  postRender(result: TraceResult): void {
    this.post({ type: 'render', result });
  }

  postStatus(text: string): void {
    this.post({ type: 'status', text });
  }

  postClear(): void {
    this.post({ type: 'clear' });
  }

  private post(message: ExtensionToWebviewMessage): void {
    if (this.view) {
      void this.view.webview.postMessage(message);
    } else {
      this.pending = message;
    }
  }

  /** Open the clicked node's file, select its range, and scroll it into view. */
  private async reveal(location: TraceLocation): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(location.filePath));
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const range = new vscode.Range(
        location.line,
        location.character,
        location.endLine,
        location.endCharacter
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      void vscode.window.showWarningMessage(
        `React Prop Tracer: could not open ${location.filePath}`
      );
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'trace.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'trace.js'));

    // Strict CSP: no inline scripts or handlers; only our nonce'd script and
    // stylesheets served from the extension's media/ directory.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>Prop Trace</title>
</head>
<body>
  <div id="toolbar">
    <span id="toolbar-title">Prop Trace</span>
    <button id="btn-refresh" title="Re-run the last trace">Refresh</button>
    <button id="btn-clear" title="Clear the trace">Clear</button>
  </div>
  <div id="content">
    <div class="empty">Place the cursor on a prop or component and run
      &ldquo;React Prop Tracer: Trace Prop at Cursor&rdquo;.</div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
