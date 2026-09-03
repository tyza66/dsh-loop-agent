# dsh-loop-agent

[English](README.md) | [中文](README.zh.md)

一个 DSH profile bundle，把 `headless` profile 变成**同会话无限循环**：
每次模型给出最终答案后，自动在下一轮 turn 边界注入一句用户可配置的
"延续语"，然后继续。**Ctrl-C** 退出（或匹配到 exit phrase，或达到 `maxRounds`）。

整个 run 期间，Agent 和 Session 都只有一个——每轮都看到完整累积的对话历史，
只有"下一句 user message"被模板替换。本 bundle 安装后，默认的
`@deepseek-ai/dsh-headless` 一次性 runner 会被 disable，所以装上它
profile 就从"一次任务，打印，退出"变成"一直聊下去"。

## 安装

```sh
dsh plugin --profile headless add https://github.com/tyza66/dsh-loop-agent
```

之后照常启动 profile。位置参数 `task` 与所有新 flag 的语法都和原本的
`dsh --profile headless` 一致；只是行为变了。

## 用法

shell 语法和 `dsh --profile headless` 完全一致：

```sh
dsh --profile headless "build a snake game"
dsh --profile headless "build a snake game" --max-rounds 5
dsh --profile headless "build a snake game" --continuation "refactor it. Round {{round}}"
dsh --profile headless "build a snake game" --exit-phrase DONE --exit-phrase FINISHED
```

### Flag

| Flag | 默认 | 含义 |
| --- | --- | --- |
| `[task...]` | *(必填)* | 首条 user message；多词用空格拼成一句。 |
| `--continuation <template>` | `Please continue from where you left off. (Round {{round}})` | 第一轮之后每轮开头的 prompt。支持 `{{task}}` `{{lastAnswer}}` `{{round}}` `{{turn}}` 占位符。 |
| `--max-rounds <n>` | `0` | 跑 `n` 轮后停。`0`（默认）= 不限；直到匹配 phrase、收到信号或 Ctrl-C。 |
| `--exit-phrase <phrases...>` | `[]` | 可重复。若本轮 final answer 文本（忽略大小写）包含任一 phrase，则以 exit code 0 退出。 |
| `--quiet` | 关 | 关闭每轮 stderr 上的 `── dsh-loop-agent: round N ──` 提示行。 |
| `-h, --help` |  | 帮助。 |

### 占位符

`{{lastAnswer}}` = 上一轮所有 assistant 文本拼起来（第一轮未使用，所以为空）。
`{{round}}` / `{{turn}}` 都是 1-based 且相同（第 2 轮 = 第一个延续语）。
`{{task}}` = 原始 task。未知占位符原样保留——手滑打错一眼就能在 prompt 里看到。

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 命中 phrase，或达到 maxRounds，或最后一轮干净结束。 |
| `1` | 某一轮 turn 因错误终止。错误 code 与 message 写到 stderr。 |
| `130` | 收到 `SIGINT`（Ctrl-C）。最后一条 assistant 文本仍会先写 stdout 再退出。 |
| `143` | 收到 `SIGTERM`。同上。 |

## 实现原理

`cordis.patch.yml` 给 headless profile 声明了两条新 row：

- `loop-startup` — 一个轻量 commander 程序，解析位置参数 `task` 和新增的
  loop flag，把结果 publish 成 `loopStartup` service。
- `loop-runner` — 替换默认的一次性 runner。通过 core registry 创建一个
  Agent，发出首条 user message，然后进入循环：`await agent.whenIdle()`，
  切片 durable session log 拿到本轮 assistant 文本，渲染延续语模板，
  `agent.followup(createUserMessage(...))` 开启下一轮。退出条件：maxRounds、
  匹配 phrase、turn-level error、外部信号。退出前 flush session、把
  最后一条 assistant 文本写到 stdout，再通过 launcher 的 `appExit`
  service 干净退出。

默认的 `headless-runner` 被 `disabled: true` 关掉，所以装上这个 bundle
就完全替换掉一次性行为。卸载
（`dsh plugin --profile headless remove @tyza66/dsh-loop-agent`）后
下次启动 profile 就回到上游 runner。

## 兼容性

针对 `dsh` 0.1.1-rc.2 携带的 `@deepseek-ai/dsh-*` 0.1.1-rc.2 包构建。
peerDependencies 和 `@deepseek-ai/dsh-headless` 一致；`dsh-base` 在
headless profile 里已经提供了这些依赖，无需额外安装步骤。

## 协议

MIT
