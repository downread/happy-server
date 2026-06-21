# Happy Server

A robust Express middleware for real-time server health and statistics, with authentication, detailed time-based stats, stack trace tracking, and a flexible extension mechanism.

## Features

- **/happy endpoint**: Returns detailed server health, per-endpoint and global stats, stack traces, and custom extensions.
- **/happy/quick endpoint**: Returns only the four most important current stats for fast health checks.
- **Per-second, per-minute, per-5-minute, and per-hour stats**: All with robust time-based rotation and zeroing.
- **Authentication**: Protects health endpoints with a secret (set via `HAPPY_SECRET` env var) by default. Set to 'none' to disable.
- **Stack trace tracking**: Captures and deduplicates error stack traces.
- **Extension mechanism**: Other libraries can register custom stats to appear in the `/happy` response.
- **Deterministic testing**: Supports custom time functions for reliable tests.

## Installation

```
npm install @downread/happy-server
```

## Usage

### Basic Setup

```typescript
import express from 'express';
import { initHappyServer } from '@downread/happy-server';

const app = express();

// Register the middleware and endpoints before you register your routes.
const finishHappyServerInit = initHappyServer(app);

// Your routes...
app.get('/hello', (req, res) => res.send('Hello!'));

// Important, you must call this after registering  your routes:
finishHappyServerInit();

app.listen(3000);
```

### Authentication

Set the `HAPPY_SECRET` environment variable to require a secret for `/happy` and `/happy/quick`:

```
export HAPPY_SECRET=mysecret
```

To disable authentication (not recommended for production):

```
export HAPPY_SECRET=none
```

### Endpoints

- `GET /happy` — Returns full health and stats JSON:

```json
{
  "currentReqPerSec": 0.2,
  "currentReqPerMin": 3.3,
  "currentFailsPerMin": 0,
  "currentErrPerMin": 0,
  "stackTraces": [ ... ],
  "serverStats": { ... },
  "endpoints": { ... },
  "extensions": { ... },
  "extensionsFailures": [ ... ],
}
```

- `GET /happy/quick` — Returns only the four current stats:

```json
{
  "currentReqPerSec": 0.2,
  "currentReqPerMin": 3.3,
  "currentFailsPerMin": 0,
  "currentErrPerMin": 0
}
```

### Extension Mechanism

Other libraries can register custom stats to appear in `/happy`:

```typescript
import { happyServerExtension } from '@downread/happy-server';

happyServerExtension['myFeature'] = () => ({
  status: 'ok',
  customMetric: 42
});
```

The `/happy` response will include:

```json
{
  ...,
  "extensions": {
    "myFeature": {
      "status": "ok",
      "customMetric": 42
    }
  }
}
```

### Quick Extension Mechanism

Libraries can register boolean health checks that also appear in `/happy/quick`:

```typescript
import { happyServerQuickExtension } from '@downread/happy-server';

happyServerQuickExtension['myTest'] = () => Math.random() < 0.999; // 0.999 uptime
```

The `/happy/quick` response will include an `extensionFailures` list containing the names of all registered checks that returned `false` (or threw):

```json
{
  "currentReqPerSec": 0.2,
  "currentReqPerMin": 3.3,
  "currentFailsPerMin": 0,
  "currentErrPerMin": 0,
  "extensionFailures": ["myTest"]
}
```

An empty `extensionFailures` array means all checks passed.

### TypeScript Types

- `HappyServerResponse`: Full response from `/happy`
- `HappyQuickResponse`: Response from `/happy/quick`

## Testing

Run the test suite:

```
npm test
```

## Personal Note

Human here, June 2026:
This library is the result of one of my earliest attempts at generating code using agents, probably early 2025. It predates Claude Code and was written at a time when I wouldn't trust an agent to work on a whole codebase,
but it worked OK-ish when creating a small project from scratch given a specification. I can't remember whether I used a GitHub Copilot beta or a Gemini version. I just remember I tried several models, and I had to go through several iterations to get a result I was happy with.

The library stood the test of time, and I am using it (or rather, letting Claude use it) in practically every service I create. Every component in my RSS reader Downread.com uses it.
Especially the extension mechanism proved to be very useful, and it will also be used by the libraries I publish next, as well as the upcoming monitoring system.

Tim J


## License

MIT
