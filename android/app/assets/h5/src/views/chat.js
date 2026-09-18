import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, nextTick, watch,
  api, store, toast, haptic, onWs, wsSend, confirmDialog, navigate, route, registerSwipe, mediaUrl,
} from "../ui.js";

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const now = Date.now() / 1000;
  const hhmm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  if (now - ts < 300 && now >= ts) return "刚刚";
  if (new Date().toDateString() === d.toDateString()) return hhmm;
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + hhmm;
}

const EMOJIS = ["👍", "❤️", "😂", "🔥"];
const HUES = ["#0a6cff", "#7c5cff", "#17a34a", "#e8850c", "#e5484d", "#12a5a5", "#b060ff", "#d6437c"];

function colorFor(name) {
  let sum = 0;
  for (const ch of name || "x") sum += ch.charCodeAt(0);
  return HUES[sum % HUES.length];
}

function toMap(list) {
  const out = {};
  (list || []).forEach((item) => { out[item.emoji] = item.count; });
  return out;
}

/* 匿名消息一律用代号首字，绝不把真实头像泄露给同学。
   两个视图（话题列表 / 话题内消息）都要用，所以放在模块作用域。 */
function showAvatar(msg) { return !!(msg && msg.avatar && !msg.anon); }

const SHARED_STYLE = `
  .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--green);
    margin-right: 6px; box-shadow: 0 0 0 4px var(--green-soft); }
  .topic-root { display: block; }
  .topic-card {
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; display: block; width: 100%; text-align: left; border: 1px solid var(--hair); cursor: pointer;
    transition: transform var(--dur-fast) var(--ease-out); }
  .topic-card:active { transform: scale(0.985); }
  .topic-title { font-weight: 700; font-size: var(--fs-body); }
  .topic-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--ink-3); font-size: var(--fs-cap); }
  .fab-new { position: fixed; right: var(--s4); bottom: calc(var(--tab-h) + var(--safe-b) + var(--s4)); z-index: 30; }
`;

registerRoute("/chat", defineView("chatTopics", {
  template: `
  <div class="topic-root">
  <div class="page">
    <header class="big-title row-between">
      <div>
        <h1 class="t1">匿名讨论</h1>
        <p class="sub mt2"><span class="live"></span>{{ store.online }} 人在线 · 我是 <b>{{ store.alias || '匿名同学' }}</b></p>
      </div>
      <button class="btn btn-icon glass glass-thin" @click="refresh"><Icon n="refresh" :size="19" /></button>
    </header>

    <div class="searchbar mt4">
      <Icon n="search" :size="18" />
      <input v-model="query" placeholder="搜索话题或聊天记录" @keyup.enter="runSearch" />
      <button v-if="query" class="btn btn-sm" @click="clearSearch">清空</button>
    </div>

    <template v-if="searching">
      <h2 class="section-title">话题 · {{ found.topics.length }}</h2>
      <div class="stack">
        <button v-for="topic in found.topics" :key="topic.id" class="glass glass-thin pad4 topic-card" @click="open(topic)">
          <div class="topic-title">{{ topic.title }}</div>
          <p class="cap clamp2 mt2">{{ topic.content }}</p>
          <div class="topic-meta">
            <span>{{ topic.name }}</span><span>·</span><span>{{ topic.reply_count }} 条</span>
            <span class="grow"></span><span>{{ fmtTime(topic.last_at) }}</span>
          </div>
        </button>
      </div>
      <h2 class="section-title">聊天记录 · {{ found.messages.length }}</h2>
      <div class="glass glass-thin list">
        <button v-for="msg in found.messages" :key="msg.id" class="list-row tap" @click="openId(msg.topic_id)">
          <span class="chip">{{ msg.topic_title }}</span>
          <span class="grow elide">{{ msg.content }}</span>
          <span class="cap">{{ msg.name }}</span>
        </button>
        <div v-if="!found.messages.length" class="list-row sub">没有匹配的聊天记录</div>
      </div>
    </template>

    <template v-else>
      <h2 class="section-title">话题</h2>
      <div class="stack">
        <button v-for="topic in topics" :key="topic.id" class="glass glass-thin pad4 topic-card"
                @click="topicTap(topic)" @touchstart="topicPress(topic, $event)" @touchend="topicRelease" @touchcancel="topicRelease"
                @contextmenu.prevent="topicMenu(topic)">
          <div class="row gap2">
            <span v-if="topic.pinned" class="chip chip-orange">置顶</span>
            <span class="grow topic-title elide">{{ topic.title }}</span>
            <span v-if="topic.mine" class="chip chip-accent">我的</span>
          </div>
          <p class="cap clamp2 mt2">{{ topic.content || '（没有描述）' }}</p>
          <div class="topic-meta">
            <span class="avatar avatar-sm" :style="{ background: colorFor(topic.name) }">{{ topic.name.slice(0, 1) }}</span>
            <span class="elide">{{ topic.name }}</span>
            <span class="grow"></span>
            <span>{{ topic.reply_count }} 条</span><span>·</span><span>{{ fmtTime(topic.last_at) }}</span>
          </div>
        </button>
        <div v-if="!topics.length" class="glass glass-thin pad6 center sub">还没有话题，点右下角发起第一个吧</div>
      </div>
    </template>

  </div>

  <button class="fab fab-new" @click="compose"><Icon n="plus" :size="24" /></button>

  <Transition name="fade">
    <div v-if="sheet" class="scrim" @click="sheet = false"></div>
  </Transition>
  <Transition name="sheet">
    <div v-if="sheet" class="sheet">
      <div class="sheet-grab"></div>
      <h3 class="t3">发起话题</h3>
      <p class="sub mt2">每个话题里的聊天独立保存，别人在这里聊什么都不会串台。</p>
      <input class="field mt4" v-model="form.title" maxlength="60" placeholder="话题标题，比如「今晚自习约不约」" />
      <textarea class="field mt3" v-model="form.content" rows="3" maxlength="1000" placeholder="补充说明（可留空）"></textarea>
      <div class="row gap2 mt4">
        <button class="btn grow" :class="{ 'btn-primary': form.anon }" @click="form.anon = !form.anon">
          {{ form.anon ? '匿名发起' : '实名发起' }}
        </button>
        <button class="btn btn-primary grow" :disabled="!form.title.trim()" @click="submit">发布话题</button>
      </div>
    </div>
  </Transition>
  </div>
  `,
  style: SHARED_STYLE + `
  .fab-new { position: fixed; right: var(--s4); bottom: calc(var(--tab-h) + var(--safe-b) + var(--s4)); z-index: 30; }
  textarea.field { resize: none; font-family: inherit; }
  `,
  setup() {
    const topics = ref([]);
    const query = ref("");
    const searching = ref(false);
    const found = ref({ topics: [], messages: [] });
    const sheet = ref(false);
    const form = ref({ title: "", content: "", anon: true });
    let stopNew = null;
    let stopBump = null;

    async function load() {
      try {
        const res = await api("/api/chat/topics");
        topics.value = res.topics || [];
      } catch (err) { toast(err.message, "error"); }
    }
    function refresh() { load(); haptic(6); }

    async function runSearch() {
      const q = query.value.trim();
      if (!q) { searching.value = false; return; }
      try {
        const res = await api("/api/chat/search", { query: "q=" + encodeURIComponent(q) });
        found.value = { topics: res.topics || [], messages: res.messages || [] };
        searching.value = true;
      } catch (err) { toast(err.message, "error"); }
    }
    function clearSearch() { query.value = ""; searching.value = false; }
    let searchTimer = 0;
    watch(query, () => {
      const q = query.value.trim();
      clearTimeout(searchTimer);
      if (!q) { searching.value = false; return; }
      searchTimer = setTimeout(runSearch, 300);
    });

    function open(topic) { navigate("/chat/topic?id=" + topic.id); }

    /* 长按话题：只有管理员能删掉整个话题（资委/普通成员长按无效） */
    const canManage = computed(() => !!store.user && store.user.role === "admin");
    let pressTimer = null;
    let longPressAt = 0;

    function topicTap(topic) {
      if (longPressAt && Date.now() - longPressAt < 800) return;
      open(topic);
    }

    function topicPress(topic, ev) {
      topicRelease();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressAt = Date.now();
        topicMenu(topic);
      }, 520);
    }

    function topicRelease() {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }

    async function topicMenu(topic) {
      if (!canManage.value) return;
      haptic(10);
      const yes = await confirmDialog("删除话题「" + topic.title + "」？话题里所有聊天都会一起消失。", { danger: true, okText: "删除话题" });
      if (!yes) return;
      try {
        await api("/api/chat/topic/" + topic.id, { method: "DELETE" });
        topics.value = topics.value.filter((t) => t.id !== topic.id);
        toast("话题已删除", "ok");
      } catch (err) { toast(err.message, "error"); }
    }
    function openId(id) { navigate("/chat/topic?id=" + id); }
    function compose() { form.value = { title: "", content: "", anon: true }; sheet.value = true; }

    async function submit() {
      const title = form.value.title.trim();
      if (!title) return;
      try {
        const res = await api("/api/chat/topics", { method: "POST", body: {
          title, content: form.value.content.trim(), anon: form.value.anon ? 1 : 0 } });
        sheet.value = false;
        toast("话题已发布", "ok");
        navigate("/chat/topic?id=" + res.topic.id);
      } catch (err) { toast(err.message, "error"); }
    }

    onMounted(() => {
      load();
      stopNew = onWs("topic.new", (msg) => {
        if (!msg.topic) return;
        if (!topics.value.some((t) => t.id === msg.topic.id)) topics.value.unshift(msg.topic);
      });
      stopBump = onWs("topic.bump", (msg) => {
        const hit = topics.value.find((t) => t.id === msg.topic_id);
        if (hit) { hit.reply_count = msg.reply_count; hit.last_at = msg.last_at; }
      });
    });
    onUnmounted(() => {
      clearTimeout(searchTimer); if (stopNew) stopNew(); if (stopBump) stopBump(); });

    return { topics, query, searching, found, sheet, form, store, fmtTime, colorFor, canManage,
             refresh, runSearch, clearSearch, open, openId, compose, submit,
             topicTap, topicPress, topicRelease, topicMenu, showAvatar };
  },
}));

registerRoute("/chat/topic", defineView("chatTopic", {
  template: `
  <div class="chat-page">
    <header class="chat-head">
      <div class="row gap3">
        <button class="btn btn-icon glass glass-thin" @click="back"><Icon n="back" :size="20" /></button>
        <div class="grow" style="min-width:0">
          <h1 class="t2 elide">{{ topic ? topic.title : '话题' }}</h1>
          <p class="sub mt1">{{ topic ? topic.name + ' 发起 · ' + topic.reply_count + ' 条' : '加载中…' }}</p>
        </div>
        <button v-if="topic && (topic.mine || isAdmin)" class="btn btn-sm" :class="{ 'btn-danger': manage }" @click="manage = !manage">
          {{ manage ? '完成' : '管理' }}
        </button>
      </div>
      <p v-if="topic && topic.content" class="sub mt3 topic-desc">{{ topic.content }}</p>
    </header>

    <div ref="listEl" class="msg-list" @scroll="onScroll">
      <button v-if="hasMore" class="btn btn-sm btn-block" :disabled="loading" @click="loadMore">
        {{ loading ? '加载中…' : '查看更早的消息' }}
      </button>
      <div v-if="!messages.length && !loading" class="empty glass glass-thin">
        <Icon n="topic" :size="32" />
        <p class="t3 mt3">这个话题还很安静</p>
        <p class="sub">说点什么开头吧</p>
      </div>

      <div v-for="msg in messages" :key="msg.id" class="msg" :class="{ mine: msg.mine }"
           @pointerdown="pressStart(msg)" @pointerup="pressEnd" @pointerleave="pressEnd" @pointercancel="pressEnd">
        <span class="avatar avatar-sm" :style="{ background: colorFor(msg.name) }">
          <img v-if="showAvatar(msg)" :src="mediaUrl(msg.avatar)" :alt="msg.name" loading="lazy" />
          <template v-else>{{ msg.name.slice(0,1) }}</template>
        </span>
        <div class="bubble-wrap">
          <div class="meta">
            <b :style="{ color: msg.mine ? 'inherit' : colorFor(msg.name) }">{{ msg.mine ? '我' : msg.name }}</b>
            <span class="cap">{{ fmtTime(msg.created_at) }}</span>
            <span v-if="msg.anon && !msg.mine" class="cap">匿名</span>
            <span v-if="manage && msg.author_name" class="cap admin-tag">{{ msg.author_name }}</span>
          </div>
          <div class="bubble glass glass-liquid">{{ msg.content }}</div>
          <div class="row gap1 mt2 wrap">
            <button v-for="(count, emoji) in msg.reactions || {}" :key="emoji" class="react on" @click="react(msg, emoji)">
              {{ emoji }} {{ count }}
            </button>
          </div>
          <button v-if="isAdmin" class="btn btn-sm btn-danger mt2" @click="remove(msg)">删除</button>
        </div>
      </div>
    </div>

    <Transition name="mat">
      <div v-if="palette" class="palette glass glass-thick">
        <button v-for="e in emojis" :key="e" @click="react(palette, e)">{{ e }}</button>
      </div>
    </Transition>

    <div class="composer glass glass-thick">
      <button class="anon-toggle" :class="{ on: anon }" @click="anon = !anon">
        <Icon :n="anon ? 'eyeOff' : 'eye'" :size="18" />
        <span>{{ anon ? '匿名' : '实名' }}</span>
      </button>
      <input class="field" v-model="draft" :placeholder="anon ? '匿名说点什么…' : '以真名发言…'"
             maxlength="500" @keyup.enter="send" :disabled="store.settings.chat_enabled === false" />
      <button class="send" :disabled="!draft.trim()" @click="send"><Icon n="send" :size="20" /></button>
    </div>
  </div>
  `,
  style: SHARED_STYLE + `
  .chat-page { display: flex; flex-direction: column; height: 100dvh; }
  .chat-head { padding: calc(var(--safe-t) + var(--s4)) var(--s4) var(--s3);
    position: sticky; top: 0; z-index: 6;
    background: linear-gradient(180deg, var(--bg) 62%, rgba(255,255,255,0)); backdrop-filter: blur(10px); }
  .topic-desc { background: var(--mat-thin); border-radius: var(--r-md); padding: 10px 12px; }
  .msg-list { flex: 1; overflow-y: auto; padding: var(--s2) var(--s4) calc(var(--tab-h) + 78px + var(--safe-b));
    display: flex; flex-direction: column; gap: var(--s4); -webkit-overflow-scrolling: touch; }
  .empty { padding: var(--s7) var(--s5); text-align: center; display: flex; flex-direction: column;
    align-items: center; border-radius: var(--r-lg); }
  .msg { display: flex; gap: var(--s2); align-items: flex-start; max-width: 100%; }
  .msg.mine { flex-direction: row-reverse; }
  .bubble-wrap { max-width: 78%; display: flex; flex-direction: column; }
  .msg.mine .bubble-wrap { align-items: flex-end; }
  .meta { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; font-size: var(--fs-cap); color: var(--ink-3); }
  .bubble { padding: 10px 14px; border-radius: 18px; font-size: var(--fs-body); line-height: 1.45;
    word-break: break-word; white-space: pre-wrap; }
  .msg.mine .bubble { background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 92%, #fff 8%), var(--accent));
    color: #fff; border-color: transparent; }
  .react { border: 1px solid var(--hair); background: var(--mat-thin); border-radius: var(--r-full);
    padding: 3px 9px; font-size: var(--fs-cap); cursor: pointer; color: var(--ink-2); }
  .react.on { border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); }
  .admin-tag { color: var(--red); font-weight: 600; }
  .palette { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--tab-h) + 84px + var(--safe-b));
    display: flex; gap: 4px; padding: 6px; border-radius: var(--r-full); z-index: 25; }
  .palette button { width: 40px; height: 40px; border: 0; background: transparent; font-size: 20px; cursor: pointer;
    border-radius: 50%; transition: transform var(--dur-fast) var(--ease-out); }
  .palette button:active { transform: scale(1.25); }
  .composer { position: fixed; left: 0; right: 0; bottom: calc(var(--tab-h) + var(--safe-b)); display: flex;
    align-items: center; gap: var(--s2); padding: 10px var(--s3); border-top: 1px solid var(--hair); z-index: 20; }
  .composer .field { flex: 1; padding: 11px 14px; border-radius: var(--r-full); }
  .anon-toggle { display: flex; flex-direction: column; align-items: center; gap: 2px; border: 0; background: transparent;
    color: var(--ink-3); font-size: 9px; font-weight: 700; cursor: pointer; width: 44px; }
  .anon-toggle.on { color: var(--accent); }
  .send { width: 42px; height: 42px; border-radius: var(--r-full); border: 0; cursor: pointer;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 92%, #fff 8%), var(--accent)); color: #fff;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 32%, transparent);
    transition: transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast) linear; }
  .send:active { transform: scale(0.92); }
  .send[disabled] { opacity: 0.4; }
  `,
  setup() {
    const topicId = Number(route.query.id || 0);
    const topic = ref(null);
    const messages = ref([]);
    const draft = ref("");
    const anon = ref(true);
    const hasMore = ref(false);
    const loading = ref(false);
    const manage = ref(false);
    const palette = ref(null);
    const listEl = ref(null);
    const isAdmin = computed(() => store.user && store.user.role === "admin");
    let pressTimer = null;
    let atBottom = true;
    let stops = [];

    async function load(initial) {
      loading.value = true;
      try {
        const before = initial ? 0 : (messages.value[0] && messages.value[0].id) || 0;
        const res = await api("/api/chat/topic/" + topicId, { query: "limit=40" + (before ? "&before=" + before : "") });
        topic.value = res.topic;
        const list = (res.messages || []).map((msg) => ({ ...msg, reactions: toMap(msg.reactions) }));
        messages.value = initial ? list : list.concat(messages.value);
        hasMore.value = !!res.has_more;
        if (initial) { await nextTick(scrollToBottom); }
      } catch (err) { toast(err.message, "error"); }
      finally { loading.value = false; }
    }

    function loadMore() { load(false); }
    function scrollToBottom() { const el = listEl.value; if (el) el.scrollTop = el.scrollHeight; }
    function onScroll() {
      const el = listEl.value;
      if (!el) return;
      atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    }

    async function send() {
      const content = draft.value.trim();
      if (!content) return;
      draft.value = "";
      const okSent = wsSend({ t: "chat.send", content, anon: anon.value ? 1 : 0, topic_id: topicId });
      if (!okSent) {
        try {
          await api("/api/chat/post", { method: "POST", body: { content, anon: anon.value ? 1 : 0, topic_id: topicId } });
          load(false);
        } catch (err) { toast(err.message, "error"); }
      }
    }

    function pressStart(msg) {
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => { haptic(10); palette.value = msg; }, 420);
    }
    function pressEnd() { clearTimeout(pressTimer); }

    function react(msg, emoji) {
      palette.value = null;
      if (typeof emoji === "string" && EMOJIS.includes(emoji)) {
        wsSend({ t: "chat.react", post_id: msg.id, emoji });
        haptic(8);
      }
    }

    async function remove(msg) {
      const yes = await confirmDialog("删除这条消息？删除后所有人看不到。", { danger: true, okText: "删除" });
      if (!yes) return;
      try {
        await api("/api/admin/posts/" + msg.id, { method: "PATCH", body: { deleted: true } });
        messages.value = messages.value.filter((m) => m.id !== msg.id);
        toast("已删除", "ok");
      } catch (err) { toast(err.message, "error"); }
    }

    async function removeTopic() {
      const yes = await confirmDialog("删除这个话题？整个话题和里面的聊天都会消失。", { danger: true, okText: "删除话题" });
      if (!yes) return;
      try {
        await api("/api/chat/topic/" + topicId, { method: "DELETE" });
        toast("话题已删除", "ok");
        navigate("/chat");
      } catch (err) { toast(err.message, "error"); }
    }

    function back() { navigate("/chat"); }

    function closePalette(event) {
      if (!palette.value) return;
      if (event.target.closest(".palette") || event.target.closest(".msg")) return;
      palette.value = null;
    }

    onMounted(() => {
      load(true);
      stops.push(onWs("chat.new", (msg) => {
        const item = msg.msg;
        if (!item || Number(item.topic_id || 0) !== topicId) return;
        if (messages.value.some((m) => m.id === item.id)) return;
        messages.value.push({ ...item, reactions: toMap(item.reactions) });
        if (topic.value) topic.value.reply_count = (topic.value.reply_count || 0) + 1;
        if (atBottom || item.mine) nextTick(scrollToBottom);
        else toast("这个话题有新消息", "info", 1400);
      }));
      stops.push(onWs("chat.reactions", (msg) => {
        const hit = messages.value.find((m) => m.id === msg.post_id);
        if (hit) hit.reactions = toMap(msg.reactions);
      }));
      stops.push(registerSwipe("/chat/topic", () => true));
      document.addEventListener("pointerdown", closePalette);
      stops.push(() => document.removeEventListener("pointerdown", closePalette));
    });
    onUnmounted(() => stops.forEach((fn) => fn && fn()));

    return { topic, messages, draft, anon, hasMore, loading, manage, palette, listEl, isAdmin,
             emojis: EMOJIS, store, fmtTime, colorFor, loadMore, send, react, remove, removeTopic,
             pressStart, pressEnd, onScroll, back, showAvatar, mediaUrl };
  },
}));
