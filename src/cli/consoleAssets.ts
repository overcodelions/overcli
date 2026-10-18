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

// The overcli app's own palette (src/renderer/styles.css): cool greys and
// the indigo accent, so the console and the desktop app read as one product.
const DARK = `
  --bg: #1c1c21; --side: #18181c; --panel: #24242b; --panel-2: #2a2a33; --line: #2f2f37; --line-2: #3d3d46;
  --ink: #e8e8ee; --muted: #a0a0a8; --faint: #8a8a93; --solid: #e8e8ee; --solid-ink: #17171c;
  --go: #7c8bff; --go-ink: #10121f; --go-soft: rgba(124, 139, 255, 0.16);
  --need: #f2b04a; --need-ink: #241700; --need-soft: rgba(242, 176, 74, 0.13);
  --bad: #ff8f84; --bad-ink: #2a0703; --bad-soft: rgba(255, 143, 132, 0.12); --bad-line: rgba(255, 143, 132, 0.35);
  --shadow: none;
  color-scheme: dark;`;

const LIGHT = `
  --bg: #f6f6f8; --side: #ececf0; --panel: #ffffff; --panel-2: #f6f6f8; --line: #dcdce2; --line-2: #c2c2cb;
  --ink: #17171c; --muted: #4a4a52; --faint: #6b6b74; --solid: #17171c; --solid-ink: #ffffff;
  --go: #4355e0; --go-ink: #ffffff; --go-soft: rgba(93, 114, 255, 0.11);
  --need: #8a4a07; --need-ink: #ffffff; --need-soft: #fbefdd;
  --bad: #b3261e; --bad-ink: #ffffff; --bad-soft: #fdecea; --bad-line: #f1c4bf;
  --shadow: none;
  color-scheme: light;`;

export const CONSOLE_CSS = `
/* The app's own faces: Bricolage Grotesque for display (served from the
   app's bundled file), the system face for text, SF Mono for code. The
   brand has no serif. */
@font-face { font-family: "Bricolage Grotesque"; font-style: normal; font-weight: 200 800; font-display: swap; src: url("/fonts/bricolage.woff2") format("woff2"); }
:root {${DARK}
  --serif: "Bricolage Grotesque", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
  --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
  --r-sm: 7px; --r: 10px; --r-lg: 14px;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {${LIGHT} } }
:root[data-theme="light"] {${LIGHT} }
:root[data-theme="dark"] {${DARK} }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
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
.nav button[aria-current="page"] { background: var(--go-soft); color: var(--go); font-weight: 600; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--go) 28%, transparent); }
.nav button[aria-current="page"] svg { opacity: 1; }
.nav .count { margin-left: auto; min-width: 20px; padding: 0 7px; border-radius: 999px; font-size: 11.5px; font-weight: 650; text-align: center; line-height: 19px; background: #f5b547; color: #16171a; }
.nav .issue { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--bad); }
.nav button[aria-current="page"] .issue { color: inherit; opacity: 0.85; }
.nav .sep { height: 1px; background: var(--line); margin: 10px 6px; }
.nav .group { padding: 4px 10px 6px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.nav-foot-link { background: none; border: 0; padding: 0; color: var(--go); font-size: 13px; cursor: pointer; text-align: left; }
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
.page-title { font-family: var(--serif); font-size: 38px; font-weight: 400; line-height: 1.1; letter-spacing: -0.03em; font-variation-settings: "opsz" 96, "wdth" 100; }
.serif, .ask-name, .item .t, .who-name, .card-name, .person-name, .role h3, .offer-name, .dialog h2, .solo h1, .big, .brand-name, .place b { letter-spacing: -0.02em; font-weight: 500; }
.label { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.main { padding: 32px clamp(20px, 3vw, 56px) 64px; }
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
.banner { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; background: var(--bad-soft); border: 1px solid var(--bad-line); color: var(--ink); border-radius: 12px; padding: 14px 18px; }
.banner > span { flex: 1 1 320px; }
.btn.bad { background: var(--bad); border-color: var(--bad); color: var(--bad-ink); }
.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 3px 10px; }
.sdot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; display: inline-block; }
.sdot.working { background: var(--go); } .sdot.waiting { background: #d98a1c; } .sdot.stuck, .sdot.bad { background: var(--bad); } .sdot.ok { background: var(--go); }
.status { display: inline-flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
.status.working { color: var(--go); } .status.waiting { color: var(--need); } .status.stuck, .status.bad { color: var(--bad); }
.wgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.wcard { display: flex; flex-direction: column; gap: 12px; padding: 18px; text-align: left; cursor: pointer; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
.wcard:hover { border-color: var(--line-2); }
.wcard.attn { border-color: var(--bad-line); }
.wcard.paused { background: var(--side); border-style: dashed; }
.wcard > * { width: 100%; }
.wcard .status { width: auto; }
.wcard .foot-row { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; }
.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.bubble-me { align-self: flex-end; max-width: 80%; background: var(--solid); color: var(--solid-ink); border-radius: 14px 14px 4px 14px; padding: 10px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 4px 14px 14px 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.turn { display: flex; gap: 10px; align-items: flex-start; }
.turn > .bubble { flex: 1; }
.composer { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--line-2); }
.composer textarea { border: 0; background: transparent; min-height: 54px; font-size: 15px; padding: 0; box-shadow: none; }
.composer textarea:focus { box-shadow: none; }
.setup-row { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.setup-row:last-child { border-bottom: 0; }
.setup-row .k { font-size: 12px; color: var(--muted); display: block; }
.setup-row .v { display: block; }
.rungs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.rungs li { text-align: center; padding: 8px 4px; border-radius: 9px; border: 1px dashed var(--line-2); color: var(--muted); font-size: 13px; }
.rungs li.on { background: var(--go); color: var(--go-ink); border: 1px solid var(--go); font-weight: 600; }
.rungs li.next { border-color: var(--go); color: var(--go); }
.checklist { list-style: none; margin: 0; padding: 0; }
.checklist li { display: flex; gap: 14px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
.checklist li > span { flex: 1; display: flex; flex-direction: column; }
.checklist .ck-ok { color: var(--go); } .checklist .ck-bad { color: var(--bad); } .checklist .ck-off { color: var(--faint); }
.hiresteps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.hiresteps li { display: flex; flex-direction: column; gap: 4px; padding: 14px 4px 0; border-top: 2px solid var(--line-2); }
.hiresteps li.on { border-top-color: var(--ink); }
.sgroup { display: grid; grid-template-columns: minmax(180px, 300px) minmax(0, 1fr); gap: 16px 32px; align-items: start; }
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
textarea, input[type=text], input[type=number], input[type=search], input[type=time], input[type=date], select { width: 100%; border: 1px solid var(--line-2); background: var(--bg); border-radius: var(--r-sm); padding: 9px 11px; line-height: 1.5; }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
textarea { min-height: 84px; resize: vertical; }
textarea::placeholder, input::placeholder { color: var(--faint); }
.inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
.inline-form > input { flex: 1 1 260px; min-height: 42px; }
.secret { -webkit-text-security: disc; font-family: var(--mono); letter-spacing: 0.04em; }
label.field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.alpha { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line-2); color: var(--muted); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px 20px; }
.picks { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.picks .toggle { font-size: 13px; }
.listed { display: flex; flex-direction: column; gap: 10px; }
.listed > .panel { box-shadow: none; background: var(--panel-2); padding: 14px; }
.foot { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); font-size: 12px; white-space: nowrap; }
.tag.need { background: var(--need-soft); border-color: transparent; color: var(--need); font-weight: 600; }
.tag.go { background: var(--go-soft); border-color: transparent; color: var(--go); }
.msg { font-size: 13px; padding: 8px 12px; border-radius: var(--r-sm); }
.msg.ok { background: var(--go-soft); color: var(--go); }
.msg.err { background: var(--bad-soft); color: var(--bad); }
.quote { font-size: 15.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
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
.ask.fix { border-color: var(--bad-line); }
.ask.done { opacity: 0.6; }
.tag.bad { background: var(--bad-soft); border-color: transparent; color: var(--bad); font-weight: 600; }
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
.light { display: inline-block; flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
.light.ok { background: var(--go); } .light.bad { background: var(--bad); }
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
  .rungs, .hiresteps, .sgroup { grid-template-columns: minmax(0, 1fr); }
  .nav .group { display: none; }
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
    back: [['path', 'M15 5l-7 7 7 7']],
    tool: [['path', 'M14.5 5.5a4 4 0 0 0 4.9 4.9l-8.6 8.6a2.1 2.1 0 0 1-3-3l8.6-8.6a4 4 0 0 0-1.9-1.9z']],
    inbox: [['path', 'M3 13l3-8h12l3 8v6H3z'], ['path', 'M3 13h5l1.5 2.5h5L16 13h5']],
    list: [['path', 'M4 7h16M4 12h16M4 17h10']],
    check: [['circle', 12, 12, 9], ['path', 'M8 12l3 3 5-6']],
    alert: [['circle', 12, 12, 9], ['path', 'M12 7v6M12 16.5v.5']],
    arrow: [['path', 'M4 12h12M12 6l6 6-6 6']],
    library: [['path', 'M5 4h4v16H5zM10 4h4v16h-4z'], ['path', 'M15.5 5.2l3.8-1 3.2 15.6-3.8 1z']],
    bolt: [['path', 'M13 3L5 14h6l-1 7 8-11h-6z']]
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
  function openWorker(id) { go('worker', { workerId: id, workerTab: 'talk' }); }

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
    var lead = h('p', { class: 'muted', text: 'Open the sign-in link overcli sent you in Slack. Lost it, or in a new browser? Type /overcli join in Slack for a fresh one, or ask your admin to invite you again.' });
    var ssoSlot = h('div');
    var tokenBox = h('details', null, h('summary', { class: 'faint', text: 'Sign in with an access token instead' }),
      h('div', { class: 'stack', style: 'margin-top:10px' }, input, err, h('button', { class: 'btn go', onclick: submit, text: 'Sign in' })));
    // With company sign-in on, that is the way in.
    fetch('/api/sso').then(function (r) { return r.json(); }).then(function (st) {
      if (!st.enabled) return;
      ssoSlot.appendChild(ssoButton(st, '/'));
      lead.textContent = st.required ? 'Sign in with your company account.' : 'Sign in with your company account, or open the sign-in link overcli sent you in Slack.';
    }).catch(function () {});
    return h('div', { class: 'login-wrap' }, h('div', { class: 'login panel stack' },
      brandMark(48, 'mark'),
      h('div', { class: 'row', style: 'gap:10px' }, h('h1', { class: 'page-title', text: 'Your org’s workers' }), h('span', { class: 'alpha', text: 'alpha' })),
      lead, ssoSlot, tokenBox));
  }

  function ssoButton(st, next) {
    return h('a', { class: 'btn go', style: 'min-height:46px;justify-content:center', href: '/sso/start?next=' + encodeURIComponent(next), text: 'Sign in with ' + st.provider });
  }

  /// Back from the identity provider with a one-time code: swap it for this
  /// browser's sign-in, then go where the person was headed.
  function renderSsoDone() {
    var q = new URLSearchParams(location.search);
    var box = h('div', { class: 'login panel stack' }, brandMark(48, 'mark'));
    app.appendChild(h('div', { class: 'login-wrap' }, box));
    if (q.get('error')) {
      append(box, [h('h1', { class: 'page-title', text: 'Sign-in didn’t work' }), h('p', { class: 'muted', text: q.get('error') }),
        h('a', { class: 'btn go', href: '/sso/start?next=%2F', text: 'Try again' })]);
      return;
    }
    box.appendChild(thinking('Signing you in…'));
    fetch('/api/sso/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: q.get('code') || '' }) })
      .then(function (r) { return r.json(); })
      .then(function (x) {
        if (x.ok === false) { box.lastChild.remove(); append(box, [h('p', { class: 'msg err', role: 'alert', text: x.error }), h('a', { class: 'btn go', href: '/sso/start?next=%2F', text: 'Try again' })]); return; }
        store(TOKEN_KEY, x.token);
        state.me = null;
        var next = q.get('next') || '/';
        location.replace(/^\/(?!\/)/.test(next) ? next : '/');
      });
  }

  // ---- shell -----------------------------------------------------------

  /// The day's work up top; the org's setup in its own group, for admins.
  function tabs() {
    var t = [
      { id: 'today', label: 'Inbox', icon: 'inbox', count: 'today' },
      { id: 'library', label: 'Library', icon: 'library' },
      { id: 'workers', label: 'Workers', icon: 'people' },
      { id: 'teams', label: 'Teams', icon: 'team' },
      { id: 'hire', label: 'Hire', icon: 'plus' }
    ];
    if (state.me && state.me.admin) {
      t.push('sep', { group: 'Org' });
      t.push({ id: 'setup', label: 'Setup', icon: 'list', issue: 'setup' });
      t.push({ id: 'people', label: 'People', icon: 'person', count: 'people' });
      t.push({ id: 'admin', label: 'Activity', icon: 'doc' });
    }
    return t;
  }

  /// Which nav item a page belongs under.
  function navFor(tab) {
    return { worker: 'workers', chart: 'workers', work: 'today', tools: 'setup', rules: 'setup', log: 'admin' }[tab] || tab;
  }

  function refreshCounts() {
    if (state.me && state.me.admin) {
      api('GET', '/api/admin/requests').then(function (r) {
        state.counts.people = r.ok === false ? 0 : r.requests.length;
        document.querySelectorAll('[data-count="people"]').forEach(function (el) { el.textContent = state.counts.people ? String(state.counts.people) : ''; el.hidden = !state.counts.people; });
      }).catch(function () {});
    }
    if (state.me && state.me.admin) {
      api('GET', '/api/tools').then(function (r) {
        state.counts.setup = r.ok === false ? 0 : r.missing.length;
        document.querySelectorAll('[data-issue="setup"]').forEach(function (el) { el.textContent = state.counts.setup ? plural(state.counts.setup, 'issue', 'issues') : ''; el.hidden = !state.counts.setup; });
      }).catch(function () {});
    }
    return Promise.all([api('GET', '/api/today'), api('GET', '/api/tools').catch(function () { return { ok: false }; })]).then(function (r) {
      var t = r[0], tl = r[1];
      var fixes = tl && tl.ok !== false ? tl.missing.length : 0;
      state.counts.today = fixes + t.waiting.length + t.hireApprovals.length + t.proposals.length + t.teamTasks.filter(function (x) { return x.waitingOnYou; }).length;
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
    if (location.pathname === '/sso/done') { renderSsoDone(); return; }
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
    var activeTab = navFor(state.tab);
    app.appendChild(h('div', { class: 'frame' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, brandMark(32),
          h('div', null, h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'brand-name', text: 'overcli' }), h('span', { class: 'alpha', title: 'Org workers are an early alpha: expect rough edges and changes.', text: 'alpha' })), h('div', { class: 'brand-sub', text: me.org }))),
        h('nav', { class: 'nav', 'aria-label': 'Sections' }, tabs().map(function (t) {
          if (t === 'sep') return h('div', { class: 'sep', 'aria-hidden': 'true' });
          if (t.group) return h('div', { class: 'group', text: t.group });
          return h('button', { 'aria-current': activeTab === t.id ? 'page' : null, onclick: function () { go(t.id); } },
            icon(t.icon), t.label,
            t.count ? h('span', { class: 'count', 'data-count': t.count, hidden: !state.counts[t.count], text: state.counts[t.count] ? String(state.counts[t.count]) : '' }) : null,
            t.issue ? h('span', { class: 'issue', 'data-issue': t.issue, hidden: !state.counts[t.issue], text: state.counts[t.issue] ? plural(state.counts[t.issue], 'issue', 'issues') : '' }) : null);
        })),
        h('div', { class: 'me' },
          h('button', { class: 'nav-foot-link', text: 'Use from Slack or Claude', onclick: function () { go('connect'); } }),
          h('div', { class: 'me-row' }, avatar('', me.name, 's'),
            h('div', null, h('div', { class: 'me-name', text: me.name }), h('div', { class: 'me-role', text: me.admin ? 'Admin' : me.canHire ? 'Can hire' : 'Member' }))),
          me.allowanceUSD != null ? h('div', { class: 'allowance stack', style: 'gap:6px' },
            h('div', { class: 'allow-label' }, h('span', { text: 'Your monthly allowance' }), h('span', { text: money(me.committedUSD) + ' of ' + money(me.allowanceUSD) })),
            h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' }))) : null,
          themeSwitch(),
          h('button', { class: 'linkish', onclick: function () { var done = function () { store(TOKEN_KEY, null); state.me = null; render(); }; api('POST', '/api/signout').then(done, done); }, text: 'Sign out' }))),
      h('main', { class: 'main' }, main)));
    refreshCounts();
    if (state.tab === 'tools' || state.tab === 'rules') { state.setupTab = state.tab; state.tab = 'setup'; }
    var view = { today: viewToday, work: viewWork, workers: viewWorkers, worker: viewWorker, teams: viewTeams, chart: viewChart, hire: viewHire, people: viewPeople, admin: viewAdmin, connect: viewConnect, rules: viewRules, log: viewLog, tools: viewTools, setup: viewSetup, library: viewLibrary }[state.tab] || viewToday;
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
      var approve = h('button', { class: 'btn go', text: 'Approve' });
      var reject = h('button', { class: 'btn danger', text: 'Turn down' });
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
        h('span', { class: 'tag need', text: it.kind === 'question' ? 'Asks' : 'Wants approval' }),
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

  /// A delivered piece of work in a narrow column: title, who and when, and
  /// the same read and rate controls underneath rather than beside.
  function compactItem(d) {
    var detail = h('div', { hidden: true, style: 'white-space:pre-wrap;font-size:13.5px', text: d.summary || '' });
    var slot = h('div');
    return h('div', { class: 'stack', style: 'gap:6px;padding:14px 16px' },
      h('span', { style: 'font-weight:550', text: d.title }),
      h('span', { class: 'faint', text: [d.workerName, ago(d.at), d.costUSD != null ? money(d.costUSD) : null].filter(Boolean).join(' · ') }),
      h('div', { class: 'row', style: 'gap:6px' },
        d.summary ? h('button', { class: 'btn small', text: 'Read', onclick: function (e) { detail.hidden = !detail.hidden; e.target.textContent = detail.hidden ? 'Read' : 'Hide'; } }) : null,
        d.event ? h('button', { class: 'btn small quiet', text: 'In the Library', onclick: function () { go('library'); } }) : rateButtons(d, slot)),
      slot, d.summary ? detail : null);
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
    var go_ = h('button', { class: 'btn go', text: b.items.length === 1 ? 'Start it' : 'Start the ticked' });
    var skip = h('button', { class: 'btn', text: 'Skip today' });
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
        h('span', { class: 'tag need', text: 'Proposes ' + plural(b.items.length, 'thing', 'things') }),
        h('span', { class: 'faint', text: (b.task === 'errand' ? 'From an errand, ' : 'From its scheduled run, ') + ago(b.at) })),
      h('p', { class: 'muted', style: 'font-size:13.5px', text: 'It is on probation, so nothing starts until you say. Untick what you don’t want.' }),
      h('div', null, boxes.map(function (x) { return x.row; })),
      h('div', { class: 'row' }, go_, skip), out)]);
    return card;
  }

  // ---- today -----------------------------------------------------------

  var WORDS = ['Nothing', 'One thing', 'Two things', 'Three things', 'Four things', 'Five things', 'Six things', 'Seven things', 'Eight things', 'Nine things', 'Ten things'];

  /// A tool a worker needs that this server doesn't have: the commonest reason
  /// a worker quietly does nothing useful, so it heads the inbox.
  function fixCard(m) {
    var who = m.workers.join(', ');
    var name = m.name;
    return h('article', { class: 'panel ask fix' },
      h('span', { class: 'avatar m', style: 'background:var(--bad-soft);color:var(--bad)' }, icon('alert', 18)),
      h('div', { class: 'ask-body' },
        h('div', { class: 'ask-head' }, h('span', { class: 'tag bad', text: 'Fix' }), h('span', { class: 'ask-name', text: who + ' can’t reach ' + name })),
        h('p', { class: 'muted', text: (m.workers.length === 1 ? 'Its job needs ' : 'Their jobs need ') + m.name + ', which isn’t installed on this server, so ' + (m.workers.length === 1 ? 'it works' : 'they work') + ' without it.' +
          (m.template ? ' The setup came along from the desktop it was built on; only the secret is missing.' : '') }),
        state.me.admin
          ? h('div', { class: 'row' }, h('button', { class: 'btn go', text: 'Install ' + name, onclick: function () { go('setup', { setupTab: 'tools' }); } }))
          : h('p', { class: 'faint', text: 'Ask an admin to install it on Setup → Tools.' })));
  }

  /// "Ask a worker…" from anywhere on the inbox: pick who, say what.
  function quickAsk(workers) {
    if (!workers.length) return null;
    var who = h('select', { 'aria-label': 'Which worker', style: 'width:auto;border:0;background:transparent;padding:0 4px;font-weight:600' },
      workers.map(function (w) { return h('option', { value: w.id, text: w.name }); }));
    var text = h('input', { type: 'text', placeholder: 'Ask something, or give it a task…', 'aria-label': 'What to ask', style: 'border:0;background:transparent;box-shadow:none;padding:0;min-width:0;flex:1' });
    var out = h('div', { 'aria-live': 'polite' });
    var send = function () {
      if (!text.value.trim()) { text.focus(); return; }
      var w = workers.filter(function (x) { return x.id === who.value; })[0];
      api('POST', '/api/ask', { worker: who.value, message: text.value }).then(function (r) {
        out.textContent = '';
        if (r.ok === false) { out.appendChild(msg(r)); return; }
        text.value = '';
        out.appendChild(h('div', { class: 'msg ok' }, 'Asked ' + w.name + '. ', h('button', { class: 'linkish', style: 'color:inherit;text-decoration:underline;font-size:13px', text: 'Follow it on ' + w.name + '’s page', onclick: function () { openWorker(w.id); } })));
      });
    };
    text.onkeydown = function (e) { if (e.key === 'Enter') send(); };
    return h('div', { class: 'stack', style: 'gap:6px;flex:0 1 460px;min-width:280px' },
      h('div', { class: 'panel row', style: 'gap:8px;padding:6px 6px 6px 12px;flex-wrap:nowrap;border-color:var(--line-2)' },
        h('span', { class: 'faint', style: 'flex:none' }, icon('arrow', 16)), who, text, h('button', { class: 'btn go small', text: 'Ask', onclick: send })),
      out);
  }

  function viewToday() {
    return Promise.all([api('GET', '/api/today'), api('GET', '/api/tools').catch(function () { return { ok: false }; }), api('GET', '/api/workers'), api('GET', '/api/library').catch(function () { return []; })]).then(function (r) {
      var t = r[0], tl = r[1], workers = r[2].filter(function (w) { return w.enabled; });
      // Came in: what triggers delivered in the last day, then finished work.
      var dayAgo = Date.now() - 86400000;
      var events = (Array.isArray(r[3]) ? r[3] : []).filter(function (x) { return x.kind === 'event' && x.status === 'delivered' && x.at >= dayAgo; });
      t.delivered = events.map(function (x) { return { entryId: x.id, workerId: x.workerId, workerName: x.workerName, title: x.title, at: x.at, summary: x.body, event: true }; }).concat(t.delivered);
      var fixes = tl && tl.ok !== false ? tl.missing : [];
      var mineTasks = t.teamTasks.filter(function (x) { return x.waitingOnYou; });
      var needs = fixes.length + t.waiting.length + t.hireApprovals.length + mineTasks.length + t.proposals.length;
      var title = (WORDS[needs] || plural(needs, 'thing', 'things')) + (needs === 1 ? ' needs you' : needs === 0 ? ' needs you' : ' need you');
      var byWorker = {};
      t.delivered.forEach(function (d) { byWorker[d.workerName] = (byWorker[d.workerName] || 0) + 1; });
      var names = Object.keys(byWorker);
      var sub = names.length
        ? 'Since yesterday, ' + (names.length === 1 ? names[0] + ' delivered ' + plural(byWorker[names[0]], 'thing', 'things') : names.length === 2 ? names[0] + ' and ' + names[1] + ' delivered work' : names[0] + ', ' + names[1] + ' and ' + plural(names.length - 2, 'other', 'others') + ' delivered work') + '.'
        : needs ? 'Nothing new came in since yesterday.' : 'All quiet. Ask a worker for something, or check back after its next run.';
      var date = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      var pct = t.spend.allowanceUSD ? Math.min(100, (t.spend.spentUSD / t.spend.allowanceUSD) * 100) : 0;
      var nodes = [h('header', { class: 'page-head' },
        h('div', null, h('div', { class: 'eyebrow', text: date }), h('h1', { class: 'page-title', text: title }), h('p', { class: 'page-sub', text: sub })),
        quickAsk(workers))];
      var upcoming = t.crew.filter(function (w) { return w.nextShiftAt; }).sort(function (a, b) { return a.nextShiftAt - b.nextShiftAt; }).slice(0, 4);
      nodes.push(h('div', { class: 'split' },
        h('section', { class: 'wide', style: 'gap:14px', 'aria-labelledby': 'needs' },
          h('h2', { id: 'needs', class: 'label', text: 'Needs you' }),
          needs ? [fixes.map(fixCard), t.waiting.map(waitingCard), t.proposals.map(proposalCard), t.hireApprovals.map(hireApprovalCard), mineTasks.map(teamTaskCard)]
            : h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: 'You’re all caught up.' }),
                h('p', { text: t.crew.length ? 'Questions, approvals and proposed work from your workers land here.' : 'Hire a worker and what it needs from you lands here.' }),
                !t.crew.length && state.me.canHire ? h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn go', text: 'Hire your first worker', onclick: function () { go('hire'); } })) : null)),
        h('aside', { class: 'narrow', style: 'gap:24px' },
          h('section', { class: 'stack', 'aria-labelledby': 'came' },
            h('div', { class: 'spread' }, h('h2', { id: 'came', class: 'label', text: 'Came in' }), h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'All work', onclick: function () { go('work'); } })),
            t.delivered.length ? h('div', { class: 'panel list' }, t.delivered.slice(0, 6).map(compactItem))
              : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Nothing since yesterday.' })),
          h('section', { class: 'panel pad stack', style: 'gap:10px', 'aria-labelledby': 'month' },
            h('h2', { id: 'month', class: 'label', text: 'Your workers this month' }),
            h('div', { class: 'row', style: 'align-items:baseline' }, h('span', { class: 'big', text: money(t.spend.spentUSD) }),
              h('span', { class: 'muted', text: (t.spend.allowanceUSD != null ? 'of ' + money(t.spend.allowanceUSD) + ' · ' : '') + 'on track for ' + money(t.spend.projectedUSD) })),
            t.spend.allowanceUSD ? h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })) : null),
          upcoming.length ? h('section', { class: 'stack', style: 'gap:8px', 'aria-labelledby': 'next' },
            h('h2', { id: 'next', class: 'label', text: 'Coming up' }),
            h('div', { class: 'sched' }, upcoming.map(function (w) { return [h('span', { class: 'faint', text: when(w.nextShiftAt) }), h('button', { class: 'linkish', style: 'color:var(--ink);font-size:13.5px', text: w.name, onclick: function () { openWorker(w.id); } })]; }))) : null)));
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

  /// What a worker is up to, in a few words, and how loudly to say it.
  function workerStatus(w) {
    var missing = (w.tools || []).filter(function (t) { return !t.ok; }).map(function (t) { return t.name; });
    if (!w.enabled) return { cls: '', text: 'Paused' };
    if (missing.length) return { cls: 'bad', text: 'Can’t reach ' + missing.join(', ') + (w.waiting ? ' · ' + w.waiting + ' waiting on you' : '') };
    if (w.waiting) return { cls: 'waiting', text: 'Waiting on you: ' + plural(w.waiting, 'thing', 'things') };
    if (w.state === 'working') return { cls: 'working', text: 'Working' };
    if (w.state === 'stuck') return { cls: 'stuck', text: 'Stuck: its last run failed' };
    return { cls: '', text: 'Idle · ' + (w.nextRunAt ? 'next run ' + when(w.nextRunAt) : 'works when asked') };
  }

  function workerCard(w) {
    var st = workerStatus(w);
    return h('button', { type: 'button', class: 'wcard' + (st.cls === 'bad' ? ' attn' : '') + (w.enabled ? '' : ' paused'), onclick: function () { openWorker(w.id); } },
      h('span', { class: 'row', style: 'gap:12px;flex-wrap:nowrap' }, avatar(w.id, w.name, 'l'),
        h('span', { style: 'display:flex;flex-direction:column;min-width:0' }, h('span', { style: 'font-weight:600;font-size:16px', text: w.name }), h('span', { class: 'who-tag', text: w.tagline }))),
      h('span', { class: 'status ' + st.cls }, h('span', { class: 'sdot ' + (st.cls || (w.state === 'working' ? 'working' : '')) }), st.text),
      h('span', { class: 'foot-row' }, h('span', { text: (w.manager || 'No manager') + ' · ' + w.schedule.toLowerCase().replace(/^when asked$/, 'when asked') }), h('span', { text: money(w.spentThisMonthUSD) + ' of ' + money(w.budgetUSDPerMonth) })));
  }

  function viewWorkers() {
    return api('GET', '/api/workers').then(function (list) {
      if (!list.length) return [head('Workers'), emptyState('No workers you can see yet.', 'Hire one, or ask your admin to make a team’s workers visible to you.', hireButton())];
      var filter = state.workersFilter || 'all';
      var attention = function (w) { return workerStatus(w).cls === 'bad' || w.waiting > 0 || w.state === 'stuck'; };
      var counts = { all: list.length, mine: list.filter(function (w) { return w.youManage; }).length, attention: list.filter(attention).length };
      var grid = h('div', { class: 'wgrid' });
      var query = h('input', { type: 'search', placeholder: 'Find a worker', 'aria-label': 'Find a worker', style: 'min-height:38px;border-radius:999px;padding:6px 14px' });
      var draw = function () {
        var q = query.value.trim().toLowerCase();
        grid.textContent = '';
        list.filter(function (w) {
          if (filter === 'mine' && !w.youManage) return false;
          if (filter === 'attention' && !attention(w)) return false;
          return !q || (w.name + ' ' + w.tagline).toLowerCase().indexOf(q) >= 0;
        }).forEach(function (w) { grid.appendChild(workerCard(w)); });
        if (!grid.children.length) grid.appendChild(h('p', { class: 'muted', text: 'No workers match.' }));
      };
      query.oninput = draw;
      draw();
      var waitingN = list.filter(function (w) { return w.waiting > 0; }).length;
      var working = list.filter(function (w) { return w.state === 'working'; }).length;
      var broken = list.filter(function (w) { return workerStatus(w).cls === 'bad'; }).length;
      var bits = [];
      if (waitingN) bits.push(plural(waitingN, 'waits', 'wait') + ' on you');
      if (working) bits.push(working + ' ' + (working === 1 ? 'is' : 'are') + ' working');
      if (broken) bits.push(broken + ' can’t reach a tool ' + (broken === 1 ? 'it needs' : 'they need'));
      var sub = plural(list.length, 'worker', 'workers') + '.' + (bits.length ? ' ' + bits.join(', ').replace(/^./, function (c) { return c.toUpperCase(); }) + '.' : ' All quiet.');
      var chip = function (id, label) {
        return h('button', { class: 'chip', 'aria-pressed': filter === id ? 'true' : 'false', text: label + ' · ' + counts[id], onclick: function () { state.workersFilter = id; render(); } });
      };
      return [head('Workers', sub, hireButton()),
        h('div', { class: 'row', role: 'group', 'aria-label': 'Show' }, chip('all', 'All'), chip('mine', 'Mine'), chip('attention', 'Needs attention'), h('span', { style: 'margin-left:auto;min-width:220px' }, query)),
        grid,
        h('p', { class: 'faint' }, 'Who reports to whom? ', h('button', { class: 'linkish', style: 'color:var(--go);font-size:12.5px', text: 'See the org chart', onclick: function () { go('chart'); } }), '.')];
    });
  }

  /// One question and its answer, as a turn of conversation. A question
  /// still being worked on says so; the page keeps checking until it is
  /// answered.
  function askItem(a) {
    var reply = a.status === 'working'
      ? thinking(a.workerName + ' is working on it… (asked ' + ago(a.at) + ')')
      : a.status === 'failed'
        ? h('div', { class: 'msg err', text: a.error || 'It could not answer.' })
        : h('div', { class: 'stack', style: 'gap:6px' }, h('div', { style: 'white-space:pre-wrap;overflow-wrap:anywhere', text: a.reply || '' }),
            a.launched ? h('div', { class: 'faint', text: 'Started ' + plural(a.launched, 'piece', 'pieces') + ' of work. It shows up here when done.' }) : null);
    return h('li', { class: 'stack', style: 'gap:10px', 'data-at': String(a.at) },
      h('div', { class: 'bubble-me', text: a.text }),
      h('div', { class: 'turn' }, avatar(a.workerId || a.workerName, a.workerName, 's'),
        h('div', { class: 'bubble' }, reply, h('span', { class: 'faint', text: (a.by ? a.by + ' · ' : '') + ago(a.at) + (a.doneAt && a.status !== 'working' ? ' · took ' + Math.max(1, Math.round((a.doneAt - a.at) / 1000)) + ' s' : '') }))));
  }

  function deliveredItem(d) {
    var slot = h('div');
    return h('li', { class: 'turn', 'data-at': String(d.at) },
      h('span', { class: 'avatar s person' }, icon('check', 15)),
      h('div', { class: 'bubble', style: 'border-radius:14px' },
        h('div', { class: 'spread' }, h('span', { style: 'font-weight:600', text: d.title }), h('span', { class: 'faint', text: ago(d.at) + (d.costUSD != null ? ' · ' + money(d.costUSD) : '') })),
        d.summary ? h('details', null, h('summary', { text: 'Read it' }), h('div', { style: 'white-space:pre-wrap;margin-top:8px;font-size:13.5px', text: d.summary })) : null,
        h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Useful?' }), rateButtons(d, slot)), slot));
  }

  function questionItem(q, w) {
    return h('li', { class: 'turn', 'data-at': String(q.at) }, avatar(w.id, w.name, 's'),
      h('div', { class: 'bubble', style: 'border-radius:14px' },
        h('span', { class: 'label', style: 'font-size:11.5px', text: 'It asked' }),
        h('span', { text: q.question }),
        q.waiting ? h('span', { class: 'tag need', style: 'align-self:flex-start', text: 'Waiting on a person — answer it on the Inbox' })
          : q.answer ? h('span', { class: 'muted', style: 'font-size:13.5px' }, h('b', { style: 'color:var(--ink);font-weight:600', text: (q.answeredBy || 'Someone') + ': ' }), q.answer)
          : h('span', { class: 'faint', text: 'Not answered' }),
        h('span', { class: 'faint', text: ago(q.at) })));
  }

  /// The conversation with a worker: a box to ask it something, then
  /// everything between you, newest first — answers, delivered work and the
  /// questions it asked.
  function conversation(w, d) {
    var input = h('textarea', { placeholder: 'Ask ' + w.name + ' something, or give it a task…', 'aria-label': 'Message for ' + w.name });
    var out = h('div', { 'aria-live': 'polite' });
    var items = []
      .concat((d.asks || []).map(function (a) { return { at: a.at, node: askItem(a), ask: a }; }))
      .concat((d.delivered || []).map(function (x) { return { at: x.at, node: deliveredItem(x) }; }))
      .concat((d.questions || []).map(function (q) { return { at: q.at, node: questionItem(q, w) }; }))
      .sort(function (a, b) { return b.at - a.at; });
    var list = h('ol', { class: 'timeline' }, items.map(function (x) { return x.node; }));
    // Follow one question until it is answered, while this page is showing.
    var follow = function (id, li) {
      if (!li.isConnected) return;
      api('GET', '/api/asks/' + encodeURIComponent(id)).then(function (x) {
        if (!li.isConnected || x.ok === false) return;
        if (x.ask.status === 'working') { setTimeout(function () { follow(id, li); }, 3000); return; }
        li.replaceWith(askItem(x.ask));
      }, function () { setTimeout(function () { follow(id, li); }, 6000); });
    };
    items.forEach(function (x) { if (x.ask && x.ask.status === 'working') setTimeout(function () { follow(x.ask.id, x.node); }, 3000); });
    var send = h('button', { class: 'btn go', style: 'margin-left:auto', text: 'Send' });
    var submit = function (preset) {
      var text = (preset || input.value).trim();
      if (!text) { input.focus(); return; }
      var restore = busy(send, 'Sending…');
      api('POST', '/api/ask', { worker: w.id, message: text }).then(function (r) {
        restore();
        out.textContent = '';
        if (r.ok === false) { out.appendChild(msg(r)); return; }
        input.value = '';
        var li = askItem({ id: r.askId, workerId: w.id, workerName: w.name, text: text, at: Date.now(), status: 'working', by: state.me.name });
        list.prepend(li);
        out.appendChild(h('p', { class: 'faint', text: 'You can leave this page: the answer is kept here' + (state.me.slackUserId ? ', and comes to you in Slack if it takes a while.' : '.') }));
        setTimeout(function () { follow(r.askId, li); }, 3000);
      });
    };
    send.onclick = function () { submit(); };
    input.onkeydown = function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); };
    var starters = ['What did you do on your last run?', 'What would you work on next?', 'What do you need from me?'];
    return h('section', { class: 'stack', style: 'gap:16px', 'aria-label': 'Conversation with ' + w.name },
      w.enabled ? h('div', { class: 'panel composer' }, input,
        h('div', { class: 'row' }, starters.map(function (t) { return h('button', { class: 'chip', style: 'min-height:32px;font-size:13px', text: t, onclick: function () { submit(t); } }); }), send), out)
        : h('p', { class: 'muted', text: w.name + ' is paused. Resume it to ask it things.' }),
      items.length ? list : h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: 'Nothing between you yet.' }), h('p', { text: 'Ask it something above. Its answers, the work it delivers and the questions it asks you all show up here.' })));
  }

  function viewWorker() {
    return Promise.all([api('GET', '/api/workers/' + encodeURIComponent(state.workerId) + '/detail'), api('GET', '/api/workers'),
      state.me.admin ? api('GET', '/api/admin/people') : Promise.resolve({ ok: false })]).then(function (r) {
      var d = r[0], all = r[1], ppl = r[2];
      if (d.ok === false) return [msg(d)];
      var w = d.worker;
      var out = h('div');
      var setTrust = function (level) {
        api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/trust', { trust: level }).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else render(); });
      };
      var rd = d.readiness;
      var RUNG = { probation: 'Asks first', trusted: 'Trusted', autonomous: 'On its own' };
      var explain = rd.level === 'probation' ? 'It proposes each run’s work and asks before anything leaves the server. ' : rd.level === 'trusted' ? 'It starts its own runs, and asks only before acting outside its sandbox. ' : 'It acts on its own. ';
      var trustCard = h('section', { class: 'panel pad stack', 'aria-labelledby': 'trust' },
        h('h2', { id: 'trust', class: 'label', text: 'How much it does alone' }),
        h('ol', { class: 'rungs', 'aria-label': 'Trust levels' }, ['probation', 'trusted', 'autonomous'].map(function (lvl) {
          return h('li', { class: lvl === rd.level ? 'on' : lvl === rd.readyFor ? 'next' : '', 'aria-current': lvl === rd.level ? 'step' : null, text: RUNG[lvl] });
        })),
        h('p', { style: 'font-size:13.5px', text: explain }, h('span', { class: 'muted', text: rd.reason })),
        w.youManage ? h('div', { class: 'row' },
          rd.readyFor && (rd.readyFor !== 'autonomous' || state.me.admin) ? h('button', { class: 'btn go small', text: 'Move to ' + RUNG[rd.readyFor].toLowerCase(), onclick: function () { setTrust(rd.readyFor); } }) : null,
          rd.level !== 'probation' ? h('button', { class: 'btn quiet small', text: 'Back to asks first', onclick: function () { setTrust('probation'); } }) : null) : null,
        out);

      var settings = null;
      if (w.youManage) {
        var reports = h('select', { 'aria-label': 'Reports to' }, h('option', { value: '', text: 'Nobody, it’s at the top' }),
          all.filter(function (x) { return x.id !== w.id; }).map(function (x) { return h('option', { value: x.id, text: x.name, selected: !!(w.reportsTo && w.reportsTo.id === x.id) }); }));
        var vis = h('select', { 'aria-label': 'Who may ask it' }, ['private', 'team', 'org'].map(function (v) { return h('option', { value: v, text: VIS[v], selected: w.visibility === v }); }));
        var budget = h('input', { type: 'number', min: '1', step: '1', value: String(w.budgetUSDPerMonth), 'aria-label': 'Monthly budget' });
        var sched = scheduleEditor(w.cadence);
        var saved = h('div');
        // Handing a worker to someone else is an admin's call.
        var mgr = null;
        if (state.me.admin && ppl.ok !== false) {
          var candidates = ppl.people.filter(function (p) { return p.slackUserId; });
          mgr = h('select', { 'aria-label': 'Manager' },
            h('option', { value: '', text: w.managerSlackUserId ? 'No manager of its own' : (w.manager ? w.manager + ' (through its boss)' : 'No manager') , selected: !w.managerSlackUserId }),
            candidates.map(function (p) { return h('option', { value: p.slackUserId, text: p.name, selected: p.slackUserId === w.managerSlackUserId }); }));
          mgr._people = candidates;
        }
        var letGo = h('button', { class: 'btn danger', text: 'Let ' + w.name + ' go' });
        var armed = null;
        letGo.onclick = function () {
          if (!armed) {
            letGo.textContent = 'Yes, let ' + w.name + ' go';
            saved.textContent = ''; saved.appendChild(h('div', { class: 'msg err', role: 'alert', text: 'This retires ' + w.name + ' for good. Its finished work and journal stay; its reports move up to its boss. Press again to confirm.' }));
            armed = setTimeout(function () { armed = null; letGo.textContent = 'Let ' + w.name + ' go'; saved.textContent = ''; }, 6000);
            return;
          }
          clearTimeout(armed);
          api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/retire').then(function (x) {
            if (x.ok === false) { saved.textContent = ''; saved.appendChild(msg(x)); return; }
            go('workers');
          });
        };
        // One section per question a manager asks: when, who, how much, and
        // the irreversible ones apart at the bottom.
        var group = function (title, sub, body) {
          return h('section', { class: 'panel pad sgroup' },
            h('div', null, h('h2', { class: 'section-title', text: title }), sub ? h('p', { class: 'faint', style: 'margin-top:4px', text: sub }) : null),
            h('div', { class: 'stack' }, body));
        };
        var saveAll = h('button', { class: 'btn go', text: 'Save changes' });
        saveAll.onclick = function () {
          var patch = { reportsTo: reports.value || null, visibility: vis.value, budgetUSDPerMonth: Number(budget.value), cadence: sched.value() };
          if (mgr && mgr.value !== (w.managerSlackUserId || '')) {
            var who = mgr._people.filter(function (p) { return p.slackUserId === mgr.value; })[0];
            patch.manager = who ? { name: who.name, slackUserId: who.slackUserId } : null;
          }
          var restore = busy(saveAll, 'Saving…');
          api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: patch })
            .then(function (x) { restore(); saved.textContent = ''; saved.appendChild(msg(x, 'Saved. It applies from its next run.')); });
        };
        settings = h('div', { class: 'stack', style: 'gap:16px' },
          group('When it runs', 'On its own schedule, or only when someone asks.', [sched.node]),
          group('Who it answers to', 'Its questions and approvals go here, climbing the chain if its boss can’t answer.', [
            h('div', { class: 'grid2' }, mgr ? h('label', { class: 'field' }, 'Manager', mgr) : h('div', { class: 'field' }, h('span', { text: 'Manager' }), h('span', { style: 'color:var(--ink)', text: w.manager || 'Nobody yet' })),
              h('label', { class: 'field' }, 'Reports to (another worker)', reports))]),
          group('Who can ask it', 'Anyone who can ask it can learn what its tools can reach.', [h('div', { style: 'max-width:360px' }, vis)]),
          group('Budget', 'At its budget it stops until the month turns.', [h('label', { class: 'field', style: 'max-width:240px' }, 'Monthly budget (USD)', budget),
            h('span', { class: 'faint', text: money(w.spentThisMonthUSD) + ' spent so far this month.' })]),
          h('div', { class: 'foot' }, saveAll, saved),
          h('section', { class: 'panel pad sgroup', style: 'border-color:var(--bad-line)' },
            h('div', null, h('h2', { class: 'section-title', text: 'Pause or let go' }), h('p', { class: 'faint', style: 'margin-top:4px', text: 'Pausing keeps everything; letting go retires it for good.' })),
            h('div', { class: 'row' },
              h('button', { class: 'btn', text: w.enabled ? 'Pause ' + w.name : 'Resume ' + w.name, onclick: function () {
                api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/paused', { paused: w.enabled }).then(function (x) { if (x.ok === false) { saved.textContent = ''; saved.appendChild(msg(x)); } else render(); });
              } }),
              letGo)));
      }

      // The job, readable at full width; its manager can rewrite it.
      var jobView = function () {
        var text = h('div', { style: 'white-space:pre-wrap;font-size:15px;line-height:1.65;max-width:84ch', text: d.jobDescription });
        var box = h('section', { class: 'panel pad stack', style: 'gap:16px' });
        var out = h('div', { 'aria-live': 'polite' });
        var edit = w.youManage ? h('button', { class: 'btn', text: 'Edit the job' }) : null;
        if (edit) edit.onclick = function () {
          var ta = h('textarea', { 'aria-label': w.name + '’s job', style: 'min-height:420px;font-size:14.5px;line-height:1.6' });
          ta.value = d.jobDescription;
          var save = h('button', { class: 'btn go', text: 'Save the job' });
          save.onclick = function () {
            var restore = busy(save, 'Saving…');
            api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { jobDescription: ta.value } }).then(function (x) {
              restore(); out.textContent = '';
              if (x.ok === false) { out.appendChild(msg(x)); return; }
              d.jobDescription = ta.value.trim(); render();
            });
          };
          box.textContent = '';
          append(box, [h('p', { class: 'muted', text: 'This is what ' + w.name + ' plans every run from. Say what to do, what to skip, and where things live.' }), ta,
            h('div', { class: 'foot' }, save, h('button', { class: 'btn quiet', text: 'Cancel', onclick: function () { render(); } }), out)]);
          ta.focus();
        };
        append(box, [h('div', { class: 'spread', style: 'align-items:center' }, h('h2', { class: 'label', text: 'The job it was hired for' }), edit), text]);
        return h('div', { class: 'split' }, h('div', { class: 'wide' }, box),
          h('aside', { class: 'narrow' }, h('section', { class: 'panel pad stack', style: 'gap:8px' },
            h('h2', { class: 'label', text: 'What it has learned' }),
            h('p', { class: 'faint', text: 'From your ratings and notes. It reads these alongside its job before every run.' }),
            d.learned.length ? h('ul', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13.5px' }, d.learned.map(function (l) { return h('li', { text: l.note }); }))
              : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Nothing yet.' }))));
      };

      var st = workerStatus(w);
      var missing = (w.tools || []).filter(function (t) { return !t.ok; }).map(function (t) { return t.name; });
      var tab = state.workerTab || 'talk';
      var change = w.youManage ? function () { state.workerTab = 'settings'; render(); } : null;
      var row = function (k, v, extra) {
        return h('div', { class: 'setup-row' }, h('span', { style: 'flex:1;min-width:0' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }), extra || null),
          change ? h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Change', onclick: change }) : null);
      };
      var pct = w.budgetUSDPerMonth > 0 ? Math.min(100, (w.spentThisMonthUSD / w.budgetUSDPerMonth) * 100) : 0;
      var job = h('div', { class: 'setup-row', style: 'align-items:flex-start' }, h('span', { style: 'flex:1;min-width:0' }, h('span', { class: 'k', text: 'Its job' }),
        h('span', { class: 'v', style: 'display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;font-size:13.5px', text: d.jobDescription })),
        h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px;flex:none', text: w.youManage ? 'Read or edit' : 'Read', onclick: function () { state.workerTab = 'job'; render(); } }));
      var onItsOwn = h('section', { class: 'panel pad stack', style: 'gap:8px', 'aria-labelledby': 'own' },
        h('div', { class: 'spread' }, h('h2', { id: 'own', class: 'label', text: 'What it does on its own' }),
          h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: (d.triggers || []).length ? 'Triggers' : w.youManage ? 'Add a trigger' : '', onclick: function () { state.workerTab = 'triggers'; render(); } })),
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { class: 'faint', style: 'display:inline-flex' }, icon('sun', 15)), h('span', { style: 'font-size:13.5px', text: w.cadence ? w.schedule : 'No schedule: works when asked' })),
        (d.triggers || []).map(function (t) {
          return h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { style: 'display:inline-flex;color:' + (t.enabled ? 'var(--go)' : 'var(--faint)') }, icon('bolt', 15)), h('span', { style: 'font-size:13.5px', text: t.name + (t.enabled ? '' : ' (off)') }));
        }),
        d.value && d.value.handled ? h('p', { class: 'faint', text: plural(d.value.handled, 'event', 'events') + ' handled this month' + (d.value.medianMinutes != null ? ', typically in ' + (d.value.medianMinutes < 1 ? 'under a minute' : Math.round(d.value.medianMinutes) + ' min') : '') + '.' }) : null);
      var aside = h('aside', { class: 'narrow', style: 'gap:14px', 'aria-label': 'Setup' },
        onItsOwn,
        trustCard,
        (w.tools || []).length ? h('section', { class: 'panel pad stack', style: 'gap:10px', 'aria-labelledby': 'tl' },
          h('h2', { id: 'tl', class: 'label', text: 'Tools' }),
          w.tools.map(function (t) {
            return h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { class: 'sdot ' + (t.ok ? 'ok' : 'bad') }), h('span', { style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: t.name, text: t.name }),
              t.ok ? h('span', { class: 'faint', text: 'Installed' }) : state.me.admin ? h('button', { class: 'linkish', style: 'color:var(--bad);font-size:13px', text: 'Not on this server — install', onclick: function () { go('setup', { setupTab: 'tools' }); } }) : h('span', { class: 'faint', style: 'color:var(--bad)', text: 'Not on this server' }));
          })) : null,
        h('section', { class: 'panel', style: 'padding:4px 16px', 'aria-label': 'Settings' },
          row('Runs', w.schedule + (w.nextRunAt ? ' · next ' + when(w.nextRunAt) : '')),
          row('Answers to', (w.manager || 'Nobody yet') + (w.managerInherited ? ' (through its boss)' : '')),
          w.reportsTo ? row('Reports to', w.reportsTo.name) : null,
          row('Who can ask it', VIS[w.visibility]),
          h('div', { class: 'setup-row', style: 'flex-direction:column;align-items:stretch;gap:8px' },
            h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { style: 'flex:1' }, h('span', { class: 'k', text: 'Budget' }), h('span', { class: 'v', text: money(w.spentThisMonthUSD) + ' of ' + money(w.budgetUSDPerMonth) + ' this month' })),
              change ? h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Change', onclick: change }) : null),
            h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' }))),
          job),
        h('section', { class: 'panel pad stack', style: 'gap:8px', 'aria-labelledby': 'learn' },
          h('h2', { id: 'learn', class: 'label', text: 'What it has learned' }),
          d.learned.length ? h('ul', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13.5px' }, d.learned.map(function (l) { return h('li', { text: l.note }); }))
            : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Nothing yet. Rate its work and it learns what you want.' }),
          h('p', { class: 'faint', text: 'Last 30 days: ' + plural(d.stats.runs, 'run', 'runs') + (d.stats.failed ? ', ' + d.stats.failed + ' failed' : '') + (d.stats.usefulPct != null ? ', ' + d.stats.usefulPct + '% rated useful' : '') + '.' })));

      return [h('div', null, h('button', { class: 'btn quiet small', onclick: function () { go('workers'); } }, icon('back', 16), 'All workers')),
        h('header', { class: 'row', style: 'gap:20px;align-items:center' }, avatar(w.id, w.name, 'xl'),
          h('div', { style: 'flex:1 1 320px;min-width:0' },
            h('div', { class: 'row', style: 'gap:12px' }, h('h1', { class: 'page-title', text: w.name }),
              h('span', { class: 'pill' }, h('span', { class: 'sdot ' + (st.cls || (w.state === 'working' ? 'working' : '')) }), st.text)),
            h('p', { class: 'page-sub', style: 'font-size:15px', text: w.tagline })),
          w.youManage && w.enabled ? h('button', { class: 'btn', text: 'Run now', onclick: function (e) {
            var restore = busy(e.target, 'Starting…');
            api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/run').then(function (x) {
              restore();
              var note = document.getElementById('run-note');
              if (note) { note.textContent = ''; note.appendChild(msg(x, w.name + ' is running. What it proposes lands in your Inbox.')); }
            });
          } }) : null,
          null),
        h('div', { id: 'run-note' }),
        missing.length ? h('div', { class: 'banner', role: 'status' },
          h('span', { style: 'color:var(--bad);flex:none' }, icon('alert', 20)),
          h('span', { text: w.name + '’s job needs ' + missing.join(', ') + ', which ' + (missing.length === 1 ? 'isn’t' : 'aren’t') + ' installed on this server — so it works without ' + (missing.length === 1 ? 'it' : 'them') + '.' }),
          state.me.admin ? h('button', { class: 'btn bad', text: 'Install ' + missing[0], onclick: function () { go('setup', { setupTab: 'tools' }); } }) : h('span', { class: 'faint', style: 'flex:none', text: 'Ask an admin to install it.' })) : null,
        h('div', { class: 'tabs', role: 'tablist', 'aria-label': w.name },
          [['talk', 'Conversation'], ['triggers', 'Triggers' + ((d.triggers || []).length ? ' · ' + d.triggers.length : '')], ['job', 'Job'], w.youManage ? ['settings', 'Settings'] : null].filter(Boolean).map(function (t) {
            return h('button', { role: 'tab', 'aria-selected': tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.workerTab = t[0]; render(); } });
          })),
        tab === 'triggers' ? triggersView(w, d)
          : tab === 'job' ? jobView()
          : tab === 'settings' && settings ? settings
          : h('div', { class: 'split' }, h('div', { class: 'wide' }, conversation(w, d)), aside)];
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
      wrap.appendChild(describe(ctx));
      var nodes = [head('What do you need done?', 'Describe the job the way you’d brief a new colleague: what it does, for whom, how often, and where the information lives. You review the worker before anything runs.'),
        wrap,
        h('ol', { class: 'hiresteps', 'aria-label': 'How hiring works' },
          h('li', { class: 'on' }, h('span', { class: 'faint', text: '1' }), h('b', { style: 'font-weight:600', text: 'You describe the job' }), h('span', { class: 'muted', style: 'font-size:13px', text: 'It may ask a question or two.' })),
          h('li', null, h('span', { class: 'faint', text: '2' }), h('b', { style: 'font-weight:600', text: 'You read its offer' }), h('span', { class: 'muted', style: 'font-size:13px', text: 'Its routine, schedule, tools and budget, in plain words. Change anything.' })),
          h('li', null, h('span', { class: 'faint', text: '3' }), h('b', { style: 'font-weight:600', text: 'It starts carefully' }), h('span', { class: 'muted', style: 'font-size:13px', text: 'It asks you before each run and before anything leaves the server, until it earns more trust.' })))];
      if (roles.length) {
        nodes.push(h('section', { class: 'stack' }, h('h2', { class: 'label', text: 'Or start from a role ' + state.me.org + ' has approved' }),
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
    var job = h('textarea', { placeholder: 'e.g. Every weekday morning, find the open bugs in our sprint, fix the small well-specified ones, and open a pull request for each.', 'aria-label': 'Describe the job', style: 'min-height:120px;border:0;background:transparent;box-shadow:none;padding:0;font-size:17px' });
    var out = h('div');
    if (error) out.appendChild(h('div', { class: 'msg err', text: error }));
    var draft = h('button', { class: 'btn go', text: 'Draft this worker' });
    draft.onclick = function () {
      if (job.value.trim().length < 20) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', text: 'Say a little more: what it does, for whom, from which sources.' })); job.focus(); return; }
      busy(draft, 'Drafting…');
      out.textContent = ''; out.appendChild(thinking('Reading the job and writing an offer. This takes a minute.'));
      api('POST', '/api/hires/draft', { jobDescription: job.value }).then(function (r) { show(ctx, r); });
    };
    var left = state.me.allowanceUSD != null ? state.me.allowanceUSD - (state.me.committedUSD || 0) : null;
    return h('div', { class: 'stack' }, h('div', { class: 'panel pad stack', style: 'border-color:var(--line-2)' },
      job,
      h('div', { class: 'spread', style: 'align-items:center;border-top:1px solid var(--line);padding-top:12px' },
        h('span', { class: 'status' }, h('span', { class: 'sdot ok' }), left != null ? (left > 0 ? 'Within your allowance: ' + money(left) + ' left this month' : 'Over your allowance: an approver will be asked') : 'You’ll be its manager. Its questions come to you.'),
        draft),
      out),
      h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'faint', text: 'Try:' }),
        IDEAS.map(function (idea) { return h('button', { class: 'chip', style: 'min-height:34px;font-size:13px', text: idea.label, title: idea.text, onclick: function () { job.value = idea.text; job.focus(); } }); })));
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
        h('tbody', null, ppl.people.map(function (p) { return personRows(p, ppl.people); }))));

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

  /// Someone has left: who takes their workers, then every way in closed.
  function offboardBox(p, everyone, out) {
    var others = everyone.filter(function (x) { return x.slackUserId && x.slackUserId !== p.slackUserId; });
    var to = h('select', { 'aria-label': 'Who takes over ' + p.name + '’s workers' },
      h('option', { value: '', text: p.workers ? 'Pick who takes over' : 'Nobody needed' }),
      others.map(function (x) { return h('option', { value: x.slackUserId, text: x.name }); }));
    var go_ = h('button', { class: 'btn danger small', text: p.name + ' has left' });
    var armed = false;
    go_.onclick = function () {
      if (p.workers && !to.value) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', role: 'alert', text: 'Pick who takes over ' + plural(p.workers, 'worker', 'workers') + ' first.' })); return; }
      if (!armed) {
        armed = true; go_.textContent = 'Yes, offboard ' + p.name;
        out.textContent = ''; out.appendChild(h('div', { class: 'msg err', role: 'alert', text: 'This hands their workers on, drops their hires in progress, signs them out everywhere and removes them from every rule. Press again to confirm.' }));
        return;
      }
      var who = others.filter(function (x) { return x.slackUserId === to.value; })[0];
      api('POST', '/api/admin/people/offboard', { slackUserId: p.slackUserId, to: who ? { name: who.name, slackUserId: who.slackUserId } : null }).then(function (x) {
        out.textContent = '';
        if (x.ok === false) { armed = false; go_.textContent = p.name + ' has left'; out.appendChild(msg(x)); return; }
        out.appendChild(msg({}, p.name + ' is offboarded.' + (x.workers && x.workers.length ? ' ' + x.workers.join(', ') + ' now report' + (x.workers.length === 1 ? 's' : '') + ' to ' + who.name + '.' : '')));
        setTimeout(render, 1800);
      });
    };
    return h('div', { class: 'stack', style: 'gap:6px;border-top:1px solid var(--line);padding-top:12px' },
      h('span', { class: 'faint', text: 'Offboarding' }), h('div', { class: 'row' }, to, go_));
  }

  function personRows(p, everyone) {
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
      p.slackUserId && p.slackUserId !== state.me.slackUserId ? offboardBox(p, everyone, out) : null,
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
      if (info.ssoRequired && !info.setup) {
        append(left, [h('h1', { text: info.invitedBy + ' invited you to ' + info.org + '\u2019s workers' }),
          h('p', { class: 'lead', text: info.org + ' signs in with its company account. Sign in, and your invite applies.' }),
          h('div', { style: 'max-width:360px' }, ssoButton({ provider: info.ssoProvider || 'your company account' }, '/'))]);
        return;
      }
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
      fetch('/api/sso').then(function (r) { return r.json(); }).then(function (st) {
        if (st.enabled) left.appendChild(h('div', { style: 'max-width:360px' }, ssoButton(st, '/pair?code=' + encodeURIComponent(code))));
      }).catch(function () {});
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
    return Promise.all([api('GET', '/api/admin/health'), api('GET', '/api/admin/people'), api('GET', '/api/admin/audit'), api('GET', '/api/admin/fleet')]).then(function (r) {
      var hl = r[0], ppl = r[1], au = r[2], fl = r[3];
      if (hl.ok === false) return [msg(hl)];
      var total = hl.spend.spentUSD || 0;
      return [head('Activity', 'Whether everything is running, what the workers cost, and every decision people made.', null, hl.org.name || 'Your org'),
        h('section', { class: 'health', 'aria-label': 'Health' }, hl.items.map(function (it) {
          return h('div', { class: 'panel' }, h('span', { class: 'h' }, h('span', { class: 'light' + (it.ok === true ? ' ok' : it.ok === false ? ' bad' : '') }), it.name), h('span', { class: 'faint', text: it.detail }));
        })),
        h('section', { class: 'panel pad stack', 'aria-labelledby': 'sp' },
          h('div', { class: 'spread' }, h('h2', { id: 'sp', class: 'label', text: 'Spend this month' }),
            h('span', { class: 'big', style: 'font-size:24px', text: money(total) + (hl.spend.orgBudgetUSD ? ' of ' + money(hl.spend.orgBudgetUSD) : '') })),
          hl.spend.orgBudgetUSD ? h('div', { class: 'meter' + (total / hl.spend.orgBudgetUSD >= 0.85 ? ' high' : ''), role: 'img', 'aria-label': Math.round((total / hl.spend.orgBudgetUSD) * 100) + '% of the org budget' },
            h('span', { style: 'width:' + Math.min(100, (total / hl.spend.orgBudgetUSD) * 100).toFixed(0) + '%' })) : null,
          spendBars('By manager', hl.spend.byManager, total),
          hl.spend.byTeam.length ? spendBars('By team', hl.spend.byTeam, total) : null),
        fl.ok !== false && fl.servers.length ? fleetPanel(fl.servers) : null,
        h('section', { class: 'panel pad', 'aria-labelledby': 'lg' },
          h('div', { class: 'spread', style: 'margin-bottom:8px' }, h('h2', { id: 'lg', class: 'label', text: 'Recent decisions' }), h('button', { class: 'btn small', text: 'Search and export', onclick: function () { go('log'); } })),
          au.ok === false ? msg(au) : au.entries.length ? h('ol', { class: 'log' }, au.entries.map(function (e) {
            return h('li', null, h('span', { class: 'faint', text: ago(e.at) }), h('span', null, h('b', { style: 'font-weight:600', text: e.by + ' ' }), e.what.charAt(0).toLowerCase() + e.what.slice(1)));
          })) : h('p', { class: 'muted', text: 'Nothing decided yet.' }))];
    });
  }


  // ---- rules -----------------------------------------------------------

  /// Tick boxes for the people who have access, plus a box for anyone else
  /// by Slack member ID. Reads back as a list of IDs.
  function peoplePicker(people, chosen, label) {
    var picked = {};
    (chosen || []).forEach(function (id) { picked[id] = true; });
    var known = people.filter(function (p) { return p.slackUserId; });
    var extra = h('input', { type: 'text', placeholder: 'Others, by Slack member ID (U012AB3CD), comma separated', 'aria-label': label + ': others by Slack member ID' });
    extra.value = (chosen || []).filter(function (id) { return !known.some(function (p) { return p.slackUserId === id; }); }).join(', ');
    var boxes = known.map(function (p) {
      var b = h('input', { type: 'checkbox', checked: !!picked[p.slackUserId] });
      return { id: p.slackUserId, box: b, el: h('label', { class: 'toggle' }, b, h('span', { text: p.name })) };
    });
    return {
      node: h('div', { class: 'stack', style: 'gap:8px', role: 'group', 'aria-label': label }, boxes.length ? h('div', { class: 'picks' }, boxes.map(function (b) { return b.el; })) : null, extra),
      value: function () {
        var ids = boxes.filter(function (b) { return b.box.checked; }).map(function (b) { return b.id; });
        extra.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
        return ids;
      }
    };
  }

  function ruleSection(title, sub, fields, collect) {
    var out = h('div', { 'aria-live': 'polite' });
    var save = h('button', { class: 'btn go', text: 'Save' });
    save.onclick = function () {
      var patch = collect();
      if (!patch) return;
      var restore = busy(save, 'Saving…');
      api('POST', '/api/admin/rules', { patch: patch }).then(function (x) {
        restore(); out.textContent = ''; out.appendChild(msg(x, 'Saved. It applies now.'));
      });
    };
    return h('section', { class: 'panel pad stack' },
      h('div', null, h('h2', { class: 'section-title', text: title }), sub ? h('p', { class: 'muted', style: 'font-size:13.5px', text: sub }) : null),
      fields, h('div', { class: 'foot' }, save, out));
  }

  function numOrNull(input) { var v = input.value.trim(); return v === '' ? null : Number(v); }
  function list(text) { return text.split(',').map(function (x) { return x.trim(); }).filter(Boolean); }

  function viewRules() {
    return Promise.all([api('GET', '/api/admin/rules'), api('GET', '/api/admin/people')]).then(function (r) {
      var res = r[0], ppl = r[1];
      if (res.ok === false) return [msg(res)];
      var R = res.rules, people = ppl.ok === false ? [] : ppl.people;

      // Who the org is.
      var name = h('input', { type: 'text', value: R.name, placeholder: 'Acme' });
      var url = h('input', { type: 'text', value: R.publicUrl, placeholder: 'https://overcli.acme.internal' });
      var tz = h('input', { type: 'text', value: R.timezone, placeholder: 'America/New_York' });
      var identity = ruleSection('The org', 'Its name, the address people use, and the time zone schedules run in.',
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Name', name), h('label', { class: 'field' }, 'Console address', url), h('label', { class: 'field' }, 'Time zone', tz)),
        function () { return { name: name.value.trim() || null, publicUrl: url.value.trim() || null, timezone: tz.value.trim() || null }; });

      // Hiring.
      var everyone = h('input', { type: 'checkbox', checked: R.hirers === '*' });
      var hirers = peoplePicker(people, R.hirers === '*' ? [] : R.hirers, 'Who may hire');
      var syncHirers = function () { hirers.node.style.display = everyone.checked ? 'none' : ''; };
      everyone.onchange = syncHirers; syncHirers();
      var allowance = h('input', { type: 'number', min: '0', step: '1', value: String(R.budgetAllowanceUSD) });
      var approvers = peoplePicker(people, R.approvers, 'Who approves hires over an allowance');
      var visAdmin = h('input', { type: 'checkbox', checked: R.orgVisibilityNeedsAdmin });
      var cleared = h('input', { type: 'text', value: R.allowedMcpServers.join(', '), placeholder: 'acme-crm, acme-docs' });
      var hiring = ruleSection('Hiring', 'Who may hire, what their workers may cost before a hire needs approval, and who approves.',
        h('div', { class: 'stack' },
          h('label', { class: 'toggle' }, everyone, h('span', { text: 'Everyone with access may hire' })),
          hirers.node,
          h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Allowance per person (USD a month)', allowance), h('label', { class: 'field' }, 'Tools any hire may have without approval', cleared)),
          h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Approves hires over an allowance (none ticked: the admins)' }), approvers.node),
          h('label', { class: 'toggle' }, visAdmin, h('span', { text: 'Making a worker visible to everyone needs an admin' }))),
        function () {
          return { hirers: everyone.checked ? '*' : hirers.value(), budgetAllowanceUSD: Number(allowance.value || 0), approvers: approvers.value(), orgVisibilityNeedsAdmin: visAdmin.checked, allowedMcpServers: list(cleared.value) };
        });

      // Spending.
      var cap = h('input', { type: 'number', min: '1', step: '1', value: R.orgBudgetUSD == null ? '' : String(R.orgBudgetUSD), placeholder: 'No cap' });
      var alertAt = h('input', { type: 'number', min: '0', max: '100', step: '5', value: String(R.alertAtPercent) });
      var spending = ruleSection('Spending', 'A cap on what every worker together may cost in a month, and when to warn people they are getting close.',
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Org-wide budget (USD a month)', cap), h('label', { class: 'field' }, 'Warn at (% of a budget; 0 for never)', alertAt)),
        function () { return { orgBudgetUSD: numOrNull(cap), alertAtPercent: Number(alertAt.value || 0) }; });

      // Records.
      var keep = h('input', { type: 'number', min: '7', step: '1', value: R.retentionDays == null ? '' : String(R.retentionDays), placeholder: 'Forever' });
      var records = ruleSection('Records', 'How long the decision log and finished runs are kept. Older ones are deleted each night.',
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Keep for (days, 7 or more)', keep)),
        function () { return { retentionDays: numOrNull(keep) }; });

      // Teams.
      var teamRows = h('div', { class: 'listed' });
      var addTeam = function (tname, members) {
        var n = h('input', { type: 'text', value: tname || '', placeholder: 'Product', 'aria-label': 'Team name' });
        var pick = peoplePicker(people, members || [], 'Team members');
        var row = h('div', { class: 'panel stack' }, h('div', { class: 'spread' }, h('label', { class: 'field', style: 'flex:1' }, 'Team', n),
          h('button', { class: 'btn quiet small', text: 'Remove', onclick: function () { row.remove(); } })), pick.node);
        row._read = function () { return { name: n.value.trim(), members: pick.value() }; };
        teamRows.appendChild(row);
      };
      Object.keys(R.teams).forEach(function (k) { addTeam(k, R.teams[k]); });
      var teams = ruleSection('Teams', 'Groups of people. A worker set to "my team may ask it" is open to everyone who shares a team with its manager.',
        h('div', { class: 'stack' }, teamRows, h('div', null, h('button', { class: 'btn small', text: 'Add a team', onclick: function () { addTeam('', []); } }))),
        function () {
          var out = {};
          [].slice.call(teamRows.children).forEach(function (row) { var t = row._read(); if (t.name) out[t.name] = t.members; });
          return { teams: out };
        });

      // Roles.
      var roleRows = h('div', { class: 'listed' });
      var addRole = function (role) {
        role = role || { name: '', job: '', tools: [], budgetUSDPerMonth: 30 };
        var n = h('input', { type: 'text', value: role.name, placeholder: 'Product analyst' });
        var job = h('textarea', { 'aria-label': 'What the job is', placeholder: 'Reads the product board and usage data, and writes a weekly summary for the product team.' });
        job.value = role.job;
        var tools = h('input', { type: 'text', value: role.tools.join(', '), placeholder: 'acme-analytics' });
        var b = h('input', { type: 'number', min: '1', step: '1', value: String(role.budgetUSDPerMonth) });
        var row = h('div', { class: 'panel stack' },
          h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Role', n), h('label', { class: 'field' }, 'Budget (USD a month)', b)),
          h('label', { class: 'field' }, 'The job', job), h('label', { class: 'field' }, 'Tools cleared for it', tools),
          h('div', null, h('button', { class: 'btn quiet small', text: 'Remove role', onclick: function () { row.remove(); } })));
        row._read = function () { return { name: n.value.trim(), job: job.value.trim(), tools: list(tools.value), budgetUSDPerMonth: Number(b.value || 0) }; };
        roleRows.appendChild(row);
      };
      R.roles.forEach(addRole);
      var roles = ruleSection('Role catalog', 'Approved jobs on the Hire page. Hiring one skips the interview, and its tools need no approver.',
        h('div', { class: 'stack' }, roleRows, h('div', null, h('button', { class: 'btn small', text: 'Add a role', onclick: function () { addRole(null); } }))),
        function () { return { roles: [].slice.call(roleRows.children).map(function (row) { return row._read(); }).filter(function (x) { return x.name; }) }; });

      return [head('Rules', 'What people may do with the workers. Changes apply at once, and each is written to the decision log.', null),
        identity, hiring, spending, teams, roles, records].concat(ssoSection(R)).concat(fleetSection(R));
    });
  }

  function spendBars(title, rows, total) {
    if (!rows.length) return h('p', { class: 'muted', text: 'No workers yet.' });
    return h('div', { class: 'stack', style: 'gap:8px' }, h('span', { class: 'faint', text: title }), h('div', { class: 'bars' }, rows.map(function (m) {
      var pct = total ? (m.spentUSD / total) * 100 : 0;
      return h('div', null, h('span', { text: m.name }), h('div', { class: 'meter' }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })), h('span', { text: money(m.spentUSD) }));
    })));
  }

  // ---- decision log ------------------------------------------------------

  function viewLog() {
    var q = h('input', { type: 'search', placeholder: 'A person, a worker, “approved”…', 'aria-label': 'Search the decision log' });
    var from = h('input', { type: 'date', 'aria-label': 'From' });
    var to = h('input', { type: 'date', 'aria-label': 'To' });
    var list = h('div', { 'aria-live': 'polite' });
    var params = function () {
      var p = new URLSearchParams();
      if (q.value.trim()) p.set('q', q.value.trim());
      if (from.value) p.set('from', String(new Date(from.value + 'T00:00:00').getTime()));
      if (to.value) p.set('to', String(new Date(to.value + 'T00:00:00').getTime() + 86400000));
      p.set('limit', '500');
      return p.toString();
    };
    var load = function () {
      list.textContent = ''; list.appendChild(thinking('Searching…'));
      api('GET', '/api/admin/audit?' + params()).then(function (au) {
        list.textContent = '';
        if (au.ok === false) { list.appendChild(msg(au)); return; }
        if (!au.entries.length) { list.appendChild(h('p', { class: 'muted', text: 'No decisions match.' })); return; }
        append(list, [h('p', { class: 'faint', text: au.total > au.entries.length ? 'Showing the newest ' + au.entries.length + ' of ' + au.total + '. Download them all below.' : plural(au.total, 'decision', 'decisions') + '.' }),
          h('ol', { class: 'log' }, au.entries.map(function (e) {
            return h('li', null, h('span', { class: 'faint', text: new Date(e.at).toLocaleString() }), h('span', null, h('b', { style: 'font-weight:600', text: e.by + ' ' }), e.what.charAt(0).toLowerCase() + e.what.slice(1)));
          }))]);
      });
    };
    var timer = null;
    q.oninput = function () { clearTimeout(timer); timer = setTimeout(load, 300); };
    from.onchange = load; to.onchange = load;
    var download = h('button', { class: 'btn', text: 'Download CSV' });
    download.onclick = function () {
      var restore = busy(download, 'Preparing…');
      fetch('/api/admin/audit.csv?' + params(), { headers: { Authorization: 'Bearer ' + token() } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) {
        var a = h('a', { href: URL.createObjectURL(blob), download: 'decision-log.csv' });
        document.body.appendChild(a); a.click(); a.remove();
        restore();
      }, function () { restore(); list.prepend(msg({ ok: false, error: 'The download did not work. Try again.' })); });
    };
    load();
    return Promise.resolve([head('Decision log', 'Every hire, approval, promotion, rule change and offboarding, and who made it.', h('button', { class: 'btn', text: 'Back to Activity', onclick: function () { go('admin'); } })),
      h('section', { class: 'panel pad stack' }, h('div', { class: 'row' }, h('span', { style: 'flex:1 1 260px' }, q), from, to, download), list)]);
  }

  // ---- library -----------------------------------------------------------

  var SOURCE = { watch: 'Watch', webhook: 'Webhook', slack: 'Slack', ask: 'Asked' };

  /// One thing a worker delivered: what set it off, what came of it, where
  /// it went, and whether it was useful.
  function libraryCard(x) {
    var body = x.body ? h('div', { hidden: true, style: 'white-space:pre-wrap;font-size:13.5px;border-top:1px solid var(--line);padding-top:10px', text: x.body }) : null;
    var out = h('div');
    var rate = function (useful) {
      return function () {
        var path = x.kind === 'event' ? '/api/library/' + encodeURIComponent(x.id) + '/rate' : '/api/rate';
        api('POST', path, x.kind === 'event' ? { useful: useful } : { entryId: x.id, useful: useful }).then(function (r) { out.textContent = ''; out.appendChild(msg(r, useful ? 'Marked useful. It leans that way next time.' : 'Noted.')); });
      };
    };
    var src = x.source || {};
    return h('article', { class: 'panel', style: 'padding:16px 18px;display:flex;flex-direction:column;gap:8px' },
      h('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap;align-items:flex-start' }, avatar(x.workerId, x.workerName, 's'),
        h('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:3px' },
          h('span', { style: 'font-weight:600', text: x.title }),
          h('span', { class: 'faint', text: [x.workerName, x.kind === 'work' ? 'From a run' : (SOURCE[src.kind] || 'Asked') + (src.triggerName ? ': ' + src.triggerName : ''), ago(x.at), x.minutes != null ? 'handled in ' + (x.minutes < 1 ? 'under a minute' : Math.round(x.minutes) + ' min') : null].filter(Boolean).join(' · ') })),
        x.status === 'working' ? h('span', { class: 'tag go', text: 'Working' }) : x.status === 'failed' ? h('span', { class: 'tag bad', text: 'Failed' }) : null),
      x.error ? h('div', { class: 'msg err', text: x.error }) : null,
      x.deliveredTo && x.deliveredTo.length ? h('span', { class: 'faint', text: 'Delivered to ' + x.deliveredTo.join(', ') }) : null,
      h('div', { class: 'row', style: 'gap:6px' },
        body ? h('button', { class: 'btn small', text: 'Read', onclick: function (e) { body.hidden = !body.hidden; e.target.textContent = body.hidden ? 'Read' : 'Hide'; } }) : null,
        src.url ? h('a', { class: 'btn small quiet', href: src.url, target: '_blank', rel: 'noopener', text: 'What set it off' }) : null,
        (x.links || []).slice(0, 4).map(function (l) {
          var label = /\/pull\/\d+/.test(l) ? 'PR #' + l.split('/pull/')[1].split(/[/?#]/)[0] : /docs\.google|notion\.so|confluence/.test(l) ? 'Doc' : l.replace(/^https?:\/\//, '').split('/')[0];
          return h('a', { class: 'btn small', href: l, target: '_blank', rel: 'noopener', text: label });
        }),
        x.status === 'delivered' ? h('span', { style: 'margin-left:auto', class: 'row' },
          h('button', { class: 'btn small icon', 'aria-label': 'Useful', 'aria-pressed': x.rating && x.rating.useful ? 'true' : 'false', onclick: rate(true) }, icon('up', 15)),
          h('button', { class: 'btn small icon', 'aria-label': 'Not useful', 'aria-pressed': x.rating && !x.rating.useful ? 'true' : 'false', onclick: rate(false) }, icon('down', 15))) : null),
      out, body);
  }

  function viewLibrary() {
    return Promise.all([api('GET', '/api/library'), api('GET', '/api/workers')]).then(function (r) {
      var all = r[0], workers = r[1];
      var who = h('select', { 'aria-label': 'Whose work', style: 'width:auto' }, h('option', { value: '', text: 'Every worker' }), workers.map(function (w) { return h('option', { value: w.id, text: w.name }); }));
      var q = h('input', { type: 'search', placeholder: 'Search what they delivered', 'aria-label': 'Search the library', style: 'min-height:38px' });
      var list = h('div', { class: 'stack', style: 'gap:10px' });
      var draw = function () {
        var words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        list.textContent = '';
        var shown = all.filter(function (x) { return (!who.value || x.workerId === who.value) && words.every(function (w) { return (x.title + ' ' + x.workerName + ' ' + (x.body || '')).toLowerCase().indexOf(w) >= 0; }); });
        var groups = [], last = null;
        shown.forEach(function (x) { var l = dayLabel(x.at); if (l !== last) { groups.push({ label: l, items: [] }); last = l; } groups[groups.length - 1].items.push(x); });
        groups.forEach(function (g) { append(list, [h('h2', { class: 'label', style: 'margin-top:8px', text: g.label }), g.items.map(libraryCard)]); });
        if (!shown.length) list.appendChild(h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: all.length ? 'Nothing matches.' : 'Nothing delivered yet.' }),
          h('p', { text: all.length ? 'Try other words or every worker.' : 'Give a worker a trigger, and what it delivers on each event lands here — with where it went and how long it took.' })));
      };
      who.onchange = draw; q.oninput = draw;
      draw();
      var month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
      var thisMonth = all.filter(function (x) { return x.at >= month.getTime() && x.status === 'delivered'; });
      var mins = thisMonth.filter(function (x) { return x.minutes != null; }).map(function (x) { return x.minutes; }).sort(function (a, b) { return a - b; });
      var median = mins.length ? mins[Math.floor(mins.length / 2)] : null;
      return [head('Library', 'Everything the workers delivered — on business events and on request — and where it went.'),
        h('div', { class: 'grid2', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' },
          h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Delivered this month' }), h('div', { class: 'big', style: 'margin-top:6px', text: String(thisMonth.length) })),
          h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Typical time to handle' }), h('div', { class: 'big', style: 'margin-top:6px', text: median == null ? '—' : median < 1 ? '<1 min' : Math.round(median) + ' min' })),
          h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Rated useful' }), h('div', { class: 'big', style: 'margin-top:6px', text: (function () { var rated = thisMonth.filter(function (x) { return x.rating; }); return rated.length ? Math.round(100 * rated.filter(function (x) { return x.rating.useful; }).length / rated.length) + '%' : '—'; })() }))),
        h('div', { class: 'row' }, who, h('span', { style: 'flex:1 1 280px' }, q)),
        list];
    });
  }

  // ---- triggers ------------------------------------------------------------

  /// A trigger in one plain sentence: what sets it off.
  function triggerWhen(t) {
    if (t.kind === 'watch' && t.watch) return 'Checks ' + t.watch.server + ' (' + t.watch.tool + ') every ' + t.watch.everyMinutes + ' min for new items';
    if (t.kind === 'webhook') return 'When another system posts to its webhook';
    if (t.kind === 'slack' && t.slack) return (t.slack.on === 'reaction' ? 'When someone reacts :' + t.slack.reaction + ': to a message' : t.slack.on === 'mention' ? 'When someone mentions the bot' : 'On each new message') + ' in #' + t.slack.channel + (t.slack.contains ? ' containing “' + t.slack.contains + '”' : '');
    return 'On an event';
  }

  function triggerRow(t, canEdit) {
    var out = h('div', { 'aria-live': 'polite' });
    var act = function (path, body, ok) { return function () { api('POST', path, body).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else if (ok) { out.textContent = ''; out.appendChild(msg({}, ok)); setTimeout(render, 1200); } else render(); }); }; };
    var deliver = (t.deliver || []).map(function (d) { return d.kind === 'slack' ? 'posts in #' + d.channel : d.kind === 'thread' ? 'replies in the thread' : d.text; });
    return h('article', { class: 'panel', style: 'padding:16px 18px;display:flex;flex-direction:column;gap:8px' + (t.enabled ? '' : ';opacity:.7') },
      h('div', { class: 'spread', style: 'align-items:center' },
        h('div', { class: 'row', style: 'gap:10px' }, h('span', { style: 'color:var(--go);display:inline-flex' }, icon('bolt', 17)), h('b', { style: 'font-weight:600', text: t.name }), h('span', { class: 'tag' + (t.enabled ? ' go' : ''), text: t.enabled ? 'On' : 'Off' })),
        canEdit ? h('div', { class: 'row', style: 'gap:6px' },
          t.kind === 'watch' && t.enabled ? h('button', { class: 'btn small', text: 'Check now', onclick: act('/api/triggers/' + encodeURIComponent(t.id) + '/check', {}, 'Checked.') }) : null,
          h('button', { class: 'btn small', text: t.enabled ? 'Pause' : 'Turn on', onclick: act('/api/triggers/' + encodeURIComponent(t.id), { patch: { enabled: !t.enabled } }) }),
          h('button', { class: 'btn small quiet', text: 'Remove', onclick: function () { if (window.confirm('Remove “' + t.name + '”? What it already delivered stays in the Library.')) act('/api/triggers/' + encodeURIComponent(t.id) + '/remove', {})(); } })) : null),
      h('span', { class: 'muted', style: 'font-size:13.5px', text: triggerWhen(t) + ' → ' + t.instructions.split('\n')[0].slice(0, 140) + (deliver.length ? ' → ' + deliver.join(', ') : '') }),
      h('span', { class: 'faint', text: [t.handledTotal + ' handled', t.handledToday + ' today of ' + t.maxPerDay, t.lastFiredAt ? 'last ' + ago(t.lastFiredAt) : 'not set off yet', t.kind === 'watch' && t.lastPolledAt ? 'checked ' + ago(t.lastPolledAt) : null].filter(Boolean).join(' · ') }),
      t.lastError ? h('div', { class: 'msg err', text: t.lastError }) : null,
      out);
  }

  /// Build a trigger in plain steps: what sets it off, what to do, where the
  /// result goes. A watch can be tried before it is saved.
  function triggerBuilder(w, done) {
    var kind = 'watch';
    var name = h('input', { type: 'text', placeholder: 'e.g. New bugs in Support Backlog', 'aria-label': 'Name' });
    var kinds = h('div', { class: 'grid2', role: 'radiogroup', 'aria-label': 'What sets it off', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' });
    var parts = {};
    // Watch
    var server = h('select', { 'aria-label': 'Tool' }, h('option', { value: '', text: 'Loading tools…' }));
    var call = h('select', { 'aria-label': 'Call' }, h('option', { value: '', text: 'Pick a tool first' }));
    var args = h('textarea', { 'aria-label': 'Arguments (JSON)', placeholder: '{ "jql": "project = ACME AND sprint = \\"Support Backlog\\" AND statusCategory != Done" }', style: 'min-height:70px;font-family:var(--mono);font-size:12.5px' });
    var every = h('select', { 'aria-label': 'How often', style: 'width:auto' }, [5, 10, 15, 30, 60].map(function (n) { return h('option', { value: String(n), text: 'every ' + n + ' min', selected: n === 15 }); }));
    var itemsPath = h('input', { type: 'text', placeholder: 'e.g. issues', 'aria-label': 'Where the list is' });
    var idPath = h('input', { type: 'text', placeholder: 'e.g. key', 'aria-label': 'What identifies an item' });
    var testOut = h('div', { 'aria-live': 'polite' });
    var parseArgs = function () { if (!args.value.trim()) return {}; try { return JSON.parse(args.value); } catch (e) { return null; } };
    var test = h('button', { class: 'btn', text: 'Try it now' });
    test.onclick = function () {
      var a = parseArgs();
      if (a === null) { testOut.textContent = ''; testOut.appendChild(h('div', { class: 'msg err', text: 'The arguments aren’t valid JSON.' })); return; }
      var restore = busy(test, 'Asking the tool…');
      api('POST', '/api/triggers/test', { watch: { server: server.value, tool: call.value, args: a, everyMinutes: 15, itemsPath: itemsPath.value.trim(), idPath: idPath.value.trim() } }).then(function (x) {
        restore(); testOut.textContent = '';
        if (x.ok === false) { testOut.appendChild(msg(x)); return; }
        append(testOut, [h('p', { class: 'faint', text: 'It sees ' + plural(x.items.length, 'item', 'items') + ' now. These are skipped when it starts; it acts on new ones after.' }),
          h('ul', { style: 'margin:6px 0 0;padding-left:18px;font-size:13.5px' }, x.items.slice(0, 8).map(function (i) { return h('li', { text: i.title }); }))]);
      });
    };
    api('GET', '/api/tools').then(function (r) {
      server.textContent = '';
      var tools = r.ok === false ? [] : r.tools;
      if (!tools.length) { server.appendChild(h('option', { value: '', text: 'No tools installed — add one on Setup → Tools' })); return; }
      server.appendChild(h('option', { value: '', text: 'Pick a tool' }));
      tools.forEach(function (t) { server.appendChild(h('option', { value: t.name, text: t.name })); });
    });
    server.onchange = function () {
      call.textContent = ''; call.appendChild(h('option', { value: '', text: 'Loading…' }));
      if (!server.value) return;
      api('GET', '/api/tools/' + encodeURIComponent(server.value) + '/calls').then(function (r) {
        call.textContent = '';
        if (r.ok === false) { call.appendChild(h('option', { value: '', text: r.error })); return; }
        r.tools.forEach(function (t) { call.appendChild(h('option', { value: t.name, text: t.name, title: t.description || '' })); });
      });
    };
    parts.watch = h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Tool', server), h('label', { class: 'field' }, 'What to ask it', call)),
      h('label', { class: 'field' }, 'With (JSON)', args),
      h('div', { class: 'row' }, h('span', { class: 'faint', text: 'Check' }), every),
      h('details', null, h('summary', { text: 'If it can’t tell items apart' }), h('div', { class: 'grid2', style: 'margin-top:10px' }, h('label', { class: 'field' }, 'Where the list is', itemsPath), h('label', { class: 'field' }, 'What identifies an item', idPath))),
      h('div', { class: 'row' }, test), testOut);
    // Webhook
    var hookId = h('input', { type: 'text', placeholder: 'optional, e.g. issue.key', 'aria-label': 'What identifies an event' });
    parts.webhook = h('div', { class: 'stack' }, h('p', { class: 'muted', text: 'You get a secret address when you save. Paste it into Jira automation, a GitHub webhook, your CRM or Zapier. Each post is one event; repeats of the same event are handled once.' }),
      h('label', { class: 'field', style: 'max-width:360px' }, 'What identifies an event', hookId));
    // Slack
    var channel = h('input', { type: 'text', placeholder: 'C012AB3CD', 'aria-label': 'Channel ID' });
    var on = h('select', { 'aria-label': 'On' }, h('option', { value: 'message', text: 'each new message' }), h('option', { value: 'reaction', text: 'an emoji reaction' }), h('option', { value: 'mention', text: 'a mention of the bot' }));
    var emoji = h('input', { type: 'text', placeholder: 'bug', 'aria-label': 'Emoji' });
    var contains = h('input', { type: 'text', placeholder: 'optional', 'aria-label': 'Only if it contains' });
    var emojiField = h('label', { class: 'field' }, 'Emoji', emoji);
    on.onchange = function () { emojiField.style.display = on.value === 'reaction' ? '' : 'none'; };
    on.onchange();
    parts.slack = h('div', { class: 'stack' }, h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Channel ID', channel), h('label', { class: 'field' }, 'On', on), emojiField, h('label', { class: 'field' }, 'Only if it contains', contains)),
      h('p', { class: 'faint', text: 'Invite the overcli bot to the channel first (/invite @overcli).' }));
    var KINDS = [['watch', 'Something new shows up in a tool', 'A new ticket, deal, row or message, checked every few minutes. Works anywhere.'],
      ['webhook', 'Another system tells us', 'Jira, GitHub, a CRM or Zapier posts each event to a secret address.'],
      ['slack', 'Something happens in Slack', 'A new message, a mention, or an emoji reaction in a channel.']];
    var drawKinds = function () {
      kinds.textContent = '';
      KINDS.forEach(function (k) {
        kinds.appendChild(h('button', { type: 'button', role: 'radio', 'aria-checked': kind === k[0] ? 'true' : 'false', class: 'place', style: 'min-height:0;padding:14px' + (kind === k[0] ? ';border-color:var(--go);box-shadow:0 0 0 2px var(--go-soft)' : ''), onclick: function () { kind = k[0]; drawKinds(); sync(); } },
          h('b', { style: 'font-size:15px', text: k[1] }), h('span', { class: 'muted', style: 'font-size:13px', text: k[2] })));
      });
    };
    var kindBody = h('div');
    var thread = h('input', { type: 'checkbox' });
    var threadRow = h('label', { class: 'toggle' }, thread, h('span', { text: 'Reply in the Slack thread it came from' }));
    var sync = function () { kindBody.textContent = ''; kindBody.appendChild(parts[kind]); threadRow.style.display = kind === 'slack' ? '' : 'none'; };
    drawKinds(); sync();
    var instructions = h('textarea', { 'aria-label': 'What to do with each one', placeholder: 'e.g. Triage the ticket: reproduce it if you can, label it, and say who owns it. If it’s small and clear, fix it and open a PR.', style: 'min-height:90px' });
    var postTo = h('input', { type: 'text', placeholder: 'Channel ID, e.g. C012AB3CD (optional)', 'aria-label': 'Post each result in this Slack channel' });
    var itself = h('input', { type: 'text', placeholder: 'e.g. Comment your triage on the ticket (optional)', 'aria-label': 'The worker delivers it itself' });
    var perDay = h('input', { type: 'number', min: '1', max: '500', value: '50', 'aria-label': 'At most per day', style: 'width:110px' });
    var out = h('div', { 'aria-live': 'polite' });
    var save = h('button', { class: 'btn go', text: 'Save the trigger' });
    save.onclick = function () {
      var a = kind === 'watch' ? parseArgs() : {};
      if (a === null) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', text: 'The arguments aren’t valid JSON.' })); return; }
      var deliver = [];
      if (postTo.value.trim()) deliver.push({ kind: 'slack', channel: postTo.value.trim() });
      if (kind === 'slack' && thread.checked) deliver.push({ kind: 'thread' });
      if (itself.value.trim()) deliver.push({ kind: 'worker', text: itself.value.trim() });
      var trigger = { name: name.value.trim(), kind: kind, instructions: instructions.value.trim(), deliver: deliver, maxPerDay: Number(perDay.value) || 50,
        watch: { server: server.value, tool: call.value, args: a, everyMinutes: Number(every.value), itemsPath: itemsPath.value.trim(), idPath: idPath.value.trim() },
        slack: { channel: channel.value.trim(), on: on.value, reaction: emoji.value.trim(), contains: contains.value.trim() },
        webhook: { idPath: hookId.value.trim() } };
      var restore = busy(save, 'Saving…');
      api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/triggers', { trigger: trigger }).then(function (x) {
        restore(); out.textContent = '';
        if (x.ok === false) { out.appendChild(msg(x)); return; }
        if (x.webhookPath) {
          var url = location.origin + x.webhookPath;
          append(out, [msg({}, 'Saved. Here is its secret address — shown once. Anyone with it can set the trigger off, so keep it like a password.'), linkBox(url, 'POST JSON events here:'),
            codeBlock('curl -X POST ' + url + ' -H "Content-Type: application/json" -d \'{"title":"Test event","id":"test-1"}\''),
            h('button', { class: 'btn', text: 'Done', onclick: done })]);
          return;
        }
        done();
      });
    };
    return h('section', { class: 'panel pad stack', style: 'gap:18px' },
      h('h2', { class: 'section-title', text: 'New trigger for ' + w.name }),
      h('label', { class: 'field', style: 'max-width:520px' }, 'Name', name),
      h('div', { class: 'stack', style: 'gap:8px' }, h('span', { class: 'label', text: '1 · What sets it off' }), kinds, kindBody),
      h('div', { class: 'stack', style: 'gap:8px' }, h('span', { class: 'label', text: '2 · What it does with each one' }), instructions,
        h('p', { class: 'faint', text: 'It gets the event’s details with this. ' + (w.trust === 'probation' ? 'On probation, it proposes what it would do and waits for you.' : 'Trusted, it goes ahead.') })),
      h('div', { class: 'stack', style: 'gap:8px' }, h('span', { class: 'label', text: '3 · Where the result goes' }),
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Post each result in a Slack channel', postTo), h('label', { class: 'field' }, 'Or the worker delivers it itself', itself)),
        threadRow, h('p', { class: 'faint', text: 'Everything it delivers is also kept in the Library.' })),
      h('div', { class: 'row' }, h('span', { class: 'faint', text: 'At most' }), perDay, h('span', { class: 'faint', text: 'a day, to keep cost in check.' })),
      h('div', { class: 'foot' }, save, h('button', { class: 'btn quiet', text: 'Cancel', onclick: done }), out));
  }

  function triggersView(w, d) {
    var list = d.triggers || [];
    var holder = h('div', { class: 'stack', style: 'gap:12px' });
    var showBuilder = function () { holder.textContent = ''; holder.appendChild(triggerBuilder(w, function () { render(); })); holder.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    var v = d.value;
    return h('div', { class: 'stack', style: 'gap:16px' },
      v ? h('div', { class: 'grid2', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr))' },
        h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Handled this month' }), h('div', { class: 'big', style: 'margin-top:6px', text: String(v.handled) })),
        h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Typical time' }), h('div', { class: 'big', style: 'margin-top:6px', text: v.medianMinutes == null ? '—' : v.medianMinutes < 1 ? '<1 min' : Math.round(v.medianMinutes) + ' min' })),
        h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Cost per item' }), h('div', { class: 'big', style: 'margin-top:6px', text: v.costPerItemUSD == null ? '—' : money(v.costPerItemUSD) })),
        h('div', { class: 'panel pad' }, h('div', { class: 'label', text: 'Rated useful' }), h('div', { class: 'big', style: 'margin-top:6px', text: v.rated ? Math.round((100 * v.useful) / v.rated) + '%' : '—' }))) : null,
      h('div', { class: 'spread', style: 'align-items:center' },
        h('p', { class: 'muted', text: list.length ? 'What sets ' + w.name + ' off on its own, besides its schedule (' + w.schedule.toLowerCase() + ').' : w.name + ' only works on its schedule (' + w.schedule.toLowerCase() + ') and when asked. Give it a trigger so it acts the moment work shows up.' }),
        w.youManage ? h('button', { class: 'btn go', onclick: showBuilder }, icon('bolt', 15), 'Add a trigger') : null),
      list.map(function (t) { return triggerRow(t, w.youManage); }),
      holder);
  }

  // ---- setup (org) -------------------------------------------------------

  /// Everything an admin sets up, in one place: how ready the server is,
  /// the tools workers can use, and the rules.
  function viewSetup() {
    var tab = state.setupTab || 'ready';
    var tabs_ = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Setup' },
      [['ready', 'Readiness'], ['tools', 'Tools'], ['rules', 'Rules, spending and sign-in']].map(function (t) {
        return h('button', { role: 'tab', 'aria-selected': tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.setupTab = t[0]; render(); } });
      }));
    var headNode = head('Setup', 'What this server needs so workers can do their jobs. Everything here applies at once.');
    var body = tab === 'tools' ? viewTools() : tab === 'rules' ? viewRules() : readiness();
    return body.then(function (nodes) { return [headNode, tabs_].concat(tab === 'ready' ? nodes : nodes.slice(1)); });
  }

  function readiness() {
    return Promise.all([api('GET', '/api/admin/health'), api('GET', '/api/tools'), api('GET', '/api/projects'), api('GET', '/api/admin/people'), api('GET', '/api/admin/requests')]).then(function (r) {
      var hl = r[0], tl = r[1], places = r[2] || [], ppl = r[3], req = r[4];
      if (hl.ok === false) return [msg(hl)];
      var item = function (name) { return hl.items.filter(function (i) { return i.name === name; })[0]; };
      var model = item('Models'), slack = item('Slack'), sso = item('Company sign-in');
      var missing = tl.ok === false ? [] : tl.missing;
      var people = ppl.ok === false ? [] : ppl.people;
      var asking = req.ok === false ? 0 : req.requests.length;
      var checks = [
        { ok: !!(model && model.ok), title: 'A model to think with', detail: model ? model.detail : 'Checking…', optional: false },
        { ok: !!(slack && slack.ok), title: 'Slack, for questions and approvals', detail: slack ? slack.detail : 'Not connected.', optional: false,
          action: slack && slack.ok ? null : ['How to connect it', function () { go('connect'); }] },
        { ok: places.length > 0, title: 'A place to work', detail: places.length ? places.map(function (p) { return p.name; }).join(', ') : 'No repo or folder yet. An operator adds one with: overcli projects add <folder>', optional: false },
        { ok: !missing.length, title: 'The tools workers need', detail: missing.length ? missing.map(function (m) { return m.name + ' is missing — ' + m.workers.join(', ') + (m.workers.length === 1 ? ' needs' : ' need') + ' it'; }).join('; ') : 'Every tool a worker lists is installed.', optional: false,
          action: missing.length ? ['Install ' + missing[0].name, function () { state.setupTab = 'tools'; render(); }] : null, bad: missing.length > 0 },
        { ok: people.length > 1 && !asking, title: 'People', detail: plural(people.length, 'person', 'people') + ' in' + (asking ? ', ' + asking + ' asking to join' : ''), optional: false,
          action: asking ? ['Let them in', function () { go('people'); }] : people.length < 2 ? ['Invite people', function () { go('people'); }] : null },
        { ok: !!(sso && sso.ok), title: 'Company sign-in', detail: sso ? sso.detail : 'Optional. People sign in through Slack links until you set it up.', optional: true,
          action: sso && sso.ok ? null : ['Set it up', function () { state.setupTab = 'rules'; render(); }] }
      ];
      var core = checks.filter(function (c) { return !c.optional; });
      var done = core.filter(function (c) { return c.ok; }).length;
      return [h('section', { class: 'panel pad stack', 'aria-labelledby': 'ready' },
        h('div', { class: 'spread' }, h('h2', { id: 'ready', class: 'section-title', style: 'font-size:18px', text: done === core.length ? 'Ready' : done + ' of ' + core.length + ' ready' }),
          h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Check again', onclick: function () { render(); } })),
        h('div', { class: 'meter', style: 'height:8px' }, h('span', { style: 'width:' + Math.round((done / core.length) * 100) + '%' })),
        h('ul', { class: 'checklist' }, checks.map(function (c) {
          return h('li', null,
            h('span', { class: c.ok ? 'ck-ok' : c.bad ? 'ck-bad' : 'ck-off', style: 'flex:none;display:inline-flex' }, icon(c.ok ? 'check' : 'alert', 20)),
            h('span', null, h('span', { style: 'font-weight:550', text: c.title + (c.optional ? ' (optional)' : '') }), h('span', { class: 'faint', style: c.bad ? 'color:var(--bad)' : '', text: c.detail })),
            c.action ? h('button', { class: 'btn small' + (c.bad ? ' bad' : ''), text: c.action[0], onclick: c.action[1] }) : null);
        })))];
    });
  }

  // ---- tools (MCP servers on this server) --------------------------------

  /// "KEY=value" lines, or "Key: value" for headers, into an object.
  function kvLines(text, sep) {
    var out = {};
    text.split('\n').forEach(function (line) {
      var i = line.indexOf(sep);
      if (i < 1) return;
      var k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  /// Split a command line on spaces, keeping "quoted parts" whole.
  function splitArgs(text) {
    var out = [], m, re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    while ((m = re.exec(text))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
    return out;
  }

  /// The install form. prefill is a name, or what a published worker
  /// brought: its command or URL and the names of its settings, no values.
  function toolForm(prefill, onDone) {
    var tpl = prefill && typeof prefill === 'object' ? prefill : null;
    var name = h('input', { type: 'text', value: tpl ? tpl.name : prefill || '', placeholder: 'jira', 'aria-label': 'Name' });
    var kind = h('select', { 'aria-label': 'How it runs' }, h('option', { value: 'command', text: 'A command on the server (npx, uvx, docker…)' }), h('option', { value: 'http', text: 'A remote server, by URL' }));
    var cmd = h('input', { type: 'text', placeholder: 'npx -y @acme/jira-mcp', 'aria-label': 'Command' });
    var env = h('textarea', { placeholder: 'JIRA_URL=https://acme.atlassian.example\nJIRA_API_TOKEN=…', 'aria-label': 'Environment', style: 'min-height:70px;font-family:var(--mono, monospace)' });
    var url = h('input', { type: 'text', placeholder: 'https://mcp.acme.example/mcp', 'aria-label': 'URL' });
    var headers = h('textarea', { placeholder: 'Authorization: Bearer …', 'aria-label': 'Headers', style: 'min-height:56px;font-family:var(--mono, monospace)' });
    var cmdPart = h('div', { class: 'stack', style: 'gap:10px' }, h('label', { class: 'field' }, 'Command', cmd), h('label', { class: 'field' }, 'Settings and secrets (one KEY=value a line)', env));
    var httpPart = h('div', { class: 'stack', style: 'gap:10px' }, h('label', { class: 'field' }, 'URL', url), h('label', { class: 'field' }, 'Headers (one "Name: value" a line)', headers));
    var sync = function () { cmdPart.style.display = kind.value === 'command' ? '' : 'none'; httpPart.style.display = kind.value === 'http' ? '' : 'none'; };
    if (tpl) {
      kind.value = tpl.kind;
      if (tpl.kind === 'http') { url.value = tpl.url || ''; headers.value = tpl.headerKeys.map(function (k) { return k + ': '; }).join('\n'); }
      else { cmd.value = [tpl.command || ''].concat(tpl.args || []).map(function (a) { return /\s/.test(a) ? '"' + a + '"' : a; }).join(' '); env.value = tpl.envKeys.map(function (k) { return k + '='; }).join('\n'); }
    }
    kind.onchange = sync; sync();
    var out = h('div', { 'aria-live': 'polite' });
    var save = h('button', { class: 'btn go', text: 'Install' });
    save.onclick = function () {
      var parts = splitArgs(cmd.value.trim());
      var tool = kind.value === 'http'
        ? { name: name.value.trim(), kind: 'http', url: url.value.trim(), headers: kvLines(headers.value, ':') }
        : { name: name.value.trim(), kind: 'command', command: parts[0] || '', args: parts.slice(1), env: kvLines(env.value, '=') };
      var restore = busy(save, 'Installing…');
      api('POST', '/api/admin/tools', { tool: tool }).then(function (x) {
        restore(); out.textContent = '';
        if (x.ok === false) { out.appendChild(msg(x)); return; }
        out.appendChild(msg({}, 'Installed. Workers that list ' + tool.name + ' use it from their next run. Press “Check them” to see that it starts.'));
        if (onDone) setTimeout(onDone, 1200);
      });
    };
    return h('div', { class: 'stack' },
      tpl ? h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Filled in from how it was set up where the worker was built. Add the values for each setting: secrets never travel with a published worker.' }) : null,
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Name (what workers list)', name), h('label', { class: 'field' }, 'How it runs', kind)),
      cmdPart, httpPart,
      h('p', { class: 'faint', text: 'Secrets are written to the server’s own config on its volume and never shown again. Connectors that sign in through a browser (claude.ai connectors, OAuth pop-ups) cannot work on a server: use one that takes an API token.' }),
      h('div', { class: 'foot' }, save, out));
  }

  function viewTools() {
    return api('GET', '/api/tools').then(function (r) {
      if (r.ok === false) return [msg(r)];
      var lightFor = function (status) { return status === 'connected' ? ' ok' : status ? ' bad' : ''; };
      var statusText = function (status) {
        return !status ? 'Not checked yet' : status === 'connected' ? 'Starts and connects' : status === 'needs-auth' ? 'Needs a browser sign-in, which a server cannot do' : status === 'failed' ? 'Fails to start: check the command and its settings' : status;
      };
      var check = h('button', { class: 'btn', text: 'Check them' });
      var checkOut = h('div', { 'aria-live': 'polite' });
      check.onclick = function () {
        var restore = busy(check, 'Checking… (up to a minute)');
        api('POST', '/api/admin/tools/check').then(function (x) {
          restore();
          if (x.ok === false) { checkOut.textContent = ''; checkOut.appendChild(msg(x)); return; }
          render();
        });
      };
      var addPanel = h('section', { class: 'panel pad stack', hidden: true }, h('h2', { class: 'section-title', text: 'Install a tool' }), toolForm('', render));
      var missing = r.missing.length ? h('section', { class: 'panel pad stack', 'aria-labelledby': 'miss' },
        h('h2', { id: 'miss', class: 'section-title', text: 'Workers are missing these' }),
        h('p', { class: 'muted', style: 'font-size:13.5px', text: 'A worker brought from someone’s desktop names the tools it had there. Until one is installed here under the same name, the worker runs without it.' }),
        h('div', { class: 'listed' }, r.missing.map(function (m) {
          var slot = h('div');
          return h('div', { class: 'panel stack', style: 'gap:8px' },
            h('div', { class: 'spread', style: 'align-items:center' },
              h('div', null, h('b', { text: m.name }), h('span', { class: 'faint', text: '  needed by ' + m.workers.join(', ') })),
              r.canEdit ? h('button', { class: 'btn small', text: 'Install ' + m.name, onclick: function (e) { e.target.remove(); slot.appendChild(toolForm(m.template || m.name, render)); } }) : null),
            slot);
        }))) : null;
      var installed = h('section', { class: 'panel pad stack', 'aria-labelledby': 'inst' },
        h('div', { class: 'spread', style: 'align-items:center' }, h('h2', { id: 'inst', class: 'section-title', text: 'Installed on this server' }),
          r.canEdit ? h('div', { class: 'row' }, check, h('button', { class: 'btn go', text: 'Install a tool', onclick: function () { addPanel.hidden = false; addPanel.scrollIntoView({ behavior: 'smooth' }); } })) : null),
        r.checkedAt ? h('p', { class: 'faint', text: 'Checked ' + ago(r.checkedAt) + '.' }) : null, checkOut,
        r.tools.length ? h('div', { class: 'listed' }, r.tools.map(function (t) {
          var out = h('div');
          return h('div', { class: 'panel stack', style: 'gap:6px' },
            h('div', { class: 'spread', style: 'align-items:center' },
              h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'light' + lightFor(t.status) }), h('b', { text: t.name }), h('span', { class: 'tag', text: t.kind === 'http' ? 'Remote' : 'Command' })),
              r.canEdit ? h('button', { class: 'btn quiet small', text: 'Remove', onclick: function () {
                if (!window.confirm('Remove ' + t.name + '? Workers that use it carry on without it.')) return;
                api('POST', '/api/admin/tools/' + encodeURIComponent(t.name) + '/remove').then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else render(); });
              } }) : null),
            h('code', { class: 'faint', style: 'font-size:12.5px;word-break:break-all', text: t.target }),
            h('div', { class: 'faint', text: statusText(t.status) + (t.secrets.length ? ' · sets ' + t.secrets.join(', ') : '') + ' · ' + (t.usedBy.length ? 'used by ' + t.usedBy.join(', ') : 'no worker lists it yet') }),
            out);
        })) : h('p', { class: 'muted', text: 'Nothing installed yet. Workers here can use only their built-in tools: files, the shell (as allowed) and the web.' }));
      return [head('Tools', 'The MCP servers this server’s workers can use: Jira, a CRM, a database. A worker gets a tool when its name here matches one it lists.'),
        missing, installed, addPanel];
    });
  }

  function ssoSection(R) {
    var sso = R.sso || { issuer: '', clientId: '', allowedDomains: [], required: false };
    var issuer = h('input', { type: 'text', value: sso.issuer, placeholder: 'https://acme.okta.example' });
    var clientId = h('input', { type: 'text', value: sso.clientId, placeholder: '0oa1b2c3d4' });
    var domains = h('input', { type: 'text', value: sso.allowedDomains.join(', '), placeholder: 'acme.com' });
    var required = h('input', { type: 'checkbox', checked: sso.required });
    var callback = (R.publicUrl || location.origin) + '/sso/callback';
    var peopleRows = h('div', { class: 'stack', style: 'gap:8px' });
    var addPerson = function (email, id) {
      var e = h('input', { type: 'text', value: email || '', placeholder: 'pat@acme.com', 'aria-label': 'Work email' });
      var i = h('input', { type: 'text', value: id || '', placeholder: 'U012AB3CD', 'aria-label': 'Slack member ID' });
      var row = h('div', { class: 'row' }, h('span', { style: 'flex:1 1 200px' }, e), h('span', { style: 'flex:1 1 140px' }, i), h('button', { class: 'btn quiet small', text: 'Remove', onclick: function () { row.remove(); } }));
      row._read = function () { return [e.value.trim().toLowerCase(), i.value.trim()]; };
      peopleRows.appendChild(row);
    };
    Object.keys(R.people).forEach(function (k) { addPerson(k, R.people[k]); });
    return [ruleSection('Sign-in', 'Let people sign in with the company account (Okta, Entra ID, Google — anything that speaks OpenID Connect).',
      h('div', { class: 'stack' },
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Issuer', issuer), h('label', { class: 'field' }, 'Client ID', clientId), h('label', { class: 'field' }, 'Only these email domains (optional)', domains)),
        h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint', text: 'In the provider, register this as the redirect (sign-in callback) address. A confidential client’s secret goes in OVERCLI_SSO_CLIENT_SECRET on the server, never here.' }), codeBlock(callback)),
        h('label', { class: 'toggle' }, required, h('span', { text: 'Everyone signs in this way. Invite links still give people their role, but no longer sign them in.' })),
        h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Who is who. overcli asks Slack for each email (the bot needs users:read.email); list anyone Slack can’t match here.' }),
          peopleRows, h('div', null, h('button', { class: 'btn small', text: 'Add a person', onclick: function () { addPerson('', ''); } })))),
      function () {
        var people = {};
        [].slice.call(peopleRows.children).forEach(function (row) { var v = row._read(); if (v[0] && v[1]) people[v[0]] = v[1]; });
        var on = issuer.value.trim() && clientId.value.trim();
        return { sso: on ? { issuer: issuer.value.trim(), clientId: clientId.value.trim(), allowedDomains: list(domains.value), required: required.checked } : null, people: people };
      })];
  }
  function fleetPanel(servers) {
    return h('section', { class: 'panel pad stack', 'aria-labelledby': 'fleet' },
      h('div', null, h('h2', { id: 'fleet', class: 'section-title', text: 'Your other servers' }),
        h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Each department’s overcli, read with an admin token from that server. Open one to manage it.' })),
      h('div', { class: 'listed' }, servers.map(function (sv) {
        var out = h('div');
        var body = [h('div', { class: 'spread', style: 'align-items:center' },
          h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'light' + (sv.ok ? ' ok' : ' bad') }),
            h('b', { text: sv.name }), sv.org && sv.org !== sv.name ? h('span', { class: 'faint', text: sv.org }) : null),
          h('div', { class: 'row' },
            sv.connected && sv.spentUSD != null ? h('span', { text: money(sv.spentUSD) + (sv.orgBudgetUSD ? ' of ' + money(sv.orgBudgetUSD) : '') + ' this month' }) : null,
            h('a', { class: 'btn small', href: sv.url, target: '_blank', rel: 'noopener', text: 'Open' })))];
        if (sv.workers) body.push(h('div', { class: 'faint', text: sv.workers }));
        if (sv.error) body.push(h('div', { class: 'faint', text: sv.error }));
        (sv.problems || []).forEach(function (p) { body.push(h('div', { class: 'faint', text: p })); });
        if (!sv.connected || /token/.test(sv.error || '')) {
          var t = h('input', { type: 'text', class: 'secret', placeholder: 'ocli_… (overcli tokens create --name "Fleet" --admin, on that server)', 'aria-label': 'Admin token for ' + sv.name, autocomplete: 'off', 'data-1p-ignore': true });
          var save = h('button', { class: 'btn small', text: 'Connect', onclick: function () {
            api('POST', '/api/admin/fleet/token', { url: sv.url, token: t.value }).then(function (x) { out.textContent = ''; if (x.ok === false) out.appendChild(msg(x)); else render(); });
          } });
          body.push(h('div', { class: 'row' }, h('span', { style: 'flex:1 1 280px' }, t), save));
        }
        body.push(out);
        return h('div', { class: 'panel stack', style: 'gap:6px' }, body);
      })));
  }

  function fleetSection(R) {
    var rows = h('div', { class: 'stack', style: 'gap:8px' });
    var add = function (name, url) {
      var n = h('input', { type: 'text', value: name || '', placeholder: 'Sales', 'aria-label': 'Server name' });
      var u = h('input', { type: 'text', value: url || '', placeholder: 'https://overcli-sales.acme.internal', 'aria-label': 'Server address' });
      var row = h('div', { class: 'row' }, h('span', { style: 'flex:1 1 140px' }, n), h('span', { style: 'flex:2 1 260px' }, u), h('button', { class: 'btn quiet small', text: 'Remove', onclick: function () { row.remove(); } }));
      row._read = function () { return { name: n.value.trim(), url: u.value.trim() }; };
      rows.appendChild(row);
    };
    R.fleet.forEach(function (f) { add(f.name, f.url); });
    return [ruleSection('Other servers', 'Other overcli servers in the company — one per department or Slack app — to watch from Admin. Connect each with an admin token there.',
      h('div', { class: 'stack' }, rows, h('div', null, h('button', { class: 'btn small', text: 'Add a server', onclick: function () { add('', ''); } }))),
      function () { return { fleet: [].slice.call(rows.children).map(function (r) { return r._read(); }).filter(function (f) { return f.name && f.url; }) }; })];
  }

  render();
})();
`;
