<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { Member } from '../types';
import { formatRelative } from '../utils/format';
import Icon from './Icon.vue';
import UserAvatar from './UserAvatar.vue';

const props = defineProps<{ modelValue: boolean; member: Member | null }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const ROLE_LABELS: Record<Member['role'], string> = {
  owner: '房主',
  admin: '管理员',
  member: '成员',
  bot: 'BOT',
};

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const roleLabel = computed(() => (props.member ? ROLE_LABELS[props.member.role] : ''));
const joinedLabel = computed(() => {
  const joinedAt = props.member?.joinedAt;
  return joinedAt ? formatRelative(joinedAt) : '未知';
});
const joinedExact = computed(() => {
  const joinedAt = props.member?.joinedAt;
  return joinedAt ? new Date(joinedAt).toLocaleString() : '';
});
const onlineLabel = computed(() => {
  const member = props.member;
  if (!member) {
    return '';
  }
  if (member.online) {
    return '在线';
  }
  return member.lastSeenAt ? `最后在线 ${formatRelative(member.lastSeenAt)}` : '离线';
});
const onlineExact = computed(() => {
  const member = props.member;
  if (!member || member.online || !member.lastSeenAt) {
    return '';
  }
  return new Date(member.lastSeenAt).toLocaleString();
});
const statusLine = computed(() => {
  const member = props.member;
  if (!member) {
    return '';
  }
  return [member.statusEmoji, member.statusText].filter(Boolean).join(' ');
});

async function copyUsername() {
  const member = props.member;
  if (!member) {
    return;
  }
  try {
    await navigator.clipboard.writeText(member.username);
    ElMessage.success('已复制用户名');
  } catch {
    ElMessage.info(member.username);
  }
}
</script>

<template>
  <el-dialog v-model="visible" class="member-profile-dialog" title="成员资料" width="360px">
    <div v-if="member" class="mp-body" data-testid="member-profile">
      <div class="mp-head">
        <UserAvatar
          size="lg"
          :avatar="member.avatar"
          :id="member.userId"
          :name="member.displayName"
        />
        <div class="mp-identity">
          <div class="mp-name">
            <span class="mp-display">{{ member.displayName }}</span>
            <span class="mp-role" :class="`is-${member.role}`">{{ roleLabel }}</span>
          </div>
          <div class="mp-handle">@{{ member.username }}</div>
        </div>
      </div>

      <dl class="mp-facts">
        <div class="mp-fact">
          <dt>身份</dt>
          <dd>{{ roleLabel }}</dd>
        </div>
        <div v-if="statusLine" class="mp-fact mp-fact-status">
          <dt>状态</dt>
          <dd>
            <span class="mp-status" :title="statusLine">{{ statusLine }}</span>
          </dd>
        </div>
        <div class="mp-fact">
          <dt>在线状态</dt>
          <dd :title="onlineExact">
            <span class="mp-dot" :class="{ online: member.online }"></span>
            {{ onlineLabel }}
          </dd>
        </div>
        <div class="mp-fact">
          <dt>加入房间</dt>
          <dd :title="joinedExact">{{ joinedLabel }}</dd>
        </div>
      </dl>

      <button
        class="btn ghost small mp-copy"
        type="button"
        data-testid="member-profile-copy"
        @click="copyUsername"
      >
        <Icon name="copy" :size="15" />
        复制用户名
      </button>
    </div>
  </el-dialog>
</template>

<style scoped>
:global(.el-dialog.member-profile-dialog) {
  background: var(--paper-2);
  background: var(--glass-pop);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
  backdrop-filter: blur(20px) saturate(1.5);
  border: 1px solid var(--line-strong);
  box-shadow: inset 0 1px 0 var(--glass-hi), var(--glass-shadow);
}

.mp-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 4px;
}

.mp-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mp-identity {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.mp-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  min-width: 0;
}

.mp-display {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-role {
  flex: none;
  padding: 0 5px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 600;
  line-height: 1.5;
}

.mp-role.is-owner,
.mp-role.is-admin {
  border-color: var(--ink);
  color: var(--ink);
}

.mp-role.is-bot {
  border-color: var(--rust);
  color: var(--rust-ink);
}

.mp-handle {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.03em;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-facts {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}

.mp-fact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
}

.mp-fact dt {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: 0.08em;
  color: var(--muted);
}

.mp-fact dd {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--fs-sub);
  font-weight: 600;
  color: var(--text);
}

.mp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--line-strong);
  background: transparent;
}

.mp-dot.online {
  background: var(--lime);
  border-color: var(--lime);
}

.mp-fact-status dd {
  min-width: 0;
  max-width: 72%;
}

.mp-status {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mp-copy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
}
</style>
