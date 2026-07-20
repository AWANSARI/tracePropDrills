import * as vscode from 'vscode';

/**
 * Thin wrappers over VS Code's built-in definition/reference providers.
 *
 * Deliberate design decision: we never reimplement tsconfig/module
 * resolution. These commands are answered by the TypeScript language server
 * that VS Code is already running, which handles path aliases, node_modules,
 * re-exports, monorepos, etc. for free.
 */

export interface ResolvedLocation {
  uri: vscode.Uri;
  range: vscode.Range;
}

type DefinitionResult = (vscode.Location | vscode.LocationLink)[] | vscode.Location | undefined;

function normalize(result: DefinitionResult): ResolvedLocation[] {
  if (!result) {
    return [];
  }
  const items = Array.isArray(result) ? result : [result];
  return items.map((item) => {
    if ('targetUri' in item) {
      return { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange };
    }
    return { uri: item.uri, range: item.range };
  });
}

/** Where is the symbol at `position` declared? (Go to Definition) */
export async function findDefinitions(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<ResolvedLocation[]> {
  try {
    const result = await vscode.commands.executeCommand<DefinitionResult>(
      'vscode.executeDefinitionProvider',
      uri,
      position
    );
    return normalize(result);
  } catch {
    return [];
  }
}

/** Who references the symbol at `position`? (Find All References) */
export async function findReferences(
  uri: vscode.Uri,
  position: vscode.Position
): Promise<ResolvedLocation[]> {
  try {
    const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
      'vscode.executeReferenceProvider',
      uri,
      position
    );
    return normalize(result);
  } catch {
    return [];
  }
}

const SUPPORTED_FILE = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

export function isSupportedFile(fsPath: string): boolean {
  return SUPPORTED_FILE.test(fsPath);
}

/**
 * Pick the most useful definition for a component tag: prefer real source in
 * the workspace over node_modules and over .d.ts type declarations.
 */
export function pickComponentDefinition(
  defs: ResolvedLocation[]
): ResolvedLocation | undefined {
  if (defs.length === 0) {
    return undefined;
  }
  const supported = defs.filter((d) => isSupportedFile(d.uri.fsPath));
  const source = supported.find(
    (d) => !d.uri.fsPath.includes('node_modules') && !d.uri.fsPath.endsWith('.d.ts')
  );
  return source ?? supported[0] ?? defs[0];
}
