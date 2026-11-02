// harness/flaky-model.js —— 第3章 demo 专用：一个「专出事故」的假模型。
// 真实项目里，被包的 inner 就是调真实 API 的流式模型；demo 用它确定性复现三类故障。
import { textBlock } from "./messages.js";

const hangUntilAborted = (signal) =>
  new Promise((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("被看门狗掐断"), { kind: "stream_idle_timeout" })),
      { once: true },
    );
    // 不 resolve、不 reject：模拟「连接还在、正文永远不来」
  });

export function createFlakyModel(scenario) {
  let calls = 0;
  return {
    async complete({ signal, onDelta } = {}) {
      if (signal?.aborted) return { role: "assistant", content: [], stopReason: "aborted" };
      calls++;

      // 戏1「stall」：第一次调用一个字都不吐然后装死 → 看门狗掐断 → 重试第二次正常
      if (scenario === "stall" && calls === 1) {
        await hangUntilAborted(signal);
      }

      // 戏2「rate-limit」：前两次都回 429 并带上 Retry-After，第三次放行
      if (scenario === "rate-limit" && calls <= 2) {
        const err = new Error("HTTP 429 Too Many Requests");
        err.kind = "http";
        err.status = 429;
        err.retryAfterMs = 400; // 假装服务端要求「400ms 后再来」
        throw err;
      }

      // 戏3「mid-stream-drop」：先吐半句，然后连接被掐断 → 已外发，绝不重试
      if (scenario === "mid-stream-drop") {
        onDelta?.("这半句已经上屏了，");
        const err = new Error("正文读到一半连接被掐断");
        err.kind = "network";
        throw err;
      }

      return { role: "assistant", content: [textBlock("一切正常，任务完成。")], stopReason: "stop" };
    },
  };
}
