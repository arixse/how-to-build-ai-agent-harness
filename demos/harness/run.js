// harness/run.js —— 第1章：把四个文件跑起来
import { runAgentLoop } from "./loop.js";
import { createMockModel } from "./model.js";
import { createToolRegistry, readFileTool, execTool } from "./tools.js";
import { toolCallBlock, textBlock } from "./messages.js";

const model = createMockModel([
  // 第1轮：让模型读一个文件（stopReason 用 toolUse 表示「还要调工具」）
  { content: [toolCallBlock("c1", "read_file", { path: "loop.js" })], stopReason: "toolUse" },
  // 第2轮：读完结果，模型说「好了，不用再调了」
  { content: [textBlock("已读到 loop.js，任务完成。")], stopReason: "stop" },
]);

const tools = createToolRegistry([readFileTool, execTool]);
const beforeToolCall = (call) => ({ action: "allow" }); // 第6章换成审批三档

const { newMessages } = await runAgentLoop({
  systemPrompt: "你是一个会读文件的助手。",
  messages: [],
  tools,
  model,
  beforeToolCall,
});

console.log("\n--- 本轮产生的消息 ---");
for (const m of newMessages) {
  if (m.role === "toolResult") {
    console.log(`[toolResult ${m.toolName}] ${m.content[0].text.slice(0, 50)}...`);
  }
}
