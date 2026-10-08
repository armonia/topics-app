# CPU Profile

| Duration | Samples | Interval | Functions |
|----------|---------|----------|----------|
| 4.60s | 18822 | 100us | 264 |

**Top 10:** `values` 49.8%, `all` 23.2%, `anonymous` 3.2%, `copyDataProperties` 3.1%, `anteprimaUtile` 1.8%, `mapRow` 1.5%, `stringify` 1.2%, `Set` 1.1%, `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` 1.0%, `queueReasonOf` 0.8%

## Hot Functions (Self Time)

| Self% | Self | Total% | Total | Function | Location |
|------:|-----:|-------:|------:|----------|----------|
| 49.8% | 2.29s | 49.8% | 2.29s | `values` | `[native code]` |
| 23.2% | 1.06s | 23.2% | 1.06s | `all` | `[native code]` |
| 3.2% | 148.1ms | 3.7% | 171.3ms | `anonymous` | `[native code]` |
| 3.1% | 144.2ms | 3.1% | 144.2ms | `copyDataProperties` | `[native code]` |
| 1.8% | 84.6ms | 2.9% | 134.3ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1759` |
| 1.5% | 69.7ms | 1.5% | 69.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2491` |
| 1.2% | 58.0ms | 1.2% | 58.0ms | `stringify` | `[native code]` |
| 1.1% | 50.7ms | 1.1% | 50.7ms | `Set` | `[native code]` |
| 1.0% | 49.5ms | 1.0% | 49.5ms | `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` | `[native code]` |
| 0.8% | 39.0ms | 1.0% | 47.1ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2406` |
| 0.7% | 33.6ms | 19.4% | 893.4ms | `map` | `[native code]` |
| 0.7% | 33.0ms | 0.7% | 33.0ms | `join` | `[native code]` |
| 0.6% | 28.0ms | 0.6% | 28.0ms | `columnNames` | `bun:sqlite:193` |
| 0.4% | 18.6ms | 0.4% | 18.6ms | `get` | `[native code]` |
| 0.3% | 18.1ms | 0.6% | 28.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2630` |
| 0.3% | 17.1ms | 0.5% | 25.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2560` |
| 0.3% | 15.5ms | 0.4% | 21.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2563` |
| 0.3% | 15.2ms | 0.3% | 15.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2650` |
| 0.3% | 15.2ms | 0.3% | 15.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2478` |
| 0.3% | 14.9ms | 0.4% | 22.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2564` |
| 0.3% | 13.8ms | 0.4% | 21.6ms | `filter` | `[native code]` |
| 0.2% | 13.2ms | 0.2% | 13.2ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.2% | 13.1ms | 0.5% | 23.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2590` |
| 0.2% | 11.7ms | 0.2% | 11.7ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2418` |
| 0.2% | 11.2ms | 0.3% | 17.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2558` |
| 0.2% | 10.9ms | 0.2% | 10.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2597` |
| 0.2% | 10.7ms | 0.2% | 10.7ms | `readTaskWeight` | `/home/user/topics-app/shared/board.ts:390` |
| 0.2% | 10.0ms | 0.4% | 19.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2562` |
| 0.2% | 9.5ms | 0.3% | 16.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2561` |
| 0.2% | 9.4ms | 0.4% | 19.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2582` |
| 0.2% | 9.2ms | 0.2% | 9.2ms | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:28` |
| 0.2% | 9.2ms | 0.2% | 9.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2603` |
| 0.1% | 8.3ms | 1.6% | 76.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2615` |
| 0.1% | 8.1ms | 0.1% | 8.1ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3671` |
| 0.1% | 7.8ms | 0.3% | 16.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2544` |
| 0.1% | 7.5ms | 0.1% | 8.0ms | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts:33` |
| 0.1% | 7.3ms | 0.1% | 7.3ms | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:22` |
| 0.1% | 7.2ms | 0.3% | 15.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2600` |
| 0.1% | 7.2ms | 0.1% | 7.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2649` |
| 0.1% | 7.0ms | 0.1% | 7.2ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1755` |
| 0.1% | 6.6ms | 0.3% | 17.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2515` |
| 0.1% | 6.6ms | 0.1% | 7.3ms | `query` | `bun:sqlite:341` |
| 0.1% | 6.3ms | 0.2% | 13.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2546` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `toISOString` | `[native code]` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2427` |
| 0.1% | 6.1ms | 0.1% | 6.1ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2520` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2645` |
| 0.1% | 5.8ms | 0.1% | 5.8ms | `Date` | `[native code]` |
| 0.1% | 5.7ms | 0.1% | 5.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2592` |
| 0.1% | 5.7ms | 0.2% | 11.3ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2359` |
| 0.1% | 5.4ms | 0.1% | 5.6ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3759` |
| 0.1% | 5.3ms | 0.1% | 5.3ms | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts:1175` |
| 0.1% | 5.1ms | 0.4% | 20.8ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3761` |
| 0.1% | 4.7ms | 0.2% | 13.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2559` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `@lazy` | `[native code]` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `isAgentWorking` | `/home/user/topics-app/shared/board.ts:431` |
| 0.0% | 3.6ms | 0.2% | 10.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2545` |
| 0.0% | 3.3ms | 0.0% | 3.3ms | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1232` |
| 0.0% | 3.3ms | 0.1% | 6.8ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3756` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1826` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `includes` | `[native code]` |
| 0.0% | 2.9ms | 0.1% | 6.2ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3735` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `bun:sqlite` |
| 0.0% | 2.2ms | 99.1% | 4.56s | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:11` |
| 0.0% | 2.1ms | 0.1% | 7.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2266` |
| 0.0% | 2.0ms | 1.1% | 51.9ms | `idParam` | `/home/user/topics-app/server/services/tasks.ts:1561` |
| 0.0% | 2.0ms | 0.0% | 3.6ms | `query` | `bun:sqlite:345` |
| 0.0% | 1.9ms | 54.0% | 2.48s | `list` | `/home/user/topics-app/server/services/tasks.ts:3766` |
| 0.0% | 1.8ms | 0.0% | 2.6ms | `query` | `bun:sqlite:343` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `#all` | `bun:sqlite:157` |
| 0.0% | 1.7ms | 0.1% | 6.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2594` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `get columnNames` | `bun:sqlite:193` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `set` | `[native code]` |
| 0.0% | 1.4ms | 0.1% | 7.8ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3767` |
| 0.0% | 1.4ms | 3.4% | 160.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2490` |
| 0.0% | 1.3ms | 0.1% | 9.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2591` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `some` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 1.1ms | 0.1% | 9.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2313` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2219` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2655` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2680` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `Map` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `query` | `bun:sqlite` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3748` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2313` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `#values` | `bun:sqlite:171` |
| 0.0% | 997us | 0.1% | 5.6ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2276` |
| 0.0% | 987us | 0.0% | 987us | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 966us | 0.0% | 966us | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts:1708` |
| 0.0% | 935us | 0.0% | 935us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2679` |
| 0.0% | 932us | 0.0% | 932us | `Boolean` | `[native code]` |
| 0.0% | 925us | 0.1% | 7.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2522` |
| 0.0% | 913us | 0.0% | 913us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2638` |
| 0.0% | 899us | 0.1% | 6.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2374` |
| 0.0% | 898us | 0.2% | 12.9ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2268` |
| 0.0% | 895us | 0.0% | 895us | `push` | `[native code]` |
| 0.0% | 888us | 0.0% | 888us | `Database` | `bun:sqlite` |
| 0.0% | 877us | 0.0% | 1.5ms | `query` | `bun:sqlite:347` |
| 0.0% | 825us | 0.0% | 1.2ms | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts:34` |
| 0.0% | 761us | 0.0% | 761us | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1328` |
| 0.0% | 705us | 0.0% | 705us | `prepare` | `[native code]` |
| 0.0% | 703us | 0.1% | 5.0ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2302` |
| 0.0% | 697us | 0.0% | 2.0ms | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2228` |
| 0.0% | 691us | 49.8% | 2.29s | `allWideRows` | `/home/user/topics-app/server/lib/wide-rows.ts:52` |
| 0.0% | 681us | 0.0% | 1.9ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2386` |
| 0.0% | 680us | 0.0% | 680us | `isArray` | `[native code]` |
| 0.0% | 661us | 0.0% | 661us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts` |
| 0.0% | 657us | 0.0% | 1.1ms | `#values` | `bun:sqlite:174` |
| 0.0% | 602us | 0.0% | 602us | `open` | `[native code]` |
| 0.0% | 578us | 0.0% | 578us | `importModule` | `[native code]` |
| 0.0% | 501us | 0.0% | 501us | `isFinalized` | `bun:sqlite:104` |
| 0.0% | 496us | 0.0% | 496us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2398` |
| 0.0% | 481us | 2.1% | 97.9ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2720` |
| 0.0% | 480us | 0.0% | 2.3ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2281` |
| 0.0% | 473us | 0.0% | 473us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2657` |
| 0.0% | 470us | 0.0% | 470us | `list` | `/home/user/topics-app/server/services/tasks.ts:3768` |
| 0.0% | 464us | 0.0% | 464us | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:17` |
| 0.0% | 461us | 4.2% | 197.7ms | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1971` |
| 0.0% | 452us | 0.0% | 452us | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 452us | 0.0% | 452us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1526` |
| 0.0% | 450us | 0.0% | 450us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2403` |
| 0.0% | 445us | 0.0% | 445us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2226` |
| 0.0% | 445us | 0.0% | 445us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2726` |
| 0.0% | 441us | 8.2% | 377.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2283` |
| 0.0% | 441us | 0.0% | 441us | `(anonymous)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` |
| 0.0% | 437us | 0.0% | 437us | `awaitingAnswerFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 435us | 0.0% | 435us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1521` |
| 0.0% | 433us | 0.0% | 433us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2526` |
| 0.0% | 432us | 0.0% | 2.8ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2346` |
| 0.0% | 424us | 0.0% | 424us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2681` |
| 0.0% | 422us | 0.0% | 422us | `now` | `[native code]` |
| 0.0% | 389us | 0.8% | 40.1ms | `allWideRows` | `/home/user/topics-app/server/lib/wide-rows.ts:50` |
| 0.0% | 340us | 0.0% | 4.4ms | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1968` |
| 0.0% | 304us | 34.0% | 1.56s | `list` | `/home/user/topics-app/server/services/tasks.ts:3769` |
| 0.0% | 282us | 0.0% | 1.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2612` |
| 0.0% | 277us | 0.0% | 277us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2729` |
| 0.0% | 269us | 0.0% | 269us | `makeBitMapDescriptor` | `internal:streams/readable` |
| 0.0% | 264us | 0.0% | 264us | `call` | `[native code]` |
| 0.0% | 262us | 0.0% | 262us | `get columnNames` | `bun:sqlite` |
| 0.0% | 262us | 0.0% | 262us | `awaitingAnswerFor` | `/home/user/topics-app/server/services/tasks.ts:2027` |
| 0.0% | 261us | 0.0% | 261us | `previewOf` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 259us | 0.0% | 259us | `#all` | `bun:sqlite` |
| 0.0% | 258us | 0.0% | 258us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2634` |
| 0.0% | 251us | 0.0% | 251us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2337` |
| 0.0% | 250us | 0.0% | 250us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2381` |
| 0.0% | 249us | 0.0% | 249us | `#allNoArgs` | `bun:sqlite` |
| 0.0% | 248us | 0.0% | 248us | `#values` | `bun:sqlite` |
| 0.0% | 247us | 0.0% | 688us | `sort` | `[native code]` |
| 0.0% | 245us | 0.0% | 245us | `defineCustomPromisifyArgs` | `internal:promisify` |
| 0.0% | 243us | 0.0% | 243us | `(unknown)` | `[native code]` |
| 0.0% | 243us | 0.0% | 243us | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 240us | 0.0% | 240us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1972` |
| 0.0% | 240us | 0.0% | 240us | `every` | `[native code]` |
| 0.0% | 239us | 0.0% | 239us | `node:crypto` | `node:crypto:84` |
| 0.0% | 238us | 0.0% | 238us | `internal:streams/writable` | `internal:streams/writable:213` |
| 0.0% | 237us | 0.0% | 237us | `delete` | `[native code]` |
| 0.0% | 236us | 0.0% | 236us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2271` |
| 0.0% | 236us | 0.0% | 1.9ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2381` |
| 0.0% | 236us | 0.0% | 236us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 235us | 0.0% | 235us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2246` |
| 0.0% | 235us | 0.0% | 235us | `list` | `/home/user/topics-app/server/services/tasks.ts:3673` |
| 0.0% | 232us | 4.3% | 198.0ms | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2689` |
| 0.0% | 232us | 0.3% | 18.1ms | `readGlobalDispatch` | `/home/user/topics-app/server/services/tasks.ts:1467` |
| 0.0% | 229us | 0.0% | 450us | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts:2061` |
| 0.0% | 228us | 0.0% | 228us | `internal:shared` | `internal:shared:2` |
| 0.0% | 226us | 0.0% | 226us | `::bunternal::` | `internal:validators` |
| 0.0% | 225us | 0.0% | 225us | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 225us | 0.0% | 459us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2727` |
| 0.0% | 224us | 0.0% | 224us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2404` |
| 0.0% | 223us | 0.0% | 223us | `allWideRows` | `/home/user/topics-app/server/lib/wide-rows.ts` |
| 0.0% | 221us | 0.0% | 221us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2519` |
| 0.0% | 220us | 0.0% | 220us | `ownKeys` | `[native code]` |
| 0.0% | 219us | 0.0% | 219us | `internal:promisify` | `internal:promisify:2` |
| 0.0% | 216us | 0.0% | 216us | `idParam` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 216us | 0.0% | 216us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 216us | 0.0% | 216us | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:21` |
| 0.0% | 215us | 0.0% | 215us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1524` |
| 0.0% | 214us | 0.0% | 214us | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts` |
| 0.0% | 213us | 0.0% | 213us | `match` | `[native code]` |
| 0.0% | 213us | 0.0% | 213us | `bun:ffi` | `bun:ffi:2` |
| 0.0% | 212us | 0.0% | 212us | `dlopen` | `[native code]` |
| 0.0% | 211us | 0.0% | 211us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2586` |
| 0.0% | 211us | 0.0% | 211us | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 211us | 0.0% | 211us | `node:fs` | `node:fs:400` |
| 0.0% | 210us | 18.5% | 851.4ms | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2656` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2374` |
| 0.0% | 209us | 0.1% | 6.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2520` |
| 0.0% | 208us | 0.0% | 208us | `createSafeIterator` | `internal:primordials` |
| 0.0% | 208us | 0.0% | 208us | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 206us | 0.0% | 206us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 206us | 0.0% | 206us | `query` | `bun:sqlite:337` |
| 0.0% | 205us | 3.6% | 166.0ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2300` |
| 0.0% | 202us | 0.1% | 5.6ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2367` |
| 0.0% | 200us | 0.0% | 200us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2266` |
| 0.0% | 199us | 0.0% | 199us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 199us | 0.0% | 199us | `#values` | `bun:sqlite:173` |
| 0.0% | 199us | 0.0% | 199us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2367` |
| 0.0% | 197us | 0.0% | 620us | `require` | `[native code]` |
| 0.0% | 177us | 0.0% | 177us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2706` |

## Call Tree (Total Time)

| Total% | Total | Self% | Self | Function | Location |
|-------:|------:|------:|-----:|----------|----------|
| 99.1% | 4.56s | 0.0% | 2.2ms | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:11` |
| 54.0% | 2.48s | 0.0% | 1.9ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3766` |
| 49.8% | 2.29s | 0.0% | 691us | `allWideRows` | `/home/user/topics-app/server/lib/wide-rows.ts:52` |
| 49.8% | 2.29s | 49.8% | 2.29s | `values` | `[native code]` |
| 34.0% | 1.56s | 0.0% | 304us | `list` | `/home/user/topics-app/server/services/tasks.ts:3769` |
| 23.2% | 1.06s | 23.2% | 1.06s | `all` | `[native code]` |
| 19.4% | 893.4ms | 0.7% | 33.6ms | `map` | `[native code]` |
| 18.5% | 851.4ms | 0.0% | 210us | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2656` |
| 8.2% | 377.7ms | 0.0% | 441us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2283` |
| 5.5% | 254.0ms | 0.0% | 0us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2231` |
| 4.4% | 203.3ms | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2269` |
| 4.3% | 198.0ms | 0.0% | 232us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2689` |
| 4.2% | 197.7ms | 0.0% | 461us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1971` |
| 3.7% | 171.3ms | 3.2% | 148.1ms | `anonymous` | `[native code]` |
| 3.6% | 166.0ms | 0.0% | 205us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2300` |
| 3.4% | 160.8ms | 0.0% | 1.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2490` |
| 3.2% | 148.0ms | 0.0% | 0us | `previewOf` | `/home/user/topics-app/server/services/tasks.ts:1780` |
| 3.1% | 144.2ms | 3.1% | 144.2ms | `copyDataProperties` | `[native code]` |
| 2.9% | 134.3ms | 1.8% | 84.6ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1759` |
| 2.5% | 119.4ms | 0.0% | 0us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2244` |
| 2.3% | 110.0ms | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2700` |
| 2.1% | 97.9ms | 0.0% | 481us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2720` |
| 1.6% | 76.0ms | 0.1% | 8.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2615` |
| 1.5% | 69.7ms | 1.5% | 69.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2491` |
| 1.2% | 58.0ms | 1.2% | 58.0ms | `stringify` | `[native code]` |
| 1.1% | 51.9ms | 0.0% | 2.0ms | `idParam` | `/home/user/topics-app/server/services/tasks.ts:1561` |
| 1.1% | 50.7ms | 1.1% | 50.7ms | `Set` | `[native code]` |
| 1.0% | 49.5ms | 1.0% | 49.5ms | `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` | `[native code]` |
| 1.0% | 47.1ms | 0.8% | 39.0ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2406` |
| 0.8% | 40.1ms | 0.0% | 389us | `allWideRows` | `/home/user/topics-app/server/lib/wide-rows.ts:50` |
| 0.8% | 36.8ms | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2680` |
| 0.7% | 33.0ms | 0.7% | 33.0ms | `join` | `[native code]` |
| 0.6% | 28.0ms | 0.3% | 18.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2630` |
| 0.6% | 28.0ms | 0.6% | 28.0ms | `columnNames` | `bun:sqlite:193` |
| 0.5% | 25.2ms | 0.3% | 17.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2560` |
| 0.5% | 23.6ms | 0.2% | 13.1ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2590` |
| 0.4% | 22.3ms | 0.3% | 14.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2564` |
| 0.4% | 21.6ms | 0.3% | 13.8ms | `filter` | `[native code]` |
| 0.4% | 21.3ms | 0.3% | 15.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2563` |
| 0.4% | 20.8ms | 0.1% | 5.1ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3761` |
| 0.4% | 19.5ms | 0.2% | 10.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2562` |
| 0.4% | 19.4ms | 0.2% | 9.4ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2582` |
| 0.4% | 18.6ms | 0.4% | 18.6ms | `get` | `[native code]` |
| 0.3% | 18.1ms | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2331` |
| 0.3% | 18.1ms | 0.0% | 232us | `readGlobalDispatch` | `/home/user/topics-app/server/services/tasks.ts:1467` |
| 0.3% | 17.8ms | 0.2% | 11.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2558` |
| 0.3% | 17.1ms | 0.1% | 6.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2515` |
| 0.3% | 16.9ms | 0.1% | 7.8ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2544` |
| 0.3% | 16.7ms | 0.2% | 9.5ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2561` |
| 0.3% | 15.2ms | 0.3% | 15.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2650` |
| 0.3% | 15.2ms | 0.1% | 7.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2600` |
| 0.3% | 15.2ms | 0.3% | 15.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2478` |
| 0.2% | 13.6ms | 0.1% | 4.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2559` |
| 0.2% | 13.3ms | 0.0% | 0us | `(module)` | `/home/user/topics-app/server/services/deliveryReportProbe.ts:18` |
| 0.2% | 13.3ms | 0.0% | 0us | `bound join` | `[native code]` |
| 0.2% | 13.2ms | 0.2% | 13.2ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.2% | 13.0ms | 0.1% | 6.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2546` |
| 0.2% | 12.9ms | 0.0% | 898us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2268` |
| 0.2% | 11.7ms | 0.2% | 11.7ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2418` |
| 0.2% | 11.3ms | 0.1% | 5.7ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2359` |
| 0.2% | 10.9ms | 0.2% | 10.9ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2597` |
| 0.2% | 10.7ms | 0.2% | 10.7ms | `readTaskWeight` | `/home/user/topics-app/shared/board.ts:390` |
| 0.2% | 10.7ms | 0.0% | 0us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2512` |
| 0.2% | 10.7ms | 0.0% | 3.6ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2545` |
| 0.2% | 9.2ms | 0.2% | 9.2ms | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:28` |
| 0.2% | 9.2ms | 0.2% | 9.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2603` |
| 0.1% | 9.1ms | 0.0% | 1.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2313` |
| 0.1% | 9.0ms | 0.0% | 1.3ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2591` |
| 0.1% | 8.8ms | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2334` |
| 0.1% | 8.1ms | 0.1% | 8.1ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3671` |
| 0.1% | 8.0ms | 0.1% | 7.5ms | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts:33` |
| 0.1% | 7.8ms | 0.0% | 1.4ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3767` |
| 0.1% | 7.3ms | 0.1% | 7.3ms | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:22` |
| 0.1% | 7.3ms | 0.1% | 6.6ms | `query` | `bun:sqlite:341` |
| 0.1% | 7.2ms | 0.1% | 7.0ms | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts:1755` |
| 0.1% | 7.2ms | 0.1% | 7.2ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2649` |
| 0.1% | 7.1ms | 0.0% | 2.1ms | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2266` |
| 0.1% | 7.0ms | 0.0% | 925us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2522` |
| 0.1% | 6.8ms | 0.0% | 3.3ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3756` |
| 0.1% | 6.7ms | 0.0% | 899us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2374` |
| 0.1% | 6.5ms | 0.0% | 1.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2594` |
| 0.1% | 6.5ms | 0.0% | 209us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2520` |
| 0.1% | 6.3ms | 0.0% | 0us | `node:crypto` | `node:crypto:2` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `toISOString` | `[native code]` |
| 0.1% | 6.2ms | 0.1% | 6.2ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2427` |
| 0.1% | 6.2ms | 0.0% | 2.9ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3735` |
| 0.1% | 6.1ms | 0.1% | 6.1ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2520` |
| 0.1% | 6.0ms | 0.1% | 6.0ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2645` |
| 0.1% | 5.8ms | 0.0% | 0us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2571` |
| 0.1% | 5.8ms | 0.1% | 5.8ms | `Date` | `[native code]` |
| 0.1% | 5.7ms | 0.1% | 5.7ms | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2592` |
| 0.1% | 5.6ms | 0.1% | 5.4ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3759` |
| 0.1% | 5.6ms | 0.0% | 997us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2276` |
| 0.1% | 5.6ms | 0.0% | 202us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2367` |
| 0.1% | 5.3ms | 0.1% | 5.3ms | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts:1175` |
| 0.1% | 5.1ms | 0.0% | 0us | `internal:streams/transform` | `internal:streams/transform:2` |
| 0.1% | 5.1ms | 0.0% | 0us | `internal:streams/lazy_transform` | `internal:streams/lazy_transform:2` |
| 0.1% | 5.0ms | 0.0% | 703us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2302` |
| 0.1% | 4.9ms | 0.0% | 0us | `internal:streams/duplex` | `internal:streams/duplex:2` |
| 0.0% | 4.5ms | 0.0% | 0us | `node:fs` | `node:fs:8` |
| 0.0% | 4.4ms | 0.0% | 340us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1968` |
| 0.0% | 3.9ms | 0.0% | 3.9ms | `@lazy` | `[native code]` |
| 0.0% | 3.7ms | 0.0% | 3.7ms | `isAgentWorking` | `/home/user/topics-app/shared/board.ts:431` |
| 0.0% | 3.7ms | 0.0% | 0us | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1311` |
| 0.0% | 3.6ms | 0.0% | 2.0ms | `query` | `bun:sqlite:345` |
| 0.0% | 3.3ms | 0.0% | 3.3ms | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1232` |
| 0.0% | 3.2ms | 0.0% | 3.2ms | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1826` |
| 0.0% | 3.1ms | 0.0% | 0us | `listColumns` | `/home/user/topics-app/server/services/tasks.ts:1834` |
| 0.0% | 3.1ms | 0.0% | 3.1ms | `includes` | `[native code]` |
| 0.0% | 3.1ms | 0.0% | 0us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:1834` |
| 0.0% | 2.8ms | 0.0% | 2.8ms | `(anonymous)` | `bun:sqlite` |
| 0.0% | 2.8ms | 0.0% | 432us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2346` |
| 0.0% | 2.6ms | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2337` |
| 0.0% | 2.6ms | 0.0% | 1.8ms | `query` | `bun:sqlite:343` |
| 0.0% | 2.6ms | 0.0% | 0us | `bun:sqlite` | `bun:sqlite:217` |
| 0.0% | 2.3ms | 0.0% | 480us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2281` |
| 0.0% | 2.0ms | 0.0% | 697us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2228` |
| 0.0% | 1.9ms | 0.0% | 681us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2386` |
| 0.0% | 1.9ms | 0.0% | 236us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2381` |
| 0.0% | 1.8ms | 0.0% | 1.8ms | `#all` | `bun:sqlite:157` |
| 0.0% | 1.7ms | 0.0% | 0us | `node:child_process` | `node:child_process:292` |
| 0.0% | 1.7ms | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:2` |
| 0.0% | 1.7ms | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2682` |
| 0.0% | 1.7ms | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:5` |
| 0.0% | 1.6ms | 0.0% | 1.6ms | `get columnNames` | `bun:sqlite:193` |
| 0.0% | 1.6ms | 0.0% | 0us | `node:os` | `node:os:110` |
| 0.0% | 1.5ms | 0.0% | 1.5ms | `set` | `[native code]` |
| 0.0% | 1.5ms | 0.0% | 282us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2612` |
| 0.0% | 1.5ms | 0.0% | 877us | `query` | `bun:sqlite:347` |
| 0.0% | 1.4ms | 0.0% | 0us | `(module)` | `/home/user/topics-app/server/lib/fleet-usage.ts:170` |
| 0.0% | 1.3ms | 0.0% | 0us | `node:path` | `node:path:2` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `some` | `[native code]` |
| 0.0% | 1.2ms | 0.0% | 1.2ms | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 1.2ms | 0.0% | 825us | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts:34` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2219` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts:2655` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2680` |
| 0.0% | 1.1ms | 0.0% | 657us | `#values` | `bun:sqlite:174` |
| 0.0% | 1.1ms | 0.0% | 1.1ms | `Map` | `[native code]` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `query` | `bun:sqlite` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `list` | `/home/user/topics-app/server/services/tasks.ts:3748` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2313` |
| 0.0% | 1.0ms | 0.0% | 1.0ms | `#values` | `bun:sqlite:171` |
| 0.0% | 987us | 0.0% | 987us | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 966us | 0.0% | 966us | `drawsCardComments` | `/home/user/topics-app/server/services/tasks.ts:1708` |
| 0.0% | 935us | 0.0% | 935us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2679` |
| 0.0% | 932us | 0.0% | 932us | `Boolean` | `[native code]` |
| 0.0% | 913us | 0.0% | 913us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2638` |
| 0.0% | 908us | 0.0% | 0us | `internal:errors` | `internal:errors:2` |
| 0.0% | 908us | 0.0% | 0us | `internal:streams/destroy` | `internal:streams/destroy:2` |
| 0.0% | 895us | 0.0% | 895us | `push` | `[native code]` |
| 0.0% | 888us | 0.0% | 888us | `Database` | `bun:sqlite` |
| 0.0% | 882us | 0.0% | 0us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1967` |
| 0.0% | 761us | 0.0% | 761us | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts:1328` |
| 0.0% | 711us | 0.0% | 0us | `internal:validators` | `internal:validators:2` |
| 0.0% | 709us | 0.0% | 0us | `internal:streams/legacy` | `internal:streams/legacy:2` |
| 0.0% | 705us | 0.0% | 0us | `[prepareOwned]` | `bun:sqlite:330` |
| 0.0% | 705us | 0.0% | 705us | `prepare` | `[native code]` |
| 0.0% | 699us | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2280` |
| 0.0% | 688us | 0.0% | 247us | `sort` | `[native code]` |
| 0.0% | 688us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` |
| 0.0% | 680us | 0.0% | 680us | `isArray` | `[native code]` |
| 0.0% | 661us | 0.0% | 661us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts` |
| 0.0% | 620us | 0.0% | 0us | `bound require` | `[native code]` |
| 0.0% | 620us | 0.0% | 197us | `require` | `[native code]` |
| 0.0% | 620us | 0.0% | 0us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts:152` |
| 0.0% | 602us | 0.0% | 602us | `open` | `[native code]` |
| 0.0% | 602us | 0.0% | 0us | `Database` | `bun:sqlite:262` |
| 0.0% | 578us | 0.0% | 578us | `importModule` | `[native code]` |
| 0.0% | 578us | 0.0% | 0us | `(module)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:6` |
| 0.0% | 501us | 0.0% | 501us | `isFinalized` | `bun:sqlite:104` |
| 0.0% | 496us | 0.0% | 496us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2398` |
| 0.0% | 473us | 0.0% | 473us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2657` |
| 0.0% | 470us | 0.0% | 470us | `list` | `/home/user/topics-app/server/services/tasks.ts:3768` |
| 0.0% | 464us | 0.0% | 464us | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:17` |
| 0.0% | 461us | 0.0% | 0us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2295` |
| 0.0% | 459us | 0.0% | 225us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2727` |
| 0.0% | 455us | 0.0% | 0us | `internal:streams/add-abort-signal` | `internal:streams/add-abort-signal:2` |
| 0.0% | 452us | 0.0% | 452us | `rejectedPaths` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 452us | 0.0% | 452us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1526` |
| 0.0% | 450us | 0.0% | 229us | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts:2061` |
| 0.0% | 450us | 0.0% | 450us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2403` |
| 0.0% | 445us | 0.0% | 445us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2726` |
| 0.0% | 445us | 0.0% | 445us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2226` |
| 0.0% | 441us | 0.0% | 441us | `(anonymous)` | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` |
| 0.0% | 437us | 0.0% | 437us | `awaitingAnswerFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 435us | 0.0% | 435us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1521` |
| 0.0% | 433us | 0.0% | 433us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2526` |
| 0.0% | 424us | 0.0% | 424us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2681` |
| 0.0% | 422us | 0.0% | 422us | `now` | `[native code]` |
| 0.0% | 277us | 0.0% | 277us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2729` |
| 0.0% | 269us | 0.0% | 0us | `internal:streams/readable` | `internal:streams/readable:50` |
| 0.0% | 269us | 0.0% | 269us | `makeBitMapDescriptor` | `internal:streams/readable` |
| 0.0% | 264us | 0.0% | 0us | `makeSafe` | `internal:primordials:35` |
| 0.0% | 264us | 0.0% | 264us | `call` | `[native code]` |
| 0.0% | 264us | 0.0% | 0us | `bound call` | `[native code]` |
| 0.0% | 264us | 0.0% | 0us | `internal:primordials` | `internal:primordials:83` |
| 0.0% | 262us | 0.0% | 262us | `get columnNames` | `bun:sqlite` |
| 0.0% | 262us | 0.0% | 262us | `awaitingAnswerFor` | `/home/user/topics-app/server/services/tasks.ts:2027` |
| 0.0% | 261us | 0.0% | 261us | `previewOf` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 259us | 0.0% | 259us | `#all` | `bun:sqlite` |
| 0.0% | 258us | 0.0% | 258us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2634` |
| 0.0% | 251us | 0.0% | 251us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2337` |
| 0.0% | 250us | 0.0% | 250us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2381` |
| 0.0% | 249us | 0.0% | 249us | `#allNoArgs` | `bun:sqlite` |
| 0.0% | 248us | 0.0% | 248us | `#values` | `bun:sqlite` |
| 0.0% | 245us | 0.0% | 0us | `node:crypto` | `node:crypto:103` |
| 0.0% | 245us | 0.0% | 245us | `defineCustomPromisifyArgs` | `internal:promisify` |
| 0.0% | 243us | 0.0% | 243us | `(unknown)` | `[native code]` |
| 0.0% | 243us | 0.0% | 243us | `rowsToTasks` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 241us | 0.0% | 0us | `internal:validators` | `internal:validators:76` |
| 0.0% | 240us | 0.0% | 240us | `every` | `[native code]` |
| 0.0% | 240us | 0.0% | 240us | `labelsFor` | `/home/user/topics-app/server/services/tasks.ts:1972` |
| 0.0% | 240us | 0.0% | 0us | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts:39` |
| 0.0% | 239us | 0.0% | 239us | `node:crypto` | `node:crypto:84` |
| 0.0% | 239us | 0.0% | 0us | `node:crypto` | `node:crypto:58` |
| 0.0% | 238us | 0.0% | 238us | `internal:streams/writable` | `internal:streams/writable:213` |
| 0.0% | 237us | 0.0% | 237us | `delete` | `[native code]` |
| 0.0% | 236us | 0.0% | 236us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts:2271` |
| 0.0% | 236us | 0.0% | 236us | `internal:streams/readable` | `internal:streams/readable:14` |
| 0.0% | 235us | 0.0% | 235us | `list` | `/home/user/topics-app/server/services/tasks.ts:3673` |
| 0.0% | 235us | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2730` |
| 0.0% | 235us | 0.0% | 235us | `previewImagesFor` | `/home/user/topics-app/server/services/tasks.ts:2246` |
| 0.0% | 228us | 0.0% | 228us | `internal:shared` | `internal:shared:2` |
| 0.0% | 226us | 0.0% | 0us | `node:crypto` | `node:crypto:190` |
| 0.0% | 226us | 0.0% | 0us | `deprecate` | `internal:util/deprecate:16` |
| 0.0% | 226us | 0.0% | 226us | `::bunternal::` | `internal:validators` |
| 0.0% | 225us | 0.0% | 225us | `deriveQueueReason` | `/home/user/topics-app/shared/board.ts` |
| 0.0% | 225us | 0.0% | 0us | `list` | `/home/user/topics-app/server/services/tasks.ts:3722` |
| 0.0% | 225us | 0.0% | 0us | `Database` | `bun:sqlite:218` |
| 0.0% | 224us | 0.0% | 224us | `queueReasonOf` | `/home/user/topics-app/server/services/tasks.ts:2404` |
| 0.0% | 223us | 0.0% | 0us | `#all` | `bun:sqlite:160` |
| 0.0% | 223us | 0.0% | 223us | `allWideRows` | `/home/user/topics-app/server/lib/wide-rows.ts` |
| 0.0% | 221us | 0.0% | 221us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2519` |
| 0.0% | 220us | 0.0% | 0us | `makeSafe` | `internal:primordials:32` |
| 0.0% | 220us | 0.0% | 220us | `ownKeys` | `[native code]` |
| 0.0% | 220us | 0.0% | 0us | `internal:primordials` | `internal:primordials:76` |
| 0.0% | 219us | 0.0% | 219us | `internal:promisify` | `internal:promisify:2` |
| 0.0% | 218us | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2694` |
| 0.0% | 216us | 0.0% | 216us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 216us | 0.0% | 216us | `sliceCodePoints` | `/home/user/topics-app/server/lib/code-points.ts:21` |
| 0.0% | 216us | 0.0% | 216us | `idParam` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 215us | 0.0% | 215us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts:1524` |
| 0.0% | 215us | 0.0% | 0us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2708` |
| 0.0% | 214us | 0.0% | 214us | `builderFor` | `/home/user/topics-app/server/lib/wide-rows.ts` |
| 0.0% | 213us | 0.0% | 213us | `bun:ffi` | `bun:ffi:2` |
| 0.0% | 213us | 0.0% | 213us | `match` | `[native code]` |
| 0.0% | 212us | 0.0% | 0us | `dlopen` | `bun:ffi:157` |
| 0.0% | 212us | 0.0% | 0us | `(anonymous)` | `/home/user/topics-app/server/lib/fleet-usage.ts:153` |
| 0.0% | 212us | 0.0% | 212us | `dlopen` | `[native code]` |
| 0.0% | 211us | 0.0% | 211us | `node:fs` | `node:fs:400` |
| 0.0% | 211us | 0.0% | 211us | `mapRow` | `/home/user/topics-app/server/services/tasks.ts:2586` |
| 0.0% | 211us | 0.0% | 211us | `anteprimaUtile` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 209us | 0.0% | 209us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2374` |
| 0.0% | 208us | 0.0% | 0us | `internal:primordials` | `internal:primordials:54` |
| 0.0% | 208us | 0.0% | 208us | `cardCommentsFor` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 208us | 0.0% | 208us | `createSafeIterator` | `internal:primordials` |
| 0.0% | 206us | 0.0% | 206us | `buildBatch` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 206us | 0.0% | 206us | `query` | `bun:sqlite:337` |
| 0.0% | 200us | 0.0% | 200us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2266` |
| 0.0% | 199us | 0.0% | 199us | `(anonymous)` | `/home/user/topics-app/server/services/tasks.ts:2367` |
| 0.0% | 199us | 0.0% | 199us | `#values` | `bun:sqlite:173` |
| 0.0% | 199us | 0.0% | 199us | `resolveSubtaskWork` | `/home/user/topics-app/server/services/tasks.ts` |
| 0.0% | 177us | 0.0% | 177us | `withSubtaskCounts` | `/home/user/topics-app/server/services/tasks.ts:2706` |

## Function Details

### `values`
`[native code]` | Self: 49.8% (2.29s) | Total: 49.8% (2.29s) | Samples: 9596

**Called by:**
- `allWideRows` (9596)

### `all`
`[native code]` | Self: 23.2% (1.06s) | Total: 23.2% (1.06s) | Samples: 4453

**Called by:**
- `previewImagesFor` (1006)
- `withSubtaskCounts` (817)
- `labelsFor` (666)
- `buildBatch` (606)
- `previewImagesFor` (479)
- `withSubtaskCounts` (429)
- `withSubtaskCounts` (412)
- `buildBatch` (38)

### `anonymous`
`[native code]` | Self: 3.2% (148.1ms) | Total: 3.7% (171.3ms) | Samples: 561

**Called by:**
- `map` (538)
- `node:crypto` (25)
- `internal:streams/lazy_transform` (23)
- `internal:streams/transform` (23)
- `internal:streams/duplex` (22)
- `internal:streams/readable` (8)
- `node:path` (5)
- `internal:streams/destroy` (4)
- `internal:errors` (4)
- `internal:validators` (3)
- `internal:streams/legacy` (3)
- `internal:streams/add-abort-signal` (2)
- `require` (2)
- `node:fs` (1)

**Calls:**
- `internal:streams/transform` (23)
- `internal:streams/lazy_transform` (23)
- `internal:streams/duplex` (22)
- `internal:streams/readable` (8)
- `internal:errors` (4)
- `internal:streams/destroy` (4)
- `internal:validators` (3)
- `internal:streams/legacy` (3)
- `internal:streams/add-abort-signal` (2)
- `internal:primordials` (1)
- `internal:primordials` (1)
- `internal:promisify` (1)
- `internal:shared` (1)
- `bun:ffi` (1)
- `internal:streams/readable` (1)
- `internal:primordials` (1)
- `internal:validators` (1)
- `internal:streams/writable` (1)
- `internal:streams/readable` (1)

### `copyDataProperties`
`[native code]` | Self: 3.1% (144.2ms) | Total: 3.1% (144.2ms) | Samples: 593

**Called by:**
- `mapRow` (45)
- `mapRow` (42)
- `mapRow` (42)
- `mapRow` (40)
- `mapRow` (39)
- `mapRow` (35)
- `mapRow` (32)
- `mapRow` (32)
- `mapRow` (32)
- `mapRow` (32)
- `mapRow` (31)
- `mapRow` (31)
- `mapRow` (30)
- `mapRow` (28)
- `mapRow` (28)
- `mapRow` (27)
- `mapRow` (25)
- `mapRow` (21)
- `anteprimaUtile` (1)

### `anteprimaUtile`
`/home/user/topics-app/server/services/tasks.ts:1759` | Self: 1.8% (84.6ms) | Total: 2.9% (134.3ms) | Samples: 360

**Called by:**
- `previewOf` (565)

**Calls:**
- `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/` (204)
- `match` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2491` | Self: 1.5% (69.7ms) | Total: 1.5% (69.7ms) | Samples: 256

**Called by:**
- `map` (256)

### `stringify`
`[native code]` | Self: 1.2% (58.0ms) | Total: 1.2% (58.0ms) | Samples: 221

**Called by:**
- `labelsFor` (74)
- `withSubtaskCounts` (52)
- `previewImagesFor` (46)
- `buildBatch` (32)
- `previewImagesFor` (17)

### `Set`
`[native code]` | Self: 1.1% (50.7ms) | Total: 1.1% (50.7ms) | Samples: 203

**Called by:**
- `idParam` (199)
- `buildBatch` (3)
- `buildBatch` (1)

### `/\n\s*(?:[-*\u2022]\s+\|\d+[.)]\s+)/`
`[native code]` | Self: 1.0% (49.5ms) | Total: 1.0% (49.5ms) | Samples: 204

**Called by:**
- `anteprimaUtile` (204)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2406` | Self: 0.8% (39.0ms) | Total: 1.0% (47.1ms) | Samples: 155

**Called by:**
- `mapRow` (188)

**Calls:**
- `deriveQueueReason` (16)
- `deriveQueueReason` (15)
- `deriveQueueReason` (1)
- `deriveQueueReason` (1)

### `map`
`[native code]` | Self: 0.7% (33.6ms) | Total: 19.4% (893.4ms) | Samples: 131

**Called by:**
- `list` (2814)
- `list` (552)
- `buildBatch` (31)
- `withSubtaskCounts` (26)
- `buildBatch` (18)
- `buildBatch` (18)
- `buildBatch` (18)
- `buildBatch` (15)
- `buildBatch` (13)
- `buildBatch` (9)
- `buildBatch` (1)
- `buildBatch` (1)
- `buildBatch` (1)

**Calls:**
- `mapRow` (670)
- `anonymous` (538)
- `mapRow` (297)
- `mapRow` (256)
- `mapRow` (109)
- `mapRow` (92)
- `mapRow` (88)
- `mapRow` (88)
- `mapRow` (85)
- `mapRow` (82)
- `mapRow` (72)
- `mapRow` (70)
- `mapRow` (68)
- `mapRow` (68)
- `mapRow` (66)
- `mapRow` (60)
- `mapRow` (60)
- `mapRow` (55)
- `mapRow` (51)
- `(anonymous)` (50)
- `mapRow` (48)
- `mapRow` (46)
- `mapRow` (45)
- `mapRow` (44)
- `mapRow` (38)
- `mapRow` (31)
- `mapRow` (29)
- `mapRow` (27)
- `mapRow` (27)
- `mapRow` (25)
- `mapRow` (24)
- `mapRow` (24)
- `mapRow` (22)
- `mapRow` (7)
- `(anonymous)` (5)
- `mapRow` (4)
- `(anonymous)` (4)
- `mapRow` (2)
- `(anonymous)` (2)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `(anonymous)` (1)
- `mapRow` (1)
- `mapRow` (1)
- `(anonymous)` (1)
- `mapRow` (1)

### `join`
`[native code]` | Self: 0.7% (33.0ms) | Total: 0.7% (33.0ms) | Samples: 76

**Called by:**
- `list` (58)
- `list` (15)
- `builderFor` (2)
- `bound join` (1)

### `columnNames`
`bun:sqlite:193` | Self: 0.6% (28.0ms) | Total: 0.6% (28.0ms) | Samples: 119

**Called by:**
- `allWideRows` (119)

### `get`
`[native code]` | Self: 0.4% (18.6ms) | Total: 0.4% (18.6ms) | Samples: 80

**Called by:**
- `readGlobalDispatch` (73)
- `query` (3)
- `builderFor` (2)
- `withSubtaskCounts` (1)
- `withSubtaskCounts` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2630` | Self: 0.3% (18.1ms) | Total: 0.6% (28.0ms) | Samples: 70

**Called by:**
- `map` (109)

**Calls:**
- `copyDataProperties` (39)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2560` | Self: 0.3% (17.1ms) | Total: 0.5% (25.2ms) | Samples: 60

**Called by:**
- `map` (92)

**Calls:**
- `copyDataProperties` (32)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2563` | Self: 0.3% (15.5ms) | Total: 0.4% (21.3ms) | Samples: 60

**Called by:**
- `map` (85)

**Calls:**
- `copyDataProperties` (25)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2650` | Self: 0.3% (15.2ms) | Total: 0.3% (15.2ms) | Samples: 51

**Called by:**
- `map` (51)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2478` | Self: 0.3% (15.2ms) | Total: 0.3% (15.2ms) | Samples: 60

**Called by:**
- `map` (60)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2564` | Self: 0.3% (14.9ms) | Total: 0.4% (22.3ms) | Samples: 56

**Called by:**
- `map` (88)

**Calls:**
- `copyDataProperties` (32)

### `filter`
`[native code]` | Self: 0.3% (13.8ms) | Total: 0.4% (21.6ms) | Samples: 54

**Called by:**
- `buildBatch` (14)
- `list` (9)
- `buildBatch` (8)
- `buildBatch` (7)
- `buildBatch` (7)
- `buildBatch` (7)
- `buildBatch` (6)
- `buildBatch` (6)
- `buildBatch` (3)
- `buildBatch` (3)
- `buildBatch` (2)
- `listColumns` (1)

**Calls:**
- `(anonymous)` (5)
- `drawsCardComments` (4)
- `Boolean` (4)
- `drawsCardComments` (4)
- `(anonymous)` (1)
- `(anonymous)` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.2% (13.2ms) | Total: 0.2% (13.2ms) | Samples: 55

**Called by:**
- `map` (50)
- `filter` (5)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2590` | Self: 0.2% (13.1ms) | Total: 0.5% (23.6ms) | Samples: 46

**Called by:**
- `map` (88)

**Calls:**
- `copyDataProperties` (42)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2418` | Self: 0.2% (11.7ms) | Total: 0.2% (11.7ms) | Samples: 46

**Called by:**
- `mapRow` (46)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2558` | Self: 0.2% (11.2ms) | Total: 0.3% (17.8ms) | Samples: 42

**Called by:**
- `map` (70)

**Calls:**
- `copyDataProperties` (28)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2597` | Self: 0.2% (10.9ms) | Total: 0.2% (10.9ms) | Samples: 44

**Called by:**
- `map` (44)

### `readTaskWeight`
`/home/user/topics-app/shared/board.ts:390` | Self: 0.2% (10.7ms) | Total: 0.2% (10.7ms) | Samples: 46

**Called by:**
- `mapRow` (46)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2562` | Self: 0.2% (10.0ms) | Total: 0.4% (19.5ms) | Samples: 32

**Called by:**
- `map` (72)

**Calls:**
- `copyDataProperties` (40)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2561` | Self: 0.2% (9.5ms) | Total: 0.3% (16.7ms) | Samples: 37

**Called by:**
- `map` (68)

**Calls:**
- `copyDataProperties` (31)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2582` | Self: 0.2% (9.4ms) | Total: 0.4% (19.4ms) | Samples: 37

**Called by:**
- `map` (82)

**Calls:**
- `copyDataProperties` (45)

### `sliceCodePoints`
`/home/user/topics-app/server/lib/code-points.ts:28` | Self: 0.2% (9.2ms) | Total: 0.2% (9.2ms) | Samples: 35

**Called by:**
- `previewOf` (25)
- `mapRow` (10)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2603` | Self: 0.2% (9.2ms) | Total: 0.2% (9.2ms) | Samples: 27

**Called by:**
- `map` (27)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2615` | Self: 0.1% (8.3ms) | Total: 1.6% (76.0ms) | Samples: 27

**Called by:**
- `map` (297)

**Calls:**
- `queueReasonOf` (188)
- `queueReasonOf` (46)
- `queueReasonOf` (25)
- `queueReasonOf` (6)
- `queueReasonOf` (2)
- `queueReasonOf` (2)
- `queueReasonOf` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3671` | Self: 0.1% (8.1ms) | Total: 0.1% (8.1ms) | Samples: 18

**Called by:**
- `(module)` (18)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2544` | Self: 0.1% (7.8ms) | Total: 0.3% (16.9ms) | Samples: 29

**Called by:**
- `map` (60)

**Calls:**
- `copyDataProperties` (31)

### `builderFor`
`/home/user/topics-app/server/lib/wide-rows.ts:33` | Self: 0.1% (7.5ms) | Total: 0.1% (8.0ms) | Samples: 27

**Called by:**
- `allWideRows` (29)

**Calls:**
- `join` (2)

### `sliceCodePoints`
`/home/user/topics-app/server/lib/code-points.ts:22` | Self: 0.1% (7.3ms) | Total: 0.1% (7.3ms) | Samples: 28

**Called by:**
- `mapRow` (28)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2600` | Self: 0.1% (7.2ms) | Total: 0.3% (15.2ms) | Samples: 31

**Called by:**
- `map` (66)

**Calls:**
- `copyDataProperties` (35)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2649` | Self: 0.1% (7.2ms) | Total: 0.1% (7.2ms) | Samples: 27

**Called by:**
- `map` (27)

### `anteprimaUtile`
`/home/user/topics-app/server/services/tasks.ts:1755` | Self: 0.1% (7.0ms) | Total: 0.1% (7.2ms) | Samples: 30

**Called by:**
- `previewOf` (31)

**Calls:**
- `copyDataProperties` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2515` | Self: 0.1% (6.6ms) | Total: 0.3% (17.1ms) | Samples: 26

**Called by:**
- `map` (68)

**Calls:**
- `copyDataProperties` (42)

### `query`
`bun:sqlite:341` | Self: 0.1% (6.6ms) | Total: 0.1% (7.3ms) | Samples: 27

**Called by:**
- `list` (27)
- `readGlobalDispatch` (2)
- `labelsFor` (1)

**Calls:**
- `get` (3)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2546` | Self: 0.1% (6.3ms) | Total: 0.2% (13.0ms) | Samples: 27

**Called by:**
- `map` (55)

**Calls:**
- `copyDataProperties` (28)

### `toISOString`
`[native code]` | Self: 0.1% (6.2ms) | Total: 0.1% (6.2ms) | Samples: 25

**Called by:**
- `buildBatch` (25)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2427` | Self: 0.1% (6.2ms) | Total: 0.1% (6.2ms) | Samples: 25

**Called by:**
- `mapRow` (25)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2520` | Self: 0.1% (6.1ms) | Total: 0.1% (6.1ms) | Samples: 23

**Called by:**
- `mapRow` (23)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2645` | Self: 0.1% (6.0ms) | Total: 0.1% (6.0ms) | Samples: 24

**Called by:**
- `map` (24)

### `Date`
`[native code]` | Self: 0.1% (5.8ms) | Total: 0.1% (5.8ms) | Samples: 24

**Called by:**
- `buildBatch` (24)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2592` | Self: 0.1% (5.7ms) | Total: 0.1% (5.7ms) | Samples: 22

**Called by:**
- `map` (22)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2359` | Self: 0.1% (5.7ms) | Total: 0.2% (11.3ms) | Samples: 14

**Called by:**
- `rowsToTasks` (38)

**Calls:**
- `map` (15)
- `filter` (6)
- `Set` (3)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3759` | Self: 0.1% (5.4ms) | Total: 0.1% (5.6ms) | Samples: 23

**Called by:**
- `(module)` (24)

**Calls:**
- `push` (1)

### `rejectedPaths`
`/home/user/topics-app/server/services/tasks.ts:1175` | Self: 0.1% (5.3ms) | Total: 0.1% (5.3ms) | Samples: 22

**Called by:**
- `mapRow` (22)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3761` | Self: 0.1% (5.1ms) | Total: 0.4% (20.8ms) | Samples: 21

**Called by:**
- `(module)` (79)

**Calls:**
- `join` (58)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2559` | Self: 0.1% (4.7ms) | Total: 0.2% (13.6ms) | Samples: 16

**Called by:**
- `map` (48)

**Calls:**
- `copyDataProperties` (32)

### `@lazy`
`[native code]` | Self: 0.0% (3.9ms) | Total: 0.0% (3.9ms) | Samples: 4

**Called by:**
- `internal:validators` (1)
- `node:os` (1)
- `node:crypto` (1)
- `node:child_process` (1)

### `isAgentWorking`
`/home/user/topics-app/shared/board.ts:431` | Self: 0.0% (3.7ms) | Total: 0.0% (3.7ms) | Samples: 16

**Called by:**
- `deriveQueueReason` (16)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2545` | Self: 0.0% (3.6ms) | Total: 0.2% (10.7ms) | Samples: 15

**Called by:**
- `map` (45)

**Calls:**
- `copyDataProperties` (30)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts:1232` | Self: 0.0% (3.3ms) | Total: 0.0% (3.3ms) | Samples: 15

**Called by:**
- `queueReasonOf` (15)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3756` | Self: 0.0% (3.3ms) | Total: 0.1% (6.8ms) | Samples: 14

**Called by:**
- `(module)` (29)

**Calls:**
- `join` (15)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1826` | Self: 0.0% (3.2ms) | Total: 0.0% (3.2ms) | Samples: 10

**Called by:**
- `list` (10)

### `includes`
`[native code]` | Self: 0.0% (3.1ms) | Total: 0.0% (3.1ms) | Samples: 1

**Called by:**
- `(anonymous)` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3735` | Self: 0.0% (2.9ms) | Total: 0.1% (6.2ms) | Samples: 4

**Called by:**
- `(module)` (13)

**Calls:**
- `filter` (9)

### `(anonymous)`
`bun:sqlite` | Self: 0.0% (2.8ms) | Total: 0.0% (2.8ms) | Samples: 2

**Called by:**
- `Database` (1)
- `bun:sqlite` (1)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:11` | Self: 0.0% (2.2ms) | Total: 99.1% (4.56s) | Samples: 10

**Calls:**
- `list` (10368)
- `list` (6363)
- `withSubtaskCounts` (821)
- `withSubtaskCounts` (429)
- `withSubtaskCounts` (414)
- `withSubtaskCounts` (148)
- `list` (79)
- `list` (29)
- `list` (24)
- `list` (18)
- `list` (17)
- `list` (13)
- `withSubtaskCounts` (8)
- `list` (5)
- `withSubtaskCounts` (4)
- `withSubtaskCounts` (2)
- `push` (2)
- `withSubtaskCounts` (2)
- `list` (2)
- `withSubtaskCounts` (2)
- `now` (2)
- `list` (1)
- `withSubtaskCounts` (1)
- `withSubtaskCounts` (1)
- `list` (1)
- `withSubtaskCounts` (1)
- `withSubtaskCounts` (1)
- `withSubtaskCounts` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2266` | Self: 0.0% (2.1ms) | Total: 0.1% (7.1ms) | Samples: 10

**Called by:**
- `rowsToTasks` (28)

**Calls:**
- `map` (18)

### `idParam`
`/home/user/topics-app/server/services/tasks.ts:1561` | Self: 0.0% (2.0ms) | Total: 1.1% (51.9ms) | Samples: 9

**Called by:**
- `labelsFor` (86)
- `withSubtaskCounts` (70)
- `buildBatch` (52)

**Calls:**
- `Set` (199)

### `query`
`bun:sqlite:345` | Self: 0.0% (2.0ms) | Total: 0.0% (3.6ms) | Samples: 9

**Called by:**
- `labelsFor` (5)
- `previewImagesFor` (3)
- `buildBatch` (1)
- `withSubtaskCounts` (1)
- `list` (1)

**Calls:**
- `set` (2)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3766` | Self: 0.0% (1.9ms) | Total: 54.0% (2.48s) | Samples: 8

**Called by:**
- `(module)` (10368)

**Calls:**
- `allWideRows` (9611)
- `map` (552)
- `allWideRows` (166)
- `query` (27)
- `query` (1)
- `query` (1)
- `query` (1)
- `allWideRows` (1)

### `query`
`bun:sqlite:343` | Self: 0.0% (1.8ms) | Total: 0.0% (2.6ms) | Samples: 8

**Called by:**
- `labelsFor` (5)
- `readGlobalDispatch` (2)
- `withSubtaskCounts` (1)
- `list` (1)
- `buildBatch` (1)
- `previewImagesFor` (1)

**Calls:**
- `isFinalized` (2)
- `delete` (1)

### `#all`
`bun:sqlite:157` | Self: 0.0% (1.8ms) | Total: 0.0% (1.8ms) | Samples: 8

**Called by:**
- `withSubtaskCounts` (3)
- `labelsFor` (2)
- `previewImagesFor` (2)
- `buildBatch` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2594` | Self: 0.0% (1.7ms) | Total: 0.1% (6.5ms) | Samples: 8

**Called by:**
- `map` (29)

**Calls:**
- `copyDataProperties` (21)

### `get columnNames`
`bun:sqlite:193` | Self: 0.0% (1.6ms) | Total: 0.0% (1.6ms) | Samples: 7

**Called by:**
- `allWideRows` (7)

### `set`
`[native code]` | Self: 0.0% (1.5ms) | Total: 0.0% (1.5ms) | Samples: 2

**Called by:**
- `query` (2)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3767` | Self: 0.0% (1.4ms) | Total: 0.1% (7.8ms) | Samples: 6

**Called by:**
- `(module)` (17)

**Calls:**
- `listColumns` (10)
- `listColumns` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2490` | Self: 0.0% (1.4ms) | Total: 3.4% (160.8ms) | Samples: 6

**Called by:**
- `map` (670)

**Calls:**
- `previewOf` (622)
- `sliceCodePoints` (28)
- `sliceCodePoints` (10)
- `sliceCodePoints` (2)
- `previewOf` (1)
- `sliceCodePoints` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2591` | Self: 0.0% (1.3ms) | Total: 0.1% (9.0ms) | Samples: 6

**Called by:**
- `map` (38)

**Calls:**
- `copyDataProperties` (32)

### `some`
`[native code]` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 6

**Called by:**
- `buildBatch` (6)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (1.2ms) | Total: 0.0% (1.2ms) | Samples: 6

**Called by:**
- `mapRow` (6)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2313` | Self: 0.0% (1.1ms) | Total: 0.1% (9.1ms) | Samples: 5

**Called by:**
- `rowsToTasks` (39)

**Calls:**
- `map` (31)
- `filter` (3)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2219` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 5

**Called by:**
- `buildBatch` (5)

### `rowsToTasks`
`/home/user/topics-app/server/services/tasks.ts:2655` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 5

**Called by:**
- `list` (5)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2680` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 4

**Called by:**
- `map` (4)

### `Map`
`[native code]` | Self: 0.0% (1.1ms) | Total: 0.0% (1.1ms) | Samples: 5

**Called by:**
- `labelsFor` (4)
- `cardCommentsFor` (1)

### `query`
`bun:sqlite` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `labelsFor` (2)
- `withSubtaskCounts` (1)
- `withSubtaskCounts` (1)
- `previewImagesFor` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3748` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `(module)` (5)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2313` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `map` (5)

### `#values`
`bun:sqlite:171` | Self: 0.0% (1.0ms) | Total: 0.0% (1.0ms) | Samples: 5

**Called by:**
- `allWideRows` (5)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2276` | Self: 0.0% (997us) | Total: 0.1% (5.6ms) | Samples: 4

**Called by:**
- `rowsToTasks` (23)

**Calls:**
- `filter` (14)
- `cardCommentsFor` (2)
- `cardCommentsFor` (1)
- `map` (1)
- `(unknown)` (1)

### `drawsCardComments`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (987us) | Total: 0.0% (987us) | Samples: 4

**Called by:**
- `filter` (4)

### `drawsCardComments`
`/home/user/topics-app/server/services/tasks.ts:1708` | Self: 0.0% (966us) | Total: 0.0% (966us) | Samples: 4

**Called by:**
- `filter` (4)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2679` | Self: 0.0% (935us) | Total: 0.0% (935us) | Samples: 4

**Called by:**
- `(module)` (4)

### `Boolean`
`[native code]` | Self: 0.0% (932us) | Total: 0.0% (932us) | Samples: 4

**Called by:**
- `filter` (4)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2522` | Self: 0.0% (925us) | Total: 0.1% (7.0ms) | Samples: 4

**Called by:**
- `map` (31)

**Calls:**
- `copyDataProperties` (27)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2638` | Self: 0.0% (913us) | Total: 0.0% (913us) | Samples: 4

**Called by:**
- `map` (4)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2374` | Self: 0.0% (899us) | Total: 0.1% (6.7ms) | Samples: 4

**Called by:**
- `rowsToTasks` (29)

**Calls:**
- `map` (18)
- `filter` (7)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2268` | Self: 0.0% (898us) | Total: 0.2% (12.9ms) | Samples: 4

**Called by:**
- `rowsToTasks` (53)

**Calls:**
- `toISOString` (25)
- `Date` (24)

### `push`
`[native code]` | Self: 0.0% (895us) | Total: 0.0% (895us) | Samples: 4

**Called by:**
- `(module)` (2)
- `list` (1)
- `list` (1)

### `Database`
`bun:sqlite` | Self: 0.0% (888us) | Total: 0.0% (888us) | Samples: 1

**Called by:**
- `(module)` (1)

### `query`
`bun:sqlite:347` | Self: 0.0% (877us) | Total: 0.0% (1.5ms) | Samples: 4

**Called by:**
- `withSubtaskCounts` (5)
- `withSubtaskCounts` (1)
- `list` (1)

**Calls:**
- `[prepareOwned]` (3)

### `builderFor`
`/home/user/topics-app/server/lib/wide-rows.ts:34` | Self: 0.0% (825us) | Total: 0.0% (1.2ms) | Samples: 4

**Called by:**
- `allWideRows` (6)

**Calls:**
- `get` (2)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts:1328` | Self: 0.0% (761us) | Total: 0.0% (761us) | Samples: 1

**Called by:**
- `queueReasonOf` (1)

### `prepare`
`[native code]` | Self: 0.0% (705us) | Total: 0.0% (705us) | Samples: 3

**Called by:**
- `[prepareOwned]` (3)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2302` | Self: 0.0% (703us) | Total: 0.1% (5.0ms) | Samples: 3

**Called by:**
- `rowsToTasks` (22)

**Calls:**
- `map` (13)
- `filter` (6)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2228` | Self: 0.0% (697us) | Total: 0.0% (2.0ms) | Samples: 3

**Called by:**
- `buildBatch` (9)

**Calls:**
- `query` (3)
- `query` (1)
- `query` (1)
- `query` (1)

### `allWideRows`
`/home/user/topics-app/server/lib/wide-rows.ts:52` | Self: 0.0% (691us) | Total: 49.8% (2.29s) | Samples: 3

**Called by:**
- `list` (9611)

**Calls:**
- `values` (9596)
- `#values` (5)
- `#values` (5)
- `#values` (1)
- `#values` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2386` | Self: 0.0% (681us) | Total: 0.0% (1.9ms) | Samples: 3

**Called by:**
- `rowsToTasks` (9)

**Calls:**
- `some` (6)

### `isArray`
`[native code]` | Self: 0.0% (680us) | Total: 0.0% (680us) | Samples: 3

**Called by:**
- `#values` (2)
- `#all` (1)

### `(anonymous)`
`/home/user/topics-app/server/lib/fleet-usage.ts` | Self: 0.0% (661us) | Total: 0.0% (661us) | Samples: 1

**Called by:**
- `(module)` (1)

### `#values`
`bun:sqlite:174` | Self: 0.0% (657us) | Total: 0.0% (1.1ms) | Samples: 3

**Called by:**
- `allWideRows` (5)

**Calls:**
- `isArray` (2)

### `open`
`[native code]` | Self: 0.0% (602us) | Total: 0.0% (602us) | Samples: 2

**Called by:**
- `Database` (2)

### `importModule`
`[native code]` | Self: 0.0% (578us) | Total: 0.0% (578us) | Samples: 2

**Called by:**
- `(module)` (2)

### `isFinalized`
`bun:sqlite:104` | Self: 0.0% (501us) | Total: 0.0% (501us) | Samples: 2

**Called by:**
- `query` (2)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2398` | Self: 0.0% (496us) | Total: 0.0% (496us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2720` | Self: 0.0% (481us) | Total: 2.1% (97.9ms) | Samples: 2

**Called by:**
- `(module)` (414)

**Calls:**
- `all` (412)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2281` | Self: 0.0% (480us) | Total: 0.0% (2.3ms) | Samples: 2

**Called by:**
- `rowsToTasks` (10)

**Calls:**
- `filter` (7)
- `map` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2657` | Self: 0.0% (473us) | Total: 0.0% (473us) | Samples: 2

**Called by:**
- `map` (2)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3768` | Self: 0.0% (470us) | Total: 0.0% (470us) | Samples: 2

**Called by:**
- `(module)` (2)

### `sliceCodePoints`
`/home/user/topics-app/server/lib/code-points.ts:17` | Self: 0.0% (464us) | Total: 0.0% (464us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1971` | Self: 0.0% (461us) | Total: 4.2% (197.7ms) | Samples: 2

**Called by:**
- `buildBatch` (832)

**Calls:**
- `all` (666)
- `idParam` (86)
- `stringify` (74)
- `#all` (2)
- `#all` (1)
- `idParam` (1)

### `rejectedPaths`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (452us) | Total: 0.0% (452us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1526` | Self: 0.0% (452us) | Total: 0.0% (452us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2403` | Self: 0.0% (450us) | Total: 0.0% (450us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2226` | Self: 0.0% (445us) | Total: 0.0% (445us) | Samples: 2

**Called by:**
- `buildBatch` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2726` | Self: 0.0% (445us) | Total: 0.0% (445us) | Samples: 2

**Called by:**
- `(module)` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2283` | Self: 0.0% (441us) | Total: 8.2% (377.7ms) | Samples: 2

**Called by:**
- `rowsToTasks` (1570)

**Calls:**
- `previewImagesFor` (1054)
- `previewImagesFor` (497)
- `previewImagesFor` (9)
- `previewImagesFor` (5)
- `previewImagesFor` (2)
- `previewImagesFor` (1)

### `(anonymous)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` | Self: 0.0% (441us) | Total: 0.0% (441us) | Samples: 1

**Called by:**
- `sort` (1)

### `awaitingAnswerFor`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (437us) | Total: 0.0% (437us) | Samples: 2

**Called by:**
- `buildBatch` (2)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1521` | Self: 0.0% (435us) | Total: 0.0% (435us) | Samples: 2

**Called by:**
- `mapRow` (2)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2526` | Self: 0.0% (433us) | Total: 0.0% (433us) | Samples: 2

**Called by:**
- `map` (2)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2346` | Self: 0.0% (432us) | Total: 0.0% (2.8ms) | Samples: 2

**Called by:**
- `rowsToTasks` (11)

**Calls:**
- `filter` (8)
- `map` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2681` | Self: 0.0% (424us) | Total: 0.0% (424us) | Samples: 2

**Called by:**
- `(module)` (2)

### `now`
`[native code]` | Self: 0.0% (422us) | Total: 0.0% (422us) | Samples: 2

**Called by:**
- `(module)` (2)

### `allWideRows`
`/home/user/topics-app/server/lib/wide-rows.ts:50` | Self: 0.0% (389us) | Total: 0.8% (40.1ms) | Samples: 2

**Called by:**
- `list` (166)

**Calls:**
- `columnNames` (119)
- `builderFor` (29)
- `get columnNames` (7)
- `builderFor` (6)
- `builderFor` (1)
- `get columnNames` (1)
- `builderFor` (1)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1968` | Self: 0.0% (340us) | Total: 0.0% (4.4ms) | Samples: 1

**Called by:**
- `buildBatch` (14)

**Calls:**
- `query` (5)
- `query` (5)
- `query` (2)
- `query` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3769` | Self: 0.0% (304us) | Total: 34.0% (1.56s) | Samples: 1

**Called by:**
- `(module)` (6363)

**Calls:**
- `rowsToTasks` (3542)
- `map` (2814)
- `rowsToTasks` (5)
- `rowsToTasks` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2612` | Self: 0.0% (282us) | Total: 0.0% (1.5ms) | Samples: 1

**Called by:**
- `map` (7)

**Calls:**
- `resolveSubtaskWork` (2)
- `resolveSubtaskWork` (2)
- `resolveSubtaskWork` (1)
- `resolveSubtaskWork` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2729` | Self: 0.0% (277us) | Total: 0.0% (277us) | Samples: 1

**Called by:**
- `(module)` (1)

### `makeBitMapDescriptor`
`internal:streams/readable` | Self: 0.0% (269us) | Total: 0.0% (269us) | Samples: 1

**Called by:**
- `internal:streams/readable` (1)

### `call`
`[native code]` | Self: 0.0% (264us) | Total: 0.0% (264us) | Samples: 1

**Called by:**
- `bound call` (1)

### `get columnNames`
`bun:sqlite` | Self: 0.0% (262us) | Total: 0.0% (262us) | Samples: 1

**Called by:**
- `allWideRows` (1)

### `awaitingAnswerFor`
`/home/user/topics-app/server/services/tasks.ts:2027` | Self: 0.0% (262us) | Total: 0.0% (262us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `previewOf`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (261us) | Total: 0.0% (261us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `#all`
`bun:sqlite` | Self: 0.0% (259us) | Total: 0.0% (259us) | Samples: 1

**Called by:**
- `previewImagesFor` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2634` | Self: 0.0% (258us) | Total: 0.0% (258us) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2337` | Self: 0.0% (251us) | Total: 0.0% (251us) | Samples: 1

**Called by:**
- `map` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2381` | Self: 0.0% (250us) | Total: 0.0% (250us) | Samples: 1

**Called by:**
- `filter` (1)

### `#allNoArgs`
`bun:sqlite` | Self: 0.0% (249us) | Total: 0.0% (249us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `#values`
`bun:sqlite` | Self: 0.0% (248us) | Total: 0.0% (248us) | Samples: 1

**Called by:**
- `allWideRows` (1)

### `sort`
`[native code]` | Self: 0.0% (247us) | Total: 0.0% (688us) | Samples: 1

**Called by:**
- `(module)` (2)

**Calls:**
- `(anonymous)` (1)

### `defineCustomPromisifyArgs`
`internal:promisify` | Self: 0.0% (245us) | Total: 0.0% (245us) | Samples: 1

**Called by:**
- `node:crypto` (1)

### `(unknown)`
`[native code]` | Self: 0.0% (243us) | Total: 0.0% (243us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `rowsToTasks`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (243us) | Total: 0.0% (243us) | Samples: 1

**Called by:**
- `list` (1)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1972` | Self: 0.0% (240us) | Total: 0.0% (240us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `every`
`[native code]` | Self: 0.0% (240us) | Total: 0.0% (240us) | Samples: 1

**Called by:**
- `builderFor` (1)

### `node:crypto`
`node:crypto:84` | Self: 0.0% (239us) | Total: 0.0% (239us) | Samples: 1

### `internal:streams/writable`
`internal:streams/writable:213` | Self: 0.0% (238us) | Total: 0.0% (238us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `delete`
`[native code]` | Self: 0.0% (237us) | Total: 0.0% (237us) | Samples: 1

**Called by:**
- `query` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2271` | Self: 0.0% (236us) | Total: 0.0% (236us) | Samples: 1

**Called by:**
- `rowsToTasks` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2381` | Self: 0.0% (236us) | Total: 0.0% (1.9ms) | Samples: 1

**Called by:**
- `rowsToTasks` (8)

**Calls:**
- `filter` (7)

### `internal:streams/readable`
`internal:streams/readable:14` | Self: 0.0% (236us) | Total: 0.0% (236us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2246` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3673` | Self: 0.0% (235us) | Total: 0.0% (235us) | Samples: 1

**Called by:**
- `(module)` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2689` | Self: 0.0% (232us) | Total: 4.3% (198.0ms) | Samples: 1

**Called by:**
- `(module)` (821)

**Calls:**
- `all` (817)
- `#all` (3)

### `readGlobalDispatch`
`/home/user/topics-app/server/services/tasks.ts:1467` | Self: 0.0% (232us) | Total: 0.3% (18.1ms) | Samples: 1

**Called by:**
- `buildBatch` (78)

**Calls:**
- `get` (73)
- `query` (2)
- `query` (2)

### `cardCommentsFor`
`/home/user/topics-app/server/services/tasks.ts:2061` | Self: 0.0% (229us) | Total: 0.0% (450us) | Samples: 1

**Called by:**
- `buildBatch` (2)

**Calls:**
- `Map` (1)

### `internal:shared`
`internal:shared:2` | Self: 0.0% (228us) | Total: 0.0% (228us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `::bunternal::`
`internal:validators` | Self: 0.0% (226us) | Total: 0.0% (226us) | Samples: 1

**Called by:**
- `deprecate` (1)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts` | Self: 0.0% (225us) | Total: 0.0% (225us) | Samples: 1

**Called by:**
- `queueReasonOf` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2727` | Self: 0.0% (225us) | Total: 0.0% (459us) | Samples: 1

**Called by:**
- `(module)` (2)

**Calls:**
- `get` (1)

### `queueReasonOf`
`/home/user/topics-app/server/services/tasks.ts:2404` | Self: 0.0% (224us) | Total: 0.0% (224us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `allWideRows`
`/home/user/topics-app/server/lib/wide-rows.ts` | Self: 0.0% (223us) | Total: 0.0% (223us) | Samples: 1

**Called by:**
- `list` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2519` | Self: 0.0% (221us) | Total: 0.0% (221us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `ownKeys`
`[native code]` | Self: 0.0% (220us) | Total: 0.0% (220us) | Samples: 1

**Called by:**
- `makeSafe` (1)

### `internal:promisify`
`internal:promisify:2` | Self: 0.0% (219us) | Total: 0.0% (219us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `idParam`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `labelsFor` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `map` (1)

### `sliceCodePoints`
`/home/user/topics-app/server/lib/code-points.ts:21` | Self: 0.0% (216us) | Total: 0.0% (216us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts:1524` | Self: 0.0% (215us) | Total: 0.0% (215us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `builderFor`
`/home/user/topics-app/server/lib/wide-rows.ts` | Self: 0.0% (214us) | Total: 0.0% (214us) | Samples: 1

**Called by:**
- `allWideRows` (1)

### `match`
`[native code]` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `anteprimaUtile` (1)

### `bun:ffi`
`bun:ffi:2` | Self: 0.0% (213us) | Total: 0.0% (213us) | Samples: 1

**Called by:**
- `anonymous` (1)

### `dlopen`
`[native code]` | Self: 0.0% (212us) | Total: 0.0% (212us) | Samples: 1

**Called by:**
- `dlopen` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2586` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `map` (1)

### `anteprimaUtile`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

**Called by:**
- `previewOf` (1)

### `node:fs`
`node:fs:400` | Self: 0.0% (211us) | Total: 0.0% (211us) | Samples: 1

### `rowsToTasks`
`/home/user/topics-app/server/services/tasks.ts:2656` | Self: 0.0% (210us) | Total: 18.5% (851.4ms) | Samples: 1

**Called by:**
- `list` (3542)

**Calls:**
- `buildBatch` (1570)
- `buildBatch` (851)
- `buildBatch` (692)
- `buildBatch` (78)
- `buildBatch` (53)
- `buildBatch` (39)
- `buildBatch` (39)
- `buildBatch` (38)
- `buildBatch` (29)
- `buildBatch` (28)
- `buildBatch` (23)
- `buildBatch` (23)
- `buildBatch` (22)
- `buildBatch` (11)
- `buildBatch` (11)
- `buildBatch` (10)
- `buildBatch` (9)
- `buildBatch` (8)
- `buildBatch` (3)
- `buildBatch` (2)
- `buildBatch` (1)
- `buildBatch` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2374` | Self: 0.0% (209us) | Total: 0.0% (209us) | Samples: 1

**Called by:**
- `map` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2520` | Self: 0.0% (209us) | Total: 0.1% (6.5ms) | Samples: 1

**Called by:**
- `map` (25)

**Calls:**
- `(anonymous)` (23)
- `(anonymous)` (1)

### `createSafeIterator`
`internal:primordials` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `internal:primordials` (1)

### `cardCommentsFor`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (208us) | Total: 0.0% (208us) | Samples: 1

**Called by:**
- `buildBatch` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `rowsToTasks` (1)

### `query`
`bun:sqlite:337` | Self: 0.0% (206us) | Total: 0.0% (206us) | Samples: 1

**Called by:**
- `previewImagesFor` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2300` | Self: 0.0% (205us) | Total: 3.6% (166.0ms) | Samples: 1

**Called by:**
- `rowsToTasks` (692)

**Calls:**
- `all` (606)
- `idParam` (52)
- `stringify` (32)
- `#all` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2367` | Self: 0.0% (202us) | Total: 0.1% (5.6ms) | Samples: 1

**Called by:**
- `rowsToTasks` (23)

**Calls:**
- `map` (18)
- `filter` (3)
- `Set` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2266` | Self: 0.0% (200us) | Total: 0.0% (200us) | Samples: 1

**Called by:**
- `map` (1)

### `resolveSubtaskWork`
`/home/user/topics-app/server/services/tasks.ts` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `mapRow` (1)

### `#values`
`bun:sqlite:173` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `allWideRows` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:2367` | Self: 0.0% (199us) | Total: 0.0% (199us) | Samples: 1

**Called by:**
- `map` (1)

### `require`
`[native code]` | Self: 0.0% (197us) | Total: 0.0% (620us) | Samples: 1

**Called by:**
- `bound require` (3)

**Calls:**
- `anonymous` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2706` | Self: 0.0% (177us) | Total: 0.0% (177us) | Samples: 1

**Called by:**
- `(module)` (1)

### `(module)`
`/home/user/topics-app/server/services/deliveryReportProbe.ts:18` | Self: 0.0% (0us) | Total: 0.2% (13.3ms) | Samples: 0

**Calls:**
- `bound join` (1)

### `internal:validators`
`internal:validators:2` | Self: 0.0% (0us) | Total: 0.0% (711us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `internal:validators`
`internal:validators:76` | Self: 0.0% (0us) | Total: 0.0% (241us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `@lazy` (1)

### `deprecate`
`internal:util/deprecate:16` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Called by:**
- `node:crypto` (1)

**Calls:**
- `::bunternal::` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2280` | Self: 0.0% (0us) | Total: 0.0% (699us) | Samples: 0

**Called by:**
- `rowsToTasks` (3)

**Calls:**
- `awaitingAnswerFor` (2)
- `awaitingAnswerFor` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2694` | Self: 0.0% (0us) | Total: 0.0% (218us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `query` (1)

### `node:crypto`
`node:crypto:190` | Self: 0.0% (0us) | Total: 0.0% (226us) | Samples: 0

**Calls:**
- `deprecate` (1)

### `internal:streams/transform`
`internal:streams/transform:2` | Self: 0.0% (0us) | Total: 0.1% (5.1ms) | Samples: 0

**Called by:**
- `anonymous` (23)

**Calls:**
- `anonymous` (23)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2244` | Self: 0.0% (0us) | Total: 2.5% (119.4ms) | Samples: 0

**Called by:**
- `buildBatch` (497)

**Calls:**
- `all` (479)
- `stringify` (17)
- `#all` (1)

### `node:path`
`node:path:2` | Self: 0.0% (0us) | Total: 0.0% (1.3ms) | Samples: 0

**Calls:**
- `anonymous` (5)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2512` | Self: 0.0% (0us) | Total: 0.2% (10.7ms) | Samples: 0

**Called by:**
- `map` (46)

**Calls:**
- `readTaskWeight` (46)

### `list`
`/home/user/topics-app/server/services/tasks.ts:3722` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `push` (1)

### `internal:primordials`
`internal:primordials:83` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `bound call`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `makeSafe` (1)

**Calls:**
- `call` (1)

### `previewImagesFor`
`/home/user/topics-app/server/services/tasks.ts:2231` | Self: 0.0% (0us) | Total: 5.5% (254.0ms) | Samples: 0

**Called by:**
- `buildBatch` (1054)

**Calls:**
- `all` (1006)
- `stringify` (46)
- `#all` (2)

### `[prepareOwned]`
`bun:sqlite:330` | Self: 0.0% (0us) | Total: 0.0% (705us) | Samples: 0

**Called by:**
- `query` (3)

**Calls:**
- `prepare` (3)

### `previewOf`
`/home/user/topics-app/server/services/tasks.ts:1780` | Self: 0.0% (0us) | Total: 3.2% (148.0ms) | Samples: 0

**Called by:**
- `mapRow` (622)

**Calls:**
- `anteprimaUtile` (565)
- `anteprimaUtile` (31)
- `sliceCodePoints` (25)
- `anteprimaUtile` (1)

### `internal:streams/readable`
`internal:streams/readable:50` | Self: 0.0% (0us) | Total: 0.0% (269us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeBitMapDescriptor` (1)

### `#all`
`bun:sqlite:160` | Self: 0.0% (0us) | Total: 0.0% (223us) | Samples: 0

**Called by:**
- `labelsFor` (1)

**Calls:**
- `isArray` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2337` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Called by:**
- `rowsToTasks` (11)

**Calls:**
- `map` (9)
- `filter` (2)

### `deriveQueueReason`
`/home/user/topics-app/shared/board.ts:1311` | Self: 0.0% (0us) | Total: 0.0% (3.7ms) | Samples: 0

**Called by:**
- `queueReasonOf` (16)

**Calls:**
- `isAgentWorking` (16)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:6` | Self: 0.0% (0us) | Total: 0.0% (578us) | Samples: 0

**Calls:**
- `importModule` (2)

### `internal:streams/legacy`
`internal:streams/legacy:2` | Self: 0.0% (0us) | Total: 0.0% (709us) | Samples: 0

**Called by:**
- `anonymous` (3)

**Calls:**
- `anonymous` (3)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2334` | Self: 0.0% (0us) | Total: 0.1% (8.8ms) | Samples: 0

**Called by:**
- `rowsToTasks` (39)

**Calls:**
- `all` (38)
- `#allNoArgs` (1)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:5` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Calls:**
- `Database` (2)
- `Database` (1)
- `Database` (1)

### `node:crypto`
`node:crypto:58` | Self: 0.0% (0us) | Total: 0.0% (239us) | Samples: 0

**Calls:**
- `@lazy` (1)

### `bun:sqlite`
`bun:sqlite:217` | Self: 0.0% (0us) | Total: 0.0% (2.6ms) | Samples: 0

**Calls:**
- `(anonymous)` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2680` | Self: 0.0% (0us) | Total: 0.8% (36.8ms) | Samples: 0

**Called by:**
- `(module)` (148)

**Calls:**
- `idParam` (70)
- `stringify` (52)
- `map` (26)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2295` | Self: 0.0% (0us) | Total: 0.0% (461us) | Samples: 0

**Called by:**
- `rowsToTasks` (2)

**Calls:**
- `query` (1)
- `query` (1)

### `node:os`
`node:os:110` | Self: 0.0% (0us) | Total: 0.0% (1.6ms) | Samples: 0

**Calls:**
- `@lazy` (1)

### `(anonymous)`
`/home/user/topics-app/server/lib/fleet-usage.ts:153` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `dlopen` (1)

### `dlopen`
`bun:ffi:157` | Self: 0.0% (0us) | Total: 0.0% (212us) | Samples: 0

**Called by:**
- `(anonymous)` (1)

**Calls:**
- `dlopen` (1)

### `listColumns`
`/home/user/topics-app/server/services/tasks.ts:1834` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Called by:**
- `list` (1)

**Calls:**
- `filter` (1)

### `internal:streams/destroy`
`internal:streams/destroy:2` | Self: 0.0% (0us) | Total: 0.0% (908us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `node:crypto`
`node:crypto:103` | Self: 0.0% (0us) | Total: 0.0% (245us) | Samples: 0

**Calls:**
- `defineCustomPromisifyArgs` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2700` | Self: 0.0% (0us) | Total: 2.3% (110.0ms) | Samples: 0

**Called by:**
- `(module)` (429)

**Calls:**
- `all` (429)

### `internal:errors`
`internal:errors:2` | Self: 0.0% (0us) | Total: 0.0% (908us) | Samples: 0

**Called by:**
- `anonymous` (4)

**Calls:**
- `anonymous` (4)

### `labelsFor`
`/home/user/topics-app/server/services/tasks.ts:1967` | Self: 0.0% (0us) | Total: 0.0% (882us) | Samples: 0

**Called by:**
- `buildBatch` (4)

**Calls:**
- `Map` (4)

### `internal:primordials`
`internal:primordials:54` | Self: 0.0% (0us) | Total: 0.0% (208us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `createSafeIterator` (1)

### `makeSafe`
`internal:primordials:32` | Self: 0.0% (0us) | Total: 0.0% (220us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `ownKeys` (1)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2331` | Self: 0.0% (0us) | Total: 0.3% (18.1ms) | Samples: 0

**Called by:**
- `rowsToTasks` (78)

**Calls:**
- `readGlobalDispatch` (78)

### `internal:streams/readable`
`internal:streams/readable:2` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `anonymous` (8)

**Calls:**
- `anonymous` (8)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2708` | Self: 0.0% (0us) | Total: 0.0% (215us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `query` (1)

### `internal:streams/add-abort-signal`
`internal:streams/add-abort-signal:2` | Self: 0.0% (0us) | Total: 0.0% (455us) | Samples: 0

**Called by:**
- `anonymous` (2)

**Calls:**
- `anonymous` (2)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2682` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Called by:**
- `(module)` (8)

**Calls:**
- `query` (5)
- `query` (1)
- `query` (1)
- `query` (1)

### `Database`
`bun:sqlite:218` | Self: 0.0% (0us) | Total: 0.0% (225us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `(anonymous)` (1)

### `bound require`
`[native code]` | Self: 0.0% (0us) | Total: 0.0% (620us) | Samples: 0

**Called by:**
- `(anonymous)` (3)

**Calls:**
- `require` (3)

### `buildBatch`
`/home/user/topics-app/server/services/tasks.ts:2269` | Self: 0.0% (0us) | Total: 4.4% (203.3ms) | Samples: 0

**Called by:**
- `rowsToTasks` (851)

**Calls:**
- `labelsFor` (832)
- `labelsFor` (14)
- `labelsFor` (4)
- `labelsFor` (1)

### `node:crypto`
`node:crypto:2` | Self: 0.0% (0us) | Total: 0.1% (6.3ms) | Samples: 0

**Calls:**
- `anonymous` (25)

### `makeSafe`
`internal:primordials:35` | Self: 0.0% (0us) | Total: 0.0% (264us) | Samples: 0

**Called by:**
- `internal:primordials` (1)

**Calls:**
- `bound call` (1)

### `(anonymous)`
`/home/user/topics-app/server/services/tasks.ts:1834` | Self: 0.0% (0us) | Total: 0.0% (3.1ms) | Samples: 0

**Called by:**
- `filter` (1)

**Calls:**
- `includes` (1)

### `withSubtaskCounts`
`/home/user/topics-app/server/services/tasks.ts:2730` | Self: 0.0% (0us) | Total: 0.0% (235us) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `get` (1)

### `node:fs`
`node:fs:8` | Self: 0.0% (0us) | Total: 0.0% (4.5ms) | Samples: 0

**Calls:**
- `anonymous` (1)

### `builderFor`
`/home/user/topics-app/server/lib/wide-rows.ts:39` | Self: 0.0% (0us) | Total: 0.0% (240us) | Samples: 0

**Called by:**
- `allWideRows` (1)

**Calls:**
- `every` (1)

### `mapRow`
`/home/user/topics-app/server/services/tasks.ts:2571` | Self: 0.0% (0us) | Total: 0.1% (5.8ms) | Samples: 0

**Called by:**
- `map` (24)

**Calls:**
- `rejectedPaths` (22)
- `rejectedPaths` (2)

### `internal:streams/duplex`
`internal:streams/duplex:2` | Self: 0.0% (0us) | Total: 0.1% (4.9ms) | Samples: 0

**Called by:**
- `anonymous` (22)

**Calls:**
- `anonymous` (22)

### `node:child_process`
`node:child_process:292` | Self: 0.0% (0us) | Total: 0.0% (1.7ms) | Samples: 0

**Calls:**
- `@lazy` (1)

### `internal:streams/lazy_transform`
`internal:streams/lazy_transform:2` | Self: 0.0% (0us) | Total: 0.1% (5.1ms) | Samples: 0

**Called by:**
- `anonymous` (23)

**Calls:**
- `anonymous` (23)

### `bound join`
`[native code]` | Self: 0.0% (0us) | Total: 0.2% (13.3ms) | Samples: 0

**Called by:**
- `(module)` (1)

**Calls:**
- `join` (1)

### `Database`
`bun:sqlite:262` | Self: 0.0% (0us) | Total: 0.0% (602us) | Samples: 0

**Called by:**
- `(module)` (2)

**Calls:**
- `open` (2)

### `(anonymous)`
`/home/user/topics-app/server/lib/fleet-usage.ts:152` | Self: 0.0% (0us) | Total: 0.0% (620us) | Samples: 0

**Called by:**
- `(module)` (3)

**Calls:**
- `bound require` (3)

### `internal:primordials`
`internal:primordials:76` | Self: 0.0% (0us) | Total: 0.0% (220us) | Samples: 0

**Called by:**
- `anonymous` (1)

**Calls:**
- `makeSafe` (1)

### `(module)`
`/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts:12` | Self: 0.0% (0us) | Total: 0.0% (688us) | Samples: 0

**Calls:**
- `sort` (2)

### `(module)`
`/home/user/topics-app/server/lib/fleet-usage.ts:170` | Self: 0.0% (0us) | Total: 0.0% (1.4ms) | Samples: 0

**Calls:**
- `(anonymous)` (3)
- `(anonymous)` (1)
- `(anonymous)` (1)

## Files

| Self% | Self | File |
|------:|-----:|------|
| 85.6% | 3.94s | `[native code]` |
| 12.1% | 557.2ms | `/home/user/topics-app/server/services/tasks.ts` |
| 1.1% | 51.4ms | `bun:sqlite` |
| 0.4% | 18.8ms | `/home/user/topics-app/shared/board.ts` |
| 0.3% | 17.3ms | `/home/user/topics-app/server/lib/code-points.ts` |
| 0.2% | 9.8ms | `/home/user/topics-app/server/lib/wide-rows.ts` |
| 0.0% | 2.6ms | `/tmp/claude-0/-home-user-topics-app/dba43c97-f806-5847-9f48-9cc8fda85c31/scratchpad/bench/prof.ts` |
| 0.0% | 661us | `/home/user/topics-app/server/lib/fleet-usage.ts` |
| 0.0% | 505us | `internal:streams/readable` |
| 0.0% | 464us | `internal:promisify` |
| 0.0% | 239us | `node:crypto` |
| 0.0% | 238us | `internal:streams/writable` |
| 0.0% | 228us | `internal:shared` |
| 0.0% | 226us | `internal:validators` |
| 0.0% | 213us | `bun:ffi` |
| 0.0% | 211us | `node:fs` |
| 0.0% | 208us | `internal:primordials` |
