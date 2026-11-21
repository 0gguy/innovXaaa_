// With `globals: true`, Testing Library registers its own cleanup after each test.
import "@testing-library/jest-dom/vitest";

// The language choice is persisted in localStorage; start every test from the default (English).
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* not available */
  }
});
