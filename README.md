# dsh-llm-rate-limit

English | [中文](README.zh.md)

Proactive provider admission control for DeepSeek Harness 0.1.0-rc.8 or newer. It combines request and optional estimated-token buckets, concurrency limits, a bounded FIFO queue, cancellation, adaptive cooldown, `Retry-After`, and quiescent disposal. It never retries; every attempt owned by `dsh-llm-retry` re-enters admission.

## Install

```sh
dsh plugin --profile web add github:Asong6824/dsh-llm-rate-limit
dsh web
```

The bundle enables a conservative `deepseek-official` policy: 30 requests per minute, burst 1, and two concurrent requests. Install it into `headless` separately when that profile also needs admission control.

## Configure

Override the complete `llm-rate-limit` config in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

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

Provider keys must exactly match `GenerateOptions.provider`. Optional token limiting adds `tokens: { perMinute, burst, estimatedOutputTokens, imageTokens }`; `burst` must be at least one complete request estimate. Queue waits are recorded as paired, non-surface `llm/admission-wait` and `llm/admission-started` Session events.

## Limits

State is process-local and resets on restart. Token estimation is provider-independent. The plugin does not implement distributed quotas or route failover.

## Development

```sh
pnpm install
pnpm run check
```

MIT
