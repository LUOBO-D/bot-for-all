<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import http, { errorMessage } from '../api/http';
import { useAuthStore } from '../stores/auth';
import { useChatStore } from '../stores/chat';
import type { Bot, Member } from '../types';

const props = defineProps<{ modelValue: boolean; roomId: number }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const auth = useAuthStore();
const chat = useChatStore();
const bots = ref<Bot[]>([]);
const mountedIds = ref<number[]>([]);
const loading = ref(false);
const saving = ref(false);
const testingId = ref<number | null>(null);
const editingId = ref<number | null>(null);
const isAdmin = computed(() => auth.user?.role === 'admin');

const presets = [
  {
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.5:9b',
    extraBody: '{"reasoning_effort":"none"}',
  },
  {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    extraBody: '',
  },
  {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    extraBody: '',
  },
];

const form = reactive({
  name: '',
  baseUrl: 'http://127.0.0.1:11434',
  apiKey: '',
  model: 'qwen3.5:9b',
  systemPrompt: '',
  triggerMode: 'mention' as 'mention' | 'all',
  temperature: 0.7,
  maxTokens: 1024,
  extraBody: '{"reasoning_effort":"none"}',
  scope: 'room' as 'room' | 'global',
});

async function load() {
  loading.value = true;
  try {
    const requests = [http.get<{ bots: Bot[] }>('/me/bots')];
    if (isAdmin.value) {
      requests.push(http.get<{ bots: Bot[] }>('/admin/bots'));
    }
    const responses = await Promise.all(requests);
    const merged = new Map<number, Bot>();
    for (const response of responses) {
      for (const bot of response.data.bots) {
        merged.set(bot.userId, bot);
      }
    }
    bots.value = [...merged.values()];
    const members = await http.get<{ members: Member[] }>(`/rooms/${props.roomId}/members`);
    mountedIds.value = members.data.members
      .filter((member) => member.type === 'bot')
      .map((member) => member.userId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      resetForm();
      void load();
    }
  },
);

function parseExtraBody(): Record<string, unknown> | null | undefined {
  if (!form.extraBody.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(form.extraBody);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resetForm() {
  editingId.value = null;
  form.name = '';
  form.baseUrl = 'http://127.0.0.1:11434';
  form.apiKey = '';
  form.model = 'qwen3.5:9b';
  form.systemPrompt = '';
  form.triggerMode = 'mention';
  form.temperature = 0.7;
  form.maxTokens = 1024;
  form.extraBody = '{"reasoning_effort":"none"}';
  form.scope = 'room';
}

function applyPreset(preset: (typeof presets)[number]) {
  form.baseUrl = preset.baseUrl;
  form.model = preset.model;
  form.extraBody = preset.extraBody;
}

function startEdit(bot: Bot) {
  if (!isOwner(bot)) {
    return;
  }
  editingId.value = bot.userId;
  form.name = bot.name;
  form.baseUrl = bot.baseUrl;
  form.apiKey = '';
  form.model = bot.model;
  form.systemPrompt = bot.systemPrompt;
  form.triggerMode = bot.triggerMode;
  form.temperature = bot.temperature;
  form.maxTokens = bot.maxTokens;
  form.extraBody = bot.extraBody ? JSON.stringify(bot.extraBody, null, 2) : '';
  form.scope = bot.scope;
}

async function copyHandle(bot: Bot) {
  try {
    await navigator.clipboard.writeText(`@${bot.username}`);
    ElMessage.success(`已复制 @${bot.username}`);
  } catch {
    ElMessage.info(`@${bot.username}`);
  }
}

async function save() {
  if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
    ElMessage.warning('请填写名称、baseUrl、model');
    return;
  }
  if (editingId.value == null && !form.apiKey.trim()) {
    ElMessage.warning('新建机器人需要 API Key');
    return;
  }
  const extraBody = parseExtraBody();
  if (extraBody === undefined) {
    ElMessage.error('extraBody 必须是 JSON 对象');
    return;
  }
  saving.value = true;
  try {
    if (editingId.value != null) {
      const patch: Record<string, unknown> = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        systemPrompt: form.systemPrompt,
        triggerMode: form.triggerMode,
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
        extraBody,
      };
      if (form.apiKey.trim()) {
        patch.apiKey = form.apiKey.trim();
      }
      await http.patch(`/me/bots/${editingId.value}`, patch);
      ElMessage.success('机器人已保存');
    } else {
      const { data } = await http.post<{ bot: Bot }>('/me/bots', {
        name: form.name.trim(),
        roomId: form.scope === 'room' ? props.roomId : undefined,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        model: form.model.trim(),
        systemPrompt: form.systemPrompt,
        triggerMode: form.triggerMode,
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
        extraBody,
        scope: form.scope,
      });
      ElMessage.success(`已创建，发送 @${data.bot.username} 触发`);
    }
    resetForm();
    await load();
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

async function test(bot: Bot) {
  testingId.value = bot.userId;
  try {
    const { data } = await http.post<{
      ok: boolean;
      reply?: string;
      code?: string;
      message?: string;
    }>(`/me/bots/${bot.userId}/test`);
    if (data.ok) {
      ElMessage.success(`连接成功：${(data.reply ?? 'OK').slice(0, 80)}`);
    } else {
      ElMessage.error(`连接失败：${data.message ?? data.code ?? '未知错误'}`);
    }
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    testingId.value = null;
  }
}

async function disable(bot: Bot) {
  try {
    await http.delete(`/me/bots/${bot.userId}`);
    ElMessage.success('已停用');
    await load();
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function enable(bot: Bot) {
  try {
    await http.patch(`/me/bots/${bot.userId}`, { enabled: true });
    ElMessage.success('已启用');
    await load();
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function mount(bot: Bot) {
  try {
    await http.post(`/me/rooms/${props.roomId}/bots`, { botId: bot.userId });
    ElMessage.success('已挂载');
    await load();
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

async function unmount(bot: Bot) {
  try {
    await http.delete(`/me/rooms/${props.roomId}/bots/${bot.userId}`);
    ElMessage.success('已卸载');
    await load();
    await chat.refreshMembers(props.roomId);
  } catch (error) {
    ElMessage.error(errorMessage(error));
  }
}

function isMounted(bot: Bot) {
  return mountedIds.value.includes(bot.userId);
}

// Only the creator may edit or (re)enable a bot; admins keep test/mount.
function isOwner(bot: Bot) {
  return bot.ownerUserId === auth.user?.id;
}

function canMount(bot: Bot) {
  return bot.scope === 'global' || bot.roomId === props.roomId;
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="机器人"
    width="680px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="bot-dialog">
      <div class="bot-list">
        <div v-if="loading" class="empty">加载中…</div>
        <div v-for="bot in bots" :key="bot.userId" class="bot-card">
          <span class="status-dot" :class="{ on: bot.enabled }"></span>
          <div class="bot-card-main">
            <div class="bot-card-title">
              {{ bot.name }}
              <span v-if="bot.scope === 'global'" class="tag">GLOBAL</span>
              <span v-if="!bot.enabled" class="tag muted">已停用</span>
            </div>
            <div class="bot-card-sub">
              @{{ bot.username }} · {{ bot.model }} · {{ bot.apiKeyMasked }} ·
              {{ bot.triggerMode === 'mention' ? '@ 触发' : '每条消息' }}
              <span v-if="!canMount(bot)" class="tag muted">其他房间</span>
            </div>
          </div>
          <div class="bot-card-actions">
            <button class="btn ghost small" @click="copyHandle(bot)">复制 @</button>
            <button v-if="isOwner(bot)" class="btn ghost small" @click="startEdit(bot)">
              编辑
            </button>
            <button
              class="btn ghost small"
              :disabled="testingId === bot.userId"
              @click="test(bot)"
            >
              {{ testingId === bot.userId ? '测试中…' : '测试' }}
            </button>
            <button
              v-if="!isMounted(bot)"
              class="btn ghost small"
              :disabled="!bot.enabled || !canMount(bot)"
              @click="mount(bot)"
            >
              挂载
            </button>
            <button v-else class="btn ghost small" @click="unmount(bot)">卸载</button>
            <button
              v-if="isOwner(bot) && !bot.enabled"
              class="btn ghost small"
              @click="enable(bot)"
            >
              启用
            </button>
            <button
              v-else-if="isOwner(bot)"
              class="btn ghost small"
              @click="disable(bot)"
            >
              停用
            </button>
          </div>
        </div>
        <div v-if="!loading && bots.length === 0" class="empty">还没有机器人</div>
      </div>

      <div class="section-title">{{ editingId ? '编辑机器人' : '新建机器人' }}</div>
      <div class="preset-row">
        <span class="preset-label">预设</span>
        <button
          v-for="preset in presets"
          :key="preset.label"
          class="preset-btn"
          @click="applyPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
      <div class="bot-form-grid">
        <label class="field">
          <span>名称</span>
          <input v-model="form.name" data-testid="bot-name" maxlength="64" />
        </label>
        <label class="field">
          <span>model</span>
          <input v-model="form.model" data-testid="bot-model" />
        </label>
        <label class="field field-wide">
          <span>baseUrl</span>
          <input v-model="form.baseUrl" data-testid="bot-base-url" />
        </label>
        <label class="field field-wide">
          <span>API Key</span>
          <input
            v-model="form.apiKey"
            data-testid="bot-api-key"
            type="password"
            :placeholder="editingId ? '留空则不修改' : ''"
          />
        </label>
        <label class="field field-wide">
          <span>system prompt</span>
          <textarea v-model="form.systemPrompt" rows="2"></textarea>
        </label>
        <label class="field field-wide">
          <span>extraBody（JSON，可选）</span>
          <textarea v-model="form.extraBody" data-testid="bot-extra-body" rows="2"></textarea>
        </label>
        <label class="field">
          <span>触发模式</span>
          <select v-model="form.triggerMode">
            <option value="mention">仅 @机器人</option>
            <option value="all">每条消息</option>
          </select>
        </label>
        <label class="field">
          <span>temperature</span>
          <input v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" />
        </label>
        <label class="field">
          <span>maxTokens</span>
          <input v-model.number="form.maxTokens" type="number" min="1" max="8192" />
        </label>
        <label v-if="isAdmin" class="field">
          <span>范围</span>
          <select v-model="form.scope">
            <option value="room">房间级</option>
            <option value="global">全局</option>
          </select>
        </label>
      </div>
    </div>

    <template #footer>
      <span class="footer-hint">
        {{
          editingId
            ? '留空 API Key 表示不修改；保存后立即生效'
            : '创建后点「挂载」才会进入成员列表'
        }}
      </span>
      <button v-if="editingId" class="btn ghost" @click="resetForm">取消编辑</button>
      <button class="btn primary" data-testid="bot-create" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : editingId ? '保存修改' : '创建机器人' }}
      </button>
    </template>
  </el-dialog>
</template>
