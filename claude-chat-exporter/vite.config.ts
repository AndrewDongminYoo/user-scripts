import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Claude Chat Exporter",
        namespace: "http://tampermonkey.net/",
        version:
          process.env["SCRIPT_VERSION"] ??
          new Date().toISOString().slice(0, 10),
        description:
          "Export Claude.ai conversations to Markdown from the conversation page.",
        author: "Dongmin, Yu",
        match: ["https://claude.ai/*"],
        "run-at": "document-idle",
        // A real GM_* grant forces Tampermonkey to run in its sandboxed world,
        // which is exempt from claude.ai's strict CSP. With `@grant none` the
        // script is injected into the page and blocked by script-src.
        grant: ["GM_addStyle"],
      },
    }),
  ],
});
