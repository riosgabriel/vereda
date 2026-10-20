# API reference

Generated from the TypeScript source on every build. The package has four entry points:

| Import | What's in it |
| --- | --- |
| `@vereda/http` | `HttpClient`, the request `Ticket`, configuration types and the error classes (the `core` module below) |
| `@vereda/http/middleware` | The middleware types, plus `defaultHeaders` and `requestLogger` |
| `@vereda/http/otel` | `instrumentTracing` and `otelMetricsSink` for OpenTelemetry |
| `@vereda/http/zod` | `withZod`, which validates a response body with a Zod schema |

For how the pieces fit together, start with the [guide](/guide/requests/). For why they work the way they do, read [the book](/book/).
