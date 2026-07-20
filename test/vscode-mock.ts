// Minimal stand-in for the `vscode` module so the tracer can run in plain
// Node. The definition/reference providers return empty results, which
// exercises the tracer's local-AST fallback path (all five fixtures are
// single-file, so the trace still completes end to end).
import * as fs from 'fs';

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c as number, d as number);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
}

export class Uri {
  private constructor(public readonly fsPath: string) {}
  static file(path: string): Uri {
    return new Uri(path);
  }
  toString(): string {
    return 'file://' + this.fsPath;
  }
}

export class Location {
  constructor(
    public readonly uri: Uri,
    public readonly range: Range
  ) {}
}

export const commands = {
  async executeCommand<T>(_command: string, ..._args: unknown[]): Promise<T> {
    return [] as unknown as T;
  },
};

export class MockTextDocument {
  private readonly lineStarts: number[];
  readonly languageId = 'typescriptreact';

  constructor(
    readonly uri: Uri,
    private readonly text: string
  ) {
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        this.lineStarts.push(i + 1);
      }
    }
  }

  get fileName(): string {
    return this.uri.fsPath;
  }

  getText(): string {
    return this.text;
  }

  offsetAt(position: Position): number {
    const lineStart = this.lineStarts[Math.min(position.line, this.lineStarts.length - 1)];
    return lineStart + position.character;
  }

  positionAt(offset: number): Position {
    let line = 0;
    while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) {
      line++;
    }
    return new Position(line, offset - this.lineStarts[line]);
  }

  lineAt(line: number): { text: string } {
    const from = this.lineStarts[line];
    const to = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : this.text.length;
    return { text: this.text.slice(from, to).replace(/\n$/, '') };
  }
}

export const workspace = {
  getConfiguration() {
    return {
      get<T>(_section: string, defaultValue: T): T {
        return defaultValue;
      },
    };
  },
  async openTextDocument(uri: Uri): Promise<MockTextDocument> {
    return new MockTextDocument(uri, fs.readFileSync(uri.fsPath, 'utf8'));
  },
};

export const window = {};

export function makeDocument(fsPath: string): MockTextDocument {
  return new MockTextDocument(Uri.file(fsPath), fs.readFileSync(fsPath, 'utf8'));
}
