// The one function that decides how a connector's URI subject (a Notion page, a Linear issue) is shown on the page: Change.file, the call text,
// the stop labels and the Files view all take its answer. It never returns more than the path scrub would show.
//   - Display form: `<scheme>://<host><path>`, with userinfo, query and fragment removed.
//   - Shown whole only if the host is [A-Za-z0-9.-]+ (optional :port) and every path segment is [A-Za-z0-9._~-]+. Anything else (file://, encoded,
//     a token shape, a local path) shows as the path scrub shows a path: its last segment if that is on the allow-list or a secret name (the text
//     scrub words it), else (also when the text matches a known token shape) "[outside link]". Never more than that.
// Only a row whose `connector` column is set gets this; any other URI-pathed row is scrubbed by the path scrub.

import { isSecretPath } from "../secret-files.ts";
import { firstSecretRule } from "../secret-scan.ts";
import { baseName } from "./runs.ts";

const PARTS = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i;
const HOST = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;
const ROOTS = /^\/(?:Users|home|root|private|Volumes|tmp|var|etc|opt|mnt|usr|proc|sys)(?:\/|$)/i;
const HOME_ANYWHERE = /(?:^|\/)(?:Users|home)\/[^/]+\//i;
// Token shapes by prefix: the detector's entropy floor clears a made-up or low-entropy token, so a segment that starts like a known key is cut too.
const TOKEN_PREFIX = /(?:^|[-_.~/])(?:gh[pousr]_|github_pat_|sk-|sk_|pk_|rk_|xox[abprs]-|glpat-|AKIA|ASIA|AIza|npm_|bearer)/i;
const tokenLike = (t: string): boolean => TOKEN_PREFIX.test(t) || firstSecretRule(t) !== undefined;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

export interface SubjectDisplay {
  text: string;
  /** True when `text` is a clean display form the text scrub must leave alone; false when it is the path-scrub form, which the scrub still reads. */
  whole: boolean;
}

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };

export function subjectDisplay(subject: string): SubjectDisplay {
  const m = PARTS.exec(subject);
  // The fallback: the last segment of the original string, kept only when it is itself on the allow-list or is a secret name (the text scrub words
  // that); anything else (encoded, a token shape, a local path) is "[outside link]".
  const cut = (): SubjectDisplay => {
    const name = baseName(subject.replace(/[?#].*$/s, "").replace(/[\\/]+$/, ""));
    const secret = name !== "" && (isSecretPath(name) || isSecretPath(decode(name)));
    return { text: name !== "" && (secret || (SEGMENT.test(name) && !tokenLike(name))) ? name : "[outside link]", whole: false };
  };
  if (m === null) return cut();
  const [, scheme, auth, rest] = m;
  const host = auth!.replace(/^.*@/s, "");
  const path = rest!;
  const segments = path === "" ? [] : path.replace(/\/$/, "").split("/").slice(1);
  const clean = scheme!.toLowerCase() !== "file" && HOST.test(host) && (path === "" || path.startsWith("/")) && segments.every((x) => SEGMENT.test(x));
  if (!clean || ROOTS.test(path) || HOME_ANYWHERE.test(path) || isSecretPath(decode(path)) || tokenLike(decode(path))) return cut();
  return { text: `${scheme}://${host}${path}`, whole: true };
}
