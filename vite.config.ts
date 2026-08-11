import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    // Public Pages artifacts do not need source maps. Revisit only with a
    // controlled error-reporting pipeline that keeps maps private.
    sourcemap: false,
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
