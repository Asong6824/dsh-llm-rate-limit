# dsh-llm-rate-limit

[English](README.md) | 中文

适用于 DeepSeek Harness 0.1.0-rc.8 及以上版本的主动提供方准入控制。插件组合请求与可选估算 Token bucket、并发限制、有界 FIFO 队列、取消、自适应冷却、`Retry-After` 和完全停稳的卸载。它不执行重试；`dsh-llm-retry` 持有的每次尝试都会重新经过准入。

## 安装

```sh
dsh plugin --profile web add github:Asong6824/dsh-llm-rate-limit
dsh web
```

Bundle 默认启用保守的 `deepseek-official` 策略：每分钟 30 次请求、突发 1、并发 2。若 Headless 也需要准入控制，请单独安装到该 profile。

## 配置

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

提供方键必须与 `GenerateOptions.provider` 完全一致。可选 Token 限流使用 `tokens: { perMinute, burst, estimatedOutputTokens, imageTokens }`；`burst` 必须容纳一个完整请求估算。队列等待会记录为成对且不进入表层的 `llm/admission-wait` 与 `llm/admission-started` Session 事件。

## 限制

状态仅存在于当前进程，重启后重置。Token 估算与提供方无关。插件不提供分布式配额或路由故障转移。

## 开发

```sh
pnpm install
pnpm run check
```

MIT
