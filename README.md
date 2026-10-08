# dsh-plugin-repowiki

[English](#english) | 中文

Qoder 风格的 **Repo Wiki** 插件，用于 DeepSeek Harness（DSH）。

让 agent 扫描你的仓库，规划目录结构并逐页生成带文件引用（`<cite>`）、mermaid 图的中文 Repo Wiki；支持**增量更新**（源码变更后只刷新过期页面）；产出一套与 Qoder `.qoder/repowiki` **同构兼容**的目录与元数据（`content/`、`meta/repowiki-metadata.json`、`knowledge/`），并内置一个 **DSH 侧栏 Wiki 浏览面板**（目录树 + Markdown 渲染 + 引用展示 + 过期标记）。

> 生成环节由 agent + LLM 完成（插件提供结构化工具链），浏览环节由插件自己的 Web 面板完成——两者组合复刻了 Qoder Repo Wiki 的完整体验。

## 功能

| 能力 | 说明 |
|---|---|
| **AI 生成 Wiki** | `repowiki_init` / `repowiki_scan` / `repowiki_write_page` / `repowiki_write_knowledge` 四个工具，引导 agent 完成“骨架 → 扫描快照 → 规划目录 → 逐页生成”的全流程 |
| **GUI 浏览面板** | DSH 侧栏新增 Repo Wiki 入口；主区域展示目录树与页面（Markdown 渲染、`<cite>` 引用文件展示、刷新与“检查更新”） |
| **增量更新** | 每页记录其来源文件的 fs 版本/大小快照；`repowiki_status` 精确报告哪些页面因哪些源文件变更而过期 |
| **Qoder 格式兼容输出** | 生成 `<wikiRoot>/<locale>/content/**/*.md` + `<locale>/meta/repowiki-metadata.json`（wiki_repo/wiki_catalogs/wiki_items/knowledge_relations/wiki_overview 同构字段）+ `knowledge/<locale>/_index.yaml` |

## 安装

插件以 bundle 形式安装进当前 profile。两种方式（任选其一）：

### 方式一：让 agent 装（推荐）

在 DSH 会话里直接说：

> 帮我安装 dsh-plugin-repowiki，仓库地址 https://github.com/WuuShan/dsh-plugin-repowiki

agent 会调用 `plugin_manager` 工具的 `install_bundle` 完成安装（DSH 原生支持 git 地址安装，会先做 `git ls-remote` 连通性检查再走 pnpm）。

### 方式二：CLI 手动装

```bash
dsh plugin --profile desktop install github:WuuShan/dsh-plugin-repowiki
```

安装后立即生效（live profile 无需重启）；若未生效，在 Web 侧边栏 **插件** 页确认 `repowiki` 条目已启用。

## 使用

1. **初始化**：对 agent 说“给这个仓库生成 Repo Wiki”。agent 会依次调用：
   - `repowiki_init` —— 在 `<工作区>/.qoder/repowiki/` 创建骨架（幂等，已有内容会被保留）；
   - `repowiki_scan` —— 扫描源码树并快照（默认排除 `Library/Logs/obj/.svn/.git` 等，可配）；
   - `repowiki_write_page` —— 按规划的目录逐页写入（自动生成 `<cite>` 引用块、维护元数据与索引）；
   - `repowiki_write_knowledge` —— （可选）写入 Qoder 格式知识卡模块。
2. **浏览**：DSH 左侧栏点击 **Repo Wiki** 图标，左侧目录树选择页面阅读。
3. **增量更新**：代码改动后对 agent 说“刷新 Repo Wiki 过期页面”。agent 调 `repowiki_status` 获取过期页面清单，仅重写受影响页面。面板里的“检查更新”按钮也能看到同样的过期标记。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件配置：

```yaml
- id: repowiki
  name: dsh-plugin-repowiki
  config:
    wikiRoot: .qoder/repowiki   # Wiki 输出根目录（工作区相对路径）
    locale: zh                  # 内容语言目录名
    overviewPage: 项目概述       # 镜像进 wiki_overview.content 的页面
    excludeDirs: [Library, Logs, obj, .svn, .git]  # 扫描排除
    sourceExts: [.cs, .asmdef, .json, .md]         # 扫描的扩展名
    maxScanFiles: 3000          # 单次扫描文件数上限
```

## 文件布局（与 Qoder 同构）

```
<工作区>/.qoder/repowiki/
├── .repowiki-index.json          ← 本插件的增量索引（源码快照 + 页面→来源映射）
├── zh/
│   ├── content/                  ← Wiki 页面（Qoder 同名目录）
│   │   ├── 项目概述.md
│   │   └── 核心架构/事件驱动架构/事件总线核心.md
│   ├── meta/
│   │   └── repowiki-metadata.json ← wiki_repo / wiki_catalogs / wiki_items /
│   │                               knowledge_relations / wiki_overview / wiki_readme
│   └── (Qoder 原生 content 与本插件共用同一目录，互不覆盖同名文件时共存)
└── knowledge/zh/
    ├── _index.yaml               ← Qoder 知识卡导出索引
    └── <模块名>/_module.yaml + <模块名>.md
```

## 兼容性说明

- `repowiki-metadata.json` 中的 `catalogue_think_content`、`raw_data` 等字段在 Qoder 侧是云端加密内容，本插件生成时留空/省略——**页面文件与目录结构完全兼容**；Qoder 重新生成 Wiki 时会以自己的服务端数据为准，不会破坏本插件的 `content/*.md`。
- 面板数据通过宿主 `webServer` 的同源路由 `/plugins/dsh-plugin-repowiki/api/*` 提供（只读），不依赖任何自定义 Remote 命名空间，因此对 DSH 升级有良好的前向兼容性。

## 开发

```bash
git clone https://github.com/WuuShan/dsh-plugin-repowiki
# 两个半边都是无构建的纯 ESM/浏览器 bundle：
#   lib/index.js  —— host 半（Node ESM，工具 + 路由）
#   lib/client.js —— 浏览器半（window.__ModuleLoader__.load 工厂格式，React createElement 风格）
# 改完直接从本地路径安装调试：
dsh plugin --profile desktop install file:E:/path/to/dsh-plugin-repowiki
```

## License

MIT
