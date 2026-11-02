// harness/run-reliable.js —— 第3章 demo：三出戏，把可靠性壳的每条规矩演一遍。
// demo 把 120s/1s 缩小成 300ms/80ms 方便观察；真实常量见 model-reliable.js 顶部注释。
import { withReliability } from "./model-reliable.js";
import { createFlakyModel } from "./flaky-model.js";

const opts = { idleTimeoutMs: 300, baseDelayMs: 80, jitterRatio: 0.2, log: console.log };

// 戏1：静默装死 → 看门狗掐断 → 自动重试成功
{
  console.log("[戏1] 上游一个字不吐然后装死（300ms 静默上限）…");
  const model = withReliability(createFlakyModel("stall"), opts);
  const r = await model.complete({ onDelta: (t) => process.stdout.write(t) });
  console.log("\n[戏1] 看门狗 + 重试救回来了 →", r.content[0].text, "\n");
}

// 戏2：连续两次 429（Retry-After=400ms）→ 退避取大 + 抖动 → 第三次成功
{
  console.log("[戏2] 上游连续限流（429，要求 400ms 后再来）…");
  const model = withReliability(createFlakyModel("rate-limit"), opts);
  const r = await model.complete({});
  console.log("[戏2] 退避重试救回来了 →", r.content[0].text, "\n");
}

// 戏3：吐了半句才断 → 已外发 → 绝不重试，把错误交出去
{
  console.log("[戏3] 上游吐了半句才断线…");
  const model = withReliability(createFlakyModel("mid-stream-drop"), opts);
  try {
    await model.complete({ onDelta: (t) => process.stdout.write(t) });
  } catch (e) {
    console.log("\n[戏3] 已上屏 → 拒绝重试（否则重复显示、重复计费）→", e.message);
  }
}
