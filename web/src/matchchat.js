// 对局内讨论：任何联机游戏（含观战）都能发言。
// 观战者的发言会被服务端标记 spec=1，正在比赛的同学屏幕上会飘过弹幕（见 app.js 的弹幕层）。
import { ref, computed, nextTick, onMounted, onUnmounted, onWs, wsSend, haptic, store, mediaUrl } from "./ui.js";

export const MatchChat = {
  setup() {
    const open = ref(false);
    const draft = ref("");
    const msgs = ref([]);
    const unread = ref(0);
    const listEl = ref(null);
    const roomInfo = ref(null);

    const myId = computed(() => (store.user && store.user.id) || 0);
    const isSeat = computed(() => {
      const list = (roomInfo.value && roomInfo.value.players) || [];
      return list.some((p) => p.uid === myId.value);
    });
    const live = computed(() => !!(roomInfo.value && roomInfo.value.started && !roomInfo.value.finished));
    const gameName = computed(() => (roomInfo.value && roomInfo.value.name) || "对局");

    function noteRoom(msg) { if (msg && msg.room) roomInfo.value = msg.room; }

    function toggle() {
      open.value = !open.value;
      if (open.value) { unread.value = 0; scrollDown(); }
      haptic(8);
    }
    function close() { open.value = false; haptic(6); }

    function scrollDown() {
      nextTick(() => { const el = listEl.value; if (el) el.scrollTop = el.scrollHeight; });
    }

    function send() {
      const text = draft.value.trim();
      if (!text) return;
      wsSend({ t: "game.chat", text });
      draft.value = "";
      haptic(10);
    }

    let stops = [];
    onMounted(() => {
      stops.push(onWs("game.entered", (msg) => noteRoom(msg)));
      stops.push(onWs("game.state", (msg) => noteRoom(msg)));
      stops.push(onWs("game.update", (msg) => noteRoom(msg)));
      stops.push(onWs("game.over", (msg) => noteRoom(msg)));
      stops.push(onWs("game.left", () => { roomInfo.value = null; msgs.value = []; open.value = false; }));
      stops.push(onWs("game.chat", (msg) => {
        const chat = msg && msg.chat;
        if (!chat) return;
        msgs.value.push(chat);
        if (msgs.value.length > 60) msgs.value.shift();
        if (open.value) { unread.value = 0; scrollDown(); }
        else if (chat.uid !== myId.value) unread.value = Math.min(99, unread.value + 1);
      }));
    });
    onUnmounted(() => { stops.forEach((fn) => fn && fn()); stops = []; });

    return { open, draft, msgs, unread, listEl, roomInfo, myId, isSeat, live, gameName,
             toggle, close, send, mediaUrl };
  },
  template: `
  <div class="mc" v-if="roomInfo">
    <button v-if="!open" class="mc-fab glass glass-thick glass-live" :class="{ 'mc-live': live }" @click="toggle">
      <Icon n="chat" :size="19" />
      <span>讨论</span>
      <i v-if="unread" class="mc-dot">{{ unread }}</i>
    </button>

    <Transition name="mat">
      <section v-if="open" class="mc-sheet glass glass-thick glass-live">
        <header class="mc-head">
          <div class="grow">
            <b>{{ gameName }} · 讨论</b>
            <p class="cap">{{ isSeat ? (live ? '你正在比赛，发言会出现在这里' : '等待开局…') : '观战中 · 你的发言会以弹幕飘过比赛同学的屏幕' }}</p>
          </div>
          <button class="btn btn-icon glass glass-thin" @click="close"><Icon n="close" :size="16" /></button>
        </header>

        <div class="mc-list" ref="listEl">
          <p v-if="!msgs.length" class="cap center mc-empty">还没有人说话，聊两句吧</p>
          <div v-for="(m, i) in msgs" :key="i" class="mc-row" :class="{ me: m.uid === myId, spec: m.spec }">
            <span class="avatar avatar-sm" :style="m.color ? { background: m.color } : {}">
              <img v-if="m.avatar" :src="mediaUrl(m.avatar)" :alt="m.name" loading="lazy" />
              <template v-else>{{ (m.name || '?').slice(0, 1) }}</template>
            </span>
            <div class="grow" style="min-width:0">
              <p class="cap">{{ m.name }}<span v-if="m.spec"> · 观战</span></p>
              <p class="mc-text">{{ m.text }}</p>
            </div>
          </div>
        </div>

        <form class="mc-form" @submit.prevent="send">
          <input class="field" v-model="draft" maxlength="120" :placeholder="isSeat ? '说点什么…' : '观战发言，会变成弹幕'"
                 enterkeyhint="send" />
          <button class="btn btn-primary btn-icon btn-lg" type="submit" :disabled="!draft.trim()">
            <Icon n="send" :size="18" />
          </button>
        </form>
      </section>
    </Transition>
  </div>`,
};
