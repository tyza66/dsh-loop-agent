# dsh-loop-agent

[English](README.md) | [中文](README.zh.md)

一个 DSH profile bundle（**web profile**），把每个 agent 变成**同会话无限循环**：
每次模型给出最终答案后，loop 自动在下一轮 turn 边界注入一句用户可配置的
"延续语"，永远继续。

整个 run 期间，Agent 和 Session 都只有一个——每轮都看到完整累积的对话历史，
只有"下一句 user message"被模板替换。**用户消息天然优先**：客户端输入走
`next-step`（steer / inject），loop 注入的延续语走 `next-turn`（followup），
inbox 的 `claim("next-turn")` 顺序永远先取 `next-step`。

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
registry，自动给每个 agent 挂上 driver——**新开的对话即时生效**，重启
后恢复的历史会话也会被重新挂上（但超过 `idleGraceMs` 没动静的旧会话
会等用户先开口，不会自动续烧 token）。用户消息照常处理——总是先于
loop 注入的延续语被消费。

bundle 同时带一个 browser half：在 web UI 的 Settings 侧栏里挂一个
**无尽模式（Endless loop）** 入口。那个开关是日常 on/off 控件，patch 文件
覆盖是兜底逃生口。详见 [关闭](#关闭)。

## 关闭

**应用内（推荐）** — 进 **Settings → 无尽模式**，拨开关。插件不卸载；
driver 轮询 `$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json` 这个
sidecar JSON，关掉后 ~2 秒内就停止排队延续语；再拨回来，同一批 agent
立刻恢复 loop。无需重启 profile，下次 turn 边界就生效。

**单场叫停** — 某一场对话跑飞了，直接点对话里的**停止**按钮。那场立即
停：driver 看到 `aborted` 收尾就收手，之后这场回到普通一问一答，开关
仍保持"开"，其他会话不受影响。想让这一场重新进入无尽模式：把开关
**关掉再打开**（enable 时会重新武装所有被停止的会话），或重启 profile。

**归档即停** — 把会话归档（会话列表里的「归档会话」）同样立即停止它的
loop，并取消它正在进行的回复。归档不销毁 agent/session，只是从所有
分组界面里隐藏，所以不显式停的话它会在后台一直烧——supervisor 每秒
对照 `dsh-workspace` 的 `archivedSessionIds`，被归档的会话不再挂 driver，
正在跑的当场停。取消归档不会自动复活：想让这场重新无尽，开关 off→on
（归档中的会话会被跳过）或重启 profile。

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
| `GET`  | `/api/loop-agent/state`           | —                            | `{ enabled, attachedAgents, profile, continuation, defaultContinuation }` |
| `POST` | `/api/loop-agent/enabled`         | `{ "enabled": boolean }`     | snapshot + `{ path, changed }`                                     |
| `POST` | `/api/loop-agent/continuation`    | `{ "continuation": string }` | snapshot + `{ path, changed }`                                     |

`attachedAgents` 是 host scope 上当前**活着且已上膛**（loop 开着、driver 未
disarm）的会话数——被用户停止或已归档的会话不算。开关关闭时它恒为 0：关着
开关的 driver 全守在 disabled 闸门，报"N 个在跑"就是撒谎。设置页每 2 秒轮询
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
`ctx.agents.list()`，对每个还没挂上的 agent 启动一个 fire-and-forget
driver 任务，循环：

1. `await agent.whenIdle()` — 等当前 turn（如果有）跑完
2. 切片 durable session log，从上轮 `turn/end` 到当前 tail，取出本轮
   assistant 文本
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
