import { defineView, registerRoute, ref, computed, onMounted, onUnmounted, navigate, route, store, api, toast, haptic, confirmDialog, logout, isApp, setToken, mediaUrl } from "../ui.js";

const COLORS = ["#0a84ff", "#34c759", "#ff9500", "#ff3b30", "#af52de", "#5ac8fa", "#ff2d55", "#8e8e93"];

registerRoute("/me", defineView("profile", {
  template: `
  <div class="page">
    <section class="pf-hero glass glass-thick">
      <div class="row gap4">
        <span class="avatar pf-avatar" :style="avatarStyle">
          <img v-if="myAvatar" :src="myAvatar" alt="" />
          <template v-else>{{ initial }}</template>
        </span>
        <div class="grow">
          <h1 class="t2">{{ store.user?.name }}</h1>
          <p class="sub">@{{ store.user?.username }}</p>
          <span class="chip mt2" :class="roleChip.cls">{{ roleChip.text }}</span>
        </div>
        <button class="btn btn-icon glass glass-thin" @click="editOpen = !editOpen" :aria-expanded="String(editOpen)">
          <Icon :n="editOpen ? 'close' : 'edit'" :size="18" />
        </button>
      </div>

      <div class="pf-stats mt5">
        <div class="pf-stat"><b class="num">{{ stats.rate ?? 0 }}<i>%</i></b><span>出勤率</span></div>
        <div class="pf-stat"><b class="num">{{ stats.checked ?? 0 }}</b><span>已签到</span></div>
        <div class="pf-stat"><b class="num">{{ stats.streak ?? 0 }}</b><span>连续天数</span></div>
        <div class="pf-stat"><b class="num">{{ stats.missed ?? 0 }}</b><span>缺勤</span></div>
      </div>
    </section>

    <Transition name="mat">
      <section v-if="editOpen" class="glass glass-thin pf-card mt4">
        <label class="label">头像</label>
        <div class="row gap3 mt2">
          <span class="avatar pf-avatar-sm" :style="avatarStyle">
            <img v-if="myAvatar" :src="myAvatar" alt="" />
            <template v-else>{{ initial }}</template>
          </span>
          <div class="grow">
            <input ref="fileEl" type="file" accept="image/*" class="hidden" @change="pickAvatar" />
            <button class="btn btn-sm btn-block" :disabled="avatarBusy" @click="chooseFile">
              {{ avatarBusy ? "上传中…" : "从相册选择" }}
            </button>
            <button v-if="myAvatar" class="btn btn-sm btn-block mt2" @click="clearAvatar">恢复默认头像</button>
          </div>
        </div>

        <label class="label mt4">昵称</label>
        <input class="field" v-model="form.name" maxlength="20" placeholder="显示给同学的名字" />
        <label class="label mt4">头像颜色（未设置头像时生效）</label>
        <div class="pf-swatches">
          <button v-for="c in colors" :key="c" class="pf-sw" :class="{ on: form.color === c }"
                  :style="{ background: c }" @click="form.color = c; haptic(6)"></button>
        </div>
        <button class="btn btn-primary btn-block mt5" :disabled="saving" @click="save">
          {{ saving ? "保存中…" : "保存资料" }}
        </button>
      </section>
    </Transition>

    <h2 class="section-title">我的积分</h2>
    <section class="glass glass-thin list">
      <div class="list-row">
        <Icon n="crown" :size="19" /><span class="grow">总积分</span>
        <b class="num">{{ points.total }}</b>
      </div>
      <div class="list-row">
        <span class="grow" style="padding-left:27px">联机对战</span>
        <span class="cap num">{{ points.online }} 分 · {{ points.wins }} 胜 {{ points.losses }} 负</span>
      </div>
      <div class="list-row">
        <span class="grow" style="padding-left:27px">单机挑战</span>
        <span class="cap num">{{ points.solo }} 分</span>
      </div>
      <button class="list-row tap" @click="navigate('/changelog')">
        <Icon n="sparkles" :size="19" /><span class="grow">更新日志</span>
        <span class="cap">v{{ store.settings.version_h5 || 1 }}</span>
        <Icon n="back" :size="17" class="pf-chev" />
      </button>
    </section>

    <h2 class="section-title">我的出勤</h2>
    <section class="glass glass-thin list">
      <div v-for="r in recent" :key="r.id" class="list-row">
        <span class="pf-dot" :style="{ background: colorOf(r.status) }"></span>
        <div class="grow">
          <p class="pf-title">{{ r.title || "签到" }}</p>
          <p class="cap">{{ when(r.starts_at || r.created_at) }}</p>
        </div>
        <span class="chip" :class="chipOf(r.status)">{{ labelOf(r.status) }}</span>
      </div>
      <div v-if="!recent.length" class="list-row sub">还没有签到记录</div>
    </section>

    <h2 class="section-title">账号</h2>
    <section class="glass glass-thin list">
      <button class="list-row tap" @click="pwdOpen = !pwdOpen">
        <Icon n="lock" :size="19" /><span class="grow">修改密码</span><Icon n="back" :size="17" class="pf-chev" />
      </button>
      <div v-if="pwdOpen" class="pf-pwd pad5">
        <input class="field" type="password" v-model="pwd.old" placeholder="当前密码" autocomplete="current-password" />
        <input class="field mt3" type="password" v-model="pwd.next" placeholder="新密码（至少 5 位）" autocomplete="new-password" />
        <button class="btn btn-primary btn-block mt4" :disabled="pwdBusy" @click="changePassword">确认修改</button>
      </div>
      <button class="list-row tap" @click="checkUpdate" :disabled="checking">
        <Icon n="refresh" :size="19" /><span class="grow">{{ checking ? "检查中…" : "检查更新" }}</span>
        <span class="cap">当前 v{{ versionText }}</span>
      </button>
      <button class="list-row tap danger" @click="doLogout">
        <Icon n="logout" :size="19" /><span class="grow">退出登录</span>
      </button>
    </section>

    <h2 class="section-title">关于</h2>
    <section class="glass glass-thin list">
      <div class="list-row"><span class="grow">班级签到系统</span><span class="cap">{{ store.settings.site_name || "班级签到" }}</span></div>
      <div class="list-row"><span class="grow">在线同学</span><span class="cap num">{{ store.online }} 人</span></div>
      <div class="list-row"><span class="grow">H5 版本</span><span class="cap num">v{{ store.settings.version_h5 || 1 }}</span></div>
      <div class="list-row"><span class="grow">运行模式</span><span class="cap">{{ isApp() ? "安卓客户端" : "网页版" }}</span></div>
      <div class="list-row"><span class="grow">服务器时间</span><span class="cap num">{{ clock }}</span></div>
    </section>

    <div v-if="isStaff" class="mt4">
      <button class="btn btn-block btn-lg" @click="navigate('/admin')">
        <Icon n="shield" :size="18" /> 进入管理后台
      </button>
    </div>

    <p class="cap center pf-foot">© {{ year }} 我们的班级 · 一起签到，一起玩</p>
  </div>`,
  style: `
  .pf-hero { padding: calc(var(--safe-t) + var(--s5)) var(--s5) var(--s5); border-radius: 0 0 var(--r-xl) var(--r-xl); }
  .pf-avatar { width: 68px; height: 68px; font-size: 27px; overflow: hidden; }
  .pf-avatar-sm { width: 56px; height: 56px; font-size: 22px; overflow: hidden; }
  .avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; display: block; }
  .hidden { display: none; }
  .pf-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s2); }
  .pf-stat { text-align: center; padding: var(--s3) 0; border-radius: var(--r-md); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .pf-stat b { display: block; font-size: 21px; }
  .pf-stat b i { font-size: 12px; font-style: normal; opacity: .6; }
  .pf-stat span { font-size: 11px; color: var(--ink-2); }
  .pf-card { padding: var(--s5); border-radius: var(--r-lg); }
  .pf-swatches { display: flex; gap: 12px; flex-wrap: wrap; }
  .pf-sw { width: 30px; height: 30px; border-radius: 50%; border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12);
    transition: transform var(--dur-med) var(--ease-out); }
  .pf-sw.on { border-color: var(--ink); transform: scale(1.14); }
  .pf-title { font-weight: 600; font-size: var(--fs-sub); }
  .pf-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .pf-chev { transform: rotate(180deg); opacity: .3; }
  .list-row.tap { cursor: pointer; transition: background var(--dur-fast) var(--ease-out); }
  .list-row.tap:active { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .list-row.danger { color: var(--red); }
  .pf-pwd { border-top: 1px solid var(--hair); }
  .pf-foot { padding: var(--s6) 0 calc(var(--safe-b) + 96px); opacity: .55; }
  `,
  setup() {
    const form = ref({ name: "", color: "" });
    const pwd = ref({ old: "", next: "" });
    const editOpen = ref(false);
    const pwdOpen = ref(false);
    const saving = ref(false);
    const pwdBusy = ref(false);
    const bundle = ref(0);
    const clock = ref("");
    const fileEl = ref(null);
    const avatarBusy = ref(false);
    const checking = ref(false);
    const colors = COLORS;

    const stats = computed(() => store.stats || {});
    const points = computed(() => store.points || { online: 0, solo: 0, total: 0, wins: 0, losses: 0 });
    const isAdmin = computed(() => store.user && store.user.role === "admin");
    const isStaff = computed(() => !!store.user && ["admin", "committee", "study"].includes(store.user.role));
    const roleChip = computed(() => {
      const role = store.user && store.user.role;
      if (role === "admin") return { text: "管理员", cls: "chip-accent" };
      if (role === "committee") return { text: "资委", cls: "chip-orange" };
      if (role === "study") return { text: "学委", cls: "chip-orange" };
      return { text: "班级成员", cls: "" };
    });
    const myAvatar = computed(() => (store.user && store.user.avatar ? mediaUrl(store.user.avatar) : ""));
    const versionText = computed(() => {
      const code = appCode();
      if (code) return String(code);
      return String(store.settings.version_h5 || 1);
    });

    function appCode() {
      try {
        if (!isApp() || !window.ClassCheckIn) return 0;
        const raw = window.ClassCheckIn.versionCode;
        const value = typeof raw === "function" ? raw.call(window.ClassCheckIn) : raw;
        const num = parseInt(value, 10);
        return Number.isFinite(num) && num > 0 ? num : 0;
      } catch (err) {
        return 0;
      }
    }

    function currentH5Code() {
      return appCode() || Number(store.settings.version_h5 || 0);
    }
    const initial = computed(() => (store.user?.name || "?").slice(0, 1));
    const recent = computed(() => store.stats?.recent || []);
    const year = new Date().getFullYear();
    const avatarStyle = computed(() => ({
      background: store.user?.color ? store.user.color : "linear-gradient(140deg, var(--accent), var(--purple))",
      color: "#fff",
    }));

    function labelOf(status) {
      return { present: "已签到", late: "迟到", leave: "请假", absent: "缺勤" }[status] || status;
    }
    function chipOf(status) {
      return { present: "chip-green", late: "chip-orange", leave: "chip-accent", absent: "chip-red" }[status] || "";
    }
    function colorOf(status) {
      return { present: "var(--green)", late: "var(--orange)", leave: "var(--accent)", absent: "var(--red)" }[status] || "var(--ink-3)";
    }
    function when(ts) {
      if (!ts) return "";
      const d = new Date(ts * 1000);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getMonth() + 1) + "月" + p(d.getDate()) + "日 " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    async function save() {
      if (saving.value) return;
      saving.value = true;
      try {
        await api("/api/me", { method: "POST", body: { name: form.value.name, color: form.value.color } });
        store.user = { ...store.user, name: form.value.name, color: form.value.color };
        toast("已保存", "success");
        haptic(12);
        editOpen.value = false;
      } catch (err) {
        toast(err.message || "保存失败", "error");
      } finally {
        saving.value = false;
      }
    }

    async function changePassword() {
      if (pwdBusy.value) return;
      pwdBusy.value = true;
      try {
        await api("/api/me/password", { method: "POST", body: { old: pwd.value.old, new: pwd.value.next } });
        pwd.value = { old: "", next: "" };
        pwdOpen.value = false;
        toast("密码已更新", "success");
        haptic(12);
      } catch (err) {
        toast(err.message || "修改失败", "error");
      } finally {
        pwdBusy.value = false;
      }
    }

    async function checkUpdate() {
      if (checking.value) return;
      checking.value = true;
      haptic(8);
      try {
        const code = currentH5Code();
        bundle.value = code;
        const info = await api("/api/app/version", { query: "platform=h5&code=" + code });
        const latest = Number(info.version_code || 0);
        if (!info.has_update) {
          toast("已是最新版本 v" + (latest || code), "success");
          return;
        }
        if (!isApp()) {
          const yes = await confirmDialog("服务器上有新版本 v" + latest + "，网页版刷新一下就能用上。", { okText: "立即刷新" });
          if (yes) location.reload();
          return;
        }
        const okGo = await confirmDialog("发现新版本 " + (info.version_name || info.version_code) + "（" + Math.round((info.size || 0) / 1024) + " KB），立即更新？", { okText: "更新" });
        if (!okGo) return;
        if (window.ClassCheckIn && window.ClassCheckIn.updateH5) {
          window.ClassCheckIn.updateH5(info.url, String(info.version_code), info.version_name || "");
          toast("正在后台下载 " + Math.round((info.size || 0) / 1024) + " KB…", "info", 4000);
        } else {
          toast("当前环境不支持自动更新，请手动刷新", "warn");
        }
      } catch (err) {
        toast("检查更新失败：" + (err.message || "网络异常"), "error");
      } finally {
        checking.value = false;
      }
    }

    function chooseFile() {
      if (fileEl.value) fileEl.value.click();
    }

    function shrinkImage(file, max) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
            const w = Math.max(1, Math.round((img.width || max) * scale));
            const h = Math.max(1, Math.round((img.height || max) * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.86));
          };
          img.onerror = () => reject(new Error("图片读取失败"));
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
      });
    }

    async function pickAvatar(event) {
      const file = (event.target.files || [])[0];
      if (!file) return;
      if (!/^image\//.test(file.type || "")) { toast("请选择图片文件", "warn"); return; }
      avatarBusy.value = true;
      try {
        const data = await shrinkImage(file, 512);
        const res = await api("/api/me/avatar", { method: "POST", body: { data } });
        store.user = { ...store.user, avatar: res.avatar };
        toast("头像已更新", "success");
        haptic(12);
      } catch (err) {
        toast(err.message || "上传失败", "error");
      } finally {
        avatarBusy.value = false;
        if (fileEl.value) fileEl.value.value = "";
      }
    }

    async function clearAvatar() {
      try {
        await api("/api/me/avatar/clear", { method: "POST" });
        store.user = { ...store.user, avatar: "" };
        toast("已恢复默认头像", "ok");
      } catch (err) {
        toast(err.message || "操作失败", "error");
      }
    }

    async function doLogout() {
      const yes = await confirmDialog("确定要退出登录吗？", { okText: "退出", danger: true });
      if (!yes) return;
      try { await api("/api/logout", { method: "POST" }); } catch (err) { /* ignore */ }
      setToken("");
      logout(true);
      navigate("/login", true);
    }

    onMounted(() => {
      /* 根路径/我的页不注册滑动处理器，交给全局分页器（否则会吞掉左右滑动） */
      form.value = { name: store.user?.name || "", color: store.user?.color || COLORS[0] };
      const base = Number(store.settings.version_h5 || 0);
      bundle.value = base;
      if (isApp() && window.ClassCheckIn) bundle.value = Number(window.ClassCheckIn.versionCode || base);
      window.__onBundle = (payload) => {
        const data = payload || {};
        if (data.state === "done") toast("更新完成，正在重启界面…", "success", 3000);
        else if (data.state === "error") toast("更新失败：" + (data.message || "未知错误"), "error", 4000);
        else toast("下载中 " + (data.percent || 0) + "%", "info", 1200);
      };
      const tick = () => {
        if (route.path !== "/me") return;   // 分页器会把本页预挂载在后台，离开时别再每秒重渲染
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        clock.value = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
      };
      tick();
      const timer = setInterval(tick, 1000);
      onUnmounted(() => clearInterval(timer));
    });

    return { store, stats, points, form, pwd, editOpen, pwdOpen, saving, pwdBusy, bundle, clock, colors, fileEl,
             avatarBusy, checking, isAdmin, isStaff, roleChip, myAvatar, versionText,
             initial, recent, year, avatarStyle, labelOf, chipOf, colorOf, when,
             save, changePassword, checkUpdate, doLogout, navigate, isApp, setToken,
             chooseFile, pickAvatar, clearAvatar };
  },
}));
