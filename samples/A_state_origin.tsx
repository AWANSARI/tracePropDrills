// Fixture A — one hop, state origin.
// Place the cursor on `value` (or `count`) in <Counter value={count} /> and
// run "React Prop Tracer: Trace Prop at Cursor" (Ctrl+Alt+T / Cmd+Alt+T).
//
// Expect: Origin ↑  count → useState (state-hook)
//         Flows into ↓  Counter receives `value` as received-param (leaf).
import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);
  return <Counter value={count} />;
}

export function Counter({ value }: { value: number }) {
  return <span>{value}</span>;
}
