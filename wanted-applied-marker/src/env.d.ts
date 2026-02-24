import type {
  GmGetValueType,
  GmSetValueType,
} from "vite-plugin-monkey/dist/client";

declare global {
  const GM_getValue: GmGetValueType;
  const GM_setValue: GmSetValueType;
}
