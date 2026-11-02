# demos/harness —— 累积式简化 Harness

本目录对应教程的**累积式**代码：每一章往同一个项目里加文件，走到第 6 章，  
`node run.js` 跑起来就是一个带审批护栏的简化 Harness。零依赖，Node ≥ 18 即可。

## 各章文件一览

| 章节    | 文件                  | 作用                                                   |
| ----- | ------------------- | ---------------------------------------------------- |
| 第 1 章 | `messages.js`       | 消息形状：assistant / toolCall / toolResult               |
| 第 1 章 | `model.js`          | 模型 seam（本章 mock，第 3 章包上可靠性壳，接口不变）                    |
| 第 1 章 | `tools.js`          | 工具注册表 + read_file / exec（第 1 章简化版，见正文 3.3）           |
| 第 1 章 | `loop.js`           | `runAgentLoop`：轮次护栏 / 按序归位 / 只读并发写串行 / 钩子 / 取消补占位    |
| 第 2 章 | `tools.js`（升级）      | 注册表 + 只读分级 + 结果回传（名片 / 唯一事实来源 / 两开关 / 失败也是结果 / 写明截断） |
| 第 3 章 | `model-reliable.js` | 可靠性壳：静默看门狗 + 指数退避重试 + 已外发不重试                         |
| 第 3 章 | `flaky-model.js`    | 专出事故的假模型（确定性复现三类故障，demo 专用）                          |
| 第 4 章 | `context.js`        | token 估算（ASCII 4:1 / CJK 1:1，toolCall 参数计入）+ 压缩阈值      |
| 第 4 章 | `session.js`        | JSONL 会话存储：追加先写盘、读时容错、压缩失败不丢历史                        |
| 第 5 章 | `provider.js`       | 统一 Provider 接口：鉴权头 / Base URL 差异沉在实现里 + 注册中心               |
| 第 5 章 | `context-window.js` | 窗口表（最长前缀匹配）+ 三级解析，压缩阈值的原料                             |
| 第 6 章 | `security.js`       | 审批三档 + bash 风险分级（两个纯函数）                              |

## 怎么跑

```bash
cd demos/harness

node run.js            # 第1章：最小 Loop（流式吐字 → 工具结果回灌 → 多轮终止）
node run-tools.js      # 第2章：名片 / 并发开关 / 写明截断 / 失败也是结果
node run-reliable.js   # 第3章：三出戏（看门狗掐断→重试 / 429退避→重试 / 已上屏→不重试）
node run-session.js    # 第4章：存档重开 / 损坏容错 / token估算 / 压缩触发与失败不丢历史
node run-provider.js   # 第5章：两家请求组装 / 窗口推断 / 三级解析 / 自定义供应商底线
node run-security.js   # 第6章：三档裁决表 + 风险分级表 + 钩子端到端（rm -rf 被拒）
```

> 第 3 章 demo 把真实常量（120s 看门狗 / 1s 退避）缩小成 300ms/80ms，方便肉眼看着触发；  
> 真实数值与出处见 `model-reliable.js` 顶部注释。

