import { ConfigurationError } from "./errors.js"
import type { ClientConfig, PartitionConfig, RetryConfig } from "./types.js"

export function validateConfig(config: ClientConfig): void {
  if (config.concurrency !== undefined) {
    if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
      throw new ConfigurationError("concurrency must be a positive integer")
    }
  }

  if (config.timeout?.attemptMs !== undefined && config.timeout.attemptMs <= 0) {
    throw new ConfigurationError("timeout.attemptMs must be positive")
  }

  validateRetryConfig(config.retry, "retry")
  validatePartitions(config.partitions)
}

function validateRetryConfig(retry: RetryConfig | undefined, prefix: string): void {
  if (!retry) return

  if (retry.maxRetries !== undefined && retry.maxRetries < 0) {
    throw new ConfigurationError(`${prefix}.maxRetries must be non-negative`)
  }

  if (retry.retryOnStatus !== undefined && !Array.isArray(retry.retryOnStatus)) {
    throw new ConfigurationError(`${prefix}.retryOnStatus must be an array`)
  }

  if (retry.backoff && typeof retry.backoff === "object") {
    const { baseDelayMs, maxDelayMs } = retry.backoff
    if (baseDelayMs !== undefined && baseDelayMs < 0) {
      throw new ConfigurationError(`${prefix}.backoff.baseDelayMs must be non-negative`)
    }
    if (maxDelayMs !== undefined && maxDelayMs < 0) {
      throw new ConfigurationError(`${prefix}.backoff.maxDelayMs must be non-negative`)
    }
    if (baseDelayMs !== undefined && maxDelayMs !== undefined && baseDelayMs > maxDelayMs) {
      throw new ConfigurationError(`${prefix}.backoff.baseDelayMs must not exceed maxDelayMs`)
    }
  }
}

function validatePartitions(partitions: Record<string, PartitionConfig> | undefined): void {
  if (!partitions) return
  for (const [name, config] of Object.entries(partitions)) {
    if (config.concurrency !== undefined) {
      if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
        throw new ConfigurationError(`partitions.${name}.concurrency must be a positive integer`)
      }
    }
    if (config.maxQueueSize !== undefined && config.maxQueueSize < 1) {
      throw new ConfigurationError(`partitions.${name}.maxQueueSize must be at least 1`)
    }
    if (config.timeout?.attemptMs !== undefined && config.timeout.attemptMs <= 0) {
      throw new ConfigurationError(`partitions.${name}.timeout.attemptMs must be positive`)
    }
    validateRetryConfig(config.retry, `partitions.${name}.retry`)
  }
}
