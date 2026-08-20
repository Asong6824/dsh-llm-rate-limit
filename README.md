# dsh-llm-rate-limit

[![npm](https://img.shields.io/npm/v/dsh-llm-rate-limit)](https://www.npmjs.com/package/dsh-llm-rate-limit)
[![downloads](https://img.shields.io/npm/dm/dsh-llm-rate-limit)](https://www.npmjs.com/package/dsh-llm-rate-limit)
[![CI](https://github.com/Asong6824/dsh-llm-rate-limit/actions/workflows/ci.yml/badge.svg)](https://github.com/Asong6824/dsh-llm-rate-limit/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-llm-rate-limit)](LICENSE)

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that prevents avoidable API rate-limit errors by pacing LLM requests before they reach the provider. It provides per-provider RPM limits, optional token budgets, concurrency control, bounded FIFO queuing, and adaptive cooldown for DeepSeek API, Volcengine Ark, and other DSH providers.

Use it when parallel agents, subagents, retries, or background requests are producing HTTP 429 errors, provider throttling, or traffic bursts.

## Install from npm

Install the latest release into the Web profile:

```sh
dsh plugin --profile web add dsh-llm-rate-limit
dsh web
```

Pin a version for reproducible environments:

```sh
dsh plugin --profile web add dsh-llm-rate-limit@0.1.1
```

Install separately for Headless:

```sh
dsh plugin --profile headless add dsh-llm-rate-limit
```

GitHub installation is also supported:

```sh
dsh plugin --profile web add github:Asong6824/dsh-llm-rate-limit#v0.1.1
```

The bundled default protects `deepseek-official` with 30 requests per minute, burst 1, two concurrent requests, and a bounded queue.

## Features

- Provider-scoped requests-per-minute token buckets with configurable burst capacity.
- Optional estimated-token-per-minute budgets with actual-usage reconciliation.
- Concurrency limits and bounded FIFO queues with timeout and cancellation.
- Adaptive cooldown for provider error codes, HTTP statuses, and `Retry-After`.
- Explicit auxiliary-request shedding so background traffic does not block primary work.
- Durable admission wait/start events for DSH session diagnostics.
- Clean lifecycle disposal without abandoning queued or active requests.
- Retry-aware admission: every `dsh-llm-retry` attempt is admitted independently; this plugin never retries requests itself.

## Configure DeepSeek and Ark

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

Provider keys must exactly match `GenerateOptions.provider`. Optional token limiting adds:

```yaml
tokens:
  perMinute: 1000000
  burst: 200000
  estimatedOutputTokens: 8192
  imageTokens: 1024
```

`tokens.burst` must be large enough for one complete request estimate. Omit `tokens` when a provider should have RPM and concurrency control without a local token ceiling.

## How it works

Before each provider call, the plugin reserves request capacity, estimated token capacity, and a concurrency slot. Requests without capacity wait in FIFO order. Provider throttling responses activate a shared cooldown; successful responses reconcile estimated tokens with actual usage. The state is process-local and resets when DSH restarts.

The plugin deliberately does not provide distributed quotas, automatic retries, or provider failover.

## Compatibility and links

- Requires DeepSeek Harness `0.1.0-rc.8` or newer and Node.js `22.19` or newer.
- [npm package](https://www.npmjs.com/package/dsh-llm-rate-limit)
- [GitHub releases](https://github.com/Asong6824/dsh-llm-rate-limit/releases)
- [DSH plugins topic](https://github.com/topics/dsh-plugin)
- [Machine-readable summary](llms.txt)

## Development

```sh
pnpm install
pnpm run check
```

MIT
