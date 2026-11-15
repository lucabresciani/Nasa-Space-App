import { defineConfig } from 'vitest/config'
import { loadEnv, type Plugin } from 'vite'
import { parse } from 'yaml'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

// config/*.yaml is parsed at build time (src/config.ts imports it), so every constant comes from
// config/ itself, never a copy, and no YAML parser ships to the browser.
function yamlPlugin(): Plugin {
  return {
    name: 'homeline-yaml',
    transform(code, id) {
      if (!id.endsWith('.yaml') && !id.endsWith('.yml')) return null
      return { code: `export default ${JSON.stringify(parse(code))};`, map: null }
    },
  }
}

// public/ holds both data trees; ship only the one this build reads (VITE_DATA=dummy -> data-dummy/).
function pruneDataDirs(dataMode: string): Plugin {
  let outDir = 'dist'
  return {
    name: 'homeline-prune-data',
    apply: 'build',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir)
    },
    closeBundle() {
      rmSync(resolve(outDir, dataMode === 'dummy' ? 'data' : 'data-dummy'), { recursive: true, force: true })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const dataMode = process.env.VITE_DATA ?? env.VITE_DATA ?? 'real'
  return {
    // Relative base so the build works under a GitHub Pages project path (hash routing).
    base: './',
    plugins: [yamlPlugin(), pruneDataDirs(dataMode)],
    server: { fs: { allow: ['..'] } }, // config/ and contracts/ live one level up
    build: { chunkSizeWarningLimit: 1200 }, // maplibre-gl is ~1 MB minified, lazy-loaded on "/"
    test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], environment: 'node' },
  }
})
