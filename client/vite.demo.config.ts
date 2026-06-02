import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Redirect EVERY import that resolves to src/lib/api or src/hooks/useWebSocket
// (relative OR @-aliased) to the demo mocks. resolve.alias only matches exact
// specifiers, so components using relative imports (../../lib/api) bypass it —
// a resolveId plugin catches all forms.
function mockModules(): Plugin {
  const apiMock = path.resolve(__dirname, "src/demo/api.mock.ts");
  const wsMock = path.resolve(__dirname, "src/demo/useWebSocket.mock.ts");
  return {
    name: "demo-mock-modules",
    enforce: "pre",
    resolveId(source) {
      if (source === "@/lib/api" || /(^|\/)lib\/api(\.ts)?$/.test(source)) return apiMock;
      if (source === "@/hooks/useWebSocket" || /(^|\/)hooks\/useWebSocket(\.ts)?$/.test(source)) return wsMock;
      return null;
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, "src/demo"),
  base: "./",
  define: { __BUILD_TIME__: JSON.stringify("demo"), __DEMO__: "true" },
  plugins: [mockModules(), react(), tailwindcss()],
  resolve: { alias: [{ find: "@", replacement: path.resolve(__dirname, "src") }] },
  build: { outDir: path.resolve(__dirname, "../landing/app"), emptyOutDir: true },
});
