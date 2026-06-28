# harness-ts

`harness-ts` 是一个基于 TypeScript / Node.js 的本地编程 Agent 运行时。它可以在指定工作区中读取和修改代码、执行受控命令、调用 OpenAI Responses API，并把会话、工具调用和恢复信息持久化到本地。

## 环境要求

- Node.js 22.12 或更高版本
- Git：供 `GitStatus`、`GitDiff` 和 worktree 隔离模式使用
- ripgrep (`rg`)：供 `Grep` 和 `Glob` 使用
- Docker（Linux 容器模式）：用于隔离执行 Bash
- 如果明确使用 host 模式，则本机需要安装 Bash

Windows 用户如需使用 host 模式，必须确保 `bash.exe` 已加入 `PATH`，例如安装 Git for Windows。macOS 和 Linux 通常已有 Bash，但默认的 `auto` 模式仍优先检查 Docker，不会自动退回 host 模式。

## 安装与首次运行

在项目目录中安装依赖并构建：

```bash
npm install
npm run build
```

复制环境变量示例并填入真实 API Key：

```bash
cp .env.example .env
# 编辑 .env 后运行：
npm start -- --task "Inspect this project"
```

`harness-ts` 默认加载 `--cwd` 工作区根目录中的 `.env`；文件不存在时继续使用当前进程环境。`--env-file` 可显式选择其他可信文件，相对路径仍以工作区为基准。shell 中已经设置的环境变量优先，不会被 env 文件覆盖。

默认使用真实的 OpenAI provider，必须提供 `OPENAI_API_KEY`。只想测试 Agent 循环而不发起 API 请求时，需要明确启用 mock provider：

```bash
npm run dev -- --provider mock --task "Inspect README.md"
```

`npm start` 运行已构建的 `dist/index.js`；修改源码后应重新执行 `npm run build`。开发时可使用 `npm run dev` 直接运行 TypeScript 源码。

## 从 GitHub 更新

每次拉取新版本后都应同步依赖并重新构建，不能直接复用旧
`node_modules`：

```bash
git pull origin main
npm install
npm run build
```

如果 `npm install` 后仍出现依赖版本错乱，可重建本机依赖。不要删除仓库中的
`package-lock.json`，它用于锁定生产依赖版本。

macOS / Linux：

```bash
rm -rf node_modules
npm ci
```

Windows PowerShell：

```powershell
Remove-Item -Recurse -Force node_modules
npm ci
```

出现 `Cannot find module '@modelcontextprotocol/sdk/...'`、`ajv`、`undici`
或 `yaml` 时，说明当前依赖没有按最新 `package-lock.json` 安装，重新执行
`npm install` 或 `npm ci`，而不是逐个手工安装缺失包。

## 基本用法

### 单次任务

通过 `--task` 提交任务，任务完成后进程退出：

```bash
npm start -- --env-file .env --task "Inspect this project"
```

可以通过 `--cwd` 指定工作区：

```bash
npm start -- --cwd /path/to/project --env-file .env --task "Inspect this project"
```

### 交互会话

不传 `--task` 时，CLI 会进入交互模式，并持续接收消息，直到使用 `/exit`、`/quit` 或确认终止：

```bash
npm start
```

交互命令：

```text
/new
/resume <session-id|latest>
/session
/sessions
/inspect [session-id|latest]
/exit
```

- `/new`：创建并切换到新会话。
- `/resume <session-id|latest>`：恢复指定会话或最近选择的会话。
- `/session`：显示当前会话 ID、状态和模型。
- `/sessions`：列出已有会话。
- `/inspect [session-id|latest]`：查看会话元数据；省略参数时查看当前会话。
- `/exit`：退出交互模式；`/quit` 也可用。

每次启动默认创建独立会话。也可以在启动时恢复会话：

```bash
npm start -- --resume latest
npm start -- --resume 20260627-120000-a1b2c3
```

### 使用 `Ctrl+C` 取消

在单次 `--task` 模式中：

- 第一次按 `Ctrl+C` 会请求优雅取消，并清理模型请求和子进程。
- 清理尚未完成时再次按 `Ctrl+C` 会立即退出。
- 优雅取消完成后，进程以状态码 130 退出。

在交互模式中：

- 任务运行时第一次按 `Ctrl+C` 会取消当前任务。
- 清理后输入 `y` 终止整个会话，输入 `n` 继续使用当前会话。
- 没有任务运行时按 `Ctrl+C`，也会要求输入 `y` 或 `n`。
- 等待确认时再次按 `Ctrl+C` 会立即以状态码 130 退出。

同一个 `AbortSignal` 会传递给模型请求、工具注册表、命令工具、只读子代理以及本地或 Docker 执行器。本地命令会先获得宽限期，再清理完整进程树。模型或传输错误只结束当前交互轮次，不会直接终止整个交互会话。

## 用户配置、Base URL 与环境变量

### 用户配置文件

非敏感配置默认放在 `~/.harness/config.json`。可从 `config.example.json` 开始配置；模型、Base URL、Budget、Memory 和可信 MCP server 都在这里定义。

```json
{
  "version": 1,
  "model": {
    "provider": "openai",
    "name": "gpt-4.1",
    "baseUrl": "https://api.openai.com/v1"
  },
  "budget": {
    "maxTurns": 50,
    "maxWallTimeMs": 1800000,
    "maxInputTokens": 1000000,
    "maxOutputTokens": 250000,
    "maxToolCalls": 200,
    "maxModelRetries": 3
  },
  "memory": {
    "enabled": true
  },
  "telemetry": {
    "enabled": true
  },
  "mcpServers": []
}
```

可通过 `--config <path>` 或 `HARNESS_CONFIG` 改用其他可信配置文件。API Key 和 MCP token 不得写入 JSON 配置，必须通过环境变量提供。

在 macOS 和 Linux 上，配置文件必须由当前用户拥有，并且不能对 group 或 others 开放写权限。Windows 不执行 Unix 文件所有者和 mode 检查，但仍应使用仅当前用户可访问的位置保存配置。

### 显式 env-file

`.env.example` 使用以下变量：

```bash
OPENAI_API_KEY=sk-your-real-key
OPENAI_MODEL=gpt-4.1
OPENAI_BASE_URL=https://api.openai.com/v1
```

显式加载方式：

```bash
npm start -- --env-file .env
```

env-file 只负责把值加入进程环境，不会把它变成用户配置。不要提交含有真实密钥的 `.env`，也不要加载不可信仓库提供的 env-file。

### 配置优先级

对可覆盖的运行参数，CLI 参数优先于环境变量，环境变量优先于 `~/.harness/config.json`。未设置时使用程序默认值。

常用环境变量：

- `OPENAI_API_KEY`：默认 OpenAI provider 必需。
- `OPENAI_PROVIDER`：`openai`，或仅供显式本地循环测试的 `mock`。
- `OPENAI_MODEL`：覆盖模型名，默认 `gpt-4.1`。
- `OPENAI_BASE_URL`：OpenAI-compatible API Base URL，默认 `https://api.openai.com/v1`。
- `HARNESS_CONFIG`：可信用户配置文件路径。
- `HARNESS_BASH_SANDBOX`：`auto`、`docker`、`host` 或 `off`。
- `HARNESS_SANDBOX_IMAGE`：Bash 使用的 Docker image。
- `HARNESS_SANDBOX_PULL`：`never` 或 `missing`。
- `HARNESS_SANDBOX_NETWORK`：`none` 或 `bridge`。
- `HARNESS_MAX_TURNS`、`HARNESS_MAX_WALL_TIME_MS`。
- `HARNESS_MAX_INPUT_TOKENS`、`HARNESS_MAX_OUTPUT_TOKENS`。
- `HARNESS_MAX_TOOL_CALLS`、`HARNESS_MAX_MODEL_RETRIES`。

也可以直接通过 CLI 指定模型：

```bash
npm run dev -- --model gpt-4.1 --task "Find the main agent loop"
```

使用 OpenAI-compatible gateway 或代理时：

```bash
npm run dev -- --base-url https://your-gateway.example/v1 --task "Inspect README.md"
```

远程模型端点必须使用 HTTPS。只有明确指向 localhost 的 Base URL 才允许使用普通 HTTP。

### 项目级限制配置

工作区根目录可以提交 `.harness.json`，但它被视为不可信仓库输入，只能收紧运行限制：

```json
{
  "version": 1,
  "budget": {
    "maxTurns": 20,
    "maxToolCalls": 50,
    "maxWallTimeMs": 600000
  },
  "memory": {
    "enabled": false
  }
}
```

项目配置中的 Budget 与用户/CLI 结果取更小值；Memory 只能关闭。项目配置不能设置模型、Base URL、价格、密钥、MCP、env-file、Telemetry、权限或 sandbox，因此仓库不能借此扩大能力或隐藏审计。

## 预算（Budget）

Budget 按每条用户消息限制 Agent 循环，避免任务无限运行或消耗失控。可在用户配置、环境变量或 CLI 中设置：

- `maxTurns` / `--max-turns`：最大 Agent 轮数。
- `maxWallTimeMs` / `--max-wall-time-ms`：最大运行时间，单位为毫秒。
- `maxInputTokens` / `--max-input-tokens`：provider 输入 token 上限。
- `maxOutputTokens` / `--max-output-tokens`：provider 输出 token 上限。
- `maxToolCalls` / `--max-tool-calls`：工具调用上限。
- `maxModelRetries` / `--max-model-retries`：模型重试上限。

长任务示例：

```bash
npm run dev -- --max-turns 100 --max-tool-calls 300 \
  --max-wall-time-ms 3600000
```

Budget 会在模型请求和工具调用前检查。provider token 用量按 request ID 记录，重试会计入重试上限；达到 wall-time 上限时，正在进行的工作会通过同一取消链终止。

费用预算不会猜测或在线获取模型价格。需要在可信用户配置中同时设置价格和上限：

```json
{
  "model": {
    "pricing": {
      "inputPerMillionTokens": 1.5,
      "outputPerMillionTokens": 6,
      "cacheReadPerMillionTokens": 0.75
    }
  },
  "budget": {
    "maxEstimatedCostUsd": 2
  }
}
```

价格单位为每百万 token 的美元费用，应按实际 provider 合同维护。配置费用上限但缺少非零价格时，启动会失败，避免产生“已经限费”的错误安全感。

Windows PowerShell 不使用 Bash 的行尾 `\` 续行语法。请把上面的多行命令写成一行，或改用 PowerShell 的反引号续行。

## 长期记忆（Memory）

在用户配置中使用 `"memory": { "enabled": true }` 启用长期记忆。启用后提供：

- `MemorySearch`：只读搜索。
- `MemoryWrite`：写入记忆，要求用户明确提出并批准。
- `MemoryDelete`：删除记忆，要求用户明确提出并批准。

工具不能自行选择存储路径。Memory 会拒绝疑似 secret、credential 和 prompt-injection 文本；带标签的冲突会交给用户处理，不会静默覆盖。

用户记忆保存在 `~/.harness/memory/user.jsonl`。项目记忆也保存在用户目录中，并按工作区路径的 hash 分区，因此不可信仓库不能直接修改长期记忆。注入模型上下文的内容最多为十条，只包含相关、有效且未过期的记录，并按不可信的历史上下文处理。

Memory 与会话恢复不是同一机制：Memory 用于跨会话保留明确的信息；`.harness/sessions/` 中的事件日志用于当前任务的连续性和恢复。

## MCP 集成

### 当前支持范围

当前稳定支持通过 stdio 或 Streamable HTTP 使用 **MCP Tools、静态 Resources
和 Prompts**。当 server 声明相应 capability 时，Resources 与 Prompts 会转换成
有界的只读工具：Resource 只有在实际调用时才读取，Prompt 参数必须通过严格
schema 校验；返回内容始终带有 server 来源和不可信标记，不会自动注入 Agent
上下文，也不会冒充 system instruction。

MCP server 只能定义在可信用户配置中。将 server 设置为 `enabled`，表示允许运行时持久启动该 server；每次 MCP tool 调用仍会经过普通的 hooks、权限确认和 Budget 检查。

## 受控 HTTP Fetch

需要读取外部网页或 JSON 时，可在可信用户配置中启用独立的 `HttpFetch` 工具：

```json
{
  "httpFetch": {
    "enabled": true,
    "allowedHosts": ["docs.example.com"],
    "allowedPorts": [443],
    "maxRedirects": 3,
    "maxResponseBytes": 1000000,
    "timeoutMs": 30000
  }
}
```

Host 必须是精确、小写、规范化的名称，不支持通配符。工具只执行 GET，默认仅允许 HTTPS，并在每次连接及重定向时重新检查 host、port、DNS 和目标 IP；私网、loopback、link-local、metadata 与保留地址默认拒绝。响应只接受有界的文本或 JSON，并作为不可信内容返回。

`HttpFetch` 每次调用都需要用户批准，不保存 session 级网络授权。不要把 token、签名或其他 secret 放在 URL query 中；运行时会在工具输出中脱敏 query，但完整工具调用仍属于 session audit 事件。

Bash 的网络策略不因此放宽，默认仍为 `none`。`bridge` 表示用户明确选择的完全联网模式，不是域名 allowlist。

### stdio 服务

```json
{
  "version": 1,
  "mcpServers": [
    {
      "id": "local_docs",
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/server.js"],
        "envAllowlist": ["DOCS_TOKEN"]
      },
      "timeoutMs": 30000,
      "maxTools": 64,
      "maxResources": 64,
      "maxPrompts": 64
    }
  ]
}
```

stdio server 默认从用户 home 目录启动；只有配置绝对 `cwd` 时才会改用该目录。这样可避免不可信工作区通过当前目录影响 executable lookup。server 只能收到 `envAllowlist` 中明确列出的环境变量。

Windows 的绝对路径可使用 JSON 转义形式，例如 `"C:\\path\\to\\server.js"`；macOS 和 Linux 使用 `/absolute/path/to/server.js`。

### Streamable HTTP 服务

远程 server 必须：

- 配置精确的 `allowedHosts`，不支持通配符。
- 使用 HTTPS；只有同时明确允许 localhost 时才能使用 HTTP。
- 通过 `tokenEnv` 从环境变量读取 bearer token，不能把 token 写入配置。
- 通过目标地址检查；非 localhost 的 private-network resolution 会被拒绝。

MCP tool 会获得稳定且符合 provider 要求的名称，并使用完整 JSON Schema 验证参数。server 描述和 schema annotation 不会被当作指令注入。调用结果按不可信、有限大小的数据处理；请求发出后的传输失败会记录为 `unknown_outcome`，不会自动重放。

## 安全模型

### 工具与权限

模型可用的内置工具包括 `Read`、`Grep`、`Glob`、`Write`、`Edit`、`Bash`（按 sandbox 配置决定是否注册）、`GitStatus`、`GitDiff`、Todo、Memory、Project Skills 和只读 `Task` 子代理。

工具名和参数会先按照发送给模型的同一份 JSON Schema 校验，再进入 hooks 和权限流程。未知工具或格式错误的调用会作为可恢复失败返回给模型，不会弹出授权请求。

默认权限规则：

- `Read` 和 `Grep` 默认允许。
- `Write` 可以无批准创建新文件，但不能覆盖已有文件。
- 使用 `Edit` 更新文件需要批准。
- 明确只读的 shell 命令默认允许；可能改变状态的命令需要批准。
- 危险 shell 片段以及 `.git`、`.env`、`node_modules` 等敏感路径会在执行前拒绝。
- 有副作用的 MCP tool 默认需要批准；MCP Resource 与 Prompt 适配器是只读的，
  可在已启用的可信 server 上直接读取。

需要批准时，可以选择：

- Allow once
- Allow for this session
- Reject

`allow_session` 只会对同一工具和规范化后的相同具体参数复用；参数变化后会重新检查。危险命令和被拒绝的路径不会因为会话授权而放行。所有授权决定都会写入会话日志。

模型文本会实时输出到终端。工具调用只显示简短动作摘要和执行状态；完整参数与结果保留在会话日志中，供模型连续执行和诊断使用。

### 文件一致性

`Read` 即使只展示分页内容，也会报告完整文件的 SHA-256、byte size、UTF-8 BOM、line-ending style 和 mode。`Edit` 可通过 `expected_hash` 检测并发修改；hash 过期、文件已变化、二进制文件、无效 UTF-8、超大文件和 symlink 写入目标都会失败，不会替换原文件。

`Edit` 使用同目录临时文件和 atomic rename，并保留 BOM、换行风格及普通 permission bits；setuid/setgid/sticky bits 不会恢复。只允许创建的 `Write` 使用 atomic no-overwrite hard link 发布完整临时文件，并要求父目录已经存在。

运行时会在发布前再次检查文件身份和内容，但 Node.js 无法跨平台提供针对外部非协作写入者的原子 compare-and-swap rename。不要让多个进程同时编辑同一文件；高风险任务可使用 `--worktree` 隔离。

成功执行 `Write` 或 `Edit` 后，运行时会确保下一轮模型调用前执行 `GitDiff`。如果模型已经在最近一次编辑后运行过 `GitDiff`，则不会重复执行。自动 diff 作为不可信 observation 写入日志，不会提升为系统指令。

## Bash 沙箱

默认 `auto` 模式只有在 Docker daemon、Linux container mode、本地 Docker context、sandbox image 和 workspace mount 全部通过检查时才注册 Bash。任何一项失败，Bash 都不可用；运行时不会静默改用 host 执行。

缺少默认 image 时允许拉取：

```bash
npm start -- --sandbox-pull missing
```

强制要求 Docker，或明确关闭 Bash：

```bash
npm start -- --bash-sandbox docker
npm start -- --bash-sandbox off
```

host 模式是明确的兼容选项，不提供操作系统级隔离：

```bash
npm start -- --bash-sandbox host
```

Docker 模式默认禁用网络，并使用只读 container root、移除 capabilities、限制 process/memory/CPU、隐藏 `.harness`、遮蔽 `.env*`、只读挂载 `.git`，同时为每个会话使用独立的 Linux `node_modules`。只有任务确实需要联网时才开启：

```bash
npm start -- --sandbox-network bridge
```

跨平台注意事项：

- Windows 需要 Docker Desktop 运行 Linux containers；host 模式需要 `bash.exe`。
- macOS 的 Docker 同样运行 Linux 容器，容器中的依赖与宿主机依赖可能不同。
- Linux 需要当前用户能够访问 Docker daemon 和挂载工作区。
- `auto` 检查失败时应修复 Docker 条件、改用明确的 `host`，或使用 `off`，不要假定 Bash 仍可调用。
- 内部 `rg` 和 `git` 工具使用参数数组启动进程，兼容 Windows 与 Unix；只有显式的 `Bash` 工具会调用 shell。

## 会话、日志与上下文压缩

会话日志、元数据和任务 Todo 分别持久化在 `.harness/sessions/` 和 `.harness/todos/`。新事件包含 session ID、唯一 event ID、单调递增 sequence 和 timestamp；元数据记录模型及 lifecycle state。

已完成的 `toolCallId` 可从日志恢复。已经开始但被中断的执行会标记为 `unknown_outcome`，不会自动再次运行。该状态用于任务恢复，不等同于长期 Memory。

长会话始终保留完整的 append-only event log。当新增事件达到阈值后，运行时会追加一份有界的事实摘要，并结合近期事件构建模型上下文。`BeforeToolUse`、`AfterToolUse`、`AfterEdit` 和 `BeforeAgentStop` hooks 提供确定性的拦截和观察点；默认写入 hook 会阻止敏感路径和过大的单文件写入。

启动时会探测 Git、当前 Git repository 和 ripgrep。缺失 Git 时不注册 GitStatus/GitDiff，缺失 ripgrep 时不注册 Grep/Glob；Read 和文件编辑能力仍可使用。生命周期还提供 `SessionStart` 与 `PreCompact` hook 事件点。

## 遥测（Telemetry）

Telemetry 默认写入 `~/.harness/telemetry/telemetry.jsonl`，可通过用户配置
`"telemetry": { "enabled": false }` 完全关闭。它与 session event log 分离，
只记录任务、模型请求、工具、权限、压缩和取消的结构化指标，例如耗时、token
数量、工具名、结果码和 request ID。

Telemetry 不记录完整用户消息、模型回答、文件内容、命令参数或工具输出。字段
采用严格白名单，字符串会限长并进行 credential 脱敏；文件使用 `0600`、
append-only、跨进程锁、损坏尾恢复和 16 MiB 默认上限。Telemetry 写入失败采用
fail-open，不会导致 Agent 任务失败。

## 项目技能（Project Skills）

项目 Skill 位于 `.harness/skills/<name>/SKILL.md`，可以随仓库提交。文件使用 YAML frontmatter：

```md
---
name: typescript-testing
description: 测试并验证 TypeScript 改动。
---

# TypeScript 测试

先运行定向测试，再运行完整测试套件。
```

模型通过 `SkillList` 读取元数据，再用 `SkillLoad` 显式加载一个相关指令文件。Skill 名称必须与目录名一致，单个文件最大 64KB，路径不能逃逸工作区。`scripts/` 目录中的文件不会自动执行。Project Skills 来自项目，应按不可信仓库内容审查后再使用。

## 只读代码审查子代理

`Task` 工具可以把内置 `code-reviewer` 作为独立 AgentLoop 运行。它有单独、隐藏的 append-only audit log，最多运行 20 轮，只能使用：

```text
Read
Grep
Glob
GitStatus
GitDiff
SkillList
SkillLoad
```

它不能访问 `Write`、`Edit`、`Bash`、`TodoWrite` 或 `Task`，因此不能修改文件，也不能递归创建更多子代理。父 Agent 只会收到有长度限制的最终审查结果。

## Git Worktree 隔离

在干净 Git repository 中创建新分支和相邻 worktree 后执行任务：

```bash
npm start -- --worktree --task "Refactor the parser and run tests"
npm start -- --worktree --worktree-base main
```

运行时会打印生成的 `harness/<id>` branch 和 worktree path。Agent 的 Workspace、Session、Todo、Skills 和 sandbox 状态都会以该 worktree 为根目录。源 repository 必须保持 clean，避免未提交改动被静默遗漏。

退出后 worktree 会保留。使用打印出的路径继续：

```bash
npm start -- --cwd /path/to/worktree --resume latest
```

在源 repository 中明确审查并合并：

```bash
git -C /path/to/worktree status
git -C /path/to/worktree diff
git merge harness/<id>
git worktree remove /path/to/worktree
git branch -d harness/<id>
```

运行时不会自动 merge 或删除 worktree。`--worktree` 不能与 `--resume` 同时使用；继续已有 worktree 时应通过 `--cwd` 进入对应路径，再使用 `--resume`。

## 当前实现概览

- 支持模型 tool-call continuation 的 Agent loop
- append-only session event log 与持久化 session metadata
- session lifecycle、tool-call deduplication 和恢复
- 每条消息独立的 wall-time、token、turn、tool-call 与 retry Budget
- 可搜索、跨会话的用户与项目 Memory
- 基于 stdio 或 Streamable HTTP 的 MCP Tools，以及只读 Resources/Prompts
- workspace path boundary checks
- 带 SHA-256 冲突检测的 atomic UTF-8 file writes
- Read、Grep、Glob、Write、Edit、Bash、Git status/diff 和 Todo tools
- 只读 Project Skill discovery 与显式加载
- allow / ask / deny permission gate
- 默认使用真实 OpenAI Responses API，并支持流式输出
- 模型请求与子进程的端到端取消
- append-only context compaction 与确定性 tool lifecycle hooks
- 编辑后的自动 Git diff review
- Docker-isolated Bash，以及显式 host/off 模式
- 有界、只读的 `code-reviewer` 子代理
- 显式 Git worktree 隔离模式
- 仅供明确本地循环测试的 mock model

## 验收与回归测试

提交前运行完整构建和测试：

```bash
npm run build
npm test -- --run
```

指南中的五类 MVP 任务有独立的确定性验收套件，不调用真实模型 API：

```bash
npm run test:acceptance
```

OpenAI 原生/兼容接口与 MCP 协议转换使用合同测试：

```bash
npm run test:contract
```
