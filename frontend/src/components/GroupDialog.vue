<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { errorMessage } from '../api/http';
import { useChatStore } from '../stores/chat';
import type { RoomSummary } from '../types';
import Icon from './Icon.vue';

const props = defineProps<{
  modelValue: boolean;
  room: RoomSummary | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const chat = useChatStore();
const newGroup = ref('');
const saving = ref(false);

// Every group already in use, so moving a room is a pick, not a retype.
const groups = computed(() => {
  const names = new Set<string>();
  for (const room of chat.rooms.mine) {
    const name = room.group?.trim();
    if (name) {
      names.add(name);
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'zh'));
});

const current = computed(() => props.room?.group?.trim() || null);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      newGroup.value = '';
      saving.value = false;
    }
  },
);

function close() {
  emit('update:modelValue', false);
}

async function choose(group: string | null) {
  const room = props.room;
  if (!room || saving.value) {
    return;
  }
  const next = group?.trim() || null;
  if (next && next.length > 32) {
    ElMessage.warning('分组名最多 32 个字符');
    return;
  }
  saving.value = true;
  try {
    await chat.setRoomGroup(room.id, next);
    ElMessage.success(next ? `已移动到「${next}」` : '已移出分组');
    close();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

function saveNew() {
  const name = newGroup.value.trim();
  if (!name) {
    ElMessage.warning('请输入分组名');
    return;
  }
  if (name.length > 32) {
    ElMessage.warning('分组名最多 32 个字符');
    return;
  }
  void choose(name);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="group-dialog"
    title="移动到分组"
    width="380px"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="group-body" data-testid="group-dialog">
      <div v-if="groups.length" class="group-options">
        <button
          v-for="name in groups"
          :key="name"
          type="button"
          class="group-option"
          :class="{ active: current === name }"
          data-testid="group-option"
          :disabled="saving"
          @click="choose(name)"
        >
          <Icon name="hash" :size="14" />
          <span class="group-option-name">{{ name }}</span>
          <Icon v-if="current === name" name="check" :size="14" />
        </button>
      </div>

      <button
        type="button"
        class="group-option group-option-none"
        :class="{ active: !current }"
        data-testid="group-option"
        :disabled="saving"
        @click="choose(null)"
      >
        <span class="group-option-name">不分组</span>
        <Icon v-if="!current" name="check" :size="14" />
      </button>

      <div class="group-new">
        <input
          v-model="newGroup"
          class="group-input"
          data-testid="group-input"
          maxlength="32"
          placeholder="新建分组名（≤32 字）"
          @keydown.enter.prevent="saveNew"
        />
        <button
          type="button"
          class="btn primary"
          data-testid="group-save"
          :disabled="saving"
          @click="saveNew"
        >
          保存
        </button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
/* Glass surface: solid fallback first, then the translucent layer. */
.group-dialog {
  background: var(--paper-2);
  background: var(--glass-pop);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  border: 1px solid var(--glass-hi);
  box-shadow: inset 0 1px 0 var(--glass-hi), var(--shadow-dialog);
}

.group-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-options {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 240px;
  overflow-y: auto;
}

.group-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sub);
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease-out, border-color 0.12s ease-out;
}

.group-option:hover {
  background: var(--paper-3);
}

.group-option.active {
  border-color: var(--line-strong);
  background: var(--paper-3);
  font-weight: 700;
}

.group-option:disabled {
  cursor: default;
  opacity: 0.6;
}

.group-option-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-option-none {
  border-top: 1px solid var(--line);
  border-radius: 0;
  margin-top: 2px;
  padding-top: 10px;
}

.group-new {
  display: flex;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.group-input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--paper-2);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sub);
}

.group-input:focus {
  outline: none;
  border-color: var(--ink);
}
</style>
