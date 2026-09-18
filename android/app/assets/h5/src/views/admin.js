import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, nextTick, navigate, store, api, toast, haptic,
  confirmDialog, registerSwipe, deviceLocation, pillStyle,
} from "../ui.js";
import { createMapPicker } from "../mapkit.js";

const TABS = [
  { id: "overview", label: "概览" },
  { id: "users", label: "成员", adminOnly: true },
  { id: "sessions", label: "场次" },
  { id: "records", label: "记录" },
  { id: "posts", label: "讨论" },
  { id: "signset", label: "签到设置" },
  { id: "settings", label: "设置", adminOnly: true },
  { id: "advanced", label: "高级", adminOnly: true },
];

const SETTING_TOGGLES = [
  { key: "signin_enabled", label: "签到功能", hint: "关闭后同学无法签到" },
  { key: "chat_enabled", label: "匿名讨论", hint: "关闭后讨论区停止发帖" },
  { key: "games_enabled", label: "游戏大厅", hint: "关闭后仅管理员可建房" },
  { key: "register_open", label: "开放注册", hint: "允许同学自助注册账号" },
  { key: "checkin_code_required", label: "签到口令", hint: "签到需要输入场次口令" },
];

registerRoute("/admin", defineView("admin", {
  template: `
  <div class="page admin">
    <header class="head row gap3">
      <div class="grow">
        <h1 class="t1">管理后台</h1>
        <p class="sub">{{ store.user?.name }} · {{ isAdmin ? '管理员（最高权限）' : '资委' }}</p>
      </div>
      <button class="btn btn-icon glass glass-thin" :class="{ spin: loading }" @click="refresh">
        <Icon n="refresh" :size="19" />
      </button>
    </header>

    <div class="ad-segs glass glass-thin" ref="segEl" data-no-swipe>
      <span class="seg-pill" :style="pill" aria-hidden="true"></span>
      <button v-for="t in tabs" :key="t.id" :class="{ on: tab === t.id }" @click="go(t.id)">
        {{ t.label }}
      </button>
    </div>

    <div class="ad-body" ref="bodyEl" :class="{ anim: bodyAnim }">
    <!-- ---------------------------------------------------------- overview -->
    <template v-if="tab === 'overview'">
      <div class="ad-gauges mt4">
        <div class="ad-gauge glass glass-thin">
          <b class="num">{{ online }}</b><span>在线人数</span>
        </div>
        <div class="ad-gauge glass glass-thin">
          <b class="num">{{ overview.users || 0 }}</b><span>账号总数</span>
        </div>
        <div class="ad-gauge glass glass-thin">
          <b class="num">{{ overview.sessions || 0 }}</b><span>签到场次</span>
        </div>
        <div class="ad-gauge glass glass-thin">
          <b class="num">{{ overview.records || 0 }}</b><span>签到记录</span>
        </div>
        <div class="ad-gauge glass glass-thin">
          <b class="num">{{ overview.posts || 0 }}</b><span>讨论帖</span>
        </div>
        <div class="ad-gauge glass glass-thin">
          <b class="num">{{ overview.games || 0 }}</b><span>对局数</span>
        </div>
      </div>

      <h2 v-if="isAdmin" class="section-title">服务器</h2>
      <div v-if="isAdmin" class="glass glass-thin ad-card">
        <div class="ad-mrow">
          <span>CPU 负载</span><b class="num">{{ (server.load || []).join(" / ") }}</b>
        </div>
        <div class="ad-meter"><i :style="{ width: loadPercent + '%', background: barColor(loadPercent) }"></i></div>
        <div class="ad-mrow mt3">
          <span>内存 {{ server.mem_used || 0 }}MB / {{ server.mem_total || 0 }}MB</span>
          <b class="num">{{ server.mem_percent || 0 }}%</b>
        </div>
        <div class="ad-meter"><i :style="{ width: (server.mem_percent || 0) + '%', background: barColor(server.mem_percent) }"></i></div>
        <div class="ad-mrow mt3">
          <span>磁盘剩余 {{ server.disk_free || 0 }}MB / {{ server.disk_total || 0 }}MB</span>
          <b class="num">{{ server.disk_percent || 0 }}%</b>
        </div>
        <div class="ad-meter"><i :style="{ width: (server.disk_percent || 0) + '%', background: barColor(server.disk_percent) }"></i></div>
      </div>

      <h2 class="section-title">在线同学</h2>
      <div class="glass glass-thin ad-card ad-wrap">
        <span v-for="n in onlineUsers" :key="n" class="chip chip-green">{{ n }}</span>
        <span v-if="!onlineUsers.length" class="sub">当前没人挂着</span>
      </div>

      <h2 class="section-title">快捷公告</h2>
      <div class="glass glass-thin ad-card">
        <textarea class="field ad-area" v-model="announceText" maxlength="500" rows="3" placeholder="写下要通知全班的事，所有人会立刻收到"></textarea>
        <button class="btn btn-primary btn-block mt4" :disabled="busy || !announceText.trim()" @click="sendAnnounce">
          <Icon n="bell" :size="18" /> 发布公告
        </button>
      </div>
    </template>

    <!-- ------------------------------------------------------------- users -->
    <template v-else-if="tab === 'users'">
      <div class="glass glass-thin ad-card mt4">
        <div class="row gap3">
          <input class="field grow" v-model="newUser.username" placeholder="用户名 (登录用)" />
          <input class="field grow" v-model="newUser.name" placeholder="昵称" />
        </div>
        <div class="row gap3 mt3">
          <input class="field grow" v-model="newUser.password" placeholder="密码（留空自动生成）" />
          <select class="field" v-model="newUser.role">
            <option value="member">普通成员</option>
            <option value="committee">资委</option>
            <option value="study">学委</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        <button class="btn btn-primary btn-block mt4" :disabled="busy || newUser.username.trim().length < 2" @click="createUser">
          <Icon n="plus" :size="18" /> 新建账号
        </button>
      </div>

      <div class="glass glass-thin list mt4">
        <div v-for="u in users" :key="u.id" class="ad-row">
          <div class="row gap3 ad-tap" @click="toggleEdit(u.id)">
            <span class="avatar avatar-sm" :style="{ background: u.color || 'color-mix(in srgb, var(--ink) 10%, transparent)' }">{{ u.name.slice(0, 1) }}</span>
            <div class="grow">
              <p class="row-title">{{ u.name }}
                <span class="chip chip-accent" v-if="u.role === 'admin'">管理员</span>
                <span class="chip chip-orange" v-else-if="u.role === 'committee'">资委</span>
                <span class="chip chip-orange" v-else-if="u.role === 'study'">学委</span>
                <span class="chip chip-red" v-if="u.banned">封禁</span>
                <span class="chip chip-orange" v-if="u.muted">禁言</span>
              </p>
              <p class="cap">@{{ u.username }} · 签到 {{ u.checked }} 次</p>
            </div>
            <Icon n="back" :size="16" class="ad-chev" />
          </div>
          <div v-if="editing === u.id" class="ad-edit ad-pad4">
            <div class="row gap3">
              <input class="field grow" v-model="draft.name" placeholder="昵称" />
              <input class="field grow" v-model="draft.note" placeholder="备注（座位/学号）" />
            </div>
            <div class="row gap3 mt3">
              <select class="field grow" v-model="draft.role">
                <option value="member">普通成员</option>
                <option value="committee">资委</option>
                <option value="study">学委</option>
                <option value="admin">管理员</option>
              </select>
              <input class="field grow" v-model="draft.password" placeholder="重设密码（可留空）" />
            </div>
            <div class="row gap3 mt3 wrap">
              <button class="btn" :class="draft.banned ? 'btn-danger' : ''" @click="draft.banned = !draft.banned">
                {{ draft.banned ? "已封禁" : "封禁账号" }}
              </button>
              <button class="btn" :class="draft.muted ? 'btn-danger' : ''" @click="draft.muted = !draft.muted">
                {{ draft.muted ? "已禁言" : "禁言" }}
              </button>
            </div>
            <div class="row gap3 mt4">
              <button class="btn grow" @click="resetPassword(u)">重置密码</button>
              <button class="btn btn-danger" @click="removeUser(u)"><Icon n="trash" :size="17" /></button>
              <button class="btn btn-primary grow" :disabled="busy" @click="saveUser(u)">保存</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ---------------------------------------------------------- sessions -->
    <template v-else-if="tab === 'sessions'">
      <div class="glass glass-thin ad-card mt4">
        <input class="field" v-model="newSession.title" placeholder="场次名称，如 周三上午第一节课" />

        <label class="label mt4">签到时间</label>
        <div class="row gap2 wrap">
          <button v-for="t in signTimes" :key="t" class="chip"
                  :class="{ 'chip-accent': newSession.sign_at === t && !customTime }" @click="pickTime(t)">{{ t }}</button>
          <button class="chip" :class="{ 'chip-accent': customTime }" @click="customTime = !customTime">自定义</button>
        </div>
        <input v-if="customTime" class="field mt3" type="time" v-model="newSession.sign_at" />
        <p class="cap mt2">所选时间之前都能正常签到；之后 {{ newSession.grace_minutes }} 分钟内签到算迟到。</p>

        <div class="row gap3 mt3">
          <label class="ad-mini"><span>补签时长(分)</span><input class="field" type="number" v-model.number="newSession.grace_minutes" /></label>
          <label class="ad-mini"><span>口令</span><input class="field" v-model="newSession.code" placeholder="留空随机" /></label>
        </div>

        <div class="row gap3 mt3 wrap">
          <button class="btn" :class="newSession.require_location ? 'btn-primary' : ''" @click="toggleLocation">
            需要定位{{ newSession.require_location ? " ✓" : "" }}
          </button>
          <button class="btn" :class="newSession.require_note ? 'btn-primary' : ''" @click="newSession.require_note = !newSession.require_note">
            需要备注{{ newSession.require_note ? " ✓" : "" }}
          </button>
          <button class="btn" :class="newSession.allow_leave ? 'btn-primary' : ''" @click="newSession.allow_leave = !newSession.allow_leave">
            允许请假{{ newSession.allow_leave ? " ✓" : "" }}
          </button>
        </div>

        <div v-if="newSession.require_location" class="ad-loc mt3" data-no-swipe>
          <div class="map-box" data-no-swipe>
            <div ref="mapEl" class="map-host" data-no-swipe></div>
            <div class="map-pin"><Icon n="location" :size="30" /></div>
            <div class="map-zoom">
              <button class="map-zbtn" @click="zoomMap(1)">+</button>
              <button class="map-zbtn" @click="zoomMap(-1)">−</button>
            </div>
            <button class="map-me" @click="useMyLocation">
              <Icon n="location" :size="15" /> 定位到我
            </button>
            <p class="map-tip">拖动地图选点</p>
          </div>
          <div class="row gap2 mt3">
            <input class="grow" v-model="newSession.place" placeholder="地点名称" />
            <button class="btn btn-sm" :disabled="locating" @click="locateName">
              {{ locating ? "识别中…" : "识别地名" }}
            </button>
          </div>
          <p class="cap mt2">{{ pickedCoord || "还没有选点" }} · 半径 {{ newSession.radius }} 米</p>
          <input class="ad-range mt2" type="range" min="50" max="1500" step="10"
                 v-model.number="newSession.radius" @input="syncRadius" />
        </div>

        <button class="btn btn-primary btn-block mt4" :disabled="busy" @click="createSession">
          <Icon n="plus" :size="18" /> 开启新场次
        </button>
      </div>

      <div class="glass glass-thin list mt4">
        <div v-for="s in sessions" :key="s.id" class="ad-row">
          <div class="row gap3 ad-tap" @click="toggleSession(s.id)">
            <div class="grow">
              <p class="row-title">
                {{ s.title }}
                <span class="chip" :class="s.status === 'open' ? 'chip-green' : 'chip-red'">{{ s.status === "open" ? "进行中" : "已关闭" }}</span>
              </p>
              <p class="cap">口令 {{ s.code }} · {{ s.present }}/{{ s.total }} 人 · {{ stamp(s.starts_at) }}</p>
            </div>
            <b class="num">{{ percent(s) }}%</b>
          </div>
          <div v-if="openSession === s.id" class="ad-edit ad-pad4">
            <div class="row gap3">
              <input class="field grow" v-model="sDraft.title" placeholder="名称" />
              <input class="field" v-model="sDraft.code" placeholder="口令" />
            </div>
            <div class="row gap3 mt3">
              <select class="field grow" v-model="sDraft.status">
                <option value="open">进行中</option>
                <option value="closed">已关闭</option>
              </select>
              <input class="field grow" v-model="sDraft.note" placeholder="备注" />
            </div>
            <div class="row gap3 mt4">
              <button class="btn grow" @click="viewRecords(s)">查看记录</button>
              <button class="btn btn-danger" @click="removeSession(s)"><Icon n="trash" :size="17" /></button>
              <button class="btn btn-primary grow" :disabled="busy" @click="saveSession(s)">保存</button>
            </div>
          </div>
        </div>
        <div v-if="!sessions.length" class="list-row sub">还没有场次，先创建一个</div>
      </div>
    </template>

    <!-- ----------------------------------------------------------- records -->
    <template v-else-if="tab === 'records'">
      <div class="glass glass-thin ad-card mt4">
        <label class="label">选择场次</label>
        <select class="field" v-model.number="recordSession" @change="loadRecords">
          <option :value="0">全部（最近 300 条）</option>
          <option v-for="s in sessions" :key="s.id" :value="s.id">#{{ s.id }} {{ s.title }}</option>
        </select>
        <div class="row gap3 mt3">
          <select class="field grow" v-model.number="newRecord.user_id">
            <option :value="0">选择同学…</option>
            <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
          <select class="field" v-model="newRecord.status">
            <option value="present">已签到</option>
            <option value="late">迟到</option>
            <option value="leave">请假</option>
            <option value="absent">缺勤</option>
          </select>
        </div>
        <input class="field mt3" v-model="newRecord.note" placeholder="备注（可留空）" />
        <button class="btn btn-primary btn-block mt4" :disabled="busy || !newRecord.user_id || !recordSession"
                @click="saveRecord">
          <Icon n="ad-check" :size="18" /> 补签 / 修改
        </button>
      </div>

      <div class="glass glass-thin list mt4">
        <div v-for="r in records" :key="r.id" class="list-row">
          <span class="avatar avatar-sm">{{ r.name.slice(0, 1) }}</span>
          <div class="grow">
            <p class="row-title">{{ r.name }} <span class="cap">@{{ r.username }}</span></p>
            <p class="cap">{{ stamp(r.created_at) }} · 场次 #{{ r.session_id }}<template v-if="r.note"> · {{ r.note }}</template></p>
          </div>
          <select class="field ad-tiny" :value="r.status" @change="patchRecord(r, $event.target.value)">
            <option value="present">已签到</option>
            <option value="late">迟到</option>
            <option value="leave">请假</option>
            <option value="absent">缺勤</option>
          </select>
          <button class="btn btn-icon" @click="removeRecord(r)"><Icon n="trash" :size="16" /></button>
        </div>
        <div v-if="!records.length" class="list-row sub">没有记录</div>
      </div>
    </template>

    <!-- ------------------------------------------------------------- posts -->
    <template v-else-if="tab === 'posts'">
      <div class="glass glass-thin list mt4">
        <div v-for="p in posts" :key="p.id" class="list-row">
          <div class="grow">
            <p class="row-title" :class="{ struck: p.deleted }">{{ p.content }}</p>
            <p class="cap">
              {{ p.anon ? p.anon_name : p.author }}<span v-if="p.anon" class="chip chip-orange ad-sm">匿名</span>
              · 真实身份 {{ p.author }} · {{ stamp(p.created_at) }}
            </p>
          </div>
          <button v-if="isAdmin" class="btn btn-icon" :title="p.deleted ? '恢复' : '删除'" @click="togglePost(p)">
            <Icon :n="p.deleted ? 'refresh' : 'trash'" :size="16" />
          </button>
        </div>
        <div v-if="!posts.length" class="list-row sub">还没有讨论</div>
      </div>
    </template>

    <!-- ----------------------------------------------------------- signset -->
    <template v-else-if="tab === 'signset'">
      <div class="glass glass-thin ad-card mt4">
        <label class="label">固定签到时间点</label>
        <p class="sub mt2">同学发布签到时可以直接挑这些时间点，也可以用自定义时间。</p>
        <div class="row gap2 mt3 wrap">
          <span v-for="(t, i) in signTimes" :key="t + i" class="chip chip-accent">
            {{ t }}
            <button class="ad-x" @click="removeTime(i)">×</button>
          </span>
          <span v-if="!signTimes.length" class="sub">还没有时间点</span>
        </div>
        <div class="row gap2 mt3">
          <input class="field grow" type="time" v-model="newTime" />
          <button class="btn" :disabled="!newTime" @click="addTime">添加</button>
        </div>
        <label class="label mt4">默认补签时长（分钟）</label>
        <input class="field" type="number" v-model.number="graceDraft" />
        <p class="cap mt2">签到时间之后这段时间内仍可签到，记为迟到。</p>
        <button class="btn btn-primary btn-block mt4" :disabled="busy" @click="saveSignSettings">保存签到设置</button>
      </div>
    </template>

    <!-- ---------------------------------------------------------- settings -->
    <template v-else-if="tab === 'settings'">
      <div class="glass glass-thin ad-card mt4">
        <label class="label">站点名称</label>
        <input class="field" v-model="settings.site_name" />
        <label class="label mt4">副标题</label>
        <input class="field" v-model="settings.site_subtitle" />
        <label class="label mt4">当前 H5 版本号</label>
        <input class="field" type="number" v-model.number="settings.version_h5" />
      </div>
      <div class="glass glass-thin list mt4">
        <div v-for="s in toggles" :key="s.key" class="list-row">
          <div class="grow">
            <p class="row-title">{{ s.label }}</p>
            <p class="cap">{{ s.hint }}</p>
          </div>
          <label class="switch"><input type="checkbox" :checked="settings[s.key] === '1'"
                  @change="toggleSetting(s.key)" /><i></i></label>
        </div>
      </div>
      <button class="btn btn-primary btn-block btn-lg mt4" :disabled="busy" @click="saveSettings">保存设置</button>
    </template>

    <!-- ---------------------------------------------------------- advanced -->
    <template v-else>
      <h2 class="section-title">数据备份</h2>
      <div class="glass glass-thin ad-card">
        <p class="sub">把整份数据库下载到本地，随时可以恢复。</p>
        <button class="btn btn-block mt4" :disabled="busy" @click="downloadBackup">
          <Icon n="download" :size="18" /> 下载数据库备份
        </button>
      </div>

      <h2 class="section-title">H5 热更新包</h2>
      <div class="glass glass-thin ad-card">
        <p class="sub">上传 web 资源 zip，安卓客户端会自动下载并切换到新版本。</p>
        <input class="field mt3" v-model="upload.version_name" placeholder="版本名，如 1.2.0" />
        <input class="field mt3" v-model="upload.notes" placeholder="更新说明" />
        <input class="field mt3" type="number" v-model.number="upload.version_code" placeholder="版本号（留空自动 +1）" />
        <input class="ad-file mt3" type="ad-file" accept=".zip" ref="fileInput" @change="onFile" />
        <button class="btn btn-primary btn-block mt4" :disabled="busy || !uploadFile" @click="doUpload">
          <Icon n="upload" :size="18" /> {{ uploadFile ? "上传 " + fileSize : "请选择 zip 文件" }}
        </button>
        <div class="list mt4" v-if="versions.length">
          <div v-for="v in versions" :key="v.id" class="list-row">
            <div class="grow">
              <p class="row-title">{{ v.version_name }} <span class="chip" :class="v.active ? 'chip-green' : ''">{{ v.active ? "当前" : "历史" }}</span></p>
              <p class="cap">{{ v.platform }} · v{{ v.version_code }} · {{ sizeOf(v.size) }} · {{ stamp(v.created_at) }}</p>
            </div>
          </div>
        </div>
      </div>

      <h2 class="section-title">SQL 控制台</h2>
      <div class="glass glass-thin ad-card">
        <p class="sub">只读语句直接执行；写操作需要勾选确认。一次只能一条语句。</p>
        <textarea class="field ad-area mt3 ad-mono" v-model="sql" rows="4" spellcheck="false" placeholder="SELECT * FROM users LIMIT 5;"></textarea>
        <label class="row gap3 mt3 ad-check">
          <label class="switch"><input type="checkbox" v-model="sqlConfirm" /><i></i></label>
          <span class="sub">我确认执行写操作</span>
        </label>
        <button class="btn btn-primary btn-block mt4" :disabled="busy || !sql.trim()" @click="runSql">执行</button>
        <pre v-if="sqlResult" class="ad-out ad-mono">{{ sqlResult }}</pre>
      </div>

      <h2 class="section-title">审计日志</h2>
      <div class="glass glass-thin list">
        <div v-for="l in logs" :key="l.id" class="list-row">
          <div class="grow">
            <p class="row-title">{{ l.name }} <span class="chip ad-sm">{{ l.action }}</span></p>
            <p class="cap">{{ l.detail }} · {{ l.ip }} · {{ stamp(l.created_at) }}</p>
          </div>
        </div>
        <div v-if="!logs.length" class="list-row sub">暂无日志</div>
      </div>
    </template>
    </div>

    <div class="ad-tail"></div>
  </div>`,
  style: `
  .admin .head { padding-top: calc(var(--safe-t) + var(--s5)); }
  .ad-segs { position: relative; display: flex; gap: 4px; padding: 4px; border-radius: var(--r-md); overflow-x: auto;
    scrollbar-width: none; position: sticky; top: var(--s2); z-index: 12; }
  .ad-segs::-webkit-scrollbar { display: none; }
  .ad-segs button { flex: none; background: none; border: 0; padding: 7px 12px; border-radius: calc(var(--r-md) - 4px); font-size: var(--fs-foot);
    font-weight: 600; color: var(--ink-2); transition: color var(--dur-med) var(--ease-out), background-color var(--dur-med) var(--ease-out); }
  .ad-segs button.on { color: var(--ink); }
  .ad-body { will-change: transform; }
  .ad-body.anim { transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms var(--ease-out); }
  .ad-gauges { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s3); }
  .ad-gauge { padding: var(--s4) var(--s2); border-radius: var(--r-md); text-align: center; }
  .ad-gauge b { display: block; font-size: 22px; }
  .ad-gauge span { font-size: 11px; color: var(--ink-2); }
  .ad-card { padding: var(--s5); border-radius: var(--r-lg); }
  .ad-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
  .ad-mrow { display: flex; justify-content: space-between; align-items: baseline; font-size: var(--fs-foot); }
  .ad-meter { height: 7px; border-radius: 4px; background: var(--hair); overflow: hidden; margin-top: 8px; }
  .ad-meter i { display: block; height: 100%; border-radius: 4px; transition: width var(--dur-slow) var(--ease-out); }
  .ad-area { resize: vertical; min-height: 76px; line-height: 1.45; padding-top: 12px; padding-bottom: 12px; }
  .ad-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .ad-out { margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: color-mix(in srgb, var(--ink) 6%, transparent);
    max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  .ad-row + .ad-row { border-top: 1px solid var(--hair); }
  .ad-tap { padding: var(--s4) 0; cursor: pointer; }
  .ad-edit { border-top: 1px solid var(--hair); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .ad-pad4 { padding: var(--s4) 0 var(--s4); }
  .ad-chev { transform: rotate(180deg); opacity: .25; }
  .ad-mini { flex: 1; display: block; }
  .ad-mini span { display: block; font-size: 11px; color: var(--ink-2); margin-bottom: 4px; }
  .field.ad-tiny { width: auto; padding: 6px 26px 6px 10px; font-size: 12px; }
  .ad-struck { text-decoration: line-through; opacity: .5; }
  .ad-sm { font-size: 10px; padding: 1px 6px; }
  .ad-check { cursor: pointer; align-items: center; }
  .ad-file { font-size: 12.5px; color: var(--ink-2); }
  .ad-spin { animation: spin 900ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .ad-tail { height: calc(var(--safe-b) + 100px); }
  .ad-loc { padding: var(--s3); border-radius: var(--r-md); background: color-mix(in srgb, var(--ink) 5%, transparent); }
  .ad-range { width: 100%; accent-color: var(--accent); }
  .ad-x { border: 0; background: transparent; color: inherit; font-size: 14px; cursor: pointer; padding: 0 0 0 4px; }
  `,
  setup() {
    const tab = ref("overview");
    const loading = ref(false);
    const busy = ref(false);
    const overview = ref({});
    const server = ref({});
    const online = ref(0);
    const onlineUsers = ref([]);
    const users = ref([]);
    const sessions = ref([]);
    const records = ref([]);
    const posts = ref([]);
    const logs = ref([]);
    const versions = ref([]);
    const settings = ref({});
    const editing = ref(0);
    const openSession = ref(0);
    const draft = ref({});
    const sDraft = ref({});
    const recordSession = ref(0);
    const newRecord = ref({ user_id: 0, status: "present", note: "" });
    const announceText = ref("");
    const uploadFile = ref(null);
    const fileInput = ref(null);
    const sql = ref("");
    const sqlConfirm = ref(false);
    const sqlResult = ref("");
    const newUser = ref({ username: "", name: "", password: "", role: "member" });
    const newSession = ref({ title: "", sign_at: "08:00", grace_minutes: 15, code: "",
                             require_note: false, allow_leave: true, require_location: false,
                             lat: 0, lng: 0, radius: 200, place: "" });
    const upload = ref({ version_name: "", notes: "", version_code: 0 });

    const toggles = SETTING_TOGGLES;
    const isAdmin = computed(() => !!(store.user && store.user.role === "admin"));
    const tabs = computed(() => TABS.filter((t) => isAdmin.value || !t.adminOnly));
    const signTimes = ref([]);
    const newTime = ref("");
    const graceDraft = ref(15);
    const mapEl = ref(null);
    const locating = ref(false);
    const pickedCoord = computed(() => {
      const draft = newSession.value;
      if (!draft.lat && !draft.lng) return "";
      return Number(draft.lat).toFixed(5) + ", " + Number(draft.lng).toFixed(5);
    });
    let map = null;
    const customTime = ref(false);
    const loadPercent = computed(() => {
      const one = parseFloat((server.value.load || [])[0]);
      if (isNaN(one)) return 0;
      return Math.min(100, Math.round((one / 2) * 100));
    });
    const fileSize = computed(() => sizeOf(uploadFile.value ? uploadFile.value.size : 0));

    function barColor(p) {
      if (p >= 85) return "var(--red)";
      if (p >= 65) return "var(--orange)";
      return "linear-gradient(90deg, var(--accent), var(--green))";
    }
    function sizeOf(bytes) {
      const n = Number(bytes || 0);
      if (n < 1024) return n + "B";
      if (n < 1048576) return (n / 1024).toFixed(1) + "KB";
      return (n / 1048576).toFixed(2) + "MB";
    }
    function stamp(ts) {
      if (!ts) return "-";
      const d = new Date(ts * 1000);
      const p = (n) => String(n).padStart(2, "0");
      return p(d.getMonth() + 1) + "/" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function percent(s) { return s.total ? Math.round((s.present * 100) / s.total) : 0; }

    async function guard(task) {
      busy.value = true;
      try {
        await task();
      } catch (err) {
        toast(err.message || "操作失败", "error");
      } finally {
        busy.value = false;
      }
    }

    async function loadOverview() {
      const data = await api("/api/admin/overview");
      overview.value = data;
      server.value = data.server || {};
      online.value = data.online || 0;
      onlineUsers.value = data.online_users || [];
      settings.value = { ...data.settings };
      syncSignSettings();
    }

    function syncSignSettings() {
      const raw = settings.value.sign_times || "";
      signTimes.value = String(raw).split(",").map((t) => t.trim()).filter(Boolean);
      graceDraft.value = Number(settings.value.default_grace || 15);
      if (!newSession.value.sign_at && signTimes.value.length) newSession.value.sign_at = signTimes.value[0];
    }

    function pickTime(value) {
      newSession.value.sign_at = value;
      customTime.value = false;
      haptic(6);
    }
    function toggleLocation() {
      newSession.value.require_location = !newSession.value.require_location;
      haptic(6);
      if (newSession.value.require_location) {
        nextTick(mountMap);
      } else if (map) {
        map.destroy();
        map = null;
      }
    }

    function mountMap() {
      if (!mapEl.value) return;
      if (map) { map.destroy(); map = null; }
      const draft = newSession.value;
      map = createMapPicker(mapEl.value, {
        lat: draft.lat || 31.2304,
        lng: draft.lng || 121.4737,
        zoom: 17,
        radius: draft.radius,
        onPick: applyPick,
      });
      map.setRadius(draft.radius);
      if (draft.lat || draft.lng) locateName();
      else useMyLocation(true);
    }

    function applyPick(lat, lng) {
      newSession.value.lat = lat;
      newSession.value.lng = lng;
      haptic(6);
      locateName();
    }

    /* 反查地名：服务端走 Photon / BigDataCloud，失败就让用户自己填 */
    async function locateName() {
      const draft = newSession.value;
      if (!draft.lat && !draft.lng) return;
      locating.value = true;
      try {
        const res = await api("/api/geo/reverse", { query: "lat=" + draft.lat + "&lng=" + draft.lng });
        /* 完整地址太长，输入框里只留"地名 · 街道 · 区"三段 */
        if (res.name) draft.place = (res.address || res.name).split(" · ").slice(0, 3).join(" · ").slice(0, 60);
        else if (!draft.place) draft.place = draft.lat.toFixed(5) + ", " + draft.lng.toFixed(5);
      } catch (err) {
        if (!draft.place) draft.place = draft.lat.toFixed(5) + ", " + draft.lng.toFixed(5);
        toast("地名识别失败，可以手动填一个名字", "warn", 3600);
      } finally {
        locating.value = false;
      }
    }

    function zoomMap(delta) {
      if (map) map.zoomBy(delta);
    }

    function syncRadius() {
      if (map) map.setRadius(newSession.value.radius);
    }

    async function useMyLocation(silent) {
      /* 直接绑在 @click 上时第一个参数是事件对象，只有显式 true 才当静默 */
      if (silent !== true) toast("正在获取定位…", "info", 1400);
      let pos = null;
      try {
        pos = await deviceLocation({ timeout: 15000 });
      } catch (err) {
        toast(err.message || "定位失败，可以直接拖动地图选点", "warn", 4000);
        return;
      }
      if (map) {
        map.setMe(pos.lat, pos.lng);
        map.setCenter(pos.lat, pos.lng);
      }
      applyPick(Number(Number(pos.lat).toFixed(7)), Number(Number(pos.lng).toFixed(7)));
    }

    function addTime() {
      const value = (newTime.value || "").slice(0, 5);
      if (!value) return;
      if (!signTimes.value.includes(value)) signTimes.value.push(value);
      signTimes.value.sort();
      newTime.value = "";
      haptic(6);
    }
    function removeTime(index) {
      signTimes.value.splice(index, 1);
      haptic(6);
    }

    async function saveSignSettings() {
      await guard(async () => {
        const res = await api("/api/admin/sign-settings", { method: "PATCH", body: {
          sign_times: signTimes.value.join(","), default_grace: graceDraft.value } });
        settings.value = { ...settings.value, ...res.settings };
        store.settings = { ...store.settings, ...res.settings };
        syncSignSettings();
        toast("签到设置已保存", "success");
      });
    }
    async function loadUsers() {
      const data = await api("/api/admin/users");
      users.value = data.users || [];
    }
    async function loadSessions() {
      const data = await api("/api/admin/sign-sessions");
      sessions.value = data.sessions || [];
    }
    async function loadRecords() {
      const data = await api("/api/admin/records", { query: recordSession.value ? "session_id=" + recordSession.value : "" });
      records.value = data.records || [];
    }
    async function loadPosts() {
      const data = await api("/api/admin/posts");
      posts.value = data.posts || [];
    }
    async function loadLogs() {
      const data = await api("/api/admin/logs");
      logs.value = data.logs || [];
    }
    async function loadVersions() {
      const data = await api("/api/admin/versions");
      versions.value = data.versions || [];
    }

    async function refresh() {
      /* 非管理员/资委误入本页（例如换账号后残留 #/admin）时退回"我的" */
      if (!store.user || !["admin", "committee", "study"].includes(store.user.role)) { navigate("/me", true); return; }
      loading.value = true;
      try {
        if (tab.value === "overview") await loadOverview();
        else if (tab.value === "users") { await loadUsers(); await loadOverview(); }
        else if (tab.value === "sessions") await loadSessions();
        else if (tab.value === "records") { await loadSessions(); await loadUsers(); await loadRecords(); }
        else if (tab.value === "posts") await loadPosts();
        else if (tab.value === "settings" || tab.value === "signset") await loadOverview();
        else { await loadVersions(); await loadLogs(); }
      } catch (err) {
        toast(err.message || "加载失败", "error");
      } finally {
        loading.value = false;
      }
    }

    /* 分栏切换：跟手位移 + 平滑滑入，滑块同步（滑动时不会把整页翻走，导航条整排可横向滚动） */
    const segEl = ref(null);
    const bodyEl = ref(null);
    const pill = ref("opacity:0");
    const bodyAnim = ref(false);
    let bodyX = 0;
    let bodyOpacity = 1;

    function applyBody() {
      if (bodyEl.value) {
        bodyEl.value.style.transform = Math.abs(bodyX) < 0.5 ? "" : "translate3d(" + Math.round(bodyX) + "px,0,0)";
        bodyEl.value.style.opacity = String(bodyOpacity);
      }
      pill.value = pillStyle(segEl.value, pillFollow(bodyX)) + (bodyAnim.value ? "" : "transition:none;");
    }

    /* 拖动时让滑块朝相邻分栏跟手滑过去。
       直接按 dx 摊到 8 个分栏上基本看不出位移，看起来就像"滑块不动"。 */
    function pillFollow(dx) {
      const seg = segEl.value;
      if (!seg || !dx) return 0;
      const list = tabs.value;
      const index = list.findIndex((t) => t.id === tab.value);
      if (index < 0) return 0;
      const dir = dx < 0 ? 1 : -1;
      const btns = seg.querySelectorAll("button");
      const cur = btns[index];
      const next = btns[index + dir];
      if (!cur || !next) return 0;                       // 到头了就稳住，不跟着跑
      const threshold = Math.min(88, Math.max(1, seg.clientWidth) * 0.2);
      const progress = Math.min(1, Math.abs(dx) / threshold) * 0.9;
      return (next.getBoundingClientRect().left - cur.getBoundingClientRect().left) * progress;
    }

    function syncSeg() { nextTick(() => { applyBody(); }); }

    function go(id, dir) {
      if (id === tab.value) return;
      const list = tabs.value;
      const from = list.findIndex((t) => t.id === tab.value);
      const to = list.findIndex((t) => t.id === id);
      const forward = dir !== undefined ? dir > 0 : to > from;
      bodyAnim.value = false;
      bodyX = forward ? 30 : -30;
      bodyOpacity = 0;
      applyBody();
      tab.value = id;
      haptic(6);
      refresh();
      nextTick(() => { bodyAnim.value = true; bodyX = 0; bodyOpacity = 1; applyBody(); });
    }

    function step(dir) {
      const list = tabs.value;
      const index = list.findIndex((t) => t.id === tab.value);
      const next = index + dir;
      if (index < 0 || next < 0 || next >= list.length) return false;
      go(list[next].id, dir);
      return true;
    }

    function onSwipe(e) {
      if (e.phase === "move") {
        bodyAnim.value = false;
        bodyX = e.dx * 0.32;
        bodyOpacity = 1 - Math.min(0.4, (Math.abs(e.dx) / Math.max(1, e.width)) * 0.7);
        applyBody();
        return;
      }
      const far = Math.abs(e.dx) > Math.min(88, e.width * 0.2) || (Math.abs(e.velocity || 0) > 0.35 && Math.abs(e.dx) > 22);
      bodyAnim.value = true;
      if (e.phase === "end" && far) step(e.dir);
      bodyX = 0;
      bodyOpacity = 1;
      applyBody();
    }

    function toggleEdit(id) {
      editing.value = editing.value === id ? 0 : id;
      const u = users.value.find((x) => x.id === id);
      if (u) draft.value = { name: u.name, note: u.note || "", role: u.role, banned: !!u.banned, muted: !!u.muted, password: "" };
      haptic(6);
    }

    async function createUser() {
      await guard(async () => {
        const res = await api("/api/admin/users", { method: "POST", body: newUser.value });
        toast("已创建，初始密码：" + res.password, "success", 7000);
        newUser.value = { username: "", name: "", password: "", role: "member" };
        await loadUsers();
      });
    }

    async function saveUser(u) {
      await guard(async () => {
        await api("/api/admin/users/" + u.id, { method: "PATCH", body: draft.value });
        toast("已保存", "success");
        editing.value = 0;
        await loadUsers();
      });
    }

    async function resetPassword(u) {
      const yes = await confirmDialog("重置 " + u.name + " 的密码？", { okText: "重置", danger: true });
      if (!yes) return;
      await guard(async () => {
        const res = await api("/api/admin/users/" + u.id + "/reset-password", { method: "POST", body: {} });
        toast("新密码：" + res.password, "success", 8000);
      });
    }

    async function removeUser(u) {
      const yes = await confirmDialog("删除 " + u.name + " 及其签到记录？不可撤销。", { okText: "删除", danger: true });
      if (!yes) return;
      await guard(async () => {
        await api("/api/admin/users/" + u.id, { method: "DELETE" });
        toast("已删除", "success");
        editing.value = 0;
        await loadUsers();
      });
    }

    async function createSession() {
      if (newSession.value.require_location && !newSession.value.lat) {
        toast("开启定位签到前，先选一个签到地点", "warn");
        return;
      }
      await guard(async () => {
        const res = await api("/api/admin/sign-sessions", { method: "POST", body: newSession.value });
        toast("场次已开启，口令 " + res.code, "success", 6000);
        newSession.value = { title: "", sign_at: signTimes.value[0] || "08:00",
                             grace_minutes: graceDraft.value, code: "", require_note: false,
                             allow_leave: true, require_location: false, lat: 0, lng: 0, radius: 200, place: "" };
        if (map) { map.destroy(); map = null; }
        await loadSessions();
      });
    }

    function toggleSession(id) {
      openSession.value = openSession.value === id ? 0 : id;
      const s = sessions.value.find((x) => x.id === id);
      if (s) sDraft.value = { title: s.title, code: s.code, status: s.status, note: s.note || "" };
    }

    async function saveSession(s) {
      await guard(async () => {
        await api("/api/admin/sign-sessions/" + s.id, { method: "PATCH", body: sDraft.value });
        toast("已保存", "success");
        openSession.value = 0;
        await loadSessions();
      });
    }

    async function removeSession(s) {
      const yes = await confirmDialog("删除场次「" + s.title + "」和它的全部签到记录？", { okText: "删除", danger: true });
      if (!yes) return;
      await guard(async () => {
        await api("/api/admin/sign-sessions/" + s.id, { method: "DELETE" });
        toast("已删除", "success");
        openSession.value = 0;
        await loadSessions();
      });
    }

    function viewRecords(s) {
      recordSession.value = s.id;
      go("records");
    }

    async function saveRecord() {
      await guard(async () => {
        await api("/api/admin/records", { method: "POST", body: { ...newRecord.value, session_id: recordSession.value } });
        toast("已记录", "success");
        newRecord.value = { user_id: 0, status: "present", note: "" };
        await loadRecords();
      });
    }

    async function patchRecord(r, status) {
      await guard(async () => {
        await api("/api/admin/records/" + r.id, { method: "PATCH", body: { status } });
        toast("已更新", "success");
        await loadRecords();
      });
    }

    async function removeRecord(r) {
      const yes = await confirmDialog("删除 " + r.name + " 的这条记录？", { okText: "删除", danger: true });
      if (!yes) return;
      await guard(async () => {
        await api("/api/admin/records/" + r.id, { method: "DELETE" });
        await loadRecords();
      });
    }

    async function togglePost(p) {
      await guard(async () => {
        await api("/api/admin/posts/" + p.id, { method: "PATCH", body: { deleted: !p.deleted } });
        await loadPosts();
      });
    }

    async function sendAnnounce() {
      await guard(async () => {
        await api("/api/admin/announce", { method: "POST", body: { content: announceText.value } });
        announceText.value = "";
        toast("公告已发送", "success");
        haptic([10, 40, 10]);
      });
    }

    function toggleSetting(key) {
      settings.value = { ...settings.value, [key]: settings.value[key] === "1" ? "0" : "1" };
      haptic(6);
    }

    async function saveSettings() {
      await guard(async () => {
        const payload = {};
        ["site_name", "site_subtitle", "version_h5"].forEach((k) => { payload[k] = settings.value[k]; });
        SETTING_TOGGLES.forEach((s) => { payload[s.key] = settings.value[s.key] === "1" ? "1" : "0"; });
        const res = await api("/api/admin/settings", { method: "PATCH", body: payload });
        settings.value = { ...res.settings };
        store.settings = { ...store.settings, ...res.settings };
        toast("设置已生效", "success");
      });
    }

    async function downloadBackup() {
      await guard(async () => {
        const resp = await api("/api/admin/backup", { raw: true });
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "checkin-backup.db";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast("备份已开始下载", "success");
      });
    }

    function onFile(event) {
      const file = event.target.files && event.target.files[0];
      uploadFile.value = file || null;
      if (file && !upload.value.version_name) upload.value.version_name = new Date().toISOString().slice(0, 10);
    }

    async function doUpload() {
      if (!uploadFile.value) return;
      await guard(async () => {
        const query = "name=" + encodeURIComponent(uploadFile.value.name)
          + "&kind=h5&version_name=" + encodeURIComponent(upload.value.version_name || "")
          + "&notes=" + encodeURIComponent(upload.value.notes || "")
          + (upload.value.version_code ? "&version_code=" + upload.value.version_code : "");
        const res = await api("/api/admin/upload?" + query, { method: "POST", body: uploadFile.value });
        toast("已发布 v" + res.version_code, "success");
        uploadFile.value = null;
        if (fileInput.value) fileInput.value.value = "";
        await loadVersions();
      });
    }

    async function runSql() {
      await guard(async () => {
        const res = await api("/api/admin/sql", { method: "POST", body: { sql: sql.value, confirm: sqlConfirm.value } });
        sqlResult.value = res.rows ? JSON.stringify(res.rows, null, 2) : "OK · lastrowid=" + res.lastrowid;
        toast("执行完成 " + res.ms + "ms", "success");
        haptic(10);
      });
    }

    onMounted(refresh);

    let stopSwipe = null;
    onMounted(() => {
      stopSwipe = registerSwipe("/admin", onSwipe, (dir) => {
        const list = tabs.value;
        const index = list.findIndex((t) => t.id === tab.value);
        const next = index + dir;
        return index >= 0 && next >= 0 && next < list.length;
      });
      syncSeg();
      window.addEventListener("resize", syncSeg);
    });
    onUnmounted(() => {
      if (stopSwipe) stopSwipe();
      window.removeEventListener("resize", syncSeg);
      if (map) { map.destroy(); map = null; }
    });

    return { tab, tabs, toggles, loading, busy, overview, server, online, onlineUsers, users, sessions, records,
             segEl, bodyEl, pill, bodyAnim,
             posts, logs, versions, settings, editing, openSession, draft, sDraft, recordSession, newRecord,
             announceText, uploadFile, fileInput, sql, sqlConfirm, sqlResult, newUser, newSession, upload,
             loadPercent, fileSize, barColor, sizeOf, stamp, percent, isAdmin, signTimes, newTime, graceDraft,
             mapEl, locating, pickedCoord, customTime,
             refresh, go, step, toggleEdit, createUser, saveUser, resetPassword, removeUser, createSession,
             toggleSession, saveSession, removeSession, viewRecords, saveRecord, patchRecord, removeRecord,
             togglePost, sendAnnounce, toggleSetting, saveSettings, downloadBackup, onFile, doUpload, runSql,
             pickTime, toggleLocation, useMyLocation, zoomMap, syncRadius, locateName, addTime, removeTime, saveSignSettings,
             store, navigate };
  },
}));
