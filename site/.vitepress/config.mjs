import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 仓库根（site/ 的上级），内容 articles/ 与 site/ 都在这里
const REPO_ROOT = path.resolve(__dirname, '..', '..')

// 内容源在仓库根的 articles/，站点工程本身在 site/。
// srcDir 指向 ../articles（站点根之外）。Vite 解析裸模块（vue）时从内容文件真实目录
// 向上找 node_modules，而 node_modules 装在 site/ 里 —— 为此在仓库根建了 node_modules
// 联接指向 site/node_modules（见 package.json 的 postinstall 与 scripts/link-node_modules.mjs）。
// 这里把仓库根加入 dev server 的 fs.allow，避免「文件在根外」被拦截。
// 引入 mermaid 插件：文章里的 ```mermaid 流程图才能在站点里正常渲染
// （否则会退化成原始代码块，和之前预览器不显示是同一个坑）。
export default withMermaid(defineConfig({
  title: '从零搭建 AI Agent Harness',
  description: '一个手把手教你从 0 到 1 造 Agent 框架的系列技术博客',
  srcDir: '../articles',
  cleanUrls: true,
  ignoreDeadLinks: false, // 由 scripts/check-links.mjs 统一把关死链，构建时不静默放过

  vite: {
    server: {
      fs: {
        allow: [REPO_ROOT]
      }
    }
  },

  themeConfig: {
    nav: [
      { text: '导论', link: '/00-agent-harness/' },
      { text: '第 1 章 · Loop', link: '/01-agent-loop/' },
      { text: '第 3 章 · 可靠性', link: '/03-reliable-model/' },
      { text: '第 6 章 · 安全', link: '/06-security/' }
    ],

    sidebar: [
      {
        text: '系列总览',
        collapsed: false,
        items: [
          { text: '导论：什么是 Agent Harness', link: '/00-agent-harness/' }
        ]
      },
      {
        text: '技术章节（样稿）',
        collapsed: false,
        items: [
          { text: '第 1 章 最小可用 Agent Loop', link: '/01-agent-loop/' },
          { text: '第 3 章 模型层可靠性', link: '/03-reliable-model/' },
          { text: '第 6 章 安全模型', link: '/06-security/' }
        ]
      }
    ],

    docFooter: { prev: false, next: true },
    lastUpdated: false,
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    footer: {
      message: '系列素材取自一个真实的开源终端 AI 编程助手；正文中不出现其项目名。',
      copyright: '本系列教程'
    }
  }
}))
