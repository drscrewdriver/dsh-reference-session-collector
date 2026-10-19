import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'threads',
    environment: 'node',
    testTimeout: 15_000,
  },
})
