// harness/subagent.js —— 第7章：子 Agent 运行时（委派 = 一次工具调用）
// 裁自 mini-pi packages/core/src/agent/subagent.ts（简化：不含用量统计与 outcome 裁决）。
// 三条边界：上下文隔离（子只有一条 user 消息）、权限派生（子工具集是父的子集）、取消级联（链接父信号）。

import { runAgentLoop } from "./loop.js";
import { createToolRegistry } from "./tools.js";
import { textBlock } from "./messages.js";

// 常量对齐 subagent.ts；demo 为便于观察缩小轮次，注释注明真实值
export const MAX_SUBAGENT_DEPTH = 1;               // 达到该深度的 Agent 拿不到 task 工具：递归被结构性阻断
export const DEFAULT_SUBAGENT_MAX_TURNS = 30;      // 比主 Agent 的 100 小得多：它只被派去做一件事
export const SUBAGENT_RESULT_MAX_CHARS = 8_000;    // 单条结论上限：与 bash/read_file 同口径，写明截断
export const MAX_TURN_RESULT_CHARS = 24_000;       // 回合回传总量上限：单条上限挡不住总量，必须单独设闸
export const SUBAGENT_TOOL_NAME = "task";

/** 结论截断：要么完整返回，要么明确告知被截断以及如何收窄——静默截断会让父拿着残缺结论继续推理而不自知 */
export function capSubAgentResult(text, { limit = SUBAGENT_RESULT_MAX_CHARS, budgetExhausted = false } = {}) {
  if (text.length <= limit) return { summary: text, truncated: false };
  const hint = budgetExhausted
    ? "本回合回传总量已到上限，请把目标拆成更小的几次委派，或改用文件交接。"
    : "请让子 Agent 输出更聚焦的结论，或把完整结果写入文件后回传路径。";
  return {
    summary:
      `${text.slice(0, limit)}\n` +
      `...[已截断：结论共 ${text.length} 字符，仅返回前 ${limit} 字符。${hint}]`,
    truncated: true,
  };
}

/** 子 Agent 的 system prompt：必须写明「你看不到父历史」「只有最后输出的文本会被带走」 */
export function buildSubAgentSystemPrompt({ workspaceRoot = process.cwd(), canWrite = true, instructions } = {}) {
  const parts = [
    `你是一个被委派的子任务执行 Agent，工作目录：${workspaceRoot}。`,
    "你**看不到**调用方的对话历史，只有本次委派给出的目标与素材。",
    "调用方只会收到你最后输出的这段文本：中间的读取、搜索与分析过程一概丢弃，",
    "因此请把结论完整写在最终回复里，并带上必要的文件路径与关键符号。",
  ];
  if (!canWrite) parts.push("", "本次委派**没有写权限**：只能读取与分析，需要修改时请在结论里写清改哪里、怎么改。");
  if (instructions) parts.push("", instructions);
  return parts.join("\n");
}

/** 目标与显式素材组装成子的唯一一条 user 消息——不要图省事把父历史整段传进来 */
export function buildSubAgentUserMessage({ goal, context = [] }) {
  const lines = [`目标：${goal}`];
  const entries = context.filter((c) => typeof c === "string" && c.trim().length > 0);
  if (entries.length > 0) lines.push("", "以下是调用方提供的素材：", ...entries.map((c) => `- ${c}`));
  return textBlock(lines.join("\n"));
}

/** 回合级预算闸：单条 8k 挡不住「8 次 × 8k = 64k 灌回主上下文」，总量必须单独设闸 */
export function createSupervisor({ maxDelegations = 8, maxResultChars = MAX_TURN_RESULT_CHARS } = {}) {
  let delegations = 0;
  let resultCharsUsed = 0;
  return {
    get stats() { return { delegations, resultCharsUsed }; },
    get resultBudgetExhausted() { return resultCharsUsed >= maxResultChars; },
    // 拿不到名额返回**带原因的失败**而不是静默放行：模型知道「委派没发生」，才不会干等一个永不到来的结论
    acquire() {
      if (delegations >= maxDelegations) return { ok: false, reason: "budget_exhausted" };
      delegations += 1;
      return { ok: true };
    },
    recordResultChars(chars) { if (Number.isFinite(chars) && chars > 0) resultCharsUsed += Math.floor(chars); },
  };
}

/**
 * task 工具：委派被建模成一次工具调用——子 Agent 不需要第二套循环，
 * 它就是一次新的 runAgentLoop，只是换了 system prompt / messages / 工具集 / 轮次上限。
 * 主循环的全部护栏（按序归位 / 钩子 / 取消补占位）因此免费继承。
 *
 * @param baseDefs 父工具定义数组（可运行版本）；子工具集从中派生
 * @param model 模型 seam
 * @param options.supervisor 回合预算闸
 * @param options.maxTurns 子轮次上限（真实值 30；demo 缩小）
 */
export function createTaskTool(baseDefs, model, { supervisor, maxTurns = DEFAULT_SUBAGENT_MAX_TURNS, workspaceRoot, resultLimit = SUBAGENT_RESULT_MAX_CHARS } = {}) {
  return {
    name: SUBAGENT_TOOL_NAME,
    description: "把一个自包含的子任务委派给子 Agent；它只带回最终结论",
    concurrent: false, // 会跑完整循环，串行
    run: async ({ goal, context = [] }, signal) => {
      const acquire = supervisor?.acquire() ?? { ok: true };
      if (!acquire.ok) {
        return { text: `委派未发生（${acquire.reason}）：预算已用完，请把目标拆成更小的几次委派。`, isError: true };
      }

      // 权限派生 + 结构性阻断：深度到达上限的子工具集里**没有** task——递归不是被拦下，而是根本不存在
      const subDefs = baseDefs.filter((d) => d.name !== SUBAGENT_TOOL_NAME);
      const subTools = createToolRegistry(subDefs);

      const { newMessages } = await runAgentLoop({
        systemPrompt: buildSubAgentSystemPrompt({ workspaceRoot }),
        messages: [buildSubAgentUserMessage({ goal, context })],
        tools: subTools,
        model,
        maxTurns,
        signal,
      });

      // 父只收最后的结论文本；中间过程一概丢弃
      let finalText = "";
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const m = newMessages[i];
        if (m.role === "assistant") {
          finalText = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
          break;
        }
      }
      const capped = capSubAgentResult(finalText, { limit: resultLimit, budgetExhausted: supervisor?.resultBudgetExhausted ?? false });
      supervisor?.recordResultChars(capped.summary.length);
      return { text: capped.summary, isError: false };
    },
  };
}
