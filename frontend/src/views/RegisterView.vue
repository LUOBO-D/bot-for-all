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
  <div class="auth-scene">
    <section class="auth-hero">
      <div class="auth-brandline">
        <span class="brand-logo"><BrandMark :size="24" /></span>
        <span>
          <span class="brand-name">bot-for-all</span>
          <span class="brand-sub">群聊 · AI 群成员</span>
        </span>
      </div>

      <div>
        <h1 class="auth-headline">开一个房间，<br />把 AI 拉进来。</h1>
        <p class="auth-sub">
          注册只需要用户名和密码。建好房间后，填一个 baseUrl、一个 Key、一个模型名，
          机器人就会出现在成员列表里——和真人一样有位置。
        </p>
        <div class="auth-signals">
          <span class="auth-signal"><i></i>无需邮箱</span>
          <span class="auth-signal"><i></i>自备模型 Key</span>
          <span class="auth-signal"><i></i>随时可退出房间</span>
        </div>
      </div>

      <div class="auth-foot">
        <span>BOT-FOR-ALL · DEEP SEA BUILD</span>
        <span>v0.1 · LOCAL DEMO</span>
      </div>

      <svg class="auth-whale" viewBox="0 0 440 240" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="whaleBody2" x1="40" y1="60" x2="380" y2="190" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#48E6C5" stop-opacity="0.5" />
            <stop offset="55%" stop-color="#8FB6FF" stop-opacity="0.32" />
            <stop offset="100%" stop-color="#5C82FF" stop-opacity="0.04" />
          </linearGradient>
        </defs>
        <path d="M22 128c18-52 96-78 176-62 66 13 104 44 116 66-30 26-104 44-182 38C78 166 34 152 22 128Z"
          fill="url(#whaleBody2)" stroke="#7EE9D4" stroke-opacity="0.32" stroke-width="1" />
        <path d="M314 132c26-22 46-44 66-64-2 42-10 74-32 86-16 8-30-2-34-22Z"
          fill="url(#whaleBody2)" stroke="#7EE9D4" stroke-opacity="0.26" stroke-width="1" />
        <path d="M196 158c8 26 26 44 48 50-18 6-44-4-58-20-8-10-8-22 10-30Z"
          fill="url(#whaleBody2)" stroke="#7EE9D4" stroke-opacity="0.22" stroke-width="1" />
        <circle cx="96" cy="112" r="4.5" fill="#04120E" stroke="#CFFBF0" stroke-width="1.5" />
        <g fill="#48E6C5">
          <circle cx="380" cy="86" r="2.4" opacity="0.75" />
          <circle cx="404" cy="66" r="1.6" opacity="0.55" />
          <circle cx="356" cy="52" r="1.8" opacity="0.45" />
        </g>
        <g stroke="#7EE9D4" stroke-opacity="0.16" stroke-width="1">
          <path d="M0 196c80-14 160-14 240 0s160 14 200 2" />
          <path d="M0 214c90-12 170-12 250 2s150 12 190 0" stroke-opacity="0.09" />
        </g>
      </svg>
    </section>

    <main class="auth-panel">
      <div class="auth-card">
        <span class="eyebrow">CREATE ACCOUNT</span>
        <h1>注册</h1>
        <p>开放注册，无需邮箱。</p>
        <form @submit.prevent="submit">
          <label class="auth-field">
            <span>账号</span>
            <input
              v-model="form.username"
              data-testid="username"
              placeholder="3-32 位字母 / 数字 / 下划线"
              autocomplete="username"
            />
          </label>
          <label class="auth-field">
            <span>密码</span>
            <input
              v-model="form.password"
              data-testid="password"
              type="password"
              placeholder="至少 8 位"
              autocomplete="new-password"
            />
          </label>
          <label class="auth-field">
            <span>显示名</span>
            <input
              v-model="form.displayName"
              data-testid="display-name"
              placeholder="可选，群里显示的名字"
            />
          </label>
          <div v-if="captcha.svg" class="auth-captcha">
            <input
              v-model="form.captchaText"
              data-testid="captcha"
              placeholder="验证码"
              autocomplete="off"
            />
            <img :src="captchaImage" alt="验证码" @click="loadCaptcha" />
          </div>
          <button class="btn primary submit" data-testid="register-submit" :disabled="loading">
            {{ loading ? '注册中…' : '创建账号' }}
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
