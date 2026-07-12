import type {
  GmAddStyleType,
  GmGetValueType,
  GmSetValueType,
} from "vite-plugin-monkey/dist/client";

declare global {
  const GM_addStyle: GmAddStyleType;
  const GM_getValue: GmGetValueType;
  const GM_setValue: GmSetValueType;
  // The page (main-world) window. Under @grant, the script runs in a sandbox;
  // unsafeWindow reaches the page world where Angular's XHR/fetch + cookies
  // live, so the observe-replay interceptor can patch the app's real traffic.
  const unsafeWindow: Window & typeof globalThis;
}
