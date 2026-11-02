// harness/run-session.js —— 第4章 demo：四出戏
// 戏1 存档与重开  戏2 单行损坏只跳过  戏3 token 估算（toolCall 参数必须计入）
// 戏4 压缩触发与「压缩失败不丢历史」

import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { textBlock, toolCallBlock } from "./messages.js";
import { createMockModel } from "./model.js";
import { estimateTextTokens, estimateMessageTokens, resolveContextBudget, KEEP_RECENT_MESSAGES } from "./context.js";
import { createSessionStore } from "./session.js";

// 注：源码真实阈值 = 窗口(128k) × 0.6 ≈ 76_800、下限 8_000、保留最近 10 条。
// demo 用「窗口 200、阈值 120、保留 2」的小数字，肉眼看得到触发过程，量级差异见 context.js 顶部注释。
const DEMO_WINDOW = 200;

// ---------- 戏 1：存档与重开 ----------
{
  const file = new URL("./session-demo-1.jsonl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  rmSync(file, { force: true });
  const store = createSessionStore(file, { cwd: "/demo" });
  store.appendMessages([{ role: "user", content: [textBlock("帮我读一下 loop.js")], timestamp: Date.now() }]);
  store.appendMessages([
    { role: "assistant", content: [toolCallBlock("c1", "read_file", { path: "loop.js" })], timestamp: Date.now() },
    { role: "toolResult", toolCallId: "c1", toolName: "read_file", content: [textBlock("// loop.js 的内容……")], isError: false, timestamp: Date.now() },
  ]);

  // 模拟进程重启：同一份文件重新打开
  const reopened = createSessionStore(file, { cwd: "/demo" });
  console.log("【戏1】重开后恢复条目数 =", reopened.getEntries().length, "（1 头行 + 3 消息）");
  console.log("【戏1】重开后上下文条数 =", reopened.buildContext().length, "，加载警告 =", reopened.getLoadWarnings().length);
  rmSync(file, { force: true });
}

// ---------- 戏 2：单行损坏只跳过该行 ----------
{
  const file = new URL("./session-demo-2.jsonl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  rmSync(file, { force: true });
  const store = createSessionStore(file, { cwd: "/demo" });
  store.appendMessages([{ role: "user", content: [textBlock("第一条：完好的消息")], timestamp: Date.now() }]);
  store.appendMessages([{ role: "user", content: [textBlock("第二条：完好的消息")], timestamp: Date.now() }]);

  // 手工塞进两种「损坏」：半行 JSON + 合法 JSON 但缺字段
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw + '{"type":"message",id":"坏了\n' + JSON.stringify({ type: "message", message: { role: "user" } }) + "\n", "utf8");

  const reopened = createSessionStore(file, { cwd: "/demo" });
  console.log("\n【戏2】加载警告 =", JSON.stringify(reopened.getLoadWarnings()));
  console.log("【戏2】仍可用的消息 =", reopened.buildContext().length, "条，会话照常打开");
  rmSync(file, { force: true });
}

// ---------- 戏 3：token 估算 ----------
{
  console.log("\n【戏3】英文 'hello world, this is a test' =", estimateTextTokens("hello world, this is a test"), "token（29 字符 ≈ /4）");
  console.log("【戏3】中文「帮我读一下这个文件」 =", estimateTextTokens("帮我读一下这个文件"), "token（CJK 按 1 字符 1 token）");
  const big = { role: "assistant", content: [toolCallBlock("c1", "write_file", { content: "x".repeat(200_000) })], timestamp: Date.now() };
  console.log("【戏3】带 20 万字符参数的 toolCall =", estimateMessageTokens(big), "token —— 若漏算参数，这条恒为 0，压缩永不触发");
  console.log("【戏3】真实窗口 128k 的压缩阈值 =", resolveContextBudget(128_000), "token（128000×0.6）；窗口 200 的 demo 阈值 =", resolveContextBudget(DEMO_WINDOW));
}

// ---------- 戏 4：压缩触发，以及压缩失败不丢历史 ----------
{
  const file = new URL("./session-demo-4.jsonl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  rmSync(file, { force: true });
  const store = createSessionStore(file, { cwd: "/demo" });
  for (let i = 1; i <= 12; i++) {
    store.appendMessages([{ role: "user", content: [textBlock(`第${i}轮：请继续处理任务步骤 ${i}，这一步的结论是结论${i}。`)], timestamp: Date.now() }]);
  }
  const maxTokens = 120; // 真实阈值 = resolveContextBudget(窗口)（128000×0.6≈76800，下限 8000）；demo 的 120 会被 8000 托底，故直接给定值
  const summarizer = createMockModel([
    { content: [textBlock("用户要求依次处理任务步骤 1~9；每轮请求继续下一步，并记录结论 1~9。")], stopReason: "stop" },
  ]);
  const entry = await store.compactIfNeeded({ maxTokens, keepRecent: 2, model: summarizer });
  console.log("\n【戏4】压缩触发：tokensBefore =", entry?.tokensBefore, "，摘要 =", entry?.summary);
  const ctx = store.buildContext();
  console.log("【戏4】压缩后上下文 =", ctx.length, "条（摘要 user 消息 1 条 + 保留的最近 2 条 + 新消息）");
  console.log("【戏4】上下文第 1 条 =", JSON.stringify(ctx[0].content[0].text.slice(0, 30) + "……"));

  // 压缩失败：摘要模型挂了 → 不写盘、不丢历史，只记原因
  const file2 = new URL("./session-demo-4b.jsonl", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  rmSync(file2, { force: true });
  const store2 = createSessionStore(file2, { cwd: "/demo" });
  for (let i = 1; i <= 12; i++) {
    store2.appendMessages([{ role: "user", content: [textBlock(`第${i}轮：请继续处理任务步骤 ${i}，这一步的结论是结论${i}。`)], timestamp: Date.now() }]);
  }
  const failing = createMockModel([{ content: [], stopReason: "error" }]);
  const r2 = await store2.compactIfNeeded({ maxTokens, keepRecent: 2, model: failing });
  console.log("【戏4】摘要失败 → compactIfNeeded 返回 =", r2, "；失败原因 =", store2.getLastCompactionError());
  console.log("【戏4】失败后上下文仍 =", store2.buildContext().length, "条 —— 一条没丢，宁可不压");
  rmSync(file, { force: true }); rmSync(file2, { force: true });
}

console.log(`\n（源码真实参数：窗口 128k / 阈值≈76800 / 下限 8000 / 保留最近 ${KEEP_RECENT_MESSAGES} 条 / 摘要输入下限 4000）`);
