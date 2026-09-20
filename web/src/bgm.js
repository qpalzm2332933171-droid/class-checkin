// 开局背景音乐：五子棋 / 围棋双方都准备、对局一开始就自动播放，右上角有开关。
// 只做一件事，所以不放进 ui.js；播放被浏览器拦下时用 bgmBlocked 提示用户点一下按钮。
import { ref, mediaUrl } from "./ui.js";

const OFF_KEY = "checkin_bgm_off";
const SRC = "/media/game-start.mp3";
/** 开局背景音乐适用的游戏（五子棋 / 围棋） */
export const BGM_GAMES = ["gomoku", "go"];

/** 用户手动关掉过就记住（下次不再自动吵人） */
export const bgmMuted = ref(readOff());
/** 浏览器拦了自动播放：需要用户点一下按钮才出声 */
export const bgmBlocked = ref(false);

let audio = null;

function readOff() {
  try { return localStorage.getItem(OFF_KEY) === "1"; } catch (err) { return false; }
}

function ensure() {
  if (audio) return audio;
  audio = new Audio(mediaUrl(SRC));
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = 0.7;
  audio.hidden = true;            // 不显示控件，但挂在文档里：方便调试与自动化测试查状态
  audio.dataset.bgm = "1";
  audio.addEventListener("playing", () => { bgmBlocked.value = false; });
  try { document.body.appendChild(audio); } catch (err) { /* ignore */ }
  return audio;
}

/** 房间一挂载就预取，等对手点准备的这段时间足够把 2MB 拉进缓存 */
export function preloadGameBgm() {
  try { ensure().load(); } catch (err) { /* 取不到最多是没声音，不打断对局 */ }
}

export function playGameBgm() {
  if (bgmMuted.value) return;
  let box;
  try { box = ensure(); } catch (err) { return; }
  const played = box.play();
  if (played && played.catch) played.catch(() => { bgmBlocked.value = true; });
}

export function stopGameBgm() {
  if (!audio) return;
  try { audio.pause(); audio.currentTime = 0; } catch (err) { /* ignore */ }
}

export function setBgmMuted(next) {
  bgmMuted.value = !!next;
  try { localStorage.setItem(OFF_KEY, bgmMuted.value ? "1" : "0"); } catch (err) { /* ignore */ }
  if (bgmMuted.value) stopGameBgm();
}
