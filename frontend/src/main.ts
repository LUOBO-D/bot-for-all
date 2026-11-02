import { createApp } from 'vue';
import { createPinia } from 'pinia';
// Element Plus 按需引入：模板只用到 el-dialog / el-drawer，函数式 API 用到
// ElMessage / ElMessageBox（由使用方直接 import，无需注册）。
// 样式只引对应 theme-chalk，并保留 base.css 提供 CSS 变量与 .el-icon 等基础类。
import { ElDialog, ElDrawer } from 'element-plus';
import 'element-plus/theme-chalk/base.css';
import 'element-plus/theme-chalk/el-overlay.css';
import 'element-plus/theme-chalk/el-dialog.css';
import 'element-plus/theme-chalk/el-drawer.css';
import 'element-plus/theme-chalk/el-message.css';
import 'element-plus/theme-chalk/el-message-box.css';
import 'element-plus/theme-chalk/el-input.css';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-badge.css';
import App from './App.vue';
import router from './router';
import './style.css';
import { useAuthStore } from './stores/auth';
import { initTheme } from './theme';

// Apply the persisted theme before any UI (login page included) is painted.
initTheme();

const app = createApp(App);
const pinia = createPinia();
app.use(pinia).use(router).use(ElDialog).use(ElDrawer);

const auth = useAuthStore(pinia);
auth.fetchMe().finally(() => {
  app.mount('#app');
});
