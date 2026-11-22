// Embedded as TEXT, not as a `type: "file"` asset: a file import makes `bun build`
// emit a second output, which breaks every `--outfile=/dev/null` run of the
// server graph (the hot-reload gate, the shared-inputs probe). Text is inlined
// in the bundle, so the compiled sidecar has it and from source it is the file.
import recorderBundle from "../assets/rrweb.min.js" with { type: "text" };

let cachedRecorderSource: string | undefined;

/** The recorder shared by the server browser and native-host route. */
export function getRrwebRecorderSource(): string {
  // The text is part of the module: a missing rrweb.min.js fails when the
  // server is bundled or loads, never here. An empty or stale file still
  // loads as it is; rrweb-recorder.test.ts compares it with the installed rrweb.
  cachedRecorderSource ??= recorderBundle.replace(/\n\/\/# sourceMappingURL=.*$/m, "");
  return cachedRecorderSource;
}

