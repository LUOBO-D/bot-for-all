<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { errorMessage } from '../api/http';
import BrandMark from '../components/BrandMark.vue';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();
const username = ref('');
const password = ref('');
const loading = ref(false);

async function submit() {
  if (!username.value.trim() || !password.value) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await auth.login(username.value.trim(), password.value);
    await router.push('/rooms');
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="auth-page">
    <aside class="auth-rail">
      <div>
        <div class="auth-brand">
          <span class="brand-logo"><BrandMark :size="26" /></span>
          <span class="auth-brand-name">bot-for-all</span>
        </div>
        <p class="auth-tagline">
          机器人不是工具条，是有名字、有头像的群成员。
          建一个房间，把机器人拉进来，@它就能聊。
        </p>
      </div>
      <div class="auth-spec">
        BOT-FOR-ALL<br />
        INK &amp; PAPER BUILD
      </div>
    </aside>
    <main class="auth-main">
      <div class="auth-card">
        <h1>登录</h1>
        <p>登录后进入群聊</p>
        <form @submit.prevent="submit">
        <input
          v-model="username"
          data-testid="username"
          placeholder="用户名"
          autocomplete="username"
        />
        <input
          v-model="password"
          data-testid="password"
          type="password"
          placeholder="密码"
          autocomplete="current-password"
        />
        <button class="btn primary submit" data-testid="login-submit" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </form>
      <div class="switch">
        还没有账号？
        <router-link to="/register">注册</router-link>
      </div>
      </div>
    </main>
  </div>
</template>
