---
layout: home

hero:
  name: 从零搭建 AI Agent Harness
  text: 手把手造一个 Agent 框架
  tagline: 用真实开源项目当参照，讲清楚「可抄的架构决策 + 为什么这么决策」
  actions:
    - theme: brand
      text: 从导论开始
      link: /00-agent-harness/
    - theme: alt
      text: 直接看第 1 章
      link: /01-agent-loop/

features:
  - icon: 🗺️
    title: 先总后分
    details: 先给你一张全貌地图，再一块块拆开讲，不让你在黑话里迷路。
  - icon: 🧑‍💻
    title: 零基础友好
    details: 假设你从没造过 Agent，每个术语先用大白话类比，再给定义。
  - icon: ⚖️
    title: 决策带代价
    details: 每个架构决定都写清「选了什么 / 放弃了什么 / 代价是什么」，不吹不黑。
  - icon: 🔧
    title: 可抄的骨架
    details: 每章配套最小 demo 与源码引用，关键数字都能回素材仓库核对。
---

## 这个系列讲什么

普通聊天 AI 只会「说」。要把它变成能读文件、跑命令、改 bug 的「工人」，中间需要一层软件——**Agent Harness（智能体外壳 / 框架）**。

本系列不教你怎么调一个 API，而是带你从零把这套外壳拆开、再一块块拼回去：

- **核心三件套**：循环（Loop）/ 工具（Tools）/ 上下文（Context）
- **外围零件**：模型层可靠性、供应商抽象、安全模型、多形态入口

所有架构描述都来自一个真实开源终端 AI 编程助手的源码与文档，关键数字（超时、重试、上限）都能回源码核对——但正文里不替它打广告，你学的是「如何造」，不是「某个项目长啥样」。

## 章节地图

| 章节 | 讲什么 |
| --- | --- |
| [导论：什么是 Agent Harness](/00-agent-harness/) | 一句话定义 + 整体架构地图 + 为什么拆三件套 |
| [第 1 章 最小可用 Agent Loop](/01-agent-loop/) | 消息进 → 流式输出 → 工具回灌 → 多轮终止 |
| [第 2 章 工具层设计](/02-tool-layer/) | 只读/写/执行分级、注册表、结果回传格式 |
| [第 3 章 模型层可靠性](/03-reliable-model/) | 流式 + 超时 + 静默看门狗 + 退避重试 |
| [第 4 章 上下文与会话](/04-context-session/) | JSONL 落盘、容错加载、token 估算、自动压缩 |
| [第 5 章 供应商抽象](/05-provider/) | 统一 Provider 接口、鉴权头 / Base URL / 窗口表 |
| [第 6 章 安全模型](/06-security/) | 审批三档、风险分级、路径与凭据保护 |

> 其余章节（上下文、供应商、子 Agent、评测、多形态交付）后续补齐。
