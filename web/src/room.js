// 联机房间通用逻辑：加入 / 离开确认 / 再来一局 / 观战 / 房间号。
import {
  ref, computed, onMounted, onUnmounted, route, store, onWs, wsSend, toast, haptic,
  confirmDialog, navigate, registerBack, registerSwipe,
} from "./ui.js";

export function useRoom(path) {
  const roomId = String(route.query.room || "");
  const room = ref(null);
  const finished = ref(false);
  const aborted = ref(false);
  const winners = ref([]);
  const reason = ref("");
  const rematchVotes = ref([]);
  const notice = ref("");
  const peerLeft = ref(false);
  const left = ref(false);

  const me = computed(() => (store.user && store.user.id) || 0);
  const players = computed(() => (room.value && room.value.players) || []);
  const spectators = computed(() => (room.value && room.value.spectators) || []);
  const isSpectator = computed(() => players.value.length > 0 && !players.value.some((p) => p.uid === me.value));
  const others = computed(() => players.value.filter((p) => p.uid !== me.value));
  const iWantRematch = computed(() => rematchVotes.value.indexOf(me.value) >= 0);
  const othersWantRematch = computed(() => rematchVotes.value.some((uid) => uid !== me.value));
  const canRematch = computed(() => others.value.length > 0 && !peerLeft.value);
  const roomCode = computed(() => (room.value && (room.value.code || room.value.id)) || roomId);
  const ready = computed(() => (room.value && room.value.ready) || []);
  const readyNeeded = computed(() => (room.value && room.value.min) || 2);
  const myReady = computed(() => ready.value.indexOf(me.value) >= 0);
  const canReady = computed(() => !!room.value && !room.value.started && !finished.value && !isSpectator.value
    && players.value.length >= readyNeeded.value);
  function isReady(p) { return ready.value.indexOf(p.uid) >= 0; }
  function toggleReady() { wsSend({ t: "game.ready" }); haptic(8); }
  function winnerNames(list) {
    return (list || []).map((x) => {
      if (x && typeof x === "object") return x.name || "同学";
      const hit = players.value.find((p) => p.uid === x);
      return (hit && hit.name) || "同学";
    }).join("、");
  }
  const roomName = computed(() => (room.value && room.value.name) || "对局");

  function applyRoom(next) {
    if (!next) return;
    room.value = next;
    const state = next.state || {};
    rematchVotes.value = next.rematch || [];
    if (state.status === "finished") {
      finished.value = true;
      aborted.value = false;
      winners.value = state.winners || [];
      reason.value = state.reason || "";
    } else if (state.status === "aborted") {
      finished.value = false;
      aborted.value = true;
      winners.value = [];
      reason.value = state.reason || "";
    } else if (state.status === "playing") {
      finished.value = false;
      aborted.value = false;
      winners.value = [];
      reason.value = "";
      notice.value = "";
      peerLeft.value = false;
    }
    const remaining = (next.players || []).filter((p) => p.uid !== me.value);
    if (remaining.length === 0 && (next.started || finished.value) && !peerLeft.value) {
      peerLeft.value = true;
      notice.value = "对方已离开房间";
    }
    if (remaining.length > 0) peerLeft.value = false;
  }

  async function leaveRoom(silent) {
    if (left.value) return true;
    if (!silent) {
      const watching = isSpectator.value;
      const yes = await confirmDialog(
        watching ? "确定退出观战吗？" : "确定离开房间吗？对局不会被保存，你随时还能再加进来。",
        watching ? { title: "退出观战", okText: "退出观战", danger: true }
                 : { title: "离开房间", okText: "离开房间", danger: true });
      if (!yes) return false;
    }
    left.value = true;
    wsSend({ t: "game.leave" });
    navigate("/games");
    return true;
  }

  function rematch() {
    if (!canRematch.value) {
      toast("对方已经离开了，等新同学加入再开一局吧", "warn");
      return;
    }
    wsSend({ t: "game.rematch" });
    haptic(10);
  }

  function join() {
    wsSend({ t: "game.join", room: roomId, play: true });
  }

  async function copyCode() {
    const text = "房间号 " + roomCode.value;
    try {
      await navigator.clipboard.writeText(text);
      toast("房间号已复制：" + text, "ok");
    } catch (err) {
      toast(text, "info", 4000);
    }
  }

  let stops = [];
  onMounted(() => {
    join();
    stops.push(onWs("game.state", (msg) => applyRoom(msg.room)));
    stops.push(onWs("game.update", (msg) => applyRoom(msg.room)));
    stops.push(onWs("game.over", (msg) => {
      applyRoom(msg.room);
      finished.value = !msg.aborted;
      aborted.value = !!msg.aborted;
      winners.value = msg.winners || [];
      reason.value = msg.reason || "";
      if (!msg.aborted) haptic([12, 40, 24]);
      if (isSpectator.value) {
        /* 观战的人也要知道结果：赢了 / 平局 / 有人退出中止 */
        const names = winnerNames(msg.winners);
        const text = msg.aborted ? ("本局中止：" + (msg.reason || "有人离开了房间"))
                                 : (names ? ("本局结束，" + names + " 胜出") : "本局结束，平局");
        toast(text, msg.aborted ? "info" : "success", 4600);
      }
    }));
    stops.push(onWs("game.rematch", (msg) => {
      rematchVotes.value = msg.waiting || [];
      const names = msg.names || {};
      const wanted = (msg.waiting || []).filter((uid) => uid !== me.value);
      if (wanted.length) {
        const who = wanted.map((uid) => names[String(uid)] || "对方").join("、");
        notice.value = who + " 想和你再来一局";
        haptic([8, 30, 8]);
      } else if (!(msg.waiting || []).includes(me.value)) {
        notice.value = "";
      }
    }));
    stops.push(onWs("game.event", (msg) => { if (msg.text) toast(msg.text, "info", 2800); }));
    stops.push(onWs("game.error", (msg) => {
      toast(msg.text || "房间不存在", "warn", 3000);
      navigate("/games");
    }));
    stops.push(onWs("game.left", () => { left.value = true; }));
    /* 断线重连（手机切后台回来）后自动坐回原来的房间，服务端有 120 秒宽限期 */
    stops.push(onWs("open", () => { if (!left.value) join(); }));
    stops.push(onWs("close", () => {
      if (!left.value && room.value) toast("网络断开，正在自动重连…", "warn", 3600);
    }));
    stops.push(registerBack(path, () => { if (!store.confirm) leaveRoom(false); return true; }));
    stops.push(registerSwipe(path, () => true));
  });
  onUnmounted(() => {
    stops.forEach((fn) => fn && fn());
    stops = [];
    if (!left.value) wsSend({ t: "game.leave" });
  });

  return {
    roomId, room, roomCode, roomName, players, spectators, isSpectator, others,
    finished, aborted, winners, reason, notice, peerLeft, iWantRematch, othersWantRematch, canRematch,
    ready, readyNeeded, myReady, canReady, isReady, toggleReady,
    applyRoom, leaveRoom, rematch, join, copyCode, me,
  };
}
