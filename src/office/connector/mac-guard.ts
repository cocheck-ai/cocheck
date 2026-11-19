// OS facts the screen helper shares with the Office driver (split out of office-macos.ts): the test guard and the `ps lstart` reader.
// Office-only: its two users are screen-macos.ts and office-macos.ts, both connector code, so it moved here from src/platform; nothing else imported it.
export function guard(): void {
  if (process.env.COCHECK_TEST_NO_OFFICE === "1" && process.env.COCHECK_ALLOW_REAL_OFFICE !== "1") {
    throw new Error("test reached the real Office bridge: use a fake driver, or set COCHECK_ALLOW_REAL_OFFICE=1 for a deliberate live run");
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `ps -o lstart=` read with LC_ALL=C and TZ=UTC ("Wed Nov 11 01:06:35 2026") as epoch ms, or null. */
export function parseLstartUtc(s: string): number | null {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(s);
  const mon = m === null ? -1 : MONTHS.indexOf(m[1]!);
  if (m === null || mon < 0) return null;
  return Date.UTC(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}
