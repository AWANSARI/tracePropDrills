import * as vscode from 'vscode';
import * as ts from 'typescript';
import { LanguageTracer } from './LanguageTracer';
import { TraceNode, TraceResult } from '../types';
import {
  FunctionLikeNode,
  JsxOpeningLike,
  anyMatcher,
  attrName,
  attrValueExpression,
  attributeElement,
  componentAt,
  enclosingComponent,
  enclosingJsxAttribute,
  findBodyDestructure,
  findComponentByName,
  findDeclaration,
  findJsxSpreadOf,
  findNodeAtOffset,
  findPropsAccesses,
  findRePassSites,
  findThisPropsAccesses,
  functionName,
  getAttribute,
  getSpreadAttributes,
  identifierMatcher,
  isComponentTagName,
  isFunctionLike,
  isLiteralExpression,
  jsxTagFromNode,
  locationOf,
  owningVariableDeclaration,
  parse,
  propsAccessMatcher,
  propsAliasFromDeclaration,
  rootIdentifiers,
  snippetOf,
  spreadAttributeElement,
  tagNameOf,
  ExpressionMatcher,
} from './ast';
import {
  findDefinitions,
  findReferences,
  isSupportedFile,
  pickComponentDefinition,
} from './resolve';

const SUPPORTED_LANGUAGES = new Set([
  'javascript',
  'javascriptreact',
  'typescript',
  'typescriptreact',
]);

/** How many `const c = a` redefine hops to follow when classifying origins. */
const MAX_UPSTREAM_CHAIN = 3;

/** Static React prop tracing (Phase 1). See LanguageTracer for the language seam. */
export class ReactTracer implements LanguageTracer {
  supports(languageId: string): boolean {
    return SUPPORTED_LANGUAGES.has(languageId);
  }

  async trace(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<TraceResult | undefined> {
    const maxDepth = vscode.workspace
      .getConfiguration('reactPropTracer')
      .get<number>('maxDepth', 8);
    return new TraceSession(maxDepth).run(document, position);
  }
}

interface OpenedFile {
  doc: vscode.TextDocument;
  sf: ts.SourceFile;
}

/** How a component under the cursor binds the prop we started from (case 3). */
interface ChildPropBinding {
  propName: string;
  fn: FunctionLikeNode;
  componentName: ts.Identifier;
  bindingNode: ts.Node;
  receptionKind: 'received-param' | 'props-access';
  alias?: string;
  matcher: ExpressionMatcher;
}

/**
 * One trace = one session. Holds the per-trace id counter, warnings, and a
 * parse cache so multi-hop traces do not re-read/re-parse files.
 */
class TraceSession {
  private nextId = 0;
  private readonly warnings: string[] = [];
  private readonly files = new Map<string, OpenedFile>();

  constructor(private readonly maxDepth: number) {}

  async run(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<TraceResult | undefined> {
    const sf = parse(document.uri.fsPath, document.getText());
    this.files.set(document.uri.toString(), { doc: document, sf });

    const offset = document.offsetAt(position);
    const node = findNodeAtOffset(sf, offset);
    if (!node) {
      return undefined;
    }

    // Case 1: cursor on a JSX attribute name or inside its value expression.
    const attr = enclosingJsxAttribute(node);
    if (attr) {
      return this.traceAttribute(document, sf, attr);
    }

    // Case 2: cursor on a component tag — trace every prop of the element.
    const tag = jsxTagFromNode(node);
    if (tag) {
      return this.traceElement(document, sf, tag);
    }

    // Case 3: cursor inside a component's own props (destructured binding,
    // `props.x` access, or a body identifier that resolves to a prop).
    const binding = this.classifyChildProp(sf, node);
    if (binding) {
      return this.traceFromChild(document, sf, binding);
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // Node construction helpers
  // -------------------------------------------------------------------------

  private node(partial: Omit<TraceNode, 'id' | 'children'> & { children?: TraceNode[] }): TraceNode {
    return { id: `n${this.nextId++}`, children: [], ...partial };
  }

  private unresolvedNode(
    label: string,
    reason: string,
    direction: TraceNode['direction'],
    sf: ts.SourceFile,
    at: ts.Node,
    valueText?: string
  ): TraceNode {
    return this.node({
      label,
      kind: 'unresolved',
      direction,
      location: locationOf(sf, at),
      snippet: snippetOf(sf, at),
      valueText,
      unresolvedReason: reason,
    });
  }

  private result(root: TraceNode): TraceResult {
    return { root, generatedAt: Date.now(), warnings: this.warnings };
  }

  private async open(uri: vscode.Uri): Promise<OpenedFile> {
    const key = uri.toString();
    let entry = this.files.get(key);
    if (!entry) {
      const doc = await vscode.workspace.openTextDocument(uri);
      entry = { doc, sf: parse(uri.fsPath, doc.getText()) };
      this.files.set(key, entry);
    }
    return entry;
  }

  // -------------------------------------------------------------------------
  // Case 1: <Child value={count} /> with cursor on `value` or `count`
  // -------------------------------------------------------------------------

  private async traceAttribute(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    attr: ts.JsxAttribute
  ): Promise<TraceResult> {
    const element = attributeElement(attr);
    const propName = attrName(attr);
    const valueExpr = attrValueExpression(attr);

    const root = this.node({
      label: propName,
      kind: 'selection',
      direction: 'selection',
      location: locationOf(sf, attr),
      snippet: snippetOf(sf, attr),
      valueText: valueExpr?.getText(sf),
    });

    root.children.push(...(await this.upstreamForExpression(doc, sf, valueExpr, true)));

    const downstream = await this.downstreamForElement(doc, sf, element, propName, 0, new Set());
    if (downstream) {
      root.children.push(downstream);
    }
    return this.result(root);
  }

  // -------------------------------------------------------------------------
  // Case 2: cursor on the component tag — trace all attributes
  // -------------------------------------------------------------------------

  private async traceElement(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    element: JsxOpeningLike
  ): Promise<TraceResult> {
    const tag = tagNameOf(element);
    const root = this.node({
      label: `<${tag}>`,
      kind: 'selection',
      direction: 'selection',
      location: locationOf(sf, element.tagName),
      snippet: snippetOf(sf, element),
    });

    for (const prop of element.attributes.properties) {
      if (ts.isJsxAttribute(prop)) {
        const propName = attrName(prop);
        const valueExpr = attrValueExpression(prop);
        const child = this.node({
          label: propName,
          kind: 'selection',
          direction: 'selection',
          location: locationOf(sf, prop),
          snippet: snippetOf(sf, prop),
          valueText: valueExpr?.getText(sf),
        });
        child.children.push(...(await this.upstreamForExpression(doc, sf, valueExpr, true)));
        const downstream = await this.downstreamForElement(doc, sf, element, propName, 0, new Set());
        if (downstream) {
          child.children.push(downstream);
        }
        root.children.push(child);
      } else {
        // {...rest} — we cannot know which props travel through. Degrade
        // gracefully with a labeled unresolved node instead of guessing.
        const exprText = prop.expression.getText(sf);
        root.children.push(
          this.unresolvedNode(`{...${exprText}}`, 'spread props', 'downstream', sf, prop, exprText)
        );
      }
    }

    if (root.children.length === 0) {
      root.children.push(
        this.unresolvedNode(`<${tag}>`, 'element has no props to trace', 'downstream', sf, element)
      );
    }
    return this.result(root);
  }

  // -------------------------------------------------------------------------
  // Case 3: cursor inside the receiving component's props
  // -------------------------------------------------------------------------

  private classifyChildProp(sf: ts.SourceFile, node: ts.Node): ChildPropBinding | undefined {
    if (!ts.isIdentifier(node)) {
      return undefined;
    }

    // `props.value` with the cursor on `value`.
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isIdentifier(parent.expression)) {
      const decl = findDeclaration(parent.expression, parent.expression.text);
      if (decl?.kind === 'param' && !decl.bindingElement) {
        const owner = this.componentOwningParam(decl.fn, decl.param);
        if (owner) {
          return {
            propName: node.text,
            fn: decl.fn,
            componentName: owner,
            bindingNode: parent,
            receptionKind: 'props-access',
            matcher: propsAccessMatcher(parent.expression.text, node.text),
          };
        }
      }
    }

    // Cursor directly on a binding element name — either a destructured
    // param (`function C({ value })`) or a body rebind (`const { a } = props`).
    if (ts.isBindingElement(parent)) {
      const paramDecl = this.bindingElementDecl(parent);
      if (paramDecl) {
        return this.childBindingFromParam(sf, paramDecl);
      }
      const varDecl = owningVariableDeclaration(parent);
      if (varDecl && ts.isIdentifier(parent.name)) {
        const derived = this.propsDerivation(varDecl, parent.name.text);
        if (derived) {
          return this.childBindingFromDerivation(derived);
        }
      }
      return undefined;
    }

    // Cursor on a body identifier: resolve its declaration — a destructured
    // param, or a variable that rebinds a prop (`const { a } = props`,
    // `const x = props.a`).
    const decl = findDeclaration(node, node.text);
    if (decl?.kind === 'param' && decl.bindingElement) {
      return this.childBindingFromParam(sf, decl);
    }
    if (decl?.kind === 'variable') {
      const derived = this.propsDerivation(decl.node, node.text);
      if (derived) {
        return this.childBindingFromDerivation(derived);
      }
    }
    return undefined;
  }

  private childBindingFromParam(
    sf: ts.SourceFile,
    decl: { fn: FunctionLikeNode; param: ts.ParameterDeclaration; bindingElement?: ts.BindingElement }
  ): ChildPropBinding | undefined {
    if (!decl.bindingElement) {
      return undefined;
    }
    const owner = this.componentOwningParam(decl.fn, decl.param);
    if (!owner) {
      return undefined;
    }
    const el = decl.bindingElement;
    const local = el.name.getText(sf);
    const propName = el.propertyName ? el.propertyName.getText(sf) : local;
    return {
      propName,
      fn: decl.fn,
      componentName: owner,
      bindingNode: el,
      receptionKind: 'received-param',
      alias: el.propertyName ? local : undefined,
      matcher: identifierMatcher(local),
    };
  }

  /** Wrap a binding element the cursor sits on as a DeclInfo-shaped result. */
  private bindingElementDecl(
    el: ts.BindingElement
  ): { kind: 'param'; fn: FunctionLikeNode; param: ts.ParameterDeclaration; bindingElement: ts.BindingElement } | undefined {
    let cur: ts.Node | undefined = el;
    while (cur && !ts.isSourceFile(cur)) {
      if (ts.isParameter(cur)) {
        const fn = cur.parent;
        if (isFunctionLike(fn)) {
          return { kind: 'param', fn, param: cur, bindingElement: el };
        }
        return undefined;
      }
      if (isFunctionLike(cur)) {
        return undefined; // binding belongs to a body statement, not a param
      }
      cur = cur.parent;
    }
    return undefined;
  }

  /** The component name identifier, if `param` is the props param of a component. */
  private componentOwningParam(
    fn: FunctionLikeNode,
    param: ts.ParameterDeclaration
  ): ts.Identifier | undefined {
    if (fn.parameters[0] !== param) {
      return undefined;
    }
    const name = functionName(fn);
    return name && /^[A-Z]/.test(name.text) ? name : undefined;
  }

  /**
   * If a variable declaration rebinds a prop out of a component's props
   * object — `const { a } = props`, `const { a: x } = props`, or
   * `const x = props.a` — resolve which component and prop it came from.
   * This is what keeps the drill chain intact across renames/redefines.
   */
  private propsDerivation(
    decl: ts.VariableDeclaration,
    matchName: string
  ):
    | {
        owner: ts.Identifier;
        fn: FunctionLikeNode;
        propName: string;
        localName: string;
        bindingNode: ts.Node;
      }
    | undefined {
    const alias = propsAliasFromDeclaration(decl, matchName);
    if (!alias) {
      return undefined;
    }
    const propsDecl = findDeclaration(alias.propsIdentifier, alias.propsIdentifier.text);
    if (propsDecl?.kind !== 'param' || propsDecl.bindingElement) {
      return undefined;
    }
    const owner = this.componentOwningParam(propsDecl.fn, propsDecl.param);
    if (!owner) {
      return undefined;
    }
    return {
      owner,
      fn: propsDecl.fn,
      propName: alias.propName,
      localName: alias.localName,
      bindingNode: alias.bindingNode,
    };
  }

  private childBindingFromDerivation(derived: {
    owner: ts.Identifier;
    fn: FunctionLikeNode;
    propName: string;
    localName: string;
    bindingNode: ts.Node;
  }): ChildPropBinding {
    return {
      propName: derived.propName,
      fn: derived.fn,
      componentName: derived.owner,
      bindingNode: derived.bindingNode,
      receptionKind: 'received-param',
      alias: derived.localName !== derived.propName ? derived.localName : undefined,
      matcher: identifierMatcher(derived.localName),
    };
  }

  private async traceFromChild(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    binding: ChildPropBinding
  ): Promise<TraceResult> {
    const componentName = binding.componentName.text;
    const root = this.node({
      label: `${binding.propName} (in <${componentName}>)`,
      kind: 'selection',
      direction: 'selection',
      location: locationOf(sf, binding.bindingNode),
      snippet: snippetOf(sf, binding.bindingNode),
    });

    // Upstream: parent JSX call sites that pass this prop in.
    const parents = await this.parentPassSites(doc, sf, binding.fn, componentName, binding.propName);
    if (parents.length > 0) {
      root.children.push(...parents);
    } else {
      root.children.push(
        this.unresolvedNode(
          componentName,
          'no parent call sites found (the TS server may still be warming up)',
          'upstream',
          sf,
          binding.componentName
        )
      );
    }

    // Downstream: how this component holds the prop, and where it drills it.
    const label =
      binding.receptionKind === 'received-param'
        ? binding.alias
          ? `${binding.propName} → ${binding.alias}`
          : binding.propName
        : `props.${binding.propName}`;
    const reception = this.node({
      label,
      kind: binding.receptionKind,
      direction: 'downstream',
      location: locationOf(sf, binding.bindingNode),
      snippet: snippetOf(sf, binding.bindingNode),
    });
    const selfKey = `${doc.uri.fsPath}#${componentName}`;
    reception.children.push(
      ...(await this.rePassNodes(doc, sf, binding.fn, binding.matcher, 0, new Set([selfKey])))
    );
    root.children.push(reception);

    return this.result(root);
  }

  /**
   * Whether an initializer is a simple derivation worth chaining through.
   * Calls (`getUser()`), functions, JSX, and literals are origins in their
   * own right — chaining into them would be noise.
   */
  private isChainable(expr: ts.Expression): boolean {
    return !(
      ts.isCallExpression(expr) ||
      ts.isNewExpression(expr) ||
      ts.isArrowFunction(expr) ||
      ts.isFunctionExpression(expr) ||
      ts.isClassExpression(expr) ||
      ts.isJsxElement(expr) ||
      ts.isJsxSelfClosingElement(expr) ||
      ts.isJsxFragment(expr) ||
      isLiteralExpression(expr)
    );
  }

  // -------------------------------------------------------------------------
  // Upstream (origin) resolution
  // -------------------------------------------------------------------------

  private async upstreamForExpression(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    expr: ts.Expression | undefined,
    allowParentHop: boolean
  ): Promise<TraceNode[]> {
    if (!expr || isLiteralExpression(expr)) {
      return []; // a literal is its own origin; the selection row shows it
    }
    const identifiers = rootIdentifiers(expr).slice(0, 6);
    const nodes: TraceNode[] = [];
    for (const identifier of identifiers) {
      nodes.push(await this.traceUpstreamIdentifier(doc, sf, identifier, allowParentHop));
    }
    return nodes;
  }

  private async traceUpstreamIdentifier(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    identifier: ts.Identifier,
    allowParentHop: boolean,
    chainDepth = 0
  ): Promise<TraceNode> {
    const name = identifier.text;
    const decl = findDeclaration(identifier, name);

    if (!decl) {
      // Nothing lexically in this file — ask the definition provider (it may
      // be a global, an ambient declaration, or something we did not model).
      const defs = await findDefinitions(doc.uri, doc.positionAt(identifier.getStart(sf)));
      const def = defs.find((d) => isSupportedFile(d.uri.fsPath));
      if (def) {
        const target = await this.open(def.uri);
        const targetNode =
          findNodeAtOffset(target.sf, target.doc.offsetAt(def.range.start)) ?? target.sf;
        return this.node({
          label: name,
          kind: 'local-variable',
          direction: 'upstream',
          location: locationOf(target.sf, targetNode),
          snippet: snippetOf(target.sf, targetNode),
        });
      }
      return this.unresolvedNode(
        name,
        `could not find a declaration for '${name}'`,
        'upstream',
        sf,
        identifier
      );
    }

    switch (decl.kind) {
      case 'variable': {
        // Rebind of a prop? `const { a } = props` / `const { a: x } = props`
        // / `const x = props.a` — classify as from-parent-prop so the drill
        // chain survives the rename instead of dead-ending at a "local".
        const derived = this.propsDerivation(decl.node, name);
        if (derived) {
          const node = this.node({
            label: `${name} (prop '${derived.propName}' of <${derived.owner.text}>)`,
            kind: 'from-parent-prop',
            direction: 'upstream',
            location: locationOf(sf, derived.bindingNode),
            snippet: snippetOf(sf, derived.bindingNode),
            valueText: derived.propName !== name ? `props.${derived.propName} → ${name}` : undefined,
          });
          if (allowParentHop) {
            node.children.push(
              ...(await this.parentPassSites(doc, sf, derived.fn, derived.owner.text, derived.propName))
            );
          }
          return node;
        }

        const kind =
          decl.hookName === undefined
            ? 'local-variable'
            : decl.hookName === 'useState'
              ? 'state-hook'
              : 'hook';
        const variableNode = this.node({
          label: decl.hookName ? `${name} · ${decl.hookName}` : name,
          kind,
          direction: 'upstream',
          location: locationOf(sf, decl.node),
          snippet: snippetOf(sf, decl.node),
          valueText: decl.node.initializer?.getText(sf).slice(0, 80),
        });

        // Redefine chaining: `const doubled = a + a` should still lead back
        // to wherever `a` came from. Hooks and calls are origins in their own
        // right, so only simple derivations chain, bounded by depth.
        const init = decl.node.initializer;
        if (!decl.hookName && init && chainDepth < MAX_UPSTREAM_CHAIN && this.isChainable(init)) {
          for (const rootId of rootIdentifiers(init).slice(0, 4)) {
            if (rootId.text === name) {
              continue;
            }
            variableNode.children.push(
              await this.traceUpstreamIdentifier(doc, sf, rootId, allowParentHop, chainDepth + 1)
            );
          }
        }
        return variableNode;
      }

      case 'function':
        return this.node({
          label: name,
          kind: 'local-variable',
          direction: 'upstream',
          location: locationOf(sf, decl.node.name ?? decl.node),
          snippet: snippetOf(sf, decl.node),
        });

      case 'import': {
        // Refine the location through the definition provider so clicking the
        // node jumps to the real declaration, not just the import line.
        let location = locationOf(sf, decl.node);
        let snippet = snippetOf(sf, decl.node);
        const defs = await findDefinitions(doc.uri, doc.positionAt(identifier.getStart(sf)));
        const def = defs.find(
          (d) => isSupportedFile(d.uri.fsPath) && !d.uri.fsPath.includes('node_modules')
        );
        if (def && def.uri.toString() !== doc.uri.toString()) {
          const target = await this.open(def.uri);
          const targetNode =
            findNodeAtOffset(target.sf, target.doc.offsetAt(def.range.start)) ?? target.sf;
          location = locationOf(target.sf, targetNode);
          snippet = snippetOf(target.sf, targetNode);
        }
        return this.node({
          label: name,
          kind: 'import',
          direction: 'upstream',
          location,
          snippet,
          valueText: `from '${decl.module}'`,
        });
      }

      case 'param': {
        const owner = this.componentOwningParam(decl.fn, decl.param);
        if (!owner) {
          return this.node({
            label: `${name} (function parameter)`,
            kind: 'local-variable',
            direction: 'upstream',
            location: locationOf(sf, decl.node),
            snippet: snippetOf(sf, decl.node),
          });
        }
        // The value is itself a prop of the enclosing component — hop one
        // level up to the parent call sites (bounded to a single level).
        const propKey = decl.bindingElement?.propertyName?.getText(sf) ?? name;
        const node = this.node({
          label: `${name} (prop of <${owner.text}>)`,
          kind: 'from-parent-prop',
          direction: 'upstream',
          location: locationOf(sf, decl.node),
          snippet: snippetOf(sf, decl.node),
        });
        if (allowParentHop) {
          node.children.push(...(await this.parentPassSites(doc, sf, decl.fn, owner.text, propKey)));
        }
        return node;
      }
    }
  }

  /**
   * Find parent JSX call sites of `componentName` (via the reference
   * provider) and, for each `<Component propName={expr}>`, emit an upstream
   * node whose children classify `expr` in the parent's file. Bounded: the
   * children never hop further up.
   */
  private async parentPassSites(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    fn: FunctionLikeNode,
    componentName: string,
    propName: string
  ): Promise<TraceNode[]> {
    const nameNode = functionName(fn);
    if (!nameNode) {
      return [];
    }
    const refs = await findReferences(doc.uri, doc.positionAt(nameNode.getStart(sf)));
    const out: TraceNode[] = [];
    const seenElements = new Set<string>();

    for (const ref of refs) {
      if (out.length >= 10) {
        this.warnings.push(`Stopped after 10 call sites of <${componentName}>.`);
        break;
      }
      if (!isSupportedFile(ref.uri.fsPath)) {
        continue;
      }
      const { doc: refDoc, sf: refSf } = await this.open(ref.uri);
      const refNode = findNodeAtOffset(refSf, refDoc.offsetAt(ref.range.start));
      const element = jsxTagFromNode(refNode);
      if (!element) {
        continue; // the definition itself, an import line, etc.
      }
      const key = `${ref.uri.fsPath}#${element.getStart(refSf)}`;
      if (seenElements.has(key)) {
        continue; // opening + closing tag both reference the symbol
      }
      seenElements.add(key);

      const parentComponent = enclosingComponent(element)?.name.text;
      const attr = getAttribute(element, propName);
      if (attr) {
        const expr = attrValueExpression(attr);
        const passNode = this.node({
          label: parentComponent ? `${propName} from <${parentComponent}>` : propName,
          kind: 'from-parent-prop',
          direction: 'upstream',
          location: locationOf(refSf, attr),
          snippet: snippetOf(refSf, attr),
          valueText: expr?.getText(refSf),
        });
        passNode.children.push(...(await this.upstreamForExpression(refDoc, refSf, expr, false)));
        out.push(passNode);
      } else if (getSpreadAttributes(element).length > 0) {
        out.push(
          this.unresolvedNode(
            parentComponent ? `<${componentName}> in <${parentComponent}>` : `<${componentName}>`,
            'spread props at call site',
            'upstream',
            refSf,
            element
          )
        );
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Downstream (destination) resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve the element's tag to its component definition and describe how
   * that component receives `propName` (and drills it further). Returns
   * undefined for host/DOM tags.
   */
  private async downstreamForElement(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    element: JsxOpeningLike,
    propName: string,
    depth: number,
    visited: ReadonlySet<string>
  ): Promise<TraceNode | undefined> {
    const tag = tagNameOf(element);
    if (!isComponentTagName(tag)) {
      return undefined;
    }
    if (depth >= this.maxDepth) {
      return this.unresolvedNode(
        tag,
        `max depth (${this.maxDepth}) reached`,
        'downstream',
        sf,
        element
      );
    }

    const shortName = tag.split('.').pop() ?? tag;
    const tagPosition = doc.positionAt(element.tagName.getStart(sf));
    const defs = await findDefinitions(doc.uri, tagPosition);
    const picked = pickComponentDefinition(defs);

    let target:
      | { doc: vscode.TextDocument; sf: ts.SourceFile; component: FunctionLikeNode | ts.ClassDeclaration }
      | undefined;

    if (picked) {
      if (picked.uri.fsPath.endsWith('.d.ts')) {
        return this.unresolvedNode(
          tag,
          'resolves to a type declaration (library component)',
          'downstream',
          sf,
          element
        );
      }
      const opened = await this.open(picked.uri);
      const component =
        componentAt(opened.sf, opened.doc.offsetAt(picked.range.start)) ??
        findComponentByName(opened.sf, shortName);
      if (component) {
        target = { doc: opened.doc, sf: opened.sf, component };
      }
    }

    // Fallback: the TS server may still be starting (or unavailable in
    // tests) — same-file components can always be found by a local scan.
    if (!target) {
      const component = findComponentByName(sf, shortName);
      if (component) {
        target = { doc, sf, component };
      }
    }

    if (!target) {
      return this.unresolvedNode(
        tag,
        `definition of <${tag}> not found`,
        'downstream',
        sf,
        element
      );
    }

    const key = `${target.doc.uri.fsPath}#${shortName}`;
    if (visited.has(key)) {
      return this.unresolvedNode(tag, 'cycle detected — already traced', 'downstream', sf, element);
    }
    const nextVisited = new Set(visited);
    nextVisited.add(key);

    const nameNode = functionName(target.component) ?? target.component;
    const definitionNode = this.node({
      label: shortName,
      kind: 'component-definition',
      direction: 'downstream',
      location: locationOf(target.sf, nameNode),
      snippet: snippetOf(target.sf, target.component),
    });
    if (propName) {
      definitionNode.children.push(
        ...(await this.receptionNodes(target.doc, target.sf, target.component, shortName, propName, depth, nextVisited))
      );
    }
    return definitionNode;
  }

  /** How does `component` receive `propName`? (destructured / props.x / spread / not at all) */
  private async receptionNodes(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    component: FunctionLikeNode | ts.ClassDeclaration,
    componentName: string,
    propName: string,
    depth: number,
    visited: ReadonlySet<string>
  ): Promise<TraceNode[]> {
    if (ts.isClassDeclaration(component)) {
      const accesses = findThisPropsAccesses(component, propName);
      if (accesses.length === 0) {
        return [
          this.unresolvedNode(
            `this.props.${propName}`,
            `'this.props.${propName}' not found in class <${componentName}>`,
            'downstream',
            sf,
            component.name ?? component
          ),
        ];
      }
      const node = this.node({
        label: `this.props.${propName}`,
        kind: 'props-access',
        direction: 'downstream',
        location: locationOf(sf, accesses[0]),
        snippet: snippetOf(sf, accesses[0]),
      });
      node.children.push(
        ...(await this.rePassNodes(doc, sf, component, propsAccessMatcher('this.props', propName), depth, visited))
      );
      return [node];
    }

    const param = component.parameters[0];
    if (!param) {
      return [
        this.unresolvedNode(
          componentName,
          `<${componentName}> declares no props parameter`,
          'downstream',
          sf,
          component
        ),
      ];
    }

    // function Child({ value }) / function Child({ label: text })
    if (ts.isObjectBindingPattern(param.name)) {
      let rest: ts.BindingElement | undefined;
      for (const el of param.name.elements) {
        if (el.dotDotDotToken) {
          rest = el;
          continue;
        }
        const local = el.name.getText(sf);
        const key = el.propertyName ? el.propertyName.getText(sf) : local;
        if (key !== propName) {
          continue;
        }
        const alias = el.propertyName ? local : undefined;
        const node = this.node({
          label: alias ? `${propName} → ${alias}` : propName,
          kind: 'received-param',
          direction: 'downstream',
          location: locationOf(sf, el),
          snippet: snippetOf(sf, el),
          valueText: alias ? `renamed to '${alias}'` : undefined,
        });
        if (ts.isIdentifier(el.name)) {
          node.children.push(
            ...(await this.rePassNodes(doc, sf, component, identifierMatcher(el.name.text), depth, visited))
          );
        }
        return [node];
      }
      if (rest) {
        return [
          this.unresolvedNode(
            `...${rest.name.getText(sf)}`,
            `'${propName}' lands in a rest spread`,
            'downstream',
            sf,
            rest
          ),
        ];
      }
      return [
        this.unresolvedNode(
          propName,
          `<${componentName}> does not declare prop '${propName}'`,
          'downstream',
          sf,
          param
        ),
      ];
    }

    // function Child(props) { ... props.value ... }
    if (ts.isIdentifier(param.name)) {
      const propsName = param.name.text;

      const accesses = findPropsAccesses(component, propsName, propName);
      if (accesses.length > 0) {
        // `const heading = props.title` — track the rebound names too, so
        // passing `heading` onward still counts as drilling `title`.
        const aliasNames: string[] = [];
        for (const access of accesses) {
          const holder = access.parent;
          if (
            ts.isVariableDeclaration(holder) &&
            holder.initializer === access &&
            ts.isIdentifier(holder.name)
          ) {
            aliasNames.push(holder.name.text);
          }
        }
        const matcher =
          aliasNames.length > 0
            ? anyMatcher(
                propsAccessMatcher(propsName, propName),
                ...aliasNames.map((alias) => identifierMatcher(alias))
              )
            : propsAccessMatcher(propsName, propName);
        const node = this.node({
          label: `${propsName}.${propName}`,
          kind: 'props-access',
          direction: 'downstream',
          location: locationOf(sf, accesses[0]),
          snippet: snippetOf(sf, accesses[0]),
          valueText: aliasNames.length > 0 ? `rebound as '${aliasNames.join("', '")}'` : undefined,
        });
        node.children.push(...(await this.rePassNodes(doc, sf, component, matcher, depth, visited)));
        return [node];
      }

      // const { value } = props; inside the body
      const bodyBinding = findBodyDestructure(component, propsName, propName);
      if (bodyBinding) {
        const local = bodyBinding.name.getText(sf);
        const node = this.node({
          label: bodyBinding.propertyName ? `${propName} → ${local}` : propName,
          kind: 'received-param',
          direction: 'downstream',
          location: locationOf(sf, bodyBinding),
          snippet: snippetOf(sf, bodyBinding),
        });
        if (ts.isIdentifier(bodyBinding.name)) {
          node.children.push(
            ...(await this.rePassNodes(doc, sf, component, identifierMatcher(local), depth, visited))
          );
        }
        return [node];
      }

      // <Grandchild {...props} /> — forwarded wholesale.
      const forwarded = findJsxSpreadOf(component, propsName);
      if (forwarded) {
        return [
          this.unresolvedNode(
            `{...${propsName}}`,
            'spread props',
            'downstream',
            sf,
            forwarded,
            propsName
          ),
        ];
      }

      return [
        this.unresolvedNode(
          propName,
          `'${propName}' is not referenced inside <${componentName}>`,
          'downstream',
          sf,
          param
        ),
      ];
    }

    return [
      this.unresolvedNode(
        componentName,
        'unsupported props parameter shape',
        'downstream',
        sf,
        param
      ),
    ];
  }

  /**
   * JSX attributes inside `component` whose value uses the received prop —
   * i.e. the prop being drilled onward — each recursing downstream into the
   * next component.
   */
  private async rePassNodes(
    doc: vscode.TextDocument,
    sf: ts.SourceFile,
    component: FunctionLikeNode | ts.ClassDeclaration,
    matcher: ExpressionMatcher,
    depth: number,
    visited: ReadonlySet<string>
  ): Promise<TraceNode[]> {
    const { attributes, spreads } = findRePassSites(component, matcher);
    const out: TraceNode[] = [];

    for (const attr of attributes) {
      const element = attributeElement(attr);
      const childTag = tagNameOf(element);
      const expr = attrValueExpression(attr);
      const node = this.node({
        label: `${attrName(attr)} → <${childTag}>`,
        kind: 're-passed-prop',
        direction: 'downstream',
        location: locationOf(sf, attr),
        snippet: snippetOf(sf, attr),
        valueText: expr?.getText(sf),
      });
      const deeper = await this.downstreamForElement(doc, sf, element, attrName(attr), depth + 1, visited);
      if (deeper) {
        node.children.push(deeper);
      }
      out.push(node);
    }

    for (const spread of spreads) {
      const element = spreadAttributeElement(spread);
      out.push(
        this.unresolvedNode(
          `{...${spread.expression.getText(sf)}} → <${tagNameOf(element)}>`,
          'spread props',
          'downstream',
          sf,
          spread,
          spread.expression.getText(sf)
        )
      );
    }
    return out;
  }
}
