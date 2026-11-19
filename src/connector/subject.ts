// The one test for "is this ledger subject a connector URI or a local file path". A subject is what `file_states.file_path` holds: an absolute
// path for a built-in file, or `<scheme>://...` for a connector's subject (a Notion page, a Linear issue). Every place that hands a subject to the
// filesystem asks this function first; none re-derives it. A Windows drive path (`C:\a`, `C:/a`) is a file, never a URI.

const URI = /^[a-z][a-z0-9+.-]*:\/\//i;
const WINDOWS_DRIVE = /^[a-z]:[\\/]/i;

export function isUriSubject(subject: string): boolean {
  return !WINDOWS_DRIVE.test(subject) && URI.test(subject);
}
