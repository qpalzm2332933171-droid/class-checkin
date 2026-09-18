import { defineView, registerRoute, navigate } from "../ui.js";

registerRoute("/404", defineView("notfound", {
  template: `
  <div class="page-plain center nf">
    <div class="glass glass-liquid pad6 center stack" style="text-align:center">
      <Icon n="puzzle" :size="42" />
      <h2 class="t2 mt3">找不到这个页面</h2>
      <p class="sub">可能是链接过期了，回到签到页看看。</p>
      <button class="btn btn-primary mt3" @click="navigate('/')">回到签到</button>
    </div>
  </div>`,
  style: `.nf { min-height: 74dvh; }`,
  setup: () => ({ navigate }),
}));
