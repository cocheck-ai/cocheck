import { DatabaseSync } from "node:sqlite";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { redactSecrets } from "./secret-scan.ts";
import { hardenHomeAndSay } from "./home-perms.ts";
import { type ProofMethod } from "./attribution/basis.ts";

/** Ledger schema version 9; a ledger at any other version is refused (`openLedger`), never migrated. */
export const SCHEMA_VERSION = 9;

/**
 * The signature kind of a soft sign-off, the rail's Submit. It is written only by `recordSoftSubmission`, a fixed value,
 * so no request body, CLI argument or MCP call can supply it.
 */
export const SOFT_SIGNATURE = "soft";

/** The words every surface shows beside a soft sign-off. The one wording. */
export const SOFT_SIGNOFF_LABEL = "soft sign-off, not verified";

/** The qualifier a surface shows beside a sign-off. Never empty for a record that exists: no sign-off is verified. */
export function signoffQualifier(record: Pick<SignoffRow, "signature">): string {
  return record.signature === SOFT_SIGNATURE ? SOFT_SIGNOFF_LABEL : "unverified";
}

/**
 * The ledger's schema version: one row, written when the ledger is created and never updated; `openLedger` reads `MAX(version)`.
 */
const SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);
`;

const SCHEMA = `

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  title TEXT,
  client TEXT
);

CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  ts TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  intent TEXT NOT NULL,
  client_name TEXT,
  client_version TEXT,
  duration_ms INTEGER NOT NULL,
  result_code TEXT NOT NULL,
  error_text TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  op_id INTEGER,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  FOREIGN KEY (op_id) REFERENCES ops(id)
);

-- A file snapshot taken for a task. round 0 is the baseline taken on the file's first touch in
-- the task; round N is the snapshot taken by the Nth submit. mode is how the bytes were
-- captured: 'copy' (byte copy, file closed or saved in its app) or 'missing' (no file at the path).
-- Round-1 rows may say 'excel-save-copy', a path removed because it lost the user's unsaved edits;
-- a file open with unsaved edits is now refused (UNSAVED_CHANGES_OPEN) instead.
CREATE TABLE IF NOT EXISTS task_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  layer TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  mode TEXT NOT NULL,
  ts TEXT NOT NULL,
  sha256 TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- A snapshot whose file copy was deleted. The row stays: its sha256 is the fingerprint.
CREATE TABLE IF NOT EXISTS snapshot_removals (
  snapshot_id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL
);

-- A round's checks and "what moved", computed when the round was cut. Written by nothing now; kept
-- while old rows exist so the values expiry can still blank them.
CREATE TABLE IF NOT EXISTS round_results (
  round_id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  ts TEXT NOT NULL
);

-- The last agent or reviewer activity per task and actor ('agent': any tool call that joined or
-- cut the task; 'reviewer': a page open, round cut, decision or request). One definition, read by expiry and rollover.
CREATE TABLE IF NOT EXISTS task_activity (
  task_id INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent', 'reviewer')),
  ts TEXT NOT NULL,
  PRIMARY KEY (task_id, actor)
);

-- A task closed without a sign-off. kind is 'expired' (no activity for 7 days).
CREATE TABLE IF NOT EXISTS task_closures (
  task_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('expired')),
  ts TEXT NOT NULL
);

-- A task whose values (review rows' before/after/detail, ops' args) were expired. Lets the guards below
-- allow blanking those columns for that task, and nothing else.
CREATE TABLE IF NOT EXISTS values_expired (
  task_id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL
);

-- A step: one sweep of the hook adapter that found a changed file, written in the same flush as the ops of the calls
-- it is credited to. Its id is the key ops, file states, prompts and narration point at; seq is the adapter's own
-- counter and only makes the write idempotent across a kill.
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  client TEXT NOT NULL,
  seq INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('Pre', 'Post', 'Stop')),
  ts TEXT NOT NULL,
  calls_open_json TEXT NOT NULL,
  credited_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (task_id, client, seq),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- One file's state at one step. kept: 'whole' (the bytes are in the task's states folder, named by sha256), 'hash' (no
-- bytes were ever kept: over the scan caps), 'gone' (the file was deleted; sha256 is empty). note says in words why a
-- state is not an ordinary whole copy.
CREATE TABLE IF NOT EXISTS file_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  prev_sha256 TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('Pre', 'Post', 'Stop')),
  calls_open_json TEXT NOT NULL,
  credited_json TEXT NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL,
  kept TEXT NOT NULL CHECK (kept IN ('whole', 'hash', 'gone')),
  note TEXT NOT NULL,
  mtime_ns TEXT,
  credit_basis TEXT CHECK (credit_basis IS NULL OR credit_basis IN ('argv-tag', 'host-reported-edit', 'declared', 'named', 'window', 'joint', 'unattributed')),
  connector TEXT,
  connector_version TEXT,
  connector_spec TEXT,
  changes_sha256 TEXT,
  before_basis TEXT CHECK (before_basis IS NULL OR before_basis IN ('declared')),
  FOREIGN KEY (step_id) REFERENCES steps(id)
);
CREATE INDEX IF NOT EXISTS file_states_task ON file_states (task_id, id);

-- What an after-capture of a connector subject came to, one row per request (recorded, unchanged, no-before, no-connector, no-window, rejected, error).
-- reason is a plain sentence the rail shows for a known-subject failure; task_id is NULL when no task could be named (a subject no connector covers).
CREATE TABLE IF NOT EXISTS capture_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  ts TEXT NOT NULL,
  client TEXT NOT NULL,
  call_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('recorded', 'unchanged', 'no-before', 'no-connector', 'no-window', 'rejected', 'error')),
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS capture_outcomes_task ON capture_outcomes (task_id, id);
CREATE TRIGGER IF NOT EXISTS capture_outcomes_no_update BEFORE UPDATE ON capture_outcomes BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS capture_outcomes_no_delete BEFORE DELETE ON capture_outcomes BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- A stored state whose bytes were deleted (a size cap, a sign-off, an expiry). The event rows stay; reason is for the page.
CREATE TABLE IF NOT EXISTS state_removals (
  task_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  ts TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (task_id, sha256)
);

-- One row per submit. last_op_id is the highest ops.id that existed when the round was
-- cut: the next round's rows are explained only by ops after it. final = 1 closes the task.
CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  intent TEXT NOT NULL,
  client_name TEXT,
  final INTEGER NOT NULL,
  last_op_id INTEGER NOT NULL,
  UNIQUE (task_id, seq),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- One row per diff row a round produced. id is the stable review-item id. location is
-- layer-defined and stable within a file (xlsx: "Sheet1!B3"). status: 'explained' (ops_json names
-- the op(s) that wrote it), 'derived' (a downstream consequence no op needed to write, e.g. a
-- recalculated formula), or 'unlogged' (changed, and no op explains it). ops_json is an array of
-- {opId, tool, intent, client}; detail_json is the layer's own full row.
CREATE TABLE IF NOT EXISTS review_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  layer TEXT NOT NULL,
  location TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('explained', 'derived', 'unlogged')),
  before_json TEXT,
  after_json TEXT,
  ops_json TEXT NOT NULL,
  description TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  FOREIGN KEY (round_id) REFERENCES rounds(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- A reviewer's decision on one review row. The latest decision per row wins; nothing is ever
-- overwritten. after_op_id is the highest ops.id when the decision was made: a later 'fixed'
-- resolution of a rejection needs an op after it.
CREATE TABLE IF NOT EXISTS review_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_id INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  note TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  after_op_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (row_id) REFERENCES review_rows(id)
);

-- The agent's answer to an open review item (an item resolution). decision_id is the rejection
-- it answers (NULL for an unlogged row nobody rejected); a later rejection reopens the item.
-- op_ids_json lists the logged ops that touched the item's cell, for 'fixed'.
CREATE TABLE IF NOT EXISTS item_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_id INTEGER NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('fixed', 'accepted')),
  intent TEXT NOT NULL,
  client_name TEXT,
  decision_id INTEGER,
  op_ids_json TEXT NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (row_id) REFERENCES review_rows(id),
  FOREIGN KEY (decision_id) REFERENCES review_decisions(id)
);

-- A reviewer's task-level request for a change the agent didn't make, tied to no review row.
-- after_op_id is the highest ops.id when it was filed: a later 'fixed' resolution needs a logged
-- write in the task after it. Open until a request_resolutions row answers it.
CREATE TABLE IF NOT EXISTS review_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  note TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  after_op_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- The agent's answer to one request (a request resolution).
CREATE TABLE IF NOT EXISTS request_resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('fixed', 'accepted')),
  intent TEXT NOT NULL,
  client_name TEXT,
  op_ids_json TEXT NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES review_requests(id)
);

-- A reviewer's verdict on the agent's answer to a request (the answer is request_resolutions row
-- resolution_id). 'confirm' closes the request; 'reject' reopens it with the note. A newer answer
-- is a new resolution and awaits its own verdict.
CREATE TABLE IF NOT EXISTS request_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  resolution_id INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('confirm', 'reject')),
  note TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  after_op_id INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES review_requests(id),
  FOREIGN KEY (resolution_id) REFERENCES request_resolutions(id)
);

-- A named person's sign-off on a task. A row needs a non-empty signature; today the only one written is 'soft' (the rail's Sign off, recorded by
-- recordSoftSubmission). No row is verified; every one reads as unverified.
-- rounds is how many rounds the task took; rejections_json is [{round, rejections}] per round;
-- files_json is [{path, sha256}] of every file in the task as it was on disk at sign-off;
-- left_out_json is [{path, reason}] of every file it didn't hash.
CREATE TABLE IF NOT EXISTS signoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  signer TEXT NOT NULL,
  ts TEXT NOT NULL,
  rounds INTEGER NOT NULL,
  rejections_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  left_out_json TEXT,
  closed_task INTEGER,
  signature TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- What a Stop's reconciliation found for a session. status is complete, lossy, not recorded or not checked.
-- names_json is {lost, failed, noEvent, unmatched}: the call or event ids behind each count (cut to a few dozen).
CREATE TABLE IF NOT EXISTS session_coverage (
  session_id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  events INTEGER NOT NULL,
  ops INTEGER NOT NULL,
  calls INTEGER,
  lost INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  no_event INTEGER NOT NULL,
  unmatched INTEGER NOT NULL,
  unattributed INTEGER NOT NULL,
  names_json TEXT NOT NULL
);

-- A person's verdict on one stop of the rail. Append-only: a change of mind, a reset or a new state is a new row and no row is ever
-- updated or deleted. stop_id is the rail stop; subject links the stops of one thing across states (a file path for a change stop);
-- fingerprint is the content the verdict was given on, so a verdict counts only while the stop still has that content.
-- Additive (IF NOT EXISTS), so it does not bump the schema version.
CREATE TABLE IF NOT EXISTS stop_verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  stop_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'not_reviewed')),
  note TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE TRIGGER IF NOT EXISTS stop_verdicts_no_update BEFORE UPDATE ON stop_verdicts BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS stop_verdicts_no_delete BEFORE DELETE ON stop_verdicts BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- One row per Send back the person pressed: the exact prompt text shown and the stop ids it covers. Append-only like the verdicts.
-- note is the optional overall note the person wrote with it ('' when none); the prompt carries it too.
CREATE TABLE IF NOT EXISTS send_backs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  stop_ids_json TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  ts TEXT NOT NULL,
  nonce TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE TRIGGER IF NOT EXISTS send_backs_no_update BEFORE UPDATE ON send_backs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS send_backs_no_delete BEFORE DELETE ON send_backs BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- Nonce is the 6-character [a-z0-9] tag the follow-up marker carries.
-- One row per Copy of a send-back: the exact text that went to the clipboard. Append-only, never updated or deleted.
CREATE TABLE IF NOT EXISTS send_back_copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  send_back_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (send_back_id) REFERENCES send_backs(id)
);
CREATE TRIGGER IF NOT EXISTS send_back_copies_no_update BEFORE UPDATE ON send_back_copies BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS send_back_copies_no_delete BEFORE DELETE ON send_back_copies BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- A task that opened with a send-back's follow-up line, linked to that send-back. At most one row per task. Append-only.
CREATE TABLE IF NOT EXISTS follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE,
  send_back_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (send_back_id) REFERENCES send_backs(id)
);
CREATE TRIGGER IF NOT EXISTS follows_no_update BEFORE UPDATE ON follows BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS follows_no_delete BEFORE DELETE ON follows BEGIN SELECT RAISE(ABORT, 'append-only'); END;

-- One row per soft submission from the rail: the sign-off it recorded and the not-reviewed stop ids the person acknowledged ('[]' when
-- every stop was reviewed). Append-only like the sign-off.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  signoff_id INTEGER NOT NULL,
  acknowledged_json TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  ts TEXT NOT NULL,
  -- The highest file_states.id the task had when this submission was taken, and the stops it covered with the file version each
  -- stood on (JSON). NULL when no mark was recorded; the submission time is used then.
  state_mark INTEGER,
  covered_json TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (signoff_id) REFERENCES signoffs(id)
);
CREATE TRIGGER IF NOT EXISTS submissions_no_update BEFORE UPDATE ON submissions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS submissions_no_delete BEFORE DELETE ON submissions BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS ops_guard_update
BEFORE UPDATE ON ops
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.ts IS OLD.ts AND NEW.tool IS OLD.tool AND NEW.client_name IS OLD.client_name AND NEW.client_version IS OLD.client_version AND NEW.duration_ms IS OLD.duration_ms AND NEW.result_code IS OLD.result_code
  AND (NEW.args_json IS OLD.args_json OR (NEW.args_json IS NULL OR NEW.args_json IN ('', '{}', '[]', 'null', 'values expired')))
  AND (NEW.intent IS OLD.intent OR (NEW.intent IS NULL OR NEW.intent IN ('', '{}', '[]', 'null', 'values expired')))
  AND (NEW.error_text IS OLD.error_text OR (NEW.error_text IS NULL OR NEW.error_text IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS review_rows_guard_update
BEFORE UPDATE ON review_rows
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.round_id IS OLD.round_id AND NEW.task_id IS OLD.task_id AND NEW.file_path IS OLD.file_path AND NEW.layer IS OLD.layer AND NEW.location IS OLD.location AND NEW.kind IS OLD.kind AND NEW.status IS OLD.status
  AND (NEW.before_json IS OLD.before_json OR (NEW.before_json IS NULL OR NEW.before_json IN ('', '{}', '[]', 'null', 'values expired')))
  AND (NEW.after_json IS OLD.after_json OR (NEW.after_json IS NULL OR NEW.after_json IN ('', '{}', '[]', 'null', 'values expired')))
  AND (NEW.detail_json IS OLD.detail_json OR (NEW.detail_json IS NULL OR NEW.detail_json IN ('', '{}', '[]', 'null', 'values expired')))
  AND (NEW.description IS OLD.description OR (NEW.description IS NULL OR NEW.description IN ('', '{}', '[]', 'null', 'values expired')))
  AND (NEW.ops_json IS OLD.ops_json OR (NEW.ops_json IS NULL OR NEW.ops_json IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS rounds_guard_update
BEFORE UPDATE ON rounds
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.seq IS OLD.seq AND NEW.ts IS OLD.ts AND NEW.client_name IS OLD.client_name AND NEW.final IS OLD.final AND NEW.last_op_id IS OLD.last_op_id
  AND (NEW.intent IS OLD.intent OR (NEW.intent IS NULL OR NEW.intent IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS review_decisions_guard_update
BEFORE UPDATE ON review_decisions
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = (SELECT task_id FROM review_rows WHERE id = OLD.row_id))
  AND NEW.id IS OLD.id AND NEW.row_id IS OLD.row_id AND NEW.decision IS OLD.decision AND NEW.reviewer IS OLD.reviewer AND NEW.after_op_id IS OLD.after_op_id AND NEW.ts IS OLD.ts
  AND (NEW.note IS OLD.note OR (NEW.note IS NULL OR NEW.note IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS item_resolutions_guard_update
BEFORE UPDATE ON item_resolutions
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = (SELECT task_id FROM review_rows WHERE id = OLD.row_id))
  AND NEW.id IS OLD.id AND NEW.row_id IS OLD.row_id AND NEW.resolution IS OLD.resolution AND NEW.client_name IS OLD.client_name AND NEW.decision_id IS OLD.decision_id AND NEW.op_ids_json IS OLD.op_ids_json AND NEW.ts IS OLD.ts
  AND (NEW.intent IS OLD.intent OR (NEW.intent IS NULL OR NEW.intent IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS review_requests_guard_update
BEFORE UPDATE ON review_requests
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.reviewer IS OLD.reviewer AND NEW.after_op_id IS OLD.after_op_id AND NEW.ts IS OLD.ts
  AND (NEW.note IS OLD.note OR (NEW.note IS NULL OR NEW.note IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS request_resolutions_guard_update
BEFORE UPDATE ON request_resolutions
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = (SELECT task_id FROM review_requests WHERE id = OLD.request_id))
  AND NEW.id IS OLD.id AND NEW.request_id IS OLD.request_id AND NEW.resolution IS OLD.resolution AND NEW.client_name IS OLD.client_name AND NEW.op_ids_json IS OLD.op_ids_json AND NEW.ts IS OLD.ts
  AND (NEW.intent IS OLD.intent OR (NEW.intent IS NULL OR NEW.intent IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS request_confirmations_guard_update
BEFORE UPDATE ON request_confirmations
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = (SELECT task_id FROM review_requests WHERE id = OLD.request_id))
  AND NEW.id IS OLD.id AND NEW.request_id IS OLD.request_id AND NEW.resolution_id IS OLD.resolution_id AND NEW.verdict IS OLD.verdict AND NEW.reviewer IS OLD.reviewer AND NEW.after_op_id IS OLD.after_op_id AND NEW.ts IS OLD.ts
  AND (NEW.note IS OLD.note OR (NEW.note IS NULL OR NEW.note IN ('', '{}', '[]', 'null', 'values expired')))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_guard_update
BEFORE UPDATE ON events
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = json_extract(OLD.payload_json, '$.taskId'))
  AND NEW.id IS OLD.id AND NEW.ts IS OLD.ts AND NEW.op_id IS OLD.op_id AND NEW.kind IS OLD.kind
  AND (NEW.payload_json IS OLD.payload_json OR NEW.payload_json = json_remove(OLD.payload_json, '$.intent', '$.note'))
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- A snapshot's hash may be filled in once (a row may have none), and nothing else about it may change.
CREATE TRIGGER IF NOT EXISTS task_snapshots_guard_update
BEFORE UPDATE ON task_snapshots
WHEN NOT (
  OLD.sha256 IS NULL AND NEW.sha256 IS NOT NULL
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.round IS OLD.round AND NEW.file_path IS OLD.file_path
  AND NEW.layer IS OLD.layer AND NEW.snapshot_path IS OLD.snapshot_path AND NEW.mode IS OLD.mode AND NEW.ts IS OLD.ts
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- values_expired is insert-only, and takes a task only once it closed (signed off or expired) over 30 days before the row's own ts.
-- "signed off" here means what closureOf means: a soft sign-off (signature 'soft') closes nothing, so it never counts. The guard
-- may only be stricter than the sweep, never looser; dropped first so a ledger whose guard was made with the looser body gets the stricter one.
DROP TRIGGER IF EXISTS values_expired_guard_insert;
CREATE TRIGGER values_expired_guard_insert
BEFORE INSERT ON values_expired
WHEN NOT (
  COALESCE((SELECT MIN(closed) FROM (SELECT ts AS closed FROM signoffs WHERE task_id = NEW.task_id AND signature IS NOT 'soft' UNION ALL SELECT ts FROM task_closures WHERE task_id = NEW.task_id)), '9999')
    < strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ts, '-30 days')
)
BEGIN
  SELECT RAISE(ABORT, 'append-only: values expire only 30 days after a task closed');
END;

CREATE TRIGGER IF NOT EXISTS values_expired_no_update
BEFORE UPDATE ON values_expired
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS values_expired_no_delete
BEFORE DELETE ON values_expired
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- Everything a task captured expires on one schedule, so the free text the person wrote (a stop's note, a send-back's prompt and
-- note, a copied send-back's text) is blanked with the rest. The four tables stay append-only except for exactly that: an UPDATE that
-- leaves every other column alone and sets those columns to '' for a task with a values_expired row. Every other UPDATE and every DELETE is refused.
DROP TRIGGER IF EXISTS stop_verdicts_no_update;
DROP TRIGGER IF EXISTS send_backs_no_update;
DROP TRIGGER IF EXISTS send_back_copies_no_update;
DROP TRIGGER IF EXISTS stop_verdicts_guard_update;
DROP TRIGGER IF EXISTS send_backs_guard_update;
DROP TRIGGER IF EXISTS send_back_copies_guard_update;

CREATE TRIGGER stop_verdicts_guard_update
BEFORE UPDATE ON stop_verdicts
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.stop_id IS OLD.stop_id AND NEW.subject IS OLD.subject AND NEW.fingerprint IS OLD.fingerprint
  AND NEW.status IS OLD.status AND NEW.reviewer IS OLD.reviewer AND NEW.ts IS OLD.ts
  AND (NEW.note IS OLD.note OR NEW.note = '')
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER send_backs_guard_update
BEFORE UPDATE ON send_backs
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.stop_ids_json IS OLD.stop_ids_json AND NEW.reviewer IS OLD.reviewer AND NEW.ts IS OLD.ts AND NEW.nonce IS OLD.nonce
  AND (NEW.prompt IS OLD.prompt OR NEW.prompt = '')
  AND (NEW.note IS OLD.note OR NEW.note = '')
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER send_back_copies_guard_update
BEFORE UPDATE ON send_back_copies
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = (SELECT task_id FROM send_backs WHERE id = OLD.send_back_id))
  AND NEW.id IS OLD.id AND NEW.send_back_id IS OLD.send_back_id AND NEW.ts IS OLD.ts
  AND (NEW.text IS OLD.text OR NEW.text = '')
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS steps_no_update BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS steps_no_delete BEFORE DELETE ON steps BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS file_states_no_update BEFORE UPDATE ON file_states BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS file_states_no_delete BEFORE DELETE ON file_states BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- A change stored as inference that its own call's Post later proved (host-reported-edit). file_states is append-only, so the proof is its own row.
CREATE TABLE IF NOT EXISTS file_state_proofs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_state_id INTEGER NOT NULL UNIQUE REFERENCES file_states(id),
  credit_basis TEXT NOT NULL CHECK (credit_basis = 'host-reported-edit'),
  ts TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS file_state_proofs_no_update BEFORE UPDATE ON file_state_proofs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS file_state_proofs_no_delete BEFORE DELETE ON file_state_proofs BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- The change list of a connector-claimed file row, read by the review process after the hook wrote the row. file_states is append-only, so the
-- capture is its own rows: 'pending' written with the row, then at most one 'captured' (version, spec and frozen-list hash of the connector that ran) or 'failed'.
-- A failure's reason is CoCheck's own wording (a category); detail is what the connector said (secret-scanned, it can quote the file), blanked by the 30-day expiry.
CREATE TABLE IF NOT EXISTS file_state_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_state_id INTEGER NOT NULL REFERENCES file_states(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'captured', 'failed')),
  connector_version TEXT,
  connector_spec TEXT,
  changes_sha256 TEXT,
  reason TEXT,
  detail TEXT,
  ts TEXT NOT NULL,
  UNIQUE (file_state_id, state)
);
CREATE INDEX IF NOT EXISTS file_state_captures_by_row ON file_state_captures(file_state_id);
CREATE TRIGGER IF NOT EXISTS file_state_captures_guard_update
BEFORE UPDATE ON file_state_captures
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = (SELECT task_id FROM file_states WHERE id = OLD.file_state_id))
  AND NEW.id IS OLD.id AND NEW.file_state_id IS OLD.file_state_id AND NEW.state IS OLD.state AND NEW.connector_version IS OLD.connector_version
  AND NEW.connector_spec IS OLD.connector_spec AND NEW.changes_sha256 IS OLD.changes_sha256 AND NEW.reason IS OLD.reason AND NEW.ts IS OLD.ts
  AND (NEW.detail IS OLD.detail OR NEW.detail = '')
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
CREATE TRIGGER IF NOT EXISTS file_state_captures_no_delete BEFORE DELETE ON file_state_captures BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- Each answer that said "not ready, ask again" (cocheck.changes/1 pendingRetry) while the row's capture is still pending: the hash of that answer,
-- sealed in the task's change store like a frozen list. The count of these rows is the row's asks so far (the cap is in file-capture.ts). Append-only.
CREATE TABLE IF NOT EXISTS file_state_capture_tries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_state_id INTEGER NOT NULL REFERENCES file_states(id),
  changes_sha256 TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_state_capture_tries_by_row ON file_state_capture_tries(file_state_id);
CREATE TRIGGER IF NOT EXISTS file_state_capture_tries_no_update BEFORE UPDATE ON file_state_capture_tries BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS file_state_capture_tries_no_delete BEFORE DELETE ON file_state_capture_tries BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS state_removals_no_update BEFORE UPDATE ON state_removals BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS state_removals_no_delete BEFORE DELETE ON state_removals BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TRIGGER IF NOT EXISTS tasks_no_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS tasks_no_delete
BEFORE DELETE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS ops_no_delete
BEFORE DELETE ON ops
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS task_snapshots_no_delete
BEFORE DELETE ON task_snapshots
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS rounds_no_delete
BEFORE DELETE ON rounds
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS review_rows_no_delete
BEFORE DELETE ON review_rows
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS review_decisions_no_delete
BEFORE DELETE ON review_decisions
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS item_resolutions_no_delete
BEFORE DELETE ON item_resolutions
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS review_requests_no_delete
BEFORE DELETE ON review_requests
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS request_resolutions_no_delete
BEFORE DELETE ON request_resolutions
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS request_confirmations_no_delete
BEFORE DELETE ON request_confirmations
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS signoffs_need_signature
BEFORE INSERT ON signoffs
WHEN NEW.signature IS NULL OR length(trim(NEW.signature)) = 0
BEGIN
  SELECT RAISE(ABORT, 'sign-off needs a signature');
END;

CREATE TRIGGER IF NOT EXISTS signoffs_no_update
BEFORE UPDATE ON signoffs
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

CREATE TRIGGER IF NOT EXISTS signoffs_no_delete
BEFORE DELETE ON signoffs
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;

-- A spot on a diff the person pointed at, recorded when they drew it. kind is picture, cells or lines; sha is the state the
-- region was cut from (the change's own before or after state); picture is 1 when a PNG was written under the task's regions folder.
-- where_text and rect_json hold what the person pointed at, so they are values: the five-week expiry sets both to 'values expired'.
-- Append-only except for exactly that.
CREATE TABLE IF NOT EXISTS note_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  change_key TEXT NOT NULL,
  side TEXT NOT NULL,
  kind TEXT NOT NULL,
  sha TEXT NOT NULL,
  page INTEGER,
  rect_json TEXT NOT NULL,
  where_text TEXT NOT NULL,
  picture INTEGER NOT NULL,
  ts TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
-- One link per region: the verdict (a failed step's note) or the send-back (the overall note) it went with. Exactly one of the two is set. Append-only.
CREATE TABLE IF NOT EXISTS region_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id INTEGER NOT NULL UNIQUE,
  verdict_id INTEGER,
  send_back_id INTEGER,
  ts TEXT NOT NULL,
  CHECK ((verdict_id IS NULL) <> (send_back_id IS NULL)),
  FOREIGN KEY (region_id) REFERENCES note_regions(id),
  FOREIGN KEY (verdict_id) REFERENCES stop_verdicts(id),
  FOREIGN KEY (send_back_id) REFERENCES send_backs(id)
);
CREATE TRIGGER IF NOT EXISTS note_regions_no_delete BEFORE DELETE ON note_regions BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS region_links_no_update BEFORE UPDATE ON region_links BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS region_links_no_delete BEFORE DELETE ON region_links BEGIN SELECT RAISE(ABORT, 'append-only'); END;
-- The person's sticky notes, one row per save. note_id is the id of the note's first row; the live note is the latest row per note_id.
-- deleted = 1 retires a note; sent_back_id is set on the row a send-back writes for each note it carries (the note then leaves the live list).
-- A note's region is linked to the send-back through region_links at send-back; region_links itself is unchanged. Append-only; expiry may only blank text.
-- stop_id is the rail stop on show when the note was made (the page goes back to it); NULL when none was on show.
CREATE TABLE IF NOT EXISTS review_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  note_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  region_id INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  sent_back_id INTEGER,
  ts TEXT NOT NULL,
  stop_id TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (region_id) REFERENCES note_regions(id),
  FOREIGN KEY (sent_back_id) REFERENCES send_backs(id)
);
CREATE INDEX IF NOT EXISTS review_notes_task ON review_notes(task_id, note_id);
CREATE TRIGGER IF NOT EXISTS review_notes_no_delete BEFORE DELETE ON review_notes BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS review_notes_guard_update
BEFORE UPDATE ON review_notes
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.note_id IS OLD.note_id AND NEW.region_id IS OLD.region_id
  AND NEW.deleted IS OLD.deleted AND NEW.sent_back_id IS OLD.sent_back_id AND NEW.ts IS OLD.ts AND NEW.stop_id IS OLD.stop_id
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
DROP TRIGGER IF EXISTS note_regions_guard_update;
CREATE TRIGGER note_regions_guard_update
BEFORE UPDATE ON note_regions
WHEN NOT (
  EXISTS (SELECT 1 FROM values_expired WHERE task_id = OLD.task_id)
  AND NEW.id IS OLD.id AND NEW.task_id IS OLD.task_id AND NEW.change_key IS OLD.change_key AND NEW.side IS OLD.side AND NEW.kind IS OLD.kind
  AND NEW.sha IS OLD.sha AND NEW.page IS OLD.page AND NEW.picture IS OLD.picture AND NEW.ts IS OLD.ts
  AND (NEW.rect_json IS OLD.rect_json OR NEW.rect_json = 'values expired')
  AND (NEW.where_text IS OLD.where_text OR NEW.where_text = 'values expired')
)
BEGIN
  SELECT RAISE(ABORT, 'append-only');
END;
`;

/**
 * Returns the ledger's home directory: `$COCHECK_HOME`, or `~/.cocheck` if unset. Under the node test
 * runner (`NODE_TEST_CONTEXT` is set in every test process) the default is refused: a test that
 * reaches it would read and write the real data directory, so it throws instead.
 */
export function resolveCoCheckHome(): string {
  if (process.env.COCHECK_HOME && process.env.COCHECK_HOME.length > 0) {
    return process.env.COCHECK_HOME;
  }
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error("COCHECK_HOME is unset under the test runner; refusing to fall back to the real ~/.cocheck");
  }
  return path.join(homedir(), ".cocheck");
}

/** Max size, in UTF-8 bytes, of `args_json` stored for any `ops` row. */
const MAX_ARGS_JSON_BYTES = 64 * 1024;

/** Size, in UTF-8 bytes, of the `preview` field inside a truncated-args stand-in. */
const ARGS_PREVIEW_BYTES = 1024;

/**
 * Caps `args_json` at `MAX_ARGS_JSON_BYTES`. A write tool's arguments are caller-supplied and
 * unbounded in size (e.g. a multi-megabyte `text`) - this applies to every `ops` row, not just
 * refusals, since a large-enough successful call's args would otherwise land in the ledger
 * whole too. When the serialized args exceed the cap, the stored `args_json` is replaced with a
 * small JSON-valid stand-in carrying the original byte length, a sha256 of the full serialized
 * args (so a reviewer holding the original bytes elsewhere can confirm they match), and a short
 * preview - never the full args.
 */
/** A value with every string in it (keys excluded) passed through the secret mask; the same object when nothing changed. */
function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out = v.map((x) => redactDeep(x, depth + 1));
    return out.some((x, i) => x !== v[i]) ? out : v;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  const out = entries.map(([k, x]) => [k, redactDeep(x, depth + 1)] as const);
  return out.some(([, x], i) => x !== entries[i]![1]) ? Object.fromEntries(out) : v;
}

/**
 * An op's args with every string masked, except the person's own typed prompts (`prompts` of a UserPromptSubmit op): their prompt text is
 * stored and shown as typed, which is a decision about prompts, not about what a tool call carries.
 */
function redactArgs(args: unknown): unknown {
  const a = args as Record<string, unknown> | null;
  if (a !== null && typeof a === "object" && !Array.isArray(a) && a.hookEvent === "UserPromptSubmit" && "prompts" in a) {
    // Keys keep their order (the stored text is compared byte for byte by the hook goldens).
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, k === "prompts" ? v : redactDeep(v)]));
  }
  return redactDeep(args);
}

/**
 * The args text of a stored row with every string masked (old rows written before masking at the ledger hold raw values; new rows come back unchanged).
 * The one place a reader of `args_json` goes through. The same string when nothing is found, so unchanged rows keep their bytes. Answers are
 * remembered per text (a timeline reload reads every row again).
 */
const maskedArgs = new Map<string, string>();
export function maskArgsJson(argsJson: string): string {
  const hit = maskedArgs.get(argsJson);
  if (hit !== undefined) return hit;
  let out = argsJson;
  try {
    const parsed: unknown = JSON.parse(argsJson);
    const masked = redactArgs(parsed);
    if (masked !== parsed) out = JSON.stringify(masked);
  } catch {
    // Text that is not JSON is not an args object; mask it as a string so nothing raw passes.
    out = redactSecrets(argsJson);
  }
  if (maskedArgs.size >= 4000) maskedArgs.clear();
  maskedArgs.set(argsJson, out);
  return out;
}

/** Longest head of any one string that can reach a truncated row's preview (the preview is the first ARGS_PREVIEW_BYTES bytes of the text). */
const PREVIEW_WINDOW_CHARS = 4 * ARGS_PREVIEW_BYTES;
function clipStrings(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > PREVIEW_WINDOW_CHARS ? v.slice(0, PREVIEW_WINDOW_CHARS) : v;
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => clipStrings(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clipStrings(x, depth + 1)]));
}

/**
 * What a row stores for its args: every string masked. Args too big to be stored (only the stand-in is kept) are not scanned whole: the
 * stand-in holds just the first bytes of the text, so only the head of each string is masked and previewed, and the hash is of the original
 * text (a reviewer holding those bytes can confirm it). Nothing past the head is stored or shown.
 */
function storedArgsJson(args: unknown): string {
  const serialized = JSON.stringify(args ?? {});
  if (Buffer.byteLength(serialized, "utf8") <= MAX_ARGS_JSON_BYTES) return capArgsJson(redactArgs(args));
  return capArgsJson(redactArgs(clipStrings(args)), serialized);
}

function capArgsJson(args: unknown, whole?: string): string {
  const shown = JSON.stringify(args ?? {});
  const serialized = whole ?? shown;
  if (whole === undefined && Buffer.byteLength(serialized, "utf8") <= MAX_ARGS_JSON_BYTES) {
    return serialized;
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  // Slicing a Buffer can land mid-codepoint; toString("utf8") replaces the partial trailing
  // sequence with U+FFFD, which is fine for a preview.
  const preview = Buffer.from(shown, "utf8").subarray(0, ARGS_PREVIEW_BYTES).toString("utf8");
  return JSON.stringify({ _truncated: true, bytes, sha256, preview });
}

/**
 * Max length, in Unicode codepoints, stored for `ops.client_name` and `ops.client_version`.
 * Both come from the MCP `clientInfo` an *unauthenticated* client sends at `initialize` - any
 * host or tool can claim any string here, so both need the same fixed-size treatment as
 * `args_json` above.
 */
export const MAX_CLIENT_NAME_CHARS = 256;
export const MAX_CLIENT_VERSION_CHARS = 256;

/**
 * Max size, in UTF-8 bytes, stored for `ops.error_text`. A thrown error's `message` is not
 * bounded by anything upstream - it can come from a tool executor that embeds arbitrary
 * caller-supplied text in the exception it throws.
 */
export const MAX_ERROR_TEXT_BYTES = 4 * 1024;

/** Builds the visible "this was cut" marker embedded in a truncated column value. */
function truncationMarker(originalLength: number): string {
  return `…[truncated, ${originalLength} chars]`;
}

/**
 * Truncates `value` to at most `maxChars` Unicode codepoints, total, including a visible
 * marker naming the original codepoint count. Splitting on `Array.from` (which iterates by
 * codepoint) rather than raw indexing/`.slice` means a surrogate pair is always kept or dropped
 * as a whole unit, never split into a lone surrogate.
 */
export function truncateChars(value: string, maxChars: number): string {
  const codepoints = Array.from(value);
  if (codepoints.length <= maxChars) {
    return value;
  }
  const marker = truncationMarker(codepoints.length);
  const markerChars = Array.from(marker).length;
  const keepChars = Math.max(0, maxChars - markerChars);
  return codepoints.slice(0, keepChars).join("") + marker;
}

/**
 * Truncates `value` to at most `maxBytes` UTF-8 bytes, total, including a visible marker naming
 * the original codepoint count. Slicing the UTF-8-encoded Buffer can land mid-codepoint; decoding
 * the truncated slice with `toString("utf8")` replaces any partial trailing byte sequence with a
 * single U+FFFD (the same technique `capArgsJson`'s preview above uses) - but re-encoding that
 * replacement character can cost *more* bytes than the partial sequence it replaced (e.g. a
 * 1-byte-in partial 3-byte codepoint becomes a 3-byte U+FFFD), which could push the result back
 * over `maxBytes`. The loop below shrinks the byte slice one byte at a time until the decoded,
 * re-encoded result actually fits - bounded to a handful of iterations, since a UTF-8 sequence is
 * at most 4 bytes so the overshoot from one bad trailing sequence is always small.
 */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const originalLength = Array.from(value).length;
  const marker = truncationMarker(originalLength);
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const keepBudget = Math.max(0, maxBytes - markerBytes);
  const fullBuffer = Buffer.from(value, "utf8");
  let sliceBytes = Math.min(keepBudget, fullBuffer.byteLength);
  let kept = fullBuffer.subarray(0, sliceBytes).toString("utf8");
  while (Buffer.byteLength(kept, "utf8") > keepBudget && sliceBytes > 0) {
    sliceBytes -= 1;
    kept = fullBuffer.subarray(0, sliceBytes).toString("utf8");
  }
  return kept + marker;
}

/** The `result_code` of a hook-recorded call the host reported as failed. Never written by a tool call of CoCheck's own server. */
export const TOOL_FAILED = "TOOL_FAILED";
/** The `result_code` of a hook-recorded call that never ran: the host refused it, or it had a Pre and no Post by the agent's Stop. */
export const TOOL_NOT_RUN = "TOOL_NOT_RUN";

interface RecordOpInput {
  taskId?: number | null;
  tool: string;
  args: unknown;
  intent: string;
  clientName?: string | null;
  clientVersion?: string | null;
  durationMs: number;
  resultCode: string;
  errorText?: string | null;
}

export interface SnapshotRow {
  id: number;
  taskId: number;
  round: number;
  filePath: string;
  layer: string;
  snapshotPath: string;
  mode: string;
  /** SHA-256 of the file as snapshotted; null on a missing file. */
  sha256: string | null;
  /** The file copy at `snapshotPath` was deleted; the hash above is all that is left of it. */
  removed: boolean;
}

interface RoundRow {
  id: number;
  taskId: number;
  seq: number;
  final: boolean;
  lastOpId: number;
  /** When the round was recorded (ISO 8601). */
  ts: string;
  /** The agent's stated intent for the submit. */
  intent: string;
}

interface TaskOpRow {
  id: number;
  tool: string;
  argsJson: string;
  intent: string;
  clientName: string | null;
}

export interface RecordSnapshotInput {
  taskId: number;
  round: number;
  filePath: string;
  layer: string;
  snapshotPath: string;
  mode: string;
  sha256?: string | null;
}

export interface RecordReviewRowInput {
  filePath: string;
  layer: string;
  location: string;
  kind: string;
  status: "explained" | "derived" | "unlogged";
  before: unknown;
  after: unknown;
  ops: unknown[];
  description: string;
  detail: unknown;
}

export interface ReviewRowRecord {
  id: number;
  roundId: number;
  roundSeq: number;
  taskId: number;
  filePath: string;
  layer: string;
  location: string;
  kind: string;
  status: RecordReviewRowInput["status"];
  before: unknown;
  after: unknown;
  /** The logged ops that explain the row (`ops_json`): `{opId, tool, intent, client}` each. */
  ops: Array<{ opId: number; tool: string; intent: string; client: string | null; callId?: string; closedBy?: string; description?: string; outsideFolder?: boolean }>;
  description: string;
  detail: Record<string, unknown>;
  /** `rounds.last_op_id` of the round that produced this row. */
  roundLastOpId: number;
}

export interface DecisionRow {
  id: number;
  rowId: number;
  decision: "approve" | "reject";
  note: string;
  reviewer: string;
  afterOpId: number;
  ts: string;
}

export interface ResolutionRow {
  id: number;
  rowId: number;
  resolution: "fixed" | "accepted";
  intent: string;
  clientName: string | null;
  decisionId: number | null;
  opIds: number[];
  ts: string;
}

export interface RequestRow {
  id: number;
  taskId: number;
  note: string;
  reviewer: string;
  afterOpId: number;
  ts: string;
}

export interface RequestResolutionRow {
  id: number;
  requestId: number;
  resolution: "fixed" | "accepted";
  intent: string;
  clientName: string | null;
  opIds: number[];
  ts: string;
}

export interface RequestConfirmationRow {
  id: number;
  requestId: number;
  resolutionId: number;
  verdict: "confirm" | "reject";
  note: string;
  reviewer: string;
  afterOpId: number;
  ts: string;
}

interface RecordResolutionRequestInput {
  requestId: number;
  resolution: RequestResolutionRow["resolution"];
  intent: string;
  clientName: string | null;
  opIds: number[];
}

interface RecordDecisionInput {
  rowId: number;
  decision: DecisionRow["decision"];
  note: string;
  reviewer: string;
}

interface RecordResolutionInput {
  rowId: number;
  resolution: ResolutionRow["resolution"];
  intent: string;
  clientName: string | null;
  decisionId: number | null;
  opIds: number[];
}

interface RecordRoundInput {
  taskId: number;
  seq: number;
  intent: string;
  clientName: string | null;
  final: boolean;
  lastOpId: number;
  snapshots: RecordSnapshotInput[];
  rows: RecordReviewRowInput[];
  /**
   * Plain-language notes about what the round couldn't see (e.g. a folder too big to watch),
   * stored as `round_note` events so the review page can show them.
   */
  notes?: string[];
  /**
   * Who cut the round when it wasn't the agent's submit: `reviewer` for a round the
   * review process cut on a page open. Stored as a `round_actor` event (no schema change).
   */
  actor?: "reviewer";
}

/** One file as signed off: its path and the SHA-256 of its bytes on disk at sign-off. */
export interface SignedFile {
  path: string;
  sha256: string;
}

export type CoverageStatus = "complete" | "lossy" | "not recorded" | "not checked";

export interface SessionCoverageRow {
  sessionId: string;
  host: string;
  checkedAt: string;
  status: CoverageStatus;
  /** One plain sentence on why the status is not "complete" (empty when it is). */
  reason: string;
  /** Distinct hook events the journal received for the session. */
  events: number;
  /** Ops the ledger holds for the session. */
  ops: number;
  /** Tool calls in the host transcript and subagent files; null when they were not read. */
  calls: number | null;
  lost: number;
  failed: number;
  /** Transcript calls the host sent no hook event for. */
  noEvent: number;
  /** Ops whose call is not in the transcript (context only). */
  unmatched: number;
  /** Journal events and failure markers with no usable session id (all sessions share them). */
  unattributed: number;
  /** Calls whose last op says expiry closed them (no Post, or none yet): their outcome is unknown. Kept in names_json, so no column. */
  expired: number;
  names: { lost: string[]; failed: string[]; noEvent: string[]; unmatched: string[]; expired: string[] };
}

/** names_json also holds `expired` (names) and `expiredCount`; a row written before them reads as none. */
function expiredOf(j: Record<string, any>): Pick<SessionCoverageRow, "names" | "expired"> {
  const { expiredCount, ...names } = j;
  return { names: { ...names, expired: Array.isArray(names.expired) ? names.expired : [] } as SessionCoverageRow["names"], expired: typeof expiredCount === "number" ? expiredCount : 0 };
}

function coverageRowOf(r: Record<string, any>): SessionCoverageRow {
  return {
    sessionId: r.session_id, host: r.host, checkedAt: r.checked_at, status: r.status, reason: r.reason, events: r.events, ops: r.ops, calls: r.calls,
    lost: r.lost, failed: r.failed, noEvent: r.no_event, unmatched: r.unmatched, unattributed: r.unattributed, ...expiredOf(JSON.parse(r.names_json)),
  };
}

export interface SignoffRow {
  id: number;
  taskId: number;
  signer: string;
  /** When the task was signed off (ISO 8601). */
  ts: string;
  /** How many rounds the task took. */
  rounds: number;
  /** Reviewer rejections per round, every round listed. */
  rejections: Array<{ round: number; rejections: number }>;
  files: SignedFile[];
  /** Every file of the task the sign-off didn't hash, with why. */
  leftOut: LeftOutFile[] | null;
  /**
   * True when the task's latest round wasn't final and this sign-off closed it: the round counts
   * as final because of this record (append-only, so the round row itself is never rewritten).
   */
  closedTask: boolean;
  /** The signature kind ('soft' for the rail's Submit); every row is shown as unverified. */
  signature: string | null;
}

/** A file a sign-off didn't hash, and why, in plain words. */
export interface LeftOutFile {
  path: string;
  reason: string;
  /**
   * Set on the one summary entry that follows the listed ones when more than the cap were left out:
   * how many files it stands for. Kept inside `left_out_json`, so no schema change; a record
   * without it lists every file itself.
   */
  count?: number;
  /** On a summary entry: the folders holding the unlisted files, so verify can match one by its folder. */
  folders?: string[];
  /** A file deleted in review: it is not hashed and not counted as left out. */
  deleted?: true;
}

export type RecordSignoffInput = Omit<SignoffRow, "id" | "ts" | "leftOut" | "signature"> & { leftOut: LeftOutFile[] };

/** At most this many regions go with one note. */
export const MAX_NOTE_REGIONS = 4;
/** At most this many regions a task holds, linked or not: it bounds the pictures on disk. */
export const MAX_TASK_REGIONS = 50;

/** One live sticky note: `id` is its note_id, `rowId` its latest row. */
interface NoteRow {
  id: number;
  rowId: number;
  taskId: number;
  text: string;
  regionId: number | null;
  /** The rail stop on show when the note was made; null when none was on show. */
  stopId: string | null;
  ts: string;
}

/** One region the person pointed at. `rect` is [x, y, w, h] in fractions of the picture for a picture, else the cell or line span. */
export interface RegionRow {
  id: number;
  taskId: number;
  changeKey: string;
  side: "before" | "after";
  kind: "picture" | "cells" | "lines";
  sha: string;
  page: number | null;
  rect: unknown;
  where: string;
  picture: boolean;
  ts: string;
  linked: boolean;
  verdictId?: number;
  sendBackId?: number;
  /** The step the linked verdict was recorded for. */
  stopId?: string;
}

function regionRowOf(r: Record<string, unknown>): RegionRow {
  let rect: unknown = null;
  try {
    rect = JSON.parse(String(r.rect_json));
  } catch {
    // an expired row holds the words "values expired"
  }
  const out: RegionRow = {
    id: Number(r.id), taskId: Number(r.task_id), changeKey: String(r.change_key), side: r.side as RegionRow["side"], kind: r.kind as RegionRow["kind"], sha: String(r.sha),
    page: r.page === null ? null : Number(r.page), rect, where: String(r.where_text), picture: Number(r.picture) === 1, ts: String(r.ts), linked: r.vid != null || r.sbid != null,
  };
  if (r.vid != null) out.verdictId = Number(r.vid);
  if (r.sbid != null) out.sendBackId = Number(r.sbid);
  if (r.stop != null) out.stopId = String(r.stop);
  return out;
}

export interface StopVerdictRow {
  id: number;
  taskId: number;
  stopId: string;
  subject: string;
  fingerprint: string;
  status: "passed" | "failed" | "not_reviewed";
  note: string;
  reviewer: string;
  ts: string;
}

export interface SubmissionRow {
  id: number;
  taskId: number;
  signoffId: number;
  acknowledged: string[];
  reviewer: string;
  ts: string;
  /** The highest file state id the task had at this submission; null when none was recorded. */
  stateMark: number | null;
  /** The stops this submission covered, each with its status then and the file version (sha256) it stood on. */
  covered: Array<{ stop: string; status: string; sha256: string | null }> | null;
}

/** A fix task's link to the send-back it came from. */
interface FollowRow {
  id: number;
  /** The fix task. */
  taskId: number;
  sendBackId: number;
  ts: string;
  /** The task the send-back was made on. */
  fromTask: number;
  /** When the send-back was made. */
  sentAt: string;
}

export interface SendBackRow {
  id: number;
  taskId: number;
  prompt: string;
  stopIds: string[];
  reviewer: string;
  /** The overall note, trimmed; '' when the person wrote none. */
  note: string;
  ts: string;
  /** The follow-up marker's 6-character tag. */
  nonce: string | null;
}

/** One Copy of a send-back: the exact text put on the clipboard. */
interface SendBackCopyRow {
  id: number;
  sendBackId: number;
  text: string;
  ts: string;
}

/** A `round_note` event: one note recorded with round `round` of a task. */
interface RoundNote {
  round: number;
  note: string;
}

export class Ledger {
  #db: DatabaseSync;
  /** The directory this ledger lives in, when opened via `openLedger`. */
  readonly home: string | undefined;

  constructor(db: DatabaseSync, home?: string) {
    this.#db = db;
    this.home = home;
  }

  /** Opens a new task for `client`. Returns its id. */
  openTask(client: string | null, at: Date = new Date()): number {
    const result = this.#db
      .prepare("INSERT INTO tasks (created_at, client) VALUES (?, ?)")
      .run(at.toISOString(), client != null ? truncateChars(client, MAX_CLIENT_NAME_CHARS) : null);
    return Number(result.lastInsertRowid);
  }

  /** When `taskId` was opened (ISO), or undefined for an unknown task. */
  taskCreatedAt(taskId: number): string | undefined {
    const row = this.#db.prepare("SELECT created_at FROM tasks WHERE id = ?").get(taskId) as { created_at: string } | undefined;
    return row === undefined ? undefined : String(row.created_at);
  }

  /**
   * The last agent activity on `taskId` at or before `until` (ISO), or when the task opened if none:
   * `lastActivity` restricted to the agent. The 4-hour rollover reads this; expiry reads the unrestricted form.
   */
  lastActivityTs(taskId: number, until: string): string | undefined {
    return this.lastActivity(taskId, { until, agentOnly: true });
  }

  /** Notes agent or reviewer activity on `taskId` at `at`; the later time wins. */
  recordActivity(taskId: number, actor: "agent" | "reviewer", at: Date): void {
    this.#db
      .prepare(
        `INSERT INTO task_activity (task_id, actor, ts) VALUES (?, ?, ?)
         ON CONFLICT (task_id, actor) DO UPDATE SET ts = MAX(ts, excluded.ts)`,
      )
      .run(taskId, actor, at.toISOString());
  }


  recordSnapshot(input: RecordSnapshotInput): number {
    const result = this.#db
      .prepare(
        `INSERT INTO task_snapshots (task_id, round, file_path, layer, snapshot_path, mode, ts, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.taskId, input.round, input.filePath, input.layer, input.snapshotPath, input.mode, new Date().toISOString(), input.sha256 ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Every snapshot of every file in `taskId`, oldest first. */
  snapshotsForTask(taskId: number): SnapshotRow[] {
    const rows = this.#db
      .prepare(
        `SELECT s.id, s.task_id, s.round, s.file_path, s.layer, s.snapshot_path, s.mode, s.sha256,
                (SELECT 1 FROM snapshot_removals x WHERE x.snapshot_id = s.id) AS removed
         FROM task_snapshots s WHERE s.task_id = ? ORDER BY s.id`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: Number(r.task_id),
      round: Number(r.round),
      filePath: String(r.file_path),
      layer: String(r.layer),
      snapshotPath: String(r.snapshot_path),
      mode: String(r.mode),
      sha256: r.sha256 == null ? null : String(r.sha256),
      removed: r.removed != null,
    }));
  }

  /** Records that these snapshots' file copies were deleted. */
  markCopiesRemoved(snapshotIds: number[], at: Date = new Date()): void {
    const stmt = this.#db.prepare("INSERT OR IGNORE INTO snapshot_removals (snapshot_id, ts) VALUES (?, ?)");
    for (const id of snapshotIds) stmt.run(id, at.toISOString());
  }

  /** How `taskId` was closed without a sign-off, if it was. */
  closureForTask(taskId: number): { kind: "expired"; ts: string } | undefined {
    const r = this.#db.prepare("SELECT kind, ts FROM task_closures WHERE task_id = ?").get(taskId) as { kind: "expired"; ts: string } | undefined;
    return r === undefined ? undefined : { kind: r.kind, ts: String(r.ts) };
  }

  /** Closes `taskId` as expired. A task closed already stays as it was. */
  recordExpiry(taskId: number, at: Date): void {
    this.#db.prepare("INSERT OR IGNORE INTO task_closures (task_id, kind, ts) VALUES (?, 'expired', ?)").run(taskId, at.toISOString());
  }

  /**
   * The one definition of activity on `taskId` (ISO), at or before `opts.until`: an agent tool call
   * (a logged op, or a touch or submit noted by `recordActivity`) or, unless `agentOnly`, a reviewer
   * action (a noted page open or round cut, a decision, a request or a verdict). The task's opening
   * time when there is none.
   */
  lastActivity(taskId: number, opts: { until?: string; agentOnly?: boolean } = {}): string | undefined {
    const until = opts.until ?? "9999";
    const agent = `SELECT ts FROM ops WHERE task_id = ?1 AND ts <= ?2
         UNION ALL SELECT ts FROM task_activity WHERE task_id = ?1 AND actor = 'agent' AND ts <= ?2`;
    const reviewer = `UNION ALL SELECT ts FROM task_activity WHERE task_id = ?1 AND actor = 'reviewer' AND ts <= ?2
         UNION ALL SELECT d.ts FROM review_decisions d JOIN review_rows r ON r.id = d.row_id WHERE r.task_id = ?1 AND d.ts <= ?2
         UNION ALL SELECT ts FROM review_requests WHERE task_id = ?1 AND ts <= ?2
         UNION ALL SELECT c.ts FROM request_confirmations c JOIN review_requests q ON q.id = c.request_id WHERE q.task_id = ?1 AND c.ts <= ?2`;
    const row = this.#db.prepare(`SELECT MAX(ts) AS ts FROM (${agent} ${opts.agentOnly ? "" : reviewer})`).get(taskId, until) as { ts: string | null };
    return row.ts ?? this.taskCreatedAt(taskId);
  }

  /**
   * When a task that was signed off at `since` and rejected after that was last worked on: the
   * latest reviewer decision or confirmation, agent resolution, logged op or agent touch or submit
   * after `since`. Page opens and reads don't count. Undefined when nothing was rejected after
   * `since` (the task was never reopened).
   */
  reopenedWorkSince(taskId: number, since: string): string | undefined {
    const rejected = this.#db
      .prepare(
        `SELECT 1 FROM review_decisions d JOIN review_rows r ON r.id = d.row_id WHERE r.task_id = ?1 AND d.decision = 'reject' AND d.ts > ?2
         UNION ALL SELECT 1 FROM request_confirmations c JOIN review_requests q ON q.id = c.request_id WHERE q.task_id = ?1 AND c.verdict = 'reject' AND c.ts > ?2`,
      )
      .get(taskId, since);
    if (rejected === undefined) return undefined;
    const row = this.#db
      .prepare(
        `SELECT MAX(ts) AS ts FROM (
           SELECT d.ts FROM review_decisions d JOIN review_rows r ON r.id = d.row_id WHERE r.task_id = ?1
           UNION ALL SELECT c.ts FROM request_confirmations c JOIN review_requests q ON q.id = c.request_id WHERE q.task_id = ?1
           UNION ALL SELECT s.ts FROM item_resolutions s JOIN review_rows r ON r.id = s.row_id WHERE r.task_id = ?1
           UNION ALL SELECT ts FROM ops WHERE task_id = ?1
           UNION ALL SELECT ts FROM task_activity WHERE task_id = ?1 AND actor = 'agent'
         ) WHERE ts > ?2`,
      )
      .get(taskId, since) as { ts: string | null };
    return row.ts ?? undefined;
  }

  /** Whether `taskId`'s values were expired. */
  valuesExpiredAt(taskId: number): string | undefined {
    const r = this.#db.prepare("SELECT ts FROM values_expired WHERE task_id = ?").get(taskId) as { ts: string } | undefined;
    return r === undefined ? undefined : String(r.ts);
  }

  /**
   * Blanks every value of `taskId`: its review rows' before, after, detail, description and ops, its ops'
   * arguments, intents and error text, its rounds' intents, every reviewer note and agent answer, the
   * round summaries and notes in `events`, and its stored round results. The send-back prompts, notes and
   * copied texts, the stop verdicts' notes, and what each pointed-at region says and where it was. Ids, locations, kinds, statuses, nonces, hashes and times stay. Refused (by trigger) unless the task closed over 30 days before `at`.
   */
  expireValues(taskId: number, at: Date): void {
    this.immediate(() => {
      const run = (sql: string) => this.#db.prepare(sql).run(taskId);
      this.#db.prepare("INSERT INTO values_expired (task_id, ts) VALUES (?, ?)").run(taskId, at.toISOString());
      run("UPDATE review_rows SET before_json = 'null', after_json = 'null', detail_json = '{}', description = 'values expired', ops_json = '[]' WHERE task_id = ?");
      run("UPDATE ops SET args_json = '{}', intent = '', error_text = NULL WHERE task_id = ?");
      run("UPDATE rounds SET intent = '' WHERE task_id = ?");
      run("UPDATE review_decisions SET note = '' WHERE row_id IN (SELECT id FROM review_rows WHERE task_id = ?)");
      run("UPDATE item_resolutions SET intent = '' WHERE row_id IN (SELECT id FROM review_rows WHERE task_id = ?)");
      run("UPDATE review_requests SET note = '' WHERE task_id = ?");
      run("UPDATE request_resolutions SET intent = '' WHERE request_id IN (SELECT id FROM review_requests WHERE task_id = ?)");
      run("UPDATE request_confirmations SET note = '' WHERE request_id IN (SELECT id FROM review_requests WHERE task_id = ?)");
      run("UPDATE events SET payload_json = json_remove(payload_json, '$.intent', '$.note') WHERE json_extract(payload_json, '$.taskId') = ?");
      run("UPDATE stop_verdicts SET note = '' WHERE task_id = ?");
      run("UPDATE send_backs SET prompt = '', note = '' WHERE task_id = ?");
      run("UPDATE send_back_copies SET text = '' WHERE send_back_id IN (SELECT id FROM send_backs WHERE task_id = ?)");
      run("UPDATE review_notes SET text = '' WHERE task_id = ?");
      run("UPDATE file_state_captures SET detail = '' WHERE detail IS NOT NULL AND detail != '' AND file_state_id IN (SELECT id FROM file_states WHERE task_id = ?)");
      run("UPDATE note_regions SET rect_json = 'values expired', where_text = 'values expired' WHERE task_id = ?");
      run(`UPDATE round_results SET result_json = '{"flags":[],"moved":[],"notices":[]}' WHERE task_id = ?`);
    });
  }

  /**
   * Records one step (a sweep that changed files) and its file states, once: a step already recorded for
   * (task, client, seq) is left as it is. Returns the step's id.
   */
  recordStep(input: RecordStepInput): number {
    return this.immediate(() => {
      const have = this.#db.prepare("SELECT id FROM steps WHERE task_id = ? AND client = ? AND seq = ?").get(input.taskId, input.client, input.seq) as { id: number } | undefined;
      if (have !== undefined) return Number(have.id);
      const ts = new Date().toISOString();
      const calls = JSON.stringify(input.callsOpen);
      const credited = JSON.stringify(input.credited);
      const stepId = Number(
        this.#db.prepare("INSERT INTO steps (task_id, client, seq, phase, ts, calls_open_json, credited_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.taskId, input.client, input.seq, input.phase, ts, calls, credited).lastInsertRowid,
      );
      const stmt = this.#db.prepare(
        "INSERT INTO file_states (step_id, task_id, file_path, sha256, prev_sha256, phase, calls_open_json, credited_json, size, kept, note, mtime_ns, credit_basis, connector, connector_version, connector_spec, changes_sha256, before_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const pending = this.#db.prepare("INSERT INTO file_state_captures (file_state_id, state, ts) VALUES (?, 'pending', ?)");
      for (const f of input.files) {
        const id = stmt.run(stepId, input.taskId, f.filePath, f.sha256, f.prevSha256, input.phase, calls, f.credited === undefined ? credited : JSON.stringify(f.credited), f.size, f.kept, f.note, f.mtimeNs ?? null, f.creditBasis ?? null, f.connector ?? null, f.connectorVersion ?? null, f.connectorSpec ?? null, f.changesSha256 ?? null, f.beforeBasis ?? null).lastInsertRowid;
        if (f.capturePending === true) pending.run(id, ts);
      }
      return stepId;
    });
  }

  /** The id of the step recorded for (task, client, seq), if any. */
  stepIdBySeq(taskId: number, client: string, seq: number): number | undefined {
    const r = this.#db.prepare("SELECT id FROM steps WHERE task_id = ? AND client = ? AND seq = ?").get(taskId, client, seq) as { id: number } | undefined;
    return r === undefined ? undefined : Number(r.id);
  }

  /** A task's steps, oldest first. */
  stepsForTask(taskId: number): StepRow[] {
    const rows = this.#db.prepare("SELECT * FROM steps WHERE task_id = ? ORDER BY id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), taskId: Number(r.task_id), client: String(r.client), seq: Number(r.seq), phase: String(r.phase) as StepRow["phase"], ts: String(r.ts), callsOpen: JSON.parse(String(r.calls_open_json)) as string[], credited: JSON.parse(String(r.credited_json)) as string[] }));
  }

  /** The newest `limit` file states of a task credited to exactly `callId` whose basis is inference (`named`, `window`, none), newest first. */
  inferredStatesOfCall(taskId: number, callId: string, limit = 50): Array<{ id: number; filePath: string; sha256: string; prevSha256: string | null }> {
    const rows = this.#db.prepare("SELECT id, file_path, sha256, prev_sha256 FROM file_states WHERE task_id = ? AND credited_json = ? AND (credit_basis IS NULL OR credit_basis IN ('named', 'window')) AND id NOT IN (SELECT file_state_id FROM file_state_proofs) ORDER BY id DESC LIMIT ?").all(taskId, JSON.stringify([callId]), limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), filePath: String(r.file_path), sha256: String(r.sha256), prevSha256: r.prev_sha256 == null ? null : String(r.prev_sha256) }));
  }

  /** Records that one file state's change stands on a host-reported edit. Append-only: `file_states` is never updated, so `fileStatesForTask` reads this beside the row. */
  proveFileState(fileStateId: number): void {
    this.#db.prepare("INSERT OR IGNORE INTO file_state_proofs (file_state_id, credit_basis, ts) VALUES (?, 'host-reported-edit', ?)").run(fileStateId, new Date().toISOString());
  }

  /** A task's file states, oldest first. */
  fileStatesForTask(taskId: number): FileStateRow[] {
    // A row's latest capture (a finished one before 'pending') stands in for the row's own connector columns once the review process has read it.
    const rows = this.#db.prepare(
      "SELECT f.*, p.credit_basis AS proof_basis, c.state AS cap_state, c.connector_version AS cap_version, c.connector_spec AS cap_spec, c.changes_sha256 AS cap_sha, c.reason AS cap_reason, c.detail AS cap_detail, (SELECT COUNT(*) FROM file_state_capture_tries t WHERE t.file_state_id = f.id) AS cap_tries, (SELECT changes_sha256 FROM file_state_capture_tries t WHERE t.file_state_id = f.id ORDER BY id DESC LIMIT 1) AS cap_try_sha FROM file_states f LEFT JOIN file_state_proofs p ON p.file_state_id = f.id LEFT JOIN file_state_captures c ON c.id = (SELECT id FROM file_state_captures WHERE file_state_id = f.id ORDER BY state = 'pending', id DESC LIMIT 1) WHERE f.task_id = ? ORDER BY f.id",
    ).all(taskId) as Array<Record<string, unknown>>;
    const str = (v: unknown): string | null => (v == null ? null : String(v));
    return rows.map((r) => ({
      id: Number(r.id),
      stepId: Number(r.step_id),
      taskId: Number(r.task_id),
      filePath: String(r.file_path),
      sha256: String(r.sha256),
      prevSha256: r.prev_sha256 == null ? null : String(r.prev_sha256),
      phase: String(r.phase) as StepRow["phase"],
      callsOpen: JSON.parse(String(r.calls_open_json)) as string[],
      credited: JSON.parse(String(r.credited_json)) as string[],
      size: Number(r.size),
      kept: String(r.kept) as FileStateRow["kept"],
      note: String(r.note),
      mtimeNs: r.mtime_ns == null ? null : String(r.mtime_ns),
      connector: r.connector == null ? null : String(r.connector),
      connectorVersion: r.cap_state === "captured" || (r.cap_state === "failed" && r.cap_version != null) ? str(r.cap_version) : str(r.connector_version),
      connectorSpec: r.cap_state === "captured" || (r.cap_state === "failed" && r.cap_spec != null) ? str(r.cap_spec) : str(r.connector_spec),
      changesSha256: r.cap_state === "captured" ? str(r.cap_sha) : str(r.changes_sha256),
      capture: r.cap_state == null ? null : (String(r.cap_state) as NonNullable<FileStateRow["capture"]>),
      captureReason: r.cap_state === "failed" ? str(r.cap_reason) : null,
      captureDetail: r.cap_state === "failed" && r.cap_detail != null && r.cap_detail !== "" ? String(r.cap_detail) : null,
      captureTries: Number(r.cap_tries ?? 0),
      captureTrySha: r.cap_state === "pending" ? str(r.cap_try_sha) : null,
      creditBasis: r.proof_basis != null ? (String(r.proof_basis) as ProofMethod) : r.credit_basis == null ? null : (String(r.credit_basis) as ProofMethod),
      beforeBasis: r.before_basis === "declared" ? "declared" : null,
    }));
  }

  /** The rows of a task whose change list the review process has not read yet (pending, nothing finished), oldest first. */
  pendingCapturesForTask(taskId: number): FileStateRow[] {
    return this.fileStatesForTask(taskId).filter((r) => r.capture === "pending");
  }

  /**
   * Queues a pending capture for a row that has no capture rows at all (a row the hook recorded with no connector). Writes only
   * `file_state_captures`; returns whether a row was added (false when the row already has any capture).
   */
  queueCapture(fileStateId: number): boolean {
    return this.immediate(() => {
      if (this.#db.prepare("SELECT 1 FROM file_state_captures WHERE file_state_id = ?").get(fileStateId) !== undefined) return false;
      this.#db.prepare("INSERT INTO file_state_captures (file_state_id, state, ts) VALUES (?, 'pending', ?)").run(fileStateId, new Date().toISOString());
      return true;
    });
  }

  /**
   * Records what reading one row's change list came to, once. A row that already has a finished capture keeps it (the first answer is the frozen one);
   * returns whether this one was recorded.
   */
  recordFileCapture(input: { fileStateId: number; state: "captured" | "failed"; connectorVersion?: string; connectorSpec?: string; changesSha256?: string; reason?: string; detail?: string }): boolean {
    return this.immediate(() => {
      const done = this.#db.prepare("SELECT 1 FROM file_state_captures WHERE file_state_id = ? AND state != 'pending'").get(input.fileStateId);
      if (done !== undefined) return false;
      this.#db.prepare("INSERT INTO file_state_captures (file_state_id, state, connector_version, connector_spec, changes_sha256, reason, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.fileStateId, input.state, input.connectorVersion ?? null, input.connectorSpec ?? null, input.state === "captured" ? (input.changesSha256 ?? null) : null, input.reason ?? null, input.state === "failed" ? (input.detail ?? null) : null, new Date().toISOString());
      return true;
    });
  }

  /** The "ask again" answers recorded for a row so far, the latest one's hash, and when it was recorded (ISO time, null with none). */
  captureTries(fileStateId: number): { count: number; latest: string | null; latestTs: string | null } {
    const r = this.#db.prepare("SELECT COUNT(*) AS n, (SELECT changes_sha256 FROM file_state_capture_tries WHERE file_state_id = ? ORDER BY id DESC LIMIT 1) AS latest, (SELECT ts FROM file_state_capture_tries WHERE file_state_id = ? ORDER BY id DESC LIMIT 1) AS latest_ts FROM file_state_capture_tries WHERE file_state_id = ?").get(fileStateId, fileStateId, fileStateId) as { n: number; latest: string | null; latest_ts: string | null };
    return { count: Number(r.n), latest: r.latest == null ? null : String(r.latest), latestTs: r.latest_ts == null ? null : String(r.latest_ts) };
  }

  /** Records one "ask again" answer of a row whose capture is still pending (a finished row records none); returns whether it was recorded. `ts` defaults to now. */
  recordCaptureTry(input: { fileStateId: number; changesSha256: string; ts?: string }): boolean {
    return this.immediate(() => {
      const done = this.#db.prepare("SELECT 1 FROM file_state_captures WHERE file_state_id = ? AND state != 'pending'").get(input.fileStateId);
      if (done !== undefined) return false;
      this.#db.prepare("INSERT INTO file_state_capture_tries (file_state_id, changes_sha256, ts) VALUES (?, ?, ?)").run(input.fileStateId, input.changesSha256, input.ts ?? new Date().toISOString());
      return true;
    });
  }

  /** Records what one after-capture request came to. Append-only; one row per request, whatever the outcome. */
  recordCaptureOutcome(input: { taskId: number | null; client: string; call: string; subject: string; outcome: CaptureOutcomeKind; reason: string }): number {
    const r = this.#db.prepare("INSERT INTO capture_outcomes (task_id, ts, client, call_id, subject, outcome, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.taskId, new Date().toISOString(), input.client, input.call, input.subject, input.outcome, input.reason);
    return Number(r.lastInsertRowid);
  }

  /** A task's capture outcomes, oldest first. */
  captureOutcomesForTask(taskId: number): CaptureOutcomeRow[] {
    const rows = this.#db.prepare("SELECT * FROM capture_outcomes WHERE task_id = ? ORDER BY id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map(captureOutcomeRow);
  }

  /** Every capture outcome in the ledger, oldest first (a test and an audit read this; the page reads `captureOutcomesForTask`). */
  allCaptureOutcomes(): CaptureOutcomeRow[] {
    return (this.#db.prepare("SELECT * FROM capture_outcomes ORDER BY id").all() as Array<Record<string, unknown>>).map(captureOutcomeRow);
  }

  /** Records that these stored states' bytes were deleted, with the reason in words. A state already recorded keeps its first reason. */
  recordStateRemovals(taskId: number, removals: Array<{ sha256: string; reason: string }>, at: Date = new Date()): void {
    const stmt = this.#db.prepare("INSERT OR IGNORE INTO state_removals (task_id, sha256, ts, reason) VALUES (?, ?, ?, ?)");
    for (const r of removals) stmt.run(taskId, r.sha256, at.toISOString(), r.reason);
  }

  /**
   * The stored states of a task whose bytes were deleted, by hash. The table is append-only, so a state whose bytes were
   * dropped and later written again (A to B to A, B dropped in between) keeps its row; it is left out here because its
   * bytes are in the store again: the re-stored bytes win.
   */
  stateRemovalsForTask(taskId: number): Array<{ sha256: string; ts: string; reason: string }> {
    const rows = this.#db.prepare("SELECT sha256, ts, reason FROM state_removals WHERE task_id = ? ORDER BY ts, sha256").all(taskId) as Array<Record<string, unknown>>;
    const home = this.home;
    return rows
      .map((r) => ({ sha256: String(r.sha256), ts: String(r.ts), reason: String(r.reason) }))
      .filter((r) => home === undefined || !existsSync(path.join(home, "tasks", String(taskId), "states", r.sha256)));
  }

  /** Fills in the hash of a snapshot row that has none; refused once it has one. */
  backfillSnapshotHash(snapshotId: number, sha256: string): void {
    this.#db.prepare("UPDATE task_snapshots SET sha256 = ? WHERE id = ? AND sha256 IS NULL").run(sha256, snapshotId);
  }

  /** The task's rounds, in order. */
  roundsForTask(taskId: number): RoundRow[] {
    const rows = this.#db
      .prepare("SELECT id, task_id, seq, ts, intent, final, last_op_id FROM rounds WHERE task_id = ? ORDER BY seq")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      taskId: Number(r.task_id),
      seq: Number(r.seq),
      final: Number(r.final) === 1,
      lastOpId: Number(r.last_op_id),
      ts: String(r.ts),
      intent: String(r.intent),
    }));
  }

  /** `client`'s most recent task (highest id), matched the way `openTask` stored the name. */
  latestTaskForClient(client: string): number | undefined {
    const row = this.#db
      .prepare("SELECT MAX(id) AS id FROM tasks WHERE client = ?")
      .get(truncateChars(client, MAX_CLIENT_NAME_CHARS)) as { id: number | null };
    return row.id ?? undefined;
  }

  /** Every task id, oldest first. */
  allTaskIds(): number[] {
    return (this.#db.prepare("SELECT id FROM tasks ORDER BY id").all() as Array<{ id: number }>).map((r) => Number(r.id));
  }

  /**
   * Every task of the folder `client` names, whatever its session: the client itself and `<client>?session=<id>`. Oldest first.
   * `client` is the folder-only form (`stripHookSession`); any other client name has no family but itself.
   */
  tasksForFamily(client: string): number[] {
    const base = truncateChars(client, MAX_CLIENT_NAME_CHARS);
    const like = `${base.replace(/[\\%_]/g, (c) => `\\${c}`)}?session=%`;
    const rows = this.#db.prepare("SELECT id FROM tasks WHERE client = ? OR client LIKE ? ESCAPE '\\' ORDER BY id").all(base, like) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  }

  /** Every task of `client`, oldest first. */
  tasksForClient(client: string): number[] {
    const rows = this.#db
      .prepare("SELECT id FROM tasks WHERE client = ? ORDER BY id")
      .all(truncateChars(client, MAX_CLIENT_NAME_CHARS)) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  }

  /**
   * `client`'s tasks that may be open, oldest first: no round yet, a latest round that isn't
   * final, a rejection or task-level request stamped at or above its op watermark. A superset; the caller decides.
   */
  maybeOpenTasksForClient(client: string): number[] {
    const rows = this.#db
      .prepare(
        `SELECT t.id FROM tasks t
         LEFT JOIN rounds r ON r.task_id = t.id AND r.seq = (SELECT MAX(seq) FROM rounds WHERE task_id = t.id)
         WHERE t.client = ? AND (r.id IS NULL OR r.final = 0 OR EXISTS (
           SELECT 1 FROM review_decisions d JOIN review_rows rr ON rr.id = d.row_id
           WHERE rr.task_id = t.id AND d.decision = 'reject' AND d.after_op_id >= r.last_op_id)
         OR EXISTS (
           SELECT 1 FROM review_requests q WHERE q.task_id = t.id AND q.after_op_id >= r.last_op_id)
         OR EXISTS (
           SELECT 1 FROM request_confirmations c JOIN review_requests q ON q.id = c.request_id
           WHERE q.task_id = t.id AND c.verdict = 'reject' AND c.after_op_id >= r.last_op_id))
         ORDER BY t.id`,
      )
      .all(truncateChars(client, MAX_CLIENT_NAME_CHARS)) as Array<{ id: number }>;
    return rows.map((r) => Number(r.id));
  }

  /** The task of review row `rowId` if that task belongs to `client`, else undefined. */
  reviewRowTaskForClient(rowId: number, client: string): number | undefined {
    const row = this.#db
      .prepare("SELECT r.task_id FROM review_rows r JOIN tasks t ON t.id = r.task_id WHERE r.id = ? AND t.client = ?")
      .get(rowId, truncateChars(client, MAX_CLIENT_NAME_CHARS)) as { task_id: number } | undefined;
    return row === undefined ? undefined : Number(row.task_id);
  }

  /** The task's client name, or undefined when there is no such task. */
  taskClient(taskId: number): string | null | undefined {
    const row = this.#db.prepare("SELECT client FROM tasks WHERE id = ?").get(taskId) as
      | { client: string | null }
      | undefined;
    return row === undefined ? undefined : row.client;
  }

  /** Every review row of `taskId`, oldest first, with its round's seq and op watermark. */
  reviewRowsForTask(taskId: number): ReviewRowRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT r.*, rd.seq AS round_seq, rd.last_op_id AS round_last_op_id
         FROM review_rows r JOIN rounds rd ON rd.id = r.round_id
         WHERE r.task_id = ? ORDER BY r.id`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      roundId: Number(r.round_id),
      roundSeq: Number(r.round_seq),
      taskId: Number(r.task_id),
      filePath: String(r.file_path),
      layer: String(r.layer),
      location: String(r.location),
      kind: String(r.kind),
      status: String(r.status) as ReviewRowRecord["status"],
      before: r.before_json == null ? null : JSON.parse(String(r.before_json)),
      after: r.after_json == null ? null : JSON.parse(String(r.after_json)),
      ops: JSON.parse(String(r.ops_json)) as ReviewRowRecord["ops"],
      description: String(r.description),
      detail: JSON.parse(String(r.detail_json)) as Record<string, unknown>,
      roundLastOpId: Number(r.round_last_op_id),
    }));
  }

  /** The `round_note` events of `taskId`'s rounds, oldest first. */
  roundNotesForTask(taskId: number): RoundNote[] {
    const rows = this.#db
      .prepare(
        `SELECT payload_json FROM events
         WHERE kind = 'round_note' AND json_extract(payload_json, '$.taskId') = ? ORDER BY id`,
      )
      .all(taskId) as Array<{ payload_json: string }>;
    return rows.map((r) => {
      const { round, note } = JSON.parse(r.payload_json) as RoundNote;
      return { round: Number(round), note: String(note) };
    });
  }

  /** Round seqs of `taskId` that were cut by someone other than the agent's submit (`round_actor` events). */
  roundActorsForTask(taskId: number): Map<number, string> {
    const rows = this.#db
      .prepare(
        `SELECT payload_json FROM events
         WHERE kind = 'round_actor' AND json_extract(payload_json, '$.taskId') = ? ORDER BY id`,
      )
      .all(taskId) as Array<{ payload_json: string }>;
    return new Map(
      rows.map((r) => {
        const { round, actor } = JSON.parse(r.payload_json) as { round: number; actor: string };
        return [Number(round), String(actor)] as [number, string];
      }),
    );
  }

  /** Records the agent's submit summary against an existing round, instead of cutting a duplicate one. */
  recordRoundSummary(input: { taskId: number; round: number; intent: string; clientName: string | null }): void {
    this.#db
      .prepare("INSERT INTO events (ts, op_id, kind, payload_json) VALUES (?, NULL, 'round_summary', ?)")
      .run(new Date().toISOString(), JSON.stringify(input));
  }

  /** The seqs of `taskId`'s rounds that already carry an agent summary (`round_summary` events). */
  summarizedRoundsForTask(taskId: number): Set<number> {
    const rows = this.#db
      .prepare(
        `SELECT payload_json FROM events
         WHERE kind = 'round_summary' AND json_extract(payload_json, '$.taskId') = ?`,
      )
      .all(taskId) as Array<{ payload_json: string }>;
    return new Set(rows.map((r) => Number((JSON.parse(r.payload_json) as { round: number }).round)));
  }

  /** Every reviewer decision on `taskId`'s rows, oldest first. */
  decisionsForTask(taskId: number): DecisionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT d.* FROM review_decisions d JOIN review_rows r ON r.id = d.row_id
         WHERE r.task_id = ? ORDER BY d.id`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      rowId: Number(r.row_id),
      decision: String(r.decision) as DecisionRow["decision"],
      note: String(r.note),
      reviewer: String(r.reviewer),
      afterOpId: Number(r.after_op_id),
      ts: String(r.ts),
    }));
  }

  /** Every item resolution on `taskId`'s rows, oldest first. */
  resolutionsForTask(taskId: number): ResolutionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM item_resolutions s JOIN review_rows r ON r.id = s.row_id
         WHERE r.task_id = ? ORDER BY s.id`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      rowId: Number(r.row_id),
      resolution: String(r.resolution) as ResolutionRow["resolution"],
      intent: String(r.intent),
      clientName: r.client_name == null ? null : String(r.client_name),
      decisionId: r.decision_id == null ? null : Number(r.decision_id),
      opIds: JSON.parse(String(r.op_ids_json)) as number[],
      ts: String(r.ts),
    }));
  }

  /** Appends a reviewer decision, stamped with the current highest op id. Returns its id. */
  recordDecision(input: RecordDecisionInput): number {
    const result = this.#db
      .prepare(
        `INSERT INTO review_decisions (row_id, decision, note, reviewer, after_op_id, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.rowId, input.decision, input.note, input.reviewer, this.maxOpId(), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** Appends an item resolution. Returns its id. */
  recordResolution(input: RecordResolutionInput): number {
    const result = this.#db
      .prepare(
        `INSERT INTO item_resolutions (row_id, resolution, intent, client_name, decision_id, op_ids_json, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.rowId,
        input.resolution,
        input.intent,
        input.clientName != null ? truncateChars(input.clientName, MAX_CLIENT_NAME_CHARS) : null,
        input.decisionId,
        JSON.stringify(input.opIds),
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Every task-level request filed on `taskId`, oldest first. */
  requestsForTask(taskId: number): RequestRow[] {
    const rows = this.#db
      .prepare("SELECT * FROM review_requests WHERE task_id = ? ORDER BY id")
      .all(taskId) as Record<string, unknown>[];
    return rows.map(requestRow);
  }

  /** The request `requestId` if it belongs to one of `client`'s tasks. */
  requestForClient(requestId: number, client: string): RequestRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT q.* FROM review_requests q JOIN tasks t ON t.id = q.task_id
         WHERE q.id = ? AND t.client = ?`,
      )
      .get(requestId, client) as Record<string, unknown> | undefined;
    return row ? requestRow(row) : undefined;
  }

  /** Every answer to `taskId`'s requests, oldest first. */
  requestResolutionsForTask(taskId: number): RequestResolutionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM request_resolutions s JOIN review_requests q ON q.id = s.request_id
         WHERE q.task_id = ? ORDER BY s.id`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      requestId: Number(r.request_id),
      resolution: String(r.resolution) as RequestResolutionRow["resolution"],
      intent: String(r.intent),
      clientName: r.client_name == null ? null : String(r.client_name),
      opIds: JSON.parse(String(r.op_ids_json)) as number[],
      ts: String(r.ts),
    }));
  }

  /** Appends a task-level request, stamped with the current highest op id. Returns its id. */
  recordRequest(input: { taskId: number; note: string; reviewer: string }): number {
    const result = this.#db
      .prepare(
        `INSERT INTO review_requests (task_id, note, reviewer, after_op_id, ts) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.taskId, input.note, input.reviewer, this.maxOpId(), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** Appends the agent's answer to a request. Returns its id. */
  recordRequestResolution(input: RecordResolutionRequestInput): number {
    const result = this.#db
      .prepare(
        `INSERT INTO request_resolutions (request_id, resolution, intent, client_name, op_ids_json, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.resolution,
        input.intent,
        input.clientName != null ? truncateChars(input.clientName, MAX_CLIENT_NAME_CHARS) : null,
        JSON.stringify(input.opIds),
        new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Every reviewer verdict on the agent's answers to `taskId`'s requests, oldest first. */
  requestConfirmationsForTask(taskId: number): RequestConfirmationRow[] {
    const rows = this.#db
      .prepare(
        `SELECT c.* FROM request_confirmations c JOIN review_requests q ON q.id = c.request_id
         WHERE q.task_id = ? ORDER BY c.id`,
      )
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      requestId: Number(r.request_id),
      resolutionId: Number(r.resolution_id),
      verdict: String(r.verdict) as RequestConfirmationRow["verdict"],
      note: String(r.note),
      reviewer: String(r.reviewer),
      afterOpId: Number(r.after_op_id ?? 0),
      ts: String(r.ts),
    }));
  }

  /** Appends a reviewer's verdict on the agent's answer `resolutionId` to a request. Returns its id. */
  recordRequestConfirmation(input: { requestId: number; resolutionId: number; verdict: "confirm" | "reject"; note: string; reviewer: string }): number {
    const result = this.#db
      .prepare(
        `INSERT INTO request_confirmations (request_id, resolution_id, verdict, note, reviewer, after_op_id, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.requestId, input.resolutionId, input.verdict, input.note, input.reviewer, this.maxOpId(), new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  /** Appends one verdict on a rail stop. Never updates or deletes (the table refuses both). Returns its id. */
  appendStopVerdict(v: Omit<StopVerdictRow, "id" | "ts">, at: Date = new Date()): number {
    const result = this.#db
      .prepare("INSERT INTO stop_verdicts (task_id, stop_id, subject, fingerprint, status, note, reviewer, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(v.taskId, v.stopId, v.subject, v.fingerprint, v.status, v.note, v.reviewer, at.toISOString());
    return Number(result.lastInsertRowid);
  }

  /** Records one Send back: the exact prompt text and the stop ids it covers. Never updated or deleted (the table refuses both). Returns its id. */
  appendSendBack(v: Omit<SendBackRow, "id" | "ts" | "nonce"> & { nonce?: string }, at: Date = new Date()): number {
    const nonce = v.nonce ?? newSendBackNonce();
    if (!/^[a-z0-9]{6}$/.test(nonce)) throw new Error("a send-back nonce is 6 characters of a-z and 0-9");
    const result = this.#db
      .prepare("INSERT INTO send_backs (task_id, prompt, stop_ids_json, reviewer, note, ts, nonce) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(v.taskId, v.prompt, JSON.stringify(v.stopIds), v.reviewer, v.note, at.toISOString(), nonce);
    return Number(result.lastInsertRowid);
  }

  /**
   * Records one region the person pointed at. `onId` runs inside the same write with the new id (it writes the region's picture): if it throws,
   * nothing is recorded. Never updated or deleted (the table refuses both, bar the expiry blanking). Returns its id.
   */
  appendRegion(v: Omit<RegionRow, "id" | "ts" | "linked" | "verdictId" | "sendBackId" | "stopId">, onId?: (id: number) => void, at: Date = new Date()): number {
    return this.immediate(() => {
      const r = this.#db
        .prepare("INSERT INTO note_regions (task_id, change_key, side, kind, sha, page, rect_json, where_text, picture, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(v.taskId, v.changeKey, v.side, v.kind, v.sha, v.page, JSON.stringify(v.rect), v.where, v.picture ? 1 : 0, at.toISOString());
      const id = Number(r.lastInsertRowid);
      onId?.(id);
      return id;
    });
  }

  /** Every region of `taskId`, oldest first, with the verdict or send-back that took it, if any. */
  regionsForTask(taskId: number): RegionRow[] {
    const rows = this.#db
      .prepare("SELECT n.*, l.verdict_id AS vid, l.send_back_id AS sbid, v.stop_id AS stop FROM note_regions n LEFT JOIN region_links l ON l.region_id = n.id LEFT JOIN stop_verdicts v ON v.id = l.verdict_id WHERE n.task_id = ? ORDER BY n.id")
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map(regionRowOf);
  }

  /** The regions linked to the verdict `verdictId`, oldest first (the task is the verdict's own). */
  regionsOfVerdict(verdictId: number): RegionRow[] {
    const rows = this.#db
      .prepare("SELECT n.*, l.verdict_id AS vid, l.send_back_id AS sbid, v.stop_id AS stop FROM note_regions n JOIN region_links l ON l.region_id = n.id JOIN stop_verdicts v ON v.id = l.verdict_id WHERE l.verdict_id = ? ORDER BY n.id")
      .all(verdictId) as Array<Record<string, unknown>>;
    return rows.map(regionRowOf);
  }

  /**
   * Why `ids` cannot go with one note of `taskId`, or undefined when they can. At most `MAX_NOTE_REGIONS`, no id twice, each id a region of this
   * task that no note has taken, and, for a step's note, each cut from that step's own change (`changeKey`; null for the overall note, which takes any).
   */
  regionLinkProblem(taskId: number, ids: readonly number[], changeKey: string | null): string | undefined {
    if (ids.length > MAX_NOTE_REGIONS) return `A note takes at most ${MAX_NOTE_REGIONS} regions.`;
    if (new Set(ids).size !== ids.length) return "A region is listed twice.";
    const have = new Map(this.regionsForTask(taskId).map((r) => [r.id, r]));
    const heldByNote = new Set(this.liveNotes(taskId).flatMap((n) => (n.regionId === null ? [] : [n.regionId])));
    for (const id of ids) {
      const r = have.get(id);
      if (r === undefined) return `Region ${id} is not a region of this task.`;
      if (r.linked || heldByNote.has(id)) return `Region ${id} is already part of a note.`;
      if (changeKey !== null && r.changeKey !== changeKey) return `Region ${id} was drawn on a different step.`;
    }
    return undefined;
  }

  /** Links regions to the verdict or send-back that carries them. Call inside the write that records that verdict or send-back, after `regionLinkProblem` said none. */
  linkRegions(ids: readonly number[], to: { verdictId: number } | { sendBackId: number }, at: Date = new Date()): void {
    const stmt = this.#db.prepare("INSERT INTO region_links (region_id, verdict_id, send_back_id, ts) VALUES (?, ?, ?, ?)");
    for (const id of ids) stmt.run(id, "verdictId" in to ? to.verdictId : null, "sendBackId" in to ? to.sendBackId : null, at.toISOString());
  }

  /** Longest sticky-note text. */
  static readonly MAX_NOTE_TEXT = 2000;

  /** The live notes of `taskId` (latest row per note not deleted and not sent), oldest note first. */
  liveNotes(taskId: number): NoteRow[] {
    const rows = this.#db
      .prepare("SELECT r.* FROM review_notes r WHERE r.task_id = ? AND r.id = (SELECT MAX(id) FROM review_notes WHERE note_id = r.note_id) AND r.deleted = 0 AND r.sent_back_id IS NULL ORDER BY r.note_id")
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.note_id), rowId: Number(r.id), taskId: Number(r.task_id), text: String(r.text), regionId: r.region_id === null ? null : Number(r.region_id), stopId: r.stop_id == null ? null : String(r.stop_id), ts: String(r.ts) }));
  }

  /** Why `regionId` cannot go with a new note of `taskId`, or undefined: it must be an unlinked region of this task that no live note holds. */
  noteRegionProblem(taskId: number, regionId: number): string | undefined {
    return this.regionLinkProblem(taskId, [regionId], null);
  }

  /** Writes a new note made on rail stop `stopId` (null: none); returns its note_id. The caller has judged the text and `noteRegionProblem`, and holds the write lock (`immediate`) across both. */
  appendNote(taskId: number, text: string, regionId: number | null, stopId: string | null = null, at: Date = new Date()): number {
    // note_id is this row's own id: the next AUTOINCREMENT value, read in the same statement that inserts.
    const r = this.#db
      .prepare("INSERT INTO review_notes (task_id, note_id, text, region_id, deleted, sent_back_id, ts, stop_id) VALUES (?, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'review_notes'), 0) + 1, ?, ?, 0, NULL, ?, ?)")
      .run(taskId, text, regionId, at.toISOString(), stopId);
    return Number(r.lastInsertRowid);
  }

  /** The live note `noteId` of `taskId`, or undefined (not a note of this task, deleted, or already sent). */
  liveNote(taskId: number, noteId: number): NoteRow | undefined {
    return this.liveNotes(taskId).find((n) => n.id === noteId);
  }

  /** Appends the edited text (and the same region and stop) of a live note. Returns false when the note is not live in this task. */
  editNote(taskId: number, noteId: number, text: string, at: Date = new Date()): boolean {
    return this.immediate(() => {
      const n = this.liveNote(taskId, noteId);
      if (n === undefined) return false;
      this.#db.prepare("INSERT INTO review_notes (task_id, note_id, text, region_id, deleted, sent_back_id, ts, stop_id) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)").run(taskId, noteId, text, n.regionId, at.toISOString(), n.stopId);
      return true;
    });
  }

  /** Retires a live note (its region is free again). Returns false when the note is not live in this task. */
  deleteNote(taskId: number, noteId: number, at: Date = new Date()): boolean {
    return this.immediate(() => {
      const n = this.liveNote(taskId, noteId);
      if (n === undefined) return false;
      this.#db.prepare("INSERT INTO review_notes (task_id, note_id, text, region_id, deleted, sent_back_id, ts, stop_id) VALUES (?, ?, ?, ?, 1, NULL, ?, ?)").run(taskId, noteId, n.text, n.regionId, at.toISOString(), n.stopId);
      return true;
    });
  }

  /** Marks `notes` sent with `sendBackId` and links each one's region to that send-back. Call inside the write that records the send-back. */
  markNotesSent(notes: readonly NoteRow[], sendBackId: number, at: Date = new Date()): void {
    const stmt = this.#db.prepare("INSERT INTO review_notes (task_id, note_id, text, region_id, deleted, sent_back_id, ts, stop_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)");
    for (const n of notes) stmt.run(n.taskId, n.id, n.text, n.regionId, sendBackId, at.toISOString(), n.stopId);
    this.linkRegions(notes.flatMap((n) => (n.regionId === null ? [] : [n.regionId])), { sendBackId }, at);
  }

  /** Records one Copy of a send-back: the exact text that went to the clipboard. Never updated or deleted (the table refuses both). Returns its id. */
  appendSendBackCopy(sendBackId: number, text: string, at: Date = new Date()): number {
    const result = this.#db.prepare("INSERT INTO send_back_copies (send_back_id, text, ts) VALUES (?, ?, ?)").run(sendBackId, text, at.toISOString());
    return Number(result.lastInsertRowid);
  }

  /** The send-back `id`, or undefined. */
  originById(id: number): SendBackRow | undefined {
    const r = this.#db.prepare("SELECT * FROM send_backs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (r === undefined) return undefined;
    return { id: Number(r.id), taskId: Number(r.task_id), prompt: String(r.prompt), stopIds: JSON.parse(String(r.stop_ids_json)) as string[], reviewer: String(r.reviewer), note: String(r.note ?? ""), ts: String(r.ts), nonce: typeof r.nonce === "string" ? r.nonce : null };
  }

  /** Links the fix task `taskId` to the send-back it came from. One link per task: a second call for the same task writes nothing. Returns whether a row was written. */
  appendFollow(taskId: number, sendBackId: number, at: Date = new Date()): boolean {
    const r = this.#db.prepare("INSERT OR IGNORE INTO follows (task_id, send_back_id, ts) VALUES (?, ?, ?)").run(taskId, sendBackId, at.toISOString());
    return Number(r.changes) > 0;
  }

  /** The send-back the task `taskId` came from, or undefined when it follows none. */
  followOf(taskId: number): FollowRow | undefined {
    const r = this.#db.prepare("SELECT f.id, f.task_id, f.send_back_id, f.ts, s.task_id AS from_task, s.ts AS sent_at FROM follows f JOIN send_backs s ON s.id = f.send_back_id WHERE f.task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    return r === undefined ? undefined : { id: Number(r.id), taskId: Number(r.task_id), sendBackId: Number(r.send_back_id), ts: String(r.ts), fromTask: Number(r.from_task), sentAt: String(r.sent_at) };
  }

  /** The fix tasks that came from a send-back of `taskId`, oldest first. */
  followersOf(taskId: number): FollowRow[] {
    const rows = this.#db.prepare("SELECT f.id, f.task_id, f.send_back_id, f.ts, s.task_id AS from_task, s.ts AS sent_at FROM follows f JOIN send_backs s ON s.id = f.send_back_id WHERE s.task_id = ? ORDER BY f.id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), taskId: Number(r.task_id), sendBackId: Number(r.send_back_id), ts: String(r.ts), fromTask: Number(r.from_task), sentAt: String(r.sent_at) }));
  }

  /** Every Copy of the send-back `sendBackId`, oldest first. */
  sendBackCopies(sendBackId: number): SendBackCopyRow[] {
    const rows = this.#db.prepare("SELECT * FROM send_back_copies WHERE send_back_id = ? ORDER BY id").all(sendBackId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), sendBackId: Number(r.send_back_id), text: String(r.text), ts: String(r.ts) }));
  }

  /** Every Send back of `taskId`, oldest first. */
  sendBacksForTask(taskId: number): SendBackRow[] {
    const rows = this.#db.prepare("SELECT * FROM send_backs WHERE task_id = ? ORDER BY id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), taskId: Number(r.task_id), prompt: String(r.prompt), stopIds: JSON.parse(String(r.stop_ids_json)) as string[], reviewer: String(r.reviewer), note: String(r.note ?? ""), ts: String(r.ts), nonce: typeof r.nonce === "string" ? r.nonce : null }));
  }

  /** Every verdict of `taskId`, oldest first. */
  stopVerdictsForTask(taskId: number): StopVerdictRow[] {
    const rows = this.#db.prepare("SELECT * FROM stop_verdicts WHERE task_id = ? ORDER BY id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), taskId: Number(r.task_id), stopId: String(r.stop_id), subject: String(r.subject), fingerprint: String(r.fingerprint), status: r.status as StopVerdictRow["status"], note: String(r.note), reviewer: String(r.reviewer), ts: String(r.ts) }));
  }

  /**
   * Records a soft sign-off and the acknowledgement that came with it, in one transaction. The signature is the fixed kind
   * `SOFT_SIGNATURE`; this is the only sign-off write. `check` runs inside the
   * write lock, so what it reads (the verdicts) cannot change before the row lands; it throws to refuse. A list it returns is stored as `covered` in place of `input.covered`, so the list is read under the same lock as the check. Returns both ids.
   */
  recordSoftSubmission(input: RecordSignoffInput & { acknowledged: string[]; reviewer: string; stateMark?: number; covered?: SubmissionRow["covered"] }, check: () => SubmissionRow["covered"] | void = () => {}): { signoffId: number; submissionId: number } {
    return this.immediate(() => {
      const covered = check() ?? input.covered;
      const now = new Date().toISOString();
      const signoff = this.#db
        .prepare(
          `INSERT INTO signoffs (task_id, signer, ts, rounds, rejections_json, files_json, left_out_json, closed_task, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(input.taskId, input.signer, now, input.rounds, JSON.stringify(input.rejections), JSON.stringify(input.files), JSON.stringify(input.leftOut), input.closedTask ? 1 : 0, SOFT_SIGNATURE);
      const signoffId = Number(signoff.lastInsertRowid);
      const sub = this.#db
        .prepare("INSERT INTO submissions (task_id, signoff_id, acknowledged_json, reviewer, ts, state_mark, covered_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.taskId, signoffId, JSON.stringify(input.acknowledged), input.reviewer, now, input.stateMark ?? null, covered === undefined ? null : JSON.stringify(covered));
      return { signoffId, submissionId: Number(sub.lastInsertRowid) };
    });
  }

  /** Every submission of `taskId`, oldest first. */
  submissionsForTask(taskId: number): SubmissionRow[] {
    const rows = this.#db.prepare("SELECT * FROM submissions WHERE task_id = ? ORDER BY id").all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ id: Number(r.id), taskId: Number(r.task_id), signoffId: Number(r.signoff_id), acknowledged: JSON.parse(String(r.acknowledged_json)) as string[], reviewer: String(r.reviewer), ts: String(r.ts), stateMark: r.state_mark == null ? null : Number(r.state_mark), covered: r.covered_json == null ? null : (JSON.parse(String(r.covered_json)) as SubmissionRow["covered"]) }));
  }

  /** The highest file state id of `taskId` (0 when it has none). */
  maxFileStateId(taskId: number): number {
    const row = this.#db.prepare("SELECT MAX(id) AS m FROM file_states WHERE task_id = ?").get(taskId) as { m: number | null };
    return row.m ?? 0;
  }

  /**
   * Whether file states landed on `taskId` after `submission` was taken. A submission with a recorded mark compares ids; one with
   * no mark compares the step time of each file state with the submission time.
   */
  newWorkSince(taskId: number, submission: SubmissionRow): boolean {
    if (submission.stateMark !== null) return this.maxFileStateId(taskId) > submission.stateMark;
    const steps = new Map(this.stepsForTask(taskId).map((st) => [st.id, st.ts]));
    return this.fileStatesForTask(taskId).some((f) => (steps.get(f.stepId) ?? "") > submission.ts);
  }

  /**
   * Runs `fn` in one write transaction (BEGIN IMMEDIATE: the write lock is taken up front, so no
   * other connection writes between `fn`'s reads and its writes). Commits on return, rolls back on
   * throw. `fn` must be synchronous.
   */
  immediate<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The task's sign-offs, oldest first. */
  signoffsForTask(taskId: number): SignoffRow[] {
    const rows = this.#db.prepare("SELECT * FROM signoffs WHERE task_id = ? ORDER BY id").all(taskId) as Record<string, unknown>[];
    return rows.map(signoffRow);
  }

  /** Every sign-off that recorded a file with this path or this SHA-256, or left this path (or a folder the "and N more" entry covers) out, oldest first. */
  signoffsForFile(filePath: string, sha256: string): SignoffRow[] {
    const dir = path.dirname(filePath);
    const rows = this.#db
      .prepare(
        `SELECT * FROM signoffs s WHERE EXISTS (
           SELECT 1 FROM json_each(s.files_json) f
           WHERE json_extract(f.value, '$.path') = ? OR json_extract(f.value, '$.sha256') = ?)
         OR EXISTS (
           SELECT 1 FROM json_each(COALESCE(s.left_out_json, '[]')) l WHERE json_extract(l.value, '$.path') = ?)
         OR EXISTS (
           SELECT 1 FROM json_each(COALESCE(s.left_out_json, '[]')) l, json_each(COALESCE(json_extract(l.value, '$.folders'), '[]')) d
           WHERE d.value = ?)
         ORDER BY s.id`,
      )
      .all(filePath, sha256, filePath, dir) as Record<string, unknown>[];
    return rows.map(signoffRow);
  }

  /** Highest `ops.id` so far, or 0 if there are none. */
  maxOpId(): number {
    const row = this.#db.prepare("SELECT MAX(id) AS id FROM ops").get() as { id: number | null };
    return row.id ?? 0;
  }

  /**
   * The task's ops that count with `afterOpId < id <= upToOpId`: successful ones (`result_code = 'OK'`) and a hook-recorded failed call
   * (`TOOL_FAILED`). The second is not a refused write: the hook adapter saw the files move while the call ran, so its cells and
   * credit are as real as a successful call's, and the page needs them to say that the call failed.
   */
  okOpsForTask(taskId: number, afterOpId: number, upToOpId: number): TaskOpRow[] {
    const rows = this.#db
      .prepare(
        `SELECT id, tool, args_json, intent, client_name FROM ops
         WHERE task_id = ? AND result_code IN ('OK', '${TOOL_FAILED}', '${TOOL_NOT_RUN}') AND id > ? AND id <= ? ORDER BY id`,
      )
      .all(taskId, afterOpId, upToOpId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      tool: String(r.tool),
      argsJson: String(r.args_json),
      intent: String(r.intent),
      clientName: r.client_name == null ? null : String(r.client_name),
    }));
  }

  /**
   * Records one submit round atomically: the round's snapshots, its `rounds` row, and every
   * review row. Returns the round id and the review-row ids in input order.
   */
  recordRound(input: RecordRoundInput): { roundId: number; rowIds: number[] } {
    this.#db.exec("BEGIN");
    try {
      for (const snap of input.snapshots) {
        this.recordSnapshot(snap);
      }
      const round = this.#db
        .prepare(
          `INSERT INTO rounds (task_id, seq, ts, intent, client_name, final, last_op_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.taskId,
          input.seq,
          new Date().toISOString(),
          input.intent,
          input.clientName != null ? truncateChars(input.clientName, MAX_CLIENT_NAME_CHARS) : null,
          input.final ? 1 : 0,
          input.lastOpId,
        );
      const roundId = Number(round.lastInsertRowid);
      const insertRow = this.#db.prepare(
        `INSERT INTO review_rows
          (round_id, task_id, file_path, layer, location, kind, status, before_json, after_json,
           ops_json, description, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const rowIds = input.rows.map((row) =>
        Number(
          insertRow.run(
            roundId,
            input.taskId,
            row.filePath,
            row.layer,
            row.location,
            row.kind,
            row.status,
            JSON.stringify(row.before ?? null),
            JSON.stringify(row.after ?? null),
            JSON.stringify(row.ops),
            row.description,
            JSON.stringify(row.detail ?? {}),
          ).lastInsertRowid,
        ),
      );
      const insertNote = this.#db.prepare("INSERT INTO events (ts, op_id, kind, payload_json) VALUES (?, NULL, 'round_note', ?)");
      for (const note of input.notes ?? []) {
        insertNote.run(new Date().toISOString(), JSON.stringify({ taskId: input.taskId, round: input.seq, roundId, note }));
      }
      if (input.actor) {
        this.#db
          .prepare("INSERT INTO events (ts, op_id, kind, payload_json) VALUES (?, NULL, 'round_actor', ?)")
          .run(new Date().toISOString(), JSON.stringify({ taskId: input.taskId, round: input.seq, roundId, actor: input.actor }));
      }
      this.#db.exec("COMMIT");
      return { roundId, rowIds };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The ops that name this session in their args (or are truncated stand-ins, which carry only the call id), with the ids they carry. */
  sessionOpRows(sessionId: string): Array<{ id: number; toolUseId?: string; sessionId?: string; truncated: boolean; closedBy?: string }> {
    const rows = this.#db
      .prepare(`SELECT id, args_json FROM ops WHERE instr(args_json, ?) > 0 OR instr(args_json, '"_truncated":true') > 0 ORDER BY id`)
      .all(sessionId) as Array<{ id: number; args_json: string }>;
    const out: Array<{ id: number; toolUseId?: string; sessionId?: string; truncated: boolean; closedBy?: string }> = [];
    for (const r of rows) {
      try {
        const a = JSON.parse(r.args_json) as Record<string, unknown>;
        if (a._truncated === true) {
          const preview = typeof a.preview === "string" ? a.preview : "";
          out.push({ id: r.id, toolUseId: /"tool_use_id":"([^"]+)"/.exec(preview)?.[1], sessionId: /"session_id":"([^"]+)"/.exec(preview)?.[1], truncated: true, closedBy: /"closedBy":"([^"]+)"/.exec(preview)?.[1] });
        } else {
          out.push({ id: r.id, toolUseId: typeof a.tool_use_id === "string" ? a.tool_use_id : undefined, sessionId: typeof a.session_id === "string" ? a.session_id : undefined, truncated: false, closedBy: typeof a.closedBy === "string" ? a.closedBy : undefined });
        }
      } catch {
        // not JSON: no session to name
      }
    }
    return out;
  }

  /** The host session ids named by a task's ops. */
  sessionIdsForTask(taskId: number): string[] {
    const ids = new Set<string>();
    for (const r of this.#db.prepare("SELECT args_json FROM ops WHERE task_id = ?").all(taskId) as Array<{ args_json: string }>) {
      try {
        const a = JSON.parse(r.args_json) as Record<string, unknown>;
        const sid = a._truncated === true ? /"session_id":"([^"]+)"/.exec(typeof a.preview === "string" ? a.preview : "")?.[1] : a.session_id;
        if (typeof sid === "string") ids.add(sid);
      } catch {
        // skip
      }
    }
    return [...ids];
  }

  /**
   * Whether the task's session ran `cocheck track stop` and has done nothing since: its newest op, leaving out ops written on its behalf
   * by other events (words found late, another session's call, a drop note), is the stop mark.
   */
  trackingStoppedLast(taskId: number): boolean {
    const r = this.#db
      .prepare(
        `SELECT json_extract(args_json, '$.hookEvent') AS e FROM ops WHERE task_id = ?
           AND COALESCE(json_extract(args_json, '$.hookEvent'), '') NOT IN ('LateNarration', 'OtherSessionCall', 'Dropped') ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId) as { e: unknown } | undefined;
    return r?.e === "TrackingStopped";
  }

  /** The first request the person typed in a task (a recorded UserPromptSubmit, a wake notification skipped), as typed; undefined when none is recorded. */
  firstPromptForTask(taskId: number): string | undefined {
    const rows = this.#db.prepare("SELECT args_json FROM ops WHERE task_id = ? AND instr(args_json, 'UserPromptSubmit') > 0 ORDER BY id").all(taskId) as Array<{ args_json: string }>;
    for (const r of rows) {
      try {
        const a = JSON.parse(r.args_json) as Record<string, unknown>;
        if (a.hookEvent !== "UserPromptSubmit" || !Array.isArray(a.prompts)) continue;
        const typed = a.prompts.find((p) => typeof p === "string" && p.trim() !== "" && !p.startsWith("<task-notification>"));
        if (typeof typed === "string") return typed;
      } catch {
        // not JSON: no prompt to name
      }
    }
    return undefined;
  }

  /** Rewrites the session's coverage row (a Stop reconciles the whole session again, so the row is replaced). */
  saveSessionCoverage(row: SessionCoverageRow): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO session_coverage (session_id, host, checked_at, status, reason, events, ops, calls, lost, failed, no_event, unmatched, unattributed, names_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.sessionId, row.host, row.checkedAt, row.status, row.reason, row.events, row.ops, row.calls, row.lost, row.failed, row.noEvent, row.unmatched, row.unattributed, JSON.stringify({ ...row.names, expiredCount: row.expired }));
  }

  sessionCoverage(sessionId: string): SessionCoverageRow | null {
    const r = this.#db.prepare("SELECT * FROM session_coverage WHERE session_id = ?").get(sessionId) as Record<string, any> | undefined;
    return r === undefined ? null : coverageRowOf(r);
  }

  /** Records exactly one row in `ops` for a single write-tool call. Returns the new row id. */
  recordOp(input: RecordOpInput): number {
    // The one path every call's text takes into the ledger (hook calls of every host, CoCheck's own tools): a value the secret detector
    // finds is masked before it is written, in the args (every string in them), the intent and the error text.
    input = { ...input, intent: redactSecrets(input.intent), ...(input.errorText != null ? { errorText: redactSecrets(input.errorText) } : {}) };
    const stmt = this.#db.prepare(
      `INSERT INTO ops
        (task_id, ts, tool, args_json, intent, client_name, client_version, duration_ms,
         result_code, error_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      input.taskId ?? null,
      new Date().toISOString(),
      input.tool,
      storedArgsJson(input.args),
      input.intent,
      input.clientName != null ? truncateChars(input.clientName, MAX_CLIENT_NAME_CHARS) : null,
      input.clientVersion != null
        ? truncateChars(input.clientVersion, MAX_CLIENT_VERSION_CHARS)
        : null,
      input.durationMs,
      input.resultCode,
      input.errorText != null ? truncateUtf8Bytes(input.errorText, MAX_ERROR_TEXT_BYTES) : null,
    );
    return Number(result.lastInsertRowid);
  }

  close(): void {
    this.#db.close();
  }

  /**
   * Executes raw SQL directly against this ledger's own connection. Exists only so tests can
   * attempt tamper writes (e.g. `INSERT OR REPLACE`) against the exact connection the server
   * uses - `recursive_triggers` is a per-connection setting, so testing the guard requires
   * this connection specifically, not a fresh one opened on the same file. Not called from any
   * production code path.
   */
  execForTest(sql: string): void {
    this.#db.exec(sql);
  }
}

export type CaptureOutcomeKind = "recorded" | "unchanged" | "no-before" | "no-connector" | "no-window" | "rejected" | "error";
export interface CaptureOutcomeRow { id: number; taskId: number | null; ts: string; client: string; call: string; subject: string; outcome: CaptureOutcomeKind; reason: string }
function captureOutcomeRow(r: Record<string, unknown>): CaptureOutcomeRow {
  return { id: Number(r.id), taskId: r.task_id == null ? null : Number(r.task_id), ts: String(r.ts), client: String(r.client), call: String(r.call_id), subject: String(r.subject), outcome: String(r.outcome) as CaptureOutcomeKind, reason: String(r.reason) };
}

function signoffRow(r: Record<string, unknown>): SignoffRow {
  return {
    id: Number(r.id),
    taskId: Number(r.task_id),
    signer: String(r.signer),
    ts: String(r.ts),
    rounds: Number(r.rounds),
    rejections: JSON.parse(String(r.rejections_json)) as SignoffRow["rejections"],
    files: JSON.parse(String(r.files_json)) as SignedFile[],
    leftOut: r.left_out_json == null ? null : (JSON.parse(String(r.left_out_json)) as LeftOutFile[]),
    closedTask: Number(r.closed_task ?? 0) === 1,
    signature: r.signature == null ? null : String(r.signature),
  };
}

function requestRow(r: Record<string, unknown>): RequestRow {
  return {
    id: Number(r.id),
    taskId: Number(r.task_id),
    note: String(r.note),
    reviewer: String(r.reviewer),
    afterOpId: Number(r.after_op_id),
    ts: String(r.ts),
  };
}

interface RecordStepInput {
  taskId: number;
  client: string;
  /** The adapter's own counter: the idempotency key of the write, not the step's identity. */
  seq: number;
  phase: "Pre" | "Post" | "Stop";
  /** The tool_use_ids open at the sweep: context, not credit. */
  callsOpen: string[];
  /** The tool_use_ids the sweep's change was credited to. */
  credited: string[];
  /** `credited`: the calls this file's change is credited to; absent, the step's. */
  files: Array<{ filePath: string; sha256: string; prevSha256: string | null; size: number; kept: "whole" | "hash" | "gone"; note: string; credited?: string[]; mtimeNs?: string; creditBasis?: ProofMethod; /** The connector id when `filePath` is that connector's URI subject; absent for a built-in file. */ connector?: string; /** The connector's version and spec identifier when the row was captured, and the sha256 of the sealed change list it served then (absent when none was kept). */ connectorVersion?: string; connectorSpec?: string; changesSha256?: string; /** The change list is read later by the review process (a 'pending' capture row is written with the row). */ capturePending?: boolean; /** The row has no before state because the connector declared the call creates its item, not because anything was read. */ beforeBasis?: "declared" }>;
}

interface StepRow {
  id: number;
  taskId: number;
  client: string;
  seq: number;
  phase: "Pre" | "Post" | "Stop";
  ts: string;
  /** Open at the sweep: context, not credit. */
  callsOpen: string[];
  /** Credited with the sweep's change. */
  credited: string[];
}

export interface FileStateRow {
  id: number;
  stepId: number;
  taskId: number;
  filePath: string;
  sha256: string;
  prevSha256: string | null;
  phase: "Pre" | "Post" | "Stop";
  /** Open at the sweep: context, not credit. */
  callsOpen: string[];
  /** Credited with this change. A call can be open and not credited (a change found with no owner). */
  credited: string[];
  size: number;
  kept: "whole" | "hash" | "gone";
  note: string;
  /** The file's modification time at the sweep, in ns; null on a deleted file. */
  mtimeNs: string | null;
  /** What the credit stands on; null when no basis was recorded. */
  creditBasis: ProofMethod | null;
  /** The connector id when `filePath` is a URI subject; null for a built-in file. */
  connector: string | null;
  /** What the connector was when this row was captured; null on a built-in file row. */
  connectorVersion: string | null;
  connectorSpec: string | null;
  /** The sha256 of the sealed change list as served at capture (the frozen list); null when none was kept. */
  changesSha256: string | null;
  /** Where reading the change list stands for a row the review process reads after the hook: pending, captured or failed; null for any other row. */
  capture?: "pending" | "captured" | "failed" | null;
  /** Why the read failed, when `capture` is failed: CoCheck's own wording, kept for good. */
  captureReason?: string | null;
  /** What the connector said when it failed (secret-scanned); null once the task's values expired. */
  captureDetail?: string | null;
  /** How many "ask again" answers the connector gave for this row so far. */
  captureTries?: number;
  /** While the capture is pending, the hash of the latest "ask again" answer (sealed in the change store); null otherwise. */
  captureTrySha?: string | null;
  /** "declared" when the missing before state is the connector's declaration that the call created the item (no read); null otherwise. */
  beforeBasis?: "declared" | null;
}

/** The 6-character [a-z0-9] tag of one send-back's follow-up marker; random per send-back. */
export function newSendBackNonce(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/**
 * Opens (creating if needed) the ledger database at `$COCHECK_HOME/ledger.sqlite`, applying
 * the schema (tables + append-only triggers) and enabling WAL mode. A write that meets another
 * connection's write lock waits up to `busyTimeoutMs` first. Refuses a db whose schema version is
 * not this build's `SCHEMA_VERSION`, before touching it.
 */
export function openLedger(home: string = resolveCoCheckHome(), busyTimeoutMs = 2000): Ledger {
  mkdirSync(home, { recursive: true });
  // Before the first data file opens: a Windows home can hold files with an empty ACL, and the open below would throw EPERM.
  // Windows does the pass once per home (a marker). Mac runs the same chmod here and again after the open.
  hardenHomeAndSay(home, false);
  const dbPath = path.join(home, "ledger.sqlite");
  const db = new DatabaseSync(dbPath);
  // The busy timeout comes before anything else touches the file: two processes creating a fresh
  // ledger at once (the gateway and the review process on a first run) must queue, not fail.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  // Switching to WAL needs a lock the busy handler does not always cover on a brand-new file.
  const deadline = Date.now() + busyTimeoutMs;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      break;
    } catch (error) {
      if (Date.now() >= deadline || !/database is locked|SQLITE_BUSY/i.test(String((error as Error).message))) {
        db.close();
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  // recursive_triggers is per-connection, not persisted with the schema. Without it, SQLite's
  // REPLACE conflict resolution (INSERT OR REPLACE / REPLACE INTO) deletes the pre-existing row
  // out from under the append-only DELETE triggers below without firing them - silently
  // defeating the tamper guard for any writer sharing this connection.
  db.exec("PRAGMA recursive_triggers = ON;");
  // IMMEDIATE takes the write lock up front (waiting on the busy timeout), so the version read
  // and the schema creation below are one step another opener cannot interleave with.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_VERSION_TABLE);
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as {
      version: number | null;
    };
    const current = row.version;
    if (current !== null && current !== SCHEMA_VERSION) {
      throw new Error(
        `ledger schema version ${current} is not the version this build uses (${SCHEMA_VERSION}); this build does not migrate a ledger of that version, so it refuses to open ${dbPath}. Use a new data home.`,
      );
    }
    db.exec(SCHEMA);
    if (current === null) {
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the transaction never began
    }
    db.close();
    throw error;
  }

  // The ledger and its WAL and SHM files exist by now. On Mac they are chmodded here; Windows files inherit from the hardened folder.
  hardenHomeAndSay(home, false);
  return new Ledger(db, home);
}
