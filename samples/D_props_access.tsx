// Fixture D — non-destructured props.
// Place the cursor on `label` in <Child label={heading} /> — or on `label`
// inside `props.label` to trace upstream from within the child.
//
// Expect: a props-access node for props.label.
export function App() {
  const heading = 'Drilled without destructuring';
  return <Child label={heading} />;
}

function Child(props: { label: string }) {
  return <p>{props.label}</p>;
}
