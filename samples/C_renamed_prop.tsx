// Fixture C — renamed prop.
// Place the cursor on `label` in <Child label={title} />.
//
// Expect: received-param records the alias `label → text`.
function useTitle() {
  return 'Hello, tracer';
}

export function App() {
  const title = useTitle();
  return <Child label={title} />;
}

function Child({ label: text }: { label: string }) {
  return <h1>{text}</h1>;
}
