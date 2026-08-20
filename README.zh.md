# dsh-llm-rate-limit

[![npm](https://img.shields.io/npm/v/dsh-llm-rate-limit)](https://www.npmjs.com/package/dsh-llm-rate-limit)
[![downloads](https://img.shields.io/npm/dm/dsh-llm-rate-limit)](https://www.npmjs.com/package/dsh-llm-rate-limit)
[![CI](https://github.com/Asong6824/dsh-llm-rate-limit/actions/workflows/ci.yml/badge.svg)](https://github.com/Asong6824/dsh-llm-rate-limit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-llm-rate-limit)](LICENSE)

[English](README.md) | 中文

用于 DeepSeek Harness（DSH）的 LLM API 主动限流插件，在请求到达提供方之前平滑流量。它为 DeepSeek API、火山方舟及其他 DSH 提供方提供独立的 RPM、可选 Token 预算、并发控制、有界 FIFO 队列和自适应冷却。

当并行 Agent、Subagent、重试或后台请求导致 HTTP 429、提供方限流或突发流量时，可以使用本插件。

## 从 npm 安装

安装最新版到 Web profile：

```sh
dsh plugin --profile web add dsh-llm-rate-limit
dsh web
```

生产环境可以固定版本：

```sh
dsh plugin --profile web add dsh-llm-rate-limit@0.1.1
```

Headless profile 需要单独安装：

```sh
dsh plugin --profile headless add dsh-llm-rate-limit
```

也可以从 GitHub 安装：

```sh
dsh plugin --profile web add github:Asong6824/dsh-llm-rate-limit#v0.1.1
```

Bundle 默认保护 `deepseek-official`：每分钟 30 次请求、突发 1、并发 2，并启用有界队列。

## 功能

- 每个提供方独立的 RPM Token Bucket 和可配置突发容量。
- 可选的每分钟估算 Token 预算，并根据实际用量校正。
- 并发限制、有界 FIFO 队列、超时与取消。
- 根据提供方错误码、HTTP 状态和 `Retry-After` 自适应冷却。
- 可拒绝辅助请求，避免后台流量阻塞主要任务。
- 记录准入等待与开始事件，便于分析 DSH Session。
- 卸载时等待活动请求并妥善处理排队请求。
- 每次 `dsh-llm-retry` 重试都会重新准入；本插件自身不执行重试。

## 配置 DeepSeek 和方舟

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 中覆盖完整的 `llm-rate-limit` 配置：

```yaml
- id: llm-rate-limit
  config:
    providers:
      deepseek-official:
        requests: { perMinute: 30, burst: 1 }
        maxConcurrentRequests: 2
        queue: { maxSize: 100, maxWaitMs: 300000, auxiliary: reject }
        cooldown:
          codes: [RATE_LIMIT, SERVER]
          statuses: [429, 529]
          initialDelayMs: 500
          maxDelayMs: 60000
          maxProviderDelayMs: 3600000
          jitterRatio: 0.1
      volcengine-ark-coding:
        requests: { perMinute: 30, burst: 1 }
        maxConcurrentRequests: 2
        queue: { maxSize: 100, maxWaitMs: 300000, auxiliary: reject }
```

提供方键必须与 `GenerateOptions.provider` 完全一致。可选 Token 限流配置为：

```yaml
tokens:
  perMinute: 1000000
  burst: 200000
  estimatedOutputTokens: 8192
  imageTokens: 1024
```

`tokens.burst` 必须容纳一个完整请求估算。不需要本地 Token 上限时省略 `tokens`，RPM 和并发控制仍然生效。

## 工作原理

每次调用提供方前，插件会预留请求容量、估算 Token 容量和并发槽位。容量不足的请求按 FIFO 顺序等待。提供方返回限流错误后，所有相关请求共享冷却时间；成功响应会用实际 Token 用量校正估算。状态仅存在于当前进程，DSH 重启后重置。

插件不提供分布式配额、自动重试或提供方故障转移。

## 兼容性与链接

- 需要 DeepSeek Harness `0.1.0-rc.8` 及以上版本和 Node.js `22.19` 及以上版本。
- [npm 包](https://www.npmjs.com/package/dsh-llm-rate-limit)
- [GitHub Releases](https://github.com/Asong6824/dsh-llm-rate-limit/releases)
- [DSH 插件 Topic](https://github.com/topics/dsh-plugin)
- [机器可读摘要](llms.txt)

## 开发

```sh
pnpm install
pnpm run check
```

MIT
