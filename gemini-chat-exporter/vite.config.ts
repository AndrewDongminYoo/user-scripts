import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Gemini Chat Exporter",
        namespace: "http://tampermonkey.net/",
        version:
          process.env["SCRIPT_VERSION"] ??
          new Date().toISOString().slice(0, 10),
        description:
          "Export gemini.google.com conversations to Markdown/JSON from the conversation page.",
        author: "Dongmin, Yu",
        match: ["https://gemini.google.com/*"],
        "run-at": "document-idle",
        // A real GM_* grant forces Tampermonkey's sandboxed world, which is
        // exempt from Gemini's strict CSP. With `@grant none` the injected
        // script is blocked by script-src and never runs.
        grant: ["GM_addStyle", "GM_getValue", "GM_setValue"],
      },
    }),
  ],
});
