# 从零搭建 AI Agent Harness

一个手把手教你从 0 到 1 造 Agent 框架的系列技术博客。不调用Agent Harness框架，一章一章把一个真实可用的 Agent Harness 拼出来，并且**每个设计决策都讲清楚代价**：为什么非这么设计、不这么设计会出什么乱子。

**在线阅读**：[https://arixse.github.io/how-to-build-ai-agent-harness/](https://arixse.github.io/how-to-build-ai-agent-harness/)

## 这个系列的特点

- **可照着搭**：每章都有一节「实现：跟着写」，给出完整可复制、零依赖的代码。读者从头跟到尾，最后得到一个带护栏的简化版 Harness。
- **设计决策讲透**：每个关键决策固定三段式——怎么做 → 代价是什么 → 源码注释里**真实出过、并倒逼出这条护栏的事故**。
- **demo 先行**：文章里的代码先在 `demos/harness/` 里实跑验证，预期输出就是真实运行结果。

## 章节目录

| 章节                                                        | 讲什么                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| [第 0 章 导论](articles/00-agent-harness/)                   | 什么是 Harness：Loop、工具、模型三件套                  |
| [第 1 章 最小可用 Agent Loop](articles/01-agent-loop/)       | 消息进 → 流式输出 → 工具回灌 → 多轮终止              |
| [第 2 章 工具层设计](articles/02-tool-layer/)                | 只读/写/执行分级、注册表、结果回传格式                  |
| [第 3 章 模型层可靠性](articles/03-reliable-model/)          | 流式 + 超时 + 静默看门狗 + 退避重试                     |
| [第 4 章 上下文与会话](articles/04-context-session/)         | JSONL 落盘、容错加载、token 估算、自动压缩              |
| [第 5 章 供应商抽象](articles/05-provider/)                  | 统一 Provider 接口、鉴权头 / Base URL / 窗口表          |
| [第 6 章 安全模型](articles/06-security/)                    | 审批三档、风险分级、路径与凭据保护                      |
| [第 7 章 子 Agent 与 Skills](articles/07-advanced-subagent/) | 委派 = 一次工具调用、上下文隔离、成本三道闸、渐进式披露 |
| [第 8 章 评测：给 Agent 上门禁](articles/08-evaluation/)     | 任务集、三合一判定、相对基线、CI 门禁                   |
| [第 9 章 多形态交付](articles/09-delivery-forms/)            | 同一内核 → 终端 / headless / SSE 服务端                |

## 快速开始：跑 demo

`demos/harness/` 是一个**累积式**项目——每章在前一章的基础上加一块文件，走完全部章节就是一个完整的简化 Harness。

```bash
cd demos/harness

node run.js            # 第1章：最小 Loop（流式吐字 → 工具结果回灌 → 多轮终止）
node run-tools.js      # 第2章：名片剥离 / 并发开关 / 截断续读 / 失败也是结果
node run-reliable.js   # 第3章：三出戏（看门狗掐断→重试 / 429退避→重试 / 已上屏→不重试）
node run-session.js    # 第4章：存档重开 / 损坏容错 / token估算 / 压缩失败不丢历史
node run-provider.js   # 第5章：两家请求组装 / 窗口推断 / 三级解析 / 自定义供应商底线
node run-security.js   # 第6章：三档裁决表 + 风险分级表 + 钩子端到端（rm -rf 被拒）
node run-subagent.js   # 第7章：委派 / 结构性阻断 / 结论截断 / Skills 渐进式披露
node run-eval.js       # 第8章：基线绿 / 回归红 / 禁改文件 / gate:false 采样不稳定
node run-delivery.js   # 第9章：同一内核 → 终端 + headless + SSE 服务端（真起 HTTP 服务）
```

各文件与章节的对应关系见 [`demos/harness/README.md`](demos/harness/README.md)。

## 本地起站点

站点基于 VitePress，内容源在 `articles/`：

```bash
cd site
npm install        # postinstall 会在仓库根建 node_modules 联接（内容源在站点工程之外）
npm run dev        # 本地预览
npm run build      # 构建到 site/.vitepress/dist
```

push 到 `main` 后由 GitHub Actions 自动构建并部署到 GitHub Pages（见 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)）。

## 仓库结构

```
├── articles/           # 教程正文（VitePress 内容源，10 篇）
├── demos/harness/      # 累积式简化 Harness demo（零依赖，随章节生长）
├── site/               # VitePress 站点工程
└── scripts/            # 校验脚本：code-ref 源码行有效性 / 文章死链检查
```

## License

[MIT](LICENSE)
