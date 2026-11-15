/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** 'dummy' reads public/data-dummy/; anything else reads public/data/ (docs/dummy.md). */
  readonly VITE_DATA?: string
}

// config/*.yaml, parsed at build time by the yaml plugin in vite.config.ts; typed in src/config.ts.
declare module '*.yaml' {
  const value: unknown
  export default value
}

declare module 'maplibre-gl/dist/maplibre-gl-worker.mjs?url' {
  const url: string
  export default url
}
