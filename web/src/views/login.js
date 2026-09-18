import { defineView, registerRoute, ref, onMounted, nextTick, api, setToken, store, navigate, toast, haptic, isApp, wsConnect } from "../ui.js";

registerRoute("/login", defineView("login", {
  template: `
  <div class="login-wrap">
    <div class="login-card glass glass-thick glass-liquid">
      <div class="brand">
        <div class="logo"><span class="logo-in"></span></div>
        <h1 class="display">{{ siteName }}</h1>
        <p class="sub mt2">{{ subtitle }}</p>
      </div>

      <div class="stack mt7">
        <label class="field-group">
          <span class="label">账号</span>
          <input ref="userEl" class="field" v-model.trim="username" autocomplete="username"
                 placeholder="学号或姓名拼音" @keyup.enter="submit" />
        </label>
        <label class="field-group">
          <span class="label">密码</span>
          <div class="pw">
            <input class="field" :type="showPw ? 'text' : 'password'" v-model="password"
                   autocomplete="current-password" placeholder="请输入密码" @keyup.enter="submit" />
            <button class="pw-eye" type="button" @click="showPw = !showPw" tabindex="-1">
              <Icon :n="showPw ? 'eyeOff' : 'eye'" :size="19" />
            </button>
          </div>
        </label>

        <p v-if="error" class="err">{{ error }}</p>

        <button class="btn btn-primary btn-lg btn-block mt2" :disabled="busy || !canSubmit" @click="submit">
          <span v-if="!busy">进入班级</span>
          <span v-else class="row gap2"><span class="spin"></span>正在登录</span>
        </button>
        <button v-if="registerOpen" class="btn btn-ghost btn-block" @click="register">注册新账号</button>
      </div>

      <div class="row-between mt7 cap">
        <span>{{ isApp() ? 'Android 客户端' : '网页版' }}</span>
        <span v-if="online > 0"><span class="dot" style="background:var(--green);display:inline-block;margin-right:5px"></span>{{ online }} 人在线</span>
        <span v-else>H5 / APK 通用</span>
      </div>
    </div>
    <p class="login-foot cap">v{{ version }} · {{ host }}</p>
  </div>`,
  style: `
  .login-wrap { min-height: 100dvh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; padding: var(--s5) var(--s4) calc(var(--safe-b) + var(--s6)); gap: var(--s4); }
  .login-card { width: min(430px, 100%); padding: var(--s6) var(--s5) var(--s5);
    transition: opacity 520ms var(--ease-out), transform 520ms var(--ease-out); }
  @starting-style { .login-card { opacity: 0; transform: translateY(22px) scale(0.97); } }
  .brand { text-align: center; }
  .logo { width: 74px; height: 74px; border-radius: 24px; margin: 0 auto var(--s4);
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 88%, #fff 12%), var(--purple));
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 14px 34px color-mix(in srgb, var(--accent) 38%, transparent), inset 0 1px 0 rgba(255,255,255,0.5); }
  .logo-in { width: 30px; height: 30px; border-radius: 10px; border: 3px solid #fff; position: relative; }
  .logo-in::after { content: ""; position: absolute; left: 4px; top: 8px; width: 12px; height: 5px;
    border-left: 3px solid #fff; border-bottom: 3px solid #fff; transform: rotate(-45deg); border-radius: 1px; }
  .field-group { display: block; }
  .field-group .label { display: block; margin: 0 0 var(--s2) var(--s2); }
  .pw { position: relative; }
  .pw .field { padding-right: 46px; }
  .pw-eye { position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 36px; height: 36px; border: 0; background: transparent; color: var(--ink-3); cursor: pointer;
    display: flex; align-items: center; justify-content: center; border-radius: var(--r-full); }
  .pw-eye:active { background: var(--hair); }
  .err { margin: 0; color: var(--red); font-size: var(--fs-sub); font-weight: 600; animation: shake 320ms var(--ease-inout); }
  @keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
  .spin { width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.45);
    border-top-color: #fff; animation: sp 700ms linear infinite; display: inline-block; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .login-foot { margin: 0; text-align: center; }
  @media (prefers-reduced-motion: reduce) { .err { animation: none; } }
  `,
  setup() {
    const username = ref(localStorage.getItem("checkin_last_user") || "");
    const password = ref("");
    const showPw = ref(false);
    const busy = ref(false);
    const error = ref("");
    const userEl = ref(null);
    const siteName = ref(store.settings.site_name || "班级签到");
    const subtitle = ref(store.settings.site_subtitle || "");
    const registerOpen = ref(false);
    const version = ref(store.settings.version_h5 || 1);
    const host = location.host;
    const online = ref(store.online);

    async function loadConfig() {
      try {
        const cfg = await api("/api/config");
        siteName.value = cfg.site_name || siteName.value;
        subtitle.value = cfg.site_subtitle || "";
        registerOpen.value = !!cfg.register_open;
        version.value = cfg.version_h5;
        store.settings = { ...store.settings, ...cfg };
      } catch (err) { /* ignore */ }
    }

    async function submit() {
      if (busy.value) return;
      const name = username.value.trim();
      if (!name || !password.value) {
        error.value = "请输入账号和密码";
        haptic(30);
        return;
      }
      busy.value = true;
      error.value = "";
      try {
        const res = await api("/api/login", { method: "POST", body: { username: name, password: password.value } });
        setToken(res.token);
        store.user = res.user;
        store.settings = { ...store.settings, ...(res.settings || {}) };
        localStorage.setItem("checkin_last_user", name);
        wsConnect();
        haptic(12);
        navigate(res.user.role === "admin" ? "/admin" : "/");
      } catch (err) {
        error.value = err.message || "登录失败";
        haptic([14, 40, 14]);
      } finally {
        busy.value = false;
      }
    }

    async function register() {
      const name = username.value.trim();
      if (!name || password.value.length < 5) {
        error.value = "注册请先填好账号，密码至少 5 位";
        return;
      }
      try {
        await api("/api/register", { method: "POST", body: { username: name, password: password.value, name } });
        toast("注册成功，正在登录…", "ok");
        await submit();
      } catch (err) {
        error.value = err.message;
      }
    }

    onMounted(async () => {
      await loadConfig();
      await nextTick();
      if (userEl.value && !username.value) userEl.value.focus();
    });

    return { username, password, showPw, busy, error, userEl, siteName, subtitle, registerOpen,
             version, host, online, submit, register, isApp,
             get canSubmit() { return username.value && password.value; } };
  },
}));
