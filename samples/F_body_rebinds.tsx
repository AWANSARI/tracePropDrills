// Fixture F — body rebinds: destructures, renames, and redefines.
//
// 1. Cursor on `a` in `c={a}` inside Component2 — upstream recognizes `a`
//    as prop 'a' of Component2 (via `const { a } = props`), not a plain
//    local, so the drill chain back to App survives.
// 2. Cursor on `a` in `const { a } = props;` — traces the child-side prop
//    (parents upstream, re-passes downstream).
// 3. Cursor on `title` in <Component4 title={t} /> — downstream follows the
//    `const heading = props.title` rebind into <Header text={heading} />.
// 4. Cursor on `doubled` in `d={doubled}` — the redefine chain
//    doubled → a → prop 'a' of Component2 is preserved.
function useThing() {
  return 'thing';
}

export function App() {
  const b = useThing();
  return <Component2 a={b} />;
}

function Component2(props: { a: string }) {
  const { a } = props;
  const doubled = a + a;
  return <Component3 c={a} d={doubled} />;
}

function Component3({ c, d }: { c: string; d: string }) {
  return <p>{c}{d}</p>;
}

export function App2() {
  const t = useThing();
  return <Component4 title={t} />;
}

function Component4(props: { title: string }) {
  const heading = props.title;
  return <Header text={heading} />;
}

function Header({ text }: { text: string }) {
  return <h1>{text}</h1>;
}
