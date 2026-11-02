// harness/tools.js
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { toolResultBlock } from "./messages.js";

export function createToolRegistry(defs) {
  const map = new Map(defs.map((d) => [d.name, d]));
  return {
    // 工具失败也必须转成 toolResult（isError），绝不能直接抛——
    // 否则这一轮会以「缺结果」的非法序列落盘（见决定五）。
    async execute(toolCall, signal) {
      const def = map.get(toolCall.name);
      if (!def) return toolResultBlock(toolCall.id, toolCall.name, `未知工具: ${toolCall.name}`, true);
      try {
        const out = await def.run(toolCall.arguments, signal);
        return toolResultBlock(toolCall.id, toolCall.name, out.text, out.isError ?? false);
      } catch (e) {
        return toolResultBlock(toolCall.id, toolCall.name, String(e?.message ?? e), true);
      }
    },
    canRunConcurrently(toolCall) {
      return map.get(toolCall.name)?.concurrent ?? false;
    },
  };
}

export const readFileTool = {
  name: "read_file",
  concurrent: true, // 只读 → 允许并发
  run: ({ path }) => ({ text: readFileSync(path, "utf8") }),
};

export const execTool = {
  name: "exec",
  concurrent: false, // 会改变状态 → 必须串行
  run: ({ command }) => ({ text: execSync(command, { encoding: "utf8" }) }),
};
