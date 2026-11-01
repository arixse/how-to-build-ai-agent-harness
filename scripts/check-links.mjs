// scripts/check-links.mjs
// 站点链接检查：扫描 articles/ 下所有 Markdown 的内部链接，确认指向的文件真实存在。
// 外部链接（http/https）只计数、不发起请求（避免 CI 网络依赖与误判）。
// 返回非 0 退出码代表存在死链。
//
// 用法：node scripts/check-links.mjs
// 约定：站点内容根为 articles/（与 VitePress srcDir 一致）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARTICLES_ROOT = path.resolve(__dirname, '../articles')

const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const MD_URL_RE = /<(https?:\/\/[^>\s]+)>/g

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && full.endsWith('.md')) out.push(full)
  }
  return out
}

function resolveInternal(target, fromFile) {
  // 去掉锚点
  const [pathPart] = target.split('#')
  if (!pathPart) return null // 纯锚点，跳过
  let resolvedAbs
  if (pathPart.startsWith('/')) {
    // 站点根相对 articles/
    resolvedAbs = path.join(ARTICLES_ROOT, pathPart)
  } else {
    resolvedAbs = path.resolve(path.dirname(fromFile), pathPart)
  }
  // 允许 .md 省略；VitePress 还会生成 .html，这里以源 .md 为准
  const candidates = [resolvedAbs, resolvedAbs + '.md', resolvedAbs.replace(/\/$/, '/index.md')]
  return candidates.find((c) => fs.existsSync(c)) || candidates[0]
}

function main() {
  if (!fs.existsSync(ARTICLES_ROOT)) {
    console.error(`[check-links] 找不到内容根: ${ARTICLES_ROOT}`)
    process.exit(1)
  }
  const files = walk(ARTICLES_ROOT)
  let internalTotal = 0
  let externalTotal = 0
  const broken = []

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    let m
    while ((m = MD_LINK_RE.exec(text))) {
      const target = decodeURIComponent(m[1])
      if (/^https?:\/\//.test(target) || target.startsWith('//')) {
        externalTotal++
        continue
      }
      if (target.startsWith('mailto:') || target.startsWith('tel:')) continue
      internalTotal++
      const resolved = resolveInternal(target, file)
      if (!fs.existsSync(resolved)) {
        broken.push({ file, target, resolved })
      }
    }
    while ((m = MD_URL_RE.exec(text))) {
      externalTotal++
    }
  }

  console.log(`[check-links] 扫描 ${files.length} 个 Markdown 文件`)
  console.log(`[check-links] 内部链接 ${internalTotal} 条，外部链接 ${externalTotal} 条`)

  if (broken.length) {
    console.error(`[check-links] 发现 ${broken.length} 条死链：`)
    for (const b of broken) {
      console.error(`  ${path.relative(ARTICLES_ROOT, b.file)}  ->  ${b.target}`)
      console.error(`    (解析为: ${path.relative(ARTICLES_ROOT, b.resolved)}，文件不存在)`)
    }
    process.exit(1)
  }

  console.log('[check-links] 全部内部链接有效 ✓')
  process.exit(0)
}

main()
