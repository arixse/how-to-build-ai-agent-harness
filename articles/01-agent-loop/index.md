# 第 1 章：最小可用 Agent Loop —— 让 AI 真正「动手」的那层循环

先讲个场景。你让 AI 帮你改个 bug：「帮我看看 `main.ts` 里超时写成了多少。」

如果只是一个普通的聊天程序，AI 会回你一句「建议你打开文件看看」，然后就没了。它不会真去读那个文件，也不会根据你看到的内容继续往下干。

这一章要解决的，就是怎么让 AI 从「答一句」变成「干到底」。这个东西行话叫 **Agent Loop（智能体循环）**。在动手写代码之前，咱们先把几个词掰扯清楚——否则后面全是黑话，看着头疼。

## 1. 先搞懂三个词（What）

### 1.1 Agent 是什么

普通 AI（比如你平时聊天的那种）只会「说」。你问，它答，完事。

**Agent 是「会说 + 会动手」的 AI。** 除了聊天，它还能调用工具：读文件、搜代码、跑命令、写文件。你可以把它理解成：一个顾问，外加一双能直接操作你电脑的手。本章要搭的，就是这只「手」能稳定干活所需的骨架。

### 1.2 Loop 是什么

Agent 干活不是一步到位的。它是**反复**做一件事：问模型 → 模型可能要调工具 → 把工具结果喂回去 → 再问模型 → ……直到模型说「好了，不用再调了」。

这个「反复」的过程，就是一个循环（Loop）。你可以类比带新人干活：你交代一句，他做一步回来汇报，你再指示，周而复始，直到事办完。循环就是这套「汇报—指示」的自动化。

### 1.3 工具调用 和 流式输出 是什么

- **工具调用（tool call）**：模型在回复里不光说人话，还能夹一段「结构化指令」，比如「请读 `main.ts`」。程序看到这条指令，就去执行对应的工具，把结果交回去。注意：模型说的每一句「我要调工具」，都必须配一个「工具结果」，一一对应——这点后面要命地重要。
- **流式输出（streaming）**：模型不是憋半天一次性吐整段，而是**一个字一个字蹦出来**，像打字机。好处是用户不用干等。但有个隐患：字一旦蹦出来，就已经「发出去了」，后面如果出岔子，这些字不能假装没发过——这点给下一章埋个伏笔。

把这三个词串起来：**Agent 在一个 Loop 里，用流式输出和用户对话，期间靠工具调用去动手，再把结果喂回对话。** 这就是本章要落地的东西。

## 2. 它到底怎么转起来的（How）

把源码里无关的分支裁掉，主循环的核心逻辑就一句人话能说清：

> **反复「问模型 → 它要么说话、要么叫工具 → 工具结果按原顺序塞回历史 → 再问」，直到它不再叫工具为止。**

<!-- code-ref: packages/core/src/agent/loop.ts#L280-L294 -->
<!-- code-ref: packages/core/src/agent/loop.ts#L338-L380 -->

一轮内部的数据流向，画成图是这样的——**图里每个标了「决定 N」的区块，就是下面 2.2 ~ 2.6 要展开的设计决策**（看不懂图，先跳过看下面那句人话）：

```mermaid
flowchart TD
    START(["开始：你输入 / 历史消息"]) --> TURN

    subgraph D1["决定一：以「轮」为单位（默认最多 100 轮）"]
        TURN{{"第 turn 轮, 上限 100"}}
        TURN -->|跑满 100 轮| HALT([强行收尾 max_turns_exceeded])
    end
    TURN -->|还有额度| ASK

    ASK[问模型 + 流式吐字 onDelta] --> DONE{要调工具吗?}
    DONE -->|不调了| SAVE
    DONE -->|要调| ABORT1{取消信号已触发?}
    ABORT1 -->|是| CLEANUP
    ABORT1 -->|否| GATHER

    subgraph D3["决定三：只读并发跑 / 写操作串行"]
        GATHER["收集一批：连续可并发→凑批(上限8)<br/>遇写操作→先结算前一批"]
    end
    GATHER --> HOOK

    subgraph D4["决定四：beforeToolCall 钩子"]
        HOOK["逐个问钩子"]
    end
    HOOK -->|放行 / 改写| EXEC
    HOOK -->|拒绝| REJ[记一条拒绝对结果, 不崩]
    REJ --> SLOT
    EXEC["执行工具: 读文件/跑命令..."] --> SLOT

    subgraph D2["决定二：结果按原顺序归位"]
        SLOT["slots[index] 按原下标写回<br/>绝不按完成序"]
    end
    SLOT --> ABORT2{取消信号已触发?}
    ABORT2 -->|是| CLEANUP
    ABORT2 -->|否| MORE{本批还有调用?}
    MORE -->|有| GATHER
    MORE -->|本批完| BACK[结果塞回历史 context]
    BACK --> TURN

    subgraph D5["决定五：取消 / 空回复 → 收成合法状态"]
        CLEANUP["未跑完的 toolCall 补占位<br/>空回复→丢空壳"]
    end
    CLEANUP --> SAVE

    SAVE["结束前存档：失败则记补档点"] --> END([结束])
```

> **人话版**：每进一轮先数「这是第几轮、超 100 没」（决定一）；模型吐完字，要调工具就先问钩子（决定四），再把一批调用按「只读并发、写串行」跑掉（决定三），结果按下标塞回历史（决定二）；中途取消就给没跑的调用补占位（决定五），模型不调工具了就存档退出。下面 2.2 ~ 2.6 把每个「决定 N」单独掰开讲代价和真实事故，第 3 节代码就是照这张图一行行落地的。

每一轮结束，循环还会顺手做两件事：把这一轮**存一次档**，顺便看看上下文是不是太长了要压缩。存档要是失败也不打断本轮，但会记着「从这儿重新补」，免得漏一条或重复一条。

<!-- code-ref: packages/core/src/agent/loop.ts#L311-L336 -->

下面把这台循环机的设计取舍一次讲透——先看「不这么设计会出什么乱子」，再逐条给决定、代价和真实踩坑。How 和 Why 放在一起，是因为每个设计选择的理由本来就和它「怎么转」分不开；这些决定会被第 3 节（实现）的代码逐行落实，看代码时一眼就能对上。

### 2.1 不这么设计的下场

- **工具的结果回不去。** 模型说「我要读 `main.ts`」，你真读了、算出了内容。可下一轮你如果只把「用户最新一句话」发给模型，历史里根本没有「调用工具 → 拿到结果」这一步。模型会反复要求读同一个文件，直到对话塞爆。
- **多轮要么跑不满，要么停不下来。** 没有「轮」的概念，要么一次请求完就退出（复杂任务做不完），要么无限循环（模型一直调工具，永远不说「好了」）。
- **中途取消会弄坏存档。** 你按 Ctrl+C 不想让它跑了，它却已经在这一轮里说出了「我要读文件」，但磁盘记录里只有这一句、没有「读到了什么」。下次打开，程序一看记录残缺，直接报错把这局对话整废。

### 2.2 决定一：循环以「轮」为单位，默认最多 100 轮

每一轮 = 问一次模型 + 可能跑几次工具 + 把结果喂回去。跑满 100 轮还没完，就强行收尾。

**代价**：`maxTurns` 默认 100，它不是一个「日常会用到」的配额，而是一道兜底护栏——源码里一旦撞到上限会直接停并发出 `max_turns_exceeded` 提示（见下方 code-ref），可见它的本职是拦住失控的无限循环，而非正常任务的预期用量。正常任务靠模型主动说「停」来结束（循环逻辑：模型不再叫工具就退出），根本不会去碰这个上限。真有任务需要超过 100 轮才做完，该去优化任务拆解，而不是把数字调大——否则只是把「失控循环能跑多久」的上限往后挪，问题还在。

**深入一点**：注意「轮」数的是**模型往返次数**，不是工具调用次数——一个模型回复里可能夹着好几个工具调用，它们算同一轮。所以护栏数字要留足余量：太小会掐断那些本身就需要多步检索、推理、试错的合法长任务；太大又只是给失控循环多留了跑路空间。100 是在「不轻易误伤长任务」和「失控时一定兜得住」之间取的默认折中，特殊场景再按任务单独调，而不是无脑调大。另外，如果空回复被当成「正常结束」（见决定五），循环可能在「什么都没做」的情况下提前退出，这就是护栏另一面——既要防「停不下来」，也要防「跑不满」。

<!-- code-ref: packages/core/src/agent/loop.ts#L34-L59 -->

### 2.3 决定二：工具结果必须按原顺序归位，且每个调用都得有结果

模型是按位置来配对「我刚才叫了什么」和「得到了什么」的。所以不管工具是并发跑还是挨个跑，最后都得按原本的下标放回原位。

**代价**：并发跑完还得「乱序执行、顺序落盘」，多一层下标管理。换来一个铁的好处——存盘的记录永远合法，绝不出「叫了工具却没结果」这种让程序崩溃的残缺。

**踩坑实录（源码注释里的真实事故）**：只读工具是并发跑的，谁先跑完谁后跑完全看系统调度。如果边 `await` 边把结果 `push` 进历史，落盘顺序就是「完成序」而非「调用序」。而模型是靠**位置**配对的——顺序错一位，它就把 A 工具的结果当成 B 工具的，后面全错乱，记录也变非法。修法正是 3.4 节那段：用 `slots[index]` 先按原下标收着，整批跑完再按下标写回 `context`/`newMessages`，**绝不按完成顺序**。这就是「乱序执行、顺序落盘」那层下标管理的由来——也是它最容易被漏写的地方。

<!-- code-ref: packages/core/src/agent/loop.ts#L344-L345 -->

<!-- code-ref: packages/core/src/agent/loop.ts#L447-L479 -->

### 2.4 决定三：只读工具一起跑，会改东西的逐个来

模型常一口气叫好几个「读文件」类的操作。这些只读调用如果排队挨个跑，纯属浪费时间，干脆凑一批并发跑（上限 8 个）。但「写文件」「执行命令」这种会改变状态的，必须一个一个来，不然两个写操作同时落盘，谁生效全看运气。

**代价与踩坑实录**：批次收集逻辑要「连续同类型才凑批」——遇到一个写操作得先结算前面那一批，稍繁。为什么上限是 8 而不是无限？并发开太多会打爆上游、占满文件句柄，而且整批要等最慢那个（木桶效应），开太多反而更慢，8 是压过的经验值。

**更深的一坑：「只读」和「能不能并发」是两件独立的事，曾经被当成一回事。** 只读是*语义*属性（不改状态），可并发是*调度*属性（能同时跑）。源码特意点名：二者混在一起时，出过「能并发却还要先确认」（本可一把梭，却被确认步骤拖成串行），也出过「免确认却不该并发」（本该串行，却因标错被并发了）。所以真实实现会分别声明「语义只读」与「调度可并发」。（简化版里我们把这两件事合用一个 `concurrent` 开关表达——`read_file` 标 `true`、写类标 `false`；这是有意为之的简化，真实系统要把它们拆开才踩不到这个坑。）

<!-- code-ref: packages/core/src/agent/toolDispatch.ts#L30-L40 -->

<!-- code-ref: packages/core/src/agent/loop.ts#L482-L504 -->

<!-- code-ref: packages/core/src/agent/loop.ts#L435-L445 -->

### 2.5 决定四：「要不要执行这个工具」交给钩子，不写死在循环里

循环每要执行一个工具前，先问一个叫 `beforeToolCall` 的钩子：「放行？拒绝？还是改下参数再放行？」循环只认这三种回答，不关心「为什么」。

**代价**：这个钩子自己得健壮，它一旦抛错就按「拒绝」处理——宁可错杀，不可放过。但换来的好处是「安不安全」以后怎么变都好扩展（比如后来加的审批三档），而且 CLI、网页、无人值守模式全从同一个口子收口。

**深入一点**：为什么是「钩子函数」而不是「配置项（比如一个 allowlist）」？因为安全决策常常需要**异步和上下文**——查数据库里的权限表、弹窗问人、调远程策略服务——配置项表达不了。三态（allow / block / rewrite）也是刻意最小：`allow` 直接跑；`block` 记一条拒绝对结果（不让循环崩）；`rewrite` 把参数改了再跑（比如把绝对路径收敛进沙箱目录）。正因为循环只认这三态，第 6 章的「审批三档」才能直接挂在同一个 `beforeToolCall` 上，CLI、网页、无人值守三种模式也共用这一个收口点——**循环本体一行都不用懂「安全」**。

<!-- code-ref: packages/core/src/agent/loop.ts#L61-L67 -->

### 2.6 决定五：取消和「模型回空话」都要收成合法状态，绝不留半成品

取消可能落在两个时刻：模型刚说「我要调工具」时，或一批工具正跑到一半时。无论哪种，循环收尾时都会给**所有还没结果的工具调用补一个占位结果**（就是你刚写的 3.4 节第 4 步）。另外，模型偶尔会返回「什么都不说」的空回复，这种不能直接塞进历史，否则你看到的就是「敲了回车什么都没发生」。

**代价**：多写两道收尾处理（补占位 + 丢空壳）。但换来存档永远能被重新打开——回到 2.1 那个坑：缺结果的记录落盘就是残缺，重新打开直接报废。

**踩坑实录（这三桩都来自源码注释里的真实事故，本质同一件事）**：源码注释里这三桩事故，看着是三件不同的事，其实都破坏同一条不变量——**「历史里任何一条 assistant / toolCall 都必须是完整且自洽的」**。

- **#1 缺结果 = 存档报废。** 取消落在一批工具跑到一半，没跑完的调用若不补占位，存盘就成了「叫了工具却没结果」的残缺记录，重新打开直接被 API 拒绝。修法就是 3.4 节第 4 步：遍历 `toolCalls`，凡是 `slots[i]` 还是 `undefined` 的，一律补一个占位 `toolResult`（取消时文案写「本轮已取消，该工具未执行」，普通异常写「该工具未执行」）。
- **#2 把取消当成了模型说的话。** 旧版本曾把取消时的报错（`This operation was aborted`）当成模型回复写进历史。结果你取消一次，记录里就多一条「模型说它被中止了」，无人值守模式还把它当失败上报。修法：取消就是取消——正文留空，落盘时把这个空壳直接丢掉，绝不污染历史。
- **#4 空回复静默混进历史。** 上游偶尔返回空流，旧逻辑为不打断流式，把「无内容」记成正常结束。必须显式转成一条错误回复，否则用户看到的是「回车没反应」，还以为程序挂了。

把这三件事并在一起看就清楚了：取消、空回复、中断，只是「不变量被破坏」的不同入口。所以 3.4 节才在每轮结束前统一做一遍「补齐残缺 / 丢弃空壳」的清理——`model.js` 里 `signal?.aborted` 直接收尾、循环里给没结果的下标补占位，都来自这一条。这是 demo 最容易漏、真实环境最坑人的一环，也是本章最该先焊死的护栏。

<!-- code-ref: packages/core/src/agent/loop.ts#L78-L97 -->
<!-- code-ref: packages/core/src/agent/loop.ts#L105-L128 -->
<!-- code-ref: packages/core/src/agent/loop.ts#L151-L157 -->
<!-- code-ref: packages/core/src/agent/loop.ts#L239-L248 -->

## 3. 实现：跟着写一个最小 Loop

前面讲的都是概念。下面用**零依赖的 Node ESM**（不需要 `npm install`，`node xxx.js` 就能跑）写一个能跑的最小 Loop。它先跑通「问模型 → 流式吐字 → 工具结果回灌 → 多轮终止 → 取消安全」这条主线；模型层先用 mock 顶上，第 3 章（系列）再换成真实流式 + 看门狗 + 重试，而且**换的时候 loop 一行都不用改**——这正是「模型层是独立 seam」这个设计的好处，具体已在 3.2 与 3.4 落地。

### 3.0 落点：一套累积式代码

本系列是**累积式**的：后续每一章往同一个 `harness/` 目录里加一个文件，代码从简到全，走到第 6 章跑起来就是一个带审批护栏的简化 Harness。本章你写出这四个文件：

```
harness/
├── messages.js   # 消息与内容块的形状（assistant / toolCall / toolResult）
├── model.js      # callModel 接口（本章用 mock，第3章换真实实现）
├── tools.js      # 工具注册表 + 两个最小工具（read_file / exec）
└── loop.js       # 本章核心：runAgentLoop
```

### 3.1 `messages.js` —— 先定消息形状

协议里有个铁律，后面所有代码都绕着它转：**assistant 消息里的每个 toolCall，都必须有顺序一致的 toolResult 对应**。先把这几个块的形状钉死：

```js
// harness/messages.js
// 协议铁律：assistant 里的每个 toolCall，都必须有顺序一致的 toolResult 对应。

export const textBlock = (text) => ({ type: "text", text });

export const toolCallBlock = (id, name, args) => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

export const toolResultBlock = (toolCallId, toolName, text, isError = false) => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [textBlock(text)],
  isError,
  timestamp: Date.now(),
});
```

### 3.2 `model.js` —— 模型层的 seam

关键设计：**循环只认一个 `complete()` 接口**，不关心里面是 mock 还是真实 API。这样第 3 章把里面换成真实流式 + 看门狗 + 重试时，`loop.js` 完全不动。

```js
// harness/model.js  —— 第1章用 mock；第3章换成「真实流式 + 看门狗 + 重试」
// 关键 seam：complete({ systemPrompt, messages, tools, signal, onDelta })
import { textBlock } from "./messages.js";

export function createMockModel(scriptedTurns) {
  let i = 0;
  return {
    async complete({ signal, onDelta } = {}) {
      // 取消信号一上来就直接收尾，绝不假装成功
      if (signal?.aborted) {
        return { role: "assistant", content: [], stopReason: "aborted" };
      }
      const turn =
        scriptedTurns[i++] ?? 
        { content: [textBlock("我做完了，没有要调的工具。")], stopReason: "stop" };
      // 模拟流式：一个字一个字往外吐（真实实现见第3章）
      if (onDelta) for (const b of turn.content) if (b.type === "text") onDelta(b.text);
      return { role: "assistant", content: turn.content, stopReason: turn.stopReason };
    },
  };
}
```

### 3.3 `tools.js` —— 最小工具注册表

注册表只做两件事：按名字找到工具并 `execute`；告诉 loop 某个调用**能不能并发**。注意 `read_file` 标了 `concurrent: true`（只读，可并发），`exec` 标了 `false`（会改状态，必须串行）。

```js
// harness/tools.js
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { toolResultBlock } from "./messages.js";

export function createToolRegistry(defs) {
  const map = new Map(defs.map((d) => [d.name, d]));
  return {
    // 工具失败也必须转成 toolResult（isError），绝不能直接抛——
    // 否则这一轮会以「缺结果」的非法序列落盘（见决定五）。
    async execute(toolCall, signal) {
      const def = map.get(toolCall.name);
      if (!def) return toolResultBlock(toolCall.id, toolCall.name, `未知工具: ${toolCall.name}`, true);
      try {
        const out = await def.run(toolCall.arguments, signal);
        return toolResultBlock(toolCall.id, toolCall.name, out.text, out.isError ?? false);
      } catch (e) {
        return toolResultBlock(toolCall.id, toolCall.name, String(e?.message ?? e), true);
      }
    },
    canRunConcurrently(toolCall) {
      return map.get(toolCall.name)?.concurrent ?? false;
    },
  };
}

export const readFileTool = {
  name: "read_file",
  concurrent: true, // 只读 → 允许并发
  run: ({ path }) => ({ text: readFileSync(path, "utf8") }),
};

export const execTool = {
  name: "exec",
  concurrent: false, // 会改变状态 → 必须串行
  run: ({ command }) => ({ text: execSync(command, { encoding: "utf8" }) }),
};
```

### 3.4 `loop.js` —— 核心循环

这一段是本章正文。逐条对照第 2 节的五个决定：轮次上限 `MAX_TURNS=100`、只读并发上限 `MAX_CONCURRENT_TOOL_CALLS=8`、结果按原下标归位、只读并发/写串行、`beforeToolCall` 钩子、取消时给没跑完的 toolCall 补占位。

```js
// harness/loop.js
import { toolResultBlock } from "./messages.js";

export const MAX_TURNS = 100;               // 默认轮次护栏（防失控，见决定一）
export const MAX_CONCURRENT_TOOL_CALLS = 8;  // 只读批次并发上限（见决定三）

async function executeToolCall(toolCall, registry, signal) {
  return registry.execute(toolCall, signal);
}

export async function runAgentLoop({
  systemPrompt,
  messages,
  tools,        // 工具注册表
  model,        // 第1章是 mock，第3章换真实实现（接口不变）
  maxTurns = MAX_TURNS,
  beforeToolCall,
  signal,
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
      onDelta: (text) => process.stdout.write(text),
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
  }

  return { newMessages };
}
```

### 3.5 跑起来，看发生了什么

把上面四个文件放好，再写一个驱动脚本，用 mock 模型「脚本化」两轮对话：第 1 轮让它读 `loop.js`，第 2 轮它读完结果说「好了」。

```js
// harness/run.js  —— 把上面四个文件跑起来（第1章版）
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
```

运行：

```bash
cd harness && node run.js
```

预期输出（流式吐字那句会先打印在屏幕上，进度条位置取决于你的终端）：

```
已读到 loop.js，任务完成。   ← 模型第2轮说的（onDelta 实时吐出）
--- 本轮产生的消息 ---
[toolResult read_file] import { toolResultBlock } from "./messages.js";...
```

你刚刚走过的就是一条完整的最小 Loop：**模型要调工具 → 循环执行并把结果按序塞回 context → 再问模型 → 模型说「停」→ 退出**。第 2 轮模型能说出「已读到 loop.js」，正是因为第 1 轮的工具结果被正确地回灌进了 context。把 `mock` 换成真实模型、把 `read_file` 换成 `write_file`，它就能干真活了。

## 4. 配套 demo

demo 在仓库的 `demos/harness/`，与本章正文逐文件对应：`messages.js` / `model.js` / `tools.js` / `loop.js` + 驱动脚本 `run.js`——就是 3.1 ~ 3.5 节那五份代码，可直接对照着抄，也可以先跑一遍看效果：

```bash
cd demos/harness && node run.js
```

预期输出：

```
已读到 loop.js，任务完成。   ← 模型第2轮说的（onDelta 实时吐出）
--- 本轮产生的消息 ---
[toolResult read_file] // harness/loop.js ...
```

后续每一章的 demo 都往这个目录里加文件（见第 0 章的搭建地图），走到第 6 章，这个目录跑起来就是一个带审批护栏的简化 Harness。

## 5. 小结与下一章

最小 Agent Loop 的本质，是把「消息、流式、工具回灌、终止、取消安全」这五个不变量焊在一起。其中**取消安全**（补占位、不存空壳）最不起眼，却最致命——它是 demo 最容易漏、真实环境最坑人的一环。

循环里「执行工具」那一行，本章一直被一句带过——下一章（工具层设计）就拆它：**注册表、只读分级、结果回传的格式**，以及「截断要写明、失败也是结果」这些小票上的规矩。工具侧立完规矩，第 3 章再回到「问模型」那一行：真实网络下它会连不上、卡半天、被限流、读到一半被掐断——**两道计时、静默看门狗、指数退避，以及「已经吐给你半个答案就绝不再重来」这条反直觉的铁律。**
