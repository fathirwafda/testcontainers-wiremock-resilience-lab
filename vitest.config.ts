import { defineConfig } from 'vitest/config';

// Container start-up is the slow part, so Docker-backed projects get generous hook timeouts.
const dockerTimeouts = { hookTimeout: 180_000, testTimeout: 30_000 };

export default defineConfig({
  test: {
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/junit.xml' },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          ...dockerTimeouts,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          ...dockerTimeouts,
        },
      },
    ],
  },
});
