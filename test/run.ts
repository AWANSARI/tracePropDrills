// Smoke tests for ReactTracer against the five acceptance fixtures.
// Run with `npm test` (bundled by test/build-and-run.js, which aliases
// `vscode` to test/vscode-mock.ts).
import * as path from 'path';
import { ReactTracer } from '../src/tracer/ReactTracer';
import { TraceNode, TraceResult } from '../src/types';
import { MockTextDocument, makeDocument } from './vscode-mock';

const samplesDir = path.resolve(process.cwd(), 'samples');

let failures = 0;
let passes = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passes++;
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function flatten(node: TraceNode, out: TraceNode[] = []): TraceNode[] {
  out.push(node);
  for (const child of node.children) {
    flatten(child, out);
  }
  return out;
}

function describeTree(node: TraceNode, indent = ''): string {
  const line = `${indent}[${node.kind}] ${node.label}${node.valueText ? ` = ${node.valueText}` : ''}${node.unresolvedReason ? ` (${node.unresolvedReason})` : ''}`;
  return [line, ...node.children.map((c) => describeTree(c, indent + '  '))].join('\n');
}

/**
 * Cursor position at the first character of `inner` within `needle`,
 * skipping occurrences that sit inside // comment lines (the fixtures'
 * instruction headers quote the same code they point at).
 */
function positionOf(doc: MockTextDocument, needle: string, inner?: string) {
  const text = doc.getText();
  let base = text.indexOf(needle);
  while (base >= 0) {
    const lineStart = text.lastIndexOf('\n', base) + 1;
    if (!text.slice(lineStart, base).includes('//')) {
      const offset = inner ? base + needle.indexOf(inner) : base;
      return doc.positionAt(offset + 1);
    }
    base = text.indexOf(needle, base + 1);
  }
  throw new Error(`needle not found outside comments: ${needle}`);
}

async function traceAt(file: string, needle: string, inner?: string): Promise<TraceResult> {
  const doc = makeDocument(path.join(samplesDir, file));
  const position = positionOf(doc, needle, inner);
  const result = await new ReactTracer().trace(doc as never, position as never);
  if (!result) {
    throw new Error(`trace returned undefined for ${file} @ ${needle}`);
  }
  return result;
}

async function main(): Promise<void> {
  // --- A: one hop, state origin --------------------------------------------
  console.log('Fixture A — state origin');
  const a = await traceAt('A_state_origin.tsx', 'value={count}', 'value');
  const flatA = flatten(a.root);
  check(
    'upstream count is a state-hook',
    flatA.some((n) => n.kind === 'state-hook' && n.label.startsWith('count'))
  );
  check(
    'downstream resolves the Counter definition',
    flatA.some((n) => n.kind === 'component-definition' && n.label === 'Counter')
  );
  const receivedA = flatA.find((n) => n.kind === 'received-param');
  check('Counter receives value as received-param', receivedA?.label === 'value');
  check('received-param is a leaf (value not drilled further)', receivedA?.children.length === 0);

  // --- B: multi-hop prop drilling ------------------------------------------
  console.log('Fixture B — prop drilling');
  const b = await traceAt('B_prop_drilling.tsx', 'user={user}', 'user');
  const flatB = flatten(b.root);
  for (const component of ['Layout', 'Sidebar', 'Avatar']) {
    check(
      `chain reaches ${component}`,
      flatB.some((n) => n.kind === 'component-definition' && n.label === component)
    );
  }
  check(
    'final hop shows name={user.name}',
    flatB.some((n) => n.kind === 're-passed-prop' && n.valueText === 'user.name'),
    describeTree(b.root)
  );

  // --- C: renamed prop ------------------------------------------------------
  console.log('Fixture C — renamed prop');
  const c = await traceAt('C_renamed_prop.tsx', 'label={title}', 'label');
  const flatC = flatten(c.root);
  check(
    'received-param records alias label → text',
    flatC.some((n) => n.kind === 'received-param' && n.label === 'label → text'),
    describeTree(c.root)
  );
  check(
    'upstream title is a hook',
    flatC.some((n) => n.kind === 'hook' && n.label.startsWith('title'))
  );

  // --- D: non-destructured props -------------------------------------------
  console.log('Fixture D — props access');
  const d = await traceAt('D_props_access.tsx', 'label={heading}', 'label');
  const flatD = flatten(d.root);
  check(
    'child reception is a props-access node',
    flatD.some((n) => n.kind === 'props-access' && n.label === 'props.label'),
    describeTree(d.root)
  );

  // D from the child side: cursor on `label` inside props.label
  const d2 = await traceAt('D_props_access.tsx', 'props.label', 'label');
  const flatD2 = flatten(d2.root);
  check(
    'cursor inside props.label is classified as the child-side prop',
    d2.root.kind === 'selection' && flatD2.some((n) => n.kind === 'props-access')
  );

  // --- E: spread degradation ------------------------------------------------
  console.log('Fixture E — spread');
  const e = await traceAt('E_spread.tsx', '<Child {...rest} />', 'Child');
  const flatE = flatten(e.root);
  const spreadNode = flatE.find((n) => n.kind === 'unresolved' && n.unresolvedReason === 'spread props');
  check('spread yields an unresolved node with reason "spread props"', spreadNode !== undefined, describeTree(e.root));
  check('spread node shows rest as its source', spreadNode?.valueText === 'rest');

  // --- F: body rebinds (destructure / rename / redefine) --------------------
  console.log('Fixture F — body rebinds');
  const f1 = await traceAt('F_body_rebinds.tsx', 'c={a}', 'a');
  const flatF1 = flatten(f1.root);
  check(
    'value from a body destructure is recognized as a parent prop',
    flatF1.some((n) => n.kind === 'from-parent-prop' && n.label.startsWith('a')),
    describeTree(f1.root)
  );

  const f2 = await traceAt('F_body_rebinds.tsx', 'const { a } = props', 'a');
  const flatF2 = flatten(f2.root);
  check(
    'cursor on the body destructure traces the child-side prop',
    f2.root.kind === 'selection' &&
      flatF2.some((n) => n.kind === 're-passed-prop' && n.label === 'c → <Component3>'),
    describeTree(f2.root)
  );
  check(
    'body destructure trace reaches Component3',
    flatF2.some((n) => n.kind === 'component-definition' && n.label === 'Component3')
  );

  const f3 = await traceAt('F_body_rebinds.tsx', 'title={t}', 'title');
  const flatF3 = flatten(f3.root);
  check(
    'props.title reception is found despite the rebind',
    flatF3.some((n) => n.kind === 'props-access' && n.label === 'props.title')
  );
  check(
    'downstream follows const heading = props.title into <Header>',
    flatF3.some((n) => n.kind === 'component-definition' && n.label === 'Header'),
    describeTree(f3.root)
  );

  const f4 = await traceAt('F_body_rebinds.tsx', 'd={doubled}', 'doubled');
  const flatF4 = flatten(f4.root);
  check(
    'redefine chain doubled → a still reaches the parent prop',
    flatF4.some((n) => n.kind === 'from-parent-prop'),
    describeTree(f4.root)
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
