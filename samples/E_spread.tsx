// Fixture E — graceful degradation on spread.
// Place the cursor on `Child` in <Child {...rest} />.
//
// Expect: an unresolved node with reason "spread props" and `rest` shown as
// the source expression. The branch stops cleanly instead of guessing.
export function App() {
  const rest = { label: 'hidden in a spread', tone: 'info' };
  return <Child {...rest} />;
}

function Child({ label, tone }: { label: string; tone: string }) {
  return <p className={tone}>{label}</p>;
}
