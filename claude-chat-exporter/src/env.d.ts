import type {
  GmAddStyleType,
  GmGetValueType,
  GmSetValueType,
} from "vite-plugin-monkey/dist/client";

declare global {
  const GM_addStyle: GmAddStyleType;
  const GM_getValue: GmGetValueType;
  const GM_setValue: GmSetValueType;
}
