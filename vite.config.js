import { defineConfig } from 'vite'

// De SPA staat in web/ maar importeert de portable kern uit ../src en ../migration,
// dus fs.allow moet de projectroot omvatten.
export default defineConfig({
  root: 'web',
  base: './', // relatieve asset-paden → de SPA is porteerbaar naar een submap (/app/) op IPFS

  server: { fs: { allow: ['..'] } },
  define: { global: 'globalThis' },
  build: { outDir: '../dist-web', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2000 },
})
