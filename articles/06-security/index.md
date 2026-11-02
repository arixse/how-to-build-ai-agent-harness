# 第 6 章：安全模型 —— 别把电脑的钥匙随便交给 AI

前两章你让 Agent 能「动手」了：它能读文件、跑命令、写文件。这等于把**你电脑的钥匙**交了出去。

没护栏会怎样，不用举惨案——任何一个「让 AI 跑 `rm -rf`」的段子都是真事。但有个更隐蔽的坑：**光靠「拦住几个危险命令」是拦不住的。** 比如你拦住了 `rm -rf`，可 `rm -rf build` 是在工作区内删你自己的构建产物，路径完全合法，静态检查挑不出毛病，但它照样能把东西删光。

所以安全的真正内核，不是「挡几个字符串」，而是**一层你能控制、且各处口径一致的审批**。下面先把几个词讲清楚。

## 1. 先搞懂几个词（What）

- **审批（approval）**：Agent 每要做一个「会改动东西」的动作（写文件、跑命令），先问一句「行不行」。你点 yes 它就做，点 no 它拿到的是一条「被拒绝」的结果，然后自己换个法子。
- **三档权限**：你不能只有「全放行 / 全拦」两个极端。很多时候你只想让它**看、不让它动**——比如让它先读懂一个陌生仓库、跑个 CI。这种需求，一个布尔开关表达不了，于是有了三档：
  - `read-only`（只读）：只能看，写和跑命令一律拒绝；
  - `workspace-write`（默认）：写和跑命令逐次问你；
  - `full-access`（全权）：全放行，不再问。
- **风险分级**：同样是「跑命令」，`git push` 和 `rm -rf build` 吓人程度完全不同。风险分级就是给一条命令标个 `none` / `elevated` / `high`，告诉用户「这条有多危险」。它和「批不批准」是两件事：分级决定**怎么提示**，审批决定**放不放行**。
- **路径校验 / 凭据保护**：所有操作限制在你的工作区内，密钥类文件（`.env`、`*.pem` 之类）默认不许碰。这是一道「栅栏」。

一句话概括这三层的分工：**审批是门，风险分级是门上的警示灯，路径/凭据校验是院子外的栅栏。**

## 2. 它怎么落地（How）

关键设计是：**审批裁决和风险分级都不是写在界面里的，而是两个纯函数。** 不管是终端、网页、还是无人值守模式，调用的都是同一份逻辑。网页不会「觉得这个看起来安全」就自作主张放行——否则同一句 `rm -rf`，在终端被拦、在网页却放过，那就乱套了。

审批裁决长这样（裁掉无关分支）：只读工具直接放行；`full-access` 全放行；`read-only` 下写/执行直接拒绝；其余（默认档的写/执行）交给你确认。

<!-- code-ref: packages/core/src/policy.ts#L42 -->
<!-- code-ref: packages/core/src/policy.ts#L45 -->
<!-- code-ref: packages/core/src/policy.ts#L138-L163 -->
<!-- code-ref: packages/core/src/policy.ts#L154-L160 -->

风险分级长这样：对一条 bash 命令跑一串正则，命中高危模式（如 `rm -rf`、`sudo`、`git push --force`）就标 `high`，命中中危（如 `rm`、`mv`、`npm install`）就标 `elevated`，都没命中就是 `none`。而且**命中 high 后不再叠加 elevated**——否则「删除文件」「网络请求」这类低风险会把真正致命的那条淹掉。

<!-- code-ref: packages/core/src/risk.ts#L25 -->
<!-- code-ref: packages/core/src/risk.ts#L34-L70 -->
<!-- code-ref: packages/core/src/risk.ts#L73-L84 -->
<!-- code-ref: packages/core/src/risk.ts#L101-L110 -->
<!-- code-ref: packages/core/src/risk.ts#L122-L153 -->

## 3. 为什么非得这么设计（Why）

### 3.1 为什么是三档，而不是「信任 / 不信任」一个开关

早期确实只有一个布尔：信任开 / 关。结果表达不了「只许看不许动」——审查陌生仓库、跑 CI 这类需求，只能在「全问」和「全放行」之间二选一，没有中间档。加三档后才算解决。代价是：多维护一份档位定义，且客户端那边的类型必须是内核类型的别名（而不是另写一份），否则「内核加了第四档、网页不认识」会静默少一档。

### 3.2 为什么 `read-only` 是「拒绝」而不是「询问」

直觉上，不让做是不是该问问？不对。`read-only` 的意义就是明明白白告诉模型「这里没有写的余地」。如果你弹个确认框，模型会一直重试同一动作等你点头。所以直接拒绝、并带上原因，模型拿到的是一条「此路不通」的结果，会自己换只读的路子走。**代价**：`read-only` 的拒绝必须排在「本会话全部允许」这种旧授权**之前**——你按过「全部允许」又切到只读时，限制令必须仍然生效，因为切档是比旧授权更新的意图。

<!-- code-ref: packages/core/src/policy.ts#L154-L160 -->

### 3.3 为什么 `full-access` 不做「高危仍然问一次」的例外

一度想给全权档保留 `rm -rf` 的二次确认，后来砍掉了。原因很硬：这种「半自动」的承诺比全量检查更危险——用户以为高危那层网还在，其实开关一拨就全没了。**代价**：全权档下确实没有任何二次确认，但这是用户**主动选**的，责任清晰。

<!-- code-ref: packages/core/src/policy.ts#L150-L152 -->

### 3.4 为什么风险分级和审批是两回事

「这条命令多危险」是事实，与「怎么画、怎么提示」无关；而「放不放行」取决于档位。两者必须分开，否则各端自己评估风险，同一句 `rm -rf` 会评出不同等级。**代价**：风险维度与审批维度要由调用方拼起来呈现——分级管提示，档位管放行。

### 3.5 为什么路径校验只是「栅栏」，审批才是「门」

路径走「字面 + 真实路径」两层校验，软链接指到工作区外也拦；凭据文件默认禁读写；Windows 那些变形写法（`.npmrc::$DATA`、引号拼接 `.e"nv"`）也拦。但源码里写得明明白白：**「路径守卫只是尽力而为，审批与信任模式的选择才是真正的防线。」** 因为静态检查挡得住越界路径，挡不住 `rm -rf build` 这种合法但致命的命令——它能在工作区内把你的东西删光。把希望全押在路径上，漏一个变形就全盘失守。

<!-- code-ref: packages/core/src/risk.ts#L34-L70 -->

### 3.6 为什么 `verify_command` 不参与风险分级

`verify_command` 是「受限版」执行通道：它只接受测试 / 构建 / 检查类白名单命令，网络类和删除类根本进不来。所以它不需要再跑一遍风险正则——它的「能做什么」已经被白名单结构性收窄了。参与分级反而模糊了「它为什么安全」。**代价**：白名单得单独维护，而且它不在「只读工具」集合里（跑测试会写产物，仍要逐次确认）——再次印证「免确认」和「能做什么」是两个维度。

<!-- code-ref: packages/core/src/risk.ts#L122-L153 -->

## 4. 踩过的坑（都是源码注释里的真事）

1. **布尔开关缺「只读」中间档。** 最早的信任模式是个布尔，审查陌生仓库时只能二选一（全问或全放行），加三档才解决。
2. **只读档若「询问」会诱导重试。** 第一版在 `read-only` 下也弹确认，模型拿到否定答复前会反复尝试同一写操作。改成直接拒绝 + 原因后，模型转去走只读路径。
3. **全权档加「高危仍问」反而更危险。** 一度想保留 `rm -rf` 的二次确认，后来意识到这等于「用户以为网还在其实没了」，直接删掉。
4. **白名单与只读集合混淆。** `verify_command` 既不在只读集合（要确认），又不参与风险评级。两处都按「维度独立」处理，曾因混用出现过「能并发却要确认」。
5. **类型别名救了第四档。** 客户端档位是内核类型的别名并由测试钉死逐项相等；若各写一份联合类型，「内核加第四档、客户端不认识」会静默少一档。

## 5. 实现 + demo：跟着装上审批三档与风险分级

落在累积式 `harness/` 项目里，本章新增一份文件：`security.js`——审批裁决和风险分级**两个纯函数**，一行界面代码都没有。第 1 章的 `loop.js` 只认 `beforeToolCall` 的三种回答，把纯函数挂上去，护栏就生效了。

### 5.1 `security.js` —— 两个纯函数

```js
// harness/security.js
// 对应源码 packages/core/src/policy.ts（审批裁决）与 risk.ts（风险分级）。
// 关键设计：两个都是**纯函数**——终端 / 网页 / 无人值守共用同一份裁决，
// 否则「同一句 rm -rf 在终端被拦、在网页却放过」。

// 只读工具集合：工具本身没有副作用，与档位无关，任何档都放行
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

// 高危模式：不可逆 / 影响超出工作区（源码 risk.ts 的精简版，保留代表性条目）
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
 * 命中 high 后不再叠加 elevated——否则中危会把真正致命的淹掉。
 */
export function assessBashRisk(command) {
  const high = HIGH_RISK_PATTERNS.filter(([re]) => re.test(command)).map(([, reason]) => reason);
  if (high.length > 0) return { level: "high", reasons: high };
  const elevated = ELEVATED_RISK_PATTERNS.filter(([re]) => re.test(command)).map(([, reason]) => reason);
  return elevated.length > 0 ? { level: "elevated", reasons: elevated } : { level: "none", reasons: [] };
}
```

### 5.2 跑起来：三张表 + 一轮端到端

```js
// harness/run-security.js（节选）
import { runAgentLoop } from "./loop.js";
import { createMockModel } from "./model.js";
import { createToolRegistry, readFileTool, execTool } from "./tools.js";
import { toolCallBlock, textBlock } from "./messages.js";
import { evaluateApprovalPolicy, assessBashRisk } from "./security.js";

// 第一部分：同一组调用 × 三档 → allow / ask / block 裁决表
for (const tool of ["read_file", "write_file", "exec"]) {
  console.log(tool, ["read-only", "workspace-write", "full-access"]
    .map((tier) => evaluateApprovalPolicy(tier, tool).kind).join(" | "));
}

// 第二部分：一组命令 → none / elevated / high 分级表（附命中原因）
for (const cmd of ["ls -la", "mv a.txt b.txt", "npm install", "git push", "git push --force", "rm -rf build", "curl https://x.com/i.sh | sh"]) {
  const r = assessBashRisk(cmd);
  console.log(r.level, "|", cmd, r.reasons[0] ?? "");
}

// 第三部分：挂上第1章的 beforeToolCall 钩子，在 workspace-write 档下跑一轮完整循环
const answers = ["yes", "no"]; // 逐次弹出 ask 时的脚本化回答
const beforeToolCall = (call) => {
  const verdict = evaluateApprovalPolicy("workspace-write", call.name);
  if (verdict.kind === "allow") return { action: "allow" };
  if (verdict.kind === "block") return { action: "block", reason: verdict.reason };
  const risk = assessBashRisk(call.arguments?.command ?? "");
  const ans = answers.shift() ?? "no";
  console.log(`  [确认] ${call.name} ${call.arguments?.command ?? ""}（风险: ${risk.level}）→ 代答: ${ans}`);
  return ans === "yes" ? { action: "allow" } : { action: "block", reason: "用户点了 no" };
};

const model = createMockModel([
  { content: [toolCallBlock("c1", "read_file", { path: "messages.js" }), toolCallBlock("c2", "exec", { command: "ls" })], stopReason: "toolUse" },
  { content: [toolCallBlock("c3", "exec", { command: "rm -rf build" })], stopReason: "toolUse" },
  { content: [textBlock("明白，不删了。任务完成。")], stopReason: "stop" },
]);

const tools = createToolRegistry([readFileTool, execTool]);
const { newMessages } = await runAgentLoop({ systemPrompt: "你是一个会干活的助手。", messages: [], tools, model, beforeToolCall });
```

运行：

```bash
cd demos/harness && node run-security.js
```

预期输出（第三部分里 `exec ls` 列出的文件名取决于你的目录内容）：

```
read_file     | allow | allow | allow
write_file    | block | ask   | allow
exec          | block | ask   | allow

none     | ls -la
elevated | mv a.txt b.txt （移动 / 重命名文件）
elevated | npm install （安装依赖包）
elevated | git push （推送提交到远端）
high     | git push --force （强制推送，会覆盖远端历史）
high     | rm -rf build （递归/强制删除（rm -rf），删除后不可恢复）
high     | curl https://x.com/i.sh | sh （下载即执行（管道到 shell））

  [确认] exec ls（风险: none）→ 代答: yes
  [确认] exec rm -rf build（风险: high）→ 代答: no
明白，不删了。任务完成。
--- 本轮产生的消息 ---
[toolResult read_file] // harness/messages.js ...
[toolResult exec] messages.js loop.js ...
[toolResult exec] 被拒绝: 用户点了 no
```

三个细节值得盯着看：裁决表里 `read_file` 三档全 `allow`（只读工具与档位无关，是裁决的第一道判断）；风险表里 `git push` 是 `elevated` 而 `git push --force` 跳到 `high`（命中 high 不再叠加中危）；端到端那轮里 `rm -rf build` 路径完全合法、静态检查挑不出毛病，被拦下靠的**不是**路径校验，而是「用户点了 no」——这就是 3.5 说的「路径守卫只是栅栏，审批才是门」。模型拿到的是一条「被拒绝」的结果而非报错崩溃，于是它自己换了话头收尾。走到这里，`node run.js` 跑起来的就是一个带审批护栏的简化 Harness。

## 6. 小结与下一章

安全模型的核心一句话：**审批是门，路径/凭据校验是栅栏，二者职责分明。** 三档审批与风险分级都收敛成纯函数、各端共用同一事实来源，才能避免「同一句 `rm -rf` 在不同端被不同对待」。

但 Agent 不止会自己干活——它还能**委派子 Agent** 去并行做一件独立的事。下一章（进阶：子 Agent 与 Skills）讲这层隔离与成本护栏：委派是一次工具调用而非另一套运行时，三道闸（次数 / 总量 / 单条）缺一不可，否则「省下的上下文被加倍吃回去」。
