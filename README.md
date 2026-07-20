# React Prop Tracer

A VS Code extension that traces a React prop's flow from where you are standing:

- **Upstream (Origin ↑)** — where the value passed into the prop comes from:
  a `useState`/`useMemo`/`useContext` hook, a local variable, a function param
  that is itself a prop (with a bounded hop up to parent call sites), or an
  import.
- **Downstream (Flows into ↓)** — the target component's definition, how it
  receives the prop (destructured param, alias, or `props.x`), and every
  component it drills the prop into, recursively.

The result renders as a collapsible tree in a dockable **Prop Tracer** view.
Every node is clickable and jumps to the exact `file:line:col` in the editor.

## Prerequisites

- Node.js 18+
- VS Code 1.85+

## Getting started

```bash
npm install
npm run watch     # or: npm run compile (one-shot)
```

Open this folder in VS Code and press **F5** — an Extension Development Host
window launches with the extension loaded (F5 also runs `npm: compile` as a
pre-launch task, so `watch` is optional).

In the dev host, open `samples/` (e.g. `A_state_origin.tsx`), place the cursor
on a prop, and run the trace:

- Command Palette → **React Prop Tracer: Trace Prop at Cursor**
- Keybinding: `Ctrl+Alt+T` (`Cmd+Alt+T` on macOS)
- Editor right-click → **React Prop Tracer: Trace Prop at Cursor**

Three cursor placements are recognized:

1. **On a JSX attribute** (`<Child value={count} />`, cursor on `value` or
   `count`) — traces that one prop both ways.
2. **On a component tag** (cursor on `Child`) — traces all props of the
   element.
3. **Inside the receiving component's props** (`{ value }` in the params, a
   `props.value` access, or a body rebind like `const { value } = props` /
   `const v = props.value`) — traces upstream to parent call sites and
   downstream to any further drilling.

Rebinds and redefines are followed in both directions: a prop extracted in
the body (`const { a } = props`), renamed (`const { a: x } = props`,
`const heading = props.title`), or derived (`const doubled = a + a`) is still
recognized as coming from the parent, and passing the rebound name onward
still counts as drilling the original prop.

Other commands: **Refresh Last Trace** (also the Refresh button in the view's
toolbar) and **Clear Trace**.

> Note: the sample files intentionally do not install React; a small ambient
> shim (`samples/react-shim.d.ts`) keeps the TS server quiet. Any red
> squiggles that remain do not affect tracing — the tracer parses source
> directly and only uses the TS server for go-to-definition/references.

## Moving the view (left / right / bottom)

The **Trace** view is a contributed webview view, so it inherits VS Code's
standard drag-and-drop between regions:

- It starts in the **bottom panel** (look for the Prop Tracer icon).
- Drag its tab into the **primary sidebar** (left) or **secondary sidebar**
  (right) to dock it there; drag it back to the panel at any time.

## How it works

```
src/
├─ extension.ts          activate(): commands + view registration; picks a
│                        tracer by document.languageId
├─ TraceViewProvider.ts  WebviewViewProvider; strict CSP; reveal/refresh
│                        message handling
├─ types.ts              TraceNode/TraceResult + message contracts
├─ tracer/
│  ├─ LanguageTracer.ts  interface — the language extensibility seam
│  ├─ ReactTracer.ts     the React implementation (upstream + downstream)
│  ├─ ast.ts             TypeScript Compiler API helpers (no vscode imports)
│  └─ resolve.ts         wrappers over executeDefinitionProvider /
│                        executeReferenceProvider
└─ debug/
   └─ DebugTracer.ts     Phase 2 stub (runtime values via DAP)
```

Cross-file symbol resolution goes through VS Code's built-in
`vscode.executeDefinitionProvider` / `vscode.executeReferenceProvider`
commands, i.e. the TypeScript language server that is already running. Module
resolution, path aliases, and re-exports are never reimplemented. When the
provider has no answer (server still warming up), same-file components are
found by a local AST scan as a fallback.

Unhandled React patterns — spreads, HOC wrappers resolving into `.d.ts`,
dynamic tags, missing definitions — never throw; each surfaces as a labeled
`unresolved` node with a short reason and the branch stops cleanly.

### Deviations from the build spec

- Files are parsed with a per-extension `ScriptKind` (TSX for `.tsx`, TS for
  `.ts`, JSX for `.js`/`.jsx`) instead of always TSX, because TSX parsing
  misreads generic arrows (`<T>(x) => x`) and type assertions in plain `.ts`.
- `LanguageTracer.trace` resolves to `undefined` (rather than always a
  `TraceResult`) when nothing traceable is under the cursor; the command layer
  turns that into the friendly "place the cursor on a prop" status message.

## Phase 2 seams (designed for, not implemented)

- **More languages**: implement `LanguageTracer` and append to the `tracers`
  registry in `extension.ts`. The view and command layers only consume the
  language-agnostic `TraceResult`.
- **Debug mode**: `src/debug/DebugTracer.ts` defines the interface for
  enriching a static trace with runtime values via the Debug Adapter Protocol
  (paused stack frames + `evaluate` requests). `TraceNode.valueText` is the
  forward-compatible slot for those values; the webview already renders it.

## Samples & tests

The acceptance fixtures live in `samples/` (A: state origin, B: multi-hop
drilling, C: renamed prop, D: `props.x` access, E: spread degradation,
F: body destructures/renames/redefines), each with a comment saying where to
put the cursor and what to expect.

```bash
npm test          # runs the tracer against all five fixtures in plain Node
npm run typecheck # tsc --noEmit
```

The test harness (`test/`) aliases `vscode` to a small mock whose providers
return empty results, which exercises the tracer's local-AST fallback — the
fixtures are single-file, so every trace completes end to end.

## Configuration

- `reactPropTracer.maxDepth` (default `8`) — maximum component hops to follow
  downstream. Cycles are detected and reported as `unresolved` nodes.

## Known limitations (Phase 1)

- Context providers, HOC internals, and dynamically computed tags surface as
  `unresolved` nodes rather than being traced through.
- Upstream "from parent prop" recursion is bounded to one hop, and redefine
  chains (`const c = a`) are followed at most 3 levels deep.
- Scope resolution for origin classification is simplified lexical scoping;
  the definition provider remains the authority for locations.
