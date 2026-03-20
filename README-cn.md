<p align="center">
  <img src="./logo.png" alt="PRism" width="128" />
</p>

# PRism

[English](./README.md)

PRism 是一个个人 GitHub code review 助手。
它在 GitHub PR **Files changed** 页面的代码 diff 旁边显示 AI 生成的摘要。

## 3 分钟快速开始

### 方式 A：安装（推荐）

**1) 安装 CLI：**

```bash
npm i -g prism-code-review
```

**2) 安装 Chrome 扩展：**

1. 从 [最新 Release](https://github.com/you06/PRism/releases/latest) 下载 extension zip
2. 解压
3. 打开 `chrome://extensions`，开启 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择解压后的文件夹

**3) 使用（在 git 仓库中运行）：**

```bash
prism review 42                    # review PR #42（默认使用 codex）
prism review 42 --agent claude     # 使用 claude
prism review 42 --model gpt-4.1   # 指定模型
prism review 42 --lang cn         # 用简体中文输出摘要
prism review 42 --lang jp         # 用日语输出摘要
prism review owner/repo#42        # review 指定仓库的 PR
prism server                       # 仅启动 daemon（不分析）
```

`prism review` 默认使用 `--lang en`。支持的值有 `en`、`cn` 和 `jp`。

打开任意 GitHub PR **Files changed** 页面，即可看到 PRism 卡片出现在 diff hunk 旁边。

### 方式 B：从源码运行

```bash
pnpm install
pnpm build
pnpm --filter @prism/daemon dev
```

健康检查：`curl http://127.0.0.1:19280/v1/health`

在 `chrome://extensions` 中加载 `extension/` 目录（开发者模式 → 加载已解压的扩展程序）。

## 前置要求

- Node.js >= 20
- pnpm >= 9
- Chrome / Chromium
- 已认证的 GitHub CLI：`gh auth login`
- 以下分析 agent 之一：
  - [Codex CLI](https://github.com/openai/codex)（默认）
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（`--agent claude`）

## Smoke test

```bash
# 终端 1
pnpm --filter @prism/daemon dev

# 终端 2
pnpm --filter @prism/daemon smoke-test
```

## 问题排查

- **没有卡片出现**
  - 重新构建：`pnpm --filter @prism/extension build`
  - 在 `chrome://extensions` 中重新加载扩展
  - 确认你在 `.../pull/<n>/files` 页面上

- **Daemon 离线**
  - 启动：`pnpm --filter @prism/daemon dev`
  - 检查：`curl http://127.0.0.1:19280/v1/health`

- **GitHub 认证错误**
  - 运行 `gh auth login`
  - 重启 daemon

## 更多文档

- 开发设置 / 脚本 / 测试数据 / QA：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 设计 / 架构：[DESIGN.md](./DESIGN.md)
