# dsh-loop-agent

[English](README.md) | [中文](README.zh.md)

一个 DSH profile bundle（**web profile**），为聊天会话启用**按需无尽循环**：
会话不会自动循环。相反，你在聊天框中输入 `/forever` 来显式激活某个会话。
一旦激活，loop 就会在每次模型给出答案后自动注入一句用户可配置的"延续语"，
永远继续。

整个 run 期间，Agent 和 Session 都只有一个——每轮都看到完整累积的对话历史，
只有"下一句 user message"被模板替换。**用户消息优先**，由三层机制保证：
打断式输入（Cmd/Ctrl+Enter）走 `next-step`，inbox 的 `claim("next-turn")`
顺序永远先取 `next-step`，所以 steer 消息永远插在最前面；普通 Enter 输入
与延续语同走 `next-turn` 队列，但 agent 驱动循环在每个 turn 边界都先消化
完队列才进入空闲，而 loop 只在 `whenIdle()` 之后、且确认 inbox 里没有
真人消息 pending 时才排下一条延续语——**只要消息列表里有用户输入，它
一定先于下一条延续语执行；没有用户输入，延续语才接管，无限继续**。

**按需激活**：会话在全局开关打开时不会自动开始循环。相反，它们会停在
"等待激活"状态。在任意会话的聊天框中输入 `/forever`（大小写不敏感，忽略
前后空格）即可激活该会话的无限循环。每个会话必须单独激活。全局开关是前提
条件：`/forever` 仅在开关为 ON 时有效。关闭开关会立即停止所有正在运行的
循环并停住所有会话。

loop 永不主动退出。任何失败——LLM 错误、throw、context 临时超限——都
进入指数 backoff 并把上一轮触发失败的 prompt **真的重发**（重发永远不
放弃：退避涨到 `maxBackoffMs` 封顶后按封顶间隔一直重试，直到成功；重试
期间你插的新消息会取代这条过期重发）。哪怕进程中途重启，停滞在错误轮
的会话也会在下次 attach 时自愈——重放触发报错的那条消息继续重试。退出
只有三条路：**用户点一下对话里的"停止"按钮**——那一轮 `turn/end` 以
`aborted` 收场，driver 立刻收手、不再排下一条，这正是"无尽直到你手动停"
里的那个"手动停"；**把会话归档**——归档只把会话藏起来、并不销毁 agent，
supervisor 每秒对照 workspace 的归档集合，发现被归档就停 driver 并
cancel 当前工作，绝不让隐藏的会话在后台白烧 token；或者 agent 离开 live
registry（删会话 / profile 重启）。若是在回答中途插了条新消息把当前轮
打断（`interrupted`），loop 不会停，等这轮新问答落地后照常续。loop 配
80% 自动 compact + `/compact` 命令，长跑的边界不是 token 也不是轮数——
只看你愿不愿意让它跑。

## 安装

```sh
dsh plugin --profile web add https://github.com/tyza66/dsh-loop-agent
```

之后照常启动 web profile。host 上的 supervisor 每秒轮询一次 live agent
registry，**只**给顶层（root）agent 挂上 driver——但**不会自动启动循环**，
而是把每个会话停在"等待激活"状态。**会话需要通过 `/forever` 命令显式激活**。
全局开关（Settings 中的开关）必须为 ON，`/forever` 才有效。**子 agent 不挂
loop**（默认不开启无尽模式）：任何在父 agent scope 下被创建的、用户看不见的
助手 session——例如 dsh-subagent 派生的子任务、agent 内部 helper——都不挂
driver、不开 auto-answer、不开 auto-approve。用户消息照常处理——总是先于
loop 注入的延续语被消费。

bundle 同时带一个 browser half：在 web UI 的 Settings 侧栏里挂一个
**无尽模式（Endless loop）** 入口。那个开关控制 `/forever` 激活是否可用；
patch 文件覆盖是兜底逃生口。详见 [关闭](#关闭)。

## 激活会话

全局开关为 ON 时，在任意会话的聊天框中输入 `/forever` 即可激活该会话的
无尽循环。命令大小写不敏感，忽略前后空格（`/forever`、`/FOREVER`、
`  /forever  ` 都有效）。每个会话必须单独激活。一旦激活，会话将在每次
assistant 回答后使用延续语自动继续。

要停止正在运行的会话，点击其**停止**按钮。要稍后重新激活，再次输入
`/forever` 即可。

## 关闭

**应用内（推荐）** — 进 **Settings → 无尽模式**，拨开关。插件不卸载；
关闭开关会**立即停止所有正在运行的循环**，解除所有 driver 的激活，并停住
所有会话（它们需要重新输入 `/forever` 才能在开关重新打开后激活）。无需
重启 profile。

**单场叫停** — 某一场对话跑飞了，直接点对话里的**停止**按钮。那场立即
停：driver 看到 `aborted` 收尾就收手，之后这场回到普通一问一答，开关
仍保持"开"，其他已激活的会话不受影响。想让这一场重新进入无尽模式：
- 在聊天框输入 `/forever`（大小写不敏感，前后空格忽略）——仅在全局开关
  打开时生效
- 重启 profile（所有会话需要重新输入 `/forever`）

**归档即停** — 把会话归档（会话列表里的「归档会话」）同样立即停止它的
loop，并取消它正在进行的回复。归档不销毁 agent/session，只是从所有
分组界面里隐藏，所以不显式停的话它会在后台一直烧——supervisor 每秒
对照 `dsh-workspace` 的 `archivedSessionIds`，被归档的会话不再挂 driver，
正在跑的当场停。取消归档不会自动复活：想让这场重新无尽，取消归档后
输入 `/forever`，开关 off→on（归档中的会话会被跳过），或重启 profile。

**硬卸（兜底）** — 想把整个插件撤掉（没设置页、没 per-agent loop 任务、
没 HTTP 路由），在 profile 的 user-layer patch 里加一行 row 覆盖：

```sh
$DSH_HOME/profiles/web/cordis.patch.yml      # 通常是 ~/.dsh/profiles/web/cordis.patch.yml
```

```yaml
- id: loop-runner
  disabled: true
```

user layer 在 bundle 的 patch 之后 apply，所以 row 级别的 `disabled: true`
会胜出。**重启 web profile** 生效：

```sh
# 杀掉跑着的 web profile（在它的 terminal 里 Ctrl-C，或 pkill -f 'dsh.*web'）
dsh --profile web        # 重启；loop 现在关掉了
```

`disabled` 只阻止新的延续语被排队，不杀已经在 loop 的。已存在的 loop
会在 supervisor 下一次发现 agent 离开 registry 时自然收尾。要重新打开，
把 `disabled` 设回 `false`（或删掉覆盖）然后重启。

## 中间交互自动默认

无尽跑不该卡在"等真人点一下"上。loop 开启期间，三类会打断 run 的交互
会被自动处理，且只对**本插件驱动中**（loop 开、driver 未停）的会话生效，
你自己正常聊天的会话不受影响：

- **带选项的问题**（模型调 `ask_user_question`）——自动选推荐项并直接
  以工具结果喂回模型，不弹卡：优先选声明了 `(推荐)` / `(Recommended)`
  标记的选项（全半角括号都认），`plan-review` 意图直接批 `approve` 项，
  都没标记时按约定选第一个。
- **纯文本问题**（`ask_user_question` 里没有选项的条目）——自动回一段
  固定的**自治授权**：`(无人值守自动应答)`，告诉模型当前无人能输入，
  基于已有上下文与工具结果自行决策，缺关键信息时先尝试用工具拿、实在
  拿不到就说明假设并继续。这**不是**伪造人工回复。开这个开关是真正的
  放权决定——模型会对没人实际打过字的信息采取行动；想给它拴绳就关掉
  （`autoAnswerFreeText: false`），问题会弹给你，run 停在原地等人答。
- **需一次性批准的操作**（沙箱提权等）——直接回 `allowed-once`（放行
  一次），audit 事件照写；会话批准策略是 `never` 的仍然一律拒绝。

三个行为都能用 row 配置关掉：`autoAnswerQuestions: false` /
`autoAnswerFreeText: false` / `autoApproveActions: false`。

## 状态存在哪

应用内的两个控件（开关 + 延续语编辑框）都写入：

```
$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json
```

文件是普通 JSON；缺失或读不出来都视为「开启、无覆盖」：

```json
{ "disabled": false, "updatedAt": "2026-09-04T00:00:00.000Z" }
```

你也可以手改这个文件。driver 每个 phase 边界重读，~2 秒内就生效，不
需要重启。

browser half 通过 host half 在 `ctx.webServer` 上注册的三条路由抵达 host：

| 方法   | 路径                              | 请求体                       | 响应                                                               |
| ------ | --------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `GET`  | `/api/loop-agent/state`           | —                            | `{ version, enabled, attachedAgents, profile, continuation, defaultContinuation }` |
| `POST` | `/api/loop-agent/enabled`         | `{ "enabled": boolean }`     | snapshot + `{ path, changed }`                                     |
| `POST` | `/api/loop-agent/continuation`    | `{ "continuation": string }` | snapshot + `{ path, changed }`                                     |

`attachedAgents` 是 host scope 上当前**活着且已上膛**（loop 开着、driver 未
disarm）的**顶层**会话数——被用户停止或已归档的会话不算，**子 agent 也不
算**（任何在父 agent scope 下创建的、用户看不见的助手 session——例如
dsh-subagent 派生的子任务、agent 内部 helper——loop 默认不挂 driver，
不参与自动答、也不参与自动批准）。开关关闭时它恒为 0：关着开关的
driver 全守在 disabled 闸门，报"N 个在跑"就是撒谎。设置页每 2 秒轮询
一次 `/state`，面板上的数字跟着归档/停止/新建会话实时变化。
`continuation` 是**生效中**的延续语（有运行时覆盖就用覆盖，否则是 row 配置
默认值）；`defaultContinuation` 是 row 配置默认值。`path` 是写入落到的
sidecar 文件路径；`changed` 为 `false` 表示新值与文件原本一致，没发生实际
写入。

sidecar 文件可以同时带延续语覆盖：

```json
{ "disabled": false, "continuation": "继续，并深度检查暗病，遇到暗病和缺陷就修复", "updatedAt": "2026-09-04T00:00:00.000Z" }
```

删掉 `continuation` 字段（或设成空字符串）即回落到 row 配置默认。

## 配置

loop 的行为由 `loop-runner` row 的 `config` 控制，写在你 profile 的
user-layer patch 里：

```yaml
- id: loop-runner
  config:
    continuation: '继续，并深度检查暗病，遇到暗病和缺陷就修复'
    initialBackoffMs: 1000
    maxBackoffMs: 32000
    backoffFactor: 2
    quiet: false
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `continuation` | `继续，并深度检查暗病，遇到暗病和缺陷就修复` | 默认延续语模板。支持 `{{lastAnswer}}`（上一轮 assistant 文本）、`{{round}}`（1-based；round 1 = 第一个延续语，**不是**用户第一条消息）、`{{task}}`（web 模式永远空）。未知占位符原样保留。**Settings → 无尽模式**里设的运行时覆盖优先于这个默认值，直到被清掉。 |
| `initialBackoffMs` | `1000` | 第一次失败重试前等多少毫秒。 |
| `maxBackoffMs` | `32000` | 指数增长的上限。到顶后所有后续重试都等 cap。 |
| `backoffFactor` | `2` | 每次连续失败的乘数。2 = 1s→2s→4s→8s→16s→32s 标准阶梯；1.5 = 增长更慢。 |
| `idleGraceMs` | `300000` | 每个 dsh 启动时 supervisor 会把恢复的历史会话全部重新挂上 loop。会话最近一条事件老于这个窗口（默认 5 分钟）时，loop **先等用户发新消息**再开始续，防止重启后一堆旧会话同时烧 token。`0` 关闭守卫（旧会话也立即续）。 |
| `quiet` | `false` | true = 只 log warn/error；false = 每个 round 边界写一行 info，长跑有可见痕迹。 |
| `autoAnswerQuestions` | `true` | loop 开启时自动应答驱动中 agent 的 `ask_user_question` 带选项条目：推荐标记项 → `plan-review` 的 approve 项 → 第一个选项。 |
| `autoAnswerFreeText` | `true` | 纯文本条目（无选项）自动回"无人值守、自行决策"的自治授权，不再停在原地等人。依赖 `autoAnswerQuestions`；关掉则照常弹给真人。 |
| `autoApproveActions` | `true` | loop 开启时对驱动中 agent 的一次性批准请求直接 `allowed-once`；audit 照写。批准策略为 `never` 的会话仍然一律拒绝。 |
| `escalateAfterFailures` | `3` | 同一重试 prompt 连续失败 N 次后，不再原样重发，改发携带最新错误码+信息的换路 prompt，引导模型绕开失败操作。继续失败会持续生成更新的换路 prompt，直到某一轮完成（链条重置）。`0` = 永远原样重发。 |

重试相关的字段要重启 profile 才生效。延续语模板每个 turn 边界都重读：
设置页的运行时覆盖**下一轮**就生效，不用重启；改 patch 里的
`config.continuation` 则影响下一次重启后排队的新 round。

## 实现原理

`cordis.patch.yml` 把 web profile 默认 disable 的三个 row 重新 enable：

- `compaction-basic` — 80% context 窗口阈值自动 compact，保留最近 16% 原样。
  配 `auto: true, thresholdRatio: 0.8, retainRatio: 0.16`。
- `command-compact` — `/compact` 命令，用户除了 auto compact 还能立即触发。
- `tool-result-pruner` — 修剪过大的 tool result，防止单个超大结果卡住
  compact 阈值判断。

然后插入一个新 row `loop-runner`。它的 host-side `apply` 启动一个
**registry supervisor**（`ctx.effect` + 每秒 `setInterval`），轮询
`ctx.agents.roots()`，**只**对每个还没挂上的顶层 root agent 启动一个
fire-and-forget driver 任务，循环：

1. `await agent.whenIdle()` — 等当前 turn（如果有）跑完
2. 切片 durable session log，从上轮 `turn/end` 到当前 tail，取出本轮
   assistant 文本。挂到已有会话上的 driver（新 attach / 重启 / 停止后
   重新启用）会先播种边界：跳过历史里陈旧的 `aborted`/`interrupted`
   turn/end（重新启用不会立刻被之前的停止再次 halt），并从倒数第二个
   正常结束的轮次开始消费——所以重启后第一轮的 `{{lastAnswer}}` 只有
   上一轮文本，而不是整个历史。
3. 本轮以错误结束 → backoff 并重发上一轮 prompt
4. 否则渲染延续语模板，`agent.followup(...)` 推进 agent 的 `next-turn` inbox
5. 回到第 1 步

**为什么是轮询而不是 `agent/created` 事件**：dsh 的 agent 生命周期事件
（`agent/created` / `agent/disposed` / `session/disposed`）全部是
**scope-filtered** 的（`this: Scoped<Agent>`，见 `dsh-agent` 的
runtime-types）——它们只分发给注册在**那个 agent 自己的 scope 链内**的
监听器。第三方插件挂在根 context 上，`ctx.on("agent/created", ...)`
永远收不到。官方 `dsh-agent-loop` 之所以能用这些事件，是因为它自己就是
agent factory（`agents.setFactory()`），注册点在每个 agent scope 内部。
根 context 插件能依赖的只有公开注册表 `ctx.agents.list()`（live agent
一律可见，与 scope 无关），所以 supervisor 每 1 秒轮询它、用 agent
引用做去重（`agent.whenIdle()` / `agent.followup()` 都是公开方法，
不需要 scope）。同理，agent 离开 registry 也靠轮询发现（list 里消失 →
disarm driver），这是 `agent/disposed` 的替代。

core agent inbox 的 `agent/inbox/inserted` 和 `next-step` 优先级机制
保证用户消息永远先于 loop 注入的延续语被处理。driver 只在
`whenIdle()` 之后动作，所以从不抢正在跑的工作；用户一旦停手，agent
处理已排队的延续语 → idle → loop 排下一条。

## 兼容性

针对 `dsh` 0.1.1-rc.2 携带的 `@deepseek-ai/dsh-*` 0.1.1-rc.2 包构建。
peerDependencies 和上游 web-app bundle 一致；`dsh-base` 在 web profile
里已经提供了这些依赖，无需额外安装步骤。

## 协议

MIT
