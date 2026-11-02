// harness/security.js —— 第6章：审批三档 + 风险分级。
// 对应源码 policy.ts（审批裁决）与 risk.ts（风险分级）。
// 关键设计：两个都是**纯函数**——不碰任何界面，终端 / 网页 / 无人值守共用同一份裁决，
// 否则「同一句 rm -rf 在终端被拦、在网页却放过」。
import { READ_ONLY_TOOL_NAMES } from "./tools.js";

// 只读名单不新起一份，直接用第2章那一份（决定一）：
// 注册表认为「免确认」和审批认为「免确认」必须同源，否则新增只读工具时必然漏一处。
export const READ_ONLY_TOOLS = new Set(READ_ONLY_TOOL_NAMES);

/**
 * 审批裁决：输入「档位 + 工具名」，输出 allow / ask / block。
 * 顺序刻意固定：先判只读工具 → 再判档位（决定一 / 决定二 / 决定三）。
 */
export function evaluateApprovalPolicy(mode, toolName, readOnlyTools = READ_ONLY_TOOLS) {
  // 1) 只读工具：任何档都放行（它是「工具本身没副作用」，不是「这个档信任你」）
  if (readOnlyTools.has(toolName)) {
    return { kind: "allow", reason: "只读工具，免确认" };
  }
  // 2) 全权档：全放行，不做「高危仍问一次」的例外（决定二：半自动比全量检查更危险）
  if (mode === "full-access") {
    return { kind: "allow", reason: "全权模式，不再逐一确认" };
  }
  // 3) 只读档：直接拒绝、不是询问（决定三：询问等于告诉模型「可能可以」）
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
 * 与档位无关（决定四：分级决定怎么提示，审批决定放不放行，两件事）。
 * 命中 high 后不再叠加 elevated——否则「删除文件」这类中危会把真正致命的淹掉。
 */
export function assessBashRisk(command) {
  const high = HIGH_RISK_PATTERNS.filter(([re]) => re.test(command)).map(([, reason]) => reason);
  if (high.length > 0) return { level: "high", reasons: high };
  const elevated = ELEVATED_RISK_PATTERNS.filter(([re]) => re.test(command)).map(([, reason]) => reason);
  return elevated.length > 0 ? { level: "elevated", reasons: elevated } : { level: "none", reasons: [] };
}
