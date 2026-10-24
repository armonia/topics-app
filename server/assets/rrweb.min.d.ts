// rrweb.min.js is a plain script with no exports, so tsc reports TS2306 on a bare
// import. Bun's `type: "file"` import yields the file path as the default export.
declare const path: string;
export default path;
