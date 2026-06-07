// Makes the jest-dom matcher types (toBeInTheDocument, toHaveValue, …) visible on vitest's global
// `expect`. The runtime registration happens in `setup.ts`. We augment both the `vitest` module and
// `@vitest/expect` (the actual home of the global `Assertion`) so tsc sees the matchers regardless.
/* eslint-disable @typescript-eslint/no-empty-object-type -- interface-merge augmentations are
   intentionally empty; they graft the jest-dom matchers onto vitest's Assertion. */
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "@vitest/expect" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
