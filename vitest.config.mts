import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the unit suite — e2e-tests/specs/*.spec.ts are WebdriverIO specs
    // run by their own harness (e2e-tests/wdio.conf.ts), not by vitest.
    include: ['tests/**/*.test.ts'],
  },
});
