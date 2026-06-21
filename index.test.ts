import express from 'express';
import request from 'supertest';
import { initHappyServer, collectVitalsNow, happyTimeTillShutdownS, onShutdownChange, onBeforeShutdown } from './index';

describe('happy-server', () => {


  it('should require secret for /happy', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    initHappyServer(app);
    const res = await request(app).get('/happy');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('should return health JSON with secret', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    initHappyServer(app);
    (app as any).get('/test', (req: express.Request, res: express.Response) => res.status(200).send('ok'));

    await request(app).get('/test');
    const res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('currentReqPerSec');
    expect(res.body).toHaveProperty('serverStats');
    expect(res.body).toHaveProperty('endpoints');
  });

  it('should count failures and errors', async () => {
    let fakeNow = 1717411000000; // fixed timestamp
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/test', (req: express.Request, res: express.Response) => res.status(200).send('ok'));
    (app as any).get('/fail', (req: express.Request, res: express.Response) => res.status(401).send('fail!'));
    (app as any).get('/err', (req: express.Request, res: express.Response) => res.status(500).send('err!'));
    (app as any).get('/exception', (req: express.Request, res: express.Response) => { throw new Error('exception!'); });
    finish();
    await request(app).get('/fail');
    await request(app).get('/err');
    fakeNow += 60001; // advance time to simulate a new minute
    await request(app).get('/test');
    const res = await request(app).get('/happy');
    expect(res.body.serverStats.minuteStats.req[1]).toBe(2); // /fail + /err
    expect(res.body.serverStats.minuteStats.errors[1]).toBe(1);
    expect(res.body.serverStats.minuteStats.failures[1]).toBe(1);
    expect(res.body.currentFailsPerMin).toBeGreaterThan(0);
    expect(res.body.currentErrPerMin).toBeGreaterThan(0);
    expect(res.body.stackTraces.length).toBe(0);

    await request(app).get('/fail404');
    await request(app).get('/exception');
    await request(app).get('/fail404');
    await request(app).get('/exception');
    await request(app).get('/test');
    fakeNow += 60001; // advance time to simulate a new minute
    await request(app).get('/test');
    const res2 = await request(app).get('/happy');
    expect(res2.body.serverStats.minuteStats.req[1]).toBe(7); // 2x /fail404 + 2x /exception + 2x /test + /happy
    expect(res2.body.serverStats.minuteStats.errors[1]).toBe(2);
    expect(res2.body.serverStats.minuteStats.failures[1]).toBe(2);
    expect(res2.body.currentFailsPerMin).toBeGreaterThan(0);
    expect(res2.body.currentErrPerMin).toBeGreaterThan(0);
    expect(res2.body.stackTraces.length).toBe(1); // same stacktrace, so just 1
  });

  it('should count requests per endpoint and in server stats', async () => {
    // Use a constant fake clock for deterministic stats
    const fakeNow = 1717411200000; // fixed timestamp
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/a', (req: express.Request, res: express.Response) => res.status(200).send('a'));
    (app as any).get('/b', (req: express.Request, res: express.Response) => res.status(200).send('b'));
    (app as any).get('/c', (req: express.Request, res: express.Response) => res.status(200).send('c'));
    finish();
    // 10 requests to each endpoint
    for (let i = 0; i < 10; ++i) {
      await request(app).get('/a').set('Authorization', 'testsecret');
      await request(app).get('/b').set('Authorization', 'testsecret');
      await request(app).get('/c').set('Authorization', 'testsecret');
    }
    // Check /happy stats
    const res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.status).toBe(200);
    // Endpoints
    expect(res.body.endpoints['GET /a'].req[0]).toBe(10);
    expect(res.body.endpoints['GET /b'].req[0]).toBe(10);
    expect(res.body.endpoints['GET /c'].req[0]).toBe(10);
    // Server stats
    expect(res.body.serverStats.minuteStats.req[0]).toBe(30);
    expect(res.body.serverStats.fiveMinuteStats.req[0]).toBe(30);
    expect(res.body.serverStats.hourStats.req[0]).toBe(30);
  });

  it('should count failures and errors per endpoint and in server stats', async () => {
    const fakeNow = 1717411200000; // fixed timestamp
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/a', (req: express.Request, res: express.Response) => res.status(200).send('a'));
    (app as any).get('/b', (req: express.Request, res: express.Response) => res.status(404).send('fail'));
    (app as any).get('/c', (req: express.Request, res: express.Response) => { throw new Error('fail!'); });
    finish();
    // 10 requests to each endpoint: /a (200), /b (404), /c (500)
    for (let i = 0; i < 10; ++i) {
      await request(app).get('/a').set('Authorization', 'testsecret'); // 200
      await request(app).get('/b').set('Authorization', 'testsecret'); // 404
      await request(app).get('/c').set('Authorization', 'testsecret').catch(() => {}); // 500
    }
    // Check /happy stats
    const res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.status).toBe(200);
    // Endpoints
    expect(res.body.endpoints['GET /a'].req[0]).toBe(10);
    expect(res.body.endpoints['GET /b'].req[0]).toBe(10);
    expect(res.body.endpoints['GET /c'].req[0]).toBe(10);
    expect(res.body.endpoints['GET /b'].fail[0]).toBe(10);
    expect(res.body.endpoints['GET /c'].err[0]).toBe(10);
    // Server stats
    expect(res.body.serverStats.minuteStats.req[0]).toBe(30);
    expect(res.body.serverStats.fiveMinuteStats.req[0]).toBe(30);
    expect(res.body.serverStats.hourStats.req[0]).toBe(30);
    expect(res.body.serverStats.minuteStats.failures[0]).toBe(10);
    expect(res.body.serverStats.fiveMinuteStats.failures[0]).toBe(10);
    expect(res.body.serverStats.hourStats.failures[0]).toBe(10);
    expect(res.body.serverStats.minuteStats.errors[0]).toBe(10);
    expect(res.body.serverStats.fiveMinuteStats.errors[0]).toBe(10);
    expect(res.body.serverStats.hourStats.errors[0]).toBe(10);
  });

  it('should correctly rotate and count stats over several hours with a custom now function', async () => {
    // Start at a fixed time
    let fakeNow = 1717411200000; // 2024-06-03T00:00:00.000Z
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/foo', (req: express.Request, res: express.Response) => res.status(200).send('foo'));
    finish();
    // Simulate 5 requests at t0
    for (let i = 0; i < 5; ++i) {
      await request(app).get('/foo').set('Authorization', 'testsecret');
    }
    // Advance 1 hour
    fakeNow += 60 * 60 * 1000 + 10;
    // Simulate 3 requests at t1
    for (let i = 0; i < 3; ++i) {
      await request(app).get('/foo').set('Authorization', 'testsecret');
    }
    // Advance 1 hour
    fakeNow += 60 * 60 * 1000;
    // Simulate 2 requests at t2
    for (let i = 0; i < 2; ++i) {
      await request(app).get('/foo').set('Authorization', 'testsecret');
    }
    // Check /happy stats
    const res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.status).toBe(200);
    // Endpoint stats: should have 3 nonzero hour buckets
    const fooStats = res.body.endpoints['GET /foo'];
    expect(fooStats.req[0]).toBe(2); // most recent hour
    expect(fooStats.req[1]).toBe(3); // previous hour
    expect(fooStats.req[2]).toBe(5); // oldest hour
    expect(fooStats.req[3]).toBe(0); // should be zero for the oldest hour
    // Server stats: hourStats should also reflect the same
    expect(res.body.serverStats.hourStats.req[0]).toBe(2);
    expect(res.body.serverStats.hourStats.req[1]).toBe(3);
    expect(res.body.serverStats.hourStats.req[2]).toBe(5);
    expect(res.body.serverStats.hourStats.req[3]).toBe(0); // should be zero for the oldest hour
  });

  it('should correctly rotate and count stats over several minutes with a custom now function', async () => {
    let fakeNow = 1717411200000; // 2024-06-03T00:00:00.000Z
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/bar', (req: express.Request, res: express.Response) => res.status(200).send('bar'));
    finish();
    // Simulate 4 requests at t0
    for (let i = 0; i < 4; ++i) {
      await request(app).get('/bar').set('Authorization', 'testsecret');
    }
    // Advance 1 minute
    fakeNow += 61 * 1000;
    // Simulate 3 requests at t1
    for (let i = 0; i < 3; ++i) {
      await request(app).get('/bar').set('Authorization', 'testsecret');
    }
    // Advance 1 minute
    fakeNow += 61 * 1000;
    // Simulate 2 requests at t2
    for (let i = 0; i < 2; ++i) {
      await request(app).get('/bar').set('Authorization', 'testsecret');
    }
    // Check /happy stats
    const res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.status).toBe(200);

    expect(res.body.serverStats.minuteStats.req[0]).toBe(2);
    expect(res.body.serverStats.minuteStats.req[1]).toBe(3);
    expect(res.body.serverStats.minuteStats.req[2]).toBe(4);
    expect(res.body.serverStats.minuteStats.req[3]).toBe(0);
  });

  it('should correctly rotate and count stats over several 5-minute intervals with a custom now function', async () => {
    let fakeNow = 1717411200000; // 2024-06-03T00:00:00.000Z
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/baz', (req: express.Request, res: express.Response) => res.status(200).send('baz'));
    finish();
    // Simulate 6 requests at t0
    for (let i = 0; i < 6; ++i) {
      await request(app).get('/baz').set('Authorization', 'testsecret');
    }
    // Advance 6 minutes
    fakeNow += 6 * 60 * 1000;
    // Simulate 4 requests at t1
    for (let i = 0; i < 4; ++i) {
      await request(app).get('/baz').set('Authorization', 'testsecret');
    }
    // Advance 5 minutes
    fakeNow += 5 * 60 * 1000;
    // Simulate 2 requests at t2
    for (let i = 0; i < 2; ++i) {
      await request(app).get('/baz').set('Authorization', 'testsecret');
    }
    // Check /happy stats
    const res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.status).toBe(200);
    expect(res.body.serverStats.fiveMinuteStats.req[0]).toBe(2);
    expect(res.body.serverStats.fiveMinuteStats.req[1]).toBe(4);
    expect(res.body.serverStats.fiveMinuteStats.req[2]).toBe(6);
    expect(res.body.serverStats.fiveMinuteStats.req[3]).toBe(0);
  });

  it('should handle long gaps in time and reset buckets correctly', async () => {
    let fakeNow = 1717411200000; // 2024-06-03T00:00:00.000Z
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/gap', (req: express.Request, res: express.Response) => res.status(200).send('gap'));
    finish();
    // 3 requests in the first hour
    for (let i = 0; i < 3; ++i) {
      await request(app).get('/gap').set('Authorization', 'testsecret');
    }
    // Check after first hour
    let res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.body.endpoints['GET /gap'].req[0]).toBe(3);
    expect(res.body.serverStats.hourStats.req[0]).toBe(3);
    // Advance 3 hours (no requests)
    fakeNow += 3 * 60 * 60 * 1000;
    // Trigger rotation with a dummy request
    await request(app).get('/gap').set('Authorization', 'testsecret');
    res = await request(app).get('/happy').set('Authorization', 'testsecret');
    // The new request should be in the most recent bucket, old data should be shifted
    expect(res.body.endpoints['GET /gap'].req[0]).toBe(1);
    expect(res.body.endpoints['GET /gap'].req[1]).toBe(0);
    expect(res.body.endpoints['GET /gap'].req[2]).toBe(0);
    expect(res.body.endpoints['GET /gap'].req[3]).toBe(3);
    expect(res.body.serverStats.hourStats.req[0]).toBe(1);
    expect(res.body.serverStats.hourStats.req[1]).toBe(0);
    expect(res.body.serverStats.hourStats.req[2]).toBe(0);
    expect(res.body.serverStats.hourStats.req[3]).toBe(4); // 3 /gap + 1 /happy request
    // Advance 3 weeks (no requests)
    fakeNow += 3 * 7 * 24 * 60 * 60 * 1000;
    // Trigger rotation with a dummy request
    await request(app).get('/gap').set('Authorization', 'testsecret');
    res = await request(app).get('/happy').set('Authorization', 'testsecret');
    // All but the most recent bucket should be zeroed out
    expect(res.body.endpoints['GET /gap'].req[0]).toBe(1);
    for (let i = 1; i < res.body.endpoints['GET /gap'].req.length; ++i) {
      expect(res.body.endpoints['GET /gap'].req[i]).toBe(0);
    }
    expect(res.body.serverStats.hourStats.req[0]).toBe(1);
    for (let i = 1; i < res.body.serverStats.hourStats.req.length; ++i) {
      expect(res.body.serverStats.hourStats.req[i]).toBe(0);
    }
  });

  it('should not include the current partial interval in current currentReqPerMin', async () => {
    let fakeNow = 1717411200000; // 2024-06-03T00:00:00.000Z
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/wait', (req: express.Request, res: express.Response) => res.status(200).send('wait'));
    finish();
    // Make a request in the current minute
    await request(app).get('/wait').set('Authorization', 'testsecret');
    // Immediately check /happy: currentReqPerMin should be 0 (not included yet)
    let res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.body.currentReqPerMin).toBe(0);
    // Advance 61 seconds to next minute
    fakeNow += 61 * 1000;
    // Trigger rotation with a dummy request
    await request(app).get('/wait').set('Authorization', 'testsecret');
    res = await request(app).get('/happy').set('Authorization', 'testsecret');
    // Now the previous request should be counted in currentReqPerMin
    expect(res.body.currentReqPerMin).toBeCloseTo(2/3, 5); // 2 requests (/wait and /happy) in the last three minutes
  });

  it('should not include the current partial interval in current currentReqPerSec', async () => {
    let fakeNow = 1717411200000; // 2024-06-03T00:00:00.000Z
    const app = express();
    process.env.HAPPY_SECRET = 'testsecret';
    const finish = initHappyServer(app, { nowFn: () => fakeNow });
    (app as any).get('/wait', (req: express.Request, res: express.Response) => res.status(200).send('wait'));
    finish();
    // Make a request in the current minute
    await request(app).get('/wait').set('Authorization', 'testsecret');
    // Immediately check /happy: currentReqPerSec should be 0 (not included yet)
    let res = await request(app).get('/happy').set('Authorization', 'testsecret');
    expect(res.body.currentReqPerSec).toBe(0);
    // Advance 1 second
    fakeNow += 1001;
    // Trigger rotation with a dummy request
    await request(app).get('/wait').set('Authorization', 'testsecret');
    res = await request(app).get('/happy').set('Authorization', 'testsecret');
    // Now the previous request should be counted in currentReqPerSec
    expect(res.body.currentReqPerSec).toBeCloseTo(2/10, 5); // 2 requests (/wait and /happy) in the last three minutes
  });

  it('should correctly count and rotate per-second stats (secondStats)', async () => {
    const app = express();
    let now = 1_000_000_000_000; // arbitrary epoch ms
    process.env.HAPPY_SECRET = 'none';
    const finish = initHappyServer(app, { nowFn: () => now });
    (app as any).get('/foo', (req: express.Request, res: express.Response) => res.status(200).send('ok'));
    finish();

    // Simulate 3 requests at t=0s
    await request(app).get('/foo');
    await request(app).get('/foo');
    await request(app).get('/foo');

    // Check /happy: all 3 should be in secondStats.req[0]
    let res1 = await request(app).get('/happy').set('Authorization', 'none');
    expect(res1.body.serverStats.secondStats.req[0]).toBe(3);
    expect(res1.body.serverStats.secondStats.req.slice(1).every((v: number) => v == 0)).toBe(true);

    // Advance 1 second, make 2 requests
    now += 1000;
    await request(app).get('/foo');
    await request(app).get('/foo');
    let res2 = await request(app).get('/happy').set('Authorization', 'none');
    expect(res2.body.serverStats.secondStats.req[0]).toBe(2);
    expect(res2.body.serverStats.secondStats.req[1]).toBe(4);
    expect(res2.body.serverStats.secondStats.req.slice(2).every((v: number) => v == 0)).toBe(true);

    // Advance 58 more seconds (total 60), make 1 request
    now += 58 * 1000;
    await request(app).get('/foo');
    let res3 = await request(app).get('/happy').set('Authorization', 'none');
    expect(res3.body.serverStats.secondStats.req[0]).toBe(1);
    expect(res3.body.serverStats.secondStats.req.slice(1, -2).every((v: number) => v == 0)).toBe(true);

    // Advance 1 more second (now 61s since start), make 1 request
    now += 1000;
    await request(app).get('/foo');
    let res4 = await request(app).get('/happy').set('Authorization', 'none');
    expect(res4.body.serverStats.secondStats.req[0]).toBe(1);
    expect(res4.body.serverStats.secondStats.req.slice(2, -1).every((v: number) => v == 0)).toBe(true);
  });

  it('tracks per-second stats and rotates buckets correctly', async () => {
    let now = 1_000_000_000; // arbitrary epoch ms
    const app = express();
    // Use custom nowFn for deterministic time
    const finish = initHappyServer(app, { nowFn: () => now });
    (app as any).get('/foo', (req: any, res: any) => res.status(200).send('ok'));
    finish();

    // First request at t=0
    await request(app).get('/foo');
    let res = await request(app).get('/happy').set('Authorization', process.env.HAPPY_SECRET || 'none');
    expect(res.body.serverStats.secondStats.req[0]).toBe(1);
    // Advance 1 second, trigger rotation
    now += 1000;
    await request(app).get('/foo');
    res = await request(app).get('/happy').set('Authorization', process.env.HAPPY_SECRET || 'none');
    // The new bucket should be at index 0, previous at index 1
    expect(res.body.serverStats.secondStats.req[0]).toBe(1);
    expect(res.body.serverStats.secondStats.req[1]).toBe(2);
    // Advance 2 more seconds (simulate gap)
    now += 2000;
    await request(app).get('/foo');
    res = await request(app).get('/happy').set('Authorization', process.env.HAPPY_SECRET || 'none');
    // Buckets 0: 1 (latest), 1: 0, 2: 0, 3: 1 (oldest)
    expect(res.body.serverStats.secondStats.req[0]).toBe(1);
    expect(res.body.serverStats.secondStats.req[1]).toBe(0);
    expect(res.body.serverStats.secondStats.req[2]).toBe(2);
    expect(res.body.serverStats.secondStats.req[3]).toBe(2);
  });

  it('should return only the four current properties for /happy/quick', async () => {
    const app = express();
    const finish = initHappyServer(app);
    finish();
    // Make a request to increment stats
    await require('supertest')(app).get('/').expect(404);
    // Auth header is required unless HAPPY_SECRET=none
    const secret = process.env.HAPPY_SECRET || 'none';
    const res = await require('supertest')(app)
        .get('/happy/quick')
        .set('Authorization', secret)
        .expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
        'currentErrPerMin',
        'currentFailsPerMin',
        'currentReqPerMin',
        'currentReqPerSec',
        'extensionFailures',
        'trackedValues',
    ].sort());
    expect(res.body.extensionFailures).toEqual([]);
  });

  it('should report quick extension failures in /happy/quick', async () => {
    const { happyServerQuickExtension } = require('./index');
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    const finish = initHappyServer(app);
    finish();

    happyServerQuickExtension['passing'] = () => true;
    happyServerQuickExtension['failing'] = () => false;
    happyServerQuickExtension['throwing'] = () => { throw new Error('boom'); };

    const res = await require('supertest')(app)
        .get('/happy/quick')
        .expect(200);
    expect(res.body.extensionFailures.sort()).toEqual(['failing', 'throwing']);

    delete happyServerQuickExtension['passing'];
    delete happyServerQuickExtension['failing'];
    delete happyServerQuickExtension['throwing'];
  });

  it('should report quick extension failures in /happy', async () => {
    const { happyServerQuickExtension } = require('./index');
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    const finish = initHappyServer(app);
    finish();

    happyServerQuickExtension['ok'] = () => true;
    happyServerQuickExtension['bad'] = () => false;

    const res = await require('supertest')(app)
        .get('/happy')
        .expect(200);
    expect(res.body.extensionFailures).toEqual(['bad']);

    delete happyServerQuickExtension['ok'];
    delete happyServerQuickExtension['bad'];
  });

  it('should track and deduplicate stack traces for errors', async () => {
    // Setup
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    const finish = initHappyServer(app);
    // Route that throws
    (app as any).get('/err1', (req: express.Request, res: express.Response) => { throw new Error('exception1!'); });
    (app as any).get('/err2', (req: express.Request, res: express.Response) => { throw new Error('exception2!'); });
    finish();

    // Make two requests to /err1 (should deduplicate stack)
    await request(app).get('/err1').catch(() => {});
    await request(app).get('/err1').catch(() => {});
    // Make one request to /err2 (different stack)
    await request(app).get('/err2').catch(() => {});
    // Check /happy
    const res = await request(app).get('/happy');
    expect(res.status).toBe(200);
    // There should be two stack traces
    expect(res.body.stackTraces.length).toBe(2);
    // The first stack trace should have times: 2
    expect(res.body.stackTraces[0].times).toBe(2);
    // The second stack trace should have times: 1
    expect(res.body.stackTraces[1].times).toBe(1);
    // The error messages should match
    expect(res.body.stackTraces[0].error).toContain('Error: exception1!');
    expect(res.body.stackTraces[1].error).toContain('Error: exception2!');
  });
});

describe('vitals', () => {
  it('should not include vitals when not enabled', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app);
    const res = await request(app).get('/happy');
    expect(res.status).toBe(200);
    expect(res.body.vitals).toBeUndefined();
  });

  it('should include vitals with correct structure when enabled', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { vitals: {} });
    const res = await request(app).get('/happy');
    expect(res.status).toBe(200);
    expect(res.body.vitals).toBeDefined();
    const v = res.body.vitals;
    expect(typeof v.uptime).toBe('number');
    expect(typeof v.processUptime).toBe('number');
    // current snapshot
    expect(v.current.load).toHaveLength(3);
    expect(typeof v.current.memTotal).toBe('number');
    expect(typeof v.current.memFree).toBe('number');
    expect(Array.isArray(v.current.disks)).toBe(true);
    // snapshot arrays
    expect(Array.isArray(v.minuteSnapshots)).toBe(true);
    expect(Array.isArray(v.fiveMinuteSnapshots)).toBe(true);
    expect(Array.isArray(v.hourSnapshots)).toBe(true);
  });

  it('should include configured disk paths', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { vitals: { diskPaths: ['/', '/tmp'] } });
    const res = await request(app).get('/happy');
    const disks = res.body.vitals.current.disks;
    expect(disks).toHaveLength(2);
    expect(disks[0].path).toBe('/');
    expect(disks[1].path).toBe('/tmp');
    expect(typeof disks[0].total).toBe('number');
    expect(typeof disks[0].free).toBe('number');
    expect(disks[0].total).toBeGreaterThan(0);
  });

  it('should default disk paths to [/]', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { vitals: {} });
    const res = await request(app).get('/happy');
    const disks = res.body.vitals.current.disks;
    expect(disks).toHaveLength(1);
    expect(disks[0].path).toBe('/');
  });

  it('should handle invalid disk paths gracefully', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { vitals: { diskPaths: ['/nonexistent-path-xyz'] } });
    const res = await request(app).get('/happy');
    const disks = res.body.vitals.current.disks;
    expect(disks).toHaveLength(1);
    expect(disks[0].path).toBe('/nonexistent-path-xyz');
    expect(disks[0].total).toBe(0);
    expect(disks[0].free).toBe(0);
  });

  it('should collect initial snapshot on init', async () => {
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { vitals: {} });
    const res = await request(app).get('/happy');
    // Should have at least the initial snapshot
    expect(res.body.vitals.minuteSnapshots.length).toBeGreaterThanOrEqual(1);
  });

  it('should accumulate minute snapshots via collectVitalsNow', async () => {
    let fakeNow = 1717411200000;
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { nowFn: () => fakeNow, vitals: {} });

    // Initial snapshot is at t0 — advance 1 minute and collect
    fakeNow += 60 * 1000;
    collectVitalsNow();
    fakeNow += 60 * 1000;
    collectVitalsNow();

    const res = await request(app).get('/happy');
    // Initial + 2 manual collections = 3 minute snapshots
    expect(res.body.vitals.minuteSnapshots.length).toBe(3);
  });

  it('should store 5-minute snapshots on boundary crossings', async () => {
    let fakeNow = 1717411200000; // aligned to 5-min boundary
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { nowFn: () => fakeNow, vitals: {} });

    // Advance 5 minutes and collect
    fakeNow += 5 * 60 * 1000;
    collectVitalsNow();

    // Advance another 5 minutes and collect
    fakeNow += 5 * 60 * 1000;
    collectVitalsNow();

    const res = await request(app).get('/happy');
    // Initial (on boundary) + 2 boundary crossings = 3
    expect(res.body.vitals.fiveMinuteSnapshots.length).toBe(3);
  });

  it('should store hour snapshots on boundary crossings', async () => {
    let fakeNow = 1717412400000; // aligned to hour boundary
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { nowFn: () => fakeNow, vitals: {} });

    // Advance 1 hour and collect
    fakeNow += 60 * 60 * 1000;
    collectVitalsNow();

    // Advance another hour and collect
    fakeNow += 60 * 60 * 1000;
    collectVitalsNow();

    const res = await request(app).get('/happy');
    // Initial (on boundary) + 2 boundary crossings = 3
    expect(res.body.vitals.hourSnapshots.length).toBe(3);
  });

  it('should not store 5-min snapshot when boundary not crossed', async () => {
    let fakeNow = 1717411200000;
    const app = express();
    process.env.HAPPY_SECRET = 'none';
    initHappyServer(app, { nowFn: () => fakeNow, vitals: {} });

    // Advance only 2 minutes (no 5-min boundary crossing)
    fakeNow += 2 * 60 * 1000;
    collectVitalsNow();

    const res = await request(app).get('/happy');
    // Only the initial snapshot on the boundary
    expect(res.body.vitals.fiveMinuteSnapshots.length).toBe(1);
  });
});

describe('shutdown', () => {
  it('should return 404 when HAPPY_SECRET is not set', async () => {
    delete process.env.HAPPY_SECRET;
    const app = express();
    initHappyServer(app);
    const res = await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'x', waitS: 10, message: 'bye', logMessage: 'log' });
    expect(res.status).toBe(404);
  });

  it('should reject wrong secret', async () => {
    process.env.HAPPY_SECRET = 'correct';
    const app = express();
    initHappyServer(app);
    const res = await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'wrong', waitS: 10, message: 'bye', logMessage: 'log' });
    expect(res.status).toBe(401);
  });

  it('should reject invalid waitS', async () => {
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    initHappyServer(app);
    const res = await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: -1, message: 'bye', logMessage: 'log' });
    expect(res.status).toBe(400);
  });

  it('should schedule shutdown and report via GET', async () => {
    let fakeNow = 1000000;
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    const exitCalls: number[] = [];
    initHappyServer(app, { nowFn: () => fakeNow, _exitFn: (code) => exitCalls.push(code) });

    const postRes = await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 300, message: 'Going down', logMessage: 'maintenance' });
    expect(postRes.status).toBe(200);
    expect(postRes.body.ok).toBe(true);
    expect(postRes.body.shutdownInS).toBe(300);

    // GET should report shutdown info
    const getRes = await request(app)
      .get('/happy/shutdown')
      .set('Authorization', 'mysecret');
    expect(getRes.status).toBe(200);
    expect(getRes.body.secondsTillShutdown).toBe(300);
    expect(getRes.body.message).toBe('Going down');
    expect(getRes.body.logMessage).toBe('maintenance');
  });

  it('should report decreasing time via happyTimeTillShutdownS()', async () => {
    let fakeNow = 1000000;
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    initHappyServer(app, { nowFn: () => fakeNow, _exitFn: () => {} });

    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 300, message: 'm', logMessage: 'l' });

    expect(happyTimeTillShutdownS()).toBe(300);

    fakeNow += 100_000; // advance 100s
    expect(happyTimeTillShutdownS()).toBe(200);
  });

  it('should cancel shutdown via DELETE', async () => {
    let fakeNow = 1000000;
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    initHappyServer(app, { nowFn: () => fakeNow, _exitFn: () => {} });

    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 300, message: 'm', logMessage: 'l' });

    const delRes = await request(app)
      .delete('/happy/shutdown')
      .set('Authorization', 'mysecret');
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);

    // GET should report no shutdown
    const getRes = await request(app)
      .get('/happy/shutdown')
      .set('Authorization', 'mysecret');
    expect(getRes.body.secondsTillShutdown).toBeNull();
    expect(getRes.body.message).toBeNull();

    // Function should return undefined
    expect(happyTimeTillShutdownS()).toBeUndefined();
  });

  it('should block requests when within noRequestBeforeShutdownS of shutdown', async () => {
    let fakeNow = 1000000;
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    initHappyServer(app, {
      nowFn: () => fakeNow,
      _exitFn: () => {},
      noRequestBeforeShutdownS: 10,
    });
    (app as any).get('/test', (req: express.Request, res: express.Response) => res.status(200).send('ok'));

    // Schedule shutdown in 30s
    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 30, message: 'm', logMessage: 'l' });

    // Requests should still work (30s > 10s buffer)
    let res = await request(app).get('/test');
    expect(res.status).toBe(200);

    // Advance to within 10s of shutdown
    fakeNow += 21_000; // 9s remaining
    res = await request(app).get('/test');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Server is shutting down');
  });

  it('should call exitFn and log on shutdown', async () => {
    jest.useFakeTimers();
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    const exitCalls: number[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    initHappyServer(app, { _exitFn: (code) => exitCalls.push(code) });

    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 5, message: 'User msg', logMessage: 'Internal log' });

    expect(exitCalls).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(5000);
    expect(exitCalls).toEqual([0]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('User msg')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Internal log')
    );

    logSpy.mockRestore();
    jest.useRealTimers();
  });

  it('should require auth for DELETE and GET', async () => {
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    initHappyServer(app);

    const delRes = await request(app).delete('/happy/shutdown');
    expect(delRes.status).toBe(401);

    const getRes = await request(app).get('/happy/shutdown');
    expect(getRes.status).toBe(401);
  });

  it('should await async onBeforeShutdown callbacks before exiting', async () => {
    jest.useFakeTimers();
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    const exitCalls: number[] = [];
    initHappyServer(app, { _exitFn: (code) => exitCalls.push(code) });

    const order: string[] = [];
    let resolveFlush!: () => void;
    onBeforeShutdown(async () => {
      order.push('flush-start');
      await new Promise<void>(r => { resolveFlush = r; });
      order.push('flush-done');
    });

    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 5, message: 'm', logMessage: 'l' });

    await jest.advanceTimersByTimeAsync(5000);
    expect(order).toEqual(['flush-start']);
    expect(exitCalls).toHaveLength(0);

    resolveFlush();
    await jest.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['flush-start', 'flush-done']);
    expect(exitCalls).toEqual([0]);
    jest.useRealTimers();
  });

  it('should exit anyway when a before-shutdown callback hangs past the cap', async () => {
    jest.useFakeTimers();
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    const exitCalls: number[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    initHappyServer(app, { _exitFn: (code) => exitCalls.push(code) });

    onBeforeShutdown(() => new Promise<void>(() => {})); // never resolves

    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 5, message: 'm', logMessage: 'l' });

    await jest.advanceTimersByTimeAsync(5000);
    expect(exitCalls).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(exitCalls).toEqual([0]);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('did not finish within'));

    errSpy.mockRestore();
    jest.useRealTimers();
  });

  it('should log errors from failing before-shutdown callbacks and still exit', async () => {
    jest.useFakeTimers();
    process.env.HAPPY_SECRET = 'mysecret';
    const app = express();
    const exitCalls: number[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    initHappyServer(app, { _exitFn: (code) => exitCalls.push(code) });

    onBeforeShutdown(async () => { throw new Error('flush failed'); });

    await request(app)
      .post('/happy/shutdown')
      .send({ secret: 'mysecret', waitS: 5, message: 'm', logMessage: 'l' });

    await jest.advanceTimersByTimeAsync(5000);
    expect(exitCalls).toEqual([0]);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('before-shutdown callback failed'),
      expect.any(Error)
    );

    errSpy.mockRestore();
    jest.useRealTimers();
  });
});
