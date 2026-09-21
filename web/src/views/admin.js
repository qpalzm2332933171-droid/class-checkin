import {
  defineView, registerRoute, ref, computed, onMounted, onUnmounted, nextTick, navigate, store, api, toast, haptic,
  confirmDialog, registerSwipe, deviceLocation, pillStyle, onWs, mediaUrl,
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

const STATUS_OPTS = [
  { value: "present", label: "已签到" },
  { value: "late", label: "迟到" },
  { value: "leave", label: "请假" },
  { value: "absent", label: "缺勤" },
  { value: "clear", label: "清除这条记录" },
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

    <div class="ad-stage" ref="stageEl">
    <div v-for="p in panes" :key="p.key" class="ad-pane" :class="{ cur: p.off === 0 }"
         :data-off="p.off" :style="paneStyle(p)">
    <!-- ---------------------------------------------------------- overview -->
    <template v-if="p.id === 'overview'">
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
      <div class="glass glass-thin ad-card ad-wrap" data-ok-wrap>
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
    <template v-else-if="p.id === 'users'">
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
            <span class="avatar avatar-sm" :style="u.color ? { background: u.color } : {}">
              <img v-if="u.avatar" :src="mediaUrl(u.avatar)" :alt="u.name" loading="lazy" />
              <template v-else>{{ (u.name || '?').slice(0, 1) }}</template>
            </span>
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
    <template v-else-if="p.id === 'sessions'">
      <div class="glass glass-thin ad-card mt4">
        <input class="field" v-model="newSession.title" placeholder="场次名称，如 周三上午第一节课" />

        <label class="label mt4">签到时间</label>
        <div class="ad-times">
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

        <div class="row gap2 mt3 ad-toggles">
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
            <button class="map-me" :disabled="locating" @click="useMyLocation">
              <Icon n="location" :size="15" /> {{ locating ? "定位中…" : "定位到我" }}
            </button>
            <p class="map-tip">拖动地图微调位置</p>
          </div>
          <div class="loc-pick mt3">
            <span class="loc-pin"><Icon n="location" :size="17" /></span>
            <div class="grow ad-ellip">
              <p class="row-title">{{ newSession.place || "还没选地点" }}</p>
              <p class="cap">{{ pickedCoord || "拖动地图微调，或从下面挑一个地点" }}</p>
            </div>
          </div>

          <div class="row gap2 mt3">
            <input class="field grow" v-model.trim="placeQuery" placeholder="搜索地点：食堂 / 教学楼 / 咖啡"
                   @keyup.enter="searchPlaces" />
            <button class="btn btn-sm" :disabled="placeBusy || !placeQuery" @click="searchPlaces">
              {{ placeBusy ? "查找中…" : "搜索" }}
            </button>
          </div>
          <p class="cap mt2">{{ placeListTitle }}</p>
          <div class="glass glass-thin list loc-list">
            <button v-for="(item, i) in placeList" :key="i" class="list-row tap" @click="pickPlace(item)">
              <div class="grow ad-ellip">
                <p class="row-title">{{ item.name }}</p>
                <p class="cap">{{ item.address }}</p>
              </div>
              <span v-if="item.distance >= 0" class="chip chip-accent">{{ fmtDistance(item.distance) }}</span>
            </button>
            <div v-if="!placeList.length" class="list-row sub">
              {{ placeBusy ? "查找中…" : "点左下角「定位到我」看附近地点，也可以直接搜名字" }}
            </div>
          </div>

          <label class="label mt4">签到半径（米）</label>
          <div class="row gap2">
            <input class="field grow" type="number" inputmode="numeric" min="20" max="5000" step="10"
                   v-model.number="newSession.radius" @change="syncRadius" />
            <button v-for="r in RADIUS_PRESETS" :key="r" class="chip" :class="{ 'chip-accent': newSession.radius === r }"
                    @click="setRadius(r)">{{ r }}m</button>
          </div>
          <p class="cap mt2">地图上淡绿色那一圈就是签到时允许的范围。</p>
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
    <template v-else-if="p.id === 'records'">
      <!-- 场次详情：全班名单，点一下就能改状态 -->
      <template v-if="rosterSession">
        <div class="glass glass-thin ad-card mt4">
          <div class="row gap2">
            <button class="btn btn-icon" title="返回场次列表" @click="closeRoster"><Icon n="back" :size="18" /></button>
            <div class="grow ad-ellip">
              <p class="row-title">#{{ rosterSession.id }} {{ rosterSession.title }}</p>
              <p class="cap">{{ stamp(rosterSession.sign_at || rosterSession.starts_at) }}<template v-if="rosterSession.place"> · {{ rosterSession.place }}</template></p>
            </div>
            <button class="btn btn-icon" title="导出这一场" @click="exportRecords(rosterSession.id)"><Icon n="download" :size="17" /></button>
            <button class="btn btn-icon" title="删除场次" @click="removeSession(rosterSession)"><Icon n="trash" :size="17" /></button>
          </div>
          <div class="ad-wrap mt3" data-ok-wrap>
            <span class="chip chip-green">已签到 {{ rosterCounts.present || 0 }}</span>
            <span class="chip chip-orange">迟到 {{ rosterCounts.late || 0 }}</span>
            <span class="chip">请假 {{ rosterCounts.leave || 0 }}</span>
            <span class="chip chip-red">缺勤 {{ (rosterCounts.absent || 0) + (rosterCounts.none || 0) }}</span>
          </div>
          <p class="cap mt3">点下面的同学就能改他的状态：已签到 / 迟到 / 请假 / 缺勤。</p>
        </div>

        <div class="glass glass-thin list mt4">
          <button v-for="m in roster" :key="m.user_id" class="list-row tap" @click="pickMember(m)">
            <span class="avatar avatar-sm">
              <img v-if="m.avatar" :src="mediaUrl(m.avatar)" :alt="m.name" loading="lazy" />
              <template v-else>{{ (m.name || '?').slice(0, 1) }}</template>
            </span>
            <div class="grow ad-ellip">
              <p class="row-title">{{ m.name }}</p>
              <p class="cap">@{{ m.username }}<template v-if="m.note"> · {{ m.note }}</template><template v-if="m.by_admin"> · 管理员改过</template></p>
            </div>
            <span class="chip" :class="statusCls(m.status)">{{ statusText(m.status) }}</span>
          </button>
          <div v-if="!roster.length" class="list-row sub">名单加载中…</div>
        </div>
      </template>

      <!-- 场次列表：按日期挑、也能搜 -->
      <template v-else>
        <div class="glass glass-thin ad-card mt4">
          <div class="row gap3">
            <div class="grow ad-ellip">
              <p class="row-title">场次记录</p>
              <p class="cap">先挑一个场次，再进去看/改全班的签到状态</p>
            </div>
            <button class="btn btn-sm" @click="exportRecords(0)"><Icon n="download" :size="16" /> 导出 Excel</button>
          </div>
          <div class="ad-dates mt3">
            <select class="field" v-model.number="filter.y">
              <option :value="0">全部年</option>
              <option v-for="y in years" :key="y" :value="y">{{ y }} 年</option>
            </select>
            <select class="field" v-model.number="filter.m">
              <option :value="0">全部月</option>
              <option v-for="m in 12" :key="m" :value="m">{{ m }} 月</option>
            </select>
            <select class="field" v-model.number="filter.d">
              <option :value="0">全部日</option>
              <option v-for="d in days" :key="d" :value="d">{{ d }} 日</option>
            </select>
          </div>
          <input class="field ad-fq mt2" v-model.trim="filter.q" placeholder="搜索场次标题或编号" />
        </div>

        <div class="glass glass-thin list mt4">
          <button v-for="s in filteredSessions" :key="s.id" class="list-row tap" @click="openRoster(s)">
            <div class="grow ad-ellip">
              <p class="row-title">#{{ s.id }} {{ s.title }}</p>
              <p class="cap">{{ stamp(s.sign_at || s.starts_at) }} · 已签 {{ s.present }}/{{ s.total }}<template v-if="s.place"> · {{ s.place }}</template></p>
            </div>
            <span class="chip" :class="s.status === 'open' ? 'chip-accent' : ''">{{ s.status === 'open' ? '进行中' : '已关闭' }}</span>
            <Icon n="back" :size="16" class="ad-flip" />
          </button>
          <div v-if="!filteredSessions.length" class="list-row sub">没有符合条件的场次</div>
        </div>
      </template>

      <Transition name="fade">
        <div v-if="memberPick" class="scrim" @click="memberPick = null"></div>
      </Transition>
      <Transition name="sheet">
        <div v-if="memberPick" class="sheet">
          <div class="sheet-grab"></div>
          <h3 class="t3">{{ memberPick.name }}</h3>
          <p class="sub mt2">{{ rosterSession && rosterSession.title }} · 当前 {{ statusText(memberPick.status) }}</p>
          <div class="stack mt4">
            <button v-for="opt in STATUS_OPTS" :key="opt.value" class="btn btn-block"
                    :class="{ 'btn-primary': memberPick.status === opt.value }" @click="setStatus(opt.value)">
              {{ opt.label }}
            </button>
          </div>
          <input class="field mt3" v-model.trim="pickNote" maxlength="200" placeholder="备注（可留空）" />
          <button class="btn btn-block mt3" @click="memberPick = null">取消</button>
        </div>
      </Transition>
    </template>

    <!-- ------------------------------------------------------------- posts -->
    <template v-else-if="p.id === 'posts'">
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
    <template v-else-if="p.id === 'signset'">
      <div class="glass glass-thin ad-card mt4">
        <label class="label">固定签到时间点</label>
        <p class="sub mt2">同学发布签到时可以直接挑这些时间点，也可以用自定义时间。</p>
        <div class="ad-times mt3">
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
    <template v-else-if="p.id === 'settings'">
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
    <template v-else-if="p.id === 'advanced'">
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
    </div>

    <div class="ad-tail"></div>
  </div>`,
  style: `
  .admin .head { padding-top: calc(var(--safe-t) + var(--s5)); }
  .ad-segs { position: relative; display: flex; gap: 4px; padding: 4px; border-radius: var(--r-md); overflow-x: auto;
    scrollbar-width: none; position: sticky; top: var(--s2); z-index: 12; }
  .ad-segs::-webkit-scrollbar { display: none; }
  /* position+z-index：滑块是绝对定位元素，不抬起来会盖住按钮文字 */
  .ad-segs button { flex: none; position: relative; z-index: 1; background: none; border: 0; padding: 7px 12px; border-radius: calc(var(--r-md) - 4px); font-size: var(--fs-foot);
    font-weight: 600; color: var(--ink-2); transition: color var(--dur-med) var(--ease-out), background-color var(--dur-med) var(--ease-out); }
  .ad-segs button.on { color: var(--ink); }
  /* 分栏轨道：外层只负责裁切，panes 各自平移；当前栏在文档流里撑高度，其余绝对定位 */
  .ad-stage { position: relative; overflow-x: clip; }
  .ad-pane { position: absolute; top: 0; left: 0; width: 100%; backface-visibility: hidden; }
  .ad-pane.cur { position: relative; }
  .ad-stage.dragging .ad-pane, .ad-stage.anim .ad-pane { will-change: transform; }
  .ad-stage.anim .ad-pane { transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1); }
  @media (prefers-reduced-motion: reduce) { .ad-stage.anim .ad-pane { transition-duration: 1ms; } }
  /* 记录页：可点的行、单行省略、日期筛选条 */
  .ad-tap-hint { display: none; }
  .ad-ellip { min-width: 0; }
  .ad-ellip .row-title, .ad-ellip .cap { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 定位：已选地点卡片 / 附近地点列表 / 半径输入 */
  .loc-pick { display: flex; align-items: center; gap: var(--s3); padding: 12px var(--s4);
    border-radius: var(--r-md); background: var(--mat-thin); border: 1px solid var(--hair); }
  .loc-pin { width: 32px; height: 32px; flex: none; border-radius: var(--r-full); display: flex;
    align-items: center; justify-content: center; background: var(--green-soft); color: var(--green); }
  .loc-list { max-height: 264px; overflow-y: auto; }
  .loc-list .list-row { min-height: 46px; align-items: center; }
  /* 时间点 chips：自动铺成整齐网格，宽度够就一整行，窄屏也是整齐的多行而不是参差换行 */
  .ad-times { display: grid; grid-template-columns: repeat(auto-fit, minmax(76px, 1fr)); gap: var(--s2); }
  .ad-times .chip { justify-content: center; width: 100%; min-width: 0; }
  /* 日期筛选：三列等宽永远一行；搜索框单独一行，避免小屏乱换行 */
  .ad-dates { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s2); }
  .ad-dates .field { width: 100%; min-width: 0; padding: 10px 8px; font-size: clamp(12px, 3.4vw, 14px); }
  .ad-fq { min-width: 0; padding: 10px 12px; }
  /* 需要定位/需要备注/允许请假：三列等宽，窄屏也不换行 */
  .ad-toggles { flex-wrap: nowrap; }
  .ad-toggles .btn { flex: 1 1 0; min-width: 0; padding: 11px 6px; white-space: nowrap;
    font-size: clamp(11.5px, 3.5vw, 14px); }
  .ad-flip { transform: rotate(180deg); color: var(--ink-3); flex: none; }
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
  .ad-mini { flex: 1 1 0; min-width: 0; display: block; }
  .ad-mini .field { min-width: 0; }
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
    const roster = ref([]);
    const rosterCounts = ref({});
    const rosterSession = ref(null);
    const memberPick = ref(null);
    const pickNote = ref("");
    const filter = ref({ y: 0, m: 0, d: 0, q: "" });
    const posts = ref([]);
    const logs = ref([]);
    const versions = ref([]);
    const settings = ref({});
    const editing = ref(0);
    const openSession = ref(0);
    const draft = ref({});
    const sDraft = ref({});
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
    const placeQuery = ref("");
    const placeBusy = ref(false);
    const placeList = ref([]);
    const placeListTitle = ref("附近地点");
    const RADIUS_PRESETS = [50, 100, 200, 500];
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

    /* 模板 ref 写在 v-for 里时 Vue 会给数组，直接用会 appendChild is not a function */
    function one(refValue) {
      if (Array.isArray(refValue)) return refValue.find(function (el) { return !!el; }) || null;
      return refValue || null;
    }

    function mountMap() {
      const host = one(mapEl.value);
      if (!host) return;
      if (map) { map.destroy(); map = null; }
      const draft = newSession.value;
      map = createMapPicker(host, {
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
      loadNearby();
    }

    function fmtDistance(meters) {
      const m = Number(meters) || 0;
      return m < 1000 ? Math.round(m) + " 米" : (m / 1000).toFixed(1) + " 公里";
    }

    /* 反查地名：服务端走 Photon / BigDataCloud，失败就让用户自己填 */
    async function locateName() {
      const draft = newSession.value;
      if (!draft.lat && !draft.lng) return;
      locating.value = true;
      try {
        const res = await api("/api/geo/reverse", { query: "lat=" + draft.lat + "&lng=" + draft.lng });
        /* 完整地址太长，只留"地名 · 街道 · 区"三段 */
        if (res.name) draft.place = (res.address || res.name).split(" · ").slice(0, 3).join(" · ").slice(0, 60);
        else if (!draft.place) draft.place = draft.lat.toFixed(5) + ", " + draft.lng.toFixed(5);
      } catch (err) {
        if (!draft.place) draft.place = draft.lat.toFixed(5) + ", " + draft.lng.toFixed(5);
        toast("地名识别失败，可以手动填一个名字", "warn", 3600);
      } finally {
        locating.value = false;
      }
    }

    /* 附近的几个地点：由近到远，直接挑，不用在地图上慢慢挪 */
    async function loadNearby(silent) {
      const draft = newSession.value;
      if (!draft.lat && !draft.lng) return;
      placeBusy.value = true;
      try {
        const res = await api("/api/geo/nearby", { query: "lat=" + draft.lat + "&lng=" + draft.lng + "&limit=12" });
        placeList.value = res.items || [];
        placeListTitle.value = placeList.value.length ? "附近地点（由近到远）" : "附近没找到地点，可以在上面搜名字";
        if (res.offline && !silent) toast("附近地点暂时查不到，可以直接搜名字或拖地图", "warn", 3200);
      } catch (err) {
        placeList.value = [];
        placeListTitle.value = "附近地点暂时查不到，可以在上面搜名字";
      } finally {
        placeBusy.value = false;
      }
    }

    /* 搜索地点：不设范围，结果按离我多远从近到远排 */
    async function searchPlaces() {
      const query = (placeQuery.value || "").trim();
      if (!query) return;
      const draft = newSession.value;
      placeBusy.value = true;
      try {
        /* 参照点：优先用已经选中的点；还没选就用地图当前中心，
           这样结果总能算出"离我多远"，并按由近到远排。 */
        const here = (draft.lat || draft.lng) ? draft : (map ? map.center() : null);
        const near = here ? "&near=" + here.lat + "," + here.lng : "";
        const res = await api("/api/geo/search", { query: "q=" + encodeURIComponent(query) + near });
        placeList.value = res.items || [];
        placeListTitle.value = placeList.value.length
          ? "搜索结果「" + query + "」（由近到远）" : "没搜到「" + query + "」，换个说法试试";
        if (res.offline) toast("搜索服务暂时连不上，稍后再试", "warn", 3200);
      } catch (err) {
        placeList.value = [];
        placeListTitle.value = "搜索失败：" + err.message;
      } finally {
        placeBusy.value = false;
      }
    }

    function pickPlace(item) {
      const draft = newSession.value;
      draft.lat = Number(Number(item.lat).toFixed(7));
      draft.lng = Number(Number(item.lng).toFixed(7));
      draft.place = (item.address || item.name || "").split(" · ").slice(0, 3).join(" · ").slice(0, 60) || item.name;
      haptic(8);
      if (map) map.setCenter(draft.lat, draft.lng);
      loadNearby(true);
    }

    function setRadius(value) {
      newSession.value.radius = value;
      syncRadius();
      haptic(6);
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
      locating.value = true;
      let pos = null;
      try {
        pos = await deviceLocation({ timeout: 15000 });
      } catch (err) {
        toast(err.message || "定位失败，可以直接搜地点名或拖动地图", "warn", 4000);
        return;
      } finally {
        locating.value = false;
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
    async function loadRoster() {
      if (!rosterSession.value) return;
      const data = await api("/api/admin/session-roster", { query: "session_id=" + rosterSession.value.id });
      roster.value = data.roster || [];
      rosterCounts.value = data.counts || {};
      if (data.session) rosterSession.value = data.session;
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
        else if (tab.value === "records") { await loadSessions(); await loadRoster(); }
        else if (tab.value === "posts") await loadPosts();
        else if (tab.value === "settings" || tab.value === "signset") await loadOverview();
        else { await loadVersions(); await loadLogs(); }
      } catch (err) {
        toast(err.message || "加载失败", "error");
      } finally {
        loading.value = false;
      }
    }

    /* 分栏切换：并排轨道 + 跟手 1:1 拖动。
       滑块进度 = 翻页进度（拖满一屏 = 相邻分栏就位），所以滑块和内容永远同进同出。
       导航条自己可以横向滚动，滑块位置在"内容坐标系"里算，滚动时不会跑偏。 */
    const segEl = ref(null);
    const stageEl = ref(null);
    const pill = ref("opacity:0");
    const paneAnim = ref(false);
    const paneWidth = ref(0);
    let dragX = 0;      // 拖动位移（故意不做成响应式，直接写 DOM，保证 60fps）
    let shift = 0;      // 提交动画期间整条轨道的位移（-1/0/1 屏）

    const tabIds = computed(() => tabs.value.map((t) => t.id));
    const panes = computed(() => {
      const ids = tabIds.value;
      const index = Math.max(0, ids.indexOf(tab.value));
      const out = [];
      for (let d = -1; d <= 1; d++) {
        const id = ids[index + d] || "";
        out.push({ key: id || "ghost" + d, off: d, id: id });
      }
      return out;
    });

    function measure() {
      if (stageEl.value) paneWidth.value = stageEl.value.clientWidth || paneWidth.value;
    }

    function stageWidth() {
      const stage = stageEl.value;
      return (stage && stage.clientWidth) || paneWidth.value || window.innerWidth || 375;
    }
    function paneX(p) {
      return Math.round((p.off - shift) * stageWidth() + dragX);
    }
    function paneStyle(p) {
      const x = paneX(p);
      return Math.abs(x) < 0.5 ? "" : "transform:translate3d(" + x + "px,0,0);";
    }

    /** 拖动/动画期间直接写 DOM，不触发 Vue 重渲染 */
    function applyPanes() {
      const stage = stageEl.value;
      const w = (stage && stage.clientWidth) || paneWidth.value || 0;
      if (stage) {
        stage.classList.toggle("dragging", !paneAnim.value);
        stage.classList.toggle("anim", paneAnim.value);
        const els = stage.querySelectorAll(".ad-pane");
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          const off = Number(el.dataset.off || 0);
          const x = Math.round((off - shift) * w + dragX);
          el.style.transform = Math.abs(x) < 0.5 ? "" : "translate3d(" + x + "px,0,0)";
        }
      }
      /* 滑块在跟手阶段关掉 CSS 过渡（严格 1:1），动画阶段交还给 CSS */
      const seg = segEl.value;
      if (seg) seg.classList.toggle("pill-dragging", !paneAnim.value);
      /* 滑块和内容共用同一份进度：提交动画时 shift = ±1，
         滑块就正好压在相邻那个按钮上，和分栏一起到达，不会各走各的。 */
      let progress = 0;
      let dir = 0;
      if (shift) { progress = 1; dir = shift > 0 ? 1 : -1; }
      else if (dragX) { progress = w ? Math.min(1, Math.abs(dragX) / Math.max(1, w)) : 0; dir = dragX < 0 ? 1 : -1; }
      pill.value = pillStyle(segEl.value, progress, dir);
    }

    /* 过渡必须先落地再改位移。同一个 tick 里既挂 transition 又改 transform 时，
       浏览器会把两件事合并成一次样式计算，直接跳到终点（用户看到的就是"咔一下"）。
       读一次 offsetWidth 强制回流，让浏览器先记住"旧位移 + 过渡已生效"。 */
    function beginStageAnim() {
      const stage = stageEl.value;
      const seg = segEl.value;
      paneAnim.value = true;
      if (stage && !stage.classList.contains("anim")) stage.classList.add("anim");
      if (stage) stage.classList.remove("dragging");
      if (seg) seg.classList.remove("pill-dragging");
      if (stage) void stage.offsetWidth;
      if (seg) void seg.offsetWidth;
    }
    function endStageAnim() {
      paneAnim.value = false;
      const stage = stageEl.value;
      if (stage) stage.classList.remove("anim");
    }

    function syncSeg() { nextTick(() => { measure(); applyPanes(); }); }

    /** 切到第 step 个以外的分栏：滑一格动画 + 同步换数据 */
    function slideTo(id, dir) {
      beginStageAnim();      // 过渡先落地（此刻分栏还停在手指位置）
      shift = dir;
      dragX = 0;
      applyPanes();          // 再滑一格：内容走一格，滑块同步走到相邻按钮
      haptic(6);
      setTimeout(() => {
        endStageAnim();
        shift = 0;
        tab.value = id;
        refresh();
        nextTick(() => { measure(); applyPanes(); });
      }, 360);               // 比 CSS 的 320ms 稍晚一点，等它彻底停稳再收尾
    }

    function go(id, dir) {
      if (id === tab.value) return;
      const ids = tabIds.value;
      const from = ids.indexOf(tab.value);
      const to = ids.indexOf(id);
      if (from < 0 || to < 0 || Math.abs(to - from) !== 1) {
        /* 隔了好几栏就直切，硬滑一格格反而莫名其妙 */
        endStageAnim();
        shift = 0;
        dragX = 0;
        tab.value = id;
        haptic(6);
        refresh();
        nextTick(() => { measure(); applyPanes(); });
        return;
      }
      slideTo(id, to > from ? 1 : -1);
    }

    function step(dir) {
      const ids = tabIds.value;
      const index = ids.indexOf(tab.value);
      const next = ids[index + dir];
      if (!next) return false;
      slideTo(next, dir);
      return true;
    }

    function onSwipe(e) {
      const ids = tabIds.value;
      const index = Math.max(0, ids.indexOf(tab.value));
      if (e.phase === "move") {
        paneAnim.value = false;
        dragX = e.dx;
        applyPanes();
        return;
      }
      const width = paneWidth.value || e.width || 1;
      const dir = e.dx < 0 ? 1 : -1;
      /* 松手时用位移 + 速度决定，和微信一致：甩一下就够，慢慢拖要过半 */
      const far = Math.abs(e.dx) > Math.min(72, width * 0.18) || (Math.abs(e.velocity || 0) > 0.4 && Math.abs(e.dx) > 18);
      const next = ids[index + dir];
      if (e.phase === "end" && far && next) { slideTo(next, dir); return; }
      beginStageAnim();      // 过渡先落地（此刻分栏还停在手指位置）
      dragX = 0;             // 再改位移，于是有一段真正的回弹动画
      applyPanes();
      setTimeout(() => { endStageAnim(); applyPanes(); }, 360);
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
      rosterSession.value = s;
      go("records");
    }

    async function openRoster(s) {
      rosterSession.value = s;
      roster.value = [];
      await guard(async () => { await loadRoster(); });
    }

    function closeRoster() {
      rosterSession.value = null;
      roster.value = [];
      rosterCounts.value = {};
    }

    function pickMember(m) {
      memberPick.value = m;
      pickNote.value = m.note || "";
    }

    async function setStatus(status) {
      const m = memberPick.value;
      if (!m || !rosterSession.value) return;
      await guard(async () => {
        if (status === "clear") {
          if (m.record_id) await api("/api/admin/records/" + m.record_id, { method: "DELETE" });
        } else {
          await api("/api/admin/records", { method: "POST", body: {
            session_id: rosterSession.value.id, user_id: m.user_id, status, note: pickNote.value } });
        }
        memberPick.value = null;
        haptic(12);
        await loadRoster();
        toast("已更新", "success");
      });
    }

    /* 导出 Excel：服务端现写 xlsx，前端只负责把 blob 存下来 */
    async function exportRecords(sid) {
      try {
        toast("正在生成 Excel…", "info", 1600);
        const resp = await api("/api/admin/records.xlsx" + (sid ? "?session_id=" + sid : ""), { raw: true });
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = sid ? ("签到记录-场次" + sid + ".xlsx") : "签到记录-全部场次.xlsx";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast("Excel 已导出", "success");
      } catch (err) { toast(err.message, "error"); }
    }

    const STATUS_TEXT = { present: "已签到", late: "迟到", leave: "请假", absent: "缺勤", none: "缺勤" };
    function statusText(status) { return STATUS_TEXT[status] || status || "缺勤"; }
    function statusCls(status) {
      return { present: "chip-green", late: "chip-orange", leave: "", absent: "chip-red", none: "chip-red" }[status] || "";
    }

    const years = computed(() => {
      const set = new Set();
      sessions.value.forEach((s) => set.add(new Date((s.sign_at || s.starts_at) * 1000).getFullYear()));
      return [...set].sort((a, b) => b - a);
    });
    const days = computed(() => {
      const { y, m } = filter.value;
      if (!y || !m) return 31;
      return new Date(y, m, 0).getDate();
    });
    const filteredSessions = computed(() => {
      const f = filter.value;
      const q = (f.q || "").trim().toLowerCase();
      return sessions.value.filter((s) => {
        const d = new Date((s.sign_at || s.starts_at) * 1000);
        if (f.y && d.getFullYear() !== f.y) return false;
        if (f.m && d.getMonth() + 1 !== f.m) return false;
        if (f.d && d.getDate() !== f.d) return false;
        if (q && !(String(s.title || "").toLowerCase().includes(q) || ("#" + s.id).includes(q))) return false;
        return true;
      });
    });

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
        const picked = Array.isArray(fileInput.value) ? fileInput.value.find(function (el) { return !!el; }) : fileInput.value;
        if (picked) picked.value = "";
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
    let stopAvatar = null;
    onMounted(() => {
      /* 别人换头像后管理列表实时刷新 */
      stopAvatar = onWs("avatar", (msg) => {
        const row = users.value.find((x) => x.id === msg.user_id);
        if (row) row.avatar = msg.avatar || "";
        const rec = roster.value.find((x) => x.user_id === msg.user_id);
        if (rec) rec.avatar = msg.avatar || "";
      });
      stopSwipe = registerSwipe("/admin", onSwipe, (dir) => {
        const list = tabs.value;
        const index = list.findIndex((t) => t.id === tab.value);
        const next = index + dir;
        return index >= 0 && next >= 0 && next < list.length;
      });
      syncSeg();
      window.addEventListener("resize", syncSeg);
      /* 导航条横向滚动不需要监听：滑块位置在内容坐标系里算，会跟着一起滚 */
    });
    onUnmounted(() => {
      if (stopSwipe) stopSwipe();
      if (stopAvatar) stopAvatar();
      window.removeEventListener("resize", syncSeg);
      if (map) { map.destroy(); map = null; }
    });

    return { tab, tabs, toggles, loading, busy, overview, server, online, onlineUsers, users, sessions,
             roster, rosterCounts, rosterSession, memberPick, pickNote, filter, years, days, filteredSessions,
             STATUS_OPTS, statusText, statusCls, openRoster, closeRoster, loadRoster, pickMember, setStatus, exportRecords,
             segEl, stageEl, pill, paneAnim, panes, paneStyle,
             posts, logs, versions, settings, editing, openSession, draft, sDraft,
             announceText, uploadFile, fileInput, sql, sqlConfirm, sqlResult, newUser, newSession, upload,
             loadPercent, fileSize, barColor, sizeOf, stamp, percent, isAdmin, signTimes, newTime, graceDraft,
             mapEl, locating, pickedCoord, customTime, placeQuery, placeBusy, placeList, placeListTitle,
             RADIUS_PRESETS, searchPlaces, pickPlace, fmtDistance, setRadius,
             refresh, go, step, toggleEdit, createUser, saveUser, resetPassword, removeUser, createSession,
             toggleSession, saveSession, removeSession, viewRecords,
             togglePost, sendAnnounce, toggleSetting, saveSettings, downloadBackup, onFile, doUpload, runSql,
             pickTime, toggleLocation, useMyLocation, zoomMap, syncRadius, locateName, addTime, removeTime, saveSignSettings,
             store, navigate, mediaUrl };
  },
}));
