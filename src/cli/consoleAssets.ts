// The web console `overcli serve --control` serves at /.
//
// Kept as strings in a module, not files beside it, because the CLI ships as
// tsc output and tsc copies no assets. No framework and no build: the page is
// a handful of views over the /api routes, and a dependency-free page is one
// less thing to audit on a box that holds the org's workers.
//
// Every value from the server is set as text (`textContent` through `h`),
// never parsed as HTML: worker names, job descriptions and questions are
// written by models and by other people.
//
// The look: workers are staff, so names are set in a book serif, like a
// directory; amber means "a person is needed" and is used for nothing else;
// teal is the action that sends work forward. Light and dark follow the OS
// unless the person picks one. No web fonts — the CSP allows nothing off the
// box — so the serif is whichever good one the OS has.

/// overcli's mark for small places — the tab, the sidebar — served at
/// /icon.svg: the app icon's overline and chevron, flat on an ink tile, the
/// chevron in the console's teal. The Dock icon's white plate and shadow read
/// as a sticker at 30 px. The sidebar draws the same shape inline so the tile
/// can follow the theme.
export const CONSOLE_ICON = `<svg width="64" height="64" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#efefeb"/></linearGradient></defs>
<rect x="0.5" y="0.5" width="31" height="31" rx="7" fill="url(#g)" stroke="#000" stroke-opacity="0.14"/>
<path d="M10 9.5h12" stroke="#111113" stroke-width="3" stroke-linecap="round"/>
<path d="M10 14l11.5 5L10 24" fill="none" stroke="#111113" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>overcli</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/console.css">
</head>
<body>
<div id="app"></div>
<script src="/console.js"></script>
</body>
</html>
`;

const DARK = `
  --bg: #10141f; --side: #0c101a; --panel: #171c2a; --panel-2: #1d2334; --line: #283049; --line-2: #343d5a;
  --ink: #e8ebf3; --muted: #9ba4ba; --faint: #7d869e;
  --go: #3fbfa8; --go-ink: #06201b; --go-soft: rgba(63, 191, 168, 0.14);
  --need: #f0b43c; --need-ink: #241700; --need-soft: rgba(240, 180, 60, 0.12);
  --bad: #ff8a80; --bad-soft: rgba(255, 138, 128, 0.12);
  --shadow: 0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 8px 24px -12px rgba(0, 0, 0, 0.5);
  color-scheme: dark;`;

const LIGHT = `
  --bg: #f4f5f8; --side: #eceff4; --panel: #ffffff; --panel-2: #f6f7fa; --line: #e0e4ec; --line-2: #c9d0dc;
  --ink: #161b29; --muted: #545d72; --faint: #6f788d;
  --go: #0f7a6a; --go-ink: #ffffff; --go-soft: rgba(15, 122, 106, 0.1);
  --need: #9a5d00; --need-ink: #ffffff; --need-soft: #fff1d6;
  --bad: #b3261e; --bad-soft: #fdecea;
  --shadow: 0 1px 2px rgba(22, 27, 41, 0.05), 0 8px 24px -16px rgba(22, 27, 41, 0.22);
  color-scheme: light;`;

export const CONSOLE_CSS = `
:root {${DARK}
  --serif: "Iowan Old Style", "Charter", "Palatino Linotype", "Book Antiqua", ui-serif, Georgia, serif;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --r-sm: 7px; --r: 10px; --r-lg: 14px;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {${LIGHT} } }
:root[data-theme="light"] {${LIGHT} }
:root[data-theme="dark"] {${DARK} }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
button, input, textarea, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; border-radius: var(--r-sm); }
p { margin: 0; }
h1, h2, h3 { margin: 0; font-weight: 600; }
a { color: var(--go); }
code, pre { font-family: var(--mono); font-size: 12.5px; }

/* ---- frame ---- */
.frame { display: grid; grid-template-columns: 232px minmax(0, 1fr); min-height: 100vh; }
.side { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 18px 12px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
.brand { display: flex; align-items: center; gap: 10px; padding: 2px 8px 18px; }
.brand svg { width: 32px; height: 32px; flex: none; }
svg.mark { flex: none; filter: drop-shadow(0 1px 1.5px rgba(16, 20, 31, 0.16)); }
.brand-name { font-family: var(--serif); font-size: 17px; letter-spacing: -0.01em; }
.brand-sub { color: var(--faint); font-size: 12px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; padding: 7px 10px; border: 0; background: none; border-radius: var(--r-sm); color: var(--muted); cursor: pointer; text-align: left; }
.nav button svg { flex: none; opacity: 0.85; }
.nav button:hover { background: var(--panel); color: var(--ink); }
.nav button[aria-current="page"] { background: var(--panel-2); color: var(--ink); box-shadow: inset 2px 0 0 var(--go); }
.nav .count { margin-left: auto; min-width: 20px; padding: 0 6px; border-radius: 10px; font-size: 11px; font-weight: 650; text-align: center; line-height: 18px; background: var(--need); color: var(--need-ink); }
.nav .sep { height: 1px; background: var(--line); margin: 8px 6px; }
.me { margin-top: auto; border-top: 1px solid var(--line); padding: 14px 8px 0; display: flex; flex-direction: column; gap: 10px; }
.me-row { display: flex; align-items: center; gap: 10px; }
.me-name { font-weight: 600; }
.me-role { color: var(--faint); font-size: 12px; }
.allow-label { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.theme { display: flex; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.theme button { flex: 1; border: 0; background: none; padding: 5px 0; font-size: 12px; color: var(--muted); cursor: pointer; }
.theme button[aria-pressed="true"] { background: var(--panel-2); color: var(--ink); }
.linkish { background: none; border: 0; padding: 0; color: var(--faint); font-size: 12px; cursor: pointer; text-align: left; }
.linkish:hover { color: var(--ink); }

.main { min-width: 0; padding: 28px 36px 64px; }
.page { display: flex; flex-direction: column; gap: 26px; }
.page-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px; }
.eyebrow { color: var(--faint); font-size: 13px; }
.page-title { font-family: var(--serif); font-size: 32px; line-height: 1.15; letter-spacing: -0.015em; }
.page-sub { margin-top: 6px; color: var(--muted); max-width: 66ch; }
.section-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--need); flex: none; }
.split { display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start; }
.split > .wide { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.split > .narrow { flex: 1 1 290px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }

/* ---- primitives ---- */
.stack { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spread { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.muted { color: var(--muted); }
.faint { color: var(--faint); font-size: 12.5px; }
.serif { font-family: var(--serif); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.pad { padding: 20px 22px; }
.list > * + * { border-top: 1px solid var(--line); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; border: 1px solid var(--line-2); background: var(--panel-2); padding: 0 14px; border-radius: var(--r-sm); cursor: pointer; font-weight: 550; font-size: 13.5px; text-decoration: none; color: var(--ink); }
.btn:hover { border-color: var(--faint); }
.btn.go { background: var(--go); color: var(--go-ink); border-color: var(--go); }
.btn.go:hover { filter: brightness(1.07); }
.btn.quiet { background: none; border-color: transparent; color: var(--muted); }
.btn.quiet:hover { color: var(--ink); border-color: var(--line-2); }
.btn.danger { color: var(--bad); background: none; }
.btn.danger:hover { border-color: var(--bad); }
.btn.small { min-height: 34px; padding: 0 11px; font-size: 12.5px; }
.btn.icon { width: 34px; padding: 0; }
.btn:disabled { opacity: 0.5; cursor: default; filter: none; }
.btn[aria-pressed="true"] { border-color: var(--go); color: var(--go); }
.chip { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--panel-2); cursor: pointer; font-size: 13.5px; }
.chip:hover { border-color: var(--go); }
.chip.dashed { border-style: dashed; background: none; color: var(--muted); }
.chip[aria-pressed="true"] { border-color: var(--go); color: var(--ink); background: var(--go-soft); }
textarea, input[type=text], input[type=number], input[type=search], input[type=time], select { width: 100%; border: 1px solid var(--line-2); background: var(--bg); border-radius: var(--r-sm); padding: 9px 11px; line-height: 1.5; }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
textarea { min-height: 84px; resize: vertical; }
textarea::placeholder, input::placeholder { color: var(--faint); }
.inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
.inline-form > input { flex: 1 1 260px; min-height: 42px; }
.secret { -webkit-text-security: disc; font-family: var(--mono); letter-spacing: 0.04em; }
label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); font-size: 12px; white-space: nowrap; }
.tag.need { background: var(--need-soft); border-color: transparent; color: var(--need); font-weight: 600; }
.tag.go { background: var(--go-soft); border-color: transparent; color: var(--go); }
.msg { font-size: 13px; padding: 8px 12px; border-radius: var(--r-sm); }
.msg.ok { background: var(--go-soft); color: var(--go); }
.msg.err { background: var(--bad-soft); color: var(--bad); }
.quote { font-family: var(--serif); font-size: 17px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.why { color: var(--muted); font-size: 13px; border-left: 2px solid var(--line-2); padding-left: 10px; white-space: pre-line; }
.empty { padding: 48px 24px; text-align: center; }
.empty .quote { font-size: 20px; }
.empty p { margin-top: 6px; color: var(--muted); }
.avatar { flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: 650; color: #fff; letter-spacing: 0.02em; }
.avatar.s { width: 30px; height: 30px; font-size: 11px; }
.avatar.m { width: 38px; height: 38px; font-size: 13px; }
.avatar.l { width: 48px; height: 48px; font-size: 16px; }
.avatar.xl { width: 64px; height: 64px; font-size: 22px; }
.avatar.person { background: var(--panel-2); color: var(--ink); border: 1px solid var(--line-2); }
.avatar svg { flex: none; width: 15px; height: 15px; min-width: 15px; }
.meter { height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; }
.meter > span { display: block; height: 100%; background: var(--go); border-radius: 3px; }
.meter.high > span { background: var(--need); }
.big { font-family: var(--serif); font-size: 28px; line-height: 1.1; }
.thinking { display: inline-flex; align-items: center; gap: 10px; color: var(--muted); }
.dots { display: inline-flex; gap: 4px; }
.dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--go); animation: pulse 1.2s infinite ease-in-out; }
.dots i:nth-child(2) { animation-delay: 0.15s; } .dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes pulse { 0%, 80%, 100% { opacity: 0.25; transform: scale(0.85); } 40% { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .dots i { animation: none; opacity: 0.7; } }
.preview { border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg); padding: 12px 14px; max-height: 260px; overflow: auto; }
.preview pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
details > summary { cursor: pointer; color: var(--muted); font-size: 13px; }

/* ---- items ---- */
.ask { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px 16px; padding: 20px 22px; }
.ask.need { box-shadow: inset 3px 0 0 var(--need), var(--shadow); }
.ask.done { opacity: 0.7; box-shadow: inset 3px 0 0 var(--go), var(--shadow); }
.ask-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ask-name { font-family: var(--serif); font-size: 19px; }
.ask-body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 14px; padding: 14px 18px; align-items: start; }
.item .t { font-family: var(--serif); font-size: 16.5px; }
.item .sub { color: var(--muted); font-size: 13.5px; }
.item .acts { grid-row: span 2; display: flex; gap: 6px; align-self: center; flex-wrap: wrap; justify-content: flex-end; }
.crew-row { display: flex; align-items: center; gap: 10px; min-height: 42px; border: 0; background: none; width: 100%; padding: 4px 0; cursor: pointer; text-align: left; }
.crew-row .n { font-family: var(--serif); font-size: 15px; }
.state { margin-left: auto; font-size: 12.5px; }
.state.working { color: var(--go); } .state.waiting { color: var(--need); } .state.stuck { color: var(--bad); } .state.idle, .state.paused { color: var(--faint); }
.sched { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 8px 12px; font-size: 13.5px; }
.stages { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
.stages li { border-radius: var(--r-sm); padding: 9px 11px; display: flex; flex-direction: column; gap: 1px; font-size: 13px; border: 1px dashed var(--line-2); }
.stages li.done { border: 1px solid transparent; background: var(--go-soft); }
.stages li.now { border: 1px solid var(--go); }
.stages li.need { border: 1px solid var(--need); }
.stages .k { font-size: 12px; color: var(--faint); }
.stages li.done .k { color: var(--go); } .stages li.need .k { color: var(--need); }
.stages .l { font-weight: 600; }

/* ---- chart ---- */
.chart { overflow-x: auto; padding: 8px 0 24px; }
.branch { display: flex; flex-direction: column; align-items: center; min-width: max-content; }
.branch + .branch { margin-top: 48px; }
.person { display: flex; align-items: center; gap: 10px; padding: 8px 18px 8px 8px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--panel); }
.person-name { font-family: var(--serif); font-size: 16px; }
.person.none { border-style: dashed; color: var(--muted); padding-left: 18px; }
.stem { width: 1px; height: 22px; background: var(--line-2); }
.kids { display: flex; }
.kid { position: relative; display: flex; flex-direction: column; align-items: center; padding: 22px 10px 0; }
.kid::before { content: ""; position: absolute; top: 0; left: 50%; width: 1px; height: 22px; background: var(--line-2); }
.kid .bar { position: absolute; top: 0; height: 1px; background: var(--line-2); }
.card { width: 208px; padding: 16px 14px 14px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; color: var(--ink); }
.card:hover { border-color: var(--go); }
.card.paused { opacity: 0.55; }
.card-name { font-family: var(--serif); font-size: 17px; margin-top: 6px; }
.card-tag { color: var(--muted); font-size: 12.5px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.card .row { justify-content: center; margin-top: 8px; }

/* ---- workers ---- */
.wrow { display: grid; grid-template-columns: minmax(0, 2.2fr) minmax(0, 1.3fr) minmax(140px, 1fr) 90px; gap: 16px; align-items: center; padding: 14px 20px; }
.wrow.head { color: var(--faint); font-size: 12.5px; padding-top: 11px; padding-bottom: 10px; background: var(--panel-2); border-radius: var(--r-lg) var(--r-lg) 0 0; }
.who { display: flex; gap: 12px; align-items: center; min-width: 0; border: 0; background: none; padding: 0; cursor: pointer; text-align: left; color: var(--ink); }
.who-name { font-family: var(--serif); font-size: 16.5px; }
.who-tag { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chain { font-size: 13px; color: var(--muted); }
.chain b { color: var(--ink); font-weight: 550; }
.spend { font-size: 13px; display: flex; flex-direction: column; gap: 6px; font-variant-numeric: tabular-nums; }
.wrow .actions { display: flex; gap: 6px; justify-content: flex-end; }
.facts { display: flex; flex-wrap: wrap; gap: 8px 26px; color: var(--muted); font-size: 13.5px; padding-bottom: 18px; border-bottom: 1px solid var(--line); }
.facts b { color: var(--ink); font-weight: 600; }
.ladder { list-style: none; margin: 0; padding: 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ladder li { padding: 5px 12px; border-radius: 999px; border: 1px dashed var(--line-2); color: var(--faint); font-size: 13px; }
.ladder li.on { border-style: solid; background: var(--panel-2); color: var(--ink); }
.ladder li.next { border-color: var(--go); color: var(--go); }
.stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }

/* ---- hire ---- */
.steps { display: flex; gap: 6px; list-style: none; padding: 0; margin: 0 0 4px; flex-wrap: wrap; }
.steps li { display: flex; align-items: center; gap: 8px; color: var(--faint); font-size: 13px; padding-right: 14px; }
.steps li .n { width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-2); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; }
.steps li.on { color: var(--ink); }
.steps li.on .n { background: var(--go); border-color: var(--go); color: var(--go-ink); font-weight: 650; }
.steps li.past .n { border-color: var(--go); color: var(--go); }
.roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.role { padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; }
.role h3 { font-family: var(--serif); font-size: 19px; }
.role dl { margin: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; font-size: 13px; }
.role dt { color: var(--faint); } .role dd { margin: 0; }
.fit-fits { color: var(--go); font-size: 12.5px; } .fit-needsApproval, .fit-notAllowed { color: var(--need); font-size: 12.5px; }
.qa { display: flex; flex-direction: column; gap: 8px; }
.qa + .qa { padding-top: 16px; border-top: 1px solid var(--line); }
.offer { padding: 28px 28px 24px; }
.offer-name { font-family: var(--serif); font-size: 34px; letter-spacing: -0.02em; line-height: 1.1; }
.offer-tag { color: var(--muted); font-size: 15px; margin-top: 4px; }
.offer-job { margin: 20px 0; padding: 16px 18px; background: var(--panel-2); border-radius: var(--r); }
.ofacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px 24px; margin-bottom: 22px; }
.fact-k { color: var(--faint); font-size: 12.5px; }
.fact-v { margin-top: 2px; overflow-wrap: anywhere; }
.terms { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; padding-top: 20px; border-top: 1px solid var(--line); }
.offer-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 22px; }
.reason { background: var(--need-soft); color: var(--need); padding: 8px 12px; border-radius: var(--r-sm); font-size: 13px; }

/* ---- admin ---- */
.health { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.health > div { padding: 14px 16px; display: flex; flex-direction: column; gap: 3px; }
.health .h { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.health .light { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
.health .light.ok { background: var(--go); } .health .light.bad { background: var(--bad); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; min-width: 640px; }
th { text-align: left; font-weight: 500; color: var(--faint); font-size: 12.5px; padding: 11px 14px; }
td { padding: 11px 14px; border-top: 1px solid var(--line); vertical-align: middle; }
dl.rules { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 16px; font-size: 13.5px; }
dl.rules dt { color: var(--muted); } dl.rules dd { margin: 0; text-align: right; }
.log { list-style: none; margin: 0; padding: 0; }
.log li { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: 13.5px; }
.log li:first-child { border-top: 0; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bars > div { display: grid; grid-template-columns: 160px minmax(0, 1fr) 80px; gap: 12px; align-items: center; font-size: 13.5px; }
.bars > div > span:last-child { text-align: right; }

/* ---- connect ---- */
.code { position: relative; }
.code pre { margin: 0; padding: 14px 16px; padding-right: 76px; background: var(--bg); border: 1px solid var(--line-2); border-radius: var(--r); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.code .btn { position: absolute; top: 8px; right: 8px; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.tabs button { border: 0; background: none; padding: 8px 12px; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--go); }

/* ---- people ---- */
.people-grid { display: grid; grid-template-columns: minmax(0, 2.4fr) minmax(300px, 1fr); gap: 22px; align-items: start; }
.person-cell { display: flex; align-items: center; gap: 10px; }
.manage { background: var(--panel-2); }
.manage td { padding: 14px 18px 18px; }
.devices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.devices li { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.select-sm { width: auto; min-height: 34px; padding: 4px 8px; font-size: 13px; }
.toggle { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; cursor: pointer; }
.toggle input { margin-top: 3px; }
.scrim { position: fixed; inset: 0; background: rgba(12, 16, 26, 0.5); display: flex; align-items: flex-start; justify-content: center; padding: 56px 16px; overflow-y: auto; z-index: 10; }
.dialog { width: 100%; max-width: 620px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.5); padding: 26px 28px; display: flex; flex-direction: column; gap: 18px; }
.dialog h2 { font-family: var(--serif); font-size: 24px; }
.picker { border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.picker button { display: flex; width: 100%; align-items: center; gap: 10px; padding: 8px 12px; border: 0; border-top: 1px solid var(--line); background: var(--panel); cursor: pointer; text-align: left; color: var(--ink); }
.picker button:first-child { border-top: 0; }
.picker button:hover, .picker button:focus-visible { background: var(--go-soft); }
.roles-pick { display: flex; flex-direction: column; gap: 8px; }
.roles-pick label { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border-radius: var(--r-sm); border: 1px solid var(--line); cursor: pointer; }
.roles-pick label:has(input:checked) { border-color: var(--go); background: var(--go-soft); }
.roles-pick input { margin-top: 4px; }

/* ---- join / pair ---- */
.solo { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.solo-left { padding: 64px clamp(24px, 6vw, 88px); display: flex; flex-direction: column; justify-content: center; gap: 26px; }
.solo-right { background: var(--panel); border-left: 1px solid var(--line); padding: 64px clamp(24px, 5vw, 72px); display: flex; flex-direction: column; justify-content: center; gap: 16px; }
.solo h1 { font-family: var(--serif); font-size: clamp(30px, 3.4vw, 44px); line-height: 1.1; letter-spacing: -0.015em; }
.lead { color: var(--muted); font-size: 16px; max-width: 48ch; }
.places { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.place { display: flex; flex-direction: column; gap: 8px; padding: 18px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); text-align: left; cursor: pointer; min-height: 140px; }
.place:hover { border-color: var(--go); }
.place b { font-family: var(--serif); font-size: 19px; font-weight: 600; }
.place .cta { margin-top: auto; color: var(--go); font-size: 13px; font-weight: 600; }
.bigcode { display: flex; gap: 8px; }
.bigcode span { min-width: 44px; height: 58px; border-radius: 8px; background: var(--panel-2); border: 1px solid var(--line-2); display: inline-flex; align-items: center; justify-content: center; font-family: var(--mono); font-size: 26px; padding: 0 6px; }
.bigcode span.dash { background: none; border: 0; color: var(--faint); min-width: 16px; }

/* ---- sign in ---- */
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login { width: 100%; max-width: 420px; padding: 32px; }
.login svg.mark { width: 48px; height: 48px; }
.login .page-title { font-size: 26px; margin: 16px 0 6px; }

@media (max-width: 880px) {
  .frame { grid-template-columns: minmax(0, 1fr); }
  .side { min-width: 0; position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--line); overflow: visible; }
  .brand { padding: 0 8px 0 0; }
  .brand-sub, .nav .sep { display: none; }
  .nav { flex-direction: row; overflow-x: auto; width: 100%; min-width: 0; order: 3; scrollbar-width: none; }
  .nav button { white-space: nowrap; width: auto; }
  .nav button[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--go); }
  .me { margin: 0 0 0 auto; border: 0; padding: 0; flex-direction: row; align-items: center; }
  .me .allowance, .me-role, .me .theme { display: none; }
  .main { padding: 24px 16px 48px; }
  .page-title { font-size: 25px; }
  .wrow { grid-template-columns: 1fr; gap: 10px; }
  .wrow.head { display: none; }
  .wrow .actions { justify-content: flex-start; }
  .ask { padding: 16px; }
  .item { grid-template-columns: auto minmax(0, 1fr); }
  .item .acts { grid-row: auto; grid-column: 2; justify-content: flex-start; }
  .offer { padding: 20px; }
  .offer-name { font-size: 28px; }
  .bars > div { grid-template-columns: 100px minmax(0, 1fr) 64px; }
  .people-grid, .solo, .places { grid-template-columns: minmax(0, 1fr); }
  .solo-right { border-left: 0; border-top: 1px solid var(--line); }
}
`;

export const CONSOLE_JS = String.raw`
(function () {
  'use strict';
  var TOKEN_KEY = 'overcli-org-token';
  var THEME_KEY = 'overcli-org-theme';
  var SVG = 'http://www.w3.org/2000/svg';
  var state = { tab: 'today', me: null, counts: { today: 0 }, hire: null, workerId: null, workMine: true };
  var app = document.getElementById('app');

  function store(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) {} }
  function read(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function token() { return read(TOKEN_KEY); }
  function applyTheme() {
    var t = read(THEME_KEY);
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme();

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el[k] = v;
      // Through the CSSOM, not the attribute: the page's CSP has no
      // 'unsafe-inline', which blocks style="" but not el.style.
      else if (k === 'style') String(v).split(';').forEach(function (decl) {
        var at = decl.indexOf(':');
        if (at > 0) el.style.setProperty(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
      });
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }

  var ICONS = {
    sun: [['circle', 12, 12, 4], ['path', 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4']],
    doc: [['path', 'M6 3h9l4 4v14H6z'], ['path', 'M14 3v5h5M9 13h7M9 17h5']],
    people: [['circle', 9, 8, 3.2], ['path', 'M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5'], ['circle', 17, 9, 2.4], ['path', 'M16 14.2c2.4.2 4 1.8 4.5 4.8']],
    team: [['circle', 12, 7, 3], ['circle', 5.5, 10, 2.3], ['circle', 18.5, 10, 2.3], ['path', 'M7 20c.5-3.4 2.4-5.4 5-5.4s4.5 2 5 5.4M2.5 18c.3-2 1.4-3.3 3-3.6M21.5 18c-.3-2-1.4-3.3-3-3.6']],
    chart: [['rect', 9, 3, 6, 5], ['rect', 3, 16, 6, 5], ['rect', 15, 16, 6, 5], ['path', 'M12 8v4M6 16v-4h12v4']],
    plus: [['circle', 12, 12, 9], ['path', 'M12 8v8M8 12h8']],
    gear: [['circle', 12, 12, 3], ['path', 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1']],
    plug: [['path', 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4']],
    up: [['path', 'M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7']],
    down: [['path', 'M17 13V4h3v9zM17 13l-4 8c-1.5 0-2.5-1-2.5-2.5V15h-5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.7 4H17']],
    person: [['circle', 12, 8, 3.5], ['path', 'M5 20c.8-4 3.6-6 7-6s6.2 2 7 6']],
    back: [['path', 'M15 5l-7 7 7 7']]
  };
  function icon(name, size) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 18); s.setAttribute('height', size || 18);
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (p) {
      var el = document.createElementNS(SVG, p[0]);
      if (p[0] === 'path') el.setAttribute('d', p[1]);
      if (p[0] === 'circle') { el.setAttribute('cx', p[1]); el.setAttribute('cy', p[2]); el.setAttribute('r', p[3]); }
      if (p[0] === 'rect') { el.setAttribute('x', p[1]); el.setAttribute('y', p[2]); el.setAttribute('width', p[3]); el.setAttribute('height', p[4]); el.setAttribute('rx', 1.5); }
      s.appendChild(el);
    });
    return s;
  }

  // The mark, drawn inline so the tile follows the theme (CSS variables set
  // through the CSSOM: the CSP forbids style attributes, not el.style).
  var markSeq = 0;
  function brandMark(size, cls) {
    var s = document.createElementNS(SVG, 'svg');
    s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'mark' + (cls ? ' ' + cls : ''));
    var id = 'markg' + (++markSeq);
    var el = function (tag, attrs) { var n = document.createElementNS(SVG, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; };
    var defs = el('defs', {});
    var grad = el('linearGradient', { id: id, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(el('stop', { offset: '0', 'stop-color': '#ffffff' }));
    grad.appendChild(el('stop', { offset: '1', 'stop-color': '#efefeb' }));
    defs.appendChild(grad);
    s.appendChild(defs);
    s.appendChild(el('rect', { x: '0.5', y: '0.5', width: '31', height: '31', rx: '7', fill: 'url(#' + id + ')', stroke: '#000', 'stroke-opacity': '0.14' }));
    s.appendChild(el('path', { d: 'M10 9.5h12', stroke: '#111113', 'stroke-width': '3', 'stroke-linecap': 'round' }));
    s.appendChild(el('path', { d: 'M10 14l11.5 5L10 24', fill: 'none', stroke: '#111113', 'stroke-width': '3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return s;
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ Authorization: 'Bearer ' + token() }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 401) { store(TOKEN_KEY, null); state.me = null; render(); throw new Error('Your token was not accepted. Sign in again.'); }
      return res.json();
    });
  }

  function money(n) { n = n || 0; return '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, '')); }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  // FNV-1a, so ids that differ in a few characters still land far apart.
  function hue(s) { var x = 2166136261; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) % 360; }
  function avatar(seed, name, size) {
    return h('span', { class: 'avatar ' + (size || 'm'), style: 'background:hsl(' + hue(seed + name) + ' 42% 40%)', text: initials(name), 'aria-hidden': 'true' });
  }
  function ago(ms) {
    if (!ms) return '';
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var hrs = Math.round(m / 60); if (hrs < 24) return hrs + 'h ago';
    var d = Math.round(hrs / 24); if (d < 7) return d + 'd ago';
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function when(ms) {
    var d = new Date(ms), now = new Date(), t = new Date(now);
    t.setDate(now.getDate() + 1);
    var day = d.toDateString() === now.toDateString() ? 'Today' : d.toDateString() === t.toDateString() ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short' });
    return day + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function dayLabel(ms) {
    var d = new Date(ms), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  var VIS = { 'private': 'Only its manager', team: 'Its team', org: 'Everyone' };
  var STATE = { working: 'Working', waiting: 'Waiting on you', stuck: 'Stuck', idle: 'Idle', paused: 'Paused' };
  var TRUST = { probation: 'Probation', trusted: 'Trusted', autonomous: 'Autonomous' };

  function msg(res, okText) {
    if (res && res.ok === false) return h('div', { class: 'msg err', role: 'alert', text: res.error });
    return h('div', { class: 'msg ok', role: 'status', text: okText });
  }
  function thinking(text) { return h('div', { class: 'thinking', role: 'status' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), text); }
  function busy(button, label) {
    button.disabled = true; var was = button.textContent; button.textContent = label;
    return function () { button.disabled = false; button.textContent = was; };
  }
  function head(title, sub, action, eyebrow) {
    return h('header', { class: 'page-head' },
      h('div', null, eyebrow ? h('div', { class: 'eyebrow', text: eyebrow }) : null, h('h1', { class: 'page-title', text: title }), sub ? h('p', { class: 'page-sub', text: sub }) : null),
      action || null);
  }
  function emptyState(title, sub, action) {
    return h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: title }), sub ? h('p', { text: sub }) : null,
      action ? h('div', { style: 'margin-top:18px' }, action) : null);
  }
  function go(tab, extra) { state.tab = tab; if (extra) Object.assign(state, extra); render(); window.scrollTo(0, 0); }
  function openWorker(id) { go('worker', { workerId: id }); }

  // ---- sign in ---------------------------------------------------------

  function renderLogin() {
    // A plain text field drawn as dots: a password field makes the browser
    // offer to save a "login" that is really an API token.
    var input = h('input', { type: 'text', class: 'secret', placeholder: 'ocli_…', autocomplete: 'off', spellcheck: 'false', 'data-1p-ignore': true, 'data-lpignore': 'true', 'aria-label': 'Access token' });
    var err = h('div');
    function submit() {
      var t = input.value.trim(); if (!t) return;
      store(TOKEN_KEY, t);
      api('GET', '/api/whoami').then(function (me) { state.me = me; render(); })
        .catch(function () { err.textContent = ''; err.appendChild(h('div', { class: 'msg err', text: 'That token was not accepted. Check it was copied whole, or ask your admin for a new one.' })); });
    }
    input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    setTimeout(function () { input.focus(); }, 0);
    return h('div', { class: 'login-wrap' }, h('div', { class: 'login panel stack' },
      brandMark(48, 'mark'),
      h('h1', { class: 'page-title', text: 'Your org’s workers' }),
      h('p', { class: 'muted', text: 'Open the sign-in link overcli sent you in Slack. Lost it, or in a new browser? Type /overcli join in Slack for a fresh one, or ask your admin to invite you again.' }),
      h('details', null, h('summary', { class: 'faint', text: 'Sign in with an access token instead' }),
        h('div', { class: 'stack', style: 'margin-top:10px' }, input, err, h('button', { class: 'btn go', onclick: submit, text: 'Sign in' })))));
  }

  // ---- shell -----------------------------------------------------------

  function tabs() {
    var t = [
      { id: 'today', label: 'Today', icon: 'sun', count: 'today' },
      { id: 'work', label: 'Work', icon: 'doc' },
      { id: 'workers', label: 'Workers', icon: 'people' },
      { id: 'teams', label: 'Teams', icon: 'team' },
      { id: 'chart', label: 'Org chart', icon: 'chart' },
      { id: 'hire', label: 'Hire', icon: 'plus' },
      'sep',
      { id: 'connect', label: 'Connect', icon: 'plug' }
    ];
    if (state.me && state.me.admin) {
      t.push({ id: 'people', label: 'People', icon: 'people', count: 'people' });
      t.push({ id: 'admin', label: 'Admin', icon: 'gear' });
    }
    return t;
  }

  function refreshCounts() {
    if (state.me && state.me.admin) {
      api('GET', '/api/admin/requests').then(function (r) {
        state.counts.people = r.ok === false ? 0 : r.requests.length;
        document.querySelectorAll('[data-count="people"]').forEach(function (el) { el.textContent = state.counts.people ? String(state.counts.people) : ''; el.hidden = !state.counts.people; });
      }).catch(function () {});
    }
    return api('GET', '/api/today').then(function (t) {
      state.counts.today = t.waiting.length + t.hireApprovals.length + t.proposals.length + t.teamTasks.filter(function (x) { return x.waitingOnYou; }).length;
      document.querySelectorAll('[data-count]').forEach(function (el) {
        var n = state.counts[el.getAttribute('data-count')];
        el.textContent = n ? String(n) : ''; el.hidden = !n;
      });
    }).catch(function () {});
  }

  function themeSwitch() {
    var cur = read(THEME_KEY) || 'system';
    function pick(v) { return function () { store(THEME_KEY, v === 'system' ? null : v); applyTheme(); render(); }; }
    return h('div', { class: 'theme', role: 'group', 'aria-label': 'Appearance' },
      ['system', 'light', 'dark'].map(function (v) {
        return h('button', { 'aria-pressed': cur === v ? 'true' : 'false', onclick: pick(v), text: v === 'system' ? 'Auto' : v[0].toUpperCase() + v.slice(1) });
      }));
  }

  function render() {
    app.textContent = '';
    // The invite and pairing pages are reached by link and stand alone.
    var joinMatch = /^\/join\/([A-Za-z0-9_-]{10,100})$/.exec(location.pathname);
    if (joinMatch) { renderJoin(joinMatch[1]); return; }
    if (location.pathname === '/pair') { renderPair(new URLSearchParams(location.search).get('code') || ''); return; }
    if (!token()) { app.appendChild(renderLogin()); return; }
    var wanted = read('overcli-org-open');
    if (wanted) { store('overcli-org-open', null); state.tab = wanted; }
    if (!state.me) {
      app.appendChild(h('div', { class: 'login-wrap' }, thinking('Signing in…')));
      api('GET', '/api/whoami').then(function (me) { state.me = me; render(); }).catch(function (e) {
        // 401 already sent us back to sign in; anything else, say so.
        if (!token()) return;
        app.textContent = '';
        app.appendChild(h('div', { class: 'login-wrap' }, h('div', { class: 'login panel stack' },
          h('h1', { class: 'page-title', text: 'Can’t reach the server' }),
          h('p', { class: 'muted', text: (e && e.message) || 'The server didn’t answer.' }),
          h('button', { class: 'btn go', text: 'Try again', onclick: function () { render(); } }))));
      });
      return;
    }
    var me = state.me;
    document.title = me.org + ' — overcli';
    var main = h('div', { class: 'page' }, thinking('Loading…'));
    var pct = me.allowanceUSD ? Math.min(100, (me.committedUSD / me.allowanceUSD) * 100) : 0;
    var activeTab = state.tab === 'worker' ? 'workers' : state.tab;
    app.appendChild(h('div', { class: 'frame' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, brandMark(32),
          h('div', null, h('div', { class: 'brand-name', text: 'overcli' }), h('div', { class: 'brand-sub', text: me.org }))),
        h('nav', { class: 'nav', 'aria-label': 'Sections' }, tabs().map(function (t) {
          if (t === 'sep') return h('div', { class: 'sep', 'aria-hidden': 'true' });
          return h('button', { 'aria-current': activeTab === t.id ? 'page' : null, onclick: function () { go(t.id); } },
            icon(t.icon), t.label,
            t.count ? h('span', { class: 'count', 'data-count': t.count, hidden: !state.counts[t.count], text: state.counts[t.count] ? String(state.counts[t.count]) : '' }) : null);
        })),
        h('div', { class: 'me' },
          h('div', { class: 'me-row' }, avatar('', me.name, 's'),
            h('div', null, h('div', { class: 'me-name', text: me.name }), h('div', { class: 'me-role', text: me.admin ? 'Admin' : me.canHire ? 'Can hire' : 'Member' }))),
          me.allowanceUSD != null ? h('div', { class: 'allowance stack', style: 'gap:6px' },
            h('div', { class: 'allow-label' }, h('span', { text: 'Your monthly allowance' }), h('span', { text: money(me.committedUSD) + ' of ' + money(me.allowanceUSD) })),
            h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' }))) : null,
          themeSwitch(),
          h('button', { class: 'linkish', onclick: function () { var done = function () { store(TOKEN_KEY, null); state.me = null; render(); }; api('POST', '/api/signout').then(done, done); }, text: 'Sign out' }))),
      h('main', { class: 'main' }, main)));
    refreshCounts();
    var view = { today: viewToday, work: viewWork, workers: viewWorkers, worker: viewWorker, teams: viewTeams, chart: viewChart, hire: viewHire, people: viewPeople, admin: viewAdmin, connect: viewConnect }[state.tab] || viewToday;
    view().then(function (node) { main.textContent = ''; append(main, node); })
      .catch(function (e) { main.textContent = ''; main.appendChild(h('div', { class: 'msg err', text: String(e.message || e) })); });
  }

  // ---- shared pieces ---------------------------------------------------

  function waitingCard(it) {
    var card = h('article', { class: 'panel ask need' });
    var out = h('div');
    var body;
    function done(text) {
      return function (r) {
        out.textContent = ''; out.appendChild(msg(r, text));
        if (r.ok !== false) { card.classList.remove('need'); card.classList.add('done'); refreshCounts(); }
        return r;
      };
    }
    if (it.kind === 'question') {
      var input = h('input', { type: 'text', placeholder: (it.options ? 'Or answer' : 'Answer') + ' in your own words', 'aria-label': 'Your answer for ' + it.workerName });
      var send = h('button', { class: 'btn go', text: 'Send' });
      var answer = function (text) {
        if (!text.trim()) { input.focus(); return; }
        var restore = busy(send, 'Sending…');
        api('POST', '/api/answer', { runId: it.runId, answer: text }).then(done('Sent. ' + it.workerName + ' is carrying on.')).then(function (r) { if (r.ok === false) restore(); });
      };
      send.onclick = function () { answer(input.value); };
      input.onkeydown = function (e) { if (e.key === 'Enter') answer(input.value); };
      body = [h('div', { class: 'quote', text: it.question || 'The run needs your input before it can go on.' }),
        it.why ? h('div', { class: 'why', text: it.why }) : null,
        it.options ? h('div', { class: 'row' }, it.options.map(function (o) { return h('button', { class: 'chip', text: o, onclick: function () { answer(o); } }); })) : null,
        h('div', { class: 'inline-form' }, input, send)];
    } else {
      var approve = h('button', { class: 'btn go', text: 'Approve this step' });
      var reject = h('button', { class: 'btn danger', text: 'Reject' });
      var decide = function (yes) {
        return function () {
          approve.disabled = reject.disabled = true;
          api('POST', '/api/approval', { runId: it.runId, approve: yes }).then(done(yes ? 'Approved. The step is running.' : 'Rejected. The run is stopped.'))
            .then(function (r) { if (r.ok === false) approve.disabled = reject.disabled = false; });
        };
      };
      approve.onclick = decide(true); reject.onclick = decide(false);
      body = [h('p', { class: 'muted', text: 'Its next step reaches outside overcli: it may push code, send a message, publish, or change a service. Approving covers this one step.' }),
        it.instructions ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'faint', text: 'What the step is told to do' }), h('div', { class: 'preview' }, h('pre', { text: it.instructions }))) : null,
        (it.inputs || []).map(function (inp) {
          return h('details', null, h('summary', { text: 'What it will use: ' + inp.name }), h('div', { class: 'preview', style: 'margin-top:8px' }, h('pre', { text: inp.preview })));
        }),
        h('div', { class: 'row' }, approve, reject)];
    }
    append(card, [avatar(it.workerId, it.workerName, 'm'), h('div', { class: 'ask-body' },
      h('div', { class: 'ask-head' },
        h('button', { class: 'linkish ask-name', style: 'color:var(--ink);font-size:19px', text: it.workerName, onclick: function () { openWorker(it.workerId); } }),
        h('span', { class: 'tag need', text: it.kind === 'question' ? 'Question' : 'Approval' }),
        h('span', { class: 'faint', text: it.title + (it.since ? ', ' + ago(it.since) : '') })),
      body, out)]);
    return card;
  }

  function hireApprovalCard(x) {
    var c = x.contract || {};
    var out = h('div');
    var card = h('article', { class: 'panel ask need' });
    var yes = h('button', { class: 'btn go', text: 'Approve hire' });
    var no = h('button', { class: 'btn danger', text: 'Turn down' });
    var decide = function (approve) {
      return function () {
        yes.disabled = no.disabled = true;
        api('POST', '/api/hires/decide', { hireId: x.hireId, approve: approve }).then(function (r) {
          out.textContent = ''; out.appendChild(msg(r, approve ? (c.name || 'The worker') + ' is hired.' : 'Turned down.'));
          if (r.ok === false) yes.disabled = no.disabled = false; else { card.classList.remove('need'); card.classList.add('done'); refreshCounts(); }
        });
      };
    };
    yes.onclick = decide(true); no.onclick = decide(false);
    append(card, [avatar('', c.name || '?', 'm'), h('div', { class: 'ask-body' },
      h('div', { class: 'ask-head' }, h('span', { class: 'ask-name', text: x.requestedBy + ' wants to hire ' + (c.name || 'a worker') }), h('span', { class: 'tag need', text: 'Hire' })),
      c.tagline ? h('p', { class: 'muted', text: c.tagline }) : null,
      c.jobDescription ? h('details', null, h('summary', { text: 'The job' }), h('div', { class: 'quote', style: 'font-size:15px;margin-top:8px', text: c.jobDescription })) : null,
      h('p', { class: 'faint', text: money(c.budgetUSDPerMonth) + ' a month. Tools: ' + ((c.connectors || []).join(', ') || 'none') + '.' }),
      (x.reasons || []).map(function (r) { return h('div', { class: 'reason', text: r }); }),
      h('div', { class: 'row' }, yes, no), out)]);
    return card;
  }

  function stageStrip(t) {
    return h('ol', { class: 'stages', 'aria-label': 'Stages' }, t.stages.map(function (s) {
      var cls = s.state === 'now' && t.needs ? 'need' : s.state;
      var k = s.state === 'done' ? 'Done' : s.state === 'now' ? (t.needs ? 'Waiting' : 'Now') : 'Next';
      return h('li', { class: cls }, h('span', { class: 'k', text: k }), h('span', { class: 'l', text: s.label }), h('span', { class: 'faint', text: s.who.join(', ') }));
    }));
  }

  function teamTaskCard(t) {
    var out = h('div');
    var card = h('article', { class: 'panel pad stack' + (t.waitingOnYou ? ' ask need' : '') });
    if (t.waitingOnYou) card.style.setProperty('display', 'flex');
    var act = function (body, okText) {
      return function () {
        api('POST', '/api/team-tasks/' + encodeURIComponent(t.id), body).then(function (r) { out.textContent = ''; out.appendChild(msg(r, okText)); if (r.ok !== false) setTimeout(render, 900); });
      };
    };
    var controls = null;
    if (t.waitingOnYou && t.needs === 'answers') {
      var boxes = (t.questions || []).map(function (q) { return { q: q, ta: h('textarea', { 'aria-label': q, placeholder: 'Your answer', style: 'min-height:56px' }) }; });
      controls = h('div', { class: 'stack' }, boxes.map(function (b) { return h('div', { class: 'qa' }, h('div', { class: 'quote', style: 'font-size:15.5px', text: b.q }), b.ta); }),
        h('div', { class: 'row' }, h('button', { class: 'btn go', text: 'Send answers', onclick: function () {
          act({ kind: 'answer', answers: boxes.map(function (b) { return b.ta.value; }) }, 'Sent. The coordinator is planning.')();
        } })));
    } else if (t.waitingOnYou && t.needs === 'plan') {
      var fb = h('input', { type: 'text', placeholder: 'Or say what to change', 'aria-label': 'Changes to the plan' });
      controls = h('div', { class: 'stack' },
        t.planNote ? h('div', { class: 'quote', style: 'font-size:15.5px', text: t.planNote }) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn go', text: 'Approve the plan', onclick: act({ kind: 'approve' }, 'Approved. The team is on it.') }),
          h('button', { class: 'btn danger', text: 'Cancel', onclick: act({ kind: 'cancel' }, 'Cancelled.') })),
        h('div', { class: 'inline-form' }, fb, h('button', { class: 'btn', text: 'Ask for changes', onclick: function () { if (fb.value.trim()) act({ kind: 'revise', feedback: fb.value }, 'Sent back to the coordinator.')(); } })));
    } else if (t.waitingOnYou) {
      controls = h('div', { class: 'stack' },
        t.waitingMessage ? h('p', { class: 'why', text: t.waitingMessage }) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn go', text: 'Carry on', onclick: act({ kind: 'continue' }, 'Carrying on.') }),
          h('button', { class: 'btn danger', text: 'Cancel the task', onclick: act({ kind: 'cancel' }, 'Cancelled.') })));
    }
    var status = t.waitingOnYou ? 'Waiting on you' : t.status === 'running' ? 'Working' : t.status[0].toUpperCase() + t.status.slice(1);
    append(card, h('div', { class: 'stack', style: 'width:100%' },
      h('div', { class: 'spread' },
        h('div', null,
          h('h3', { class: 'serif', style: 'font-size:19px', text: t.title }),
          h('p', { class: 'faint', text: t.teamName + (t.requestedBy ? ', for ' + t.requestedBy : '') + '. ' + money(t.spentUSD) + ' spent of a ' + money(t.budgetUSD) + ' cap.' })),
        h('span', { class: 'tag' + (t.waitingOnYou ? ' need' : t.status === 'done' ? ' go' : ''), text: status })),
      t.stages.length ? stageStrip(t) : null,
      t.packSummary ? h('details', null, h('summary', { text: 'What the team delivered' }), h('div', { class: 'quote', style: 'font-size:15px;margin-top:8px', text: t.packSummary })) : null,
      controls, out));
    return card;
  }

  function rateButtons(d, slot) {
    var up = h('button', { class: 'btn small icon', 'aria-label': 'Useful', title: 'Useful', 'aria-pressed': d.rating && d.rating.useful ? 'true' : 'false' }, icon('up', 16));
    var down = h('button', { class: 'btn small icon', 'aria-label': 'Not useful', title: 'Not useful', 'aria-pressed': d.rating && !d.rating.useful ? 'true' : 'false' }, icon('down', 16));
    var rate = function (useful) {
      return function () {
        api('POST', '/api/rate', { entryId: d.entryId, useful: useful }).then(function (r) {
          slot.textContent = '';
          if (r.ok === false) { slot.appendChild(msg(r)); return; }
          up.setAttribute('aria-pressed', useful ? 'true' : 'false'); down.setAttribute('aria-pressed', useful ? 'false' : 'true');
          if (useful) return;
          // Not useful: ask why, inline, so the worker learns more than a thumb.
          var why = h('input', { type: 'text', placeholder: 'What would have made it useful? (optional)', 'aria-label': 'What would have made it useful' });
          var send = function () {
            if (!why.value.trim()) return;
            api('POST', '/api/rate', { entryId: d.entryId, useful: false, note: why.value.trim() }).then(function (x) {
              slot.textContent = ''; slot.appendChild(msg(x, 'Thanks. ' + d.workerName + ' reads that before its next run.'));
            });
          };
          why.onkeydown = function (e) { if (e.key === 'Enter') send(); };
          append(slot, [h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { style: 'flex:1 1 260px' }, why), h('button', { class: 'btn small', text: 'Send', onclick: send }))]);
          why.focus();
        });
      };
    };
    up.onclick = rate(true); down.onclick = rate(false);
    return [up, down];
  }

  function workItem(d, opts) {
    var detail = h('div', { hidden: true, style: 'grid-column:2 / -1' }, h('div', { class: 'quote', style: 'font-size:15px', text: d.summary || '' }));
    var meta = [d.workerName, d.forManager && opts && opts.showManager ? 'for ' + d.forManager : null, ago(d.at), d.costUSD != null ? money(d.costUSD) : null,
      d.rating ? (d.rating.useful ? 'useful to ' : 'not useful to ') + d.rating.by : null].filter(Boolean).join(', ');
    var rateSlot = h('div', { style: 'grid-column:2 / -1' });
    return h('div', { class: 'item' },
      h('span', { style: 'grid-row: span 2' }, avatar(d.workerId, d.workerName, 's')),
      h('div', { class: 't', text: d.title }),
      h('div', { class: 'acts' },
        d.summary ? h('button', { class: 'btn small', text: 'Read', onclick: function (e) { detail.hidden = !detail.hidden; e.target.textContent = detail.hidden ? 'Read' : 'Hide'; } }) : null,
        rateButtons(d, rateSlot)),
      h('div', { class: 'faint', text: meta }),
      rateSlot,
      d.summary ? detail : null);
  }

  // ---- schedules ---------------------------------------------------------

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /// A schedule picker in plain choices. Returns the node and a reader for the
  /// trigger it describes (null is "when asked"). A cron schedule set by hand
  /// in the app is kept as it is unless someone picks something else.
  function scheduleEditor(cadence) {
    var mode = 'asked', time = '09:00', day = 1, hours = 4, start = '08:00', end = '18:00';
    var keep = null;
    if (cadence && cadence.kind === 'daily') {
      time = cadence.time;
      var d = cadence.days || [];
      mode = !d.length || d.length === 7 ? 'daily' : d.length === 5 && d.join() === '1,2,3,4,5' ? 'weekdays' : d.length === 1 ? 'weekly' : 'daily';
      if (d.length === 1) day = d[0];
    } else if (cadence && cadence.kind === 'interval') {
      mode = 'hours'; hours = Math.max(1, Math.round(cadence.everyMinutes / 60));
      if (cadence.window) { start = cadence.window.start; end = cadence.window.end; }
    } else if (cadence) { mode = 'keep'; keep = cadence; }
    var modeSel = h('select', { 'aria-label': 'How often' },
      keep ? h('option', { value: 'keep', text: 'As set in the app', selected: true }) : null,
      [['asked', 'When asked'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Once a week'], ['hours', 'Every few hours']].map(function (o) {
        return h('option', { value: o[0], text: o[1], selected: mode === o[0] });
      }));
    var timeIn = h('input', { type: 'time', value: time, 'aria-label': 'At', style: 'width:130px' });
    var daySel = h('select', { 'aria-label': 'On', style: 'width:auto' }, DAY_NAMES.map(function (n, i) { return h('option', { value: String(i), text: n, selected: i === day }); }));
    var hoursSel = h('select', { 'aria-label': 'Every', style: 'width:auto' }, [1, 2, 3, 4, 6, 12].map(function (n) { return h('option', { value: String(n), text: plural(n, 'hour', 'hours'), selected: n === hours }); }));
    var startIn = h('input', { type: 'time', value: start, 'aria-label': 'From', style: 'width:120px' });
    var endIn = h('input', { type: 'time', value: end, 'aria-label': 'Until', style: 'width:120px' });
    var at = h('span', { class: 'row' }, h('span', { class: 'faint', text: 'at' }), timeIn);
    var on = h('span', { class: 'row' }, h('span', { class: 'faint', text: 'on' }), daySel);
    var every = h('span', { class: 'row' }, h('span', { class: 'faint', text: 'every' }), hoursSel, h('span', { class: 'faint', text: 'from' }), startIn, h('span', { class: 'faint', text: 'to' }), endIn);
    var hint = h('span', { class: 'faint' });
    var sync = function () {
      var m = modeSel.value;
      var show = function (el, yes) { el.style.display = yes ? '' : 'none'; };
      show(at, m === 'daily' || m === 'weekdays' || m === 'weekly');
      show(on, m === 'weekly');
      show(every, m === 'hours');
      hint.textContent = m === 'asked' ? 'It works only when someone asks it.' : m === 'keep' ? 'A custom schedule set in the overcli app.' : 'In ' + (state.me && state.me.timezone ? state.me.timezone : 'the server’s time zone') + '.';
    };
    modeSel.onchange = sync;
    sync();
    return {
      node: h('div', { class: 'row', style: 'gap:10px' }, h('span', { style: 'width:auto' }, modeSel), at, on, every, hint),
      value: function () {
        var m = modeSel.value;
        if (m === 'keep') return keep;
        if (m === 'asked') return null;
        if (m === 'daily') return { kind: 'daily', time: timeIn.value || '09:00' };
        if (m === 'weekdays') return { kind: 'daily', time: timeIn.value || '09:00', days: [1, 2, 3, 4, 5] };
        if (m === 'weekly') return { kind: 'daily', time: timeIn.value || '09:00', days: [Number(daySel.value)] };
        return { kind: 'interval', everyMinutes: Number(hoursSel.value) * 60, window: { start: startIn.value || '08:00', end: endIn.value || '18:00' } };
      }
    };
  }

  function proposalCard(b) {
    var card = h('article', { class: 'panel ask need' });
    var out = h('div');
    var boxes = b.items.map(function (it) {
      var box = h('input', { type: 'checkbox', checked: true, 'aria-label': it.title });
      return { it: it, box: box, row: h('label', { class: 'toggle', style: 'padding:8px 0;border-top:1px solid var(--line)' }, box,
        h('span', null, h('span', { class: 'serif', style: 'font-size:16px', text: it.title }), it.detail ? h('span', { class: 'faint', style: 'display:block', text: it.detail }) : null)) };
    });
    var go_ = h('button', { class: 'btn go', text: b.items.length === 1 ? 'Approve' : 'Approve selected' });
    var skip = h('button', { class: 'btn danger', text: 'Skip all' });
    var decide = function (body, okText) {
      go_.disabled = skip.disabled = true;
      api('POST', '/api/proposals/' + encodeURIComponent(b.batchId), body).then(function (x) {
        out.textContent = '';
        out.appendChild(msg(x, okText(x)));
        if (x.ok === false) { go_.disabled = skip.disabled = false; return; }
        card.classList.remove('need'); card.classList.add('done'); refreshCounts();
      });
    };
    go_.onclick = function () {
      var yes = boxes.filter(function (x) { return x.box.checked; }).map(function (x) { return x.it.candidateId; });
      var no = boxes.filter(function (x) { return !x.box.checked; }).map(function (x) { return x.it.candidateId; });
      if (!yes.length) { decide({ approve: [], skip: no }, function () { return 'Skipped.'; }); return; }
      decide({ approve: no.length ? yes : 'all', skip: no }, function (x) { return 'Approved. ' + plural(x.queued || 0, 'piece of work', 'pieces of work') + ' started' + (x.skipped ? ', ' + x.skipped + ' skipped' : '') + '.'; });
    };
    skip.onclick = function () { decide({ approve: [], skip: b.items.map(function (i) { return i.candidateId; }) }, function () { return 'Skipped.'; }); };
    append(card, [avatar(b.workerId, b.workerName, 'm'), h('div', { class: 'ask-body' },
      h('div', { class: 'ask-head' },
        h('button', { class: 'linkish ask-name', style: 'color:var(--ink);font-size:19px', text: b.workerName, onclick: function () { openWorker(b.workerId); } }),
        h('span', { class: 'tag need', text: 'Proposes' }),
        h('span', { class: 'faint', text: (b.task === 'errand' ? 'From an errand, ' : 'From its scheduled run, ') + ago(b.at) })),
      h('p', { class: 'muted', style: 'font-size:13.5px', text: 'It is on probation, so nothing starts until you say. Untick what you don’t want.' }),
      h('div', null, boxes.map(function (x) { return x.row; })),
      h('div', { class: 'row' }, go_, skip), out)]);
    return card;
  }

  // ---- today -----------------------------------------------------------

  function viewToday() {
    return api('GET', '/api/today').then(function (t) {
      var mineTasks = t.teamTasks.filter(function (x) { return x.waitingOnYou; });
      var needs = t.waiting.length + t.hireApprovals.length + mineTasks.length + t.proposals.length;
      var title = needs === 0 ? 'Nothing needs you' : needs === 1 ? 'One thing needs you' : plural(needs, 'thing needs', 'things need') + ' you';
      if (t.delivered.length) title += (needs ? '. ' : ', and ') + (t.delivered.length === 1 ? 'one piece of work came in.' : plural(t.delivered.length, 'piece', 'pieces') + ' of work came in.');
      else title += '.';
      if (!needs && t.delivered.length) title = title.charAt(0).toUpperCase() + title.slice(1);
      var date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      var pct = t.spend.allowanceUSD ? Math.min(100, (t.spend.spentUSD / t.spend.allowanceUSD) * 100) : 0;
      var nodes = [head(title, null, state.me.canHire ? h('button', { class: 'btn go', onclick: function () { go('hire'); } }, icon('plus', 16), 'Hire a worker') : null, date)];
      if (needs) {
        nodes.push(h('section', { class: 'stack', 'aria-labelledby': 'needs' },
          h('h2', { id: 'needs', class: 'section-title' }, h('span', { class: 'dot' }), 'Needs you'),
          t.proposals.map(proposalCard), t.waiting.map(waitingCard), t.hireApprovals.map(hireApprovalCard), mineTasks.map(teamTaskCard)));
      }
      var crew = t.crew.length
        ? h('section', { class: 'panel pad stack', style: 'gap:2px', 'aria-labelledby': 'crew' },
            h('h2', { id: 'crew', class: 'section-title', style: 'margin-bottom:8px' }, 'Your workers right now'),
            t.crew.map(function (w) {
              return h('button', { class: 'crew-row', onclick: function () { openWorker(w.id); } }, avatar(w.id, w.name, 's'), h('span', { class: 'n', text: w.name }), h('span', { class: 'state ' + w.state, text: STATE[w.state] }));
            }))
        : null;
      var upcoming = t.crew.filter(function (w) { return w.nextShiftAt; }).sort(function (a, b) { return a.nextShiftAt - b.nextShiftAt; }).slice(0, 5);
      nodes.push(h('div', { class: 'split' },
        h('section', { class: 'wide', 'aria-labelledby': 'came' },
          h('div', { class: 'spread' }, h('h2', { id: 'came', class: 'section-title', text: 'Came in since yesterday' }), h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'All work', onclick: function () { go('work'); } })),
          t.delivered.length
            ? [h('div', { class: 'panel list' }, t.delivered.map(function (d) { return workItem(d); })),
               h('p', { class: 'faint', text: 'Your ratings go into each worker’s journal, so its next run leans toward what you found useful.' })]
            : emptyState('Nothing new yet.', t.crew.length ? 'Ask a worker for something, or check back after its next run.' : 'You don’t manage any workers yet.', t.crew.length || !state.me.canHire ? null : h('button', { class: 'btn go', onclick: function () { go('hire'); }, text: 'Hire your first worker' }))),
        h('aside', { class: 'narrow' },
          h('section', { class: 'panel pad stack', style: 'gap:10px', 'aria-labelledby': 'month' },
            h('h2', { id: 'month', class: 'section-title', text: 'This month' }),
            h('div', { class: 'row', style: 'align-items:baseline' }, h('span', { class: 'big', text: money(t.spend.spentUSD) }),
              h('span', { class: 'muted', text: t.spend.allowanceUSD != null ? 'spent of your ' + money(t.spend.allowanceUSD) + ' allowance' : 'spent' })),
            t.spend.allowanceUSD ? h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })) : null,
            h('p', { class: 'muted', style: 'font-size:13px', text: 'On track for about ' + money(t.spend.projectedUSD) + ' by the end of the month.' })),
          crew,
          upcoming.length ? h('section', { class: 'panel pad stack', style: 'gap:10px', 'aria-labelledby': 'next' },
            h('h2', { id: 'next', class: 'section-title', text: 'Coming up' }),
            h('div', { class: 'sched' }, upcoming.map(function (w) { return [h('span', { class: 'faint', text: when(w.nextShiftAt) }), h('span', { text: w.name + '’s next run' })]; }))) : null)));
      return nodes;
    });
  }

  // ---- work ------------------------------------------------------------

  function viewWork() {
    return Promise.all([api('GET', '/api/work?days=14' + (state.workMine ? '&mine=1' : '')), api('GET', '/api/team-tasks')]).then(function (r) {
      var items = r[0], tasks = r[1].filter(function (t) { return t.status !== 'done' && t.status !== 'cancelled'; });
      var filters = h('div', { class: 'row', role: 'group', 'aria-label': 'Whose work' },
        h('button', { class: 'chip', 'aria-pressed': state.workMine ? 'true' : 'false', text: 'From my workers', onclick: function () { go('work', { workMine: true }); } }),
        h('button', { class: 'chip', 'aria-pressed': state.workMine ? 'false' : 'true', text: 'Everything I can see', onclick: function () { go('work', { workMine: false }); } }));
      var groups = [], last = null;
      items.forEach(function (d) { var l = dayLabel(d.at); if (l !== last) { groups.push({ label: l, items: [] }); last = l; } groups[groups.length - 1].items.push(d); });
      return [head('Work', 'What workers delivered in the last two weeks, newest first. Read anything, and say whether it was useful.'), filters,
        tasks.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: 'Team tasks in progress' }), tasks.map(teamTaskCard)) : null,
        groups.length ? groups.map(function (g) {
          return h('section', { class: 'stack', style: 'gap:10px' }, h('h2', { class: 'section-title', text: g.label }),
            h('div', { class: 'panel list' }, g.items.map(function (d) { return workItem(d, { showManager: !state.workMine }); })));
        }) : emptyState('Nothing delivered in the last two weeks.', state.workMine ? 'Try everything you can see.' : null)];
    });
  }

  // ---- workers ---------------------------------------------------------

  function hireButton() { return state.me && state.me.canHire ? h('button', { class: 'btn go', onclick: function () { go('hire'); } }, icon('plus', 16), 'Hire a worker') : null; }

  function viewWorkers() {
    return api('GET', '/api/workers').then(function (list) {
      if (!list.length) return [head('Workers'), emptyState('No workers you can see yet.', 'Hire one, or ask your admin to make a team’s workers visible to you.', hireButton())];
      var mine = list.filter(function (w) { return w.youManage; }).length;
      return [head('Workers', plural(list.length, 'worker', 'workers') + ' you can ask. You manage ' + (mine === list.length ? 'all of them.' : mine + '.'), hireButton()),
        h('div', { class: 'panel list' },
          h('div', { class: 'wrow head' }, h('span', { text: 'Worker' }), h('span', { text: 'Answers to' }), h('span', { text: 'Spend this month' }), h('span')),
          list.map(workerRow))];
    });
  }

  function askBox(w) {
    var input = h('input', { type: 'text', placeholder: 'Ask ' + w.name + ' something, or give it an errand', 'aria-label': 'Message for ' + w.name });
    var out = h('div');
    var send = h('button', { class: 'btn go', text: 'Send' });
    var submit = function () {
      if (!input.value.trim()) { input.focus(); return; }
      var restore = busy(send, 'Sending…');
      out.textContent = ''; out.appendChild(thinking(w.name + ' is working on it…'));
      api('POST', '/api/ask', { worker: w.id, message: input.value }).then(function (r) {
        out.textContent = '';
        out.appendChild(r.ok === false ? msg(r) : h('div', { class: 'panel pad stack', style: 'box-shadow:none;background:var(--panel-2)' },
          h('div', { class: 'quote', style: 'font-size:15.5px', text: r.reply }),
          r.launched ? h('div', { class: 'faint', text: 'Started ' + plural(r.launched, 'piece', 'pieces') + ' of work. It will show up under Work.' }) : null));
        restore();
      });
    };
    send.onclick = submit;
    input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    return h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'inline-form' }, input, send), out);
  }

  function workerRow(w) {
    var pct = w.budgetUSDPerMonth > 0 ? Math.min(100, (w.spentThisMonthUSD / w.budgetUSDPerMonth) * 100) : 0;
    return h('div', { class: 'wrow' },
      h('button', { class: 'who', onclick: function () { openWorker(w.id); } }, avatar(w.id, w.name, 'm'),
        h('span', { style: 'min-width:0;display:block' },
          h('span', { class: 'row', style: 'gap:8px' }, h('span', { class: 'who-name', text: w.name }),
            w.waiting ? h('span', { class: 'tag need', text: w.waiting + ' waiting' }) : null,
            w.enabled ? null : h('span', { class: 'tag', text: 'Paused' })),
          h('span', { class: 'who-tag', style: 'display:block', text: w.tagline }))),
      h('div', { class: 'chain' },
        w.manager ? h('div', null, h('b', { text: w.manager }), w.managerInherited ? ' through its boss' : '') : h('div', { text: 'No manager' }),
        w.reportsTo ? h('div', { text: 'Reports to ' + w.reportsTo.name }) : null,
        h('div', { class: 'faint', text: w.schedule + (w.nextRunAt ? ', next ' + when(w.nextRunAt) : '') })),
      h('div', { class: 'spend' },
        h('span', { text: money(w.spentThisMonthUSD) + ' of ' + money(w.budgetUSDPerMonth) }),
        h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' }))),
      h('div', { class: 'actions' }, h('button', { class: 'btn small', text: 'Open', onclick: function () { openWorker(w.id); } })));
  }

  function viewWorker() {
    return Promise.all([api('GET', '/api/workers/' + encodeURIComponent(state.workerId) + '/detail'), api('GET', '/api/workers')]).then(function (r) {
      var d = r[0], all = r[1];
      if (d.ok === false) return [msg(d)];
      var w = d.worker;
      var out = h('div');
      var setTrust = function (level) {
        api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/trust', { trust: level }).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else render(); });
      };
      var rd = d.readiness;
      var ladder = h('ol', { class: 'ladder', 'aria-label': 'Trust levels' }, ['probation', 'trusted', 'autonomous'].map(function (lvl) {
        return h('li', { class: lvl === rd.level ? 'on' : lvl === rd.readyFor ? 'next' : '', text: TRUST[lvl] });
      }));
      var explain = rd.level === 'probation' ? 'On probation, you approve every run before it starts. ' : rd.level === 'trusted' ? 'Trusted, it starts its own runs and asks only before acting outside its sandbox. ' : 'Autonomous, it acts on its own. ';
      var trustCard = h('section', { class: 'panel pad stack', 'aria-labelledby': 'trust' },
        h('div', { class: 'spread', style: 'align-items:center' }, h('h2', { id: 'trust', class: 'section-title', text: rd.readyFor ? 'Ready for more trust' : 'Trust' }), ladder),
        h('p', { class: 'muted', text: explain + rd.reason }),
        w.youManage ? h('div', { class: 'row' },
          rd.readyFor && (rd.readyFor !== 'autonomous' || state.me.admin) ? h('button', { class: 'btn go', text: 'Promote to ' + TRUST[rd.readyFor].toLowerCase(), onclick: function () { setTrust(rd.readyFor); } }) : null,
          rd.level !== 'probation' ? h('button', { class: 'btn quiet small', text: 'Put back on probation', onclick: function () { setTrust('probation'); } }) : null) : null,
        out);

      var settings = null;
      if (w.youManage) {
        var reports = h('select', { 'aria-label': 'Reports to' }, h('option', { value: '', text: 'Nobody, it’s at the top' }),
          all.filter(function (x) { return x.id !== w.id; }).map(function (x) { return h('option', { value: x.id, text: x.name, selected: !!(w.reportsTo && w.reportsTo.id === x.id) }); }));
        var vis = h('select', { 'aria-label': 'Who may ask it' }, ['private', 'team', 'org'].map(function (v) { return h('option', { value: v, text: VIS[v], selected: w.visibility === v }); }));
        var budget = h('input', { type: 'number', min: '1', step: '1', value: String(w.budgetUSDPerMonth), 'aria-label': 'Monthly budget' });
        var sched = scheduleEditor(w.cadence);
        var saved = h('div');
        settings = h('details', { class: 'panel pad' }, h('summary', { text: 'Settings: when it runs, who it reports to, who may ask it, its budget' }),
          h('div', { class: 'stack', style: 'margin-top:14px' },
            h('div', { class: 'terms', style: 'border:0;padding:0' },
              h('label', { class: 'field' }, 'Reports to', reports), h('label', { class: 'field' }, 'Who may ask it', vis), h('label', { class: 'field' }, 'Monthly budget (USD)', budget)),
            h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint', text: 'When it runs on its own' }), sched.node),
            h('div', { class: 'row' },
              h('button', { class: 'btn go', text: 'Save', onclick: function () {
                api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { reportsTo: reports.value || null, visibility: vis.value, budgetUSDPerMonth: Number(budget.value), cadence: sched.value() } })
                  .then(function (x) { saved.textContent = ''; saved.appendChild(msg(x, 'Saved.')); });
              } }),
              h('button', { class: 'btn quiet', text: w.enabled ? 'Pause ' + w.name : 'Resume ' + w.name, onclick: function () {
                api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/paused', { paused: w.enabled }).then(function (x) { if (x.ok === false) { saved.textContent = ''; saved.appendChild(msg(x)); } else render(); });
              } })),
            saved));
      }

      return [h('div', null, h('button', { class: 'btn quiet small', onclick: function () { go('workers'); } }, icon('back', 16), 'All workers')),
        h('header', { class: 'row', style: 'gap:18px;align-items:center' }, avatar(w.id, w.name, 'xl'),
          h('div', { style: 'flex:1 1 300px;min-width:0' },
            h('div', { class: 'row' }, h('h1', { class: 'page-title', style: 'font-size:36px', text: w.name }), w.enabled ? null : h('span', { class: 'tag', text: 'Paused' })),
            h('p', { class: 'page-sub', style: 'font-size:15px', text: w.tagline })),
          w.youManage && w.enabled ? h('button', { class: 'btn', text: 'Run now', onclick: function (e) {
            var restore = busy(e.target, 'Starting…');
            api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/run').then(function (x) {
              restore();
              var note = document.getElementById('run-note');
              if (note) { note.textContent = ''; note.appendChild(msg(x, w.name + ' is running. What it proposes will show on Today.')); }
            });
          } }) : null),
        h('div', { id: 'run-note' }),
        h('div', { class: 'facts' },
          h('span', null, 'Manager ', h('b', { text: w.manager || 'none' })),
          w.reportsTo ? h('span', null, 'Reports to ', h('button', { class: 'linkish', style: 'color:var(--go);font-size:13.5px', text: w.reportsTo.name, onclick: function () { openWorker(w.reportsTo.id); } })) : null,
          h('span', null, h('b', { text: w.schedule }), w.nextRunAt ? ', next ' + when(w.nextRunAt) : ''),
          h('span', { text: VIS[w.visibility] + ' may ask it' }),
          h('span', { text: money(w.spentThisMonthUSD) + ' of ' + money(w.budgetUSDPerMonth) + ' this month' })),
        trustCard,
        h('section', { class: 'stack', 'aria-labelledby': 'askh' }, h('h2', { id: 'askh', class: 'section-title', text: 'Ask ' + w.name }), askBox(w)),
        h('div', { class: 'split' },
          h('div', { class: 'wide', style: 'gap:24px' },
            h('section', { class: 'stack', 'aria-labelledby': 'del' }, h('h2', { id: 'del', class: 'section-title', text: 'What it delivered this month' }),
              d.delivered.length ? h('div', { class: 'panel list' }, d.delivered.map(function (x) { return workItem(x); })) : h('p', { class: 'muted', text: 'Nothing finished this month yet.' })),
            h('section', { class: 'stack', 'aria-labelledby': 'qs' }, h('h2', { id: 'qs', class: 'section-title', text: 'Questions it asked' }),
              d.questions.length ? h('div', { class: 'panel list' }, d.questions.map(function (q) {
                return h('div', { class: 'item', style: 'grid-template-columns:minmax(0,1fr) auto' },
                  h('div', { class: 't', style: 'font-size:15.5px', text: q.question }), h('span', { class: 'faint', text: ago(q.at) }),
                  h('div', { class: 'sub' }, q.waiting ? h('span', { class: 'tag need', text: 'Waiting on a person' }) : q.answer ? [h('b', { style: 'color:var(--ink);font-weight:600', text: (q.answeredBy || 'Someone') + ': ' }), q.answer] : 'Not answered'));
              })) : h('p', { class: 'muted', text: 'No questions yet.' })),
            settings),
          h('aside', { class: 'narrow' },
            h('section', { class: 'panel pad stats', 'aria-labelledby': 'st' },
              h('h2', { id: 'st', class: 'section-title', style: 'grid-column:1/-1', text: 'Last 30 days' }),
              h('div', null, h('div', { class: 'big', text: String(d.stats.runs) }), h('div', { class: 'faint', text: 'runs, ' + d.stats.failed + ' failed' })),
              h('div', null, h('div', { class: 'big', text: d.stats.usefulPct == null ? '—' : d.stats.usefulPct + '%' }), h('div', { class: 'faint', text: d.stats.rated ? 'rated useful, of ' + d.stats.rated + ' rated' : 'not rated yet' }))),
            h('section', { class: 'panel pad stack', style: 'gap:8px', 'aria-labelledby': 'learn' },
              h('h2', { id: 'learn', class: 'section-title', text: 'What it has learned' }),
              h('p', { class: 'faint', text: 'From ratings and notes. It plans every run from these.' }),
              d.learned.length ? h('ul', { style: 'margin:4px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13.5px' }, d.learned.map(function (l) { return h('li', { text: l.note }); }))
                : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Nothing yet. Rate its work and it starts learning what you want.' })),
            h('details', { class: 'panel pad' }, h('summary', { text: 'Its job description' }), h('div', { class: 'quote', style: 'font-size:14.5px;margin-top:10px', text: d.jobDescription }))))];
    });
  }

  // ---- teams -----------------------------------------------------------

  function viewTeams() {
    return Promise.all([api('GET', '/api/teams'), api('GET', '/api/team-tasks')]).then(function (r) {
      var teams = r[0], tasks = r[1];
      var intro = 'Give a team a task. Its coordinator asks what it needs, proposes a plan for you to approve, then runs the members through it. Questions and plans reach you here and in Slack.';
      if (!teams.length) return [head('Teams', intro), emptyState('No teams you can see yet.', 'Teams are put together in the overcli app and run on this server. Ask your admin.')];
      return [head('Teams', intro),
        h('div', { class: 'roles' }, teams.map(function (t) {
          var input = h('textarea', { placeholder: 'What do you want back from ' + t.name + '?', 'aria-label': 'Task for ' + t.name, style: 'min-height:70px' });
          var out = h('div');
          return h('article', { class: 'panel role' },
            h('h3', { text: t.name }),
            t.purpose ? h('p', { class: 'muted', style: 'font-size:13.5px', text: t.purpose }) : null,
            h('div', { class: 'row', style: 'gap:6px' }, t.members.map(function (m) { return h('span', { class: 'tag', title: m.role, text: m.name }); })),
            t.canBrief ? [input, h('div', null, h('button', { class: 'btn go', text: 'Give it the task', onclick: function (e) {
              if (input.value.trim().length < 10) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', text: 'Say a little more about the task.' })); input.focus(); return; }
              var restore = busy(e.target, 'Sending…');
              api('POST', '/api/teams/brief', { team: t.id, text: input.value }).then(function (x) {
                out.textContent = ''; out.appendChild(msg(x, 'The coordinator is planning. Questions or a plan will appear below and in Slack.'));
                restore(); if (x.ok !== false) { input.value = ''; setTimeout(render, 1500); }
              });
            } })), out] : h('p', { class: 'faint', text: 'Only people who manage someone on this team can give it work.' }));
        })),
        tasks.length ? h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: 'Tasks' }), tasks.map(teamTaskCard)) : null];
    });
  }

  // ---- org chart -------------------------------------------------------

  function viewChart() {
    return Promise.all([api('GET', '/api/chart'), api('GET', '/api/workers')]).then(function (r) {
      var branches = r[0], byId = {};
      r[1].forEach(function (w) { byId[w.id] = w; });
      if (!branches.length) return [head('Org chart'), emptyState('No workers you can see yet.', null, hireButton())];
      var card = function (w) {
        var full = byId[w.id] || w;
        return h('button', { class: 'panel card' + (full.enabled === false ? ' paused' : ''), onclick: function () { openWorker(w.id); } },
          avatar(w.id, w.name, 'l'),
          h('span', { class: 'card-name', text: w.name }),
          full.tagline ? h('span', { class: 'card-tag', text: full.tagline }) : null,
          h('span', { class: 'row' },
            full.waiting ? h('span', { class: 'tag need', text: full.waiting + ' waiting' }) : null,
            full.enabled === false ? h('span', { class: 'tag', text: 'Paused' }) : h('span', { class: 'tag', text: VIS[full.visibility || 'private'] })));
      };
      var kids = function (nodes) {
        if (!nodes.length) return null;
        return [h('div', { class: 'stem' }), h('div', { class: 'kids' }, nodes.map(function (n, i) {
          var bar = nodes.length > 1 ? h('span', { class: 'bar', style: 'left:' + (i === 0 ? '50%' : '0') + ';right:' + (i === nodes.length - 1 ? '50%' : '0') }) : null;
          return h('div', { class: 'kid' }, bar, card(n.worker), kids(n.reports));
        }))];
      };
      return [head('Org chart', plural(r[1].length, 'worker', 'workers') + ' you can see, under the person each branch answers to. A question climbs this tree before it reaches a person.'),
        h('div', { class: 'chart' }, branches.map(function (b) {
          return h('section', { class: 'branch' },
            h('div', { class: 'person' + (b.manager ? '' : ' none') },
              b.manager ? h('span', { class: 'avatar s person' }, icon('person', 15)) : null,
              h('span', { class: 'person-name', text: b.manager || 'Not managed yet' })),
            kids(b.roots));
        }))];
    });
  }

  // ---- hire ------------------------------------------------------------

  function steps(on) {
    var names = ['Describe the job', 'Answer a few questions', 'Review the offer'];
    return h('ol', { class: 'steps', 'aria-label': 'Hiring steps' }, names.map(function (n, i) {
      return h('li', { class: i === on ? 'on' : i < on ? 'past' : '', 'aria-current': i === on ? 'step' : null }, h('span', { class: 'n', text: String(i + 1) }), n);
    }));
  }

  function viewHire() {
    if (!state.me.canHire) return Promise.resolve([head('Hire a worker'), emptyState('You can’t hire yet.', 'Your admin decides who may hire in the org policy. Ask them to add you.')]);
    return Promise.all([api('GET', '/api/workers'), api('GET', '/api/roles'), api('GET', '/api/projects')]).then(function (r) {
      var roles = r[1];
      var wrap = h('div', { class: 'stack' });
      var ctx = { workers: r[0], projects: r[2], wrap: wrap };
      if (state.hire && state.hire.contract) { wrap.appendChild(offer(state.hire, ctx)); return [head('Hire a worker'), wrap]; }
      if (state.hire && state.hire.questions) { wrap.appendChild(questions(state.hire, ctx)); return [head('Hire a worker'), wrap]; }
      var nodes = [head('Hire a worker', 'Start from a role your org has approved, describe a new one, or bring a worker you built yourself. Nothing is hired until you review the offer.')];
      if (roles.length) {
        nodes.push(h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: 'Approved roles' }),
          h('div', { class: 'roles' }, roles.map(function (role) {
            var btn = h('button', { class: 'btn' + (role.fit === 'fits' ? ' go' : ''), text: 'Hire one', disabled: role.fit === 'notAllowed' });
            btn.onclick = function () {
              busy(btn, 'Drafting…');
              wrap.textContent = ''; wrap.appendChild(thinking('Drafting the offer for a ' + role.name.toLowerCase() + '…'));
              wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
              api('POST', '/api/roles/hire', { role: role.name }).then(function (x) { show(ctx, x); });
            };
            return h('article', { class: 'panel role' },
              h('div', { class: 'spread' }, h('h3', { text: role.name }), h('span', { class: 'faint', text: role.hiredCount ? role.hiredCount + ' in the org' : 'New' })),
              h('p', { class: 'muted', style: 'font-size:13.5px', text: role.job }),
              h('dl', null, h('dt', { text: 'Tools' }), h('dd', { text: role.tools.join(', ') || 'None beyond its folder' }), h('dt', { text: 'Budget' }), h('dd', { text: money(role.budgetUSDPerMonth) + ' a month' })),
              h('div', { class: 'spread', style: 'align-items:center;margin-top:auto' },
                h('span', { class: 'fit-' + role.fit, text: role.fit === 'fits' ? 'Fits your allowance' : role.fit === 'needsApproval' ? 'Needs an approver' : (role.why || 'Not open to you') }), btn));
          }))));
      }
      wrap.appendChild(describe(ctx));
      nodes.push(h('section', { class: 'stack' }, h('h2', { class: 'section-title', text: roles.length ? 'Something else' : 'Describe the job' }), wrap));
      nodes.push(publishPanel());
      return nodes;
    });
  }

  function show(ctx, r) {
    ctx.wrap.textContent = '';
    if (r.ok === false) { state.hire = null; ctx.wrap.appendChild(describe(ctx, r.error)); return; }
    state.hire = r.hire;
    ctx.wrap.appendChild(r.hire.contract ? offer(r.hire, ctx) : questions(r.hire, ctx));
  }

  var IDEAS = [
    { label: 'Competitor watcher', text: 'Watch our competitors’ websites and tell me each week what changed in pricing and positioning, with links.' },
    { label: 'Feedback sorter', text: 'Read new customer feedback each morning and group it into themes, with a quote for each.' },
    { label: 'PRFAQ writer', text: 'Turn a feature idea and its evidence into a one-page PRFAQ, working backwards from the customer.' }
  ];

  function describe(ctx, error) {
    var job = h('textarea', { placeholder: 'What should it do, for whom, and from which sources?', 'aria-label': 'Job description', style: 'min-height:120px' });
    var out = h('div');
    if (error) out.appendChild(h('div', { class: 'msg err', text: error }));
    var draft = h('button', { class: 'btn go', text: 'Draft the offer' });
    draft.onclick = function () {
      if (job.value.trim().length < 20) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', text: 'Say a little more: what it does, for whom, from which sources.' })); job.focus(); return; }
      busy(draft, 'Drafting…');
      out.textContent = ''; out.appendChild(thinking('Reading the job and writing an offer. This takes a minute.'));
      api('POST', '/api/hires/draft', { jobDescription: job.value }).then(function (r) { show(ctx, r); });
    };
    return h('div', { class: 'stack' }, steps(0), h('div', { class: 'panel pad stack' },
      job,
      h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'faint', text: 'Or start from' }),
        IDEAS.map(function (idea) { return h('button', { class: 'chip dashed', text: idea.label, title: idea.text, onclick: function () { job.value = idea.text; job.focus(); } }); })),
      h('div', { class: 'spread', style: 'align-items:center' }, h('span', { class: 'faint', text: 'You’ll be its manager. Its questions come to you.' }), draft),
      out));
  }

  function questions(hire, ctx) {
    var boxes = hire.questions.map(function (q) { return { q: q, ta: h('textarea', { placeholder: 'Your answer', 'aria-label': q, style: 'min-height:60px' }) }; });
    var out = h('div');
    var cont = h('button', { class: 'btn go', text: 'Continue' });
    var skipBtn = h('button', { class: 'btn quiet', text: 'Skip, just draft it' });
    var submit = function (skip) {
      var answer = boxes.filter(function (b) { return b.ta.value.trim(); }).map(function (b) { return b.q + '\n' + b.ta.value.trim(); }).join('\n\n');
      if (!skip && !answer) { boxes[0].ta.focus(); return; }
      cont.disabled = skipBtn.disabled = true;
      out.textContent = ''; out.appendChild(thinking('Writing the offer…'));
      api('POST', '/api/hires/draft', { hireId: hire.hireId, answer: answer, skipQuestions: skip }).then(function (r) { show(ctx, r); });
    };
    cont.onclick = function () { submit(false); };
    skipBtn.onclick = function () { submit(true); };
    setTimeout(function () { if (boxes[0]) boxes[0].ta.focus(); }, 0);
    return h('div', { class: 'stack' }, steps(1), h('div', { class: 'panel pad stack', style: 'gap:18px' },
      h('p', { class: 'muted', text: 'The drafter wants a little more before it writes the offer. Answer what you can.' }),
      boxes.map(function (b) { return h('div', { class: 'qa' }, h('div', { class: 'quote', style: 'font-size:16px', text: b.q }), b.ta); }),
      h('div', { class: 'row' }, cont, skipBtn), out));
  }

  function fact(k, v) { return h('div', null, h('div', { class: 'fact-k', text: k }), h('div', { class: 'fact-v', text: v })); }

  function offer(hire, ctx) {
    var c = hire.contract;
    var reports = h('select', null, h('option', { value: '', text: 'Nobody, it’s at the top' }), ctx.workers.map(function (w) { return h('option', { value: w.id, text: w.name }); }));
    var vis = h('select', null, h('option', { value: 'private', text: 'Only me' }), h('option', { value: 'team', text: 'My team' }), h('option', { value: 'org', text: 'Everyone in the org' }));
    var budget = h('input', { type: 'number', min: '1', step: '1', value: String(c.budgetUSDPerMonth) });
    var offerSched = scheduleEditor(c.cadence || null);
    var where = ctx.projects.length
      ? h('select', null, ctx.projects.map(function (p) { return h('option', { value: p.path, text: p.name, selected: c.projectPath === p.path }); }))
      : h('p', { class: 'msg err', text: 'No place to work yet. An operator can add one with: overcli projects add <folder>' });
    var out = h('div');
    var hireBtn = h('button', { class: 'btn go', text: 'Hire ' + c.name, disabled: !ctx.projects.length });
    hireBtn.onclick = function () {
      var restore = busy(hireBtn, 'Hiring…');
      var options = { visibility: vis.value, budgetUSDPerMonth: Number(budget.value), cadence: offerSched.value() };
      if (reports.value) options.reportsTo = reports.value;
      if (where.value) options.projectPath = where.value;
      api('POST', '/api/hires/confirm', { hireId: hire.hireId, options: options }).then(function (r) {
        out.textContent = '';
        if (r.ok === false) { out.appendChild(msg(r)); restore(); return; }
        state.hire = null;
        ctx.wrap.textContent = '';
        ctx.wrap.appendChild(r.hired
          ? emptyState(r.hired.name + ' is hired.', 'You’re its manager. ' + (r.hired.cadence ? 'It runs ' + r.hired.schedule.toLowerCase() + ' and starts on probation, so you approve what it proposes. ' : 'It starts on probation and works when it’s asked. ') + 'Its questions come to you.',
              h('div', { class: 'row', style: 'justify-content:center' },
                h('button', { class: 'btn go', onclick: function () { openWorker(r.hired.id); }, text: 'Open ' + r.hired.name }),
                h('button', { class: 'btn', onclick: function () { render(); }, text: 'Hire another' })))
          : emptyState('Sent for approval.', (r.hire.reasons || []).join(' ') + ' An approver has been asked; you’ll hear back in Slack.'));
        refreshCounts();
      });
    };
    return h('div', { class: 'stack' }, steps(2), h('article', { class: 'panel offer' },
      h('div', { class: 'row', style: 'gap:16px;align-items:center' }, avatar('', c.name, 'l'),
        h('div', null, h('h2', { class: 'offer-name', text: c.name }), c.tagline ? h('div', { class: 'offer-tag', text: c.tagline }) : null)),
      h('div', { class: 'offer-job quote', text: c.jobDescription }),
      h('div', { class: 'ofacts' },
        fact('How it works', c.flows.length ? plural(c.flows.length, 'routine', 'routines') + ' it follows each run' : 'A routine written for this job'),
        fact('Tools', c.connectors.length ? c.connectors.join(', ') : 'None to start'),
        fact('Starts', 'On probation: you approve what it proposes')),
      h('div', { class: 'terms' },
        h('div', { class: 'field', style: 'grid-column:1/-1' }, h('span', { text: 'When it runs on its own' }), offerSched.node),
        h('label', { class: 'field' }, 'Works in', where),
        h('label', { class: 'field' }, 'Reports to', reports),
        h('label', { class: 'field' }, 'Who may ask it', vis),
        h('label', { class: 'field' }, 'Monthly budget (USD)', budget)),
      h('div', { class: 'offer-foot' }, hireBtn, h('button', { class: 'btn quiet', text: 'Start over', onclick: function () { api('POST', '/api/hires/cancel', { hireId: hire.hireId }).catch(function () {}); state.hire = null; render(); } })),
      out));
  }

  function publishPanel() {
    var ta = h('textarea', { placeholder: 'Paste a worker file here (in the overcli app: the worker’s Share card, Copy YAML)', 'aria-label': 'Worker file', style: 'min-height:90px;font-family:var(--mono);font-size:12.5px' });
    var out = h('div');
    var btn = h('button', { class: 'btn', text: 'Bring it to the org' });
    btn.onclick = function () {
      if (!ta.value.trim()) { ta.focus(); return; }
      var restore = busy(btn, 'Checking…');
      api('POST', '/api/publish', { yaml: ta.value }).then(function (r) {
        restore(); out.textContent = '';
        out.appendChild(r.ok === false ? msg(r) : msg({}, r.hired ? r.hired.name + ' is on the roster. You’re its manager.' : 'Sent for approval: ' + (r.hire.reasons || []).join(' ')));
        if (r.ok !== false) ta.value = '';
      });
    };
    return h('details', { class: 'panel pad' }, h('summary', { text: 'Bring a worker you built yourself' }),
      h('div', { class: 'stack', style: 'margin-top:12px' },
        h('p', { class: 'muted', style: 'font-size:13.5px', text: 'A worker you built in the overcli app can join the org. Its history stays on your machine; it arrives on probation with you as its manager. In the app, use Publish to your org on its Share card, or paste its file here.' }),
        ta, h('div', null, btn), out));
  }

  // ---- connect ---------------------------------------------------------

  function codeBlock(text) {
    var b = h('button', { class: 'btn small', text: 'Copy' });
    b.onclick = function () { navigator.clipboard.writeText(text).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); }); };
    return h('div', { class: 'code' }, h('pre', { text: text }), b);
  }

  function viewConnect() {
    var base = location.origin;
    var mcp = base + '/mcp';
    // Each tool gets a key of its own, made here and shown once, so signing
    // out this browser (or one tool) leaves the others working.
    var keys = {};
    var tok = '';
    var buildClients = function () { return [
      { id: 'claude-code', label: 'Claude Code', steps: [
        'Run this once on your machine. It adds your org as an MCP server for every project:',
        'claude mcp add --transport http --scope user overcli ' + mcp + ' \\\n  --header "Authorization: Bearer ' + tok + '"',
        'Then ask Claude Code: “what’s waiting on me in overcli?”, “hire me a competitive analyst” or “what did Luke deliver this week?”'] },
      { id: 'claude-desktop', label: 'Claude Desktop', steps: [
        'Add this to claude_desktop_config.json (Settings, Developer, Edit Config), then restart Claude:',
        JSON.stringify({ mcpServers: { overcli: { command: 'npx', args: ['-y', 'mcp-remote', mcp, '--header', 'Authorization:Bearer ' + tok] } } }, null, 2),
        'mcp-remote connects Claude Desktop to this server and needs Node.js on your machine.'] },
      { id: 'codex', label: 'Codex', steps: [
        'Put your token in your shell profile:',
        'export OVERCLI_ORG_TOKEN=' + tok,
        'Then add this to ~/.codex/config.toml:',
        '[mcp_servers.overcli]\nurl = "' + mcp + '"\nbearer_token_env_var = "OVERCLI_ORG_TOKEN"'] },
      { id: 'app', label: 'overcli app', steps: [
        'In the overcli app, open Settings, Advanced, Your org, paste this address and press Sign in. Your browser opens here to confirm it\u2019s you; there is nothing to copy.',
        base,
        'Then any worker you built can join the org: open it, and on its Share card choose Publish to your org. From a terminal:',
        'export OVERCLI_ORG_URL=' + base + '\nexport OVERCLI_ORG_TOKEN=' + tok + '\novercli workers push "Worker name"'] },
      { id: 'slack', label: 'Slack', steps: [
        'Nothing to set up: if your admin connected Slack, these work in any channel or DM:',
        '/worker                     your workers\n/worker waiting             what’s waiting on you\n/worker <name> ask <text>   ask a worker to do something\n/team <name>: <task>        give a team a task\n/hire <job>                 hire a worker\n/overcli join               ask to join, or get a new sign-in link',
        'Questions, approvals and the work your workers propose arrive as DMs. Reply in the thread to answer, or press a button.'] }
    ]; };
    var CLIENTS = buildClients();
    var current = CLIENTS[0].id;
    var NEEDS_KEY = { 'claude-code': 'Claude Code', 'claude-desktop': 'Claude Desktop', codex: 'Codex', app: 'Terminal' };
    var body = h('div', { class: 'stack' });
    var tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Where to connect' });
    var draw = function () {
      tablist.textContent = '';
      CLIENTS.forEach(function (c) { tablist.appendChild(h('button', { role: 'tab', 'aria-selected': c.id === current ? 'true' : 'false', text: c.label, onclick: function () { current = c.id; draw(); } })); });
      body.textContent = '';
      var device = NEEDS_KEY[current];
      if (device && !keys[current]) {
        var make = h('button', { class: 'btn go', text: 'Make a key for ' + device });
        var out = h('div');
        make.onclick = function () {
          var restore = busy(make, 'Making…');
          api('POST', '/api/devices', { device: device }).then(function (x) {
            restore();
            if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); return; }
            keys[current] = x.token; draw();
          });
        };
        append(body, [h('p', { class: 'muted', text: device + ' needs a key of its own. It shows once, and you can sign it out from People without touching anything else.' }), h('div', null, make), out]);
        return;
      }
      tok = keys[current] || '';
      buildClients().filter(function (c) { return c.id === current; })[0].steps.forEach(function (s, i) {
        body.appendChild(i % 2 === 1 ? codeBlock(s) : h('p', { class: 'muted', text: s }));
      });
      if (device) body.appendChild(h('p', { class: 'faint', text: 'This key is shown once. Treat it like a password.' }));
    };
    draw();
    return Promise.resolve([head('Connect', 'Use your org’s workers from Claude, Codex, the overcli app or Slack.'),
      h('section', { class: 'panel pad stack' },
        h('div', { class: 'spread', style: 'align-items:center' }, h('h2', { class: 'section-title', text: 'This server' }), h('span', { class: 'faint', text: state.me.org })),
        h('div', { class: 'ofacts', style: 'margin:0' }, fact('MCP address', mcp), fact('Console', base))),
      h('section', { class: 'panel pad stack' }, tablist, body),
      h('p', { class: 'faint', text: 'claude.ai connectors call from Anthropic’s cloud, so they can only reach this server if your admin has given it a public HTTPS address.' })]);
  }

  // ---- people ----------------------------------------------------------

  var ROLE_LABEL = { member: 'Ask workers', hirer: 'Hire workers', approver: 'Approve hires', admin: 'Admin' };
  var ROLE_HELP = {
    member: 'Ask the workers they can see, and rate their work.',
    hirer: 'All of that, plus hire and manage their own workers within an allowance.',
    approver: 'Hire, and decide hires that go over someone’s allowance.',
    admin: 'Everything: people, rules and every worker.'
  };
  var ROLE_OF = { Admin: 'admin', Approver: 'approver', Hirer: 'hirer', Member: 'member' };

  function roleSelect(value, label) {
    return h('select', { class: 'select-sm', 'aria-label': label }, ['member', 'hirer', 'approver', 'admin'].map(function (r) {
      return h('option', { value: r, text: ROLE_LABEL[r], selected: r === value });
    }));
  }

  function viewPeople() {
    return Promise.all([api('GET', '/api/admin/people'), api('GET', '/api/admin/invites'), api('GET', '/api/admin/requests'), api('GET', '/api/admin/health')]).then(function (r) {
      var ppl = r[0], inv = r[1], req = r[2], hl = r[3];
      if (ppl.ok === false) return [msg(ppl)];
      var nodes = [head('People', 'Everyone who can use ' + state.me.org + '’s workers. Each person is their Slack account, so their workers, questions and approvals follow them everywhere.',
        h('button', { class: 'btn go', onclick: function () { inviteDialog(); } }, icon('plus', 16), 'Invite people'))];

      if (req.ok !== false && req.requests.length) {
        nodes.push(h('section', { class: 'panel pad stack ask need', style: 'display:flex', 'aria-labelledby': 'asking' },
          h('h2', { id: 'asking', class: 'section-title', text: 'Asking to join' }),
          req.requests.map(function (q) {
            var out = h('div');
            var role = roleSelect('member', 'Let ' + q.name + ' in as');
            var decide = function (approve) {
              return function () {
                api('POST', '/api/admin/requests/' + encodeURIComponent(q.id), { approve: approve, role: role.value }).then(function (x) {
                  out.textContent = '';
                  if (x.ok === false) { out.appendChild(msg(x)); return; }
                  if (!approve) { out.appendChild(msg({}, 'Declined.')); return; }
                  out.appendChild(x.sentInSlack ? msg({}, 'Let in. Their link is in their Slack DMs.') : linkBox(x.link, 'Let in. Slack isn’t connected, so send them this link:'));
                  refreshCounts();
                });
              };
            };
            return h('div', { class: 'stack', style: 'gap:8px;padding-top:12px;border-top:1px solid var(--line)' },
              h('div', { class: 'row', style: 'gap:12px' }, avatar(q.slackUserId, q.name, 'm'),
                h('div', { style: 'flex:1 1 220px;min-width:0' }, h('div', null, h('b', { style: 'font-weight:600', text: q.name + ' ' }), h('span', { class: 'faint', text: q.slackUserId })),
                  h('div', { class: 'faint', text: 'Asked with /overcli join, ' + ago(q.at) + '.' })),
                h('div', { class: 'row' }, h('span', { class: 'faint', text: 'as' }), role,
                  h('button', { class: 'btn go small', text: 'Let in', onclick: decide(true) }),
                  h('button', { class: 'btn danger small', text: 'Decline', onclick: decide(false) }))),
              out);
          })));
      }

      var openState = hl.ok !== false && hl.rules.openJoin;
      var openToggle = h('input', { type: 'checkbox', checked: openState });
      var openNote = h('span', { class: 'faint', 'aria-live': 'polite' });
      openToggle.onchange = function () {
        var want = openToggle.checked;
        openToggle.disabled = true;
        api('POST', '/api/admin/open-join', { on: want }).then(function (x) {
          openToggle.disabled = false;
          if (x.ok === false) { openToggle.checked = !want; openNote.textContent = x.error; return; }
          openNote.textContent = 'Saved.';
        }, function () { openToggle.disabled = false; openToggle.checked = !want; openNote.textContent = 'That didn’t save. Try again.'; });
      };

      var table = h('div', { class: 'panel table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Person', 'Can', 'Workers', 'Spend of allowance', 'Signed in on', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, ppl.people.map(personRows))));

      nodes.push(h('div', { class: 'people-grid' },
        h('section', { class: 'stack', 'aria-labelledby': 'ppl' }, h('h2', { id: 'ppl', class: 'section-title', text: plural(ppl.people.length, 'person', 'people') }), table),
        h('aside', { class: 'stack' },
          h('section', { class: 'panel pad stack', style: 'gap:10px', 'aria-labelledby': 'pend' },
            h('h2', { id: 'pend', class: 'section-title', text: 'Invites not yet used' }),
            inv.ok === false ? msg(inv) : inv.invites.length ? inv.invites.map(inviteRow) : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'None waiting.' })),
          h('section', { class: 'panel pad stack', style: 'gap:10px', 'aria-labelledby': 'ways' },
            h('h2', { id: 'ways', class: 'section-title', text: 'Other ways people get in' }),
            h('p', { class: 'muted', style: 'font-size:13.5px' }, 'Anyone in your Slack can type ', h('code', { text: '/overcli join' }), '. Slack has already said who they are, so they land in Asking to join for you to let in.'),
            h('p', { class: 'muted', style: 'font-size:13.5px', text: 'In the overcli app, Settings, Your org, Sign in pairs the app with this server: the person confirms a code here, and nobody copies a token.' }),
            h('label', { class: 'toggle' }, openToggle, h('span', { text: 'Let anyone in our Slack in without asking. They can ask workers things; make them hirers here.' })), openNote,
            hl.ok !== false && !hl.rules.publicUrl ? h('p', { class: 'faint', text: 'Links sent from Slack use the address you last opened this console at. Set publicUrl in org.json to pin it.' }) : null))));
      return nodes;
    });
  }

  function linkBox(link, label) {
    var copy = h('button', { class: 'btn small', text: 'Copy link' });
    copy.onclick = function () { navigator.clipboard.writeText(link).then(function () { copy.textContent = 'Copied'; }); };
    return h('div', { class: 'stack', style: 'gap:6px' }, h('p', { class: 'muted', style: 'font-size:13px', text: label }),
      h('div', { class: 'code' }, h('pre', { text: link }), copy));
  }

  function inviteRow(i) {
    var out = h('div');
    var meta = (i.sentInSlack ? 'Sent in Slack ' : 'Link made ') + ago(i.createdAt) + ' by ' + i.invitedBy + '. ' + ROLE_LABEL[i.role] + '.';
    return h('div', { class: 'stack', style: 'gap:4px;padding-top:8px;border-top:1px solid var(--line)' },
      h('div', { class: 'spread', style: 'align-items:center' },
        h('b', { style: 'font-weight:600', text: i.name }),
        h('div', { class: 'row', style: 'gap:4px' },
          h('button', { class: 'btn quiet small', text: 'Send again', onclick: function () {
            api('POST', '/api/admin/invites', { name: i.name, slackUserId: i.slackUserId, email: i.email, role: i.role }).then(function (x) {
              out.textContent = '';
              out.appendChild(x.ok === false ? msg(x) : x.sentInSlack ? msg({}, 'Sent again in Slack. The old link no longer works.') : linkBox(x.link, 'A new link. The old one no longer works.'));
            });
          } }),
          h('button', { class: 'btn quiet small', text: 'Cancel', onclick: function () {
            api('POST', '/api/admin/invites/' + encodeURIComponent(i.id) + '/cancel').then(function () { render(); });
          } }))),
      h('span', { class: 'faint', text: meta }), out);
  }

  function personRows(p) {
    var pct = p.allowanceUSD ? Math.min(100, (p.spentUSD / p.allowanceUSD) * 100) : 0;
    var manage = h('tr', { class: 'manage', hidden: true });
    var role = p.slackUserId ? roleSelect(ROLE_OF[p.role] || 'member', 'What ' + p.name + ' can do') : h('span', { class: 'muted', text: p.role });
    var out = h('div');
    if (p.slackUserId) {
      role.onchange = function () {
        api('POST', '/api/admin/people/role', { slackUserId: p.slackUserId, role: role.value }).then(function (x) {
          out.textContent = ''; out.appendChild(x.ok === false ? msg(x) : x.note ? msg({ ok: false, error: x.note }) : msg({}, p.name + ' can now: ' + ROLE_LABEL[x.role].toLowerCase() + '.'));
          if (x.ok !== false) manage.hidden = false;
        });
      };
    }
    var allowance = h('input', { type: 'number', min: '0', step: '10', value: p.allowanceUSD != null ? String(p.allowanceUSD) : '', 'aria-label': 'Monthly allowance for ' + p.name, style: 'width:110px' });
    var saveAllowance = h('button', { class: 'btn small', text: 'Save allowance', onclick: function () {
      api('POST', '/api/admin/people/role', { slackUserId: p.slackUserId, role: role.value, allowanceUSD: Number(allowance.value) }).then(function (x) {
        out.textContent = ''; out.appendChild(msg(x, 'Allowance saved.'));
      });
    } });
    append(manage, h('td', { colspan: '6' }, h('div', { class: 'stack' },
      p.slackUserId ? h('div', { class: 'row' }, h('span', { class: 'faint', text: 'Monthly allowance (USD)' }), allowance, saveAllowance) : null,
      h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Signed in on' }),
        p.devices.length ? h('ul', { class: 'devices' }, p.devices.map(function (d) {
          var li = h('li', null, h('span', { text: d.where }), h('span', { class: 'faint', text: d.lastUsedAt ? 'used ' + ago(d.lastUsedAt) : 'not used yet' }),
            h('button', { class: 'btn quiet small', text: 'Sign out', onclick: function () {
              api('POST', '/api/devices/' + encodeURIComponent(d.id) + '/signout').then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else li.remove(); });
            } }));
          return li;
        })) : h('span', { class: 'muted', style: 'font-size:13px', text: 'Nowhere yet. They use Slack, or haven’t opened their invite.' })),
      p.slackUserId && p.slackUserId !== state.me.slackUserId ? h('div', null, h('button', { class: 'btn danger small', text: 'Sign ' + p.name + ' out everywhere', onclick: function () {
        if (!window.confirm('Sign ' + p.name + ' out of every device? Their workers keep running.')) return;
        api('POST', '/api/admin/people/signout', { slackUserId: p.slackUserId }).then(function (x) { out.textContent = ''; out.appendChild(msg(x, 'Signed out of ' + plural(x.count || 0, 'place', 'places') + '.')); });
      } })) : null,
      out)));
    var where = p.devices.length ? p.devices.map(function (d) { return d.where.replace(/^overcli app: /, 'App: '); }).slice(0, 2).join(', ') + (p.devices.length > 2 ? ' +' + (p.devices.length - 2) : '') : 'Slack only';
    var row = h('tr', null,
      h('td', null, h('div', { class: 'person-cell' }, avatar(p.slackUserId || '', p.name, 's'),
        h('div', null, h('div', { style: 'font-weight:600', text: p.name }), h('div', { class: 'faint', text: p.slackUserId || 'No Slack account' })))),
      h('td', null, role),
      h('td', { text: String(p.workers) }),
      h('td', { style: 'min-width:160px' }, h('div', { style: 'font-size:13px', text: money(p.spentUSD) + (p.allowanceUSD != null ? ' of ' + money(p.allowanceUSD) : '') }),
        p.allowanceUSD ? h('div', { class: 'meter' + (pct >= 85 ? ' high' : ''), style: 'margin-top:5px' }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })) : null),
      h('td', { class: 'muted', style: 'font-size:13px', text: where }),
      h('td', { style: 'text-align:right' }, h('button', { class: 'btn small', text: 'Manage', onclick: function () { manage.hidden = !manage.hidden; } })));
    return [row, manage];
  }

  function inviteDialog() {
    var picked = null;
    var scrim = h('div', { class: 'scrim' });
    var close = function () { scrim.remove(); };
    scrim.onclick = function (e) { if (e.target === scrim) close(); };
    scrim.onkeydown = function (e) { if (e.key === 'Escape') close(); };
    var who = h('input', { type: 'text', placeholder: 'Find someone in Slack, or type their name', 'aria-label': 'Who', autocomplete: 'off' });
    var slackId = h('input', { type: 'text', placeholder: 'Slack member ID, e.g. U012AB3CD (optional)', 'aria-label': 'Slack member ID' });
    var email = h('input', { type: 'text', placeholder: 'Email, for someone not in Slack yet (optional)', 'aria-label': 'Email' });
    var manual = h('div', { class: 'stack', style: 'gap:8px' }, slackId, email);
    var results = h('div', { class: 'picker', hidden: true, role: 'listbox', 'aria-label': 'People in Slack' });
    var chosen = h('div', { class: 'faint', hidden: true });
    var timer = null;
    var search = function () {
      api('GET', '/api/admin/slack-people?q=' + encodeURIComponent(who.value)).then(function (x) {
        results.textContent = '';
        if (x.ok === false || !x.slack) { results.hidden = true; return; }
        manual.hidden = true;
        results.hidden = !x.people.length;
        x.people.forEach(function (sp) {
          results.appendChild(h('button', { type: 'button', role: 'option', onclick: function () {
            picked = sp; who.value = sp.name; results.hidden = true;
            chosen.textContent = 'Slack: @' + sp.handle + ' (' + sp.id + '). The invite goes to their DMs.'; chosen.hidden = false;
          } }, avatar(sp.id, sp.name, 's'), h('span', null, h('b', { style: 'font-weight:600', text: sp.name + ' ' }), h('span', { class: 'faint', text: '@' + sp.handle + (sp.title ? ', ' + sp.title : '') }))));
        });
      });
    };
    who.oninput = function () { picked = null; chosen.textContent = ''; chosen.hidden = true; clearTimeout(timer); timer = setTimeout(search, 200); };
    search();
    var role = 'hirer';
    var allowance = h('input', { type: 'number', min: '0', step: '10', placeholder: 'Org default', style: 'width:130px', 'aria-label': 'Monthly allowance' });
    var roles = h('div', { class: 'roles-pick', role: 'radiogroup', 'aria-label': 'What they can do' }, ['member', 'hirer', 'approver', 'admin'].map(function (r) {
      var input = h('input', { type: 'radio', name: 'invite-role', value: r, checked: r === role });
      input.onchange = function () { role = r; };
      return h('label', null, input, h('span', null, h('b', { style: 'font-weight:600', text: ROLE_LABEL[r] }), h('span', { class: 'faint', style: 'display:block;font-size:13px', text: ROLE_HELP[r] })));
    }));
    var out = h('div');
    var send = h('button', { class: 'btn go', text: 'Send invite' });
    send.onclick = function () {
      var name = who.value.trim();
      if (!name) { who.focus(); return; }
      var body = { name: name, role: role };
      if (picked) body.slackUserId = picked.id;
      else { if (slackId.value.trim()) body.slackUserId = slackId.value.trim(); if (email.value.trim()) body.email = email.value.trim(); }
      if (allowance.value !== '') body.allowanceUSD = Number(allowance.value);
      var restore = busy(send, 'Sending…');
      api('POST', '/api/admin/invites', body).then(function (x) {
        restore(); out.textContent = '';
        if (x.ok === false) { out.appendChild(msg(x)); return; }
        out.appendChild(x.sentInSlack ? msg({}, 'Sent. ' + name + ' has a link in their Slack DMs.') : linkBox(x.link, 'Send ' + name + ' this link. It signs them in once and works for a week.'));
        who.value = ''; slackId.value = ''; email.value = ''; picked = null; chosen.textContent = ''; chosen.hidden = true;
      });
    };
    append(scrim, h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'inv-title' },
      h('div', null, h('h2', { id: 'inv-title', text: 'Invite someone to ' + state.me.org }),
        h('p', { class: 'muted', text: 'They get a one-time link that signs them in. It works for a week.' })),
      h('label', { class: 'field' }, 'Who', who), results, chosen, manual,
      h('div', { class: 'stack', style: 'gap:8px' }, h('span', { class: 'faint', text: 'What they can do' }), roles),
      h('div', { class: 'row' }, h('span', { class: 'faint', text: 'Monthly allowance (USD)' }), allowance),
      out,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn quiet', text: 'Close', onclick: close }), send)));
    document.body.appendChild(scrim);
    setTimeout(function () { who.focus(); }, 0);
  }

  // ---- join (an invite link) ---------------------------------------------

  function renderJoin(code) {
    var left = h('section', { class: 'solo-left' }, h('div', { class: 'row', style: 'gap:12px' }, brandMark(44), h('span', { class: 'serif', style: 'font-size:20px', text: 'overcli' })), thinking('Opening your invite…'));
    var right = h('section', { class: 'solo-right', 'aria-label': 'Where you’ll use it' });
    app.appendChild(h('div', { class: 'solo' }, left, right));
    fetch('/api/join/' + encodeURIComponent(code)).then(function (r) { return r.json(); }).then(function (info) {
      left.lastChild.remove();
      if (info.ok === false) {
        append(left, [h('h1', { text: 'This invite can’t be used' }), h('p', { class: 'lead', text: info.error }),
          token() ? h('div', null, h('a', { class: 'btn go', href: '/', text: 'Go to the console' })) : null]);
        right.appendChild(h('p', { class: 'muted', text: 'Invites work once and for a week. Whoever invited you can send a new one from People, or you can type /overcli join in Slack.' }));
        return;
      }
      document.title = 'Join ' + info.org + ' — overcli';
      var out = h('div');
      var join = h('button', { class: 'btn go', style: 'min-height:48px;font-size:15px', text: info.setup ? 'Sign in as the first admin' : 'Join ' + info.org + ' as ' + info.name });
      join.onclick = function () {
        var restore = busy(join, 'Joining…');
        fetch('/api/join/' + encodeURIComponent(code), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: 'Browser' }) })
          .then(function (r) { return r.json(); })
          .then(function (x) {
            if (x.ok === false) { restore(); out.textContent = ''; out.appendChild(msg(x)); return; }
            store(TOKEN_KEY, x.token);
            history.replaceState(null, '', '/');
            state.me = null;
            joined(right, info.org);
            join.remove();
            out.textContent = ''; out.appendChild(msg({}, 'You’re in. Pick where you’ll use it.'));
          });
      };
      append(left, [
        h('h1', { text: info.setup ? 'You\u2019re setting up ' + info.org + '\u2019s workers' : info.invitedBy + ' invited you to ' + info.org + '\u2019s workers' }),
        h('p', { class: 'lead', text: info.setup
          ? 'This link makes you the first admin. Next, invite your team from People: overcli sends each person a link like this one in Slack.'
          : 'AI workers that research, write and keep an eye on things for the team. You\u2019ll be able to ' + info.roleText + (info.allowanceUSD ? ', up to $' + info.allowanceUSD + ' a month' : '') + '.' }),
        h('div', { class: 'stack', style: 'max-width:440px;gap:10px' }, join,
          h('span', { class: 'faint', text: (info.setup ? 'This link' : 'This invite is for ' + info.name + ' and') + ' works once, until ' + new Date(info.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) + '.' })),
        out]);
      right.appendChild(h('h2', { class: 'faint', style: 'font-size:13px', text: 'After you join, you choose where to use it' }));
      right.appendChild(placesGrid(info.org, false));
    });
  }

  function placesGrid(org, live) {
    var base = location.origin;
    var place = function (title, text, cta, onclick) {
      return h('button', { type: 'button', class: 'place', onclick: live ? onclick : null, disabled: !live }, h('b', { text: title }), h('span', { class: 'muted', style: 'font-size:13.5px', text: text }), h('span', { class: 'cta', text: cta }));
    };
    var appText = h('div');
    return h('div', { class: 'stack' }, h('div', { class: 'places' },
      place('This browser', 'The console: what needs you, what came in, your workers.', 'Open the console', function () { location.href = '/'; }),
      place('The overcli app', 'Sign the app in, then publish workers you build there to ' + org + '.', 'Show me how', function () {
        appText.textContent = '';
        appText.appendChild(linkBox(base, 'In the overcli app: Settings, Advanced, Your org. Paste this address and press Sign in, then confirm the code it shows.'));
      }),
      place('Claude or Codex', 'Add ' + org + '’s workers as tools: “what’s waiting on me?”', 'Show me how', function () { state.tab = 'connect'; location.href = '/'; store('overcli-org-open', 'connect'); }),
      place('Just Slack', 'Nothing to install. Questions arrive as DMs; /worker and /hire work anywhere.', 'Done', function () { appText.textContent = ''; appText.appendChild(msg({}, 'All set. You can close this tab.')); })),
      appText);
  }

  function joined(right, org) {
    right.textContent = '';
    right.appendChild(h('h2', { class: 'faint', style: 'font-size:13px', text: 'Where will you use it?' }));
    right.appendChild(placesGrid(org, true));
  }

  // ---- pair (the overcli app asks to sign in) ---------------------------

  function renderPair(code) {
    var left = h('section', { class: 'solo-left' }, h('div', { class: 'row', style: 'gap:12px' }, brandMark(44), h('span', { class: 'serif', style: 'font-size:20px', text: 'overcli' })));
    var right = h('section', { class: 'solo-right' });
    app.appendChild(h('div', { class: 'solo' }, left, right));
    if (!token()) {
      append(left, [h('h1', { text: 'Sign in here first' }), h('p', { class: 'lead', text: 'The overcli app asked to sign in as you. Open your invite link in this browser first (or sign in with a token), then come back to this page.' })]);
      var t = h('input', { type: 'text', class: 'secret', placeholder: 'ocli_…', 'aria-label': 'Access token', autocomplete: 'off', 'data-1p-ignore': true });
      right.appendChild(h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Already have a token?', t),
        h('button', { class: 'btn go', text: 'Sign in', onclick: function () { if (t.value.trim()) { store(TOKEN_KEY, t.value.trim()); location.reload(); } } })));
      return;
    }
    api('GET', '/api/pair/' + encodeURIComponent(code)).then(function (info) {
      if (info.ok === false) {
        append(left, [h('h1', { text: 'That code didn’t work' }), h('p', { class: 'lead', text: info.error + ' Start again from the overcli app.' })]);
        return;
      }
      return api('GET', '/api/whoami').then(function (me) {
        var out = h('div');
        var allow = h('button', { class: 'btn go', style: 'min-height:48px;font-size:15px', text: 'Allow' });
        var deny = h('button', { class: 'btn', style: 'min-height:48px', text: 'Don’t allow' });
        var decide = function (yes) {
          return function () {
            allow.disabled = deny.disabled = true;
            api('POST', '/api/pair/' + encodeURIComponent(code), { allow: yes }).then(function (x) {
              out.textContent = '';
              out.appendChild(x.ok === false ? msg(x) : msg({}, yes ? 'Done. The overcli app is signed in as you. You can close this tab.' : 'Refused. The app was not signed in.'));
            });
          };
        };
        allow.onclick = decide(true); deny.onclick = decide(false);
        append(left, [
          h('h1', { text: 'Sign the overcli app in to ' + info.org + '?' }),
          h('p', { class: 'lead', text: info.device + ' asked to sign in as ' + me.name + '. Allow it only if you just pressed Sign in there and it shows this code.' }),
          h('div', { class: 'bigcode', 'aria-label': 'Code ' + code }, code.split('').map(function (ch) { return h('span', { class: ch === '-' ? 'dash' : '', text: ch }); })),
          h('div', { class: 'row' }, allow, deny), out]);
        right.appendChild(h('div', { class: 'stack' },
          h('h2', { class: 'faint', style: 'font-size:13px', text: 'What it can do' }),
          h('p', { class: 'muted', text: 'Everything you can do here, from the app: see your workers and their work, and publish workers you build there to ' + info.org + '. It gets its own sign-in, listed under your name on People, so it can be signed out on its own.' })));
      });
    });
  }

  // ---- admin -----------------------------------------------------------

  function viewAdmin() {
    return Promise.all([api('GET', '/api/admin/health'), api('GET', '/api/admin/people'), api('GET', '/api/admin/audit')]).then(function (r) {
      var hl = r[0], ppl = r[1], au = r[2];
      if (hl.ok === false) return [msg(hl)];
      var total = hl.spend.spentUSD || 0;
      return [head('Admin', 'Who can use the workers, the rules they work under, and whether everything is running.', null, hl.org.name || 'Your org'),
        h('section', { class: 'health', 'aria-label': 'Health' }, hl.items.map(function (it) {
          return h('div', { class: 'panel' }, h('span', { class: 'h' }, h('span', { class: 'light' + (it.ok === true ? ' ok' : it.ok === false ? ' bad' : '') }), it.name), h('span', { class: 'faint', text: it.detail }));
        })),
        h('section', { class: 'panel pad stack', 'aria-labelledby': 'sp' },
          h('div', { class: 'spread' }, h('h2', { id: 'sp', class: 'section-title', text: 'Spend this month, by manager' }), h('span', { class: 'big', style: 'font-size:22px', text: money(total) })),
          hl.spend.byManager.length ? h('div', { class: 'bars' }, hl.spend.byManager.map(function (m) {
            var pct = total ? (m.spentUSD / total) * 100 : 0;
            return h('div', null, h('span', { text: m.name }), h('div', { class: 'meter' }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })), h('span', { text: money(m.spentUSD) }));
          })) : h('p', { class: 'muted', text: 'No workers yet.' })),
        h('section', { class: 'panel pad spread', style: 'align-items:center' },
          h('div', null, h('h2', { class: 'section-title', text: 'People' }), h('p', { class: 'muted', style: 'font-size:13.5px', text: ppl.ok === false ? '' : plural(ppl.people.length, 'person has', 'people have') + ' access.' })),
          h('button', { class: 'btn', text: 'Manage people', onclick: function () { go('people'); } })),
        h('div', { class: 'split' },
          h('section', { class: 'narrow panel pad', 'aria-labelledby': 'ru' },
            h('h2', { id: 'ru', class: 'section-title', text: 'Rules' }),
            h('dl', { class: 'rules' },
              h('dt', { text: 'Who may hire' }), h('dd', { text: hl.rules.hirers }),
              h('dt', { text: 'Allowance per person' }), h('dd', { text: money(hl.rules.allowanceUSD) + ' a month' }),
              h('dt', { text: 'Approves hires over it' }), h('dd', { text: hl.rules.approvers.join(', ') || 'Admins' }),
              h('dt', { text: 'Visible to everyone needs' }), h('dd', { text: hl.rules.orgVisibilityNeedsAdmin ? 'An admin' : 'Nobody' }),
              h('dt', { text: 'Tools cleared for hires' }), h('dd', { text: hl.rules.clearedTools.join(', ') || 'None' }),
              h('dt', { text: 'Roles in the catalog' }), h('dd', { text: String(hl.rules.roles) }),
              h('dt', { text: 'Console address' }), h('dd', { text: hl.rules.publicUrl || 'Not set' })),
            h('p', { class: 'faint', text: 'Edit org.json on the server to change these. They apply without a restart.' })),
          h('section', { class: 'wide panel pad', 'aria-labelledby': 'lg' },
            h('h2', { id: 'lg', class: 'section-title', text: 'Recent decisions' }),
            au.ok === false ? msg(au) : au.entries.length ? h('ol', { class: 'log' }, au.entries.map(function (e) {
              return h('li', null, h('span', { class: 'faint', text: ago(e.at) }), h('span', null, h('b', { style: 'font-weight:600', text: e.by + ' ' }), e.what.charAt(0).toLowerCase() + e.what.slice(1)));
            })) : h('p', { class: 'muted', text: 'Nothing decided yet.' })))];
    });
  }

  render();
})();
`;
