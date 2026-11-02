// harness/security.js —— 第6章：审批三档 + 风险分级。
// 对应源码 packages/core/src/policy.ts（审批裁决）与 risk.ts（风险分级）。
// 关键设计：两个都是**纯函数**——不碰任何界面，终端 / 网页 / 无人值守共用同一份裁决，
// 否则「同一句 rm -rf 在终端被拦、在网页却放过」。

// 只读工具集合：工具本身没有副作用，与档位无关，任何档都放行（policy.ts 的第一道判断）
export const DEFAULT_READ_ONLY_TOOLS = new Set(["read_file", "grep", "glob"]);

/**
 * 审批裁决：输入「档位 + 工具名」，输出 allow / ask / block。
 * 顺序刻意固定：先判只读工具 → 再判档位。
 */
export function evaluateApprovalPolicy(mode, toolName, readOnlyTools = DEFAULT_READ_ONLY_TOOLS) {
  // 1) 只读工具：任何档都放行（它是「工具无副作用」，不是「这个档信任你」）
  if (readOnlyTools.has(toolName)) {
    return { kind: "allow", reason: "只读工具，免确认" };
  }
  // 2) 全权档：全放行，不做「高危仍问一次」的例外（3.3：半自动比全量检查更危险）
  if (mode === "full-access") {
    return { kind: "allow", reason: "全权模式，不再逐一确认" };
  }
  // 3) 只读档：直接拒绝、不是询问（3.2：询问会诱导模型反复重试同一写操作）
  if (mode === "read-only") {
    return { kind: "block", reason: `read-only 档位下不允许 ${toolName}：写与执行一律拒绝` };
  }
  // 4) 默认档（workspace-write）：写 / 执行逐次问
  return { kind: "ask", reason: "" };
}

// 高危模式：不可逆 / 影响超出工作区（源码 risk.ts 的精简版，保留了代表性条目）
const HIGH_RISK_PATTERNS = [
  [/\brm\b[^\n]*?\s-[a-z]*(?:r[a-z]*f|f[a-z]*r)\b/i, "递归/强制删除（rm -rf），删除后不可恢复"],
  [/\bsudo\b/, "提权执行（sudo），命令以 root 权限运行"],
  [/\bgit\s+push\b[^\n]*?(?:--force|-f\b)/, "强制推送，会覆盖远端历史"],
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z|fi|k)?sh\b/i, "下载即执行（管道到 shell）"],
  [/\bmkfs\b/, "格式化文件系统（mkfs）"],
];

// 中危模式：有副作用但通常可控
const ELEVATED_RISK_PATTERNS = [
  [/\brm\b/, "删除文件"],
  [/\bmv\b/, "移动 / 重命名文件"],
  [/\bgit\s+push\b/, "推送提交到远端"],
  [/\bnpm\s+(?:install|i)\b/, "安装依赖包"],
  [/\b(?:curl|wget)\b/, "发起网络请求"],
  [/\bchmod\b/, "修改文件权限"],
];

/**
 * 风险分级：给一条 bash 命令标 none / elevated / high，附命中原因。
 * 与档位无关（3.4：分级决定怎么提示，审批决定放不放行，两件事）。
 * 命中 high 后不再叠加 elevated——否则「删除文件」这类中危会把真正致命的淹掉。
 */
export function assessBashRisk(command) {
  const high = HIGH_RISK_PATTERNS.filter(([re]) => re.test(command)).map(([, reason]) => reason);
  if (high.length > 0) return { level: "high", reasons: high };
  const elevated = ELEVATED_RISK_PATTERNS.filter(([re]) => re.test(command)).map(([, reason]) => reason);
  return elevated.length > 0 ? { level: "elevated", reasons: elevated } : { level: "none", reasons: [] };
}
