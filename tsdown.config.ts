import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  fixedExtension: false,
  clean: false,
})
