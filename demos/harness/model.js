// harness/model.js —— 第1章用 mock；第3章换成「可靠性壳 + 真实实现」
// 关键 seam：complete({ systemPrompt, messages, tools, signal, onDelta })
import { textBlock } from "./messages.js";

export function createMockModel(scriptedTurns) {
  let i = 0;
  return {
    async complete({ signal, onDelta } = {}) {
      // 取消信号一上来就直接收尾，绝不假装成功
      if (signal?.aborted) {
        return { role: "assistant", content: [], stopReason: "aborted" };
      }
      const turn =
        scriptedTurns[i++] ??
        { content: [textBlock("我做完了，没有要调的工具。")], stopReason: "stop" };
      // 模拟流式：一个字一个字往外吐（真实实现见第3章）
      if (onDelta) for (const b of turn.content) if (b.type === "text") onDelta(b.text);
      return { role: "assistant", content: turn.content, stopReason: turn.stopReason };
    },
  };
}
