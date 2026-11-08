import { resolve } from "path";
import { loadNativeModule } from "../server/lib/native-addon";
import { walkFileTreeJs } from "../server/lib/file-tree";

const RUNS = 20;
const DEPTHS = [3, 6];

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (fraction === 0.5 && sorted.length % 2 === 0) {
    const middle = sorted.length / 2;
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

export async function measureFileTree(roots = process.argv.slice(2).map((root) => resolve(root))): Promise<void> {
  if (roots.length === 0) roots = [process.cwd()];
  const nativeWalk = loadNativeModule()?.walkFileTree;
  if (!nativeWalk) throw new Error("native walkFileTree is unavailable; build the addon first");

  for (const root of roots) {
    for (const depth of DEPTHS) {
      for (const [label, walk] of [["js", walkFileTreeJs], ["native", nativeWalk]] as const) {
        const durations: number[] = [];
        for (let run = 0; run < RUNS; run++) {
          const started = performance.now();
          await walk(root, depth);
          durations.push(performance.now() - started);
        }
        console.log(`${root} depth=${depth} walker=${label} runs=${RUNS} median=${percentile(durations, 0.5).toFixed(2)}ms p95=${percentile(durations, 0.95).toFixed(2)}ms`);
      }
    }
  }
}

if (import.meta.main) await measureFileTree();
