import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/rooms' },
    { path: '/login', component: () => import('./views/LoginView.vue') },
    { path: '/register', component: () => import('./views/RegisterView.vue') },
    { path: '/rooms', component: () => import('./views/RoomListView.vue') },
    { path: '/rooms/:id', component: () => import('./views/ChatView.vue') },
    { path: '/search', component: () => import('./views/SearchView.vue') },
    {
      path: '/admin',
      component: () => import('./views/AdminView.vue'),
      meta: { admin: true },
    },
  ],
});

router.beforeEach(async (to) => {
  const token = localStorage.getItem('bfa_token');
  if (!token && to.path !== '/login' && to.path !== '/register') {
    return '/login';
  }
  if (token && (to.path === '/login' || to.path === '/register')) {
    return '/rooms';
  }
  if (to.meta.admin) {
    const auth = useAuthStore();
    if (!auth.user) {
      await auth.fetchMe();
    }
    if (auth.user?.role !== 'admin') {
      return '/rooms';
    }
  }
  return true;
});

export default router;
