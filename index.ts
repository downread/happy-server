import express, { type Request, type Response, type NextFunction } from 'express';
import * as os from 'os';
import * as fs from 'fs';

// --- Types ---
interface StatArray {
    lastUpdate: number;
    req: number[];
    failures: number[];
    errors: number[];
    sum: number[];
    slow: number[];
}

interface EndpointStats {
    lastUpdate: number;
    req: number[];
    fail: number[];
    err: number[];
    sum: number[];
}

interface StackTraceInfo {
    error: string;
    last: string;
    times: number;
    route: string;
}

export interface VitalSnapshot {
    load: [number, number, number];
    memTotal: number;
    memFree: number;
    disks: { path: string; total: number; free: number }[];
}

/** One member device of a Linux software RAID (md) array, as listed in /proc/mdstat. */
export interface RaidDevice {
    name: string;    // e.g. 'sda1'
    failed: boolean; // marked (F) in mdstat
    spare: boolean;  // marked (S) in mdstat
}

/** One md array parsed from /proc/mdstat. */
export interface RaidArray {
    name: string;            // e.g. 'md0'
    state: string;           // 'active', 'inactive', 'active (auto-read-only)', ...
    level?: string;          // 'raid1', 'raid5', ... (absent for inactive arrays)
    devices: RaidDevice[];
    blocks?: number;
    total?: number;          // expected number of devices, from '[2/2]'
    active?: number;         // working devices, from '[2/2]'
    status?: string;         // per-slot status string, e.g. 'UU' or '_U' ('_' = missing/failed)
    healthy: boolean;        // active and no slot missing
    /** In-progress recovery/resync/reshape/check. `percent` is absent while DELAYED/PENDING (see `finish`). */
    operation?: { type: string; percent?: number; finish?: string; speed?: string };
}

export interface RaidStatus {
    healthy: boolean;
    arrays: RaidArray[];
}

interface VitalsState {
    lastMinuteCollect: number;
    lastFiveMinCollect: number;
    lastHourCollect: number;
    minuteSnapshots: VitalSnapshot[];
    fiveMinuteSnapshots: VitalSnapshot[];
    hourSnapshots: VitalSnapshot[];
}

interface HappyServerState {
    serverStats: {
        secondStats: StatArray;
        minuteStats: StatArray;
        fiveMinuteStats: StatArray;
        hourStats: StatArray;
    };
    endpoints: Record<string, EndpointStats>;
    stackTraces: StackTraceInfo[];
    endpointOrder: string[];
}

export interface HappyServerResponse {
    running: boolean;
    plannedShutdownIn: number | null;
    currentReqPerSec: number;
    currentReqPerMin: number;
    currentFailsPerMin: number;
    currentErrPerMin: number;
    extensionFailures: string[];
    stackTraces: StackTraceInfo[];
    serverStats: {
        secondStats: StatArray;
        minuteStats: StatArray;
        fiveMinuteStats: StatArray;
        hourStats: StatArray;
    };
    endpoints: Record<string, EndpointStats>;
    extensions: Record<string, any>;
    trackedValues: Record<string, TrackedValueSnapshot>;
    vitals?: {
        uptime: number;
        processUptime: number;
        current: VitalSnapshot;
        minuteSnapshots: VitalSnapshot[];
        fiveMinuteSnapshots: VitalSnapshot[];
        hourSnapshots: VitalSnapshot[];
        /** Software RAID status; omitted when the host has no md arrays (no /proc/mdstat, e.g. macOS). */
        raid?: RaidStatus;
    };
}

export type HappyQuickResponse = Pick<HappyServerResponse, 'currentReqPerSec' | 'currentReqPerMin' | 'currentFailsPerMin' | 'currentErrPerMin' | 'extensionFailures' | 'trackedValues'>;

export interface TrackedValueSnapshot {
    currentMinute: number;
    currentHour: number;
    currentDay: number;
    minuteHistory: number[];
    hourHistory: number[];
    dayHistory: number[];
}

export interface TrackedValueOptions {
    minuteCount?: number;  // default 120
    hourCount?: number;    // default 72
    dayCount?: number;     // default 90
    collect?: (name: string) => number;
}

interface TrackedValueState {
    options: Required<Pick<TrackedValueOptions, 'minuteCount' | 'hourCount' | 'dayCount'>>;
    collect?: (name: string) => number;
    lastMinuteCollect: number;
    lastHourCollect: number;
    lastDayCollect: number;
    currentValue: number;
    minuteHistory: number[];
    hourHistory: number[];
    dayHistory: number[];
}

export interface HappyServerOptions {
    nowFn?: () => number;
    vitals?: {
        diskPaths?: string[];
        /** Where to read Linux software RAID status from. Default '/proc/mdstat'. */
        mdstatPath?: string;
    };
    noRequestBeforeShutdownS?: number;
    /** @internal Override process.exit for testing */
    _exitFn?: (code: number) => void;
}

// --- Constants ---
const SECONDS = 60;
const MINUTES = 120;
const FIVE_MINUTES = 12 * 48; // 48h, 12 per hour
const HOURS = 24 * 14; // 14d, 24 per day
const ENDPOINT_HOURS = 26;
const MAX_ENDPOINTS = 100;
const MAX_STACKTRACES = 10;

// --- Helpers ---
function getRouteKey(req: Request) {
    return `${req.method} ${req.route ? req.route.path : req.path}`;
}
function rotate(arr: number[], size: number, count: number) {
    if (!count)
        return;
    if (count >= size) {
        arr.length = size;
        arr.fill(0);
        return;
    }
    arr.length = Math.max(size - count, 0);
    if (count == 1)
        arr.unshift(0);
    else
        arr.splice(0, 0, ...Array(Math.min(count, size)).fill(0));
}



// --- Main State ---
const state: HappyServerState = {
    serverStats: {
        secondStats: { lastUpdate: 0, req: [], failures: [], errors: [], sum: [], slow: [] },
        minuteStats: { lastUpdate: 0, req: [], failures: [], errors: [], sum: [], slow: [] },
        fiveMinuteStats: { lastUpdate: 0, req: [], failures: [], errors: [], sum: [], slow: [] },
        hourStats: { lastUpdate: 0, req: [], failures: [], errors: [], sum: [], slow: [] },
    },
    endpoints: {},
    stackTraces: [],
    endpointOrder: [],
};

let nowFn: () => number = Date.now;

// --- Shutdown State ---
let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
let shutdownAtMs: number | undefined;
let shutdownMessage: string | undefined;
let shutdownLogMessage: string | undefined;
let noRequestBeforeShutdownS = 10;
let exitFn: (code: number) => void = (code) => process.exit(code);
let shutdownChangeCallbacks: ((planned: boolean, secondsTillShutdown: number | undefined, message: string | undefined) => void)[] = [];
let beforeShutdownCallbacks: ((message: string | undefined, logMessage: string | undefined) => void | Promise<void>)[] = [];
let sigintHandler: (() => void) | undefined;
let sigtermHandler: (() => void) | undefined;
let beforeShutdownRunning = false;

/** Register a callback invoked when a shutdown is planned or cancelled. */
export function onShutdownChange(cb: (planned: boolean, secondsTillShutdown: number | undefined, message: string | undefined) => void) {
    shutdownChangeCallbacks.push(cb);
    return () => { shutdownChangeCallbacks = shutdownChangeCallbacks.filter(c => c != cb); };
}

/**
 * Register a callback invoked just before the server shuts down.
 * Async callbacks are awaited (all in parallel, capped at BEFORE_SHUTDOWN_TIMEOUT_MS)
 * before the process exits — use this to flush pending writes.
 */
export function onBeforeShutdown(cb: (message: string | undefined, logMessage: string | undefined) => void | Promise<void>) {
    beforeShutdownCallbacks.push(cb);
    return () => { beforeShutdownCallbacks = beforeShutdownCallbacks.filter(c => c != cb); };
}

const BEFORE_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Runs all before-shutdown callbacks, awaiting async ones, then exits.
 * Exit happens after at most BEFORE_SHUTDOWN_TIMEOUT_MS even if a callback hangs,
 * so the process terminates cleanly before systemd's SIGKILL window.
 * If called again while callbacks are still running, exits immediately.
 */
function runBeforeShutdownAndExit(code: number) {
    if (beforeShutdownRunning) {
        console.log('[happy-server] Shutdown already in progress — exiting immediately.');
        exitFn(code);
        return;
    }
    beforeShutdownRunning = true;
    const work = Promise.all(beforeShutdownCallbacks.map(async cb => {
        try {
            await cb(shutdownMessage, shutdownLogMessage);
        } catch (e) {
            console.error('[happy-server] before-shutdown callback failed:', e);
        }
    }));
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>(resolve => {
        capTimer = setTimeout(() => {
            console.error(`[happy-server] before-shutdown callbacks did not finish within ${BEFORE_SHUTDOWN_TIMEOUT_MS / 1000}s — exiting anyway.`);
            resolve();
        }, BEFORE_SHUTDOWN_TIMEOUT_MS);
        capTimer.unref?.();
    });
    Promise.race([work, cap]).then(() => {
        if (capTimer) clearTimeout(capTimer);
        exitFn(code);
    });
}

/** Returns seconds until planned shutdown, or undefined if none is planned. */
export function happyTimeTillShutdownS(): number | undefined {
    if (shutdownAtMs == null) return undefined;
    return Math.max(0, (shutdownAtMs - nowFn()) / 1000);
}

/** Returns shutdown info if a shutdown is planned, or undefined otherwise. */
export function happyShutdownInfo(): { message: string; secondsTillShutdown: number } | undefined {
    if (shutdownAtMs == null) return undefined;
    return { message: shutdownMessage || '', secondsTillShutdown: Math.max(0, (shutdownAtMs - nowFn()) / 1000) };
}

// --- Vitals State ---
let vitalsEnabled = false;
let vitalsDiskPaths: string[] = ['/'];
let vitalsMdstatPath = '/proc/mdstat';
let lastRaidStatus: RaidStatus | undefined;
const vitalsState: VitalsState = {
    lastMinuteCollect: 0,
    lastFiveMinCollect: 0,
    lastHourCollect: 0,
    minuteSnapshots: [],
    fiveMinuteSnapshots: [],
    hourSnapshots: [],
};

function collectSnapshot(): VitalSnapshot {
    const load = os.loadavg() as [number, number, number];
    const memTotal = os.totalmem();
    const memFree = os.freemem();
    const disks = vitalsDiskPaths.map(path => {
        try {
            const stats = fs.statfsSync(path);
            const total = stats.blocks * stats.bsize;
            const free = stats.bavail * stats.bsize;
            return { path, total, free };
        } catch {
            return { path, total: 0, free: 0 };
        }
    });
    return { load, memTotal, memFree, disks };
}

const RAID_LEVELS = /^(raid\d+|linear|multipath|faulty)$/;

/**
 * Parses the content of /proc/mdstat. See https://kb.server4you.com/hardware/raid/status —
 * a healthy RAID 1 shows '[2/2] [UU]', a degraded one '[2/1] [_U]'.
 */
export function parseMdstat(text: string): RaidArray[] {
    const arrays: RaidArray[] = [];
    let current: RaidArray | undefined;
    for (const line of text.split('\n')) {
        const header = line.match(/^(md\d+)\s*:\s*(.*)$/);
        if (header) {
            const tokens = header[2].trim().split(/\s+/);
            let state = tokens.shift() || '';
            if (tokens[0]?.startsWith('(')) state += ' ' + tokens.shift();
            const level = tokens[0] && RAID_LEVELS.test(tokens[0]) ? tokens.shift() : undefined;
            const devices = tokens.map(t => {
                const m = t.match(/^([^\[(]+)(?:\[\d+\])?(.*)$/);
                const flags = m?.[2] || '';
                return { name: m?.[1] || t, failed: flags.includes('(F)'), spare: flags.includes('(S)') };
            });
            current = { name: header[1], state, level, devices, healthy: state.startsWith('active') && !devices.some(d => d.failed) };
            arrays.push(current);
            continue;
        }
        if (!current) continue;
        if (!line.trim()) {
            current = undefined;
            continue;
        }
        const blocks = line.match(/(\d+) blocks/);
        if (blocks) {
            current.blocks = Number(blocks[1]);
            const slots = line.match(/\[(\d+)\/(\d+)\]\s*\[([U_]+)\]/);
            if (slots) {
                current.total = Number(slots[1]);
                current.active = Number(slots[2]);
                current.status = slots[3];
                current.healthy = current.state.startsWith('active') && !current.status.includes('_');
            }
            continue;
        }
        const op = line.match(/(recovery|resync|reshape|check)\s*=\s*(\S+)/);
        if (op) {
            const percent = op[2].endsWith('%') ? parseFloat(op[2]) : undefined;
            current.operation = {
                type: op[1],
                percent,
                finish: line.match(/finish=(\S+)/)?.[1] ?? (percent == undefined ? op[2] : undefined),
                speed: line.match(/speed=(\S+)/)?.[1],
            };
        }
    }
    return arrays;
}

/** Reads the software RAID status. Undefined if there is no mdstat file or it lists no arrays. */
function readRaidStatus(): RaidStatus | undefined {
    let text: string;
    try {
        text = fs.readFileSync(vitalsMdstatPath, 'utf8');
    } catch {
        return undefined;
    }
    const arrays = parseMdstat(text);
    if (!arrays.length) return undefined;
    return { healthy: arrays.every(a => a.healthy), arrays };
}

function storeVitalSnapshot() {
    const now = nowFn();
    const snapshot = collectSnapshot();
    lastRaidStatus = readRaidStatus();

    // Always push to minute
    vitalsState.minuteSnapshots.unshift(snapshot);
    if (vitalsState.minuteSnapshots.length > MINUTES)
        vitalsState.minuteSnapshots.length = MINUTES;

    // Every 5 minutes
    if (Math.floor(now / (5 * 60 * 1000)) != Math.floor(vitalsState.lastFiveMinCollect / (5 * 60 * 1000))) {
        vitalsState.fiveMinuteSnapshots.unshift(snapshot);
        if (vitalsState.fiveMinuteSnapshots.length > FIVE_MINUTES)
            vitalsState.fiveMinuteSnapshots.length = FIVE_MINUTES;
        vitalsState.lastFiveMinCollect = now;
    }

    // Every hour
    if (Math.floor(now / (60 * 60 * 1000)) != Math.floor(vitalsState.lastHourCollect / (60 * 60 * 1000))) {
        vitalsState.hourSnapshots.unshift(snapshot);
        if (vitalsState.hourSnapshots.length > HOURS)
            vitalsState.hourSnapshots.length = HOURS;
        vitalsState.lastHourCollect = now;
    }

    vitalsState.lastMinuteCollect = now;
}

/** Trigger vitals collection manually (for testing). No-op if vitals not enabled. */
export function collectVitalsNow() {
    if (vitalsEnabled) storeVitalSnapshot();
}

// --- Tracked Values ---
const trackedValues: Record<string, TrackedValueState> = {};
let trackedValuesTimer: ReturnType<typeof setInterval> | undefined;

const DEFAULT_TRACKED_MINUTE_COUNT = 120;
const DEFAULT_TRACKED_HOUR_COUNT = 72;
const DEFAULT_TRACKED_DAY_COUNT = 90;

/** Register a tracked value. */
export function registerTrackedValue(name: string, options?: TrackedValueOptions) {
    const now = nowFn();
    trackedValues[name] = {
        options: {
            minuteCount: options?.minuteCount ?? DEFAULT_TRACKED_MINUTE_COUNT,
            hourCount: options?.hourCount ?? DEFAULT_TRACKED_HOUR_COUNT,
            dayCount: options?.dayCount ?? DEFAULT_TRACKED_DAY_COUNT,
        },
        collect: options?.collect,
        lastMinuteCollect: now,
        lastHourCollect: now,
        lastDayCollect: now,
        currentValue: options?.collect ? options.collect(name) : 0,
        minuteHistory: [],
        hourHistory: [],
        dayHistory: [],
    };
}

/** Unregister a tracked value. */
export function unregisterTrackedValue(name: string) {
    delete trackedValues[name];
}

/** Set a tracked value to a new absolute value. */
export function trackedValueChanged(name: string, newValue: number) {
    const tv = trackedValues[name];
    if (tv) tv.currentValue = newValue;
}

/** Adjust a tracked value by a delta (default +1). */
export function trackedValueDelta(name: string, delta = 1) {
    const tv = trackedValues[name];
    if (tv) tv.currentValue += delta;
}

function collectTrackedValues() {
    const now = nowFn();
    for (const [name, tv] of Object.entries(trackedValues)) {
        if (tv.collect) tv.currentValue = tv.collect(name);

        // Minute rotation
        if (Math.floor(now / 60_000) != Math.floor(tv.lastMinuteCollect / 60_000)) {
            tv.minuteHistory.unshift(tv.currentValue);
            if (tv.minuteHistory.length > tv.options.minuteCount)
                tv.minuteHistory.length = tv.options.minuteCount;
            tv.lastMinuteCollect = now;
        }

        // Hour rotation
        if (Math.floor(now / 3_600_000) != Math.floor(tv.lastHourCollect / 3_600_000)) {
            tv.hourHistory.unshift(tv.currentValue);
            if (tv.hourHistory.length > tv.options.hourCount)
                tv.hourHistory.length = tv.options.hourCount;
            tv.lastHourCollect = now;
        }

        // Day rotation
        if (Math.floor(now / 86_400_000) != Math.floor(tv.lastDayCollect / 86_400_000)) {
            tv.dayHistory.unshift(tv.currentValue);
            if (tv.dayHistory.length > tv.options.dayCount)
                tv.dayHistory.length = tv.options.dayCount;
            tv.lastDayCollect = now;
        }
    }
}

/** Trigger tracked value collection manually (for testing). */
export function collectTrackedValuesNow() {
    collectTrackedValues();
}

function getTrackedValuesSnapshot(): Record<string, TrackedValueSnapshot> {
    const result: Record<string, TrackedValueSnapshot> = {};
    for (const [name, tv] of Object.entries(trackedValues)) {
        if (tv.collect) tv.currentValue = tv.collect(name);
        result[name] = {
            currentMinute: tv.currentValue,
            currentHour: tv.currentValue,
            currentDay: tv.currentValue,
            minuteHistory: tv.minuteHistory,
            hourHistory: tv.hourHistory,
            dayHistory: tv.dayHistory,
        };
    }
    return result;
}

// --- Middleware ---
function happyMiddleware(req: Request, res: Response, next: NextFunction) {
    // Block requests when shutdown is imminent
    if (shutdownAtMs != null) {
        const secondsTillShutdown = (shutdownAtMs - nowFn()) / 1000;
        if (secondsTillShutdown <= noRequestBeforeShutdownS)
            return res.status(503).json({ error: 'Server is shutting down' });
    }

    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const duration = Number(process.hrtime.bigint() - start) / 1e6; // ms
        const code = res.statusCode;
        const isFail = code >= 400 && code < 500;
        const isErr = code >= 500;
        // --- Rotate server stats ---
        const now = nowFn();
        ([['secondStats', SECONDS, 1000], ['minuteStats', MINUTES, 60*1000], ['fiveMinuteStats', FIVE_MINUTES, 5*60*1000], ['hourStats', HOURS, 60*60*1000]] as const).forEach(([key, size, interval]) => {
            const stats = (state.serverStats as any)[key];
            const rotationCount = Math.floor(now / interval) - Math.floor(stats.lastUpdate / interval);
            if (rotationCount)
                (['req', 'failures', 'errors', 'sum', 'slow'] as (keyof StatArray)[]).forEach((k) => {
                    rotate(stats[k], size, rotationCount);
                });
            stats.lastUpdate = now;
        });
        // --- Update server stats ---
        const s = state.serverStats;
        s.secondStats.req[0] += 1;
        s.minuteStats.req[0] += 1;
        s.fiveMinuteStats.req[0] += 1;
        s.hourStats.req[0] += 1;
        s.secondStats.sum[0] += duration;
        s.minuteStats.sum[0] += duration;
        s.fiveMinuteStats.sum[0] += duration;
        s.hourStats.sum[0] += duration;
        if (isFail) {
            s.secondStats.failures[0] += 1;
            s.minuteStats.failures[0] += 1;
            s.fiveMinuteStats.failures[0] += 1;
            s.hourStats.failures[0] += 1;
        }
        if (isErr) {
            s.secondStats.errors[0] += 1;
            s.minuteStats.errors[0] += 1;
            s.fiveMinuteStats.errors[0] += 1;
            s.hourStats.errors[0] += 1;
        }
        // --- Slow requests ---
        const prevAvg = s.minuteStats.sum[1] / (s.minuteStats.req[1] || 1);
        if (duration >= 2 * prevAvg && s.minuteStats.req[1] > 0) {
            s.secondStats.slow[0] += 1;
            s.minuteStats.slow[0] += 1;
            s.fiveMinuteStats.slow[0] += 1;
            s.hourStats.slow[0] += 1;
        }
        // --- Endpoint stats ---
        const routeKey = getRouteKey(req);
        if (!state.endpoints[routeKey]) {
            if (state.endpointOrder.length >= MAX_ENDPOINTS) {
                // Remove oldest
                const oldest = state.endpointOrder.shift();
                if (oldest) delete state.endpoints[oldest];
            }
            state.endpoints[routeKey] = { lastUpdate: now, req: Array(ENDPOINT_HOURS).fill(0), fail: Array(ENDPOINT_HOURS).fill(0), err: Array(ENDPOINT_HOURS).fill(0), sum: Array(ENDPOINT_HOURS).fill(0) };
            state.endpointOrder.push(routeKey);
        }
        const ep = state.endpoints[routeKey];
        const rotationCount = Math.floor(now / (60 * 60 * 1000)) - Math.floor(ep.lastUpdate / (60 * 60 * 1000));
        rotate(ep.req, ENDPOINT_HOURS, rotationCount);
        rotate(ep.fail, ENDPOINT_HOURS, rotationCount);
        rotate(ep.err, ENDPOINT_HOURS, rotationCount);
        rotate(ep.sum, ENDPOINT_HOURS, rotationCount);
        ep.req[0] += 1;
        ep.sum[0] += duration;
        if (isFail) ep.fail[0] += 1;
        if (isErr) ep.err[0] += 1;
        ep.lastUpdate = now;
    });
    next();
}

// --- Error handler for stack traces ---
function happyErrorHandler(err: any, req: Request, res: Response, next: NextFunction) {
    if (res.headersSent) return next(err);
    const stack = err && err.stack ? err.stack : String(err);
    const routeKey = getRouteKey(req);
    let found = state.stackTraces.find((s) => s.error === stack);
    if (found) {
        found.last = new Date().toISOString();
        found.times++;
        found.route = routeKey;
    } else {
        if (state.stackTraces.length >= MAX_STACKTRACES) state.stackTraces.shift();
        state.stackTraces.push({ error: stack, last: new Date().toISOString(), times: 1, route: routeKey });
    }
    next(err);
}

// --- Extension mechanism ---
// Global extension registry for happy-server
export const happyServerExtension: Record<string, () => any> =
    (globalThis as any).happyServerExtension = (globalThis as any).happyServerExtension || {};

// Quick extension registry: boolean checks for /happy/quick
export const happyServerQuickExtension: Record<string, () => boolean> =
    (globalThis as any).happyServerQuickExtension = (globalThis as any).happyServerQuickExtension || {};

// --- Helper to calculate current stats ---
function getCurrentStats(): HappyQuickResponse {
    const s = state.serverStats;
    const reqsSec = s.secondStats.req.slice(1, 11).reduce((a, b) => a + b, 0);
    const currentReqPerSec = reqsSec / 10;
    const reqs = s.minuteStats.req.slice(1, 4).reduce((a, b) => a + b, 0);
    const currentReqPerMin = reqs / 3;
    const fails = s.minuteStats.failures.slice(1, 4).reduce((a, b) => a + b, 0);
    const currentFailsPerMin = fails / 3;
    const errs = s.minuteStats.errors.slice(1, 4).reduce((a, b) => a + b, 0);
    const currentErrPerMin = errs / 3;
    const extensionFailures: string[] = [];
    for (const [key, fn] of Object.entries(happyServerQuickExtension)) {
        try {
            if (!fn()) extensionFailures.push(key);
        } catch {
            extensionFailures.push(key);
        }
    }
    return { currentReqPerSec, currentReqPerMin, currentFailsPerMin, currentErrPerMin, extensionFailures, trackedValues: getTrackedValuesSnapshot() };
}

// --- /happy endpoint ---
function happyEndpoint(req: Request, res: Response) {
    const secret = process.env.HAPPY_SECRET;
    if (secret != 'none' && (!secret || req.header('Authorization') != secret)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const stats = getCurrentStats();
    // Gather extension data
    const extensions: Record<string, any> = {};
    for (const [key, fn] of Object.entries(happyServerExtension)) {
        try {
            extensions[key] = fn();
        } catch (e) {
            extensions[key] = { error: String(e) };
        }
    }
    const response: any = {
        running: true,
        plannedShutdownIn: happyTimeTillShutdownS() ?? null,
        ...stats,
        stackTraces: state.stackTraces,
        serverStats: state.serverStats,
        endpoints: state.endpoints,
        extensions,
    };
    if (vitalsEnabled) {
        response.vitals = {
            uptime: os.uptime(),
            processUptime: process.uptime(),
            current: collectSnapshot(),
            minuteSnapshots: vitalsState.minuteSnapshots,
            fiveMinuteSnapshots: vitalsState.fiveMinuteSnapshots,
            hourSnapshots: vitalsState.hourSnapshots,
            raid: lastRaidStatus = readRaidStatus(),
        };
    }
    res.json(response);
}

// --- /happy/quick endpoint ---
function happyQuickEndpoint(req: Request, res: Response) {
    const secret = process.env.HAPPY_SECRET;
    if (secret != 'none' && (!secret || req.header('Authorization') != secret)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const stats = getCurrentStats();
    res.json(stats);
}

// --- Shutdown endpoints ---
function shutdownPostEndpoint(req: Request, res: Response) {
    const secret = process.env.HAPPY_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not found' });
    const { secret: bodySecret, waitS, message, logMessage, exitCode } = req.body || {};
    if (bodySecret != secret) return res.status(401).json({ error: 'Unauthorized' });
    if (typeof waitS != 'number' || waitS <= 0) return res.status(400).json({ error: 'Invalid waitS' });

    const code = typeof exitCode == 'number' ? exitCode : 0;

    // Clear any existing shutdown
    if (shutdownTimer) clearTimeout(shutdownTimer);

    shutdownMessage = message || '';
    shutdownLogMessage = logMessage || '';
    shutdownAtMs = nowFn() + waitS * 1000;
    shutdownTimer = setTimeout(() => {
        console.log(`Server shutting down now. Message: ${shutdownMessage}. Log: ${shutdownLogMessage}`);
        runBeforeShutdownAndExit(code);
    }, waitS * 1000);
    shutdownTimer.unref();

    shutdownChangeCallbacks.forEach(cb => cb(true, waitS, message));
    res.json({ ok: true, shutdownInS: waitS });
}

function shutdownDeleteEndpoint(req: Request, res: Response) {
    const secret = process.env.HAPPY_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not found' });
    if (req.header('Authorization') != secret) return res.status(401).json({ error: 'Unauthorized' });

    if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
    }
    shutdownAtMs = undefined;
    shutdownMessage = undefined;
    shutdownLogMessage = undefined;
    shutdownChangeCallbacks.forEach(cb => cb(false, undefined, undefined));
    res.json({ ok: true });
}

function shutdownGetEndpoint(req: Request, res: Response) {
    const secret = process.env.HAPPY_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not found' });
    if (req.header('Authorization') != secret) return res.status(401).json({ error: 'Unauthorized' });

    const secondsTillShutdown = happyTimeTillShutdownS();
    res.json({
        secondsTillShutdown: secondsTillShutdown ?? null,
        message: shutdownMessage ?? null,
        logMessage: shutdownLogMessage ?? null,
    });
}

// --- Initialization ---
export function initHappyServer(app: any, options?: HappyServerOptions) {
    if (options?.nowFn) nowFn = options.nowFn;
    else nowFn = Date.now;

    noRequestBeforeShutdownS = options?.noRequestBeforeShutdownS ?? 10;
    exitFn = options?._exitFn ?? ((code) => process.exit(code));

    // --- Reset shutdown state ---
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
    shutdownAtMs = undefined;
    shutdownMessage = undefined;
    shutdownLogMessage = undefined;
    shutdownChangeCallbacks = [];
    beforeShutdownCallbacks = [];
    beforeShutdownRunning = false;

    // --- Vitals setup ---
    vitalsEnabled = !!options?.vitals;
    delete happyServerQuickExtension['raid'];
    if (options?.vitals) {
        vitalsDiskPaths = options.vitals.diskPaths || ['/'];
        vitalsMdstatPath = options.vitals.mdstatPath || '/proc/mdstat';
        // A degraded array is reported as a failed quick check, so /happy/quick consumers
        // (dashboard overview, clawnitor) notice without parsing the full response.
        happyServerQuickExtension['raid'] = () => !lastRaidStatus || lastRaidStatus.healthy;
        vitalsState.minuteSnapshots = [];
        vitalsState.fiveMinuteSnapshots = [];
        vitalsState.hourSnapshots = [];
        vitalsState.lastMinuteCollect = 0;
        vitalsState.lastFiveMinCollect = 0;
        vitalsState.lastHourCollect = 0;
        // Collect initial snapshot
        storeVitalSnapshot();
        // Start periodic collection (unref so it doesn't prevent process exit)
        const timer = setInterval(storeVitalSnapshot, 60_000);
        timer.unref();
    }

    // Initialize arrays
    ([['secondStats', SECONDS], ['minuteStats', MINUTES], ['fiveMinuteStats', FIVE_MINUTES], ['hourStats', HOURS]] as const).forEach(([key, size]) => {
        const stats = (state.serverStats as any)[key];
        (['req', 'failures', 'errors', 'sum', 'slow'] as (keyof StatArray)[]).forEach((k) => {
            stats[k] = Array(size).fill(0);
            stats.lastUpdate = nowFn();
        });
    });
    state.stackTraces = [];
    state.endpoints = {};

    // --- Tracked values setup ---
    for (const key of Object.keys(trackedValues)) delete trackedValues[key];
    if (trackedValuesTimer) clearInterval(trackedValuesTimer);
    trackedValuesTimer = setInterval(collectTrackedValues, 60_000);
    trackedValuesTimer.unref();

    // --- Signal handling ---
    if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
    if (sigtermHandler) process.removeListener('SIGTERM', sigtermHandler);
    const scheduleSignalShutdown = (signal: string, waitS: number) => {
        if (shutdownAtMs != null) {
            console.log(`[happy-server] Received ${signal} again — shutting down immediately.`);
            runBeforeShutdownAndExit(0);
            return;
        }
        console.log(`[happy-server] Received ${signal}. Shutting down in ${waitS}s...`);
        shutdownMessage = signal;
        shutdownLogMessage = signal;
        shutdownAtMs = nowFn() + waitS * 1000;
        shutdownTimer = setTimeout(() => {
            console.log(`[happy-server] Shutdown timer expired. Exiting now.`);
            runBeforeShutdownAndExit(0);
        }, waitS * 1000);
        shutdownTimer.unref();
        shutdownChangeCallbacks.forEach(cb => cb(true, waitS, signal));
    };
    sigintHandler = () => scheduleSignalShutdown('SIGINT', 30);
    sigtermHandler = () => scheduleSignalShutdown('SIGTERM', 5);
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    // Register middleware and endpoints
    app.use(happyMiddleware);
    (app as any).get('/happy', happyEndpoint);
    (app as any).get('/happy/quick', happyQuickEndpoint);
    (app as any).post('/happy/shutdown', express.json(), shutdownPostEndpoint);
    (app as any).delete('/happy/shutdown', shutdownDeleteEndpoint);
    (app as any).get('/happy/shutdown', shutdownGetEndpoint);
    return ()=> app.use(happyErrorHandler);
}
