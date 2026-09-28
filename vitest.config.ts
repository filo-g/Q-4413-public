import { defineConfig } from 'vitest/config';

/**
 * Root suite. Workspace packages resolve through pnpm's links, so tests import
 * `@q4413/shared` and `@q4413/core` the same way the Worker does.
 *
 * tests/projection.test.ts is the highest-priority suite in the repo: with game
 * logic this thin, project() is most of the backend's value (§4).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
