import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist2',
    // PERF (v1.42.0): was `false`, which let every local build ADD chunks
    // without removing old ones — 3,243 stale files / 146 MB were sitting in
    // dist2. Netlify builds from a clean clone so prod was unaffected, but
    // `vite preview` served a random mix of chunk generations locally.
    emptyOutDir: true,
    // The entry chunk was 955 KB (283 KB gz) because the app's vendor code and
    // eight eagerly-imported pages were fused into it. Route pages are now
    // lazy (App.jsx) and the big vendors get their own long-cached chunks, so
    // a deploy that touches one page invalidates one small file, not the
    // whole bundle.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase'
          if (/[\\/]node_modules[\\/](leaflet|@turf)[\\/]/.test(id)) return 'vendor-map'
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'vendor-icons'
          if (/[\\/]node_modules[\\/](date-fns)[\\/]/.test(id)) return 'vendor-date'
          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
