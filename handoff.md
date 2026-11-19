# pi_hive — Agent Handoff

> 交接时间：2026-11-19 19:43 +08:00
> 交接对象：从零开始接手 `pi_hive` 的 coding agent
> 仓库：`/Users/mac/hive/pi_hive`
> 一句话：**核心链路可运行，官方前端 API 路由面已补齐；但 `docs/key_concepts` 里的 Hive 机制并未全部实现。**

先读这五个文件，再动手：

1. `AGENTS.md` — 工程硬约束
2. `docs/PARITY.md` — 诚实的特性和缺口清单
3. `docs/API_COMPAT.md` — 官方前端 API 契约与状态语义
4. `program/reports/frontend-chat-e2e.md` — 官方前端端到端实测
5. `docs/ARCHITECTURE.md` — 目录、状态、运行时流向

---

## 1. 项目边界（不要做错方向）

`pi_hive` 是一个**独立工程**，不是 Python Hive 的分支，也不是 `go_hive` 的修改版。

```text
@earendil-works/pi-agent-core  → agent loop / tools / streaming / turns
pi_hive                        → Colony / Queen / Worker / Tracker / Plan /
                                 Skills / Memory / Playbook / Trigger /
                                 Reminder / Sentinel / API / UI
```

硬约束：

- **不要重写 agent loop。** `Agent`、工具执行、流式事件、对话轮次由 pi-agent-core 提供。
- **不要修改 Python Hive**：`/Users/mac/hive/core` 是参考实现和官方前端来源，只读。
- **不要修改官方前端构建**：`/Users/mac/hive/core/frontend/dist` 原样服务在 `/`。
- 官方前端是固定客户端；要让它工作，应补 `/api` 兼容层，而不是改 `dist`。
- 原生 dashboard 在 `/ui/`，是 `src/ui` 的 vanilla JS，不是官方 UI 的替代品。
- `go_hive` 是另一个独立 Go 工程；不要把两边的状态混在一起。

---

## 2. 当前状态快照

### 已验证的测试

```bash
cd /Users/mac/hive/pi_hive
npm test
node --test tests/compat/*.test.js
node --test tests/compat-shell.test.js
```

交接时观测（2026-11-19）：

```text
npm test                         24/24 pass
tests/compat/*.test.js          189/189 pass
tests/compat-shell.test.js        9/9 pass
```

这些是**当时快照**；以后以命令输出为准，不要把数字当永久事实。

### 官方 API 契约

```text
171 entries = 168 unique HTTP + 3 SSE
implemented 107
partial      64
missing       0
```

- `program/contracts/hive-api.json` 是机器契约。
- `docs/API_COMPAT.md` 解释 `implemented` / `partial` 的语义。
- **0 missing 只表示每个官方路由都有 handler，不表示 64 条 partial 已真实实现。**
- 未知 `/api/*` 仍返回结构化 `501 not_implemented`；不能用 SPA HTML 冒充 API。
- 所有 partial 路由必须返回明确 `4xx`（如 `unsupported_capability`）或文档化的空集合，不能假成功。

### 官方前端

已验证：

- 桌面 1440×900：打开 colony、创建 session、发送 chat、渲染 Queen 回复。
- Session SSE 会 replay + tail `PI_HIVE_HOME/sessions/<id>/events.jsonl`。
- `window.__apiFailures: []`。
- 证据：`program/reports/frontend-chat-rendered.png`、`program/reports/frontend-chat-e2e.md`。

限制：

- 官方前端是 desktop-first；390×844 下没有整页横向滚动，但侧栏占宽、右侧面板被挤压裁切。
- **不要宣称官方前端已响应式。** 原生 `/ui/` 才是响应式 dashboard。
- 页面上的 “Bridge runtime offline” 是 `BrowserStatusBadge` 的浏览器工具状态，不是 chat/API 失败。

### 运行中的演示服务

交接时 `127.0.0.1:8801` 有一个演示 server，`PI_HIVE_HOME=.tmp-home`。

它只是验证实例，不是生产状态。真实状态默认在 `~/.pi-hive`；重新启动前先检查端口：

```bash
lsof -nP -iTCP:8801 -sTCP:LISTEN
```

### Git

```text
仓库已 git init，分支 main
尚无 commit；当前所有工程文件都是 untracked
```

不要擅自提交、推送或改写历史；只有用户明确说 `commit` / `push` 才做。

---

## 3. 从零启动

### 3.1 运行时

本机已验证：

```text
Node v24.21.0
npm 11.19.0
```

要求 `Node >= 22.19`，因为使用了 `node:sqlite`。没有 build step，没有 TypeScript 编译。

### 3.2 依赖：本机不要直接重装

当前 `node_modules` 不是普通安装目录，而是本地目录，里面是指向全局 pi-coding-agent 依赖的 symlink：

```text
node_modules/@earendil-works/pi-agent-core
node_modules/@earendil-works/pi-ai
node_modules/@earendil-works/pi-schema
node_modules/typebox
  → /Users/mac/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/...
```

先验证依赖是否可 import：

```bash
cd /Users/mac/hive/pi_hive
node -e "import('@earendil-works/pi-agent-core').then(()=>console.log('deps ok'))"
```

- 输出 `deps ok`：不要动 `node_modules`，继续。
- 缺依赖且本机有全局 `pi-coding-agent`：按上面的路径重建 symlink。
- 真的从另一台机器开始：`npm install`（依赖已固定在 `package.json`）。
- **不要在本机运行 `npm ci`**：它会删掉现有 symlink 结构。
- 不要因为冒烟失败就升级依赖；版本变更需要用户明确批准。

### 3.3 环境变量

```bash
export PI_HIVE_HOME="/Users/mac/hive/pi_hive/.tmp-home"   # 验证用；生产默认 ~/.pi-hive
export PI_HIVE_API_KEY="..."                             # 或 BROADTOKEN_API_KEY
export PI_HIVE_BASE_URL="https://token.tokenbroad.com/v1"
export PI_HIVE_MODEL="deepseek-flash-1017"
export PI_HIVE_PORT=8790                                  # 默认 8790
```

可选：

```bash
export PI_HIVE_HOST=127.0.0.1
export PI_HIVE_QUEEN_TURNS=40
export PI_HIVE_WORKER_TURNS=10
export PI_HIVE_MAX_WORKERS=4
export PI_HIVE_IDLE_SECONDS=120
export HIVE_FRONTEND_DIST=/Users/mac/hive/core/frontend/dist
```

密钥只从环境变量读取；**不要写进 `handoff.md`、日志、提交或截图**。

### 3.4 第一次冒烟

```bash
cd /Users/mac/hive/pi_hive
export PI_HIVE_HOME="$PWD/.tmp-home"
export PI_HIVE_API_KEY="..."   # 真实值不要写入文件

node src/cli.js colony create smoke \
  --queen queen_growth \
  --goal "验证 pi_hive 基本链路"

node src/cli.js chat smoke \
  "只回答两个字：在线。"
```

预期：CLI 输出模型回复；不要求固定文本，但必须不是 mock。

### 3.5 启动 HTTP / 官方前端

另开一个 shell：

```bash
cd /Users/mac/hive/pi_hive
export PI_HIVE_HOME="$PWD/.tmp-home"
export PI_HIVE_API_KEY="..."
export PI_HIVE_PORT=8790
node src/cli.js serve
```

打开：

```text
官方 Hive 前端：http://127.0.0.1:8790/
原生 dashboard： http://127.0.0.1:8790/ui/
健康检查：       http://127.0.0.1:8790/api/health
```

如果 `/` 没有官方前端，检查 `HIVE_FRONTEND_DIST` 是否存在；先确认：

```bash
test -f /Users/mac/hive/core/frontend/dist/index.html && echo dist-ok
```

---

## 4. 验证门禁

### 4.1 单元 / 兼容测试

```bash
npm test
node --test tests/compat/*.test.js
node --test tests/compat-shell.test.js
```

### 4.2 服务面 QC

先启动 server，再执行：

```bash
PI_HIVE_BASE=http://127.0.0.1:8790 node program/qa/check.mjs
```

预期结束：

```text
failures=0 warnings=0
```

`program/qa/check.mjs` 在 `PI_HIVE_BASE` 未设置时只检查契约和 dist，不检查 served surface；不要误以为它验证了 HTTP。

### 4.3 官方会话链路

```bash
SID=$(curl -s -X POST http://127.0.0.1:8790/api/sessions \
  -H 'content-type: application/json' \
  -d '{"colony_id":"smoke"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["session_id"])')

curl -s "http://127.0.0.1:8790/api/colonies/smoke/sessions"
curl -s "http://127.0.0.1:8790/api/sessions/$SID"
curl -s "http://127.0.0.1:8790/api/sessions/$SID/workers"
curl -s "http://127.0.0.1:8790/api/sessions/$SID/tasks"
curl -s "http://127.0.0.1:8790/api/sessions/$SID/events/history"
curl -sN -m 2 "http://127.0.0.1:8790/api/sessions/$SID/events"

curl -s -X POST "http://127.0.0.1:8790/api/sessions/$SID/chat" \
  -H 'content-type: application/json' \
  -d '{"message":"只回答两个字：在线。"}'
```

预期：

```text
POST /api/sessions          201
GET  colony sessions        200
GET  session / workers / tasks / history   200
GET  events                 200 text/event-stream
POST chat                   200 with reply
```

`chat` 会调用真实模型，慢是正常的；不要在 curl 超时就判定服务死掉。

### 4.4 官方前端交互

用浏览器打开 `/`：

1. 关闭 onboarding。
2. 点击一个 colony。
3. 输入消息并发送。
4. 确认用户气泡和 Queen 回复都出现，且没有 API 失败。

不要只截静态首页就宣称“前端已对齐”。

---

## 5. 代码地图

```text
src/
├── config.js                 # 环境变量、PI_HIVE_HOME、端口、model 配置
├── kernel/
│   ├── model.js              # pi-ai provider / OpenAI-compatible runtime
│   └── agent.js              # createPiAgent / runPiAgent / message helpers
├── domain/
│   ├── colony.js             # colony 目录、metadata、ensure
│   ├── tracker.js            # node:sqlite、WAL、SELECT guard、upsert
│   ├── plan.js               # tasks.json
│   ├── skills.js             # SKILL.md、catalog、write
│   ├── memory.js             # global / queen / colony markdown
│   ├── runlog.js             # colony.db playbook_runs
│   └── soul.js               # soul.json、proposal、apply
├── runtime/
│   ├── queen.js              # QueenRuntime、persona、tools、reminders
│   ├── worker.js             # WorkerManager、queue、spawnAndWait
│   ├── playbook.js           # JS playbook runner、retry/backoff/lane
│   ├── triggers.js           # interval + 5-field cron + persistence
│   ├── reminders.js          # ReminderHub + 4 个 source
│   ├── sentinel.js           # parked classifier / inbox / webhook
│   ├── queen-mail.js         # in-process letters
│   ├── tools.js              # tracker / plan / skill / worker / soul tools
│   ├── memory-tools.js       # memory read/write/search tools
│   ├── fs-tools.js           # workspace-scoped file + terminal tools
│   └── soul.js               # SoulEngine
├── compat/
│   ├── router.js             # RouteRegistry、matcher、structured 501
│   ├── install.js            # 注册顺序：config → config-extra → organization
│   │                         # → sessions → queens → catalog → colonies-data
│   │                         # → autonomy → streams
│   ├── sessions.js           # durable SessionStore（session.json/events.jsonl）
│   └── handlers/             # 9 个官方 API 域 handler
├── server.js                 # node:http + SSE；/ 官方 dist，/ui/ 原生
├── cli.js                    # serve / colony / chat / worker / playbook / tracker
└── ui/                       # native dashboard（vanilla JS）
```

**不要随便重排 `install.js` 的注册顺序。** 例如 sessions 必须在 organization 之后，否则 `GET /api/sessions` 会被空 provider 覆盖；streams 的静态路由要能压过 session params。

### 状态目录

默认 `PI_HIVE_HOME` 或 `~/.pi-hive`：

```text
colonies/<name>/
├── metadata.json
├── worker.json
├── profiles/
├── tools.json
├── skills/
├── triggers.json
├── tracker/tracker.db
├── colony.db
├── playbooks/<name>.play.js
├── sessions/queen_<id>.json
├── plan/tasks.json
├── memory/
├── soul.json
└── inbox.jsonl

sessions/<session_id>/
├── session.json
├── events.jsonl
└── attachments/
```

Session store 由 `src/compat/sessions.js` 管；官方 session id 和 Queen 的 colony-level transcript 不是同一层状态。

---

## 6. API 兼容层：最重要的实现细节

### 状态语义

- `implemented`：有真实 handler，返回 pi_hive 的真实数据、真实操作，或文档化的空/不存在 envelope。
- `partial`：有 handler，但能力缩水，返回明确 `4xx` 或文档化空集合。
- `missing`：不应再有；当前 0。
- `shell-only`：当前 0。

### 请求分发

`PiHiveServer.isDispatchable` 必须同时允许：

- official + implemented
- official + partial（否则 partial handler 会被 501 拦截）
- missing（走 structured 501）

原生部分 `GET /api/colonies` 仍走 `handleApi`，不要强行改成 compat provider。

### 官方 session 事件

`src/compat/handlers/streams.js` 的 `/api/sessions/:session/events`：

- 先 replay `events.jsonl`
- 再每 300ms tail 新行
- `event: message`，data 是原始记录
- 未知 id → 404 `unknown_session`
- heartbeat 和 tail timer 都要 unref
- 连接关闭要停止 poll

这是官方 chat 能显示 Queen 回复的关键；不要退回“只发心跳”的空 SSE。

---

## 7. 真实已实现的闭环

以下不是设计稿，是有代码路径、测试或实测的：

- pi-agent-core Agent 循环
- Queen 对话（真实模型）
- `spawn_worker` → worker Agent → `report_to_parent`
- Tracker SQLite：query/upsert/sql
- Plan 任务列表
- colony skills 写入与 catalog
- Memory read/write/search 文件
- JS Playbook：converge、worker、retry/backoff、lane、dead-letter
- Trigger：interval、基础 cron、webhook、`triggers.json`
- ReminderHub：TrackerSnapshot、ActiveWorkers、ColonyParallel、Idle
- Sentinel：parked 分类器、本地 inbox、可选 webhook
- Soul：proposal、review/apply、review/auto/off
- Session 持久化 + 官方 SSE replay/tail
- 官方前端桌面端 colony 打开、session 创建、chat、Queen 回复
- 原生 `/ui/` dashboard
- 171 条官方路由的 handler 面

已验证的核心闭环：

```text
Queen → spawn_worker → worker → tracker_upsert
      → report_to_parent → Queen 注入 [WORKER_REPORT]
```

---

## 8. 明确未实现 / 未对等

不要再把这些当成“已完成”。`docs/PARITY.md` 是权威清单，以下是接手时最该知道的：

### P0：核心机制缺口

1. **Goals & Outcomes 整层缺失**
   - 没有结构化 `Goal` / `SuccessCriterion` / `Constraint`
   - 没有 judge 做 accept / retry / escalate
   - 现在只有字符串 `goal` 和对话上下文

2. **Loop durability 不是 Hive 级**
   - 有 Queen transcript 持久化
   - 没有 cursor park/resume、context compaction、token/cost metering、stall/doom-loop detection

3. **Worker 不能真正 resume**
   - 没有 `resume_worker_ids`
   - 没有 Python 版严格的 grace iteration 工具集
   - 未调用 `report_to_parent` 时用最后文本兜底，不是保证报告

### P1：组织与沉淀

4. **Queen 不是完整组织层**
   - 代码只有 4 个内置 persona：growth / tech / finance / ops
   - 文档说 13 个 Queen
   - 没有 profile 编辑、独立 Queen DM、persona 市场

5. **Memory 反射/召回缺失**
   - 有 `memory_read/write/search`
   - 没有 cooldown memory reflection、consolidation、recall selector
   - 当前是把 memory 文件直接拼进 prompt

6. **Improvement 只是“能写文件”**
   - skills / playbook / soul 都有基础
   - 没有自动沉淀闭环，不能宣称“自我进化”

### P1/P2：能力与自治

7. **Colony import/export 缺失**（tar 导入导出）
8. **Trigger missed-fire 对账缺失**
9. **Event bus 仍是进程内 EventEmitter**；session events 已持久化，但 colony 级 bus 不是完整事件总线
10. **Reminder Hub 只有 4 类 source**；缺 compaction / stream-stall / past-conversations 等
11. **Sentinel 只有本地 inbox + 可选 webhook**；无 Telegram/Slack transport
12. **MCP 无 loader；browser/web tools 缺失；credential vault 缺失**
13. **官方前端移动端不是响应式**
14. **API 仍有 64 条 partial**：config 写入、MCP、Telegram/Slack、global DB、Claude Code peer、compaction、部分 worker 视图等

---

## 9. 建议接手顺序

按“先证明基线，再补核心机制”的顺序：

### 第 1 天：基线

1. 读 `AGENTS.md` / `docs/PARITY.md` / `docs/API_COMPAT.md`
2. 验证依赖 import
3. 跑三组测试
4. 启动 server，跑 QC
5. 用 curl 走一遍 session create → chat → events
6. 用浏览器打开官方 `/` 和原生 `/ui/`

### 第 2 阶段：P0 机制

1. **Goals & Outcomes**
   - 新增结构化 Goal/SuccessCriterion/Constraint
   - 加 judge：accept / retry / escalate
   - 先把 worker 或独立 agent 作为试点，不要改 pi-agent-core
2. **Loop durability**
   - 在 pi-agent 外层做持久化/恢复，不改内核
   - 先做 cursor + park/resume，再做 compaction/metering
3. **Worker resume**
   - 保存 worker transcript 和任务身份
   - 增加 `resume_worker_ids` 语义
   - 明确“恢复的是对话，不是重复 tracker 行”

### 第 3 阶段：沉淀与能力

1. Memory reflection + recall selector
2. Queen profile / 13 persona 对齐
3. Import/export、missed trigger
4. MCP / browser / credentials
5. 64 条 partial API 逐条转真实实现

### 第 4 阶段：UI 与交付

1. 官方前端桌面端回归
2. 官方移动端如果要做，需要单独设计，不能直接把 desktop-first 称为响应式
3. 更新 `docs/PARITY.md`、`docs/API_COMPAT.md`、`program/contracts/hive-api.json`
4. 每次状态变化都用命令和截图证明

---

## 10. 工作规则与坑

### 必须遵守

- 不要在未明确要求时 `commit` / `push`。
- 不要把密钥、`.tmp-home`、真实 colony 数据提交。
- 不要修改 `/Users/mac/hive/core` 或官方 `dist`。
- 不要重写 pi-agent-core 的 loop。
- 不要用 501 或假成功清契约；partial 就标 partial。
- 不要用 `npm ci` 破坏当前 symlink 依赖。
- 依赖版本变更需要用户明确批准。
- UI 改动要桌面 + 移动验证；官方前端只验证桌面可用，不冒充响应式。

### 容易踩的坑

- **固定端口**：8801 可能被旧演示 server 占用。先 `lsof -nP -iTCP:<port> -sTCP:LISTEN`。
- **`npm test` 不包含 compat 测试**：`package.json` 只跑 `tests/*.test.js`；必须另跑 `tests/compat/*.test.js`。
- **QC 没设 `PI_HIVE_BASE` 就不测 served surface**；别把“契约检查通过”当成 HTTP 验证。
- **`POST /api/sessions/:id/chat` 会真实调用模型**，慢不是挂死；用足够 timeout。
- **SSE 必须 replay + tail**；只发心跳会让官方 UI 永远 “Working…”。
- **session id 不是 colony id**：`GET /api/sessions/:id/workers` 需要通过 SessionStore resolve；不要按 colony 名猜。
- **`install.js` 注册顺序**：改顺序会覆盖 `GET /api/sessions` 或 `/api/prompts`。
- **`docs/PARITY.md` 是保守清单**：不要为了让表好看把 🟡 改成 ✅。
- **`.lanes/` 是历史 lane 副本**，不是主源码；主源码是 `pi_hive/src`。lane 产物只用于追溯。
- **Watchdog 脚本** `program/watchdog.mjs` 若使用，不能 `timer.unref()`，否则进程会退出。
- **官方前端移动端**：390×844 页面无横向滚动，但侧栏挤压/裁切；不要截图后宣称响应式。

---

## 11. 证据索引

### 规格与状态

- `AGENTS.md`
- `README.md`
- `docs/PARITY.md`
- `docs/API_COMPAT.md`
- `docs/ARCHITECTURE.md`
- `docs/DELIVERY_PLAN.md`
- `program/contracts/hive-api.json`

### 实测报告

- `program/reports/frontend-chat-e2e.md` — 官方前端 session/chat/SSE 端到端
- `program/reports/cycle-3.md` — API 六 lane 完成记录
- `program/reports/lane-results-3.md` — 各 lane 路由/测试/缺口
- `program/reports/frontend-boot.md` — 早期 boot 基线（已被取代）
- `program/qa/check.mjs`、`program/qa/COMPAT_QC.md`

### 截图

- `program/reports/frontend-chat-rendered.png` — 桌面官方 chat，Queen 回复“在线”
- `program/reports/frontend-chat-mobile.png` — 390×844 官方前端（desktop-first）
- `program/reports/frontend-colony-open-fixed.png` — colony 页面
- `docs/ui-desktop.png` / `docs/ui-mobile.png` — 原生 dashboard

### 历史 lane

- `.lanes/api-*`：API 分域 lane 的副本、`LANE_REPORT.md`、`MERGE_MANIFEST.json`
- `.lanes` 被 `.gitignore` 忽略；不是主源码，不要从 lane 直接继续改。

### 当前程序状态文件

- `program/state.json` — 交接时 cycle 3 已标记 `completed`，`lanes: {}`
- `program/alerts.jsonl` / `program/watchdog.log` — 历史看门狗产物，不是运行依赖

---

## 12. 交接验收清单

接手 agent 完成以下全部后，才算“从零启动成功”：

```text
[ ] node -e "import('@earendil-works/pi-agent-core')" 成功
[ ] npm test 通过（当前命令，不依赖模型）
[ ] node --test tests/compat/*.test.js 通过
[ ] node --test tests/compat-shell.test.js 通过
[ ] node src/cli.js serve 能启动
[ ] GET /api/health 200
[ ] GET / 返回官方 dist
[ ] GET /ui/ 返回原生 dashboard
[ ] POST /api/sessions 201
[ ] GET /api/sessions/:id/workers 200
[ ] POST /api/sessions/:id/chat 200
[ ] GET /api/sessions/:id/events 有 replay 的 event: message
[ ] 官方前端点击 colony + 发送消息，能看到 Queen 回复
[ ] PI_HIVE_BASE=... node program/qa/check.mjs => failures=0 warnings=0
[ ] 没有把任何密钥写入仓库或 handoff
```

---

## 13. 最后一句话

`pi_hive` 现在是一个**可运行的 Hive 核心子集**：Queen / Worker / Tracker / Plan / Skill / Playbook / Trigger / Sentinel / Session SSE / 官方前端桌面链路都能工作。

但它不是 `docs/key_concepts` 的完整实现：**Goals & Outcomes、Loop durability、Worker resume、Memory reflection、Queen 组织层和多项能力边界仍然缺失**。请沿着 `docs/PARITY.md` 的缺口继续，而不是把 107 条 implemented 和 64 条 partial 当成“功能对等”。
