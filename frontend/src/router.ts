import { createRouter, createWebHistory } from 'vue-router';
import ChatView from './views/ChatView.vue';
import LoginView from './views/LoginView.vue';
import RegisterView from './views/RegisterView.vue';
import RoomListView from './views/RoomListView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/rooms' },
    { path: '/login', component: LoginView },
    { path: '/register', component: RegisterView },
    { path: '/rooms', component: RoomListView },
    { path: '/rooms/:id', component: ChatView },
  ],
});

router.beforeEach((to) => {
  const token = localStorage.getItem('bfa_token');
  if (!token && to.path !== '/login' && to.path !== '/register') {
    return '/login';
  }
  if (token && (to.path === '/login' || to.path === '/register')) {
    return '/rooms';
  }
  return true;
});

export default router;
