import { defineView, registerRoute, ref, computed, onMounted, api, toast, navigate, route, store } from "../ui.js";

function fmt(ts, withDate = true) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${time}` : time;
}

const STATUS = {
  present: { text: "已签到", cls: "chip-green" },
  late: { text: "迟到", cls: "chip-orange" },
  leave: { text: "请假", cls: "chip" },
  absent: { text: "缺勤", cls: "chip-red" },
};

registerRoute("/records", defineView("records", {
  template: `
  <div class="page">
    <header class="big-title row gap3">
      <button class="btn btn-icon glass glass-thin" @click="navigate('/')"><Icon n="back" :size="20" /></button>
      <div class="grow">
        <h1 class="t2">签到记录</h1>
        <p class="sub">{{ detail ? detail.title : '我的全部出勤' }}</p>
      </div>
      <span v-if="!detail" class="chip chip-accent">{{ stats.rate || 0 }}%</span>
    </header>

    <!-- 场次详情(老师视角) -->
    <section v-if="detail" class="mt5 stack">
      <div class="glass glass-thick glass-liquid pad5">
        <div class="row-between">
          <div>
            <span class="chip" :class="detail.status === 'open' ? 'chip-accent' : 'chip-orange'">
              <span class="dot"></span>{{ detail.status === 'open' ? '进行中' : '已结束' }}
            </span>
            <h2 class="t3 mt3">{{ detail.title }}</h2>
            <p class="sub mt2">{{ fmt(detail.starts_at) }} 开始 · 应到 {{ detail.total }} 人 · 实到 {{ detail.present }} 人</p>
          </div>
          <div v-if="detail.code" class="code-box">
            <span class="cap">签到码</span><b class="mono">{{ detail.code }}</b>
          </div>
        </div>
      </div>

      <h2 class="section-title">已签到 {{ (detail.records || []).length }}</h2>
      <div class="glass glass-thin list">
        <div v-for="r in detail.records" :key="r.id" class="list-row">
          <span class="avatar avatar-sm">{{ r.name.slice(0,1) }}</span>
          <div class="grow" style="min-width:0">
            <div class="elide">{{ r.name }}</div>
            <div class="cap elide">{{ fmt(r.created_at, false) }} · {{ r.device || 'web' }}<template v-if="r.by_admin"> · 管理员录入</template></div>
          </div>
          <span class="chip" :class="statusOf(r.status).cls">{{ statusOf(r.status).text }}</span>
        </div>
        <div v-if="!(detail.records || []).length" class="list-row sub">还没有人签到</div>
      </div>

      <template v-if="detail.missing && detail.missing.length">
        <h2 class="section-title">未签到 {{ detail.missing.length }}</h2>
        <div class="glass glass-thin list">
          <div v-for="u in detail.missing" :key="u.id" class="list-row">
            <span class="avatar avatar-sm" style="background:var(--ink-3)">{{ u.name.slice(0,1) }}</span>
            <span class="grow elide">{{ u.name }}</span>
            <button class="btn btn-sm" @click="mark(u, 'leave')">记请假</button>
            <button class="btn btn-sm btn-danger" @click="mark(u, 'absent')">记缺勤</button>
          </div>
        </div>
      </template>
    </section>

    <!-- 我的记录 -->
    <section v-else class="mt5 stack">
      <div class="seg">
        <button v-for="f in filters" :key="f.key" :class="{ on: filter === f.key }" @click="filter = f.key">{{ f.label }}</button>
      </div>
      <div class="glass glass-thin list mt3">
        <div v-for="item in visible" :key="item.id" class="list-row tap" @click="openSession(item.session_id)">
          <span class="chip" :class="statusOf(item.status).cls">{{ statusOf(item.status).text }}</span>
          <div class="grow" style="min-width:0">
            <div class="elide">{{ item.title }}</div>
            <div class="cap">{{ fmt(item.starts_at) }}<template v-if="item.note"> · {{ item.note }}</template></div>
          </div>
          <Icon n="back" :size="16" style="transform:rotate(180deg);color:var(--ink-3)" />
        </div>
        <div v-if="!visible.length" class="list-row sub">没有符合条件的记录</div>
      </div>
    </section>
  </div>`,
  style: `
  .code-box { text-align: center; padding: 10px 14px; border-radius: var(--r-md); background: var(--accent-soft); }
  .code-box b { display: block; font-size: 22px; letter-spacing: 3px; color: var(--accent); }
  `,
  setup() {
    const stats = ref(store.stats || {});
    const detail = ref(null);
    const filter = ref("all");
    const filters = [
      { key: "all", label: "全部" },
      { key: "present", label: "已签到" },
      { key: "late", label: "迟到" },
      { key: "leave", label: "请假" },
    ];
    const records = computed(() => stats.value.recent || []);
    const visible = computed(() => filter.value === "all" ? records.value
      : records.value.filter((r) => (filter.value === "present" ? r.status === "present" : r.status === filter.value)));

    async function load() {
      const sid = route.query.session;
      if (sid) {
        try {
          const res = await api("/api/sign/session/" + sid);
          detail.value = res.session;
        } catch (err) {
          toast(err.message, "error");
          detail.value = null;
        }
        return;
      }
      detail.value = null;
      try {
        const res = await api("/api/sign/mine");
        stats.value = res.stats;
        store.stats = res.stats;
      } catch (err) { toast(err.message, "error"); }
    }

    function openSession(sid) {
      if (store.user?.role === "admin") navigate("/records?session=" + sid);
    }

    async function mark(user, status) {
      try {
        await api("/api/admin/records", { method: "POST", body: { session_id: detail.value.id, user_id: user.id, status } });
        toast(user.name + (status === "leave" ? " 已记请假" : " 已记缺勤"), "ok");
        await load();
      } catch (err) { toast(err.message, "error"); }
    }

    function statusOf(status) { return STATUS[status] || { text: "未签到", cls: "" }; }

    onMounted(load);
    return { stats, detail, filter, filters, visible, load, openSession, mark, statusOf, fmt, navigate, store };
  },
}));
