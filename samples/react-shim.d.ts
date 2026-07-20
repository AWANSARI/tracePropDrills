// Minimal ambient shims so the sample fixtures type-check without installing
// React. The tracer itself does not depend on these — it parses the source
// directly — they only keep the TS server quiet in the Extension Dev Host.
declare module 'react' {
  export function useState<T>(initial: T): [T, (next: T) => void];
}

declare namespace JSX {
  interface IntrinsicElements {
    [tag: string]: any;
  }
  interface Element {}
  interface ElementChildrenAttribute {
    children: {};
  }
}
