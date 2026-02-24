import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "Wanted Applied Marker (Infinite Scroll)",
        namespace: "http://tampermonkey.net/",
        version: "2026-02-24",
        description:
          "Mark/hide already-applied jobs on Wanted list. Works with infinite scroll.",
        author: "Dongmin, Yu",
        match: ["https://www.wanted.co.kr/wdlist/*"],
        "run-at": "document-idle",
        grant: ["GM_getValue", "GM_setValue"],
      },
    }),
  ],
});
