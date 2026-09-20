import {
  defineView, registerRoute, ref, computed, onMounted, api, toast, navigate, store, haptic, confirmDialog,
} from "../ui.js";

function fmtDay(ts) {
  const d = new Date(ts * 1000);
  return (d.getMonth() + 1) + " 月 " + d.getDate() + " 日 " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

/* 更新日志：每次更新写一条，只在这里展示，不再往公告里发（用户要求） */
registerRoute("/changelog", defineView("changelog", {
  template: `
  <div class="page">
    <header class="big-title row gap3">
      <button class="btn btn-icon glass glass-thin" @click="navigate('/me')"><Icon n="back" :size="20" /></button>
      <div class="grow" style="min-width:0">
        <h1 class="t2">更新日志</h1>
        <p class="sub">当前 H5 版本 v{{ versionH5 }} · 共 {{ items.length }} 条</p>
      </div>
      <button v-if="isAdmin" class="btn btn-sm btn-primary" @click="openCompose">写一条</button>
    </header>

    <div class="stack mt5">
      <div v-for="item in items" :key="item.id" class="glass glass-thin pad5 log-card">
        <div class="row gap2">
          <span class="chip chip-accent">{{ item.version || '更新' }}</span>
          <b class="grow t3">{{ item.title }}</b>
          <button v-if="isAdmin" class="btn btn-icon" @click="remove(item)"><Icon n="trash" :size="16" /></button>
        </div>
        <p v-if="item.body" class="log-body mt3">{{ item.body }}</p>
        <p class="cap mt3">{{ fmtDay(item.created_at) }} · {{ item.author }}</p>
      </div>
      <div v-if="!items.length" class="glass glass-thin pad6 center sub">
        还没有更新记录
      </div>
    </div>
  </div>

  <Transition name="fade">
    <div v-if="sheet" class="scrim" @click="sheet = false"></div>
  </Transition>
  <Transition name="sheet">
    <div v-if="sheet" class="sheet">
      <div class="sheet-grab"></div>
      <h3 class="t3">写一条更新</h3>
      <p class="sub mt2">发布后只出现在「更新日志」里，不会再往公告里发。</p>
      <input class="field mt4" v-model="form.version" maxlength="24" :placeholder="'版本号，比如 v' + versionH5" />
      <input class="field mt3" v-model="form.title" maxlength="80" placeholder="一句话说明这次更新了什么" />
      <textarea class="field mt3" v-model="form.body" rows="6" maxlength="4000"
                placeholder="详细内容，一行一条，例如：&#10;· 讨论区新增匿名开关&#10;· 联机对战加入积分排行榜"></textarea>
      <div class="row gap2 mt4">
        <button class="btn grow" @click="sheet = false">取消</button>
        <button class="btn btn-primary grow" :disabled="!form.title.trim() || busy" @click="submit">
          {{ busy ? '发布中…' : '发布' }}
        </button>
      </div>
    </div>
  </Transition>
  `,
  style: `
  .log-card { display: block; }
  .log-body { white-space: pre-wrap; line-height: 1.6; color: var(--ink-2); font-size: var(--fs-sub); }
  .page { padding-bottom: calc(var(--tab-h) + var(--safe-b) + var(--s6)); }
  `,
  setup() {
    const items = ref([]);
    const versionH5 = ref(0);
    const sheet = ref(false);
    const busy = ref(false);
    const form = ref({ version: "", title: "", body: "" });
    const isAdmin = computed(() => !!store.user && store.user.role === "admin");

    async function load() {
      try {
        const res = await api("/api/changelog");
        items.value = res.items || [];
        versionH5.value = res.version_h5 || 0;
      } catch (err) { toast(err.message, "error"); }
    }

    function openCompose() {
      form.value = { version: "v" + (versionH5.value + 1), title: "", body: "" };
      sheet.value = true;
    }

    async function submit() {
      if (!form.value.title.trim() || busy.value) return;
      busy.value = true;
      try {
        await api("/api/admin/changelog", { method: "POST", body: {
          version: form.value.version.trim(), title: form.value.title.trim(),
          body: form.value.body.trim(), announce: false } });
        sheet.value = false;
        haptic([10, 30, 10]);
        toast("更新日志已发布", "ok");
        await load();
      } catch (err) { toast(err.message, "error"); }
      finally { busy.value = false; }
    }

    async function remove(item) {
      const yes = await confirmDialog("删除这条更新记录？公告不会被撤回。", { danger: true, okText: "删除" });
      if (!yes) return;
      try {
        await api("/api/admin/changelog/" + item.id, { method: "DELETE" });
        items.value = items.value.filter((x) => x.id !== item.id);
        toast("已删除", "ok");
      } catch (err) { toast(err.message, "error"); }
    }

    onMounted(load);
    return { items, versionH5, sheet, busy, form, isAdmin, fmtDay, openCompose, submit, remove, navigate };
  },
}));
