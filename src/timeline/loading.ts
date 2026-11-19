/**
 * The one CoCheck loading widget. Every place on the review page and the timeline page that is still waiting for something
 * draws this, never its own text: the CoCheck icon playing its two Lottie loaders in turn, and the words of what is loading for a
 * screen reader (and on hover). A state that has finished or failed is never this widget; it is words.
 *
 * The icon is an SVG rig, one <g> per factor of the transform (see scripts/loader-css.mjs), transparent: the magnifier without the app
 * icon's navy tile, stroked in the page's ink. With no animation it rests in the icon's own pose (assets/cocheck-icon.svg), so reduced
 * motion and a page without the keyframes show the same mark, still. The keyframes are made
 * (and the stroke rules) from assets/loaders/loader-orbit.json and loader-spin.json by `node scripts/loader-css.mjs` and pasted below; a test checks they match.
 *
 * The markup has two builders that must stay alike: `loadingHtml` here for the server-built pages, and `CoCheckViewTable.loader` in
 * rail/assets/view-table.js for the page script. The CSS is `LOADING_CSS`; review.css carries the same rules verbatim (a test pins it).
 */


import { escapeHtml as esc } from "../html.ts";

/** The icon rig; nesting is transform order: translate(P) rotate(R) translate(D) rotate(-R) scale(S), the handle adds its own turn H. */
const MARK = `<svg class="iload-mark" viewBox="0 0 128 128" aria-hidden="true" focusable="false"><g class="ild-p"><g class="ild-r"><g class="ild-d"><g class="ild-c"><g class="ild-s"><g transform="translate(-41 -41)"><circle class="ild-rim" cx="41" cy="41" r="34"></circle><path class="ild-glint" d="M22 33A21 21 0 0 1 33 22"></path></g><g class="ild-h"><g transform="translate(-41 -41)"><path class="ild-neck" d="M69 69L80 80"></path><path class="ild-grip" d="M83 83L100 100"></path></g></g></g></g></g></g></g></svg>`;

/** The widget for `label`, which names what is loading ("Drawing the preview of this change"). */
export function loadingHtml(label: string): string {
  const l = esc(label);
  return `<span class="iload" role="status" title="${l}">${MARK}<span class="iload-sr">${l}</span></span>`;
}

/** The widget's styles. Inline it is a 24px icon beside text; in a loading pane (`.loadpane`, the before and after pictures) it is 72px,
 *  where the orbit loader's small circling reads (inline it is a soft drift between the spins). With animation off the rig rests at the
 *  icon's own pose, so a page's own reduced-motion rule is all it takes; review.css has one (its last rule), the timeline page adds LOADING_MOTION_CSS. */
export const LOADING_CSS = `.iload{display:inline-flex;align-items:center;vertical-align:middle;padding:2px 0}
.iload-mark{display:block;width:24px;height:24px;overflow:visible}
.loadpane .iload-mark{width:72px;height:72px}
.ild-p{transform:translate(54.7px,52.7px)}
.ild-s{transform:scale(.7)}
.ild-rim{fill:none;stroke:var(--ink,#1c2740);stroke-width:14;stroke-linecap:round}
.ild-glint{fill:none;stroke:var(--sky-deep,#4f86b0);stroke-width:7;stroke-linecap:round}
.ild-neck{fill:none;stroke:var(--ink,#1c2740);stroke-width:11;stroke-linecap:butt}
.ild-grip{fill:none;stroke:var(--ink,#1c2740);stroke-width:22;stroke-linecap:round}
.iload-mark .ild-p{animation:ild-p 10.4s infinite}
@keyframes ild-p{0%{transform:translate(54.7px,52.7px);animation-timing-function:cubic-bezier(.4,0,.2,1)}1.923%{transform:translate(54.7px,52.7px);animation-timing-function:cubic-bezier(.4,0,.2,1)}6.41%{transform:translate(64px,64px);animation-timing-function:cubic-bezier(.4,0,.2,1)}19.872%{transform:translate(64px,64px);animation-timing-function:cubic-bezier(.4,0,.2,1)}24.359%{transform:translate(54.7px,52.7px);animation-timing-function:cubic-bezier(.4,0,.2,1)}26.923%{transform:translate(54.7px,52.7px);animation-timing-function:linear}42.308%{transform:translate(54.7px,52.7px);animation-timing-function:cubic-bezier(.4,0,.2,1)}44.231%{transform:translate(54.7px,52.7px);animation-timing-function:cubic-bezier(.4,0,.2,1)}48.718%{transform:translate(64px,64px);animation-timing-function:cubic-bezier(.4,0,.2,1)}62.179%{transform:translate(64px,64px);animation-timing-function:cubic-bezier(.4,0,.2,1)}66.667%{transform:translate(54.7px,52.7px);animation-timing-function:cubic-bezier(.4,0,.2,1)}69.231%{transform:translate(54.7px,52.7px);animation-timing-function:linear}84.615%{transform:translate(54.7px,52.7px);animation-timing-function:linear}100%{transform:translate(54.7px,52.7px);animation-timing-function:linear}}
.iload-mark .ild-r{animation:ild-r 10.4s infinite}
@keyframes ild-r{0%{transform:rotate(0deg);animation-timing-function:linear}26.923%{transform:rotate(0deg);animation-timing-function:cubic-bezier(.167,.167,.833,.833)}42.308%{transform:rotate(360deg);animation-timing-function:linear}69.231%{transform:rotate(360deg);animation-timing-function:cubic-bezier(.167,.167,.833,.833)}84.615%{transform:rotate(720deg);animation-timing-function:cubic-bezier(.167,.167,.833,.833)}100%{transform:rotate(1080deg);animation-timing-function:linear}}
.iload-mark .ild-d{animation:ild-d 10.4s infinite}
@keyframes ild-d{0%{transform:translate(5px,0px);animation-timing-function:cubic-bezier(.4,0,.2,1)}1.923%{transform:translate(0px,0px);animation-timing-function:linear}24.359%{transform:translate(0px,0px);animation-timing-function:cubic-bezier(.4,0,.2,1)}26.923%{transform:translate(5px,0px);animation-timing-function:linear}42.308%{transform:translate(5px,0px);animation-timing-function:cubic-bezier(.4,0,.2,1)}44.231%{transform:translate(0px,0px);animation-timing-function:linear}66.667%{transform:translate(0px,0px);animation-timing-function:cubic-bezier(.4,0,.2,1)}69.231%{transform:translate(5px,0px);animation-timing-function:linear}84.615%{transform:translate(5px,0px);animation-timing-function:linear}100%{transform:translate(5px,0px);animation-timing-function:linear}}
.iload-mark .ild-c{animation:ild-c 10.4s infinite}
@keyframes ild-c{0%{transform:rotate(0deg);animation-timing-function:linear}26.923%{transform:rotate(0deg);animation-timing-function:cubic-bezier(.167,.167,.833,.833)}42.308%{transform:rotate(-360deg);animation-timing-function:linear}69.231%{transform:rotate(-360deg);animation-timing-function:cubic-bezier(.167,.167,.833,.833)}84.615%{transform:rotate(-720deg);animation-timing-function:cubic-bezier(.167,.167,.833,.833)}100%{transform:rotate(-1080deg);animation-timing-function:linear}}
.iload-mark .ild-s{animation:ild-s 10.4s infinite}
@keyframes ild-s{0%{transform:scale(.7);animation-timing-function:cubic-bezier(.4,0,.2,1)}1.923%{transform:scale(.7);animation-timing-function:cubic-bezier(.4,0,.2,1)}6.41%{transform:scale(.62);animation-timing-function:cubic-bezier(.4,0,.2,1)}19.872%{transform:scale(.62);animation-timing-function:cubic-bezier(.4,0,.2,1)}24.359%{transform:scale(.7);animation-timing-function:cubic-bezier(.4,0,.2,1)}26.923%{transform:scale(.7);animation-timing-function:linear}42.308%{transform:scale(.7);animation-timing-function:cubic-bezier(.4,0,.2,1)}44.231%{transform:scale(.7);animation-timing-function:cubic-bezier(.4,0,.2,1)}48.718%{transform:scale(.62);animation-timing-function:cubic-bezier(.4,0,.2,1)}62.179%{transform:scale(.62);animation-timing-function:cubic-bezier(.4,0,.2,1)}66.667%{transform:scale(.7);animation-timing-function:cubic-bezier(.4,0,.2,1)}69.231%{transform:scale(.7);animation-timing-function:linear}84.615%{transform:scale(.7);animation-timing-function:linear}100%{transform:scale(.7);animation-timing-function:linear}}
.iload-mark .ild-h{animation:ild-h 10.4s infinite}
@keyframes ild-h{0%{transform:rotate(0deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}6.41%{transform:rotate(0deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}19.872%{transform:rotate(360deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}26.923%{transform:rotate(360deg);animation-timing-function:linear}42.308%{transform:rotate(360deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}48.718%{transform:rotate(360deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}62.179%{transform:rotate(720deg);animation-timing-function:cubic-bezier(.5,0,.5,1)}69.231%{transform:rotate(720deg);animation-timing-function:linear}84.615%{transform:rotate(720deg);animation-timing-function:linear}100%{transform:rotate(720deg);animation-timing-function:linear}}
.iload-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.loadpane{display:flex;align-items:center;justify-content:center;min-height:120px;padding:20px 16px}`;

/** Reduced motion for a page that has no rule of its own: the icon holds still. */
export const LOADING_MOTION_CSS = `@media (prefers-reduced-motion:reduce){.iload-mark *{animation:none!important}}`;
