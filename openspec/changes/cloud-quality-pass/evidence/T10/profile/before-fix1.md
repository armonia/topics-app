# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 16.75s | 57767 | 100us | 318 |

**Top 10:** `all` 48.1%, `from` 20.2%, `mapRow` 7.2%, `previewOf` 5.2%, `(anonymous)` 1.9%, `mapRow` 1.2%, `mapRow` 0.9%, `copyDataProperties` 0.7%, `drawsCardComments` 0.5%, `(anonymous)` 0.5%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 48.1% | 8.06s | 48.1% | 8.06s | `all` | `[native code]` |
| 20.2% | 3.38s | 20.2% | 3.39s | `from` | `[native code]` |
| 7.2% | 1.20s | 7.2% | 1.20s | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2476` |
| 5.2% | 884.0ms | 26.1% | 4.37s | `previewOf` | `/home/user/topics-app/server/services/tasks.ts:1778` |
| 1.9% | 320.0ms | 1.9% | 320.0ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2264` |
| 1.2% | 207.0ms | 1.2% | 207.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2491` |
| 0.9% | 165.3ms | 0.9% | 165.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2481` |
| 0.7% | 122.0ms | 0.7% | 122.0ms | `copyDataProperties` | `[native code]` |
| 0.5% | 100.3ms | 0.5% | 100.3ms | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts:1706` |
| 0.5% | 89.5ms | 0.5% | 89.5ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2300` |
| 0.5% | 83.7ms | 0.5% | 83.7ms | `stringify` | `[native code]` |
| 0.4% | 75.8ms | 0.4% | 75.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2489` |
| 0.4% | 74.4ms | 0.4% | 74.4ms | `Set` | `[native code]` |
| 0.4% | 70.0ms | 0.4% | 70.0ms | `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` | `[native code]` |
| 0.3% | 64.4ms | 0.4% | 71.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2558` |
| 0.3% | 57.2ms | 0.3% | 57.2ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2412` |
| 0.3% | 56.6ms | 48.2% | 8.07s | `map` | `[native code]` |
| 0.2% | 43.9ms | 0.3% | 51.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2557` |
| 0.2% | 41.6ms | 0.2% | 41.6ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2311` |
| 0.2% | 37.4ms | 0.2% | 43.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2561` |
| 0.2% | 36.4ms | 0.2% | 36.4ms | `join` | `[native code]` |
| 0.2% | 36.1ms | 0.2% | 45.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2513` |
| 0.2% | 33.6ms | 0.2% | 33.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2643` |
| 0.1% | 32.4ms | 0.2% | 47.4ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2404` |
| 0.1% | 31.6ms | 0.1% | 31.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2487` |
| 0.1% | 29.8ms | 0.1% | 29.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2365` |
| 0.1% | 29.7ms | 0.2% | 36.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2560` |
| 0.1% | 28.5ms | 0.1% | 28.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2570` |
| 0.1% | 27.8ms | 0.1% | 27.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2492` |
| 0.1% | 27.4ms | 0.1% | 27.4ms | `get` | `[native code]` |
| 0.1% | 27.1ms | 0.1% | 27.1ms | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts:1173` |
| 0.1% | 27.1ms | 0.1% | 27.1ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2357` |
| 0.1% | 26.3ms | 1.0% | 177.3ms | `filter` | `[native code]` |
| 0.1% | 25.6ms | 0.1% | 25.6ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1753` |
| 0.1% | 25.5ms | 0.1% | 25.5ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.1% | 25.1ms | 0.1% | 25.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2608` |
| 0.1% | 24.8ms | 0.1% | 24.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2335` |
| 0.1% | 24.4ms | 0.1% | 26.0ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3754` |
| 0.1% | 24.1ms | 0.1% | 28.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2559` |
| 0.1% | 23.8ms | 0.1% | 23.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2372` |
| 0.1% | 22.2ms | 0.1% | 33.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2598` |
| 0.1% | 20.8ms | 0.1% | 20.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2493` |
| 0.1% | 20.8ms | 0.1% | 32.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2589` |
| 0.1% | 20.4ms | 0.1% | 20.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2621` |
| 0.1% | 20.3ms | 0.1% | 26.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2556` |
| 0.1% | 19.6ms | 0.1% | 25.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2543` |
| 0.1% | 17.5ms | 0.1% | 24.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2544` |
| 0.1% | 17.4ms | 0.1% | 17.4ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2425` |
| 0.1% | 17.0ms | 0.1% | 17.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2575` |
| 0.0% | 16.3ms | 0.0% | 16.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2648` |
| 0.0% | 16.2ms | 0.1% | 21.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2592` |
| 0.0% | 15.8ms | 0.1% | 25.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2520` |
| 0.0% | 15.7ms | 0.0% | 15.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2507` |
| 0.0% | 15.0ms | 0.0% | 15.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2626` |
| 0.0% | 15.0ms | 0.1% | 20.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2542` |
| 0.0% | 15.0ms | 0.0% | 15.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2614` |
| 0.0% | 14.1ms | 0.0% | 14.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2499` |
| 0.0% | 13.9ms | 0.0% | 13.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2572` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2574` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2501` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2500` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2498` |
| 0.0% | 12.6ms | 0.0% | 12.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2497` |
| 0.0% | 12.4ms | 0.0% | 12.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2573` |
| 0.0% | 12.4ms | 0.1% | 19.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2580` |
| 0.0% | 12.0ms | 0.0% | 12.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2620` |
| 0.0% | 11.9ms | 0.0% | 15.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2628` |
| 0.0% | 11.8ms | 0.0% | 15.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2562` |
| 0.0% | 11.7ms | 0.0% | 11.7ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2518` |
| 0.0% | 11.5ms | 0.0% | 11.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2581` |
| 0.0% | 11.2ms | 0.0% | 11.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2622` |
| 0.0% | 11.2ms | 0.0% | 11.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2506` |
| 0.0% | 11.0ms | 0.0% | 11.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2632` |
| 0.0% | 11.0ms | 0.0% | 11.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2639` |
| 0.0% | 10.8ms | 0.0% | 10.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2641` |
| 0.0% | 10.8ms | 0.5% | 84.3ms | `idParam` | `/home/user/topics-app/server/services/tasks.ts:1559` |
| 0.0% | 10.7ms | 0.0% | 10.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2617` |
| 0.0% | 10.7ms | 0.0% | 10.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2615` |
| 0.0% | 10.6ms | 0.0% | 10.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2636` |
| 0.0% | 10.6ms | 0.0% | 10.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2508` |
| 0.0% | 10.4ms | 0.0% | 10.4ms | `Boolean` | `[native code]` |
| 0.0% | 10.2ms | 0.0% | 10.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2637` |
| 0.0% | 10.1ms | 0.0% | 16.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2510` |
| 0.0% | 9.9ms | 0.1% | 27.2ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3759` |
| 0.0% | 9.9ms | 0.0% | 9.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2503` |
| 0.0% | 9.5ms | 0.0% | 9.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2564` |
| 0.0% | 9.5ms | 0.0% | 10.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2631` |
| 0.0% | 9.5ms | 0.0% | 9.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2627` |
| 0.0% | 9.3ms | 0.0% | 9.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2512` |
| 0.0% | 9.3ms | 0.0% | 9.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2642` |
| 0.0% | 9.2ms | 0.0% | 9.2ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2344` |
| 0.0% | 9.1ms | 0.0% | 9.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2504` |
| 0.0% | 9.0ms | 0.0% | 9.0ms | `node:fs` | `node:fs:8` |
| 0.0% | 8.9ms | 0.0% | 8.9ms | `isAgentWorking` | `/home/user/topics-app/shared/board.ts:431` |
| 0.0% | 8.9ms | 0.2% | 36.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2569` |
| 0.0% | 8.8ms | 0.0% | 8.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2509` |
| 0.0% | 8.7ms | 0.0% | 8.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2505` |
| 0.0% | 8.4ms | 0.0% | 8.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2584` |
| 0.0% | 8.4ms | 0.0% | 8.4ms | `query` | `bun:sqlite:345` |
| 0.0% | 8.2ms | 0.0% | 8.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2496` |
| 0.0% | 8.0ms | 0.0% | 8.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2640` |
| 0.0% | 8.0ms | 0.0% | 8.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2511` |
| 0.0% | 7.6ms | 0.0% | 7.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2565` |
| 0.0% | 7.5ms | 0.2% | 38.9ms | `anonymous` | `[native code]` |
| 0.0% | 7.3ms | 0.0% | 7.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2571` |
| 0.0% | 7.2ms | 0.2% | 43.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2357` |
| 0.0% | 6.7ms | 0.0% | 6.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2579` |
| 0.0% | 6.7ms | 0.0% | 6.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2625` |
| 0.0% | 6.5ms | 0.0% | 6.5ms | `toISOString` | `[native code]` |
| 0.0% | 6.3ms | 0.0% | 6.3ms | `query` | `bun:sqlite:341` |
| 0.0% | 6.2ms | 0.0% | 6.2ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2379` |
| 0.0% | 6.1ms | 0.0% | 6.1ms | `now` | `[native code]` |
| 0.0% | 5.8ms | 0.0% | 5.8ms | `readTaskWeight` | `/home/user/topics-app/shared/board.ts:390` |
| 0.0% | 5.7ms | 0.0% | 5.7ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3757` |
| 0.0% | 5.6ms | 0.0% | 5.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2647` |
| 0.0% | 5.2ms | 1.9% | 330.4ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2264` |
| 0.0% | 5.2ms | 0.0% | 5.2ms | `arrayFromFastWithoutMapFn` | `[native code]` |
| 0.0% | 5.2ms | 0.0% | 10.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2588` |
| 0.0% | 4.9ms | 0.0% | 4.9ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2678` |
| 0.0% | 4.8ms | 0.0% | 4.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2279` |
| 0.0% | 4.4ms | 0.4% | 74.6ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1757` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `Date` | `[native code]` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `next` | `[native code]` |
| 0.0% | 4.1ms | 0.0% | 4.1ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2416` |
| 0.0% | 3.9ms | 26.1% | 4.38s | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2488` |
| 0.0% | 3.7ms | 0.0% | 4.6ms | `query` | `bun:sqlite:343` |
| 0.0% | 3.6ms | 0.0% | 3.8ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2679` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `lazyCpus` | `node:os` |
| 0.0% | 3.3ms | 99.7% | 16.68s | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:11` |
| 0.0% | 3.3ms | 0.0% | 3.3ms | `prepare` | `[native code]` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3669` |
| 0.0% | 3.0ms | 0.1% | 17.9ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2344` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1232` |
| 0.0% | 2.2ms | 0.0% | 3.6ms | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1965` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `#all` | `bun:sqlite:157` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `push` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `node:child_process` | `node:child_process:2` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `query` | `bun:sqlite` |
| 0.0% | 2.1ms | 40.9% | 6.85s | `list` | `/home/user/topics-app/server/services/tasks.ts:3764` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `bun:sqlite` | `bun:sqlite:215` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts:2059` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2590` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `some` | `[native code]` |
| 0.0% | 1.8ms | 0.0% | 2.0ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2724` |
| 0.0% | 1.8ms | 0.0% | 6.3ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3763` |
| 0.0% | 1.8ms | 0.7% | 132.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2613` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2688` |
| 0.0% | 1.5ms | 0.6% | 108.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2274` |
| 0.0% | 1.4ms | 10.4% | 1.74s | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2654` |
| 0.0% | 1.4ms | 0.0% | 4.9ms | `query` | `bun:sqlite:347` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2517` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `Map` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1520` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2285` |
| 0.0% | 1.1ms | 1.8% | 312.0ms | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2229` |
| 0.0% | 1.1ms | 0.6% | 102.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2300` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 1.0ms | 0.0% | 2.8ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2384` |
| 0.0% | 950us | 0.0% | 950us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2727` |
| 0.0% | 917us | 0.0% | 917us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1521` |
| 0.0% | 911us | 0.0% | 3.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2610` |
| 0.0% | 908us | 0.0% | 908us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2304` |
| 0.0% | 903us | 0.0% | 903us | `query` | `bun:sqlite:337` |
| 0.0% | 893us | 0.0% | 893us | `createTaskService` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 885us | 0.0% | 885us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2410` |
| 0.0% | 872us | 0.0% | 2.9ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3733` |
| 0.0% | 836us | 0.2% | 34.0ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2365` |
| 0.0% | 821us | 0.0% | 821us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 803us | 0.0% | 803us | `idParam` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 717us | 0.0% | 717us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1824` |
| 0.0% | 711us | 0.0% | 711us | `#all` | `bun:sqlite` |
| 0.0% | 708us | 0.0% | 8.0ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3762` |
| 0.0% | 708us | 0.0% | 708us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1970` |
| 0.0% | 681us | 0.0% | 11.5ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2266` |
| 0.0% | 665us | 0.0% | 665us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2217` |
| 0.0% | 665us | 0.0% | 665us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2677` |
| 0.0% | 648us | 1.3% | 232.8ms | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1969` |
| 0.0% | 583us | 0.0% | 583us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2238` |
| 0.0% | 583us | 0.0% | 809us | `sort` | `[native code]` |
| 0.0% | 516us | 0.0% | 516us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2406` |
| 0.0% | 494us | 0.0% | 494us | `isFinalized` | `bun:sqlite:104` |
| 0.0% | 492us | 0.0% | 492us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2272` |
| 0.0% | 490us | 0.1% | 32.5ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2372` |
| 0.0% | 488us | 0.0% | 488us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts` |
| 0.0% | 483us | 0.0% | 483us | `node:crypto` | `node:crypto:84` |
| 0.0% | 472us | 0.0% | 472us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2224` |
| 0.0% | 447us | 0.1% | 16.8ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2279` |
| 0.0% | 444us | 0.0% | 444us | `list` | `/home/user/topics-app/server/services/tasks.ts:3746` |
| 0.0% | 440us | 0.0% | 440us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2725` |
| 0.0% | 433us | 0.0% | 433us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2413` |
| 0.0% | 427us | 0.0% | 427us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2273` |
| 0.0% | 424us | 0.0% | 424us | `readGlobalDispatch` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 423us | 0.0% | 4.4ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2680` |
| 0.0% | 416us | 0.0% | 416us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2396` |
| 0.0% | 410us | 0.0% | 410us | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2653` |
| 0.0% | 409us | 0.0% | 409us | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 400us | 0.0% | 400us | `delete` | `[native code]` |
| 0.0% | 391us | 0.0% | 13.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2332` |
| 0.0% | 389us | 0.5% | 97.8ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2698` |
| 0.0% | 363us | 0.0% | 363us | `slice` | `[native code]` |
| 0.0% | 298us | 0.0% | 298us | `RegExp` | `[native code]` |
| 0.0% | 275us | 0.0% | 275us | `list` | `/home/user/topics-app/server/services/tasks.ts:3734` |
| 0.0% | 269us | 0.0% | 269us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2595` |
| 0.0% | 258us | 0.0% | 258us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2409` |
| 0.0% | 255us | 0.0% | 255us | `internal:streams/readable` | `internal:streams/readable:55` |
| 0.0% | 254us | 0.0% | 254us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 253us | 0.0% | 253us | `(unknown)` | `[native code]` |
| 0.0% | 253us | 2.8% | 475.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2281` |
| 0.0% | 251us | 0.0% | 3.4ms | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1966` |
| 0.0% | 249us | 0.0% | 249us | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 248us | 0.0% | 248us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2244` |
| 0.0% | 243us | 1.4% | 241.0ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2267` |
| 0.0% | 243us | 0.0% | 243us | `outOfQueuePromise` | `/home/user/topics-app/shared/board.ts:1143` |
| 0.0% | 243us | 0.0% | 243us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2230` |
| 0.0% | 241us | 0.0% | 241us | `answering` | `/home/user/topics-app/server/services/deliveryReportProbe.ts` |
| 0.0% | 241us | 0.0% | 13.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2379` |
| 0.0% | 240us | 0.0% | 240us | `list` | `/home/user/topics-app/server/services/tasks.ts:3694` |
| 0.0% | 240us | 0.0% | 240us | `#allNoArgs` | `bun:sqlite` |
| 0.0% | 239us | 0.0% | 239us | `defineProperty` | `[native code]` |
| 0.0% | 239us | 0.0% | 239us | `node:events` | `node:events:300` |
| 0.0% | 236us | 1.1% | 185.6ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2298` |
| 0.0% | 235us | 0.0% | 235us | `list` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 231us | 0.0% | 415us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2293` |
| 0.0% | 229us | 0.0% | 229us | `makeBitMapDescriptor` | `internal:streams/writable` |
| 0.0% | 227us | 0.0% | 227us | `ownKeys` | `[native code]` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` |
| 0.0% | 225us | 0.0% | 225us | `@lazy` | `[native code]` |
| 0.0% | 225us | 0.0% | 225us | `dlopen` | `[native code]` |
| 0.0% | 224us | 0.0% | 224us | `setName` | `node:fs:696` |
| 0.0% | 221us | 0.0% | 221us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2524` |
| 0.0% | 220us | 0.0% | 220us | `node:fs` | `node:fs:298` |
| 0.0% | 219us | 0.0% | 219us | `deprecate` | `internal:util/deprecate` |
| 0.0% | 219us | 0.0% | 859us | `require` | `[native code]` |
| 0.0% | 218us | 0.0% | 218us | `bun:ffi` | `bun:ffi:217` |
| 0.0% | 216us | 0.0% | 216us | `node:child_process` | `node:child_process:1111` |
| 0.0% | 214us | 0.2% | 46.4ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2311` |
| 0.0% | 213us | 0.0% | 213us | `makeSafe` | `internal:primordials` |
| 0.0% | 213us | 0.0% | 213us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2502` |
| 0.0% | 210us | 0.0% | 210us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2655` |
| 0.0% | 210us | 0.0% | 436us | `list` | `/home/user/topics-app/server/services/tasks.ts:3752` |
| 0.0% | 208us | 0.0% | 208us | `Statement` | `bun:sqlite:84` |
| 0.0% | 207us | 0.0% | 207us | `awaitingAnswerFor` | `/home/user/topics-app/server/services/tasks.ts:2025` |
| 0.0% | 203us | 0.0% | 461us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1825` |
| 0.0% | 200us | 0.0% | 200us | `internal:streams/end-of-stream` | `internal:streams/end-of-stream:205` |
| 0.0% | 199us | 0.0% | 199us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1519` |
| 0.0% | 199us | 0.0% | 199us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2730` |
| 0.0% | 198us | 0.0% | 198us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2402` |
| 0.0% | 197us | 0.0% | 197us | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 197us | 0.0% | 197us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 193us | 0.0% | 193us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2270` |
| 0.0% | 192us | 0.0% | 192us | `isUnattributedSubtask` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 191us | 0.0% | 191us | `isAgentWorking` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 189us | 0.0% | 189us | `list` | `/home/user/topics-app/server/services/tasks.ts:3720` |
| 0.0% | 187us | 0.0% | 187us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 187us | 0.0% | 187us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2411` |
| 0.0% | 184us | 0.0% | 184us | `query` | `bun:sqlite:339` |
| 0.0% | 180us | 0.9% | 153.2ms | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2242` |
| 0.0% | 177us | 0.0% | 177us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 176us | 1.4% | 240.8ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2687` |
| 0.0% | 175us | 0.3% | 65.4ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2678` |
| 0.0% | 169us | 0.0% | 169us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2467` |
| 0.0% | 168us | 0.0% | 168us | `parseChecksJson` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 168us | 0.0% | 513us | `match` | `[native code]` |
| 0.0% | 158us | 0.1% | 28.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2329` |
| 0.0% | 156us | 0.0% | 156us | `#all` | `bun:sqlite:159` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 99.7% | 16.68s | 0.0% | 3.3ms | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:11` |
| 55.0% | 9.21s | 0.0% | 0us | `list` | `/home/user/topics-app/server/services/tasks.ts:3765` |
| 48.2% | 8.07s | 0.3% | 56.6ms | `map` | `[native code]` |
| 48.1% | 8.06s | 48.1% | 8.06s | `all` | `[native code]` |
| 40.9% | 6.85s | 0.0% | 2.1ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3764` |
| 26.1% | 4.38s | 0.0% | 3.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2488` |
| 26.1% | 4.37s | 5.2% | 884.0ms | `previewOf` | `/home/user/topics-app/server/services/tasks.ts:1778` |
| 20.2% | 3.39s | 20.2% | 3.38s | `from` | `[native code]` |
| 10.4% | 1.74s | 0.0% | 1.4ms | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2654` |
| 7.2% | 1.20s | 7.2% | 1.20s | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2476` |
| 2.8% | 475.7ms | 0.0% | 253us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2281` |
| 1.9% | 330.4ms | 0.0% | 5.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2264` |
| 1.9% | 320.0ms | 1.9% | 320.0ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2264` |
| 1.8% | 312.0ms | 0.0% | 1.1ms | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2229` |
| 1.4% | 241.0ms | 0.0% | 243us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2267` |
| 1.4% | 240.8ms | 0.0% | 176us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2687` |
| 1.3% | 232.8ms | 0.0% | 648us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1969` |
| 1.2% | 207.0ms | 1.2% | 207.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2491` |
| 1.1% | 185.6ms | 0.0% | 236us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2298` |
| 1.0% | 177.3ms | 0.1% | 26.3ms | `filter` | `[native code]` |
| 0.9% | 165.3ms | 0.9% | 165.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2481` |
| 0.9% | 153.2ms | 0.0% | 180us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2242` |
| 0.7% | 132.0ms | 0.0% | 1.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2613` |
| 0.7% | 122.0ms | 0.7% | 122.0ms | `copyDataProperties` | `[native code]` |
| 0.6% | 108.7ms | 0.0% | 1.5ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2274` |
| 0.6% | 104.4ms | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2718` |
| 0.6% | 102.2ms | 0.0% | 1.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2300` |
| 0.5% | 100.3ms | 0.5% | 100.3ms | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts:1706` |
| 0.5% | 97.8ms | 0.0% | 389us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2698` |
| 0.5% | 89.5ms | 0.5% | 89.5ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2300` |
| 0.5% | 84.3ms | 0.0% | 10.8ms | `idParam` | `/home/user/topics-app/server/services/tasks.ts:1559` |
| 0.5% | 83.7ms | 0.5% | 83.7ms | `stringify` | `[native code]` |
| 0.4% | 75.8ms | 0.4% | 75.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2489` |
| 0.4% | 74.6ms | 0.0% | 4.4ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1757` |
| 0.4% | 74.4ms | 0.4% | 74.4ms | `Set` | `[native code]` |
| 0.4% | 71.1ms | 0.3% | 64.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2558` |
| 0.4% | 70.0ms | 0.4% | 70.0ms | `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` | `[native code]` |
| 0.3% | 65.4ms | 0.0% | 175us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2678` |
| 0.3% | 57.2ms | 0.3% | 57.2ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2412` |
| 0.3% | 51.3ms | 0.2% | 43.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2557` |
| 0.2% | 47.4ms | 0.1% | 32.4ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2404` |
| 0.2% | 46.4ms | 0.0% | 214us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2311` |
| 0.2% | 45.3ms | 0.2% | 36.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2513` |
| 0.2% | 43.2ms | 0.2% | 37.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2561` |
| 0.2% | 43.1ms | 0.0% | 7.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2357` |
| 0.2% | 41.6ms | 0.2% | 41.6ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2311` |
| 0.2% | 38.9ms | 0.0% | 7.5ms | `anonymous` | `[native code]` |
| 0.2% | 36.5ms | 0.1% | 29.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2560` |
| 0.2% | 36.4ms | 0.2% | 36.4ms | `join` | `[native code]` |
| 0.2% | 36.3ms | 0.0% | 8.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2569` |
| 0.2% | 34.0ms | 0.0% | 836us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2365` |
| 0.2% | 33.6ms | 0.2% | 33.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2643` |
| 0.1% | 33.0ms | 0.1% | 22.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2598` |
| 0.1% | 32.5ms | 0.0% | 490us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2372` |
| 0.1% | 32.4ms | 0.1% | 20.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2589` |
| 0.1% | 31.6ms | 0.1% | 31.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2487` |
| 0.1% | 30.5ms | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2335` |
| 0.1% | 29.8ms | 0.1% | 29.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2365` |
| 0.1% | 28.7ms | 0.1% | 24.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2559` |
| 0.1% | 28.5ms | 0.1% | 28.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2570` |
| 0.1% | 28.1ms | 0.0% | 158us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2329` |
| 0.1% | 27.8ms | 0.1% | 27.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2492` |
| 0.1% | 27.5ms | 0.0% | 0us | `readGlobalDispatch` | `/home/user/topics-app/server/services/tasks.ts:1465` |
| 0.1% | 27.4ms | 0.1% | 27.4ms | `get` | `[native code]` |
| 0.1% | 27.2ms | 0.0% | 9.9ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3759` |
| 0.1% | 27.1ms | 0.1% | 27.1ms | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts:1173` |
| 0.1% | 27.1ms | 0.1% | 27.1ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2357` |
| 0.1% | 26.2ms | 0.1% | 20.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2556` |
| 0.1% | 26.0ms | 0.1% | 24.4ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3754` |
| 0.1% | 25.7ms | 0.1% | 19.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2543` |
| 0.1% | 25.6ms | 0.1% | 25.6ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1753` |
| 0.1% | 25.6ms | 0.0% | 15.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2520` |
| 0.1% | 25.5ms | 0.1% | 25.5ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.1% | 25.1ms | 0.1% | 25.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2608` |
| 0.1% | 24.8ms | 0.1% | 24.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2335` |
| 0.1% | 24.5ms | 0.1% | 17.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2544` |
| 0.1% | 23.8ms | 0.1% | 23.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2372` |
| 0.1% | 21.5ms | 0.0% | 16.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2592` |
| 0.1% | 20.8ms | 0.1% | 20.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2493` |
| 0.1% | 20.5ms | 0.0% | 15.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2542` |
| 0.1% | 20.4ms | 0.1% | 20.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2621` |
| 0.1% | 19.2ms | 0.0% | 12.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2580` |
| 0.1% | 17.9ms | 0.0% | 3.0ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2344` |
| 0.1% | 17.5ms | 0.0% | 0us | `bound join` | `[native code]` |
| 0.1% | 17.5ms | 0.0% | 0us | `(module)` | `/home/user/topics-app/server/services/deliveryReportProbe.ts:18` |
| 0.1% | 17.4ms | 0.1% | 17.4ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2425` |
| 0.1% | 17.0ms | 0.1% | 17.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2575` |
| 0.1% | 16.8ms | 0.0% | 447us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2279` |
| 0.0% | 16.3ms | 0.0% | 16.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2648` |
| 0.0% | 16.0ms | 0.0% | 10.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2510` |
| 0.0% | 15.8ms | 0.0% | 0us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2518` |
| 0.0% | 15.8ms | 0.0% | 11.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2628` |
| 0.0% | 15.7ms | 0.0% | 15.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2507` |
| 0.0% | 15.2ms | 0.0% | 11.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2562` |
| 0.0% | 15.0ms | 0.0% | 15.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2626` |
| 0.0% | 15.0ms | 0.0% | 15.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2614` |
| 0.0% | 14.1ms | 0.0% | 14.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2499` |
| 0.0% | 13.9ms | 0.0% | 13.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2572` |
| 0.0% | 13.4ms | 0.0% | 13.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2574` |
| 0.0% | 13.3ms | 0.0% | 13.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2501` |
| 0.0% | 13.2ms | 0.0% | 13.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2500` |
| 0.0% | 13.2ms | 0.0% | 241us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2379` |
| 0.0% | 13.2ms | 0.0% | 391us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2332` |
| 0.0% | 13.1ms | 0.0% | 13.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2498` |
| 0.0% | 12.6ms | 0.0% | 12.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2497` |
| 0.0% | 12.4ms | 0.0% | 12.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2573` |
| 0.0% | 12.0ms | 0.0% | 12.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2620` |
| 0.0% | 11.7ms | 0.0% | 11.7ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2518` |
| 0.0% | 11.5ms | 0.0% | 11.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2581` |
| 0.0% | 11.5ms | 0.0% | 681us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2266` |
| 0.0% | 11.2ms | 0.0% | 11.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2622` |
| 0.0% | 11.2ms | 0.0% | 11.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2506` |
| 0.0% | 11.0ms | 0.0% | 11.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2632` |
| 0.0% | 11.0ms | 0.0% | 11.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2639` |
| 0.0% | 10.8ms | 0.0% | 10.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2636` |
| 0.0% | 10.8ms | 0.0% | 10.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2641` |
| 0.0% | 10.7ms | 0.0% | 10.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2617` |
| 0.0% | 10.7ms | 0.0% | 10.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2615` |
| 0.0% | 10.6ms | 0.0% | 10.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2508` |
| 0.0% | 10.4ms | 0.0% | 10.4ms | `Boolean` | `[native code]` |
| 0.0% | 10.3ms | 0.0% | 5.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2588` |
| 0.0% | 10.2ms | 0.0% | 10.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2637` |
| 0.0% | 10.0ms | 0.0% | 9.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2631` |
| 0.0% | 9.9ms | 0.0% | 9.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2503` |
| 0.0% | 9.5ms | 0.0% | 9.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2564` |
| 0.0% | 9.5ms | 0.0% | 9.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2627` |
| 0.0% | 9.3ms | 0.0% | 9.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2512` |
| 0.0% | 9.3ms | 0.0% | 9.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2642` |
| 0.0% | 9.2ms | 0.0% | 9.2ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2344` |
| 0.0% | 9.1ms | 0.0% | 0us | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1311` |
| 0.0% | 9.1ms | 0.0% | 9.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2504` |
| 0.0% | 9.0ms | 0.0% | 9.0ms | `node:fs` | `node:fs:8` |
| 0.0% | 8.9ms | 0.0% | 8.9ms | `isAgentWorking` | `/home/user/topics-app/shared/board.ts:431` |
| 0.0% | 8.8ms | 0.0% | 8.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2509` |
| 0.0% | 8.7ms | 0.0% | 8.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2505` |
| 0.0% | 8.4ms | 0.0% | 8.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2584` |
| 0.0% | 8.4ms | 0.0% | 8.4ms | `query` | `bun:sqlite:345` |
| 0.0% | 8.3ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 0.0% | 8.2ms | 0.0% | 8.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2496` |
| 0.0% | 8.1ms | 0.0% | 0us | `internal:streams/lazy_transform` | `internal:streams/lazy_transform:2` |
| 0.0% | 8.0ms | 0.0% | 708us | `list` | `/home/user/topics-app/server/services/tasks.ts:3762` |
| 0.0% | 8.0ms | 0.0% | 8.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2640` |
| 0.0% | 8.0ms | 0.0% | 8.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2511` |
| 0.0% | 7.8ms | 0.0% | 0us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2226` |
| 0.0% | 7.6ms | 0.0% | 7.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2565` |
| 0.0% | 7.3ms | 0.0% | 7.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2571` |
| 0.0% | 7.0ms | 0.0% | 0us | `internal:streams/transform` | `internal:streams/transform:2` |
| 0.0% | 6.7ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.0% | 6.7ms | 0.0% | 6.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2579` |
| 0.0% | 6.7ms | 0.0% | 6.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2625` |
| 0.0% | 6.5ms | 0.0% | 6.5ms | `toISOString` | `[native code]` |
| 0.0% | 6.3ms | 0.0% | 1.8ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3763` |
| 0.0% | 6.3ms | 0.0% | 6.3ms | `query` | `bun:sqlite:341` |
| 0.0% | 6.2ms | 0.0% | 6.2ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2379` |
| 0.0% | 6.1ms | 0.0% | 6.1ms | `now` | `[native code]` |
| 0.0% | 5.8ms | 0.0% | 5.8ms | `readTaskWeight` | `/home/user/topics-app/shared/board.ts:390` |
| 0.0% | 5.7ms | 0.0% | 5.7ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3757` |
| 0.0% | 5.6ms | 0.0% | 5.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2647` |
| 0.0% | 5.2ms | 0.0% | 5.2ms | `arrayFromFastWithoutMapFn` | `[native code]` |
| 0.0% | 4.9ms | 0.0% | 1.4ms | `query` | `bun:sqlite:347` |
| 0.0% | 4.9ms | 0.0% | 4.9ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2678` |
| 0.0% | 4.8ms | 0.0% | 4.8ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2279` |
| 0.0% | 4.6ms | 0.0% | 3.7ms | `query` | `bun:sqlite:343` |
| 0.0% | 4.4ms | 0.0% | 423us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2680` |
| 0.0% | 4.3ms | 0.0% | 4.3ms | `Date` | `[native code]` |
| 0.0% | 4.2ms | 0.0% | 4.2ms | `next` | `[native code]` |
| 0.0% | 4.1ms | 0.0% | 4.1ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2416` |
| 0.0% | 3.8ms | 0.0% | 3.6ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2679` |
| 0.0% | 3.6ms | 0.0% | 2.2ms | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1965` |
| 0.0% | 3.5ms | 0.0% | 911us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2610` |
| 0.0% | 3.5ms | 0.0% | 0us | `[prepareOwned]` | `bun:sqlite:330` |
| 0.0% | 3.4ms | 0.0% | 3.4ms | `lazyCpus` | `node:os` |
| 0.0% | 3.4ms | 0.0% | 0us | `node:os` | `node:os:110` |
| 0.0% | 3.4ms | 0.0% | 0us | `bound` | `node:os:74` |
| 0.0% | 3.4ms | 0.0% | 251us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1966` |
| 0.0% | 3.3ms | 0.0% | 3.3ms | `prepare` | `[native code]` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3669` |
| 0.0% | 2.9ms | 0.0% | 2.9ms | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 2.9ms | 0.0% | 872us | `list` | `/home/user/topics-app/server/services/tasks.ts:3733` |
| 0.0% | 2.8ms | 0.0% | 1.0ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2384` |
| 0.0% | 2.8ms | 0.0% | 0us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1829` |
| 0.0% | 2.6ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.0% | 2.6ms | 0.0% | 2.6ms | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1232` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `#all` | `bun:sqlite:157` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `push` | `[native code]` |
| 0.0% | 2.2ms | 0.0% | 2.2ms | `node:child_process` | `node:child_process:2` |
| 0.0% | 2.1ms | 0.0% | 2.1ms | `query` | `bun:sqlite` |
| 0.0% | 2.0ms | 0.0% | 1.8ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2724` |
| 0.0% | 2.0ms | 0.0% | 2.0ms | `bun:sqlite` | `bun:sqlite:215` |
| 0.0% | 1.9ms | 0.0% | 1.9ms | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts:2059` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2590` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `some` | `[native code]` |
| 0.0% | 1.7ms | 0.0% | 1.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2688` |
| 0.0% | 1.5ms | 0.0% | 0us | `(module)` | `/home/user/topics-app/server/lib/fleet-usage.ts:170` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2517` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `Map` | `[native code]` |
| 0.0% | 1.3ms | 0.0% | 1.3ms | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1520` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2285` |
| 0.0% | 1.1ms | 0.0% | 0us | `internal:streams/legacy` | `internal:streams/legacy:2` |
| 0.0% | 1.1ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:7` |
| 0.0% | 1.0ms | 0.0% | 0us | `internal:errors` | `internal:errors:2` |
| 0.0% | 1.0ms | 0.0% | 0us | `internal:streams/destroy` | `internal:streams/destroy:2` |
| 0.0% | 1.0ms | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2692` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 950us | 0.0% | 950us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2727` |
| 0.0% | 917us | 0.0% | 917us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1521` |
| 0.0% | 908us | 0.0% | 908us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2304` |
| 0.0% | 903us | 0.0% | 903us | `query` | `bun:sqlite:337` |
| 0.0% | 893us | 0.0% | 893us | `createTaskService` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 885us | 0.0% | 885us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2410` |
| 0.0% | 859us | 0.0% | 0us | `bound require` | `[native code]` |
| 0.0% | 859us | 0.0% | 219us | `require` | `[native code]` |
| 0.0% | 859us | 0.0% | 0us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts:152` |
| 0.0% | 852us | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 0.0% | 821us | 0.0% | 821us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 809us | 0.0% | 583us | `sort` | `[native code]` |
| 0.0% | 809us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` |
| 0.0% | 803us | 0.0% | 803us | `idParam` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 717us | 0.0% | 717us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1824` |
| 0.0% | 711us | 0.0% | 711us | `#all` | `bun:sqlite` |
| 0.0% | 708us | 0.0% | 708us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1970` |
| 0.0% | 679us | 0.0% | 0us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 665us | 0.0% | 665us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2217` |
| 0.0% | 665us | 0.0% | 665us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2677` |
| 0.0% | 583us | 0.0% | 583us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2238` |
| 0.0% | 565us | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 565us | 0.0% | 0us | `node:path` | `node:path:2` |
| 0.0% | 516us | 0.0% | 516us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2406` |
| 0.0% | 513us | 0.0% | 168us | `match` | `[native code]` |
| 0.0% | 494us | 0.0% | 494us | `isFinalized` | `bun:sqlite:104` |
| 0.0% | 492us | 0.0% | 492us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2272` |
| 0.0% | 488us | 0.0% | 488us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts` |
| 0.0% | 483us | 0.0% | 483us | `node:crypto` | `node:crypto:84` |
| 0.0% | 472us | 0.0% | 472us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2224` |
| 0.0% | 461us | 0.0% | 203us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1825` |
| 0.0% | 444us | 0.0% | 444us | `list` | `/home/user/topics-app/server/services/tasks.ts:3746` |
| 0.0% | 440us | 0.0% | 440us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2725` |
| 0.0% | 436us | 0.0% | 210us | `list` | `/home/user/topics-app/server/services/tasks.ts:3752` |
| 0.0% | 433us | 0.0% | 433us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2413` |
| 0.0% | 427us | 0.0% | 427us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2273` |
| 0.0% | 424us | 0.0% | 424us | `readGlobalDispatch` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 416us | 0.0% | 416us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2396` |
| 0.0% | 415us | 0.0% | 231us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2293` |
| 0.0% | 410us | 0.0% | 410us | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2653` |
| 0.0% | 409us | 0.0% | 409us | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 400us | 0.0% | 400us | `delete` | `[native code]` |
| 0.0% | 363us | 0.0% | 363us | `slice` | `[native code]` |
| 0.0% | 333us | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2706` |
| 0.0% | 298us | 0.0% | 0us | `(module)` | `/home/user/topics-app/shared/media-kind.ts:57` |
| 0.0% | 298us | 0.0% | 298us | `RegExp` | `[native code]` |
| 0.0% | 275us | 0.0% | 275us | `list` | `/home/user/topics-app/server/services/tasks.ts:3734` |
| 0.0% | 269us | 0.0% | 269us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2595` |
| 0.0% | 264us | 0.0% | 0us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1832` |
| 0.0% | 258us | 0.0% | 258us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2409` |
| 0.0% | 255us | 0.0% | 255us | `internal:streams/readable` | `internal:streams/readable:55` |
| 0.0% | 254us | 0.0% | 254us | `internal:streams/destroy` | `internal:streams/destroy:16` |
| 0.0% | 253us | 0.0% | 253us | `(unknown)` | `[native code]` |
| 0.0% | 249us | 0.0% | 249us | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 248us | 0.0% | 248us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2244` |
| 0.0% | 246us | 0.0% | 0us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1831` |
| 0.0% | 243us | 0.0% | 243us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2230` |
| 0.0% | 243us | 0.0% | 243us | `outOfQueuePromise` | `/home/user/topics-app/shared/board.ts:1143` |
| 0.0% | 242us | 0.0% | 0us | `createTaskService` | `/home/user/topics-app/server/services/tasks.ts:2807` |
| 0.0% | 241us | 0.0% | 0us | `(module)` | `/home/user/topics-app/server/services/deliveryReportProbe.ts:174` |
| 0.0% | 241us | 0.0% | 241us | `answering` | `/home/user/topics-app/server/services/deliveryReportProbe.ts` |
| 0.0% | 241us | 0.0% | 0us | `probeForRoot` | `/home/user/topics-app/server/services/deliveryReportProbe.ts:32` |
| 0.0% | 241us | 0.0% | 0us | `buildProbe` | `/home/user/topics-app/server/services/deliveryReportProbe.ts:149` |
| 0.0% | 240us | 0.0% | 240us | `list` | `/home/user/topics-app/server/services/tasks.ts:3694` |
| 0.0% | 240us | 0.0% | 240us | `#allNoArgs` | `bun:sqlite` |
| 0.0% | 239us | 0.0% | 239us | `node:events` | `node:events:300` |
| 0.0% | 239us | 0.0% | 0us | `makeSafe` | `internal:primordials:53` |
| 0.0% | 239us | 0.0% | 0us | `copyProps` | `internal:primordials:27` |
| 0.0% | 239us | 0.0% | 239us | `defineProperty` | `[native code]` |
| 0.0% | 235us | 0.0% | 235us | `list` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 231us | 0.0% | 0us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2611` |
| 0.0% | 229us | 0.0% | 229us | `makeBitMapDescriptor` | `internal:streams/writable` |
| 0.0% | 229us | 0.0% | 0us | `internal:streams/writable` | `internal:streams/writable:33` |
| 0.0% | 227us | 0.0% | 0us | `makeSafe` | `internal:primordials:32` |
| 0.0% | 227us | 0.0% | 227us | `ownKeys` | `[native code]` |
| 0.0% | 226us | 0.0% | 226us | `(anonymous)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` |
| 0.0% | 225us | 0.0% | 0us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts:153` |
| 0.0% | 225us | 0.0% | 0us | `node:crypto` | `node:crypto:39` |
| 0.0% | 225us | 0.0% | 225us | `@lazy` | `[native code]` |
| 0.0% | 225us | 0.0% | 225us | `dlopen` | `[native code]` |
| 0.0% | 225us | 0.0% | 0us | `dlopen` | `bun:ffi:157` |
| 0.0% | 224us | 0.0% | 224us | `setName` | `node:fs:696` |
| 0.0% | 224us | 0.0% | 0us | `node:fs` | `node:fs:739` |
| 0.0% | 221us | 0.0% | 221us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2524` |
| 0.0% | 220us | 0.0% | 220us | `node:fs` | `node:fs:298` |
| 0.0% | 219us | 0.0% | 0us | `node:crypto` | `node:crypto:190` |
| 0.0% | 219us | 0.0% | 219us | `deprecate` | `internal:util/deprecate` |
| 0.0% | 218us | 0.0% | 218us | `bun:ffi` | `bun:ffi:217` |
| 0.0% | 216us | 0.0% | 216us | `node:child_process` | `node:child_process:1111` |
| 0.0% | 213us | 0.0% | 213us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2502` |
| 0.0% | 213us | 0.0% | 213us | `makeSafe` | `internal:primordials` |
| 0.0% | 210us | 0.0% | 210us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2655` |
| 0.0% | 208us | 0.0% | 208us | `Statement` | `bun:sqlite:84` |
| 0.0% | 207us | 0.0% | 207us | `awaitingAnswerFor` | `/home/user/topics-app/server/services/tasks.ts:2025` |
| 0.0% | 207us | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2278` |
| 0.0% | 200us | 0.0% | 200us | `internal:streams/end-of-stream` | `internal:streams/end-of-stream:205` |
| 0.0% | 199us | 0.0% | 199us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1519` |
| 0.0% | 199us | 0.0% | 199us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2730` |
| 0.0% | 198us | 0.0% | 198us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2402` |
| 0.0% | 197us | 0.0% | 197us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 197us | 0.0% | 197us | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 193us | 0.0% | 193us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2270` |
| 0.0% | 192us | 0.0% | 0us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1524` |
| 0.0% | 192us | 0.0% | 192us | `isUnattributedSubtask` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 191us | 0.0% | 191us | `isAgentWorking` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 189us | 0.0% | 189us | `list` | `/home/user/topics-app/server/services/tasks.ts:3720` |
| 0.0% | 187us | 0.0% | 187us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 187us | 0.0% | 187us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2411` |
| 0.0% | 184us | 0.0% | 184us | `query` | `bun:sqlite:339` |
| 0.0% | 177us | 0.0% | 177us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 169us | 0.0% | 169us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2467` |
| 0.0% | 168us | 0.0% | 168us | `parseChecksJson` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 156us | 0.0% | 156us | `#all` | `bun:sqlite:159` |

## Function Details

### `all`
`[native code]` | Self: 48.1% (8.06s) | Total: 48.1% (8.06s) | Samples: 29036

**Called by:**
- `list` (24501)
- `previewImagesFor` (1026)
- `withSubtaskCounts` (959)
- `labelsFor` (672)
- `buildBatch` (564)
- `withSubtaskCounts` (430)
- `previewImagesFor` (427)
- `withSubtaskCounts` (408)
- `buildBatch` (49)

### `from`
`[native code]` | Self: 20.2% (3.38s) | Total: 20.2% (3.39s) | Samples: 10460

**Called by:**
- `previewOf` (10505)

**Calls:**
- `arrayFromFastWithoutMapFn` (23)
- `next` (22)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2476` | Self: 7.2% (1.20s) | Total: 7.2% (1.20s) | Samples: 4061

**Called by:**
- `map` (4061)

### `previewOf`
`/home/user/topics-app/server/services/tasks.ts:1778` | Self: 5.2% (884.0ms) | Total: 26.1% (4.37s) | Samples: 3167

**Called by:**
- `mapRow` (14072)

**Calls:**
- `from` (10505)
- `anteprimaUtile` (300)
- `anteprimaUtile` (97)
- `slice` (2)
- `anteprimaUtile` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2264` | Self: 1.9% (320.0ms) | Total: 1.9% (320.0ms) | Samples: 1185

**Called by:**
- `map` (1185)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2491` | Self: 1.2% (207.0ms) | Total: 1.2% (207.0ms) | Samples: 650

**Called by:**
- `map` (650)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2481` | Self: 0.9% (165.3ms) | Total: 0.9% (165.3ms) | Samples: 578

**Called by:**
- `map` (578)

### `copyDataProperties`
`[native code]` | Self: 0.7% (122.0ms) | Total: 0.7% (122.0ms) | Samples: 415

**Called by:**
- `mapRow` (33)
- `mapRow` (29)
- `mapRow` (27)
- `mapRow` (26)
- `mapRow` (26)
- `mapRow` (25)
- `mapRow` (25)
- `mapRow` (25)
- `mapRow` (24)
- `mapRow` (24)
- `mapRow` (23)
- `mapRow` (22)
- `mapRow` (22)
- `mapRow` (18)
- `mapRow` (17)
- `mapRow` (17)
- `mapRow` (16)
- `mapRow` (15)
- `mapRow` (1)

### `drawsCardComments`
`/home/user/topics-app/server/services/tasks.ts:1706` | Self: 0.5% (100.3ms) | Total: 0.5% (100.3ms) | Samples: 335

**Called by:**
- `filter` (335)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2300` | Self: 0.5% (89.5ms) | Total: 0.5% (89.5ms) | Samples: 334

**Called by:**
- `map` (334)

### `stringify`
`[native code]` | Self: 0.5% (83.7ms) | Total: 0.5% (83.7ms) | Samples: 208

**Called by:**
- `withSubtaskCounts` (54)
- `previewImagesFor` (45)
- `labelsFor` (43)
- `previewImagesFor` (37)
- `buildBatch` (28)
- `withSubtaskCounts` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2489` | Self: 0.4% (75.8ms) | Total: 0.4% (75.8ms) | Samples: 179

**Called by:**
- `map` (179)

### `Set`
`[native code]` | Self: 0.4% (74.4ms) | Total: 0.4% (74.4ms) | Samples: 286

**Called by:**
- `idParam` (282)
- `buildBatch` (4)

### `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/`
`[native code]` | Self: 0.4% (70.0ms) | Total: 0.4% (70.0ms) | Samples: 280

**Called by:**
- `anteprimaUtile` (278)
- `match` (2)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2558` | Self: 0.3% (64.4ms) | Total: 0.4% (71.1ms) | Samples: 169

**Called by:**
- `map` (194)

**Calls:**
- `copyDataProperties` (25)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2412` | Self: 0.3% (57.2ms) | Total: 0.3% (57.2ms) | Samples: 188

**Called by:**
- `mapRow` (188)

### `map`
`[native code]` | Self: 0.3% (56.6ms) | Total: 48.2% (8.07s) | Samples: 166

**Called by:**
- `list` (24608)
- `buildBatch` (1201)
- `buildBatch` (338)
- `buildBatch` (170)
- `buildBatch` (114)
- `buildBatch` (113)
- `buildBatch` (101)
- `buildBatch` (71)
- `withSubtaskCounts` (50)
- `buildBatch` (6)
- `createTaskService` (1)

**Calls:**
- `mapRow` (14087)
- `mapRow` (4061)
- `(anonymous)` (1185)
- `mapRow` (650)
- `mapRow` (578)
- `mapRow` (461)
- `(anonymous)` (334)
- `mapRow` (194)
- `mapRow` (179)
- `mapRow` (169)
- `(anonymous)` (161)
- `mapRow` (152)
- `mapRow` (145)
- `mapRow` (124)
- `mapRow` (113)
- `mapRow` (113)
- `(anonymous)` (108)
- `mapRow` (108)
- `mapRow` (107)
- `mapRow` (103)
- `(anonymous)` (103)
- `mapRow` (102)
- `mapRow` (100)
- `mapRow` (86)
- `(anonymous)` (84)
- `mapRow` (83)
- `mapRow` (83)
- `mapRow` (82)
- `mapRow` (81)
- `mapRow` (81)
- `mapRow` (75)
- `mapRow` (75)
- `mapRow` (71)
- `mapRow` (70)
- `mapRow` (69)
- `mapRow` (68)
- `mapRow` (67)
- `(anonymous)` (65)
- `mapRow` (63)
- `mapRow` (58)
- `mapRow` (58)
- `mapRow` (58)
- `mapRow` (55)
- `mapRow` (55)
- `mapRow` (54)
- `mapRow` (53)
- `mapRow` (51)
- `mapRow` (50)
- `mapRow` (50)
- `mapRow` (50)
- `mapRow` (49)
- `mapRow` (47)
- `mapRow` (47)
- `mapRow` (47)
- `mapRow` (46)
- `mapRow` (45)
- `mapRow` (45)
- `mapRow` (45)
- `mapRow` (45)
- `mapRow` (45)
- `mapRow` (44)
- `mapRow` (44)
- `mapRow` (41)
- `mapRow` (40)
- `mapRow` (40)
- `mapRow` (39)
- `mapRow` (39)
- `mapRow` (38)
- `mapRow` (38)
- `mapRow` (37)
- `mapRow` (36)
- `mapRow` (36)
- `mapRow` (36)
- `mapRow` (36)
- `mapRow` (36)
- `mapRow` (35)
- `mapRow` (34)
- `mapRow` (34)
- `mapRow` (32)
- `mapRow` (31)
- `mapRow` (30)
- `mapRow` (29)
- `mapRow` (27)
- `(anonymous)` (21)
- `mapRow` (20)
- `mapRow` (16)
- `(anonymous)` (11)
- `mapRow` (8)
- `mapRow` (1)
- `mapRow` (1)
- `(anonymous)` (1)
- `mapRow` (1)
- `mapRow` (1)
- `mapRow` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2557` | Self: 0.2% (43.9ms) | Total: 0.3% (51.3ms) | Samples: 127

**Called by:**
- `map` (152)

**Calls:**
- `copyDataProperties` (25)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2311` | Self: 0.2% (41.6ms) | Total: 0.2% (41.6ms) | Samples: 161

**Called by:**
- `map` (161)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2561` | Self: 0.2% (37.4ms) | Total: 0.2% (43.2ms) | Samples: 121

**Called by:**
- `map` (145)

**Calls:**
- `copyDataProperties` (24)

### `join`
`[native code]` | Self: 0.2% (36.4ms) | Total: 0.2% (36.4ms) | Samples: 59

**Called by:**
- `list` (51)
- `list` (7)
- `bound join` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2513` | Self: 0.2% (36.1ms) | Total: 0.2% (45.3ms) | Samples: 136

**Called by:**
- `map` (169)

**Calls:**
- `copyDataProperties` (33)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2643` | Self: 0.2% (33.6ms) | Total: 0.2% (33.6ms) | Samples: 102

**Called by:**
- `map` (102)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2404` | Self: 0.1% (32.4ms) | Total: 0.2% (47.4ms) | Samples: 119

**Called by:**
- `mapRow` (176)

**Calls:**
- `deriveQueueReason` (37)
- `deriveQueueReason` (13)
- `deriveQueueReason` (6)
- `outOfQueuePromise` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2487` | Self: 0.1% (31.6ms) | Total: 0.1% (31.6ms) | Samples: 113

**Called by:**
- `map` (113)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2365` | Self: 0.1% (29.8ms) | Total: 0.1% (29.8ms) | Samples: 108

**Called by:**
- `map` (108)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2560` | Self: 0.1% (29.7ms) | Total: 0.2% (36.5ms) | Samples: 90

**Called by:**
- `map` (107)

**Calls:**
- `copyDataProperties` (17)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2570` | Self: 0.1% (28.5ms) | Total: 0.1% (28.5ms) | Samples: 81

**Called by:**
- `map` (81)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2492` | Self: 0.1% (27.8ms) | Total: 0.1% (27.8ms) | Samples: 83

**Called by:**
- `map` (83)

### `get`
`[native code]` | Self: 0.1% (27.4ms) | Total: 0.1% (27.4ms) | Samples: 104

**Called by:**
- `readGlobalDispatch` (101)
- `listColumns` (1)
- `mapRow` (1)
- `withSubtaskCounts` (1)

### `rejectedPaths`
`/home/user/topics-app/server/services/tasks.ts:1173` | Self: 0.1% (27.1ms) | Total: 0.1% (27.1ms) | Samples: 86

**Called by:**
- `mapRow` (86)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2357` | Self: 0.1% (27.1ms) | Total: 0.1% (27.1ms) | Samples: 103

**Called by:**
- `map` (103)

### `filter`
`[native code]` | Self: 0.1% (26.3ms) | Total: 1.0% (177.3ms) | Samples: 107

**Called by:**
- `buildBatch` (348)
- `buildBatch` (55)
- `buildBatch` (52)
- `buildBatch` (50)
- `buildBatch` (47)
- `buildBatch` (17)
- `buildBatch` (16)
- `buildBatch` (11)
- `buildBatch` (10)
- `list` (9)
- `buildBatch` (7)
- `listColumns` (1)
- `listColumns` (1)

**Calls:**
- `drawsCardComments` (335)
- `(anonymous)` (55)
- `(anonymous)` (40)
- `Boolean` (38)
- `(anonymous)` (28)
- `(anonymous)` (16)
- `drawsCardComments` (5)

### `anteprimaUtile`
`/home/user/topics-app/server/services/tasks.ts:1753` | Self: 0.1% (25.6ms) | Total: 0.1% (25.6ms) | Samples: 97

**Called by:**
- `previewOf` (97)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.1% (25.5ms) | Total: 0.1% (25.5ms) | Samples: 78

**Called by:**
- `filter` (55)
- `mapRow` (12)
- `map` (11)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2608` | Self: 0.1% (25.1ms) | Total: 0.1% (25.1ms) | Samples: 103

**Called by:**
- `map` (103)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2335` | Self: 0.1% (24.8ms) | Total: 0.1% (24.8ms) | Samples: 65

**Called by:**
- `map` (65)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3754` | Self: 0.1% (24.4ms) | Total: 0.1% (26.0ms) | Samples: 80

**Called by:**
- `(module)` (87)

**Calls:**
- `join` (7)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2559` | Self: 0.1% (24.1ms) | Total: 0.1% (28.7ms) | Samples: 91

**Called by:**
- `map` (113)

**Calls:**
- `copyDataProperties` (22)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2372` | Self: 0.1% (23.8ms) | Total: 0.1% (23.8ms) | Samples: 84

**Called by:**
- `map` (84)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2598` | Self: 0.1% (22.2ms) | Total: 0.1% (33.0ms) | Samples: 75

**Called by:**
- `map` (100)

**Calls:**
- `copyDataProperties` (25)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2493` | Self: 0.1% (20.8ms) | Total: 0.1% (20.8ms) | Samples: 68

**Called by:**
- `map` (68)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2589` | Self: 0.1% (20.8ms) | Total: 0.1% (32.4ms) | Samples: 55

**Called by:**
- `map` (81)

**Calls:**
- `copyDataProperties` (26)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2621` | Self: 0.1% (20.4ms) | Total: 0.1% (20.4ms) | Samples: 47

**Called by:**
- `map` (47)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2556` | Self: 0.1% (20.3ms) | Total: 0.1% (26.2ms) | Samples: 81

**Called by:**
- `map` (108)

**Calls:**
- `copyDataProperties` (27)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2543` | Self: 0.1% (19.6ms) | Total: 0.1% (25.7ms) | Samples: 61

**Called by:**
- `map` (83)

**Calls:**
- `copyDataProperties` (22)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2544` | Self: 0.1% (17.5ms) | Total: 0.1% (24.5ms) | Samples: 55

**Called by:**
- `map` (71)

**Calls:**
- `copyDataProperties` (16)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2425` | Self: 0.1% (17.4ms) | Total: 0.1% (17.4ms) | Samples: 54

**Called by:**
- `mapRow` (54)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2575` | Self: 0.1% (17.0ms) | Total: 0.1% (17.0ms) | Samples: 55

**Called by:**
- `map` (55)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2648` | Self: 0.0% (16.3ms) | Total: 0.0% (16.3ms) | Samples: 58

**Called by:**
- `map` (58)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2592` | Self: 0.0% (16.2ms) | Total: 0.1% (21.5ms) | Samples: 57

**Called by:**
- `map` (75)

**Calls:**
- `copyDataProperties` (18)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2520` | Self: 0.0% (15.8ms) | Total: 0.1% (25.6ms) | Samples: 53

**Called by:**
- `map` (82)

**Calls:**
- `copyDataProperties` (29)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2507` | Self: 0.0% (15.7ms) | Total: 0.0% (15.7ms) | Samples: 63

**Called by:**
- `map` (63)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2626` | Self: 0.0% (15.0ms) | Total: 0.0% (15.0ms) | Samples: 47

**Called by:**
- `map` (47)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2542` | Self: 0.0% (15.0ms) | Total: 0.1% (20.5ms) | Samples: 62

**Called by:**
- `map` (86)

**Calls:**
- `copyDataProperties` (24)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2614` | Self: 0.0% (15.0ms) | Total: 0.0% (15.0ms) | Samples: 58

**Called by:**
- `map` (58)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2499` | Self: 0.0% (14.1ms) | Total: 0.0% (14.1ms) | Samples: 38

**Called by:**
- `map` (38)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2572` | Self: 0.0% (13.9ms) | Total: 0.0% (13.9ms) | Samples: 45

**Called by:**
- `map` (45)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2574` | Self: 0.0% (13.4ms) | Total: 0.0% (13.4ms) | Samples: 55

**Called by:**
- `map` (55)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2501` | Self: 0.0% (13.3ms) | Total: 0.0% (13.3ms) | Samples: 45

**Called by:**
- `map` (45)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2500` | Self: 0.0% (13.2ms) | Total: 0.0% (13.2ms) | Samples: 58

**Called by:**
- `map` (58)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2498` | Self: 0.0% (13.1ms) | Total: 0.0% (13.1ms) | Samples: 54

**Called by:**
- `map` (54)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2497` | Self: 0.0% (12.6ms) | Total: 0.0% (12.6ms) | Samples: 45

**Called by:**
- `map` (45)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2573` | Self: 0.0% (12.4ms) | Total: 0.0% (12.4ms) | Samples: 53

**Called by:**
- `map` (53)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2580` | Self: 0.0% (12.4ms) | Total: 0.1% (19.2ms) | Samples: 49

**Called by:**
- `map` (75)

**Calls:**
- `copyDataProperties` (26)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2620` | Self: 0.0% (12.0ms) | Total: 0.0% (12.0ms) | Samples: 49

**Called by:**
- `map` (49)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2628` | Self: 0.0% (11.9ms) | Total: 0.0% (15.8ms) | Samples: 53

**Called by:**
- `map` (70)

**Calls:**
- `copyDataProperties` (17)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2562` | Self: 0.0% (11.8ms) | Total: 0.0% (15.2ms) | Samples: 54

**Called by:**
- `map` (69)

**Calls:**
- `copyDataProperties` (15)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2518` | Self: 0.0% (11.7ms) | Total: 0.0% (11.7ms) | Samples: 22

**Called by:**
- `mapRow` (22)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2581` | Self: 0.0% (11.5ms) | Total: 0.0% (11.5ms) | Samples: 50

**Called by:**
- `map` (50)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2622` | Self: 0.0% (11.2ms) | Total: 0.0% (11.2ms) | Samples: 50

**Called by:**
- `map` (50)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2506` | Self: 0.0% (11.2ms) | Total: 0.0% (11.2ms) | Samples: 51

**Called by:**
- `map` (51)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2632` | Self: 0.0% (11.0ms) | Total: 0.0% (11.0ms) | Samples: 36

**Called by:**
- `map` (36)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2639` | Self: 0.0% (11.0ms) | Total: 0.0% (11.0ms) | Samples: 44

**Called by:**
- `map` (44)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2641` | Self: 0.0% (10.8ms) | Total: 0.0% (10.8ms) | Samples: 45

**Called by:**
- `map` (45)

### `idParam`
`/home/user/topics-app/server/services/tasks.ts:1559` | Self: 0.0% (10.8ms) | Total: 0.5% (84.3ms) | Samples: 35

**Called by:**
- `withSubtaskCounts` (132)
- `labelsFor` (116)
- `buildBatch` (69)

**Calls:**
- `Set` (282)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2617` | Self: 0.0% (10.7ms) | Total: 0.0% (10.7ms) | Samples: 47

**Called by:**
- `map` (47)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2615` | Self: 0.0% (10.7ms) | Total: 0.0% (10.7ms) | Samples: 34

**Called by:**
- `map` (34)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2636` | Self: 0.0% (10.6ms) | Total: 0.0% (10.8ms) | Samples: 49

**Called by:**
- `map` (50)

**Calls:**
- `parseChecksJson` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2508` | Self: 0.0% (10.6ms) | Total: 0.0% (10.6ms) | Samples: 46

**Called by:**
- `map` (46)

### `Boolean`
`[native code]` | Self: 0.0% (10.4ms) | Total: 0.0% (10.4ms) | Samples: 38

**Called by:**
- `filter` (38)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2637` | Self: 0.0% (10.2ms) | Total: 0.0% (10.2ms) | Samples: 44

**Called by:**
- `map` (44)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2510` | Self: 0.0% (10.1ms) | Total: 0.0% (16.0ms) | Samples: 41

**Called by:**
- `map` (67)

**Calls:**
- `readTaskWeight` (26)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3759` | Self: 0.0% (9.9ms) | Total: 0.1% (27.2ms) | Samples: 45

**Called by:**
- `(module)` (96)

**Calls:**
- `join` (51)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2503` | Self: 0.0% (9.9ms) | Total: 0.0% (9.9ms) | Samples: 27

**Called by:**
- `map` (27)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2564` | Self: 0.0% (9.5ms) | Total: 0.0% (9.5ms) | Samples: 41

**Called by:**
- `map` (41)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2631` | Self: 0.0% (9.5ms) | Total: 0.0% (10.0ms) | Samples: 35

**Called by:**
- `map` (36)

**Calls:**
- `copyDataProperties` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2627` | Self: 0.0% (9.5ms) | Total: 0.0% (9.5ms) | Samples: 40

**Called by:**
- `map` (40)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2512` | Self: 0.0% (9.3ms) | Total: 0.0% (9.3ms) | Samples: 32

**Called by:**
- `map` (32)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2642` | Self: 0.0% (9.3ms) | Total: 0.0% (9.3ms) | Samples: 39

**Called by:**
- `map` (39)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2344` | Self: 0.0% (9.2ms) | Total: 0.0% (9.2ms) | Samples: 40

**Called by:**
- `filter` (40)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2504` | Self: 0.0% (9.1ms) | Total: 0.0% (9.1ms) | Samples: 40

**Called by:**
- `map` (40)

### `node:fs`
`node:fs:8` | Self: 0.0% (9.0ms) | Total: 0.0% (9.0ms) | Samples: 1

### `isAgentWorking`
`/home/user/topics-app/shared/board.ts:431` | Self: 0.0% (8.9ms) | Total: 0.0% (8.9ms) | Samples: 36

**Called by:**
- `deriveQueueReason` (36)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2569` | Self: 0.0% (8.9ms) | Total: 0.2% (36.3ms) | Samples: 37

**Called by:**
- `map` (124)

**Calls:**
- `rejectedPaths` (86)
- `rejectedPaths` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2509` | Self: 0.0% (8.8ms) | Total: 0.0% (8.8ms) | Samples: 38

**Called by:**
- `map` (38)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2505` | Self: 0.0% (8.7ms) | Total: 0.0% (8.7ms) | Samples: 37

**Called by:**
- `map` (37)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2584` | Self: 0.0% (8.4ms) | Total: 0.0% (8.4ms) | Samples: 35

**Called by:**
- `map` (35)

### `query`
`bun:sqlite:345` | Self: 0.0% (8.4ms) | Total: 0.0% (8.4ms) | Samples: 13

**Called by:**
- `previewImagesFor` (7)
- `withSubtaskCounts` (2)
- `buildBatch` (1)
- `labelsFor` (1)
- `withSubtaskCounts` (1)
- `list` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2496` | Self: 0.0% (8.2ms) | Total: 0.0% (8.2ms) | Samples: 36

**Called by:**
- `map` (36)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2640` | Self: 0.0% (8.0ms) | Total: 0.0% (8.0ms) | Samples: 36

**Called by:**
- `map` (36)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2511` | Self: 0.0% (8.0ms) | Total: 0.0% (8.0ms) | Samples: 36

**Called by:**
- `map` (36)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2565` | Self: 0.0% (7.6ms) | Total: 0.0% (7.6ms) | Samples: 34

**Called by:**
- `map` (34)

### `anonymous`
`[native code]` | Self: 0.0% (7.5ms) | Total: 0.2% (38.9ms) | Samples: 28

**Called by:**
- `node:crypto` (33)
- `internal:streams/lazy_transform` (32)
- `internal:streams/transform` (31)
- `internal:streams/duplex` (30)
- `internal:streams/readable` (12)
- `internal:streams/destroy` (5)
- `internal:errors` (5)
- `internal:streams/legacy` (5)
- `internal:streams/add-abort-signal` (4)
- `require` (3)
- `internal:validators` (1)
- `node:path` (1)

**Calls:**
- `internal:streams/lazy_transform` (32)
- `internal:streams/transform` (31)
- `internal:streams/duplex` (30)
- `internal:streams/readable` (12)
- `internal:streams/destroy` (5)
- `internal:errors` (5)
- `internal:streams/legacy` (5)
- `internal:streams/add-abort-signal` (4)
- `internal:primordials` (3)
- `node:events` (1)
- `internal:streams/destroy` (1)
- `internal:validators` (1)
- `bun:ffi` (1)
- `internal:streams/writable` (1)
- `internal:streams/readable` (1)
- `internal:streams/end-of-stream` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2571` | Self: 0.0% (7.3ms) | Total: 0.0% (7.3ms) | Samples: 31

**Called by:**
- `map` (31)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2357` | Self: 0.0% (7.2ms) | Total: 0.2% (43.1ms) | Samples: 17

**Called by:**
- `rowsToTasks` (151)

**Calls:**
- `map` (114)
- `filter` (16)
- `Set` (4)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2579` | Self: 0.0% (6.7ms) | Total: 0.0% (6.7ms) | Samples: 30

**Called by:**
- `map` (30)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2625` | Self: 0.0% (6.7ms) | Total: 0.0% (6.7ms) | Samples: 29

**Called by:**
- `map` (29)

### `toISOString`
`[native code]` | Self: 0.0% (6.5ms) | Total: 0.0% (6.5ms) | Samples: 27

**Called by:**
- `buildBatch` (27)

### `query`
`bun:sqlite:341` | Self: 0.0% (6.3ms) | Total: 0.0% (6.3ms) | Samples: 23

**Called by:**
- `list` (23)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2379` | Self: 0.0% (6.2ms) | Total: 0.0% (6.2ms) | Samples: 28

**Called by:**
- `filter` (28)

### `now`
`[native code]` | Self: 0.0% (6.1ms) | Total: 0.0% (6.1ms) | Samples: 14

**Called by:**
- `(module)` (14)

### `readTaskWeight`
`/home/user/topics-app/shared/board.ts:390` | Self: 0.0% (5.8ms) | Total: 0.0% (5.8ms) | Samples: 26

**Called by:**
- `mapRow` (26)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3757` | Self: 0.0% (5.7ms) | Total: 0.0% (5.7ms) | Samples: 24

**Called by:**
- `(module)` (24)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2647` | Self: 0.0% (5.6ms) | Total: 0.0% (5.6ms) | Samples: 20

**Called by:**
- `map` (20)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2264` | Self: 0.0% (5.2ms) | Total: 1.9% (330.4ms) | Samples: 23

**Called by:**
- `rowsToTasks` (1224)

**Calls:**
- `map` (1201)

### `arrayFromFastWithoutMapFn`
`[native code]` | Self: 0.0% (5.2ms) | Total: 0.0% (5.2ms) | Samples: 23

**Called by:**
- `from` (23)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2588` | Self: 0.0% (5.2ms) | Total: 0.0% (10.3ms) | Samples: 22

**Called by:**
- `map` (45)

**Calls:**
- `copyDataProperties` (23)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2678` | Self: 0.0% (4.9ms) | Total: 0.0% (4.9ms) | Samples: 21

**Called by:**
- `map` (21)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2279` | Self: 0.0% (4.8ms) | Total: 0.0% (4.8ms) | Samples: 16

**Called by:**
- `filter` (16)

### `anteprimaUtile`
`/home/user/topics-app/server/services/tasks.ts:1757` | Self: 0.0% (4.4ms) | Total: 0.4% (74.6ms) | Samples: 19

**Called by:**
- `previewOf` (300)

**Calls:**
- `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` (278)
- `match` (3)

### `Date`
`[native code]` | Self: 0.0% (4.3ms) | Total: 0.0% (4.3ms) | Samples: 17

**Called by:**
- `buildBatch` (17)

### `next`
`[native code]` | Self: 0.0% (4.2ms) | Total: 0.0% (4.2ms) | Samples: 22

**Called by:**
- `from` (22)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2416` | Self: 0.0% (4.1ms) | Total: 0.0% (4.1ms) | Samples: 18

**Called by:**
- `mapRow` (18)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2488` | Self: 0.0% (3.9ms) | Total: 26.1% (4.38s) | Samples: 15

**Called by:**
- `map` (14087)

**Calls:**
- `previewOf` (14072)

### `query`
`bun:sqlite:343` | Self: 0.0% (3.7ms) | Total: 0.0% (4.6ms) | Samples: 17

**Called by:**
- `withSubtaskCounts` (7)
- `labelsFor` (7)
- `readGlobalDispatch` (3)
- `withSubtaskCounts` (2)
- `previewImagesFor` (1)
- `list` (1)

**Calls:**
- `isFinalized` (2)
- `delete` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2679` | Self: 0.0% (3.6ms) | Total: 0.0% (3.8ms) | Samples: 7

**Called by:**
- `(module)` (8)

**Calls:**
- `stringify` (1)

### `lazyCpus`
`node:os` | Self: 0.0% (3.4ms) | Total: 0.0% (3.4ms) | Samples: 1

**Called by:**
- `bound` (1)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:11` | Self: 0.0% (3.3ms) | Total: 99.7% (16.68s) | Samples: 14

**Calls:**
- `list` (30759)
- `list` (24511)
- `withSubtaskCounts` (964)
- `withSubtaskCounts` (430)
- `withSubtaskCounts` (411)
- `withSubtaskCounts` (237)
- `list` (96)
- `list` (87)
- `list` (30)
- `list` (26)
- `list` (24)
- `withSubtaskCounts` (20)
- `list` (14)
- `now` (14)
- `list` (13)
- `withSubtaskCounts` (9)
- `withSubtaskCounts` (8)
- `push` (8)
- `withSubtaskCounts` (6)
- `withSubtaskCounts` (5)
- `withSubtaskCounts` (5)
- `withSubtaskCounts` (3)
- `withSubtaskCounts` (2)
- `withSubtaskCounts` (2)
- `list` (2)
- `list` (2)
- `list` (1)
- `list` (1)
- `list` (1)
- `list` (1)
- `withSubtaskCounts` (1)

### `prepare`
`[native code]` | Self: 0.0% (3.3ms) | Total: 0.0% (3.3ms) | Samples: 14

**Called by:**
- `[prepareOwned]` (14)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3669` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 14

**Called by:**
- `(module)` (14)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2344` | Self: 0.0% (3.0ms) | Total: 0.1% (17.9ms) | Samples: 2

**Called by:**
- `rowsToTasks` (57)

**Calls:**
- `filter` (55)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts` | Self: 0.0% (2.9ms) | Total: 0.0% (2.9ms) | Samples: 13

**Called by:**
- `queueReasonOf` (13)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts:1232` | Self: 0.0% (2.6ms) | Total: 0.0% (2.6ms) | Samples: 6

**Called by:**
- `queueReasonOf` (6)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1965` | Self: 0.0% (2.2ms) | Total: 0.0% (3.6ms) | Samples: 10

**Called by:**
- `buildBatch` (16)

**Calls:**
- `Map` (6)

### `#all`
`bun:sqlite:157` | Self: 0.0% (2.2ms) | Total: 0.0% (2.2ms) | Samples: 10

**Called by:**
- `withSubtaskCounts` (4)
- `labelsFor` (2)
- `previewImagesFor` (1)
- `buildBatch` (1)
- `list` (1)
- `previewImagesFor` (1)

### `push`
`[native code]` | Self: 0.0% (2.2ms) | Total: 0.0% (2.2ms) | Samples: 9

**Called by:**
- `(module)` (8)
- `list` (1)

### `node:child_process`
`node:child_process:2` | Self: 0.0% (2.2ms) | Total: 0.0% (2.2ms) | Samples: 1

### `query`
`bun:sqlite` | Self: 0.0% (2.1ms) | Total: 0.0% (2.1ms) | Samples: 9

**Called by:**
- `labelsFor` (6)
- `previewImagesFor` (2)
- `withSubtaskCounts` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3764` | Self: 0.0% (2.1ms) | Total: 40.9% (6.85s) | Samples: 9

**Called by:**
- `(module)` (24511)

**Calls:**
- `all` (24501)
- `#all` (1)

### `bun:sqlite`
`bun:sqlite:215` | Self: 0.0% (2.0ms) | Total: 0.0% (2.0ms) | Samples: 1

### `cardCommentsFor`
`/home/user/topics-app/server/services/tasks.ts:2059` | Self: 0.0% (1.9ms) | Total: 0.0% (1.9ms) | Samples: 8

**Called by:**
- `buildBatch` (8)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2590` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 8

**Called by:**
- `map` (8)

### `some`
`[native code]` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 8

**Called by:**
- `buildBatch` (8)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2724` | Self: 0.0% (1.8ms) | Total: 0.0% (2.0ms) | Samples: 8

**Called by:**
- `(module)` (9)

**Calls:**
- `get` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3763` | Self: 0.0% (1.8ms) | Total: 0.0% (6.3ms) | Samples: 7

**Called by:**
- `(module)` (26)

**Calls:**
- `listColumns` (12)
- `listColumns` (3)
- `listColumns` (2)
- `listColumns` (1)
- `listColumns` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2613` | Self: 0.0% (1.8ms) | Total: 0.7% (132.0ms) | Samples: 7

**Called by:**
- `map` (461)

**Calls:**
- `queueReasonOf` (188)
- `queueReasonOf` (176)
- `queueReasonOf` (54)
- `queueReasonOf` (18)
- `queueReasonOf` (4)
- `queueReasonOf` (4)
- `queueReasonOf` (2)
- `queueReasonOf` (2)
- `queueReasonOf` (2)
- `queueReasonOf` (1)
- `queueReasonOf` (1)
- `queueReasonOf` (1)
- `queueReasonOf` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (1.7ms) | Total: 0.0% (1.7ms) | Samples: 2

**Called by:**
- `rowsToTasks` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2688` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 6

**Called by:**
- `(module)` (6)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2274` | Self: 0.0% (1.5ms) | Total: 0.6% (108.7ms) | Samples: 7

**Called by:**
- `rowsToTasks` (372)

**Calls:**
- `filter` (348)
- `cardCommentsFor` (8)
- `map` (6)
- `cardCommentsFor` (2)
- `(unknown)` (1)

### `rowsToTasks`
`/home/user/topics-app/server/services/tasks.ts:2654` | Self: 0.0% (1.4ms) | Total: 10.4% (1.74s) | Samples: 6

**Called by:**
- `list` (6149)

**Calls:**
- `buildBatch` (1561)
- `buildBatch` (1224)
- `buildBatch` (873)
- `buildBatch` (665)
- `buildBatch` (390)
- `buildBatch` (372)
- `buildBatch` (181)
- `buildBatch` (151)
- `buildBatch` (124)
- `buildBatch` (120)
- `buildBatch` (108)
- `buildBatch` (82)
- `buildBatch` (57)
- `buildBatch` (53)
- `buildBatch` (52)
- `buildBatch` (52)
- `buildBatch` (47)
- `buildBatch` (11)
- `buildBatch` (6)
- `buildBatch` (4)
- `buildBatch` (2)
- `buildBatch` (2)
- `buildBatch` (2)
- `buildBatch` (2)
- `buildBatch` (1)
- `buildBatch` (1)

### `query`
`bun:sqlite:347` | Self: 0.0% (1.4ms) | Total: 0.0% (4.9ms) | Samples: 7

**Called by:**
- `listColumns` (11)
- `withSubtaskCounts` (8)
- `list` (2)
- `withSubtaskCounts` (1)

**Calls:**
- `[prepareOwned]` (15)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2517` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 5

**Called by:**
- `mapRow` (5)

### `Map`
`[native code]` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 6

**Called by:**
- `labelsFor` (6)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1520` | Self: 0.0% (1.3ms) | Total: 0.0% (1.3ms) | Samples: 6

**Called by:**
- `mapRow` (6)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2285` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 6

**Called by:**
- `rowsToTasks` (6)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2229` | Self: 0.0% (1.1ms) | Total: 1.8% (312.0ms) | Samples: 1

**Called by:**
- `buildBatch` (1073)

**Calls:**
- `all` (1026)
- `stringify` (45)
- `#all` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2300` | Self: 0.0% (1.1ms) | Total: 0.6% (102.2ms) | Samples: 5

**Called by:**
- `rowsToTasks` (390)

**Calls:**
- `map` (338)
- `filter` (47)

### `drawsCardComments`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `filter` (5)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2384` | Self: 0.0% (1.0ms) | Total: 0.0% (2.8ms) | Samples: 3

**Called by:**
- `rowsToTasks` (11)

**Calls:**
- `some` (8)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2727` | Self: 0.0% (950us) | Total: 0.0% (950us) | Samples: 5

**Called by:**
- `(module)` (5)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1521` | Self: 0.0% (917us) | Total: 0.0% (917us) | Samples: 4

**Called by:**
- `mapRow` (4)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2610` | Self: 0.0% (911us) | Total: 0.0% (3.5ms) | Samples: 4

**Called by:**
- `map` (16)

**Calls:**
- `resolveSubtaskWork` (6)
- `resolveSubtaskWork` (4)
- `resolveSubtaskWork` (1)
- `resolveSubtaskWork` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2304` | Self: 0.0% (908us) | Total: 0.0% (908us) | Samples: 4

**Called by:**
- `rowsToTasks` (4)

### `query`
`bun:sqlite:337` | Self: 0.0% (903us) | Total: 0.0% (903us) | Samples: 4

**Called by:**
- `withSubtaskCounts` (3)
- `readGlobalDispatch` (1)

### `createTaskService`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (893us) | Total: 0.0% (893us) | Samples: 2

**Called by:**
- `(module)` (2)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2410` | Self: 0.0% (885us) | Total: 0.0% (885us) | Samples: 4

**Called by:**
- `mapRow` (4)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3733` | Self: 0.0% (872us) | Total: 0.0% (2.9ms) | Samples: 4

**Called by:**
- `(module)` (13)

**Calls:**
- `filter` (9)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2365` | Self: 0.0% (836us) | Total: 0.2% (34.0ms) | Samples: 4

**Called by:**
- `rowsToTasks` (124)

**Calls:**
- `map` (113)
- `filter` (7)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (821us) | Total: 0.0% (821us) | Samples: 4

**Called by:**
- `mapRow` (4)

### `idParam`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (803us) | Total: 0.0% (803us) | Samples: 2

**Called by:**
- `buildBatch` (1)
- `labelsFor` (1)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1824` | Self: 0.0% (717us) | Total: 0.0% (717us) | Samples: 3

**Called by:**
- `list` (3)

### `#all`
`bun:sqlite` | Self: 0.0% (711us) | Total: 0.0% (711us) | Samples: 3

**Called by:**
- `labelsFor` (2)
- `withSubtaskCounts` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3762` | Self: 0.0% (708us) | Total: 0.0% (8.0ms) | Samples: 3

**Called by:**
- `(module)` (30)

**Calls:**
- `query` (23)
- `query` (2)
- `query` (1)
- `query` (1)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1970` | Self: 0.0% (708us) | Total: 0.0% (708us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2266` | Self: 0.0% (681us) | Total: 0.0% (11.5ms) | Samples: 3

**Called by:**
- `rowsToTasks` (47)

**Calls:**
- `toISOString` (27)
- `Date` (17)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2217` | Self: 0.0% (665us) | Total: 0.0% (665us) | Samples: 3

**Called by:**
- `buildBatch` (3)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2677` | Self: 0.0% (665us) | Total: 0.0% (665us) | Samples: 3

**Called by:**
- `(module)` (3)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1969` | Self: 0.0% (648us) | Total: 1.3% (232.8ms) | Samples: 3

**Called by:**
- `buildBatch` (839)

**Calls:**
- `all` (672)
- `idParam` (116)
- `stringify` (43)
- `#all` (2)
- `#all` (2)
- `idParam` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2238` | Self: 0.0% (583us) | Total: 0.0% (583us) | Samples: 3

**Called by:**
- `buildBatch` (3)

### `sort`
`[native code]` | Self: 0.0% (583us) | Total: 0.0% (809us) | Samples: 2

**Called by:**
- `(module)` (3)

**Calls:**
- `(anonymous)` (1)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2406` | Self: 0.0% (516us) | Total: 0.0% (516us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `isFinalized`
`bun:sqlite:104` | Self: 0.0% (494us) | Total: 0.0% (494us) | Samples: 2

**Called by:**
- `query` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2272` | Self: 0.0% (492us) | Total: 0.0% (492us) | Samples: 2

**Called by:**
- `rowsToTasks` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2372` | Self: 0.0% (490us) | Total: 0.1% (32.5ms) | Samples: 2

**Called by:**
- `rowsToTasks` (120)

**Calls:**
- `map` (101)
- `filter` (17)

### `(anonymous)`
`/home/user/topics-app/server/lib/fleet-usage.ts` | Self: 0.0% (488us) | Total: 0.0% (488us) | Samples: 1

**Called by:**
- `(module)` (1)

### `node:crypto`
`node:crypto:84` | Self: 0.0% (483us) | Total: 0.0% (483us) | Samples: 2

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2224` | Self: 0.0% (472us) | Total: 0.0% (472us) | Samples: 2

**Called by:**
- `buildBatch` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2279` | Self: 0.0% (447us) | Total: 0.1% (16.8ms) | Samples: 2

**Called by:**
- `rowsToTasks` (52)

**Calls:**
- `filter` (50)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3746` | Self: 0.0% (444us) | Total: 0.0% (444us) | Samples: 2

**Called by:**
- `(module)` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2725` | Self: 0.0% (440us) | Total: 0.0% (440us) | Samples: 2

**Called by:**
- `(module)` (2)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2413` | Self: 0.0% (433us) | Total: 0.0% (433us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2273` | Self: 0.0% (427us) | Total: 0.0% (427us) | Samples: 2

**Called by:**
- `rowsToTasks` (2)

### `readGlobalDispatch`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 2

**Called by:**
- `buildBatch` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2680` | Self: 0.0% (423us) | Total: 0.0% (4.4ms) | Samples: 2

**Called by:**
- `(module)` (20)

**Calls:**
- `query` (8)
- `query` (7)
- `query` (2)
- `query` (1)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2396` | Self: 0.0% (416us) | Total: 0.0% (416us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `rowsToTasks`
`/home/user/topics-app/server/services/tasks.ts:2653` | Self: 0.0% (410us) | Total: 0.0% (410us) | Samples: 2

**Called by:**
- `list` (2)

### `cardCommentsFor`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (409us) | Total: 0.0% (409us) | Samples: 2

**Called by:**
- `buildBatch` (2)

### `delete`
`[native code]` | Self: 0.0% (400us) | Total: 0.0% (400us) | Samples: 2

**Called by:**
- `query` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2332` | Self: 0.0% (391us) | Total: 0.0% (13.2ms) | Samples: 2

**Called by:**
- `rowsToTasks` (52)

**Calls:**
- `all` (49)
- `query` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2698` | Self: 0.0% (389us) | Total: 0.5% (97.8ms) | Samples: 2

**Called by:**
- `(module)` (411)

**Calls:**
- `all` (408)
- `#all` (1)

### `slice`
`[native code]` | Self: 0.0% (363us) | Total: 0.0% (363us) | Samples: 2

**Called by:**
- `previewOf` (2)

### `RegExp`
`[native code]` | Self: 0.0% (298us) | Total: 0.0% (298us) | Samples: 1

**Called by:**
- `(module)` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3734` | Self: 0.0% (275us) | Total: 0.0% (275us) | Samples: 1

**Called by:**
- `(module)` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2595` | Self: 0.0% (269us) | Total: 0.0% (269us) | Samples: 1

**Called by:**
- `map` (1)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2409` | Self: 0.0% (258us) | Total: 0.0% (258us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `internal:streams/readable`
`internal:streams/readable:55` | Self: 0.0% (255us) | Total: 0.0% (255us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `internal:streams/destroy`
`internal:streams/destroy:16` | Self: 0.0% (254us) | Total: 0.0% (254us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `(unknown)`
`[native code]` | Self: 0.0% (253us) | Total: 0.0% (253us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2281` | Self: 0.0% (253us) | Total: 2.8% (475.7ms) | Samples: 1

**Called by:**
- `rowsToTasks` (1561)

**Calls:**
- `previewImagesFor` (1073)
- `previewImagesFor` (466)
- `previewImagesFor` (10)
- `previewImagesFor` (3)
- `previewImagesFor` (3)
- `previewImagesFor` (2)
- `previewImagesFor` (1)
- `previewImagesFor` (1)
- `previewImagesFor` (1)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1966` | Self: 0.0% (251us) | Total: 0.0% (3.4ms) | Samples: 1

**Called by:**
- `buildBatch` (15)

**Calls:**
- `query` (7)
- `query` (6)
- `query` (1)

### `rejectedPaths`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (249us) | Total: 0.0% (249us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2244` | Self: 0.0% (248us) | Total: 0.0% (248us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2267` | Self: 0.0% (243us) | Total: 1.4% (241.0ms) | Samples: 1

**Called by:**
- `rowsToTasks` (873)

**Calls:**
- `labelsFor` (839)
- `labelsFor` (16)
- `labelsFor` (15)
- `labelsFor` (1)
- `labelsFor` (1)

### `outOfQueuePromise`
`/home/user/topics-app/shared/board.ts:1143` | Self: 0.0% (243us) | Total: 0.0% (243us) | Samples: 1

**Called by:**
- `queueReasonOf` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2230` | Self: 0.0% (243us) | Total: 0.0% (243us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `answering`
`/home/user/topics-app/server/services/deliveryReportProbe.ts` | Self: 0.0% (241us) | Total: 0.0% (241us) | Samples: 1

**Called by:**
- `buildProbe` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2379` | Self: 0.0% (241us) | Total: 0.0% (13.2ms) | Samples: 1

**Called by:**
- `rowsToTasks` (53)

**Calls:**
- `filter` (52)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3694` | Self: 0.0% (240us) | Total: 0.0% (240us) | Samples: 1

**Called by:**
- `(module)` (1)

### `#allNoArgs`
`bun:sqlite` | Self: 0.0% (240us) | Total: 0.0% (240us) | Samples: 1

**Called by:**
- `listColumns` (1)

### `defineProperty`
`[native code]` | Self: 0.0% (239us) | Total: 0.0% (239us) | Samples: 1

**Called by:**
- `copyProps` (1)

### `node:events`
`node:events:300` | Self: 0.0% (239us) | Total: 0.0% (239us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2298` | Self: 0.0% (236us) | Total: 1.1% (185.6ms) | Samples: 1

**Called by:**
- `rowsToTasks` (665)

**Calls:**
- `all` (564)
- `idParam` (69)
- `stringify` (28)
- `#all` (1)
- `idParam` (1)
- `#all` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `(module)` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2293` | Self: 0.0% (231us) | Total: 0.0% (415us) | Samples: 1

**Called by:**
- `rowsToTasks` (2)

**Calls:**
- `query` (1)

### `makeBitMapDescriptor`
`internal:streams/writable` | Self: 0.0% (229us) | Total: 0.0% (229us) | Samples: 1

**Called by:**
- `internal:streams/writable` (1)

### `ownKeys`
`[native code]` | Self: 0.0% (227us) | Total: 0.0% (227us) | Samples: 1

**Called by:**
- `makeSafe` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `sort` (1)

### `@lazy`
`[native code]` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `node:crypto` (1)

### `dlopen`
`[native code]` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `dlopen` (1)

### `setName`
`node:fs:696` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `node:fs` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2524` | Self: 0.0% (221us) | Total: 0.0% (221us) | Samples: 1

**Called by:**
- `map` (1)

### `node:fs`
`node:fs:298` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

### `deprecate`
`internal:util/deprecate` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `node:crypto` (1)

### `require`
`[native code]` | Self: 0.0% (219us) | Total: 0.0% (859us) | Samples: 1

**Called by:**
- `bound require` (4)

**Calls:**
- `anonymous` (3)

### `bun:ffi`
`bun:ffi:217` | Self: 0.0% (218us) | Total: 0.0% (218us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `node:child_process`
`node:child_process:1111` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2311` | Self: 0.0% (214us) | Total: 0.2% (46.4ms) | Samples: 1

**Called by:**
- `rowsToTasks` (181)

**Calls:**
- `map` (170)
- `filter` (10)

### `makeSafe`
`internal:primordials` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `internal:primordials` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2502` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2655` | Self: 0.0% (210us) | Total: 0.0% (210us) | Samples: 1

**Called by:**
- `map` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3752` | Self: 0.0% (210us) | Total: 0.0% (436us) | Samples: 1

**Called by:**
- `(module)` (2)

**Calls:**
- `push` (1)

### `Statement`
`bun:sqlite:84` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `[prepareOwned]` (1)

### `awaitingAnswerFor`
`/home/user/topics-app/server/services/tasks.ts:2025` | Self: 0.0% (207us) | Total: 0.0% (207us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1825` | Self: 0.0% (203us) | Total: 0.0% (461us) | Samples: 1

**Called by:**
- `list` (2)

**Calls:**
- `get` (1)

### `internal:streams/end-of-stream`
`internal:streams/end-of-stream:205` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1519` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2730` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `(module)` (1)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2402` | Self: 0.0% (198us) | Total: 0.0% (198us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `anteprimaUtile`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `previewOf` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (197us) | Total: 0.0% (197us) | Samples: 1

**Called by:**
- `map` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2270` | Self: 0.0% (193us) | Total: 0.0% (193us) | Samples: 1

**Called by:**
- `rowsToTasks` (1)

### `isUnattributedSubtask`
`/home/user/topics-app/shared/board.ts` | Self: 0.0% (192us) | Total: 0.0% (192us) | Samples: 1

**Called by:**
- `resolveSubtaskWork` (1)

### `isAgentWorking`
`/home/user/topics-app/shared/board.ts` | Self: 0.0% (191us) | Total: 0.0% (191us) | Samples: 1

**Called by:**
- `deriveQueueReason` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3720` | Self: 0.0% (189us) | Total: 0.0% (189us) | Samples: 1

**Called by:**
- `(module)` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2411` | Self: 0.0% (187us) | Total: 0.0% (187us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `query`
`bun:sqlite:339` | Self: 0.0% (184us) | Total: 0.0% (184us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2242` | Self: 0.0% (180us) | Total: 0.9% (153.2ms) | Samples: 1

**Called by:**
- `buildBatch` (466)

**Calls:**
- `all` (427)
- `stringify` (37)
- `#all` (1)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (177us) | Total: 0.0% (177us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2687` | Self: 0.0% (176us) | Total: 1.4% (240.8ms) | Samples: 1

**Called by:**
- `(module)` (964)

**Calls:**
- `all` (959)
- `#all` (4)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2678` | Self: 0.0% (175us) | Total: 0.3% (65.4ms) | Samples: 1

**Called by:**
- `(module)` (237)

**Calls:**
- `idParam` (132)
- `stringify` (54)
- `map` (50)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2467` | Self: 0.0% (169us) | Total: 0.0% (169us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `parseChecksJson`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (168us) | Total: 0.0% (168us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `match`
`[native code]` | Self: 0.0% (168us) | Total: 0.0% (513us) | Samples: 1

**Called by:**
- `anteprimaUtile` (3)

**Calls:**
- `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2329` | Self: 0.0% (158us) | Total: 0.1% (28.1ms) | Samples: 1

**Called by:**
- `rowsToTasks` (108)

**Calls:**
- `readGlobalDispatch` (105)
- `readGlobalDispatch` (2)

### `#all`
`bun:sqlite:159` | Self: 0.0% (156us) | Total: 0.0% (156us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `(module)`
`/home/user/topics-app/server/services/deliveryReportProbe.ts:18` | Self: 0.0% (0us) | Total: 0.1% (17.5ms) | Samples: 0

**Calls:**
- `bound join` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 0.0% (8.3ms) | Samples: 0

**Calls:**
- `anonymous` (33)

### `readGlobalDispatch`
`/home/user/topics-app/server/services/tasks.ts:1465` | Self: 0.0% (0us) | Total: 0.1% (27.5ms) | Samples: 0

**Called by:**
- `buildBatch` (105)

**Calls:**
- `get` (101)
- `query` (3)
- `query` (1)

### `node:crypto`
`node:crypto:190` | Self: 0.0% (0us) | Total: 0.0% (219us) | Samples: 0

**Calls:**
- `deprecate` (1)

### `internal:streams/transform`
`internal:streams/transform:2` | Self: 0.0% (0us) | Total: 0.0% (7.0ms) | Samples: 0

**Called by:**
- `anonymous` (31)

**Calls:**
- `anonymous` (31)

### `node:path`
`node:path:2` | Self: 0.0% (0us) | Total: 0.0% (565us) | Samples: 0

**Calls:**
- `anonymous` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2706` | Self: 0.0% (0us) | Total: 0.0% (333us) | Samples: 0

**Called by:**
- `(module)` (2)

**Calls:**
- `query` (1)
- `query` (1)

### `copyProps`
`internal:primordials:27` | Self: 0.0% (0us) | Total: 0.0% (239us) | Samples: 0

**Called by:**
- `makeSafe` (1)

**Calls:**
- `defineProperty` (1)

### `(module)`
`/home/user/topics-app/server/services/deliveryReportProbe.ts:174` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Calls:**
- `probeForRoot` (1)

### `[prepareOwned]`
`bun:sqlite:330` | Self: 0.0% (0us) | Total: 0.0% (3.5ms) | Samples: 0

**Called by:**
- `query` (15)

**Calls:**
- `prepare` (14)
- `Statement` (1)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1831` | Self: 0.0% (0us) | Total: 0.0% (246us) | Samples: 0

**Called by:**
- `list` (1)

**Calls:**
- `filter` (1)

### `createTaskService`
`/home/user/topics-app/server/services/tasks.ts:2807` | Self: 0.0% (0us) | Total: 0.0% (242us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `map` (1)

### `makeSafe`
`internal:primordials:53` | Self: 0.0% (0us) | Total: 0.0% (239us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `copyProps` (1)

### `internal:primordials`
`internal:primordials:76` | Self: 0.0% (0us) | Total: 0.0% (679us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `makeSafe` (1)
- `makeSafe` (1)
- `makeSafe` (1)

### `probeForRoot`
`/home/user/topics-app/server/services/deliveryReportProbe.ts:32` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `buildProbe` (1)

### `internal:streams/lazy_transform`
`internal:streams/lazy_transform:2` | Self: 0.0% (0us) | Total: 0.0% (8.1ms) | Samples: 0

**Called by:**
- `anonymous` (32)

**Calls:**
- `anonymous` (32)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2611` | Self: 0.0% (0us) | Total: 0.0% (231us) | Samples: 0

**Called by:**
- `map` (1)

**Calls:**
- `get` (1)

### `(module)`
`/home/user/topics-app/shared/media-kind.ts:57` | Self: 0.0% (0us) | Total: 0.0% (298us) | Samples: 0

**Calls:**
- `RegExp` (1)

### `bound require`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (859us) | Samples: 0

**Called by:**
- `(anonymous)` (4)

**Calls:**
- `require` (4)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3765` | Self: 0.0% (0us) | Total: 55.0% (9.21s) | Samples: 0

**Called by:**
- `(module)` (30759)

**Calls:**
- `map` (24608)
- `rowsToTasks` (6149)
- `rowsToTasks` (2)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1832` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `list` (1)

**Calls:**
- `filter` (1)

### `internal:streams/destroy`
`internal:streams/destroy:2` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

### `makeSafe`
`internal:primordials:32` | Self: 0.0% (0us) | Total: 0.0% (227us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `ownKeys` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2226` | Self: 0.0% (0us) | Total: 0.0% (7.8ms) | Samples: 0

**Called by:**
- `buildBatch` (10)

**Calls:**
- `query` (7)
- `query` (2)
- `query` (1)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `anonymous` (12)

**Calls:**
- `anonymous` (12)

### `node:crypto`
`node:crypto:39` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Calls:**
- `@lazy` (1)

### `node:fs`
`node:fs:739` | Self: 0.0% (0us) | Total: 0.0% (224us) | Samples: 0

**Calls:**
- `setName` (1)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (565us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `anonymous` (1)

### `dlopen`
`bun:ffi:157` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `dlopen` (1)

### `node:os`
`node:os:110` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Calls:**
- `bound` (1)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1829` | Self: 0.0% (0us) | Total: 0.0% (2.8ms) | Samples: 0

**Called by:**
- `list` (12)

**Calls:**
- `query` (11)
- `#allNoArgs` (1)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.0% (6.7ms) | Samples: 0

**Called by:**
- `anonymous` (30)

**Calls:**
- `anonymous` (30)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2518` | Self: 0.0% (0us) | Total: 0.0% (15.8ms) | Samples: 0

**Called by:**
- `map` (39)

**Calls:**
- `(anonymous)` (22)
- `(anonymous)` (12)
- `(anonymous)` (5)

### `buildProbe`
`/home/user/topics-app/server/services/deliveryReportProbe.ts:149` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `probeForRoot` (1)

**Calls:**
- `answering` (1)

### `internal:errors`
`internal:errors:2` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

### `internal:streams/writable`
`internal:streams/writable:33` | Self: 0.0% (0us) | Total: 0.0% (229us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeBitMapDescriptor` (1)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 0.0% (852us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2718` | Self: 0.0% (0us) | Total: 0.6% (104.4ms) | Samples: 0

**Called by:**
- `(module)` (430)

**Calls:**
- `all` (430)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2692` | Self: 0.0% (0us) | Total: 0.0% (1.0ms) | Samples: 0

**Called by:**
- `(module)` (5)

**Calls:**
- `query` (3)
- `query` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2335` | Self: 0.0% (0us) | Total: 0.1% (30.5ms) | Samples: 0

**Called by:**
- `rowsToTasks` (82)

**Calls:**
- `map` (71)
- `filter` (11)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2278` | Self: 0.0% (0us) | Total: 0.0% (207us) | Samples: 0

**Called by:**
- `rowsToTasks` (1)

**Calls:**
- `awaitingAnswerFor` (1)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1524` | Self: 0.0% (0us) | Total: 0.0% (192us) | Samples: 0

**Called by:**
- `mapRow` (1)

**Calls:**
- `isUnattributedSubtask` (1)

### `bound join`
`[native code]` | Self: 0.0% (0us) | Total: 0.1% (17.5ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `join` (1)

### `(anonymous)`
`/home/user/topics-app/server/lib/fleet-usage.ts:152` | Self: 0.0% (0us) | Total: 0.0% (859us) | Samples: 0

**Called by:**
- `(module)` (4)

**Calls:**
- `bound require` (4)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:7` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Calls:**
- `createTaskService` (2)
- `createTaskService` (1)

### `bound`
`node:os:74` | Self: 0.0% (0us) | Total: 0.0% (3.4ms) | Samples: 0

**Called by:**
- `node:os` (1)

**Calls:**
- `lazyCpus` (1)

### `(module)`
`/home/user/topics-app/server/lib/fleet-usage.ts:170` | Self: 0.0% (0us) | Total: 0.0% (1.5ms) | Samples: 0

**Calls:**
- `(anonymous)` (4)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` | Self: 0.0% (0us) | Total: 0.0% (809us) | Samples: 0

**Calls:**
- `sort` (3)

### `(anonymous)`
`/home/user/topics-app/server/lib/fleet-usage.ts:153` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `dlopen` (1)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts:1311` | Self: 0.0% (0us) | Total: 0.0% (9.1ms) | Samples: 0

**Called by:**
- `queueReasonOf` (37)

**Calls:**
- `isAgentWorking` (36)
- `isAgentWorking` (1)

### `internal:streams/legacy`
`internal:streams/legacy:2` | Self: 0.0% (0us) | Total: 0.0% (1.1ms) | Samples: 0

**Called by:**
- `anonymous` (5)

**Calls:**
- `anonymous` (5)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 71.7% | 12.00s | `[native code]` |
| 27.8% | 4.66s | `/home/user/topics-app/server/services/tasks.ts` |
| 0.1% | 29.3ms | `bun:sqlite` |
| 0.1% | 21.0ms | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 9.4ms | `node:fs` |
| 0.0% | 3.5ms | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts` |
| 0.0% | 3.4ms | `node:os` |
| 0.0% | 2.4ms | `node:child_process` |
| 0.0% | 488us | `/home/user/topics-app/server/lib/fleet-usage.ts` |
| 0.0% | 483us | `node:crypto` |
| 0.0% | 255us | `internal:streams/readable` |
| 0.0% | 254us | `internal:streams/destroy` |
| 0.0% | 241us | `/home/user/topics-app/server/services/deliveryReportProbe.ts` |
| 0.0% | 239us | `node:events` |
| 0.0% | 229us | `internal:streams/writable` |
| 0.0% | 219us | `internal:util/deprecate` |
| 0.0% | 218us | `bun:ffi` |
| 0.0% | 213us | `internal:primordials` |
| 0.0% | 200us | `internal:streams/end-of-stream` |
