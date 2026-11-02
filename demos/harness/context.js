// harness/context.js —— 第4章：token 估算与压缩阈值（唯一口径）
// 常量对齐 mini-pi packages/core/src/context.ts：
//   CONTEXT_BUDGET_RATIO=0.6 / MIN_CONTEXT_BUDGET=8_000 / KEEP_RECENT_MESSAGES=10
//   DEFAULT_CONTEXT_WINDOW=128_000（provider/context-window.ts）；demo 用小窗口便于触发，注释里写明真实值

import { toolResultBlock } from "./messages.js";

/** 按字符类别计价：ASCII 约 4 字符 1 token，CJK/全角约 1 字符 1 token（对齐 sessionStore.ts estimateTextTokens） */
export function estimateTextTokens(text) {
  let ascii = 0;
  let wide = 0;
  for (const char of String(text)) {
    if ((char.codePointAt(0) ?? 0) < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4 + wide);
}

/**
 * 估算一条消息的 token。toolCall 的参数必须计入——参数会原样发给模型，
 * 漏算的后果不是「略有偏差」而是「恒为 0」（源码注释里的真实事故：
 * 一条带 20 万字符参数的消息估成 0 token，上下文早爆了压缩却永不触发）。
 */
export function estimateMessageTokens(message) {
  let tokens = 0;
  for (const block of message.content ?? []) {
    if (block.type === "text") tokens += estimateTextTokens(block.text);
    if (block.type === "toolCall") {
      tokens += estimateTextTokens(block.name);
      tokens += estimateTextTokens(JSON.stringify(block.arguments ?? {}));
    }
  }
  return tokens;
}

export function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

export const CONTEXT_BUDGET_RATIO = 0.6; // 给输出与工具结果留余量
export const MIN_CONTEXT_BUDGET = 8_000; // 窗口配得过小时不要退化成「每轮都压缩」
export const KEEP_RECENT_MESSAGES = 10;
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 按模型窗口推导压缩阈值；窗口配大有真实代价（小窗口模型会先被 API 400） */
export function resolveContextBudget(contextWindow) {
  const window =
    Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  return Math.max(MIN_CONTEXT_BUDGET, Math.floor(window * CONTEXT_BUDGET_RATIO));
}

/**
 * 压缩窗口起点必须对齐：第一条不能是 toolResult，否则它对应的 assistant toolCall
 * 被摘要吞掉，留下的孤儿 toolResult 直接被 API 400（对齐 sessionStore.ts alignCompactionStart）。
 * 返回 0 表示整段都要保留（调用方应放弃本次压缩）。
 */
export function alignCompactionStart(roles, keepRecentMessages) {
  const keepRecent = Math.max(1, Math.floor(keepRecentMessages) || 1);
  let start = Math.max(0, roles.length - keepRecent);
  while (start > 0 && roles[start] === "toolResult") start -= 1;
  return start;
}
