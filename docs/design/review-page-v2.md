# Review page v2: the decluttered page

The design the review page v2 build follows. The mock is `review-page-v2-mock.html` in this folder, drawn on the rail design tokens with content from a recorded test run. Numbers in brackets are review points from that run.

One rule runs through every decision [6]: the page spends boldness in two places only, the change being reviewed (pink boxes) and the verdict. Everything else is quiet, and a line that restates another line is cut.

## The page

The page opens on the first step that still needs a verdict: the call header if the change sits under one, otherwise the change. On a resumed task that is the first one after the last verdict. A `#n` in the URL wins. There is no start page and no start stop [1]. The rail keeps the origin diamond at its top, as a marker only: it is not a row you can select.

The task bar lives in the top header, on one row with the wordmark [1, 6]. Left to right: the task name and folder, then progress ("9 of 29 changes reviewed" over a thin bar), then Note, Send back and Submit. Note opens a small panel with the overall note; the button shows a dot when the note has text. Send back is enabled once a change is failed or the note has text, and shows the count of failed changes. Submit is the one filled button on the page. If changes are still unreviewed, Submit asks once in a dialog that names the count. Nothing from this bar repeats on a step.

## Every step has the same frame

A heading of one line: actor chip, plain verb, file name (the full path is on hover). Then one AI line of at most two sentences [10]. Then the body for the step type. The verdict control sits at the right end of the heading row, so attention lands on the heading and the verdict first [3, 6].

The text budget per step is: one heading, one AI line, one notes column, the limits of the view behind one disclosure ("About this view", closed), and the engine line printed once under both panes ("Drawn by CoCheck from the cells, not by Excel."). No subtitle, no card sentence that repeats the heading, no "Asked:" block (the request is its own step), no pane captions ("just before this moment").

## Layout per step type

Change. Before and after panes side by side, the notes column to the right with one card per boxed place (place, then old value struck through, then new value). Five cards show; the rest fold into "14 more changes". A whole-file rewrite is one card ("Rewrote the sheet 'info'"), never cell trivia. If the call that made the change failed, the AI line says so; there is no separate failure banner. A text change has no notes column: the diff is its own note and gets the width. Leader lines from boxes to cards stay as they are today; the mock leaves them out.

Failure group. A run of failed calls by one actor, with no file change between them, is one step: "2 runs failed" [4]. The body is a list, one row per failed call: what it tried, the last line of the error, and "Show output" to open the full text. There are no panes, because nothing changed. A failure group takes no verdict and does not count toward progress.

Request. Your words, whole, in the large sky card the page has today. The AI line says what came of the request ("Claude answered with four CSV files and one workbook, over 11 steps."). No verdict.

Reply or report. A message between actors: Claude's reply to you, a helper's report to Claude, Claude's new instruction to a helper. The body is the message in a card with the sender's lane color down its left edge and "To Helper 1" above it. No verdict.

Helper finish. Where a helper's lane joins its parent. The body is the helper's final report, then a short list of the files it changed, each with its verdict state and a link to its step. No verdict of its own.

## The verdict control [3]

Two real buttons in one bordered group, Pass and Fail, 36 px tall, each showing its key (P, F). The chosen one fills: Pass in green, Fail in red. These two colors, already used as raw values today, become tokens (`--pass`, `--fail`) and are used for verdicts only, never for a failed call. P passes and moves to the next step that needs a verdict. F opens a note field under the heading ("What's wrong?"); Enter saves, Escape cancels, and a fail needs the note. Every verdict shows a small bar for six seconds: "Passed fetch_fred.py. Undo (U)". U, or pressing the chosen button again, clears the verdict and returns to that step. "Mark not reviewed" is gone.

A verdict on a call header covers the files under it. Pass on the header passes every file in that call that has no verdict of its own; a file's own verdict always wins, and the header then reads "4 passed, 1 failed". A fail on the header needs one note, which goes to every file it covers. Only a call that changed two or more files gets a header; a single-file call is just its change step.

## The rail [2, 4]

Every row type has its own slot in the column of rows. Nothing is drawn between two rows or on top of one.

Stop: a node on its lane and a label, 30 px. Call header: a 26 px row with a thin bracket on the lane that spans the stops it covers, and the call's verdict at its right end. Quiet calls: a 22 px row, "2 calls, no change", with a small hollow tick on the lane; it opens a list in place that pushes the rows below it down. A quiet row holds one actor's calls only. Failure group: a stop row whose node is a hollow ring with a slash and whose label carries the count; it is a stop, not a quiet line. Pass marker (a submitted or sent-back round): a 24 px row with a dashed line across all lanes and its label at the right.

Call headers collapse. The header row is the control: a chevron at its left shows the state, and a click, Enter or Space on the row opens or closes it and selects the header step. With the header current, Right opens it and Left closes it; Left on a file under a header closes that header and lands on it. A header is open by default while it holds the current step or any file with no verdict, and closed once every file under it has one, so a header passed with P folds away as the page moves on. A header you open or close by hand keeps that state for the session. Closed, it reads "Rerun FRED fetch 6 files", its node is a filled dot with a ring around it, and its verdict mark shows at its right end. Closing a header that holds the current step moves the current step to the header.

The legend toggles actors, as the live page does today. Each actor in the legend is a pressed button; a click hides that actor's rows and lane line, and the pill turns dashed and hollow. A hidden actor's steps are skipped by the arrow keys and by P's jump to the next step. If the current step is hidden, the current step moves to the nearest shown step. The last shown actor can't be hidden. Pass markers and the origin always show. Hiding changes no count: progress still counts every change.

One rounding: every pill and every chip is fully round, and a chip inside a pill is a circle, so the two curves match [2]. Buttons, panes and cards share one 8 px radius.

## The text diff [7]

The text diff is split and aligned: row n on the left and row n on the right are always the same line of the file, so both panes show the same number of rows. Unchanged rows are plain on both sides. Two rows of context stay around each change; the rest of a run folds to one row ("31 unchanged lines") on both sides. An edited line shows on both sides, the old text tinted sky and the new text tinted pink, and the words that differ are marked inside the line. An added line is pink on the right and a hatched empty row on the left. A removed line is sky and struck on the left, with a hatched empty row on the right. The hatching is the page's existing "nothing here" pattern, so the three kinds of change read from shape, not from a legend.

## AI text

The AI line is plain body text: no color of its own, no rule down its side, not italic. A small neutral "AI" tag, the page's pill in ink-soft, sits at the end of the sentence, after the last word; hovering it reads "Written by AI from the record. Check it against the panes." There is no "AI-written" label above it. The AI line replaces the subtitle and the card sentence; it adds no text [10]. To write it the model gets the request, the step's change rows and the step before and after, so it can say why, not only what [5]. It states what the panes show without hedging; "the record does not show" is allowed once, only for the thing it cannot see.

## Words to cut

Gone from the page: "the host" (say "the output"); "watched file"; "workbook part"; "CoCheck saw no watched file change during it"; "just before this moment", "just after this moment", "at this moment"; "Loaded the anthropic-skills:xlsx skill" (say "Loaded Excel instructions"); "soft sign-off"; "Mark not reviewed"; "AI-written" and "Asked:" as labels; "Can't tell which" and "Outside the agents" as lane names (say "Unknown"). "Call" stays only in rail headers; headings use the verb of what was done (ran, edited, wrote, read). "Stop" and "lane" are internal words and never reach the screen; the screen says "step". A review round is a "round", never a "pass", because Pass is the verdict.

## Out of scope here

Charts drawn by CoCheck [9], who gets credit for a change [8], and capturing helper finishes and messages (a finding from the test run) are their own items. This design needs that capture to exist; until it does, the helper finish and reply steps have nothing to show. The marker for the first round in the mock is illustrative; the recorded run had no submit.
