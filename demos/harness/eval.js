// harness/eval.js —— 第8章：迷你评测 runner（回归门）
// 裁自 mini-pi eval/（docs/eval-plan.md 的 v1 实现，简化：任务内联、mock 模型、无沙箱进程）。
// 核心语义：判定三合一（隐藏测试全绿 ∧ 禁改文件未动 ∧ 未超时）+ 相对基线门禁（不设绝对分数线）。

import { runAgentLoop } from "./loop.js";
import { textBlock, toolCallBlock } from "./messages.js";

/** 被测 Agent 的「工具集」：write_file 写进内存工作区，供判定检查禁改文件 */
export function createMemoryWorkspace(initialFiles = {}) {
  const files = { ...initialFiles };
  const writeFileTool = {
    name: "write_file",
    description: "写文件",
    concurrent: false,
    run: ({ path, content }) => {
      files[path] = content;
      return { text: `已写入 ${path}` };
    },
  };
  const readFileTool = {
    name: "read_file",
    description: "读文件",
    concurrent: true,
    run: ({ path }) => (path in files ? { text: files[path] } : { text: `不存在：${path}`, isError: true }),
  };
  return { files, tools: [readFileTool, writeFileTool] };
}

/**
 * 跑单条任务：被测模型（脚本化）执行 instruction，跑完交给 grade 判定。
 * 判定三合一：hiddenTests（隐藏测试全绿）∧ 禁改文件未被改 ∧ 未超时（这里以轮次护栏模拟）。
 */
export async function runTask(task, modelFactory) {
  const ws = createMemoryWorkspace(task.workspace ?? {});
  const model = modelFactory(task.id);
  const { newMessages } = await runAgentLoop({
    systemPrompt: "你是被评测的 Agent。",
    messages: [{ role: "user", content: [textBlock(task.instruction)], timestamp: Date.now() }],
    tools: createWsRegistry(ws.tools),
    model,
    maxTurns: task.maxTurns ?? 10,
  });
  const g = task.grade({ newMessages, files: ws.files }) ?? {};
  const hiddenTestsPass = g.hiddenTestsPass ?? false;
  const forbiddenTouched = (task.forbidden ?? []).some((f) => f in ws.files && ws.files[f] !== (task.workspace?.[f] ?? undefined));
  const pass = hiddenTestsPass && !forbiddenTouched;
  return {
    id: task.id,
    pass,
    hiddenTestsPass,
    forbiddenTouched,
    reason: forbiddenTouched ? "禁改文件被修改" : hiddenTestsPass ? "通过" : "隐藏测试未全绿",
  };
}

function createWsRegistry(defs) {
  const map = new Map(defs.map((d) => [d.name, d]));
  return {
    async execute(call, signal) {
      const def = map.get(call.name);
      if (!def) return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [textBlock(`未知工具: ${call.name}`)], isError: true, timestamp: Date.now() };
      try {
        const out = await def.run(call.arguments, signal);
        return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [textBlock(out.text)], isError: out.isError ?? false, timestamp: Date.now() };
      } catch (e) {
        return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [textBlock(String(e?.message ?? e))], isError: true, timestamp: Date.now() };
      }
    },
    canRunConcurrently: (call) => map.get(call.name)?.concurrent ?? false,
  };
}

/**
 * 跑整组任务并与基线比较：任一 gate 任务的通过数低于基线 → 门禁失败（退出码 1）。
 * gate:false 的任务照常进报告，但不参与基线比较、不影响退出码。
 */
export function runSuite({ results, baseline }) {
  const rows = results.map((r) => {
    const base = baseline[r.id];
    const gated = base !== undefined && base.gate !== false;
    return { ...r, gated, baselinePass: gated ? base.pass ?? base : "—", delta: gated ? (r.pass ? 1 : 0) - (base.pass ?? base) : "—" };
  });
  const failed = rows.filter((r) => r.gated && r.delta < 0);
  const report = rows
    .map((r) => `  ${r.id.padEnd(18)} ${r.pass ? "PASS" : "FAIL"}（${r.reason}）  基线=${r.baselinePass}  Δ=${r.delta}${r.gated ? "" : "  [gate:false 不计入]"}`)
    .join("\n");
  return { rows, failed, report, exitCode: failed.length > 0 ? 1 : 0 };
}
