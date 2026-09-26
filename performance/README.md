# Vereda Benchmarks

A comprehensive benchmarking and chaos engineering suite for testing Vereda's resilience, performance, and reliability under various conditions.

## Overview

This project provides:

- **Load Testing**: Basic, stress, and soak tests to measure performance
- **Chaos Engineering**: Network failures, latency spikes, and service outages
- **Scenario Tests**: Bulkhead isolation, retry storms, and thundering herd scenarios

## Installation

```bash
cd performance
bun install
```

The benchmarks import `@vereda/http` straight from `../src` (a `paths` mapping in
`tsconfig.json`, which `tsx` applies at runtime), so they always measure the
current source: no build step, and nothing to reinstall after a change.

## Usage

### Run All Benchmarks

```bash
bun run bench
# or
bun run all
```

### Individual Load Tests

```bash
# Basic load test (500 requests, 20 concurrent)
bun run load:basic

# Stress test (varying concurrency levels)
bun run load:stress

# Soak test (sustained load over time)
bun run load:soak
```

### Chaos Engineering Tests

```bash
# Network failures (30% random failures)
bun run chaos:network

# Latency spikes (random 500-2000ms delays)
bun run chaos:latency

# Service failures (periodic outages)
bun run chaos:failure
```

### Scenario Tests

```bash
# Bulkhead isolation verification
bun run scenario:bulkhead

# Retry storm simulation
bun run scenario:retry-storm

# Thundering herd test
bun run scenario:thundering-herd
```

### Selective Runner

```bash
# Run specific benchmarks by keyword
bun run src/runner.ts stress      # Run stress tests
bun run src/runner.ts chaos       # Run chaos tests
bun run src/runner.ts bulkhead    # Run bulkhead scenario
```

## Benchmark Types

### Load Tests

| Test | Description | Purpose |
|------|-------------|---------|
| Basic | 500 requests at moderate concurrency | Baseline performance |
| Stress | 1000+ requests at varying concurrency | Find breaking points |
| Soak | Sustained load over time | Detect memory leaks, degradation |

### Chaos Tests

| Test | Description | Purpose |
|------|-------------|---------|
| Network | 30% random failures | Test retry effectiveness |
| Latency | Random 500-2000ms spikes | Test timeout handling |
| Failure | Periodic service outages | Test recovery behavior |

### Scenarios

| Test | Description | Purpose |
|------|-------------|---------|
| Bulkhead | Two partitions (fast/slow) | Verify isolation |
| Retry Storm | 80% failure rate | Test backoff effectiveness |
| Thundering Herd | Sudden burst after idle | Test queue management |

## Output Format

Each benchmark produces:

```
============================================================
BENCHMARK: Basic Load Test
============================================================
Timestamp: 2024-01-01T00:00:00.000Z
Duration: 5.23s
------------------------------------------------------------
Total Requests:     500
Successful:         498
Failed:             2
Success Rate:       99.60%
------------------------------------------------------------
Requests/sec:       95.22
------------------------------------------------------------
Latency (ms):
  Average:          15.32
  Min:              8.45
  Max:              125.67
  p50:              12.34
  p95:              25.67
  p99:              45.89
------------------------------------------------------------
Errors:
  TimeoutError: 1
  NetworkError: 1
============================================================
```

## Metrics Explained

- **p50/p95/p99**: Percentile latencies (median, 95th, 99th percentile)
- **Requests/sec**: Throughput during the test
- **Success Rate**: Percentage of successful requests after retries
- **Degradation**: Performance change over time (soak tests)

## Configuration

Modify test parameters in each script:

```typescript
// Example: Adjust basic load test
const client = HttpClient.create({
  baseUrl: server.baseUrl,
  retry: { maxRetries: 5 },      // Increase retries
  timeout: { attemptMs: 10000 }, // Longer timeout
  concurrency: 50,               // Higher concurrency
});
```

## Interpreting Results

### Good Signs ✓

- High success rate (>95%) despite failures
- Stable latency across test duration
- Fast partition unaffected by slow partition (bulkhead)
- Graceful degradation under stress

### Warning Signs ⚠️

- Success rate drops significantly under load
- P99 latency much higher than P50 (variance)
- Performance degradation over time (memory leak?)
- Queue full errors (insufficient capacity)

## Adding New Benchmarks

1. Create a new file in `load/`, `chaos/`, or `scenarios/`
2. Use `TestServer` for mock servers
3. Use `runBenchmark()` for standard metrics
4. Add to `src/runner.ts` benchmarks object if desired

Example:

```typescript
import { HttpClient } from "@vereda/http";
import { TestServer, runBenchmark, printResults } from "../src/utils.js";

async function myBenchmark() {
  const server = new TestServer({ baseLatencyMs: 10 });
  await server.start();
  
  try {
    const client = HttpClient.create({
      baseUrl: server.baseUrl,
      retry: { maxRetries: 3 },
    });
    
    const result = await runBenchmark(client, {
      name: "My Custom Test",
      totalRequests: 1000,
      concurrency: 50,
    });
    
    printResults(result);
  } finally {
    await server.stop();
  }
}

myBenchmark().catch(console.error);
```

## Best Practices

1. **Run multiple times**: Single runs can be noisy
2. **Start small**: Begin with basic tests before stress/chaos
3. **Monitor resources**: Watch CPU/memory during stress tests
4. **Compare baselines**: Run before/after changes to measure impact
5. **Document findings**: Note configurations that work well

## License

MIT
