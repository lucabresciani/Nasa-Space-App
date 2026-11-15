// Static accessibility checks (package Q1, DESIGN §9 "Contrast" and "Colour vision"): token contrast
// matrix + allow-list, colour-vision simulation, second cues in the A2 components. No browser needed.
// Reuses the app's Vite config (YAML plugin, Preact JSX for the components under test).
// Run: cd web && npm run test:a11y:static
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../vite.config.ts'

const web = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig((env) => {
  const merged = mergeConfig(typeof base === 'function' ? base(env) : base, { root: web })
  // Replace (not merge) the include list: only the Q1 static checks, not the app's unit tests.
  merged.test = { ...merged.test, include: ['tests/a11y/**/*.test.ts'], environment: 'node' }
  return merged
})
