#!/usr/bin/env node
import { readFileSync } from "node:fs";
import vm from "node:vm";

const noop = () => {};
const requestListeners = [];
const messageListeners = [];
const filters = [];
const browser = {
  webRequest: {
    filterResponseData: () => {
      const f = { write: noop, close: noop, disconnect: noop };
      filters.push(f);
      return f;
    },
    onBeforeSendHeaders: { addListener: noop },
    onCompleted: { addListener: noop },
    onBeforeRequest: { addListener: (fn, filter) => requestListeners.push({ fn, urls: filter.urls.join(" ") }) },
  },
  runtime: {
    onConnect: { addListener: noop },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
  },
  storage: { local: { get: async () => ({}) } },
};
const ctx = vm.createContext({
  browser, console: { log: noop }, TextDecoder, URL, JSON, Date, Math,
  setTimeout, clearTimeout, atob, fetch: noop, AbortController,
});
vm.runInContext(readFileSync(new URL("../src/background/background.js", import.meta.url), "utf8"), ctx);

const SIMULATED_VIDEOS = 200;
const timedtext = requestListeners.find((l) => l.urls.includes("timedtext")).fn;
const captionBody = new TextEncoder().encode("[00:01] caption text ".repeat(20)).buffer;
for (let i = 0; i < SIMULATED_VIDEOS; i++) {
  timedtext({ url: `https://www.youtube.com/api/timedtext?v=vid${String(i).padStart(8, "0")}`, requestId: i });
  const filter = filters[filters.length - 1];
  filter.ondata({ data: captionBody });
  filter.onstop();
}

const getDebug = messageListeners[0];
const dbg = await getDebug({ type: "getDebug" }, {});
const captures = dbg.capturedVideos.length;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "✓" : "✗"} ${name}  ${detail}`);
  if (!ok) failures++;
};
check("captures were ingested", captures > 0, `${captures} in map`);
check(`capture map bounded after ${SIMULATED_VIDEOS} videos`, captures <= 20, `${captures} entries (cap 20)`);
check("newest capture survives pruning", dbg.capturedVideos.includes(`vid${String(SIMULATED_VIDEOS - 1).padStart(8, "0")}`), "");

console.log(failures ? "\n❌ collection bounds violated" : "\n✅ background collections stay bounded");
process.exit(failures ? 1 : 0);
