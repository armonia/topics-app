// rrweb.min.js is a plain script with no exports, so tsc reports TS2306 on a bare
// import. Bun's `type: "text"` import yields the file's text as the default export.
declare const text: string;
export default text;
