#!/usr/bin/env node
// The `cocheck` bin. An installed package (and a built checkout) runs the built dist/cli-main.js; a source checkout that was never built
// runs src/cli-main.ts, which Node strips of types itself (it cannot inside node_modules, which is why the package ships dist/).
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const built = new URL("../dist/cli-main.js", import.meta.url);
await import(existsSync(built) ? built.href : pathToFileURL(new URL("../src/cli-main.ts", import.meta.url).pathname).href);
