// harness/context-window.js —— 第5章：上下文窗口的推断与解析
// 裁自 mini-pi packages/core/src/provider/context-window.ts。
// 窗口估大有真实代价：可能在压缩触发前就把请求发过窗口上限，被 API 直接拒绝（400）（第4章阈值的原料）。
// 策略：显式配置 > 按模型名推断（最长前缀） > 默认 128k 兜底；只登记有出处的模型，刻意保守。

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 已知模型的窗口表（demo 只登记有代表性的几条；完整表见源码 CONTEXT_WINDOW_RULES）。
 * 最长前缀优先：gpt-4o 要赢过 gpt-4，gpt-5.3-codex-spark 要赢过 gpt-5。
 */
export const CONTEXT_WINDOW_RULES = [
  { prefix: "gpt-6", window: 1_050_000, note: "GPT-6 全系（1.05M）" },
  { prefix: "gpt-5.3-codex-spark", window: 128_000, note: "GPT-5.3-Codex-Spark（128K）——落在 gpt-5 的 400K 上会超窗 400" },
  { prefix: "gpt-5", window: 400_000, note: "GPT-5 系列（400K）" },
  { prefix: "gpt-4.1", window: 1_000_000, note: "GPT-4.1（1M）" },
  { prefix: "gpt-4o", window: 128_000, note: "gpt-4o / gpt-4o-mini" },
  { prefix: "gpt-4", window: 8_192, note: "裸 gpt-4（8k，最容易踩坑的一个）" },
  { prefix: "deepseek", window: 1_000_000, note: "DeepSeek V4 起 1M" },
  { prefix: "mimo-7b", window: 32_768, note: "MiMo-7B（32K，小于 128k 必须登记）" },
];

/** 供应商专属覆盖：同一模型名经不同网关代销时窗口可能不同（对齐 PROVIDER_CONTEXT_WINDOW_OVERRIDES） */
export const PROVIDER_CONTEXT_WINDOW_OVERRIDES = [
  { provider: "bailian", prefix: "minimax-m3", window: 196_608, note: "百炼代销 MiniMax-M3（192K；原厂 1M）" },
];

/** 规范化：去空白、转小写、去掉 settings 里带的「供应商/」前缀 */
export function normalizeModelName(modelName) {
  const trimmed = String(modelName ?? "").trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

function longestPrefixMatch(name, rules) {
  let best = null;
  for (const rule of rules) {
    if (!name.startsWith(rule.prefix)) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best;
}

/** 先查供应商覆盖表，未命中再落全局表——provider 缺省时行为与只有全局表完全一致 */
export function matchContextWindowRule(modelName, providerName) {
  const name = normalizeModelName(modelName);
  if (!name) return null;
  const provider = String(providerName ?? "").trim().toLowerCase() || null;
  if (provider) {
    const override = longestPrefixMatch(
      name,
      PROVIDER_CONTEXT_WINDOW_OVERRIDES.filter((r) => r.provider === provider),
    );
    if (override) return override;
  }
  return longestPrefixMatch(name, CONTEXT_WINDOW_RULES);
}

/**
 * 解析最终生效的窗口：显式配置 > 按模型名推断 > 默认 128k。纯函数（对齐 resolveContextWindow）。
 * 认不出模型名宁可落到 128k（提前压缩），也不要硬给一个大值（发过窗口上限直接 400）。
 */
export function resolveContextWindow({ configured, modelName, providerName } = {}) {
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return { window: Math.floor(configured), source: "configured" };
  }
  const rule = matchContextWindowRule(modelName, providerName);
  return rule
    ? { window: rule.window, source: "inferred" }
    : { window: DEFAULT_CONTEXT_WINDOW, source: "default" };
}
