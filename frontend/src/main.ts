import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import './style.css';
import './styles/deepsea.css';
import { useAuthStore } from './stores/auth';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia).use(router).use(ElementPlus);

const auth = useAuthStore(pinia);
auth.fetchMe().finally(() => {
  app.mount('#app');
});
