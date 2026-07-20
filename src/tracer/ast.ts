import * as ts from 'typescript';
import { TraceLocation } from '../types';

/**
 * Pure AST helpers built on the TypeScript Compiler API. This module has no
 * dependency on `vscode`, so the tracer logic can be exercised outside the
 * editor (see test/).
 */

export type JsxOpeningLike = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

// ---------------------------------------------------------------------------
// Parsing & positions
// ---------------------------------------------------------------------------

/**
 * Deviation from the build spec (noted per its "note deviations" rule): the
 * spec suggests always parsing with ScriptKind.TSX. TSX parsing misreads two
 * legal constructs in plain .ts files — `<T>(x) => x` generic arrows and
 * `<Foo>value` type assertions — so we pick the script kind per extension
 * instead. JSX-in-.js is common, so .js/.jsx both get JSX parsing.
 */
export function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (fileName.endsWith('.ts')) {
    return ts.ScriptKind.TS;
  }
  if (fileName.endsWith('.jsx') || fileName.endsWith('.js')) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.TSX;
}

export function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName)
  );
}

/** Deepest node whose [start, end] span contains `offset`. */
export function findNodeAtOffset(sf: ts.SourceFile, offset: number): ts.Node | undefined {
  function visit(node: ts.Node): ts.Node | undefined {
    if (offset < node.getStart(sf) || offset > node.getEnd()) {
      return undefined;
    }
    return node.forEachChild(visit) ?? node;
  }
  const found = visit(sf);
  return found === sf ? undefined : found;
}

export function locationOf(sf: ts.SourceFile, node: ts.Node): TraceLocation {
  const start = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const end = sf.getLineAndCharacterOfPosition(node.getEnd());
  return {
    filePath: sf.fileName,
    line: start.line,
    character: start.character,
    endLine: end.line,
    endCharacter: end.character,
  };
}

/** The full source line containing `node`, trimmed, for display context. */
export function snippetOf(sf: ts.SourceFile, node: ts.Node): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const starts = sf.getLineStarts();
  const from = starts[line];
  const to = line + 1 < starts.length ? starts[line + 1] : sf.text.length;
  return sf.text.slice(from, to).trim().slice(0, 160);
}

// ---------------------------------------------------------------------------
// JSX helpers
// ---------------------------------------------------------------------------

/** Host/DOM tags (div, span) start lowercase; components start uppercase. */
export function isComponentTagName(tagText: string): boolean {
  const last = tagText.split('.').pop() ?? tagText;
  return /^[A-Z]/.test(last);
}

export function tagNameOf(el: JsxOpeningLike): string {
  return el.tagName.getText();
}

export function attrName(attr: ts.JsxAttribute): string {
  return attr.name.getText();
}

/** The element an attribute belongs to (JsxAttribute -> JsxAttributes -> element). */
export function attributeElement(attr: ts.JsxAttribute): JsxOpeningLike {
  return attr.parent.parent as JsxOpeningLike;
}

export function spreadAttributeElement(attr: ts.JsxSpreadAttribute): JsxOpeningLike {
  return attr.parent.parent as JsxOpeningLike;
}

/**
 * The value expression of `name={expr}` (the inner expr), `name="str"` (the
 * string literal), or undefined for bare boolean attrs / empty braces.
 */
export function attrValueExpression(attr: ts.JsxAttribute): ts.Expression | undefined {
  if (!attr.initializer) {
    return undefined;
  }
  if (ts.isJsxExpression(attr.initializer)) {
    return attr.initializer.expression;
  }
  return attr.initializer;
}

export function getAttribute(el: JsxOpeningLike, name: string): ts.JsxAttribute | undefined {
  for (const prop of el.attributes.properties) {
    if (ts.isJsxAttribute(prop) && attrName(prop) === name) {
      return prop;
    }
  }
  return undefined;
}

export function getSpreadAttributes(el: JsxOpeningLike): ts.JsxSpreadAttribute[] {
  return el.attributes.properties.filter(ts.isJsxSpreadAttribute);
}

/**
 * Walk up from `node` to the JsxAttribute it belongs to (cursor on the attr
 * name, or anywhere inside the value expression). Stops — returns undefined —
 * as soon as it crosses a JSX element boundary, so an element nested inside a
 * prop value (`icon={<Star />}`) is classified as an element, not an attr.
 */
export function enclosingJsxAttribute(node: ts.Node): ts.JsxAttribute | undefined {
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isJsxAttribute(cur)) {
      return cur;
    }
    if (
      ts.isJsxOpeningElement(cur) ||
      ts.isJsxSelfClosingElement(cur) ||
      ts.isJsxElement(cur) ||
      ts.isJsxFragment(cur)
    ) {
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * If `node` is (part of) a JSX tag name — `<Child ...>`, `<Foo.Bar ...>`, or
 * a closing tag — return the opening/self-closing element it names.
 */
export function jsxTagFromNode(node: ts.Node | undefined): JsxOpeningLike | undefined {
  if (!node) {
    return undefined;
  }
  let cur: ts.Node = node;
  while (cur.parent && ts.isPropertyAccessExpression(cur.parent)) {
    cur = cur.parent;
  }
  const parent = cur.parent;
  if (!parent) {
    return undefined;
  }
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === cur) {
    return parent;
  }
  if (ts.isJsxClosingElement(parent) && parent.tagName === cur) {
    return parent.parent.openingElement;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export function isLiteralExpression(expr: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(expr) ||
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * The "root" identifiers of an expression — the names whose declarations we
 * trace upstream. For `user.name` that is `user`; for `fmt(count) + step` it
 * is `fmt`, `count`, and `step`. Property names, object-literal keys, and JSX
 * attribute names are skipped.
 */
export function rootIdentifiers(expr: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const seen = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ts.isJsxAttribute(parent);
      if (!isPropertyName && !seen.has(node.text)) {
        seen.add(node.text);
        out.push(node);
      }
      return;
    }
    node.forEachChild(visit);
  }
  visit(expr);
  return out;
}

// ---------------------------------------------------------------------------
// Functions & components
// ---------------------------------------------------------------------------

export function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/**
 * Best-effort name of a function or class: its own name, or the variable it
 * is assigned to — looking through HOC wrappers (`const X = memo(() => ...)`)
 * and parentheses.
 */
export function functionName(fn: ts.Node): ts.Identifier | undefined {
  if (
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isClassDeclaration(fn)) &&
    fn.name &&
    ts.isIdentifier(fn.name)
  ) {
    return fn.name;
  }
  let cur: ts.Node = fn;
  while (cur.parent && (ts.isCallExpression(cur.parent) || ts.isParenthesizedExpression(cur.parent))) {
    cur = cur.parent;
  }
  if (cur.parent && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) {
    return cur.parent.name;
  }
  return undefined;
}

/** Nearest enclosing function whose (assigned) name is Uppercase — a component. */
export function enclosingComponent(
  node: ts.Node
): { fn: FunctionLikeNode; name: ts.Identifier } | undefined {
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isSourceFile(cur)) {
    if (isFunctionLike(cur)) {
      const name = functionName(cur);
      if (name && /^[A-Z]/.test(name.text)) {
        return { fn: cur, name };
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

/** Unwrap `memo(forwardRef((props) => ...))` down to the inner function. */
export function unwrapComponentInitializer(
  expr: ts.Expression | undefined
): FunctionLikeNode | ts.ClassDeclaration | undefined {
  if (!expr) {
    return undefined;
  }
  if (isFunctionLike(expr)) {
    return expr;
  }
  if (ts.isParenthesizedExpression(expr)) {
    return unwrapComponentInitializer(expr.expression);
  }
  if (ts.isCallExpression(expr)) {
    for (const arg of expr.arguments) {
      const inner = unwrapComponentInitializer(arg);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

/** Top-level component in `sf` named `name` (function, arrow const, or class). */
export function findComponentByName(
  sf: ts.SourceFile,
  name: string
): FunctionLikeNode | ts.ClassDeclaration | undefined {
  let found: FunctionLikeNode | ts.ClassDeclaration | undefined;
  sf.forEachChild((statement) => {
    if (found) {
      return;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      found = statement;
    } else if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      found = statement;
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          found = unwrapComponentInitializer(decl.initializer);
        }
      }
    }
  });
  return found;
}

/**
 * The component that contains `offset` — used to interpret a definition
 * location returned by the definition provider (which usually points at the
 * name identifier).
 */
export function componentAt(
  sf: ts.SourceFile,
  offset: number
): FunctionLikeNode | ts.ClassDeclaration | undefined {
  let cur = findNodeAtOffset(sf, offset);
  while (cur && !ts.isSourceFile(cur)) {
    if (isFunctionLike(cur) || ts.isClassDeclaration(cur)) {
      return cur;
    }
    if (ts.isVariableDeclaration(cur)) {
      const unwrapped = unwrapComponentInitializer(cur.initializer);
      if (unwrapped) {
        return unwrapped;
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Declaration lookup (lexical-ish, innermost scope first)
// ---------------------------------------------------------------------------

export type DeclInfo =
  | {
      kind: 'param';
      fn: FunctionLikeNode;
      param: ts.ParameterDeclaration;
      bindingElement?: ts.BindingElement;
      node: ts.Node;
    }
  | { kind: 'variable'; node: ts.VariableDeclaration; hookName?: string }
  | { kind: 'function'; node: ts.FunctionDeclaration }
  | { kind: 'import'; node: ts.Node; module: string };

function matchBinding(
  bindingName: ts.BindingName,
  name: string
): { node: ts.Node; element?: ts.BindingElement } | undefined {
  if (ts.isIdentifier(bindingName)) {
    return bindingName.text === name ? { node: bindingName } : undefined;
  }
  for (const el of bindingName.elements) {
    if (ts.isOmittedExpression(el)) {
      continue;
    }
    const hit = matchBinding(el.name, name);
    if (hit) {
      return { node: hit.node, element: hit.element ?? el };
    }
  }
  return undefined;
}

/** If `expr` is a call to a React hook (`useXxx(...)`), its callee name. */
export function hookCallName(expr: ts.Expression | undefined): string | undefined {
  if (!expr || !ts.isCallExpression(expr)) {
    return undefined;
  }
  const callee = expr.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  return name && /^use[A-Z0-9_]/.test(name) ? name : undefined;
}

function importBinding(statement: ts.ImportDeclaration, name: string): ts.Node | undefined {
  const clause = statement.importClause;
  if (!clause) {
    return undefined;
  }
  if (clause.name?.text === name) {
    return clause.name;
  }
  const bindings = clause.namedBindings;
  if (bindings) {
    if (ts.isNamespaceImport(bindings) && bindings.name.text === name) {
      return bindings.name;
    }
    if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.name.text === name) {
          return el;
        }
      }
    }
  }
  return undefined;
}

/**
 * Walk outward from `from`, checking function parameters and block/file
 * statements for a declaration of `name`. Simplified lexical scoping — good
 * enough for classifying a prop value's origin; the definition provider is
 * still consulted for the authoritative location.
 */
export function findDeclaration(from: ts.Node, name: string): DeclInfo | undefined {
  let cur: ts.Node | undefined = from;
  while (cur) {
    if (isFunctionLike(cur)) {
      for (const param of cur.parameters) {
        const hit = matchBinding(param.name, name);
        if (hit) {
          return { kind: 'param', fn: cur, param, bindingElement: hit.element, node: hit.node };
        }
      }
    }
    const statements: ts.NodeArray<ts.Statement> | undefined =
      ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur)
        ? cur.statements
        : undefined;
    if (statements) {
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) {
            const hit = matchBinding(decl.name, name);
            if (hit) {
              return { kind: 'variable', node: decl, hookName: hookCallName(decl.initializer) };
            }
          }
        } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
          return { kind: 'function', node: statement };
        } else if (ts.isImportDeclaration(statement)) {
          const bound = importBinding(statement, name);
          if (bound && ts.isStringLiteral(statement.moduleSpecifier)) {
            return { kind: 'import', node: bound, module: statement.moduleSpecifier.text };
          }
        }
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Body searches (prop reception & re-passing)
// ---------------------------------------------------------------------------

function bodyOf(fn: FunctionLikeNode | ts.ClassDeclaration): ts.Node | undefined {
  return ts.isClassDeclaration(fn) ? fn : fn.body;
}

function walkBody(fn: FunctionLikeNode | ts.ClassDeclaration, visit: (node: ts.Node) => void): void {
  const body = bodyOf(fn);
  if (body) {
    visit(body);
  }
}

/** All `propsName.propName` accesses inside `fn`'s body. */
export function findPropsAccesses(
  fn: FunctionLikeNode,
  propsName: string,
  propName: string
): ts.PropertyAccessExpression[] {
  const out: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === propName &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === propsName
    ) {
      out.push(node);
    }
    node.forEachChild(visit);
  };
  walkBody(fn, visit);
  return out;
}

/** All `this.props.propName` accesses inside a class component. */
export function findThisPropsAccesses(
  cls: ts.ClassDeclaration,
  propName: string
): ts.PropertyAccessExpression[] {
  const out: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === propName &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === 'props'
    ) {
      out.push(node);
    }
    node.forEachChild(visit);
  };
  visit(cls);
  return out;
}

/** `const { x } = props;` inside the body — returns the binding element for propName. */
export function findBodyDestructure(
  fn: FunctionLikeNode,
  propsName: string,
  propName: string
): ts.BindingElement | undefined {
  let found: ts.BindingElement | undefined;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      node.initializer.text === propsName &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const el of node.name.elements) {
        const key = el.propertyName ? el.propertyName.getText() : el.name.getText();
        if (key === propName) {
          found = el;
          return;
        }
      }
    }
    node.forEachChild(visit);
  };
  walkBody(fn, visit);
  return found;
}

/** Is `propsName` forwarded wholesale via `<X {...props} />` somewhere in the body? */
export function findJsxSpreadOf(
  fn: FunctionLikeNode,
  propsName: string
): ts.JsxSpreadAttribute | undefined {
  let found: ts.JsxSpreadAttribute | undefined;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      ts.isJsxSpreadAttribute(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === propsName
    ) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  walkBody(fn, visit);
  return found;
}

export type ExpressionMatcher = (expr: ts.Expression) => boolean;

/** Matches expressions whose root identifiers include `name` (e.g. `user`, `user.name`). */
export function identifierMatcher(name: string): ExpressionMatcher {
  return (expr) => rootIdentifiers(expr).some((id) => id.text === name);
}

/** Matches expressions containing a `propsName.propName` access. */
export function propsAccessMatcher(propsName: string, propName: string): ExpressionMatcher {
  return (expr) => {
    let hit = false;
    const visit = (node: ts.Node): void => {
      if (hit) {
        return;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === propName &&
        node.expression.getText() === propsName
      ) {
        hit = true;
        return;
      }
      node.forEachChild(visit);
    };
    visit(expr);
    return hit;
  };
}

export interface RePassSites {
  attributes: ts.JsxAttribute[];
  spreads: ts.JsxSpreadAttribute[];
}

/** JSX attributes/spreads inside `fn` whose value matches — i.e. the prop drilled onward. */
export function findRePassSites(
  fn: FunctionLikeNode | ts.ClassDeclaration,
  matcher: ExpressionMatcher
): RePassSites {
  const attributes: ts.JsxAttribute[] = [];
  const spreads: ts.JsxSpreadAttribute[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const expr = attrValueExpression(node);
      if (expr && !isLiteralExpression(expr) && matcher(expr)) {
        attributes.push(node);
      }
    } else if (ts.isJsxSpreadAttribute(node) && matcher(node.expression)) {
      spreads.push(node);
    }
    node.forEachChild(visit);
  };
  walkBody(fn, visit);
  return { attributes, spreads };
}
