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
        <h1 class="auth-headline">把机器人养成<br />群里的一个人。</h1>
        <p class="auth-sub">
          不是工具条，不是侧边栏插件。它有自己的名字和头像，坐在成员列表里，
          被 @ 的时候逐字回你，断网重连也不会漏掉半句话。
        </p>
        <div class="auth-signals">
          <span class="auth-signal"><i></i>流式逐字回复</span>
          <span class="auth-signal"><i></i>seq 连号不丢消息</span>
          <span class="auth-signal"><i></i>自备 Key 接任意模型</span>
        </div>
      </div>

      <div class="auth-foot">
        <span>BOT-FOR-ALL · DEEP SEA BUILD</span>
        <span>v0.1 · LOCAL DEMO</span>
      </div>

      <svg class="auth-whale" viewBox="0 0 440 240" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="whaleBody" x1="40" y1="60" x2="380" y2="190" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#48E6C5" stop-opacity="0.55" />
            <stop offset="55%" stop-color="#5C82FF" stop-opacity="0.35" />
            <stop offset="100%" stop-color="#5C82FF" stop-opacity="0.05" />
          </linearGradient>
          <radialGradient id="whaleGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0" stop-color="#48E6C5" stop-opacity="0.5" />
            <stop offset="100%" stop-color="#48E6C5" stop-opacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="200" cy="140" rx="190" ry="90" fill="url(#whaleGlow)" opacity="0.5" />
        <path d="M22 128c18-52 96-78 176-62 66 13 104 44 116 66-30 26-104 44-182 38C78 166 34 152 22 128Z"
          fill="url(#whaleBody)" stroke="#7EE9D4" stroke-opacity="0.35" stroke-width="1" />
        <path d="M314 132c26-22 46-44 66-64-2 42-10 74-32 86-16 8-30-2-34-22Z"
          fill="url(#whaleBody)" stroke="#7EE9D4" stroke-opacity="0.28" stroke-width="1" />
        <path d="M196 158c8 26 26 44 48 50-18 6-44-4-58-20-8-10-8-22 10-30Z"
          fill="url(#whaleBody)" stroke="#7EE9D4" stroke-opacity="0.24" stroke-width="1" />
        <circle cx="96" cy="112" r="4.5" fill="#04120E" stroke="#CFFBF0" stroke-width="1.5" />
        <path d="M60 132c14 6 28 6 42 2" stroke="#CFFBF0" stroke-opacity="0.35" stroke-width="1.5" stroke-linecap="round" />
        <g fill="#48E6C5">
          <circle cx="380" cy="86" r="2.4" opacity="0.8" />
          <circle cx="404" cy="66" r="1.6" opacity="0.6" />
          <circle cx="356" cy="52" r="1.8" opacity="0.5" />
          <circle cx="330" cy="76" r="1.2" opacity="0.45" />
        </g>
        <g stroke="#7EE9D4" stroke-opacity="0.18" stroke-width="1">
          <path d="M0 196c80-14 160-14 240 0s160 14 200 2" />
          <path d="M0 214c90-12 170-12 250 2s150 12 190 0" stroke-opacity="0.1" />
        </g>
      </svg>
    </section>

    <main class="auth-panel">
      <div class="auth-card">
        <span class="eyebrow">SIGN IN</span>
        <h1>登录</h1>
        <p>输入你的账号，回到群里。</p>
        <form @submit.prevent="submit">
          <label class="auth-field">
            <span>账号</span>
            <input
              v-model="username"
              data-testid="username"
              placeholder="用户名"
              autocomplete="username"
            />
          </label>
          <label class="auth-field">
            <span>密码</span>
            <input
              v-model="password"
              data-testid="password"
              type="password"
              placeholder="密码"
              autocomplete="current-password"
            />
          </label>
          <button class="btn primary submit" data-testid="login-submit" :disabled="loading">
            {{ loading ? '登录中…' : '进入群聊' }}
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
