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
        grant: "none",
      },
    }),
  ],
});
