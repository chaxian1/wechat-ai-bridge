# WeChat AI Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen.svg)](https://nodejs.org/)

通过微信个人号与 Claude Code / MiMoCode 对话，就像和朋友聊天一样。

基于微信官方 iLink Bot 接口，扫码绑定后你的微信里会多出一个好友。给它发消息，消息自动转发给电脑上运行的 AI CLI，回复实时推送到微信。

## 功能特性

- **原生微信接入** - 通过微信官方 iLink Bot 接口，无封号风险
- **双引擎支持** - Claude Code (`claude -p`) 和 MiMoCode (`mimo run`)，`.env` 一行切换
- **流式回复** - AI 输出实时推送到微信，自动分段避免刷屏
- **图片识别** - 微信发图给 Bot，自动 CDN 下载解密，转给 AI 分析
- **语音转码** - SILK 语音自动转 WAV，AI 可理解语音内容
- **文件收发** - 支持发送图片/文件/视频，AI 生成的文件也可推送回微信
- **会话恢复** - `/resume` 搜索历史会话，`--resume` 持续上下文
- **上下文压缩** - `/compact` 调用 AI CLI 原生命令压缩 token

- **定时任务** - 单次提醒 / CRON 重复任务，持久化到磁盘
- **Webhook** - 外部系统通过 HTTP 推送消息到微信
- **开机自启** - Windows bat / macOS launchd / Linux XDG autostart
- **管理后台** - Web UI 查看状态、日志、用户管理、配置
- **机器指纹** - 项目复制到其他机器时自动清理旧凭证

## 快速开始

### 环境要求

- Windows 10/11（已验证）
- macOS / Linux（代码已适配，但未经过实际测试验证）
- Node.js >= 22（分发包已内置，无需安装）
- Claude Code CLI 或 MiMoCode CLI（任选一个）

### 安装

```bash
# 克隆项目
git clone https://github.com/chaxian1/wechat-ai-bridge.git
cd wechat-ai-bridge

# 创建配置文件（可选，不配置也能直接跑）
cp .env.example .env

# 安装依赖（仅开发时需要，分发包已内置）
npm install
```

### 启动

| 系统 | 方式 |
|------|------|
| Windows | 双击 `manage.bat` |
| Mac/Linux | `chmod +x manage.sh && ./manage.sh` |

浏览器自动打开 `http://localhost:3456`

### 扫码登录

1. 打开管理页面 `http://localhost:3456`
2. 点击「更换微信」
3. 手机微信扫码
4. 确认连接

### 对话

微信里找到 Bot，发消息即可。

## 微信命令

在微信中发送以下命令（不经过 AI，直接处理）：

| 命令 | 功能 |
|------|------|
| `/stop` | 停止当前正在处理的任务 |
| `/clear` | 清空会话记忆，开新对话 |
| `/resume` | 列出历史会话，支持编号或关键词切换 |
| `/compact` | 压缩上下文，减少 token 消耗 |

## 配置

### 方式一：Web 管理页面（推荐）

访问 `http://localhost:3456`，在「AI 配置」卡片中直接设置：

- **提供商**：选择 Claude Code 或 MiMoCode
- **CLI 路径**：留空自动检测，或手动指定完整路径
  - Windows 示例：`C:\Users\用户名\AppData\Local\Programs\MiMoCode\mimo.exe`
  - macOS 示例：`/opt/homebrew/bin/claude`
- **模型**：留空使用默认值

### 方式二：.env 文件

在 `.env` 中配置（参考 `.env.example`）：

```ini
# AI 引擎：claude 或 mimo
AI_PROVIDER=mimo

# Claude Code 配置（可选）
CLAUDE_PATH=
CLAUDE_MODEL=claude-sonnet-4-6-20250514

# MiMoCode 配置（可选）
MIMO_PATH=
MIMO_MODEL=mimo/mimo-auto

# 工作目录（可选）
WORKSPACE_DIR=

# Webhook 令牌（可选）
WEBHOOK_TOKEN=your-secret-token

# 微信接口（无需修改）
ILINK_BASE_URL=https://ilinkai.weixin.qq.com
CDN_BASE_URL=https://novac2c.cdn.weixin.qq.com/c2c
```

## 开发

```bash
# 安装依赖
npm install

# 启动开发
npm start

# 类型检查
npm run typecheck
```

## 项目结构

```
wechat-ai-bridge/
├── manage.bat / manage.sh   # 启动入口
├── manage.html              # 管理页面
├── pack.ps1                 # 打包脚本（PowerShell）
├── package.json
├── .env.example             # 配置模板
├── src/
│   ├── index.ts             # 入口：HTTP 管理 + 桥接生命周期
│   ├── monitor.ts           # 主循环：长轮询 → AI CLI → 回复
│   ├── config.ts            # 环境变量读取
│   ├── ai-provider.ts       # 双引擎统一接口
│   ├── autostart.ts         # 开机自启（Win/Mac/Linux）
│   ├── api/client.ts        # iLink Bot HTTP 协议
│   ├── auth/
│   │   ├── qr-login.ts      # 扫码登录
│   │   ├── store.ts         # 凭证存储
│   │   └── users.ts         # 用户管理
│   ├── claude/client.ts     # Claude Code CLI 对接
│   ├── mimocode/client.ts   # MiMoCode CLI 对接
│   ├── cdn/
│   │   ├── aes-ecb.ts       # AES 解密
│   │   ├── download.ts      # CDN 媒体下载
│   │   └── upload.ts        # CDN 媒体上传
│   ├── media/
│   │   └── silk-transcode.ts # SILK→WAV 语音转码
│   ├── messaging/
│   │   ├── inbound.ts       # 消息解析
│   │   ├── send-media.ts    # 消息/图片/文件发送
│   │   ├── markdown-filter.ts # Markdown 过滤
│   │   ├── message-splitter.ts # 智能分段
│   │   ├── conversation.ts  # 对话记忆
│   │   ├── reminders.ts     # 提醒
│   │   ├── schedule.ts      # 定时任务
│   │   └── stats.ts         # 统计
│   └── utils/
│       └── redact.ts        # 日志脱敏
```

## 打包分发

```bash
# 打包（需要 PowerShell）
powershell -File pack.ps1

# 产物：dist/wechat-ai-bridge-v1.0.0.zip
# 包含：manage.bat/sh + src/ + node_modules + .env 模板
# 不包含：state/、.env、开发依赖
```

## 常见问题

**Q: 扫码没反应？**
确认终端未关闭，等待状态变化。

**Q: 发消息不回复？**
检查管理页面状态是否「运行中」，日志有无报错，AI CLI 是否安装。

**Q: 如何换号？**
点「更换微信」清除凭证重新扫码。

**Q: 重启后要重新扫码吗？**
不需要。凭证持久化，勾选「开机自启」后开机自动运行。

**Q: Mac 能用吗？**
能。用 `manage.sh` 启动，开机自启用 launchd plist。

**Q: 可以多人用吗？**
单用户设计。一个 Bot 绑定一个微信号。

## 致谢

本项目基于以下项目二次开发：

- [wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)
- [wechat-claude-code-enhanced](https://github.com/UnknownJackMe/wechat-claude-code-enhanced)
- [wechat-mimocode](https://github.com/Mou-1205/wechat-mimocode)

## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

[MIT License](LICENSE)
