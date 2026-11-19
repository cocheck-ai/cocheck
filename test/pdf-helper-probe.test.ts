import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const mac = process.platform === "darwin";
let dir = "";
let saved: string | undefined;

before(async () => {
  saved = process.env.COCHECK_PDF_HELPER;
  dir = await mkdtemp(path.join(tmpdir(), "cocheck-probe-"));
});
after(async () => {
  if (saved === undefined) delete process.env.COCHECK_PDF_HELPER;
  else process.env.COCHECK_PDF_HELPER = saved;
  await rm(dir, { recursive: true, force: true });
});

describe("pdf helper availability is a probe that runs it", { skip: !mac && "needs macOS" }, () => {
  it("a helper that exists but fails to execute takes the fallback path, like a missing one", async () => {
    const { pdfHelperAvailable } = await import("../src/timeline/render/pdf-helper.ts");
    const { rendererFor, registeredExtensions } = await import("../src/timeline/render/registry.ts");
    const { fallbackRenderer } = await import("../src/timeline/render/fallback.ts");
    const broken = path.join(dir, "broken-helper");
    await writeFile(broken, "\u0000\u0001 not an executable image", { mode: 0o755 });
    await chmod(broken, 0o755);
    process.env.COCHECK_PDF_HELPER = broken;
    assert.equal(pdfHelperAvailable(), false);
    assert.equal(rendererFor("a.pdf"), fallbackRenderer);
    assert.ok(!registeredExtensions().includes(".pdf"));
  });

  it("a working helper is used, even when it exits non-zero for no arguments", async () => {
    const { pdfHelperAvailable } = await import("../src/timeline/render/pdf-helper.ts");
    const { rendererFor } = await import("../src/timeline/render/registry.ts");
    const fake = path.join(dir, "working-helper");
    await writeFile(fake, "#!/bin/sh\necho usage >&2\nexit 2\n", { mode: 0o755 });
    process.env.COCHECK_PDF_HELPER = fake;
    assert.equal(pdfHelperAvailable(), true);
    assert.equal(rendererFor("a.pdf").name, "pdfkit");
  });

  it("the probe runs once per helper path", async () => {
    const { pdfHelperAvailable } = await import("../src/timeline/render/pdf-helper.ts");
    const counter = path.join(dir, "count");
    const fake = path.join(dir, "counting-helper");
    await writeFile(fake, `#!/bin/sh\necho x >> '${counter}'\nexit 2\n`, { mode: 0o755 });
    process.env.COCHECK_PDF_HELPER = fake;
    pdfHelperAvailable();
    pdfHelperAvailable();
    pdfHelperAvailable();
    const { readFile } = await import("node:fs/promises");
    assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 1);
  });
});
