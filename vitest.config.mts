import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the unit suite — e2e-tests/specs/*.spec.ts are WebdriverIO specs
    // run by their own harness (e2e-tests/wdio.conf.ts), not by vitest.
    include: ['tests/**/*.test.ts'],
    // `*.local.*` is the gitignored scratch namespace. A probe there is not
    // part of any gate — CI never receives one — so a tracked run that picks
    // one up can only report a red the pipeline cannot reproduce.
    exclude: [...configDefaults.exclude, '**/*.local.*'],
  },
});
