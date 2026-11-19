import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadingHtml } from "../loading.ts";

/**
 * The g-rail review page: a static shell, a script and a stylesheet served same-origin, and a model route the script fills
 * itself from. No inline script, no external font or CDN. The shell holds the task number and nothing else from the record.
 */

const ASSET_DIR = new URL("./assets/", import.meta.url);

/** The only files the asset route serves, by name. A name not in this table is a 404; nothing here is built from a request path. */
export const ASSETS: Readonly<Record<string, string>> = {
  "review.js": "text/javascript; charset=utf-8",
  "view-table.js": "text/javascript; charset=utf-8",
  "files-view.js": "text/javascript; charset=utf-8",
  "review.css": "text/css; charset=utf-8",
  "cocheck-icon.svg": "image/svg+xml",
};

export async function readAsset(name: string): Promise<{ body: Buffer; type: string } | undefined> {
  if (!Object.prototype.hasOwnProperty.call(ASSETS, name)) return undefined;
  return { body: await readFile(new URL(name, ASSET_DIR)), type: ASSETS[name]! };
}

/**
 * the design tokens, as the review stylesheet declares them, for a page that cannot link the stylesheet (the home page, whose CSP allows
 * inline styles only). One source: everything in review.css above its "end of tokens" line.
 */
let tokensCache: string | undefined;
export function designTokensCss(): string {
  if (tokensCache !== undefined) return tokensCache;
  const css = readFileSync(new URL("review.css", ASSET_DIR), "utf8");
  const end = css.indexOf("/* end of tokens");
  if (end < 0) throw new Error("review.css lost its end-of-tokens marker");
  return (tokensCache = css.slice(0, end));
}

/**
 * a person who lands on a refused or missing page in a browser gets a plain page in the review page's own type and colours,
 * one sentence of what happened and the one thing that fixes it, never raw JSON. `lines` are plain text (escaped here); `code` marks one command.
 */
export function renderErrorPage(title: string, line: string, code?: string): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = code === undefined || !line.includes(code) ? esc(line) : line.split(code).map(esc).join(`<code>${esc(code)}</code>`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CoCheck: ${esc(title)}</title><style>${designTokensCss()}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--canvas);color:var(--ink);font:var(--fs-body)/var(--lh-body) var(--font)}
main{max-width:30em;padding:var(--s6) var(--s5);text-align:center}
h1{margin:0 0 var(--s2);font-size:var(--fs-title);line-height:var(--lh-title);font-weight:var(--w-semi)}
p{margin:0;font-size:var(--fs-read);line-height:var(--lh-read);color:var(--ink-2)}
code{font:var(--fs-mono)/var(--lh-mono) var(--mono);padding:2px var(--s1);border-radius:var(--r-sm);background:var(--well);color:var(--ink)}
</style></head><body><main><h1>${esc(title)}</h1><p>${body}</p></main></body></html>
`;
}

export const REVIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The page's CSP with `frame-src` for exactly the connector view origin; without one, the page has no frame-src and default-src 'none' blocks frames. */
export function reviewCsp(viewOrigin?: string): string {
  return viewOrigin === undefined ? REVIEW_CSP : `${REVIEW_CSP}; frame-src ${viewOrigin}`;
}

/** The verdict buttons' marks, the same tick and cross the mock draws. */
const ICON_PASS = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_FAIL = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

export function renderReviewShell(taskId: number, notRecording?: string): string {
  // When the hook cannot record, one line above the header says so with the reason.
  const banner = notRecording === undefined ? "" : `\n<p role="alert" id="notrecording" class="notrec">CoCheck is not recording: ${notRecording.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CoCheck: review the work</title>
<link rel="icon" type="image/svg+xml" href="/timeline-assets/cocheck-icon.svg">
<link rel="stylesheet" href="/timeline-assets/review.css">
</head>
<body data-task="${Number(taskId)}">${banner}
<p id="livebanner" class="livebanner" role="status" hidden>Agent still working</p>
<header>
  <a class="wordmark" id="homelink" href="/" aria-label="CoCheck home" title="CoCheck home"><span class="wm-co" aria-hidden="true">C</span><svg viewBox="-8 -8 112 120" aria-hidden="true" focusable="false"><circle class="wm-rim" cx="41" cy="41" r="34" stroke-width="14"/><path class="wm-glint" d="M22 33 A21 21 0 0 1 33 22" stroke-width="7"/><path class="wm-hand" d="M69 69 L80 80" stroke-width="11" stroke-linecap="butt"/><path class="wm-hand" d="M83 83 L100 100" stroke-width="22"/></svg><span class="wm-ck" aria-hidden="true">Check</span></a>
  <button type="button" class="railtoggle" id="railtoggle" aria-label="Show steps" title="Show steps" aria-expanded="false" aria-controls="railcol"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M9.5 5v14"/></svg></button>
  <div class="task"><b id="taskname">Task ${Number(taskId)}</b><span id="subh"></span><span id="followline" class="followline" hidden></span></div>
  <div class="viewswitch" id="viewswitch" role="group" aria-label="View" hidden><button type="button" id="vfiles" aria-pressed="true">Deliverables</button><button type="button" id="vsteps" aria-pressed="false">Timeline</button></div>
  <div class="progress" id="progress" hidden><svg class="ring" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle class="rtrack" cx="8" cy="8" r="6" pathLength="100"/><circle class="rfill" id="progring" cx="8" cy="8" r="6" pathLength="100"/></svg><span id="progtext" aria-live="polite"></span></div>
  <div class="taskbtns" id="taskbar" hidden>
    <button type="button" class="btn" id="sendback" disabled>Send back to agent<span class="count" id="failcount" hidden></span></button>
    <button type="button" class="btn primary" id="submit" disabled>Sign off</button>
    <div class="tpanel" id="sbout" hidden><label for="sbtext">Copy this into your agent.</label><textarea id="sbtext" rows="10"></textarea><p class="sbmarker" id="sbmarker"></p><div class="row-end"><button type="button" class="btn" id="sbcopy">Copy</button><button type="button" class="btn" id="sbclose">Done</button></div></div>
    <p class="barmsg" role="status"><span id="sbmsg"></span><span id="submsg"></span><span id="subleft"></span></p>
  </div>
  <div class="setwrap" id="setwrap"><button type="button" class="pbset" id="setbtn" aria-label="Settings" title="Settings" aria-haspopup="true" aria-expanded="false" aria-controls="setmenu"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg></button><div class="setmenu" id="setmenu" role="group" aria-label="Settings" hidden><span class="setgroup" role="group" aria-label="Colour theme"><button type="button" class="setopt" id="themelight" aria-pressed="false">Light</button><button type="button" class="setopt" id="themedark" aria-pressed="false">Dark</button><button type="button" class="setopt" id="themeauto" aria-pressed="true" title="Follow the system's light or dark setting">Match System</button></span><button type="button" class="setopt" id="quietbtn" aria-pressed="true" title="Hide the rows for commands that ran but changed no file">Hide Background Commands</button><button type="button" class="setopt" id="railorder" aria-pressed="false" title="Show the newest steps at the top">Newest First</button><button type="button" class="setopt" id="cleanbtn" aria-pressed="false" title="Hide the notes, the lines to them and the boxes, and see the plain diff" hidden>Clean Diff</button></div></div>
</header>
<div class="body">
  <aside class="listcol" id="listcol" hidden><nav class="list" id="fileslist" aria-label="Files this task changed"></nav></aside>
  <aside class="railcol" id="railcol"><nav class="rail" aria-label="What happened, in order">
    <div class="legend" id="legend"></div>
    <div class="scroller" id="scroller"><div class="tl" id="tl"></div></div>
  </nav></aside>
  <main class="main">
    <p class="hint" id="nofiles" hidden>No files were changed in this session.</p>
    <div class="filesview" id="filesview" hidden>
      <div class="crumbs" id="fvcrumbs" aria-label="Where you came from"></div>
      <div class="fhead"><h1 id="fvname"></h1><div class="order" id="fvorder"></div></div>
      <div class="strip" id="strip" role="listbox" aria-label="Versions, oldest first"></div>
      <div class="built" id="fvbuilt"></div>
      <div class="stalewarn" id="fvwarn"></div>
    </div>
    <div class="head" id="head">
      <div class="stephead"><span id="hchip" class="hchip"></span><h1 id="h1">${loadingHtml("Reading the work")}</h1><span id="hsign" class="hsign" hidden></span><button type="button" class="hpill" id="hissues" aria-controls="detpanel" title="Show the issues in Details" hidden></button>
      </div>
      <div class="hsub"><span id="hinferred" class="hinferred" hidden>Likely</span><div class="hcalls calls" id="hcalls" hidden></div></div>
      <p class="fact" id="hfact" hidden></p>
      <p class="fact" id="hwho" hidden></p>
      <button type="button" class="vsaved" id="vstat" hidden></button>
      <p class="vmsg" id="vmsg" role="status"></p>
      <p class="ai" id="h2"></p><p class="ptag" id="ptag" hidden></p>
      <details class="vhist" id="vhist" hidden><summary id="vhistsum">History</summary><ol id="vhistlist"></ol></details>
    </div>
    <div class="reqview" id="reqview" hidden><div class="msg ask"><p class="to"><i class="mdot"></i><b class="mname">You</b></p><div class="reqtext mcard" id="reqtext"></div></div></div>
    <div class="hdrbody" id="hdrbody" hidden><p class="callfail" id="callfail" hidden></p><div class="hfiles" id="hdrview"></div></div>
    <div class="finding" id="finding" role="status" hidden></div>
    <div class="extras" id="extras" hidden></div>
    <div class="stepbody" id="bodyview" hidden></div>
    <div class="banner" id="banner" role="status" hidden></div>
    <div class="viewline" id="viewline" role="status" hidden></div>
    <!-- Above the stage, not after it: the stage is as tall as its notes column, which pushed these buttons a screen below a short grid. -->
    <div class="stage" id="stage">
      <div><div class="panelabel b"><span class="side" id="lsb">Before</span><span class="plname" id="lnb" hidden></span><span class="plpos" id="lpb"></span></div><div class="closeup before" id="cub" hidden></div><div class="pane before" id="pb"><div class="tabs" id="tb"></div><div class="tree" id="trb" hidden></div><div class="vw" id="vb"></div></div><div class="pstrip" id="stb" hidden></div></div>
      <div><div class="panelabel a"><span class="side" id="lsa">After</span><span class="plname" id="lna" hidden></span><span class="plpos" id="lpa"></span><span class="zoomctl" id="zoomctl" role="group" aria-label="Zoom" hidden><button type="button" data-zoom="fit" aria-pressed="false">Fit width</button><button type="button" data-zoom="100" aria-pressed="false">100%</button><button type="button" data-zoom="200" aria-pressed="false">200%</button></span></div><div class="closeup after" id="cua" hidden></div><div class="pane after" id="pa"><div class="tabs" id="ta"></div><div class="tree" id="tra" hidden></div><div class="vw" id="va"></div></div><div class="pstrip" id="sta" hidden></div></div>
      <div class="notes" id="notes"></div>
      <svg class="leaders" id="svg" aria-hidden="true"></svg>
      <div class="nmarks" id="nmarks"></div>
    </div>
    <div class="below" id="below" hidden><details class="about" id="about" hidden><summary>About this view</summary><p class="caveats" id="caveats"></p></details></div>
  </main>
</div>
<div class="pbar" id="pbar" role="group" aria-label="Review" hidden>
  <div class="detpanel" id="detpanel" role="dialog" aria-labelledby="dettitle" tabindex="-1" hidden><div class="dethead"><h2 id="dettitle">Details</h2><button type="button" class="btn detcopy" id="detcopy">Copy all</button><button type="button" class="detclose" id="detclose" aria-label="Close details" title="Close (Esc)"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div><div class="detissues" id="detissues" role="group" aria-label="Issues" tabindex="-1" hidden></div><div class="detlist" id="detlist"></div></div>
  <div class="pnotes" id="pnotes" hidden></div>
  <div class="pcomp ncomp" id="ncomp" hidden><label for="nnote" id="nlabel">Sticky note</label><textarea id="nnote" rows="3" maxlength="2000" placeholder="With no spot marked and no text selected, this note is on the whole task."></textarea><div class="rrow"><div class="regtool" role="group" aria-label="Point at a spot" aria-describedby="nrtip"><button type="button" id="nregbox" aria-pressed="true">Box</button><button type="button" id="nregfree" aria-pressed="false">Freehand</button><span class="tip" role="tooltip" id="nrtip">Mark a spot with a box or freehand.</span></div></div><div class="rchips" id="nchips"></div><div class="acts"><button type="button" class="btn" id="ngo" aria-describedby="ngotip">Save</button><span class="tip" role="tooltip" id="ngotip">Save the sticky note</span><button type="button" class="btn" id="nno" aria-describedby="nnotip">Cancel</button><span class="tip" role="tooltip" id="nnotip">Close without saving</span></div></div>
  <div class="pcomp" id="pcomp" hidden><label for="vnote">What’s wrong?</label><textarea id="vnote" rows="3" maxlength="2000"></textarea><div class="rrow"><div class="regtool" role="group" aria-label="Point at a spot" aria-describedby="rtip"><button type="button" id="regbox" aria-pressed="true">Box</button><button type="button" id="regfree" aria-pressed="false">Freehand</button><span class="tip" role="tooltip" id="rtip">Mark a spot with a box or freehand.</span></div></div><div class="rchips" id="vchips"></div><div class="acts"><button type="button" class="btn" id="vfailgo" aria-keyshortcuts="Enter" aria-describedby="vgotip">Save</button><span class="tip" role="tooltip" id="vgotip">Save with Enter</span><button type="button" class="btn" id="vfailno" aria-keyshortcuts="Escape" aria-describedby="vnotip">Cancel</button><span class="tip" role="tooltip" id="vnotip">Cancel with Esc</span></div></div>
  <div class="prow">
  <button type="button" class="pbstep" id="pbprev" aria-label="Previous step" title="Previous step"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6"/></svg></button><span class="pbpos" id="pbpos" aria-live="polite"></span><button type="button" class="pbstep" id="pbnext" aria-label="Next step" title="Next step"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg></button>
  <span class="pblabel" id="pblabel"></span><span class="pbmsg" id="pbmsg" role="status"></span>
  <button type="button" class="btn" id="pbnote" title="Highlight a spot and leave a sticky note"><svg class="noteic" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 4.5h14v10l-5 5H5zM14 19.5v-5h5"/></svg><span class="pbnotetxt">Note</span><span class="count" id="pbncount" hidden></span></button>
  <button type="button" class="btn pbdet" id="pbdetails" title="Details: how each step was drawn" aria-label="Details" aria-haspopup="dialog" aria-expanded="false" aria-controls="detpanel"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg><span class="dcount" id="pbdcount" hidden></span></button>
  <span class="vpair" id="pbverdict" role="group" aria-label="Verdict"><button type="button" class="vf" id="pbfail" aria-pressed="false" aria-keyshortcuts="F">${ICON_FAIL}Fail <kbd>F</kbd></button><button type="button" class="vp" id="pbpass" aria-pressed="false" aria-keyshortcuts="P">${ICON_PASS}Pass <kbd>P</kbd></button></span>
  <button type="button" class="btn primary" id="pbact" hidden></button>
  </div>
</div>
<div class="toast" id="toast" role="status" hidden><span id="toasttext"></span><button type="button" id="undo">Undo <kbd>U</kbd></button></div>
<dialog id="subdlg" aria-labelledby="subdlgtitle">
  <h2 id="subdlgtitle">Sign off with steps not looked at?</h2>
  <p id="subdlgtext"></p>
  <div class="acts"><button type="button" class="btn" id="subcancel">Keep reviewing</button><button type="button" class="btn primary" id="subgo">Sign off</button></div>
</dialog>
<dialog id="sbdlg" aria-labelledby="sbdlgtitle" aria-describedby="sbdlgtext">
  <h2 id="sbdlgtitle">What goes back to the agent?</h2>
  <p id="sbdlgtext"></p>
  <div class="sbchoice" role="radiogroup" aria-labelledby="sbdlgtitle">
    <label><input type="radio" name="sbwhat" id="sbwithnotes" value="notes" checked><span><b>Review comments and sticky notes</b><small>Each failed step with its note and marked spots, and every sticky note.</small></span></label>
    <label><input type="radio" name="sbwhat" id="sbcommentsonly" value="comments"><span><b>Review comments only</b><small>Each failed step with its note and marked spots. The sticky notes stay here and are not sent.</small></span></label>
  </div>
  <div class="acts"><button type="button" class="btn" id="sbdlgcancel" aria-keyshortcuts="Escape">Cancel</button><button type="button" class="btn primary" id="sbdlggo" aria-keyshortcuts="Enter">Send back</button></div>
</dialog>
<script src="/timeline-assets/view-table.js"></script>
<script src="/timeline-assets/files-view.js"></script>
<script src="/timeline-assets/review.js"></script>
</body>
</html>
`;
}
