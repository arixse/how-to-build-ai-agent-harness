// harness/run-subagent.js —— 第7章 demo：四出戏
// 戏1 委派=一次工具调用（子 loop 真的跑，父只收结论；子试图再委派被结构性阻断）
// 戏2 结论截断写明 + 回合总量闸  戏3 委派预算闸（带原因的失败）  戏4 Skills 渐进式披露

import { textBlock, toolCallBlock } from "./messages.js";
import { createMockModel } from "./model.js";
import { createToolRegistry, readFileTool } from "./tools.js";
import { createTaskTool, createSupervisor, MAX_SUBAGENT_DEPTH } from "./subagent.js";
import { createSkillLoader, createLoadSkillTool } from "./skills.js";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** 静音包装：demo 只看结果，不要流式吐字干扰输出 */
const silent = (model) => ({ complete: (p) => model.complete({ ...p, onDelta: undefined }) });

// ---------- 戏 1：委派 = 一次工具调用 ----------
{
  // 子 Agent 的模型脚本：先读文件，再给出结论
  const subModel = createMockModel([
    { content: [toolCallBlock("s1", "read_file", { path: "messages.js" })], stopReason: "toolUse" },
    { content: [textBlock("结论：messages.js 定义了 text/toolCall/toolResult 三种块；铁律是每个 toolCall 必须有顺序一致的 toolResult 对应。")], stopReason: "stop" },
  ]);
  // 父 Agent 的模型脚本：直接委派
  const parentModel = createMockModel([
    { content: [toolCallBlock("p1", "task", { goal: "总结 messages.js 里定义了什么", context: ["工作目录里有 messages.js"] })], stopReason: "toolUse" },
    { content: [textBlock("收到结论，任务完成。")], stopReason: "stop" },
  ]);

  const taskTool = createTaskTool([readFileTool], silent(subModel), { supervisor: createSupervisor(), maxTurns: 10 });
  const parentTools = createToolRegistry([readFileTool, taskTool]);
  const { newMessages } = await import("./loop.js").then(({ runAgentLoop }) =>
    runAgentLoop({ systemPrompt: "你是主 Agent。", messages: [], tools: parentTools, model: silent(parentModel), maxTurns: 10 }),
  );

  const taskResult = newMessages.find((m) => m.role === "toolResult" && m.toolName === "task");
  console.log("【戏1】父收到的 task 结果 =", taskResult.content[0].text);
  console.log("【戏1】父的消息流里只有这一条结论——子的读取过程（read_file 等）一概不在其中");
}

// ---------- 戏 1b：子 Agent 拿不到 task 工具（结构性阻断递归） ----------
{
  const greedySubModel = createMockModel([
    { content: [toolCallBlock("g1", "task", { goal: "再委派一层" })], stopReason: "toolUse" },
    { content: [textBlock("没有 task 工具，我自己做。")], stopReason: "stop" },
  ]);
  const taskTool = createTaskTool([readFileTool], silent(greedySubModel), { supervisor: createSupervisor(), maxTurns: 10 });
  // 子工具集在 task.run 内部派生（已剔除 task）；这里直接构造同款子注册表验证
  const { createToolRegistry: reg } = await import("./tools.js");
  const subTools = reg([readFileTool, taskTool].filter((d) => d.name !== "task"));
  const res = await subTools.execute({ id: "g1", name: "task", arguments: { goal: "x" } }, undefined);
  console.log("\n【戏1b】深度", MAX_SUBAGENT_DEPTH, "的子 Agent 调 task →", res.content[0].text, "（递归不是被拦下，而是根本不存在）");
}

// ---------- 戏 2：结论截断写明 + 回合总量闸 ----------
{
  const longTail = "结论细节。".repeat(80); // 400 字符
  const subModel = createMockModel([
    { content: [textBlock(longTail)], stopReason: "stop" },
    { content: [textBlock(longTail)], stopReason: "stop" }, // 第二次委派也要有剧本（mock 按次消耗）
  ]);
  const taskTool = createTaskTool([readFileTool], silent(subModel), {
    supervisor: createSupervisor({ maxResultChars: 200 }),
    maxTurns: 10,
    resultLimit: 200, // demo 缩小（真实 8000）
  });
  const tools = createToolRegistry([taskTool]);
  const r1 = await tools.execute({ id: "t1", name: "task", arguments: { goal: "给个长结论" } }, undefined);
  console.log("\n【戏2】第一次委派，截断尾部 =", JSON.stringify(r1.content[0].text.slice(-60)));
  const r2 = await tools.execute({ id: "t2", name: "task", arguments: { goal: "再来一个长结论" } }, undefined);
  console.log("【戏2】回传总量（真实 24000）耗尽后，提示切换 =", JSON.stringify(r2.content[0].text.slice(-75)));
}

// ---------- 戏 3：委派预算闸（带原因的失败） ----------
{
  const subModel = createMockModel([
    { content: [textBlock("结论：完成。")], stopReason: "stop" },
    { content: [textBlock("结论：完成。")], stopReason: "stop" },
    { content: [textBlock("结论：完成。")], stopReason: "stop" },
  ]);
  const taskTool = createTaskTool([readFileTool], silent(subModel), { supervisor: createSupervisor({ maxDelegations: 2 }), maxTurns: 10 });
  const tools = createToolRegistry([taskTool]);
  for (let i = 1; i <= 3; i++) {
    const r = await tools.execute({ id: `d${i}`, name: "task", arguments: { goal: `委派 ${i}` } }, undefined);
    console.log(`【戏3】第${i}次委派 →`, r.isError ? `isError: ${r.content[0].text}` : "成功");
  }
}

// ---------- 戏 4：Skills 渐进式披露 ----------
{
  const loader = createSkillLoader([join(here, "skills")]);
  console.log("\n【戏4】注入 system prompt 的清单（只有元数据，没有全文）：");
  console.log(loader.generateSkillSummary().split("\n").slice(0, 5).join("\n"));
  const loadSkill = createLoadSkillTool(loader);
  const full = await loadSkill.run({ name: "commit-style" }, undefined);
  const body = full.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim().split("\n");
  console.log("【戏4】load_skill 取回全文，正文前两行 =", JSON.stringify(body.slice(0, 2)));
  const miss = await loadSkill.run({ name: "no-such" }, undefined);
  console.log("【戏4】加载不存在的 skill →", JSON.stringify(miss.text), "isError =", miss.isError);
}
