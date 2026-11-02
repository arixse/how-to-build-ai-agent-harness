// harness/loop.js
// 逐条对照第 2 节的五个决定：
// 轮次上限 MAX_TURNS=100（决定一）、结果按原下标归位（决定二）、
// 只读并发/写串行 + 上限 8（决定三）、beforeToolCall 钩子（决定四）、
// 取消时给没跑完的 toolCall 补占位（决定五）。
import { toolResultBlock } from "./messages.js";

export const MAX_TURNS = 100;                // 默认轮次护栏（决定一）
export const MAX_CONCURRENT_TOOL_CALLS = 8;  // 只读批次并发上限（决定三）

async function executeToolCall(toolCall, registry, signal) {
  return registry.execute(toolCall, signal);
}

export async function runAgentLoop({
  systemPrompt,
  messages,
  tools,        // 工具注册表
  model,        // 第1章是 mock，第3章包上可靠性壳（接口不变）
  maxTurns = MAX_TURNS,
  beforeToolCall,
  signal,
  // 第9章升级：内核不打印、不着色——onDelta 由调用方注入（终端画字，服务端发事件）；
  // 默认仍是写终端，保证第 1 章的用法不变
  onDelta = (text) => process.stdout.write(text),
  // 每轮结束钩子：落盘与压缩由调用方决定（内核不知道「会话文件」长什么样）；
  // 返回新上下文时循环用它替换内部上下文——压缩后必须让模型立刻看到摘要
  onTurnEnd,
}) {
  const context = [...messages];
  const newMessages = [];
  const ac = signal ?? new AbortController().signal;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // 1) 问模型（流式：onDelta 实时吐字；已上屏的字绝不重来 —— 见第3章）
    const assistant = await model.complete({
      systemPrompt,
      messages: context,
      tools: [], // 第3章换成真实模型时，这里传工具 schema
      signal: ac,
      onDelta,
    });
    context.push(assistant);
    newMessages.push(assistant);

    // 2) 异常 / 取消 / 不再要工具 → 收尾
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error") break;
    if (ac.aborted) break;
    const toolCalls = assistant.content.filter((b) => b.type === "toolCall");
    if (toolCalls.length === 0) break;

    // 3) 执行一批工具调用，结果按原始下标归位（决定二）
    const slots = new Array(toolCalls.length);
    let cursor = 0;
    while (cursor < toolCalls.length) {
      if (ac.aborted) break;
      const concurrent = tools.canRunConcurrently(toolCalls[cursor]);
      const batch = [];
      if (concurrent) {
        // 收集连续的可并发调用，凑一批（上限 8）一起跑（决定三）
        while (
          cursor + batch.length < toolCalls.length &&
          tools.canRunConcurrently(toolCalls[cursor + batch.length]) &&
          batch.length < MAX_CONCURRENT_TOOL_CALLS
        ) {
          batch.push(cursor + batch.length);
        }
      } else {
        batch.push(cursor); // 写操作：一次一个，串行
      }

      // 先问钩子（放行 / 拒绝 / 改写），再执行（决定四）
      await Promise.all(
        batch.map(async (index) => {
          const call = toolCalls[index];
          const decision = beforeToolCall ? await beforeToolCall(call) : { action: "allow" };
          if (decision.action === "block") {
            slots[index] = toolResultBlock(call.id, call.name, `被拒绝: ${decision.reason ?? ""}`, true);
            return;
          }
          const exec = decision.action === "rewrite" ? { ...call, arguments: decision.args } : call;
          slots[index] = await executeToolCall(exec, tools, ac);
        }),
      );
      // 把这一批结果按原下标归档：context 供下一轮回灌，newMessages 供落盘
      for (const index of batch) {
        context.push(slots[index]);
        newMessages.push(slots[index]);
      }
      cursor += batch.length;
    }

    // 4) 取消落在一半：给没结果的 toolCall 补占位，否则落盘是非法序列（决定五）
    toolCalls.forEach((tc, i) => {
      if (slots[i] === undefined) {
        const msg = ac.aborted ? "本轮已取消，该工具未执行" : "该工具未执行";
        slots[i] = toolResultBlock(tc.id, tc.name, msg, true);
        context.push(slots[i]);
        newMessages.push(slots[i]);
      }
    });

    if (ac.aborted) break;

    // 5) 回合钩子（第9章）：落盘 / 压缩在这里发生；返回新上下文则立即替换
    if (onTurnEnd) {
      const next = await onTurnEnd([...context]);
      if (next) {
        context.length = 0;
        context.push(...next);
      }
    }
  }

  return { newMessages };
}
