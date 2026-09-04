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
进入指数 backoff 并重发上一轮的 prompt。唯一的退出是 session 被销毁
（web UI 的停止按钮，或 profile 重启）。loop 配 80% 自动 compact + `/compact`
命令，长跑的边界不是 token 也不是轮数——只看你愿不愿意让它跑。

## 安装

```sh
dsh plugin --profile web add https://github.com/tyza66/dsh-loop-agent
```

之后照常启动 web profile。每个新 agent 都会被 loop 自动 attach。用户消息
照常处理——总是先于 loop 注入的延续语被消费。

bundle 同时带一个 browser half：在 web UI 的 Settings 侧栏里挂一个
**无尽模式（Endless loop）** 入口。那个开关是日常 on/off 控件，patch 文件
覆盖是兜底逃生口。详见 [关闭](#关闭)。

## 关闭

**应用内（推荐）** — 进 **Settings → 无尽模式**，拨开关。插件不卸载；
driver 轮询 `$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json` 这个
sidecar JSON，关掉后 ~2 秒内就停止排队延续语；再拨回来，同一批 agent
立刻恢复 loop。无需重启 profile，下次 turn 边界就生效。

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

`disabled` 只阻止新 agent 被 attach，不杀已经在 loop 的。已存在的 loop
会在下一次 `agent/disposed` / `session/disposed` 自然收尾。要重新打开，
把 `disabled` 设回 `false`（或删掉覆盖）然后重启。

## 状态存在哪

应用内开关写入：

```
$DSH_HOME/profiles/<profile>/.dsh-loop-agent.json
```

文件是普通 JSON；缺失或读不出来都视为「开启」：

```json
{ "disabled": false, "updatedAt": "2026-09-04T00:00:00.000Z" }
```

你也可以手改这个文件。driver 每个 phase 边界重读，~2 秒内就生效，不
需要重启。

browser half 通过 host half 在 `ctx.webServer` 上注册的两条路由抵达 host：

| 方法   | 路径                         | 请求体                    | 响应                                                              |
| ------ | ---------------------------- | ------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/api/loop-agent/state`      | —                         | `{ enabled, attachedAgents, profile }`                            |
| `POST` | `/api/loop-agent/enabled`    | `{ "enabled": boolean }`  | `{ enabled, attachedAgents, profile, path, changed }`             |

`attachedAgents` 是当前 host scope 上正持有 driver 任务的 agent 实时计数。
`path` 是写入落到的 sidecar 文件路径；`changed` 为 `false` 表示新值与
文件原本一致，没发生实际写入。

## 配置

loop 的行为由 `loop-runner` row 的 `config` 控制，写在你 profile 的
user-layer patch 里：

```yaml
- id: loop-runner
  config:
    continuation: 'Please continue from where you left off. (Round {{round}})'
    initialBackoffMs: 1000
    maxBackoffMs: 32000
    backoffFactor: 2
    quiet: false
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `continuation` | `Please continue from where you left off. (Round {{round}})` | 延续语模板。支持 `{{lastAnswer}}`（上一轮 assistant 文本）、`{{round}}`（1-based；round 1 = 第一个延续语，**不是**用户第一条消息）、`{{task}}`（web 模式永远空）。未知占位符原样保留。 |
| `initialBackoffMs` | `1000` | 第一次失败重试前等多少毫秒。 |
| `maxBackoffMs` | `32000` | 指数增长的上限。到顶后所有后续重试都等 cap。 |
| `backoffFactor` | `2` | 每次连续失败的乘数。2 = 1s→2s→4s→8s→16s→32s 标准阶梯；1.5 = 增长更慢。 |
| `quiet` | `false` | true = 只 log warn/error；false = 每个 round 边界写一行 info，长跑有可见痕迹。 |

重启 web profile 后配置生效。改 `continuation` 不会影响当前正在 loop
的 agent——它继续用旧模板直到 session 被销毁。

## 实现原理

`cordis.patch.yml` 把 web profile 默认 disable 的三个 row 重新 enable：

- `compaction-basic` — 80% context 窗口阈值自动 compact，保留最近 16% 原样。
  配 `auto: true, thresholdRatio: 0.8, retainRatio: 0.16`。
- `command-compact` — `/compact` 命令，用户除了 auto compact 还能立即触发。
- `tool-result-pruner` — 修剪过大的 tool result，防止单个超大结果卡住
  compact 阈值判断。

然后插入一个新 row `loop-runner`，它的 host-side `apply` 在 host 平面
注册 `agent/created` hook。每个新 agent 拿到一个 fire-and-forget driver
任务，循环：

1. `await agent.whenIdle()` — 等当前 turn（如果有）跑完
2. 切片 durable session log，从上轮 `turn/end` 到当前 tail，取出本轮
   assistant 文本
3. 本轮以错误结束 → backoff 并重发上一轮 prompt
4. 否则渲染延续语模板，`agent.followup(...)` 推进 agent 的 `next-turn` inbox
5. 回到第 1 步

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
