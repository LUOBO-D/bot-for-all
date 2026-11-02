import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // 只能用对象形式：函数形式会把匹配到的模块强制加入打包图（Rollup 无法
        // 判断它们是否真被使用），而 element-plus 根入口 re-export 了全部组件，
        // 按 id 匹配会把整个组件库（约 790KB）重新拉回来。这里显式列出实际用到的
        // 入口，未列出的组件仍会被 tree-shaking 摇掉。
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia'],
          'element-plus': [
            'element-plus/es/components/dialog/index.mjs',
            'element-plus/es/components/drawer/index.mjs',
            'element-plus/es/components/message/index.mjs',
            'element-plus/es/components/message-box/index.mjs',
          ],
          markdown: ['marked', 'dompurify'],
          vendor: ['axios', 'socket.io-client'],
        },
      },
    },
  },
});
