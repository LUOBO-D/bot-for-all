<script setup lang="ts">
import { computed } from 'vue';
import type { Member } from '../types';
import { avatarClass, initialOf } from '../utils/format';

const props = defineProps<{ members: Member[] }>();
const humans = computed(() => props.members.filter((member) => member.type === 'human'));
const bots = computed(() => props.members.filter((member) => member.type === 'bot'));
</script>

<template>
  <div class="member-list">
    <div class="member-section">
      <div class="member-heading">
        人类
        <span>{{ humans.length }}</span>
      </div>
      <div
        v-for="member in humans"
        :key="member.userId"
        class="member-row"
        :class="{ online: member.online }"
      >
        <span class="avatar avatar-sm" :class="avatarClass(member.userId)">
          {{ initialOf(member.displayName) }}
        </span>
        <span class="member-copy">
          <span class="member-name">
            {{ member.displayName }}
            <span v-if="member.role === 'owner'" class="role-tag">房主</span>
          </span>
          <span class="member-sub">@{{ member.username }}</span>
        </span>
        <span class="presence-dot" :class="{ online: member.online }"></span>
      </div>
      <div v-if="humans.length === 0" class="member-empty">暂无人类成员</div>
    </div>

    <div class="member-section">
      <div class="member-heading">
        机器人
        <span>{{ bots.length }}</span>
      </div>
      <div
        v-for="member in bots"
        :key="member.userId"
        class="member-row"
        :class="{ online: member.online }"
      >
        <span class="avatar avatar-sm bot-avatar" :class="avatarClass(member.userId)">
          {{ initialOf(member.displayName) }}
        </span>
        <span class="member-copy">
          <span class="member-name">
            {{ member.displayName }}
            <span class="bot-tag">BOT</span>
          </span>
          <span class="member-sub">@{{ member.username }}</span>
        </span>
        <span class="presence-dot" :class="{ online: member.online }"></span>
      </div>
      <div v-if="bots.length === 0" class="member-empty">还没有机器人</div>
    </div>
  </div>
</template>
