<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import BrandMark from '../components/BrandMark.vue';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const auth = useAuthStore();
const loading = ref(false);
const captcha = reactive({ id: '', svg: '' });
const form = reactive({
  username: '',
  password: '',
  displayName: '',
  captchaText: '',
});

const captchaImage = computed(() =>
  captcha.svg ? `data:image/svg+xml;base64,${btoa(captcha.svg)}` : '',
);

async function loadCaptcha() {
  try {
    const { data } = await http.get<{ id: string; svg: string }>('/auth/captcha');
    captcha.id = data.id;
    captcha.svg = data.svg;
    form.captchaText = '';
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function submit() {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await auth.register({
      username: form.username.trim(),
      password: form.password,
      displayName: form.displayName.trim() || undefined,
      captchaId: captcha.id || undefined,
      captchaText: form.captchaText || undefined,
    });
    await router.push('/rooms');
  } catch (error) {
    ElMessage.error(errorMessage(error));
    await loadCaptcha();
  } finally {
    loading.value = false;
  }
}

onMounted(loadCaptcha);
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
        <h1>注册</h1>
        <p>开放注册，无需邮箱</p>
        <form @submit.prevent="submit">
        <input
          v-model="form.username"
          data-testid="username"
          aria-label="用户名"
          placeholder="用户名（3-32 位字母/数字/下划线）"
          autocomplete="username"
        />
        <input
          v-model="form.password"
          data-testid="password"
          type="password"
          aria-label="密码"
          placeholder="密码（至少 8 位）"
          autocomplete="new-password"
        />
        <input
          v-model="form.displayName"
          data-testid="display-name"
          aria-label="显示名（可选）"
          placeholder="显示名（可选）"
        />
        <div v-if="captcha.svg" class="captcha-row">
          <input
            v-model="form.captchaText"
            data-testid="captcha"
            aria-label="验证码"
            placeholder="验证码"
            autocomplete="off"
          />
          <img :src="captchaImage" alt="验证码" @click="loadCaptcha" />
        </div>
        <button class="btn primary submit" data-testid="register-submit" :disabled="loading">
          {{ loading ? '注册中…' : '注册' }}
        </button>
      </form>
      <div class="switch">
        已有账号？
        <router-link to="/login">登录</router-link>
      </div>
      </div>
    </main>
  </div>
</template>
