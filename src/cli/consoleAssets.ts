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
// The frame sits a step darker than the page, so the chrome reads as chrome.
const DARK = `
  --bg: #161619; --side: #111114; --panel: #1b1b20; --panel-2: #23232a; --line: #2c2c33; --line-2: #3a3a43;
  --ink: #ececf1; --muted: #b0b0ba; --faint: #8e8e98; --solid: #ececf1; --solid-ink: #17171c;
  --go: #7c8bff; --go-ink: #10121f; --go-soft: rgba(124, 139, 255, 0.16);
  --ok: #4ccf8f; --ok-soft: rgba(76, 207, 143, 0.13);
  --info: #7cb4ff; --info-soft: rgba(124, 180, 255, 0.14);
  --violet: #b896ff; --violet-soft: rgba(184, 150, 255, 0.14);
  --need: #f2b04a; --need-ink: #241700; --need-soft: rgba(242, 176, 74, 0.14);
  --bad: #ff8f84; --bad-ink: #2a0703; --bad-soft: rgba(255, 143, 132, 0.13); --bad-line: rgba(255, 143, 132, 0.35);
  --shadow: none;
  color-scheme: dark;`;

const LIGHT = `
  --bg: #f6f6f8; --side: #ffffff; --panel: #ffffff; --panel-2: #f3f3f6; --line: #e1e1e7; --line-2: #c8c8d0;
  --ink: #17171c; --muted: #4a4a52; --faint: #6b6b74; --solid: #17171c; --solid-ink: #ffffff;
  --go: #4355e0; --go-ink: #ffffff; --go-soft: rgba(93, 114, 255, 0.11);
  --ok: #17784a; --ok-soft: #e2f4ea;
  --info: #1d5fa8; --info-soft: #e7f0fb;
  --violet: #6d28d9; --violet-soft: #f1e8fd;
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
  --r-sm: 7px; --r: 8px; --r-lg: 10px;
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
.frame { display: grid; grid-template-columns: 232px minmax(0, 1fr); grid-template-rows: 56px minmax(0, 1fr); min-height: 100vh; }
.topbar { grid-column: 1 / -1; position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 16px; padding: 0 16px; background: var(--side); border-bottom: 1px solid var(--line); }
.topbar .brand { width: 200px; padding: 0; flex: none; }
.topbar .org { font-weight: 600; font-size: 13.5px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.search { flex: 1 1 auto; max-width: 520px; display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 12px; border-radius: var(--r); background: var(--panel); border: 1px solid var(--line); color: var(--faint); }
.search:focus-within { border-color: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
.search input { border: 0 !important; background: transparent !important; box-shadow: none !important; padding: 0; min-height: 0; font-size: 13.5px; }
.search kbd { font: 600 11px var(--sans); border: 1px solid var(--line-2); border-radius: 5px; padding: 1px 6px; color: var(--faint); }
.top-right { margin-left: auto; display: flex; align-items: center; gap: 4px; }
.top-link { background: none; border: 0; color: var(--muted); font-size: 13px; padding: 8px 10px; border-radius: var(--r-sm); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.top-link:hover { background: var(--panel); color: var(--ink); }
.top-bell { position: relative; }
.top-bell .count { position: absolute; top: 2px; right: 0; min-width: 16px; padding: 0 4px; border-radius: 999px; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; background: var(--need); color: var(--need-ink); }
.side { background: var(--side); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 10px; position: sticky; top: 56px; height: calc(100vh - 56px); overflow-y: auto; }
.side-hire { width: 100%; margin-top: auto; flex: none; justify-content: center; min-height: 40px; background: var(--panel); }
.side-hire[aria-current="page"] { border-color: var(--go); color: var(--go); }
.menu-wrap { position: relative; }
.menu { position: absolute; right: 0; top: calc(100% + 6px); width: 280px; background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--r-lg); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); z-index: 20; overflow: hidden; }
.menu-who { display: flex; gap: 12px; align-items: center; padding: 14px 16px; }
.menu-sec { padding: 12px 16px; border-top: 1px solid var(--line); }
.menu-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 8px; margin: 0 -8px; width: calc(100% + 16px); border: 0; background: none; border-radius: var(--r-sm); color: var(--ink); font-size: 13.5px; cursor: pointer; text-align: left; }
.menu-item:hover { background: var(--panel-2); }
.brand { display: flex; align-items: center; gap: 10px; padding: 2px 8px 18px; }
.brand svg { width: 32px; height: 32px; flex: none; }
svg.mark { flex: none; filter: drop-shadow(0 1px 1.5px rgba(16, 20, 31, 0.16)); }
.brand-name { font-family: var(--serif); font-size: 17px; letter-spacing: -0.01em; }
.brand-sub { color: var(--faint); font-size: 12px; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 6px 10px; border: 0; background: none; border-radius: var(--r-sm); color: var(--muted); cursor: pointer; text-align: left; font-size: 13.5px; font-weight: 500; }
.nav button svg { flex: none; opacity: 0.85; }
.nav button:hover { background: var(--panel); color: var(--ink); }
.nav button[aria-current="page"] { background: var(--go-soft); color: var(--go); font-weight: 600; }
.nav button[aria-current="page"] svg { opacity: 1; }
.nav .count { margin-left: auto; min-width: 20px; padding: 0 7px; border-radius: 999px; font-size: 11.5px; font-weight: 700; text-align: center; line-height: 19px; background: var(--need); color: var(--need-ink); font-variant-numeric: tabular-nums; }
.nav .issue { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--bad); }
.nav button[aria-current="page"] .issue { color: inherit; opacity: 0.85; }
.nav .sep { height: 1px; background: var(--line); margin: 10px 6px; }
.nav .group { padding: 4px 10px 6px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); font-weight: 600; }
.me-name { font-weight: 600; }
.me-role { color: var(--faint); font-size: 12px; }
.allow-label { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }
.theme { display: flex; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.theme button { flex: 1; border: 0; background: none; padding: 5px 0; font-size: 12px; color: var(--muted); cursor: pointer; }
.theme button[aria-pressed="true"] { background: var(--panel-2); color: var(--ink); }
.linkish { background: none; border: 0; padding: 0; color: var(--faint); font-size: 12px; cursor: pointer; text-align: left; }
.linkish:hover { color: var(--ink); }

.main { min-width: 0; padding: 28px 36px 64px; }
/* Data pages use the whole width; pages you read or write on keep a measure.
   Both sit against the sidebar rather than floating in the middle. */
.page { display: flex; flex-direction: column; gap: 22px; }
.page.narrow { max-width: 880px; }
.page-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px; }
.eyebrow { color: var(--faint); font-size: 12.5px; margin-bottom: 4px; }
.page-title { font-family: var(--serif); font-size: 30px; font-weight: 600; line-height: 1.15; letter-spacing: -0.02em; font-variation-settings: "opsz" 96, "wdth" 100; }
.page-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

/* ---- data: figures, tables, badges ---- */
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 12px; align-items: center; min-width: 0; }
.kpi > :not(.kpi-ic) { grid-column: 2; }
.kpi-ic { grid-row: 1 / span 3; width: 38px; height: 38px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; background: var(--go-soft); color: var(--go); }
.kpi-ic.need { background: var(--need-soft); color: var(--need); }
.kpi-ic.ok { background: var(--ok-soft); color: var(--ok); }
.kpi-ic.info { background: var(--info-soft); color: var(--info); }
.kpi-ic.violet { background: var(--violet-soft); color: var(--violet); }
.kpi .k { font-size: 12px; font-weight: 600; color: var(--faint); }
.kpi .v { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.kpi .v.need { color: var(--need); } .kpi .v.bad { color: var(--bad); }
.kpi .n { font-size: 12px; color: var(--faint); }
.kpi button.n { background: none; border: 0; padding: 0; text-align: left; color: var(--go); cursor: pointer; }
/* A titled section: its title lives in the card's own header bar, so cards in
   neighbouring columns start on the same line and share edges. */
.sec { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); min-width: 0; overflow: hidden; }
.sec-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 0 18px; border-bottom: 1px solid var(--line); }
.sec-head .label { font-size: 12px; }
.sec-head .linkish { color: var(--go); font-size: 13px; }
.sec-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 12px; }
.sec-body.flush { padding: 0; gap: 0; }
.sec-body.flush > * + * { border-top: 1px solid var(--line); }
.sec-body.flush > .panel { border: 0; border-radius: 0; background: none; }
.sec-body.flush > .muted { padding: 16px 18px; font-size: 13.5px; }
.sec .empty { padding: 36px 24px; }
.sec-body.flush > .ask.fix { background: var(--bad-soft); }
.split > .wide, .split > .narrow { gap: 16px; }
.tcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.tbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.tbar .tools { margin-left: auto; display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0; }
.tbar .tools input, .tbar .tools select { min-height: 34px; padding: 5px 11px; font-size: 13px; width: auto; }
.tbar .tools select { padding-right: 32px; }
.tabs button .c { color: var(--faint); font-weight: 500; margin-left: 4px; font-variant-numeric: tabular-nums; }
.tscroll { overflow-x: auto; }
table.data { width: 100%; border-collapse: collapse; }
table.data th { font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); text-align: left; padding: 10px 16px; border-bottom: 1px solid var(--line); white-space: nowrap; }
table.data th.r, table.data td.r { text-align: right; }
table.data th button { all: unset; cursor: pointer; }
table.data th button:hover, table.data th button[aria-pressed="true"] { color: var(--ink); }
table.data td { padding: 11px 16px; border-bottom: 1px solid var(--line); font-size: 13.5px; vertical-align: middle; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.data tr:last-child td { border-bottom: 0; }
table.data tbody tr.link { cursor: pointer; }
table.data tbody tr.link:hover td { background: var(--panel-2); }
table.data td.wrap { white-space: normal; }
table.data tr.run-detail td { white-space: normal; background: var(--panel-2); padding: 14px 16px 16px; }
table.data .sub { display: block; font-size: 12px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
table.data .who { display: flex; align-items: center; gap: 12px; min-width: 0; }
table.data .who b { font-weight: 600; }
table.data tfoot td { font-weight: 600; border-top: 1px solid var(--line-2); border-bottom: 0; }
.tfoot { display: flex; justify-content: space-between; gap: 12px; padding: 10px 16px; font-size: 12.5px; color: var(--faint); border-top: 1px solid var(--line); }
.badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--panel-2); color: var(--muted); }
.badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.badge.working { background: var(--go-soft); color: var(--go); }
.badge.waiting { background: var(--need-soft); color: var(--need); }
.badge.bad, .badge.stuck { background: var(--bad-soft); color: var(--bad); }
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.t-probation { background: var(--need-soft); color: var(--need); }
.badge.t-trusted { background: var(--info-soft); color: var(--info); }
.badge.t-autonomous { background: var(--ok-soft); color: var(--ok); }
.badge[class*="t-"]::before { display: none; }
.badge.plain { background: none; border: 1px solid var(--line-2); color: var(--muted); font-weight: 500; }
.badge.plain::before { display: none; }
.spendcell { display: flex; align-items: center; gap: 10px; min-width: 170px; }
.spendcell .meter { flex: 1; }
.spendcell span { font-size: 12.5px; color: var(--muted); min-width: 92px; text-align: right; }
.meter.over > span { background: var(--bad); }
.seg { display: inline-flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); }
.seg button { border: 0; background: none; padding: 4px 12px; border-radius: 6px; font-size: 12.5px; font-weight: 600; color: var(--muted); cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--panel-2); color: var(--ink); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.mchart { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mchart .k { font-size: 12px; font-weight: 600; color: var(--faint); display: flex; justify-content: space-between; gap: 8px; }
.mchart .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.dbars { position: relative; display: flex; align-items: flex-end; gap: 2px; height: 64px; border-bottom: 1px solid var(--line-2); }
.dbars i { flex: 1; min-width: 1px; border-radius: 2px 2px 0 0; background: var(--bar, var(--go)); opacity: 0.9; }
.dbars i.zero { background: var(--line); height: 2px !important; opacity: 1; }
.dbars .none { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--faint); }
.axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }
.lede { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.lede .sec-body { gap: 6px; }
.lede .big { font-family: var(--sans); font-size: 26px; font-weight: 700; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.econ { display: flex; flex-direction: column; margin-top: 8px; border-top: 1px solid var(--line); }
.econ > div { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
.econ > div:last-child { border-bottom: 0; }
.econ b { font-variant-numeric: tabular-nums; }
.dear { color: var(--need); font-weight: 600; }
.serif, .ask-name, .item .t, .who-name, .card-name, .person-name, .role h3, .offer-name, .dialog h2, .solo h1, .big, .brand-name, .place b { letter-spacing: -0.02em; font-weight: 500; }
.label { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.main { padding: 24px clamp(16px, 2vw, 32px) 40px; }
.page-sub { margin-top: 6px; color: var(--muted); max-width: 66ch; }
.section-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--need); flex: none; }
.split { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.split > .wide { flex: 999 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.split > .narrow { flex: 1 1 290px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
/* Under a row of four KPIs: the same four columns, so the edges meet. */
.split.quarters { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; align-items: start; }
.split.quarters > .wide { grid-column: span 3; }
/* An empty slot (no running tasks) would still take a gap and push the column down. */
.split.quarters > .wide > :empty, .split.quarters > .narrow > :empty { display: none; }
@media (max-width: 1180px) { .split.quarters { grid-template-columns: minmax(0, 1fr); } .split.quarters > .wide { grid-column: auto; } }
.guide-body { font-size: 13.5px; max-height: 280px; overflow: auto; }
.guide-body > :first-child { margin-top: 0; } .guide-body > :last-child { margin-bottom: 0; }

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
.timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.timeline .dayhead { display: flex; align-items: center; gap: 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin-top: 6px; }
.timeline .dayhead::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.more-row { display: flex; justify-content: center; padding: 4px 0 8px; }
.bubble-me { align-self: flex-end; max-width: 80%; background: var(--solid); color: var(--solid-ink); border-radius: 14px 14px 4px 14px; padding: 10px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 4px 14px 14px 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.turn { display: flex; gap: 10px; align-items: flex-start; }
.turn > .bubble { flex: 1; }
/* Work a worker did (a run, a delivery) is a card, not a chat bubble: an icon
   where the avatar sits, a header strip naming what kind of thing it is. */
.turn > .kpi-ic { width: 30px; height: 30px; border-radius: 8px; flex: none; }
.kpi-ic.bad { background: var(--bad-soft); color: var(--bad); }
.workcard { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--r-lg); overflow: hidden; }
.wc-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--panel-2); border-bottom: 1px solid var(--line); min-width: 0; }
.wc-head b { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-kind { flex: none; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
.wc-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.wc-out { margin-top: 8px; max-height: 460px; overflow: auto; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg); }
.wc-out pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
.prose { font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; min-width: 0; }
.prose > * + * { margin-top: 8px; }
.prose p, .prose ul, .prose ol, .prose pre, .prose blockquote, .prose h3, .prose h4, .prose h5, .prose h6 { margin-bottom: 0; }
.prose h3 { font-size: 16px; font-weight: 650; margin-top: 14px; } .prose h4 { font-size: 14.5px; font-weight: 650; margin-top: 12px; }
.prose h5, .prose h6 { font-size: 13.5px; font-weight: 650; margin-top: 10px; }
.prose > :first-child { margin-top: 0; }
.prose ul, .prose ol { padding-left: 22px; } .prose li + li { margin-top: 3px; }
.prose code { font-family: var(--mono); font-size: 0.88em; background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 0 5px; }
.prose pre { background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 10px 12px; overflow-x: auto; }
.prose pre code { background: none; border: 0; padding: 0; }
.prose blockquote { color: var(--muted); padding-left: 12px; border-left: 2px solid var(--line-2); margin-left: 0; margin-right: 0; }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 12px 0; }
.prose a { color: var(--go); }
.composer { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--line-2); }
.composer textarea { border: 0; background: transparent; min-height: 54px; font-size: 15px; padding: 0; box-shadow: none; }
.composer textarea:focus { box-shadow: none; }
.setup-row { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.setup-row:last-child { border-bottom: 0; }
.setup-row .k { font-size: 12px; color: var(--muted); display: block; }
.setup-row .v { display: block; }
.rungs { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.rungs li { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--faint); --rung: var(--go); }
.rungs li::before { content: ""; height: 6px; border-radius: 999px; background: var(--line); }
.rungs li[data-l="probation"] { --rung: #e9a23b; } .rungs li[data-l="trusted"] { --rung: var(--info); } .rungs li[data-l="autonomous"] { --rung: var(--ok); }
.rungs li.on, .rungs li.past { color: var(--ink); }
.rungs li.on { font-weight: 600; }
.rungs li.on::before, .rungs li.past::before { background: var(--rung); }
.rungs li.next::before { background: repeating-linear-gradient(90deg, var(--rung) 0 6px, transparent 6px 10px); opacity: 0.7; }
.checklist { list-style: none; margin: 0; padding: 0; }
.checklist li { display: flex; gap: 14px; align-items: center; padding: 12px 0; border-top: 1px solid var(--line); }
.checklist li > span { flex: 1; display: flex; flex-direction: column; }
.checklist .ck-ok { color: var(--go); } .checklist .ck-bad { color: var(--bad); } .checklist .ck-off { color: var(--faint); }
.hirelay { display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start; }
.hire-main { flex: 999 1 560px; max-width: 780px; min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.hire-main > .page-head { margin: 0; }
.hire-crew { margin-top: -6px; font-size: 13px; }
.hire-brief { border-color: var(--line-2); box-shadow: 0 10px 30px -18px rgba(0, 0, 0, 0.35); }
.hire-brief:focus-within { border-color: var(--go); box-shadow: 0 0 0 3px var(--go-soft), 0 10px 30px -18px rgba(0, 0, 0, 0.35); }
.brief-hints { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12.5px; }
.bh { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 99px; background: var(--panel-2); color: var(--muted); font-size: 12px; transition: background .2s, color .2s; }
.bh.on { background: var(--ok-soft); color: var(--ok); font-weight: 600; }
.hire-ideas { flex: 1 1 340px; max-width: 460px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: 72px; }
.hk-schedule { --hk: var(--info); --hk-soft: var(--info-soft); }
.hk-slack { --hk: var(--violet); --hk-soft: var(--violet-soft); }
.hk-event { --hk: var(--need); --hk-soft: var(--need-soft); }
.hk-team { --hk: var(--ok); --hk-soft: var(--ok-soft); }
.hk-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.hk-tab { display: flex; align-items: center; gap: 10px; padding: 10px 12px; min-height: 52px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel); color: var(--ink); font: inherit; font-size: 13.5px; font-weight: 600; text-align: left; cursor: pointer; }
.hk-tab:hover { border-color: var(--line-2); }
.hk-tab[aria-selected="true"] { border-color: var(--hk); background: var(--hk-soft); }
.hk-ic { width: 32px; height: 32px; flex: none; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; background: var(--hk-soft); color: var(--hk); }
.hk-tab[aria-selected="true"] .hk-ic { background: var(--hk); color: var(--panel); }
.hk-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.hk-card-top { display: flex; gap: 12px; align-items: flex-start; }
.hk-card-top b { font-size: 14.5px; font-weight: 600; }
.hk-when { align-self: flex-start; font-size: 11.5px; font-weight: 600; color: var(--hk); background: var(--hk-soft); padding: 1px 8px; border-radius: 99px; }
.hk-lands { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; background: var(--panel-2); font-size: 12.5px; color: var(--muted); }
.hk-lands-k { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.hk-fit { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.hk-fit ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.hk-fit li { display: flex; gap: 8px; align-items: flex-start; }
.hk-fit li b { font-weight: 600; }
.hk-tick { width: 18px; height: 18px; flex: none; border-radius: 99px; display: inline-flex; align-items: center; justify-content: center; background: var(--ok-soft); color: var(--ok); margin-top: 1px; }
.hk-fit p { margin: 0; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12.5px; }
@media (max-width: 960px) { .hire-ideas { position: static; max-width: none; } }
.hiresteps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.hiresteps li { display: flex; flex-direction: column; gap: 4px; padding: 14px 4px 0; border-top: 2px solid var(--line-2); }
.hiresteps li.on { border-top-color: var(--ink); }
.sgroup { display: grid; grid-template-columns: minmax(180px, 300px) minmax(0, 1fr); gap: 16px 32px; align-items: start; }
.pad { padding: 18px; }
/* A panel whose first child is its title gets the section card's header bar,
   and its closing row of buttons is ruled off, so every form reads the same. */
.panel.pad > h2.section-title:first-child, .panel.pad > .spread:first-child:has(> h2.section-title) {
  margin: -18px -18px 2px; padding: 0 18px; min-height: 46px; border-bottom: 1px solid var(--line); align-items: center; }
.panel.pad > h2.section-title:first-child, .panel.pad > .spread:first-child > h2.section-title { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.panel.pad > .foot:last-child { padding-top: 16px; margin-top: 4px; border-top: 1px solid var(--line); }
.panel.pad label.field, .sec-body > label.field { max-width: 640px; }
.panel.pad .grid2 label.field, .form label.field { max-width: none; }
.list > * + * { border-top: 1px solid var(--line); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; border: 1px solid var(--line-2); background: var(--panel); padding: 0 14px; border-radius: var(--r); cursor: pointer; font-weight: 600; font-size: 13px; line-height: 1; text-decoration: none; color: var(--ink); white-space: nowrap; }
.btn:hover { border-color: var(--faint); }
.btn.go { background: var(--go); color: var(--go-ink); border-color: var(--go); }
.btn.go:hover { filter: brightness(1.07); }
.btn.quiet { background: none; border-color: transparent; color: var(--muted); }
.btn.quiet:hover { color: var(--ink); border-color: var(--line-2); }
.btn.danger { color: var(--bad); background: none; }
.btn.danger:hover { border-color: var(--bad); }
.btn.small { min-height: 30px; padding: 0 10px; font-size: 12.5px; border-radius: var(--r-sm); }
.btn.icon { width: 36px; padding: 0; }
.btn.small.icon { width: 30px; }
.btn:disabled { opacity: 0.5; cursor: default; filter: none; }
.btn[aria-pressed="true"] { border-color: var(--go); color: var(--go); }
.chip { display: inline-flex; align-items: center; min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--panel-2); cursor: pointer; font-size: 13.5px; }
.chip:hover { border-color: var(--go); }
.chip.dashed { border-style: dashed; background: none; color: var(--muted); }
.chip[aria-pressed="true"] { border-color: var(--go); color: var(--ink); background: var(--go-soft); }
/* Fields share a button's height, so a row of them lines up; selects are drawn
   to match the inputs rather than as the platform's pill. */
textarea, input[type=text], input[type=number], input[type=search], input[type=time], input[type=date], select { width: 100%; min-height: 36px; border: 1px solid var(--line-2); background-color: var(--panel); border-radius: var(--r); padding: 7px 11px; font-size: 13.5px; line-height: 1.45; }
select { appearance: none; -webkit-appearance: none; padding-right: 32px; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--faint) 50%), linear-gradient(135deg, var(--faint) 50%, transparent 50%);
  background-position: calc(100% - 16px) 52%, calc(100% - 11px) 52%; background-size: 5px 5px; background-repeat: no-repeat; }
textarea:focus, input:focus, select:focus { outline: none; border-color: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
textarea { min-height: 84px; resize: vertical; }
textarea::placeholder, input::placeholder { color: var(--faint); }
.inline-form { display: flex; gap: 8px; flex-wrap: wrap; }
.inline-form > input { flex: 1 1 260px; }
.srows { padding: 0; }
.now-run { display: flex; flex-direction: column; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.now-run:last-child { border-bottom: 0; padding-bottom: 0; }
.nowslot:empty, #run-note:empty { display: none; }
.nowbar { background: var(--panel); border: 1px solid var(--go); border-radius: var(--r-lg); padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
.nowbar.need { border-color: var(--need); }
.nowbar .line { display: flex; gap: 8px 16px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.nowbar .say { display: flex; gap: 12px; align-items: center; font-size: 15px; min-width: 0; flex: 1 1 420px; }
.livedot { width: 9px; height: 9px; border-radius: 50%; background: var(--go); flex: none; animation: livepulse 1.8s infinite; }
.livedot.need { background: var(--need); animation: none; }
@keyframes livepulse { 0% { box-shadow: 0 0 0 0 var(--go-soft); } 70% { box-shadow: 0 0 0 9px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
@media (prefers-reduced-motion: reduce) { .livedot { animation: none; } }
.segs { list-style: none; margin: 0; padding: 0; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px; }
/* A thread opened in full: one vertical timeline, how far along on top. */
.vprog { display: flex; flex-direction: column; gap: 7px; margin-bottom: 14px; }
.vprog .vp-line { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; color: var(--muted); }
.vprog .vp-line b { color: var(--ink); font-weight: 600; }
.vprog .vp-bar { height: 6px; border-radius: 999px; background: var(--line); display: flex; overflow: hidden; }
.vprog .vp-bar span { display: block; height: 100%; }
.vsteps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.vstep { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; column-gap: 14px; border-radius: 10px; }
.vstep.now { background: var(--go-soft); margin: 0 -10px; padding: 0 10px; }
.vstep.need { background: var(--need-soft); margin: 0 -10px; padding: 0 10px; }
.vstep .vs-rail { display: flex; flex-direction: column; align-items: center; padding-top: 10px; }
.vstep .vs-dot { width: 20px; height: 20px; border-radius: 50%; box-sizing: border-box; display: flex; align-items: center; justify-content: center; flex: none; background: var(--panel); border: 2px solid var(--line); }
.vstep.done .vs-dot { background: var(--ok); border-color: var(--ok); color: #fff; }
.vstep.now .vs-dot { border-color: var(--go); }
.vstep.now .vs-dot::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--go); }
.vstep.need .vs-dot { border-color: var(--need); }
.vstep.need .vs-dot::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--need); }
.vstep.failed .vs-dot { background: var(--bad); border-color: var(--bad); color: #fff; }
.vstep.skipped .vs-dot, .vstep.last .vs-dot { border-style: dashed; }
.vstep .vs-link { flex: 1; width: 2px; min-height: 10px; margin-top: 4px; background: var(--line); }
.vstep.done .vs-link { background: var(--ok); }
/* Done up to the step in hand: the link into it is green too. */
.vstep.done + .vstep.now .vs-rail, .vstep.done + .vstep.need .vs-rail { background: linear-gradient(var(--ok), var(--ok)) center top / 2px 10px no-repeat; }
.vstep:last-child .vs-body { padding-bottom: 20px; }
.vs-live { display: flex; align-items: flex-start; gap: 10px; color: var(--ink); line-height: 1.45; }
.vs-spin { width: 13px; height: 13px; margin-top: 3px; flex: none; border-radius: 50%; border: 2px solid var(--go-soft); border-top-color: var(--go); animation: ntspin 0.9s linear infinite; }
.vstep:last-child .vs-link { display: none; }
.vstep .vs-body { padding: 10px 0 16px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.vstep .vs-name { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.vstep .vs-name b { font-weight: 600; }
.vstep.next .vs-name b, .vstep.last .vs-name b, .vstep.skipped .vs-name b { font-weight: 500; color: var(--muted); }
.vstep .vs-tag { font-size: 12.5px; font-weight: 500; }
.vstep.now .vs-tag { color: var(--go); } .vstep.need .vs-tag { color: var(--need); } .vstep.failed .vs-tag { color: var(--bad); }
.vstep .vs-sub { font-size: 12.5px; color: var(--faint); }
.vstep .vs-time { padding-top: 11px; font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.segs > li { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.segs .bar { height: 5px; border-radius: 3px; background: var(--line); }
.segs .done .bar { background: var(--ok); } .segs .now .bar { background: var(--go); } .segs .need .bar { background: var(--need); } .segs .failed .bar { background: var(--bad); } .segs .skipped .bar { background: var(--line-2); }
.segs .now .bar { background: linear-gradient(90deg, var(--go) 0 40%, var(--go-soft) 40% 100%); background-size: 200% 100%; animation: segrun 1.6s linear infinite; }
@keyframes segrun { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .segs .now .bar { animation: none; background: var(--go); } }
.segs .l { font-size: 12.5px; font-weight: 500; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.segs .done .l { color: var(--ok); } .segs .now .l { color: var(--go); font-weight: 600; } .segs .need .l { color: var(--need); font-weight: 600; } .segs .failed .l { color: var(--bad); }
.segs .s { font-size: 12px; color: var(--faint); min-height: 1em; }
.thread { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; transition: box-shadow .3s; }
.thread.live { border-color: var(--go); }
.thread.need { border-color: var(--need); box-shadow: inset 3px 0 0 var(--need); }
.thread.bad { border-color: var(--bad-line); }
.thread.flash { box-shadow: 0 0 0 3px var(--go-soft); }
.t-main { padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
.t-top { display: flex; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; align-items: baseline; }
.t-src { display: flex; gap: 4px 10px; align-items: baseline; min-width: 0; flex-wrap: wrap; flex: 1 1 320px; }
.t-kind { font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); white-space: nowrap; }
.t-prompt { font-size: 15.5px; font-weight: 600; overflow-wrap: anywhere; }
.t-head { margin: 0; font-size: 14.5px; }
.t-say { display: flex; gap: 12px; align-items: flex-start; }
.t-why > summary, .t-report > summary { cursor: pointer; color: var(--muted); font-size: 13.5px; }
.t-why[open] > summary { margin-bottom: 10px; }
.t-ok { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: var(--r); background: var(--need-soft); }
.t-item { display: flex; gap: 10px; align-items: flex-start; }
.t-run { display: flex; flex-direction: column; gap: 10px; }
.run-files { display: flex; flex-direction: column; gap: 6px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; width: max-content; max-width: 100%; flex-wrap: wrap; }
.seg-b { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 13.5px; padding: 8px 14px; min-height: 38px; cursor: pointer; }
.seg-b.on { background: var(--go-soft); color: var(--ink); font-weight: 600; }
.scope-row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1.2fr); gap: 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
.scope-row.wide { background: color-mix(in srgb, var(--need) 8%, transparent); }
@media (max-width: 700px) { .scope-row { grid-template-columns: 1fr 1fr; } }
.run-files:empty { display: none; }
.file-frame { width: 100%; height: 70vh; border: 1px solid var(--line); border-radius: var(--r); background: #fff; }
.file-frame.tall { height: calc(100vh - 230px); }
/* In the side panel a report fills what is left below its buttons. */
.reader-body:has(> .file-frame) { display: flex; flex-direction: column; padding: 12px 14px; }
.reader-body > .file-frame { flex: 1; height: auto; min-height: 0; }
.t-answer { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: var(--r); background: var(--ok-soft); font-size: 15px; }
.t-answer .t-kind { color: var(--ok); }
.thread .dayhead, .stack > .dayhead { display: flex; align-items: center; gap: 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin-top: 6px; }
.stack > .dayhead::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.t-turn { display: flex; flex-direction: column; gap: 12px; padding-top: 14px; border-top: 1px dashed var(--line); }
.t-replybar { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
.t-compose { display: flex; flex-direction: column; gap: 8px; }
.t-compose textarea { font: inherit; min-height: 64px; }
.t-piece { display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel-2); }
.members { display: flex; flex-direction: column; gap: 4px; }
.member { display: flex; gap: 10px; align-items: center; padding: 8px; border: 0; background: transparent; border-radius: var(--r); cursor: pointer; font: inherit; color: inherit; min-height: 44px; text-align: left; }
.member:hover { background: var(--panel-2); }
.sec-body.flush > .members { padding: 6px 8px; }
.m-role { font-size: 12.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-role.doing { color: var(--go); }
.faces { display: flex; }
.faces > .avatar { border: 2px solid var(--bg); }
.faces > .avatar + .avatar { margin-left: -8px; }
.t-title { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.t-spend { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--faint); }
.t-spend .meter { width: 160px; flex: none; }
/* Team tasks: a summary card on the team page, a page of its own. */
.tmgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
.tmcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.tmcard.add { background: none; border-style: dashed; border-color: var(--line-2); }
.tmcard.clickable { cursor: pointer; transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s; }
.tmcard.clickable:hover { transform: translateY(-2px); border-color: var(--line-2); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16); }
.tmcard.clickable:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .tmcard.clickable { transition: none; } .tmcard.clickable:hover { transform: none; } }
.tmname { font-family: var(--serif); font-size: 17px; font-weight: 600; color: var(--ink); text-align: left; }
.tmpurpose { margin: 2px 0 0; font-size: 13px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tmmeta { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; font-size: 12.5px; }
.tmmeta .faces { flex: none; }
.tmstats { flex: 1 1 160px; min-width: 0; }
.tmlive { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--go); }
.tmlive .livedot { width: 7px; height: 7px; }
.tmfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
.tmcard.add .tmfoot { border-top-style: dashed; border-top-color: var(--line-2); }
.tsegs .next { background: var(--line); }
.tsum { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.tsum.live { border-color: var(--go); } .tsum.need { border-color: var(--need); }
.t-now { margin: 0; font-size: 13.5px; color: var(--muted); }
.tsegs { list-style: none; margin: 0; padding: 0; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; }
.tsegs li { height: 5px; border-radius: 3px; background: var(--line); }
.tsegs .done { background: var(--ok); } .tsegs .part { background: #e9a23b; } .tsegs .failed { background: var(--bad); } .tsegs .need { background: var(--need); }
.tsegs .now { background: linear-gradient(90deg, var(--go) 0 40%, var(--go-soft) 40% 100%); background-size: 200% 100%; animation: segrun 1.6s linear infinite; }
.prows > .prow + .prow { border-top: 1px solid var(--line); }
.prow { padding: 12px 18px; display: flex; flex-direction: column; gap: 8px; }
.prow.slow { background: var(--need-soft); }
.prow-main { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.prow-acts { display: flex; align-items: center; gap: 10px; white-space: nowrap; }
.pask > summary { color: var(--muted); font-size: 13px; list-style: none; }
.pask > summary::-webkit-details-marker { display: none; }
.pask[open] > summary { color: var(--faint); }
.pask > p { margin: 6px 0 0; font-size: 13px; color: var(--muted); white-space: pre-wrap; }
.fgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px 18px; }
.fname { font-family: var(--mono); font-size: 12.5px; color: var(--go); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table.files .fname { color: var(--ink); }
.ftype { display: inline-block; min-width: 34px; text-align: center; font-size: 10.5px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
table.files tr.viewing td { background: var(--panel-2); }
table.files tr.picked td { background: var(--go-soft); }
.fbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); min-height: 50px; box-sizing: border-box; }
.fbar.on { background: var(--go-soft); }
.deststrip { display: flex; flex-wrap: wrap; gap: 8px 22px; align-items: center; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel); font-size: 13px; }
.deststrip .label { font-size: 11.5px; }
.gsetup { display: flex; flex-direction: column; gap: 14px; margin-top: 4px; }
.gsetup p { margin: 0; font-size: 13.5px; }
.gwho { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.gwho > div { padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel-2); display: flex; flex-direction: column; gap: 4px; }
.gsteps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; max-width: 860px; }
.gstep { display: flex; gap: 12px; align-items: flex-start; }
.gnum { width: 24px; height: 24px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; background: var(--go-soft); color: var(--go); margin-top: 1px; }
.gbul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; font-size: 13.5px; }
.gbul code { font-size: 12px; }
.gmore > summary { font-weight: 600; }
.gmore[open] > summary { margin-bottom: 8px; }
.gsetup-done > summary { font-size: 13px; }
.steps-plain { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; font-size: 13.5px; }
.steps-plain code { font-size: 12px; overflow-wrap: anywhere; }
.deststrip .dest { display: inline-flex; gap: 8px; align-items: center; }
.drawer { position: fixed; top: 56px; right: 0; bottom: 0; width: min(760px, 94vw); z-index: 30; background: var(--panel); border-left: 1px solid var(--line-2); box-shadow: -18px 0 40px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; animation: drawerin .18s ease-out; }
@keyframes drawerin { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
.drawer-head { display: flex; gap: 12px; align-items: flex-start; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.drawer-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
.drawer-acts .badge { margin-left: auto; }
.drawer-body { flex: 1; overflow: auto; padding: 22px 28px 40px; }
.drawer-body .prose { max-width: 68ch; font-size: 15px; }
.drawer.wide { width: min(1200px, 96vw); }
.drawer.wide .drawer-body .prose { max-width: 84ch; }
.drawer-body.frame { padding: 0; overflow: hidden; display: flex; }
.drawer-frame { flex: 1; width: 100%; border: 0; background: #fff; }
.drawer-body pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
@media (max-width: 880px) { .drawer { top: 0; } }
.sr { position: absolute; left: -9999px; }
/* The Library: one dense row per deliverable, opening in place. */
.lib-search { flex: 0 1 460px; height: 40px; }
.libhead, .librow { display: grid; grid-template-columns: 40px minmax(0, 1fr) 170px 130px 90px 80px; gap: 14px; align-items: center; padding: 0 16px; }
.libhead { padding-top: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--line); font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }
.libhead .r, .libwhen, .librate { text-align: right; }
.librow { width: 100%; padding-top: 10px; padding-bottom: 10px; border: 0; border-bottom: 1px solid var(--line); background: var(--panel); text-align: left; font: inherit; color: inherit; cursor: pointer; }
.librow:hover, .librow[aria-expanded="true"] { background: var(--panel-2); }
.librow > .badge { justify-self: start; }
.libkind { grid-row: auto; width: 32px; height: 32px; border-radius: 8px; }
.libtag { flex: none; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--go); }
.libtag.info { color: var(--info); } .libtag.violet { color: var(--violet); } .libtag.need { color: var(--need); } .libtag.ok { color: var(--ok); }
.libmain { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.libtitle { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.libsrc { display: flex; gap: 6px; align-items: center; min-width: 0; font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; }
.libsrc > b { font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; }
.libsrc > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.libfrom { display: flex; gap: 8px; align-items: center; min-width: 0; font-size: 13px; }
.libfrom > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.librate { font-size: 12.5px; color: var(--faint); } .librate.yes { color: var(--ok); } .librate.no { color: var(--bad); }
.libopen { padding: 14px 16px 16px 70px; background: var(--panel-2); border-bottom: 1px solid var(--line); }
.libsnip { display: flex; gap: 8px; align-items: baseline; min-width: 0; font-size: 13px; color: var(--muted); }
.libsnip > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.libwhere { flex: none; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }
mark { background: color-mix(in srgb, var(--need) 28%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
mark.on { background: var(--need); color: var(--need-ink); }
.findbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 8px 12px; margin-bottom: 12px; border: 1px solid var(--line-2); border-radius: var(--r); background: var(--panel); font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.findbar > span:nth-child(2) { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.camerow { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 12px 16px; border: 0; background: none; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.camerow:hover { background: var(--panel-2); }
.camerow .libkind { width: 28px; height: 28px; border-radius: 7px; flex: none; margin-top: 1px; }
.cametitle { font-weight: 600; font-size: 13.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.camemore { display: block; padding: 10px 16px; color: var(--go); font-size: 12.5px; }
.libsum { margin: 0; font-size: 13.5px; color: var(--muted); max-width: 90ch; }
.libfiles { display: flex; flex-direction: column; gap: 6px; max-width: 760px; }
.libfile { display: flex; gap: 10px; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--r); background: var(--panel); font: inherit; color: inherit; cursor: pointer; text-align: left; }
.libfile:hover { border-color: var(--go); }
.libfile code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; }
.libfile .go-link { color: var(--go); font-size: 12.5px; font-weight: 600; }
.librows .empty { padding: 36px 24px; }
.libmore { display: flex; justify-content: center; padding: 14px; border-bottom: 1px solid var(--line); }
@media (max-width: 880px) { .libhead { display: none; } .librow { grid-template-columns: 34px minmax(0, 1fr); } .librow > :nth-child(n+3) { display: none; } .libopen { padding-left: 16px; } }
.reach-code { display: flex; gap: 8px; align-items: flex-start; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 10px 12px; }
.reach-code pre { margin: 0; flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12.5px; }
.tool-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: start; padding: 14px 18px; border-top: 1px solid var(--line); }
.tool-target { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool-step { font-size: 13.5px; color: var(--muted); }
.tool-step.ok { color: var(--ok); } .tool-step.need { color: var(--need); } .tool-step.bad { color: var(--bad); }
.tool-actions { display: flex; gap: 8px; align-items: center; }
.tool-actions { flex-wrap: wrap; justify-content: flex-end; }
.tool-actions select { max-width: 210px; }
.tool-summary { display: flex; flex-wrap: wrap; gap: 6px 18px; padding: 12px 18px 6px; font-size: 13px; color: var(--muted); }
@media (max-width: 640px) { .tool-row { grid-template-columns: minmax(0, 1fr); } }
.reader-wrap { position: fixed; inset: 0; z-index: 50; }
.reader-back { position: absolute; inset: 0; background: rgba(10, 12, 20, 0.35); }
.reader { position: absolute; top: 0; right: 0; bottom: 0; width: min(820px, 94vw); background: var(--panel); border-left: 1px solid var(--line); display: flex; flex-direction: column; box-shadow: -12px 0 32px rgba(0,0,0,.18); }
.reader.wide { width: min(1400px, 100vw); }
.read-page { max-width: 1200px; font-size: 14.5px; }
.reader-head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.reader-body { flex: 1; overflow: auto; padding: 18px 22px 40px; font-size: 14px; }
.need-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.need-card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.need-card.need { border-color: var(--need); }
.need-card.need .t-kind { color: var(--need); }
.tools-table td { vertical-align: middle; }
.tools-table tr.dim td { background: var(--panel-2); }
.tstate { display: inline-flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); white-space: nowrap; }
.tstate.ok { color: var(--ok); } .tstate.need { color: var(--need); } .tstate.bad { color: var(--bad); }
.tl-list { border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; max-height: 420px; overflow-y: auto; }
.tl-group { padding: 7px 12px; background: var(--panel-2); font-size: 12px; font-weight: 600; color: var(--muted); border-top: 1px solid var(--line); }
.tl-group:first-child { border-top: 0; }
.tl-row { display: flex; gap: 10px; align-items: center; padding: 9px 12px; border-top: 1px solid var(--line); cursor: pointer; min-height: 40px; }
.working-wrap { position: relative; }
.working-pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--go); border-radius: 999px; padding: 4px 12px; color: var(--go); }
.work-pop { position: absolute; right: 0; top: calc(100% + 8px); width: min(460px, 92vw); max-height: 70vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: 0 12px 32px rgba(0,0,0,.18); z-index: 40; }
.work-pop-head { display: flex; justify-content: space-between; align-items: baseline; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.work-row { display: flex; gap: 10px; align-items: center; width: 100%; padding: 10px 14px; background: transparent; border: 0; border-top: 1px solid var(--line); color: inherit; font: inherit; cursor: pointer; text-align: left; min-height: 48px; }
.work-row:first-child { border-top: 0; }
.work-row:hover { background: var(--panel-2); }
.watch-head { padding-bottom: 12px; border-bottom: 1px solid var(--line); margin-bottom: 8px; }
.watch-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.watch-list.boxed { max-height: 320px; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0 12px; }
.watch-item { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 10px; padding: 7px 0; border-bottom: 1px dashed var(--line); font-size: 13.5px; overflow-wrap: anywhere; }
.watch-item.said .watch-said { color: var(--muted); font-style: italic; }
.watch-item.bad { color: var(--bad); } .watch-item.need { color: var(--need); }
.watch-at { font-size: 12px; font-variant-numeric: tabular-nums; }
.watch-item.now > span:last-child > span:first-child { color: var(--go); font-weight: 600; }
.watch-raw { margin: 0; padding: 6px 8px; background: var(--panel-2); border-radius: 6px; font: 11.5px/1.5 var(--mono, ui-monospace, Menlo, monospace); color: var(--muted); white-space: pre-wrap; word-break: break-all; }
.wl-detail-ask { margin: 0; font-size: 13.5px; color: var(--muted); }
.wl-ask { display: flex; gap: 8px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 5px 5px 5px 14px; }
.wl { display: flex; flex-wrap: wrap; gap: 16px; align-items: stretch; }
.wl-left { flex: 1 1 300px; max-width: 400px; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; display: flex; flex-direction: column; height: calc(100vh - 320px); min-height: 420px; }
.wl-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.chip.small { min-height: 28px; font-size: 12.5px; padding: 0 10px; }
.wl-list { overflow-y: auto; flex: 1; }
.wl-day { padding: 10px 14px 4px; font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.wl-row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 3px 10px; align-items: center; width: 100%; padding: 9px 14px; border: 0; border-left: 3px solid transparent; border-top: 1px solid var(--line); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wl-day + .wl-row { border-top: 0; }
.wl-row:hover { background: var(--panel-2); }
.wl-row.on { background: var(--go-soft); border-left-color: var(--go); }
.wl-row.quiet .wl-title { color: var(--muted); font-weight: 400; }
.wl-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wl-sub { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wl-meta { font-size: 12px; color: var(--faint); white-space: nowrap; text-align: right; }
.wl-meta.bad { color: var(--bad); } .wl-meta.need { color: var(--need); }
.wl-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line-2); }
.wl-dot.live { background: var(--go); animation: livepulse 1.8s infinite; } .wl-dot.ok { background: var(--ok); } .wl-dot.bad { background: var(--bad); } .wl-dot.need { background: var(--need); }
@media (prefers-reduced-motion: reduce) { .wl-dot.live { animation: none; } }
.wl-more { width: 100%; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--go); font: inherit; font-size: 13px; padding: 10px; cursor: pointer; min-height: 42px; }
.wl-detail { flex: 999 1 520px; min-width: 0; display: flex; }
.wl-detail-in { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); display: flex; flex-direction: column; height: calc(100vh - 320px); min-height: 420px; }
.wl-detail-body .watch-list.boxed { max-height: 46vh; }
@media (max-width: 960px) { .wl-left { max-width: none; height: auto; max-height: 50vh; } .wl-detail-in { height: auto; } }
.wl-detail-head { padding: 16px 20px 10px; display: flex; flex-direction: column; gap: 4px; border-bottom: 1px solid var(--line); }
.wl-detail-title { margin: 0; font-size: 19px; font-weight: 600; }
.wl-detail-body { padding: 4px 6px 16px; overflow-y: auto; flex: 1; }
.wl-detail-body > .thread { border: 0; box-shadow: none; background: transparent; }
.wl-detail-body > .thread .t-top:first-child .t-src { display: none; }
.wl-detail-body > .thread .t-main { padding: 14px 14px 16px; }
.wl-detail-body > .thread .t-main > .t-top:first-child { display: none; }
.wl-detail-body > section { padding: 0 14px; }
.wl-detail-foot { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid var(--line); }
.wl-detail-foot:empty { display: none; }
.wl-empty { padding: 40px; text-align: center; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); flex: 1; height: calc(100vh - 320px); min-height: 420px; box-sizing: border-box; }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.md-table { overflow-x: auto; margin: 8px 0; }
.md-table table { border-collapse: collapse; font-size: 13px; min-width: 100%; }
.md-table th, .md-table td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
.md-table th { background: var(--panel-2); font-weight: 600; white-space: nowrap; }
.md-table td { overflow-wrap: normal; word-break: normal; min-width: 3ch; }
.role h3 .linkish:hover { text-decoration: underline; }
.quietrow { font: inherit; font-size: 13.5px; text-align: left; background: transparent; border: 1px dashed var(--line-2); border-radius: var(--r-lg); padding: 10px 16px; color: var(--muted); min-height: 44px; cursor: pointer; }
.sec-head > .linkish, .sec-head > button, .sec-head > a { white-space: nowrap; flex: none; }
.srow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px 16px; align-items: center; padding: 14px 18px; border-top: 1px solid var(--line); }
.srow:first-child { border-top: 0; }
.srow.quiet { opacity: 0.6; }
.srow-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.srow-name code { font-size: 13px; }
.srow-name .faint { font-size: 12.5px; }
.srow > .srow-edit { grid-column: 1 / -1; }
@media (max-width: 640px) { .srow { grid-template-columns: minmax(0, 1fr) auto; } .srow > .tag { grid-column: 1; justify-self: start; } }
.secret { -webkit-text-security: disc; font-family: var(--mono); letter-spacing: 0.04em; }
label.field { display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--muted); }
label.field > input, label.field > select, label.field > textarea { font-weight: 400; color: var(--ink); }
.hint { font-size: 12.5px; color: var(--faint); font-weight: 400; }
/* A form laid out in steps: a readable width, each step ruled off. */
.form { display: flex; flex-direction: column; max-width: 960px; }
.fstep { display: flex; flex-direction: column; gap: 12px; padding: 20px 0; border-top: 1px solid var(--line); }
.fstep:first-child { border-top: 0; padding-top: 0; }
.form-foot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 18px; border-top: 1px solid var(--line); }
.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.choice { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: var(--r); border: 1px solid var(--line-2); background: var(--panel); color: var(--ink); text-align: left; cursor: pointer; }
.choice:hover { border-color: var(--go); }
.choice[aria-checked="true"] { border-color: var(--go); background: var(--go-soft); }
.choice b { font-size: 14px; font-weight: 600; }
.choice span { font-size: 12.5px; color: var(--muted); }
.alpha { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; background: var(--need-soft); color: var(--need); }
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
.avatar.pic { background: var(--panel-2); overflow: hidden; border-radius: 22%; }
.avatar.pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.picgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: 10px; }
.picgrid button { border: 2px solid transparent; border-radius: 26%; padding: 2px; background: none; cursor: pointer; justify-self: center; }
.picgrid button:hover, .picgrid button[aria-pressed="true"] { border-color: var(--go); }
.tones { gap: 6px; }
.tone { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--panel); box-shadow: 0 0 0 1px var(--line); cursor: pointer; padding: 0; }
.tone[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--go); }
.picgrid img { width: 56px; height: 56px; border-radius: 22%; display: block; background: var(--panel-2); }
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
.tabs { display: flex; gap: 22px; flex-wrap: wrap; border-bottom: 1px solid var(--line); }
.tabs button { border: 0; background: none; padding: 12px 2px; font-size: 13.5px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tabs button:hover { color: var(--ink); }
.tabs button[aria-selected="true"], .tabs button[aria-pressed="true"] { color: var(--ink); border-bottom-color: var(--go); }
.tbar .tabs { border-bottom: 0; }

/* ---- people ---- */
.people-grid { display: grid; grid-template-columns: minmax(0, 2.4fr) minmax(300px, 1fr); gap: 20px; align-items: start; }
.people-grid > aside.stack { gap: 16px; }
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
.dialog.small { max-width: 480px; gap: 14px; padding: 22px 24px; margin-top: 10vh; }
.dialog.small h2 { font-size: 20px; }
.dialog.small p { margin: 0; }
.ntwrap { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
.ntmain { flex: 999 1 560px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.ntside { flex: 1 1 300px; max-width: 400px; position: sticky; top: 72px; }
.ntbar { position: sticky; bottom: 0; z-index: 5; margin: 4px -4px 0; padding: 10px 4px 14px; background: linear-gradient(to bottom, transparent, var(--bg) 14px); display: flex; flex-direction: column; gap: 8px; }
.ntbar-inner { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px 10px 16px; background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--r-lg); box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.35); }
.ntbar-sum { flex: 1 1 240px; font-size: 13.5px; color: var(--muted); }
.ntstate { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
.ntstate.ok { color: var(--ok); }
.ntstate.need { color: var(--need); white-space: normal; text-align: right; max-width: 240px; }
.ntstate.bad { color: var(--bad); }
.ntstate.run { color: var(--go); }
.ntspin { width: 12px; height: 12px; border-radius: 99px; border: 2px solid var(--go-soft); border-top-color: var(--go); animation: ntspin 0.8s linear infinite; }
@keyframes ntspin { to { transform: rotate(360deg); } }
.ntrow { display: flex; flex-wrap: wrap; gap: 14px; }
.ntnum { width: 22px; height: 22px; flex: none; border-radius: 99px; display: inline-flex; align-items: center; justify-content: center; font-size: 11.5px; font-weight: 700; background: var(--panel-2); color: var(--muted); }
.ntnum.you { background: var(--go-soft); color: var(--go); }
.nthead { justify-content: flex-start; gap: 10px; }
.nthead h2 { margin: 0; font-family: inherit; font-size: 15px; font-weight: 600; letter-spacing: 0; }
.nthead > :last-child:not(h2) { margin-left: auto; }
.ntsuggest { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 14px; border: 1px dashed var(--line-2); border-radius: var(--r-lg); }
.ntpick { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; align-items: start; }
.ntw { display: flex; gap: 10px; align-items: center; height: 64px; box-sizing: border-box; text-align: left; padding: 0 12px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel); color: var(--ink); font: inherit; cursor: pointer; min-width: 0; }
.ntw:hover { border-color: var(--line-2); }
.ntw[aria-pressed="true"] { border-color: var(--go); background: var(--go-soft); }
.ntw-text { flex: 1; min-width: 0; display: flex; flex-direction: column; font-size: 12px; line-height: 1.3; }
.ntw-text b { font-size: 13.5px; font-weight: 600; line-height: 1.4; }
.ntclamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ntw-new { background: var(--go-soft); color: var(--go); border: 1px dashed var(--go); }
.ntw-tag { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--go); }
.ntbox { width: 20px; height: 20px; flex: none; border-radius: 6px; border: 1px solid var(--line-2); display: inline-flex; align-items: center; justify-content: center; color: var(--go-ink); }
.ntw[aria-pressed="true"] .ntbox { background: var(--go); border-color: var(--go); }
.ntempty { padding: 14px; border: 1px dashed var(--line-2); border-radius: var(--r-lg); color: var(--faint); font-size: 13px; }
.ntroles { border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.ntrole { display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 12px; }
.ntrole + .ntrole { border-top: 1px solid var(--line); }
.ntrole-who { width: 120px; flex: none; display: flex; flex-direction: column; min-width: 0; }
.ntrole-who b { font-weight: 600; }
.ntrole-who .faint { font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntrole.hire { align-items: flex-start; padding-top: 10px; padding-bottom: 10px; border-top-style: dashed; background: var(--go-soft); }
.ntrole-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding: 0 11px; }
.ntrole > input { flex: 1; min-width: 0; }
.ntchecks { display: flex; flex-direction: column; }
.ntcheck { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
.ntcheck b { font-size: 14px; font-weight: 600; }
.icon-btn { width: 32px; height: 32px; flex: none; border: 0; border-radius: var(--r); background: none; color: var(--faint); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.icon-btn:hover { background: var(--panel-2); color: var(--ink); }
.switch { width: 40px; height: 24px; flex: none; border: 0; border-radius: 99px; padding: 3px; background: var(--line-2); cursor: pointer; display: flex; justify-content: flex-start; }
.switch::after { content: ''; width: 18px; height: 18px; border-radius: 99px; background: #fff; display: block; }
.switch[aria-checked="true"] { background: var(--go); justify-content: flex-end; }
.ntflow { list-style: none; margin: 0; display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.ntflow li { display: flex; gap: 10px; align-items: flex-start; }
.ntflow b { font-size: 13.5px; font-weight: 600; }
.signbox { padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--panel-2); display: flex; flex-direction: column; gap: 10px; }
section.checking .checklist { opacity: 0.45; transition: opacity 0.15s; }
.rechecked { color: var(--ok) !important; }
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
  .frame { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; }
  .topbar { position: static; flex-wrap: wrap; padding: 10px 16px; gap: 10px; }
  .topbar .brand { width: auto; }
  .search { order: 3; flex-basis: 100%; max-width: none; }
  .search kbd, .top-link .lbl { display: none; }
  .side-hire { display: none; }
  .side { min-width: 0; position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 16px; border-right: 0; border-bottom: 1px solid var(--line); overflow: visible; }
  .brand { padding: 0 8px 0 0; }
  .brand-sub, .nav .sep { display: none; }
  .nav { flex-direction: row; overflow-x: auto; width: 100%; min-width: 0; order: 3; scrollbar-width: none; }
  .nav button { white-space: nowrap; width: auto; }
  .nav button[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--go); }
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

/* Processes: a board of stages, an item's story beside it, the editor. */
.prc-strip { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.prc-strip li { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; color: var(--muted); max-width: 100%; }
.prc-strip li.people { border-style: dashed; }
.prc-strip li.busy { border-color: var(--go); color: var(--ink); background: var(--go-soft); }
.prc-sn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.prc-ic { display: inline-flex; color: var(--faint); }
.prc-n { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--go); color: var(--go-ink); font-size: 11px; font-weight: 700; }
.prc-empty { margin: 6px 2px; font-size: 12.5px; }
.prc-rail { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.prc-rail li { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--faint); padding: 4px 0; }
.prc-rail li .dot { width: 16px; height: 16px; border-radius: 999px; border: 2px solid var(--line-2); display: inline-flex; align-items: center; justify-content: center; flex: none; background: var(--panel); box-sizing: border-box; }
.prc-rail li.done { color: var(--muted); }
.prc-rail li.done .dot { background: var(--ok); border-color: var(--ok); color: #fff; }
.prc-rail li.now { color: var(--ink); font-weight: 600; }
.prc-rail li.now .dot { border-color: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
.prc-rail li.stuck { color: var(--bad); font-weight: 600; }
.prc-rail li.stuck .dot { border-color: var(--bad); }
.prc-art { border: 1px solid var(--line); border-radius: var(--r); padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
.pp { position: relative; min-width: 200px; }
.pp-list { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); }
.pp-list:empty { display: none; }
.pp-opt { appearance: none; border: 0; background: none; text-align: left; font: inherit; color: inherit; padding: 8px 10px; cursor: pointer; font-size: 13px; }
.pp-opt:hover, .pp-opt:focus-visible { background: var(--panel-2); }
.pp-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px 3px 4px; border-radius: 999px; border: 1px solid var(--line); font-size: 13px; }
.sticky-foot { position: sticky; bottom: 0; background: var(--bg); padding: 12px 0; border-top: 1px solid var(--line); z-index: 2; }
/* The process editor: a map that wraps to fit, then the stage you picked. */
.pm-head { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; margin-bottom: 18px; }
.pm-title { display: block; width: 100%; border: 1px solid transparent; background: transparent; padding: 2px 6px; margin: 4px 0 2px -7px; font-family: var(--serif); font-size: 30px; font-weight: 500; letter-spacing: -0.02em; color: var(--ink); border-radius: var(--r-sm); }
.pm-purpose { display: block; width: 100%; border: 1px solid transparent; background: transparent; padding: 2px 6px; margin-left: -7px; color: var(--muted); font-size: 14px; border-radius: var(--r-sm); }
.pm-title:hover, .pm-purpose:hover { border-color: var(--line); }
.pm-title:focus, .pm-purpose:focus { border-color: var(--go); outline: none; background: var(--panel); }
.pm-mapcard { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; margin-bottom: 18px; }
.pm-legend { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.pm-key { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.pm-key::before { content: ""; width: 10px; height: 10px; border-radius: 3px; }
.pm-key.team::before { background: var(--go); }
.pm-key.people::before { border: 1.5px dashed var(--need); }
.pm-key.warn::before { border-radius: 999px; background: var(--bad); }
.pm-map { display: flex; flex-wrap: wrap; align-items: flex-start; row-gap: 14px; }
.pm-step { display: flex; align-items: flex-start; flex: 1 1 150px; min-width: 0; max-width: 240px; }
.pm-stack { display: flex; flex-direction: column; gap: 6px; flex: 1; min-width: 0; }
.pm-arrow { flex: none; width: 22px; height: 2px; margin-top: 44px; background: var(--line-2); position: relative; }
.pm-arrow::after { content: ""; position: absolute; right: -1px; top: -4px; border: 5px solid transparent; border-left: 6px solid var(--line-2); border-right: 0; }
.pm-end { flex: none; width: 64px; display: flex; flex-direction: column; align-items: center; gap: 6px; padding-top: 24px; font-size: 12px; text-align: center; }
.pm-step:last-child { flex: none; max-width: none; }
.pm-dot { width: 40px; height: 40px; border-radius: 999px; border: 1px solid var(--line); display: inline-flex; align-items: center; justify-content: center; color: var(--muted); }
.pm-dot.done { border: 0; background: var(--ok-soft); color: var(--ok); }
.pm-node { appearance: none; font: inherit; text-align: left; color: inherit; width: 100%; min-height: 92px; box-sizing: border-box; padding: 10px 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 3px; cursor: pointer; background: var(--bg); border: 1.5px solid var(--line); }
.pm-node.people { border-style: dashed; border-color: var(--need); }
.pm-node:hover { border-color: var(--go); }
.pm-node.people:hover { border-color: var(--need); background: var(--need-soft); }
.pm-node.on { border-color: var(--go); background: var(--go-soft); box-shadow: 0 0 0 3px var(--go-soft); }
.pm-node.people.on { border-color: var(--need); background: var(--need-soft); box-shadow: 0 0 0 3px var(--need-soft); }
.pm-node:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
.pm-nodehead { display: flex; align-items: center; gap: 7px; }
.pm-num { width: 22px; height: 22px; flex: none; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 11.5px; font-weight: 700; background: var(--panel-2); color: var(--muted); }
.pm-node.on .pm-num, .pm-num.big.team { background: var(--go); color: var(--go-ink); }
.pm-node.people.on .pm-num, .pm-num.big.people { background: var(--need); color: var(--need-ink); }
.pm-num.big { width: 28px; height: 28px; font-size: 13px; }
.pm-kind { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--go); }
.pm-node.people .pm-kind { color: var(--need); }
.pm-warn { margin-left: auto; width: 8px; height: 8px; border-radius: 999px; background: var(--bad); flex: none; }
.pm-name { font-size: 13.5px; font-weight: 600; line-height: 1.3; color: var(--ink); overflow-wrap: anywhere; }
.pm-who { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-who.missing { color: var(--bad); }
.pm-back { font-size: 11.5px; color: var(--need); padding-left: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pm-body { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; padding-bottom: 24px; }
.pm-stage { flex: 999 1 560px; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.pm-stagehead { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid var(--line); }
.pm-sname { flex: 1 1 220px; min-width: 0; font-size: 16px; font-weight: 600; border-color: transparent; background: transparent; }
.pm-sname:hover { border-color: var(--line); }
.pm-hint { font-size: 12.5px; font-weight: 400; }
.pm-empty { padding: 28px 18px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.pm-empty p { margin: 0; }
.pm-side { flex: 1 1 280px; max-width: 400px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; }
.pm-todo { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.pm-todo li { display: flex; gap: 8px; align-items: center; }
.pm-todo li::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: var(--bad); flex: none; }
.pm-todo .linkish { text-align: left; color: var(--ink); }
.pm-rules { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.pm-footnote { margin-left: auto; font-size: 12.5px; }
@media (max-width: 640px) { .pm-step { flex-basis: 100%; max-width: none; } .pm-arrow { display: none; } .pm-end { display: none; } }

/* The process library. */
.lib-stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.lib-stage { display: flex; gap: 14px; align-items: flex-start; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; }
.lib-stage.people { border-style: dashed; border-color: var(--need); }
.lib-fit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; color: var(--muted); padding: 8px 10px; border-radius: var(--r); background: var(--panel-2); }
.lib-fit.ok { color: var(--ink); background: var(--ok-soft); }
.lib-fit.gap { color: var(--ink); background: var(--need-soft); }
.pm-kind.people { color: var(--need); }
.pm-why { margin: 0; font-size: 13px; }

/* The editor, tidied: borderless title fields, labelled rows, worker stages. */
.pm-head input.pm-title { width: 100%; min-height: 0; border: 1px solid transparent; background: transparent; box-shadow: none; padding: 2px 6px; margin: 4px 0 2px -7px; font-family: var(--serif); font-size: 30px; font-weight: 500; letter-spacing: -0.02em; line-height: 1.2; }
.pm-head input.pm-purpose { width: 100%; min-height: 0; border: 1px solid transparent; background: transparent; box-shadow: none; padding: 2px 6px; margin-left: -7px; color: var(--muted); font-size: 14px; }
.pm-head input.pm-title:hover, .pm-head input.pm-purpose:hover { border-color: var(--line); }
.pm-head input.pm-title:focus, .pm-head input.pm-purpose:focus { border-color: var(--go); background: var(--panel); box-shadow: none; }
.pm-owner { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
.acc-btn { display: inline-flex; align-items: center; gap: 8px; height: 34px; margin-left: 6px; padding: 0 12px; border: 1px solid var(--line-2); border-radius: 999px; background: var(--panel); color: var(--ink); font-size: 13px; cursor: pointer; }
.acc-btn:hover, .acc-btn[aria-expanded="true"] { border-color: var(--go); background: var(--go-soft); }
.acc-btn > svg:first-child { color: var(--go); }
.acc-btn > svg:last-child { color: var(--faint); }
.acc-what { font-weight: 600; }
.acc-faces { display: inline-flex; }
.acc-faces > * + * { margin-left: -6px; }
.acc-faces > * { box-shadow: 0 0 0 2px var(--panel); border-radius: 999px; }
.acc-pop { position: absolute; right: 0; top: calc(100% + 8px); width: 460px; max-width: calc(100vw - 32px); z-index: 20; display: flex; flex-direction: column; text-align: left; background: var(--panel); border: 1px solid var(--line-2); border-radius: 14px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32); }
.acc-pop[hidden] { display: none; }
.acc-head { padding: 18px 20px 6px; }
.acc-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
.acc-head p { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }
.acc-opts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 12px 20px; }
.acc-opt { display: flex; flex-direction: column; gap: 4px; padding: 12px; text-align: left; border: 1.5px solid var(--line); border-radius: var(--r-lg); background: var(--bg); color: var(--ink); cursor: pointer; }
.acc-opt:hover { border-color: var(--line-2); }
.acc-opt.on { border-color: var(--go); background: var(--go-soft); }
.acc-opt:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
.acc-optname { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; }
.acc-opt.on .acc-optname svg { color: var(--go); }
.acc-opthint { font-size: 12px; line-height: 1.4; color: var(--muted); }
.acc-list { display: flex; flex-direction: column; gap: 8px; padding: 2px 20px 14px; }
.acc-label { font-size: 12px; font-weight: 600; color: var(--muted); }
.acc-field { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 42px; padding: 6px 8px; border: 1px solid var(--line-2); border-radius: var(--r-lg); background: var(--bg); }
.acc-field:focus-within { border-color: var(--go); }
.acc-field .pp { position: static; flex: 1 1 140px; min-width: 140px; max-width: none; }
.acc-field .pp-list { left: -1px; right: -1px; width: auto; max-height: 240px; }
.acc-field .pp input { min-height: 28px; height: 28px; padding: 0 4px; border: 0; background: transparent; box-shadow: none; }
.acc-need { font-size: 12px; color: var(--need); }
.acc-always { display: flex; flex-direction: column; gap: 8px; margin: 0 20px; padding: 12px 0 16px; border-top: 1px solid var(--line); }
.acc-who { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; color: var(--muted); }
.acc-who b { color: var(--ink); font-weight: 600; }
.acc-foot { display: flex; justify-content: flex-end; padding: 12px 20px; border-top: 1px solid var(--line); }
@media (max-width: 560px) { .acc-opts { grid-template-columns: minmax(0, 1fr); } }
.pm-person { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 32px; }
.pm-person .linkish { font-size: 12.5px; }
.pm-stagehead input.pm-sname { width: auto; min-height: 0; border: 1px solid transparent; background: transparent; box-shadow: none; font-size: 16px; font-weight: 600; padding: 4px 8px; }
.pm-stagehead input.pm-sname:hover { border-color: var(--line); }
.pm-stagehead input.pm-sname:focus { border-color: var(--go); background: var(--bg); box-shadow: none; }
.pm-why { margin: 0; padding: 12px 18px; font-size: 13px; color: var(--muted); background: var(--panel-2); border-bottom: 1px solid var(--line); }
.pm-why b { color: var(--ink); font-weight: 600; }
.pm-rows { display: flex; flex-direction: column; padding: 6px 18px 12px; }
.pm-row { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 16px; padding: 12px 0; border-top: 1px solid var(--line); align-items: start; }
.pm-row:first-child { border-top: 0; }
.pm-rl { font-size: 13px; font-weight: 600; color: var(--muted); padding-top: 8px; }
.pm-rc { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-rc > select { max-width: 420px; }
.pm-rc .lib-fit { margin: 0; }

/* A process from a picture: the drop zone, the banner on the draft and the
   picture kept open beside the editor. */
.pi-drop { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 26px 18px; border: 1.5px dashed var(--line-2); border-radius: 12px; background: var(--panel-2); color: var(--ink); cursor: pointer; }
.pi-drop:hover, .pi-drop.on { border-color: var(--go); background: var(--go-soft); }
.pi-drop .faint { font-size: 12.5px; }
.pi-dropic { display: inline-flex; color: var(--muted); }
.pi-thumb { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.pi-thumb img { max-width: 100%; max-height: 220px; border-radius: var(--r); border: 1px solid var(--line); object-fit: contain; background: #fff; }
.pi-working { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); }
.pi-banner { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; background: var(--info-soft); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; margin-bottom: 14px; }
.pi-mini { flex: none; width: 96px; height: 72px; padding: 0; border: 1px solid var(--line); border-radius: var(--r); background: #fff; cursor: zoom-in; overflow: hidden; }
.pi-mini img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pi-notes { margin: 0; padding-left: 18px; font-size: 13px; color: var(--ink); display: flex; flex-direction: column; gap: 2px; }
.pi-viewer { position: fixed; top: 72px; right: 16px; bottom: 16px; width: min(40vw, 520px); z-index: 6; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 24px 60px -20px rgba(0, 0, 0, 0.5); }
.pi-viewbody { flex: 1; min-height: 0; overflow: auto; }
.pi-viewbody img { width: 100%; height: auto; display: block; border-radius: var(--r); background: #fff; }
body.pi-open .main { padding-right: calc(min(40vw, 520px) + 32px); }
@media (max-width: 900px) { .pi-viewer { left: 16px; width: auto; } body.pi-open .main { padding-right: 16px; } }
.pm-node.worker { border-color: var(--line-2); }
.pm-node.worker .pm-kind { color: var(--info); }
.pm-node.worker:hover { border-color: var(--info); }
.pm-node.worker.on { border-color: var(--info); background: var(--info-soft); box-shadow: 0 0 0 3px var(--info-soft); }
.pm-node.worker.on .pm-num, .pm-num.big.worker { background: var(--info); color: #fff; }
.pm-key.worker::before { background: var(--info); }
@media (max-width: 640px) { .pm-row { grid-template-columns: minmax(0, 1fr); gap: 6px; } .pm-rl { padding-top: 0; } }

/* The people picker: a dropdown with groups and people. */
.pp-list { max-height: 320px; overflow-y: auto; padding: 4px; }
.pp-head { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.pp-opt { display: flex; align-items: center; gap: 6px; border-radius: var(--r-sm); width: 100%; box-sizing: border-box; }
.pp-opt:focus-visible { outline: 2px solid var(--go); outline-offset: -2px; }
.pp-chip.group { background: var(--info-soft); border-color: transparent; padding-left: 6px; }
.pp-gi { display: inline-flex; color: var(--info); }

.pp { min-width: 260px; max-width: 360px; }
.pp > input { width: 100%; }
.pp-list { right: auto; width: max(100%, 340px); }
.pp-opt { padding: 8px 10px; align-items: flex-start; }
.pp-main { display: flex; align-items: center; gap: 10px; min-width: 0; width: 100%; }
.pp-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.pp-text b { font-weight: 600; }
.pp-sub { font-size: 12px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pp-gi { width: 26px; height: 26px; flex: none; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: var(--info-soft); color: var(--info); }
.pp-chip.group .pp-gi { width: auto; height: auto; background: none; }

/* Picking who does a stage: what each one does, best fits first. */
.dp { position: relative; max-width: 520px; }
.dp-btn { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; font: inherit; color: inherit; padding: 8px 12px; border: 1px solid var(--line-2); border-radius: var(--r); background: var(--panel); cursor: pointer; min-height: 52px; }
.dp-btn:hover { border-color: var(--go); }
.dp-btn:focus-visible { outline: 2px solid var(--go); outline-offset: 1px; }
.dp-none { width: 32px; height: 32px; flex: none; border-radius: 999px; border: 1px dashed var(--line-2); display: inline-flex; align-items: center; justify-content: center; color: var(--faint); }
.dp-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.dp-text b { font-weight: 600; color: var(--ink); }
.dp-about { font-size: 12.5px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dp-chev { color: var(--faint); display: inline-flex; transform: rotate(-90deg); }
.dp-panel { position: absolute; left: 0; top: calc(100% + 6px); z-index: 6; width: max(100%, 460px); max-width: calc(100vw - 40px); background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); display: flex; flex-direction: column; }
.dp-search { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); color: var(--faint); }
.dp-search input { border: 0; background: transparent; box-shadow: none; min-height: 0; padding: 4px 0; }
.dp-search input:focus { box-shadow: none; }
.dp-list { max-height: 380px; overflow-y: auto; padding: 4px; }
.dp-opt { display: flex; align-items: flex-start; gap: 12px; width: 100%; text-align: left; font: inherit; color: inherit; padding: 9px 10px; border: 0; border-radius: var(--r-sm); background: none; cursor: pointer; }
.dp-opt:hover, .dp-opt:focus-visible { background: var(--panel-2); outline: none; }
.dp-opt.on { background: var(--go-soft); }
.dp-why { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ok); }
.dp-on { color: var(--go); display: inline-flex; margin-top: 2px; }

/* How work comes in. */
.in-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
.in-row:first-child { border-top: 0; }
.in-ic { width: 32px; height: 32px; flex: none; border-radius: var(--r); background: var(--panel-2); color: var(--muted); display: inline-flex; align-items: center; justify-content: center; }
.in-foot { border-top: 1px solid var(--line); padding-top: 12px; }
.in-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.in-form { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg); }

.pm-time { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--info); padding-left: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* A process's page: the summary, how it works drawn, the board, what came out. */
.pv-track { display: grid; gap: 4px; }
.pv-track > span { height: 5px; border-radius: 3px; background: var(--line-2); }
.pv-track > span.done { background: var(--ok); }
.pv-track > span.now { background: var(--go); }
.pv-track > span.now.worker { background: var(--info); }
.pv-track > span.now.people { background: var(--need); }
.pv-track > span.stuck { background: var(--bad); }
.pf-sum { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 8px 0 0; font-size: 13px; color: var(--faint); }
.pf-sum.big { gap: 6px 22px; align-items: baseline; margin: 0; color: var(--muted); }
.pf-sum.big b { font-size: 18px; font-weight: 650; color: var(--ink); margin-right: 5px; font-variant-numeric: tabular-nums; }
.pf-sum.big b.need { color: var(--need); }
.pf-sum.big b.bad { color: var(--bad); }
.pf-sum.big b.ok { color: var(--ok); }
.pf-panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.pf-head { display: flex; align-items: center; gap: 12px 16px; flex-wrap: wrap; }
.pf-panel.pf-how { display: block; }
.pf-how > * + * { margin-top: 12px; }
.pf-how > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 12px 16px; flex-wrap: wrap; }
.pf-how > summary::-webkit-details-marker { display: none; }
.pf-how > summary .label { display: inline-flex; align-items: center; gap: 6px; }
.pf-how > summary .label svg { transform: rotate(180deg); transition: transform 0.15s; }
.pf-how[open] > summary .label svg { transform: rotate(-90deg); }
.pf-how > summary:focus-visible { outline: 2px solid var(--go); outline-offset: 3px; border-radius: 4px; }
.pf-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--faint); }
.pf-legend > span::before { content: ""; display: inline-block; width: 18px; border-top: 2px solid var(--line-2); vertical-align: middle; margin-right: 6px; }
.pf-legend > span.loop::before { border-top-style: dashed; border-top-color: var(--need); }
.pf-scroll { overflow-x: auto; min-width: 0; }
.pf-host { position: relative; box-sizing: border-box; }
.pf-grid, .pf-board { display: grid; align-items: stretch; }
.pf-card { position: relative; z-index: 1; display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; min-height: 96px; box-sizing: border-box; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--bg); color: var(--muted); font-size: 12px; line-height: 1.45; text-align: left; }
button.pf-card { appearance: none; font-family: inherit; cursor: pointer; }
button.pf-card:hover { border-color: var(--go); }
button.pf-card:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
.pf-card b { font-size: 14px; font-weight: 600; color: var(--ink); line-height: 1.3; overflow-wrap: anywhere; }
.pf-card.people { border-style: dashed; border-color: var(--need); background: color-mix(in srgb, var(--need) 6%, var(--bg)); }
.pf-card.start { border-color: color-mix(in srgb, var(--go) 45%, var(--line)); background: color-mix(in srgb, var(--go) 8%, var(--bg)); }
.pf-card.end { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); background: color-mix(in srgb, var(--ok) 8%, var(--bg)); }
.pf-sub { overflow-wrap: anywhere; }
.pf-sub .pf-who { font: inherit; color: var(--ink); text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 3px; }
.pf-sub .pf-who:hover { color: var(--go); text-decoration-color: currentColor; }
.pf-tag { font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); }
.pf-tag.team { color: var(--violet); }
.pf-tag.worker { color: var(--info); }
.pf-tag.people { color: var(--need); }
.pf-tag.start { color: var(--go); }
.pf-tag.end { color: var(--ok); }
.pf-lines { position: absolute; left: 0; top: 0; z-index: 0; pointer-events: none; overflow: visible; }
.pf-solid { fill: none; stroke: var(--line-2); stroke-width: 2; }
.pf-loop { fill: none; stroke: var(--need); stroke-width: 1.6; stroke-dasharray: 5 5; stroke-linejoin: round; }
.pf-headfill { fill: var(--line-2); }
.pf-headfill.loop { fill: var(--need); }
.pf-labels { position: absolute; left: 0; top: 0; right: 0; bottom: 0; z-index: 2; pointer-events: none; }
.pf-note { position: absolute; transform: translate(-50%, -50%); padding: 0 6px; background: var(--panel); color: var(--need); font-size: 11.5px; line-height: 16px; white-space: nowrap; }
.pf-wait { position: absolute; transform: translate(-50%, -100%); width: 56px; text-align: center; color: var(--faint); font-size: 11px; line-height: 1.25; }
.pf-steps { list-style: none; margin: 0; padding: 12px 0 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 14px; }
.pf-steps li { display: flex; flex-direction: column; gap: 3px; min-width: 0; font-size: 13px; color: var(--muted); }
.pf-steps li b { color: var(--ink); font-weight: 600; }
.pf-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(380px, 100%), 1fr)); gap: 16px; align-items: start; }
.pf-accent { color: var(--go); }
.pf-small { font-size: 12.5px; color: var(--muted); }
.pf-split { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
.pf-way { display: flex; align-items: center; gap: 10px; font-size: 13px; min-width: 0; flex-wrap: wrap; }
.pf-what { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.pf-dot { width: 8px; height: 8px; flex: none; border-radius: 99px; background: var(--go); }
.pf-dot.ok { background: var(--ok); }
.pf-dot.info { background: var(--info); }
.pf-dot.violet { background: var(--violet); }
.pf-dot.need { background: var(--need); }
.pf-dot.bad { background: var(--bad); }
.linkish.pf-link { align-self: flex-start; color: var(--go); font-size: 12.5px; font-weight: 600; text-align: left; }
.pf-done { appearance: none; font: inherit; color: inherit; text-align: left; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg); cursor: pointer; }
.pf-done:hover { border-color: var(--go); }
.pf-done:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
.pf-done b { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.pf-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pf-out { font-size: 12.5px; color: var(--muted); }
.pf-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 8px; }
.pf-bars { display: grid; grid-template-columns: minmax(0, max-content) minmax(60px, 1fr) auto; gap: 6px 10px; align-items: center; font-size: 12.5px; }
.pf-barname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.pf-bar > span { display: block; height: 100%; border-radius: 3px; background: var(--go); }
.pf-bar > span.worker { background: var(--info); }
.pf-bar > span.team { background: var(--violet); }
.pf-bar > span.people { background: var(--need); }
.pf-boardwrap { padding: 0 17px 4px; }
.pf-col { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 220px; box-sizing: border-box; padding: 12px; border-radius: var(--r-lg); background: var(--panel); border: 1px solid var(--line); }
.pf-col.people { border-style: dashed; border-color: color-mix(in srgb, var(--need) 55%, var(--line)); }
.pf-colhead { display: flex; flex-direction: column; gap: 3px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.pf-colhead b { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.pf-coltop { display: flex; align-items: center; gap: 8px; }
.pf-count { margin-left: auto; font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
.pf-item { appearance: none; font: inherit; color: inherit; text-align: left; width: 100%; box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 9px; background: var(--panel-2); border: 1px solid var(--line); cursor: pointer; }
.pf-item:hover { border-color: var(--go); }
.pf-item:focus-visible { outline: 2px solid var(--go); outline-offset: 2px; }
.pf-item b { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.pf-now { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.pf-item.yours { background: var(--need-soft); border-color: color-mix(in srgb, var(--need) 45%, var(--line)); }
.pf-item.yours .pf-now { color: var(--need); }
.pf-item.stuck { background: var(--bad-soft); border-color: var(--bad-line); }
.pf-item.stuck .pf-now { color: var(--bad); }
.pf-none { font-size: 12px; color: var(--faint); padding: 8px 2px; }
/* A process item, the page's whole width: its stages across the top, the
   call waiting on you, tabs, and who does what beside them. */
.pi-page { display: flex; flex-direction: column; gap: 18px; width: 100%; }
.pi-head { display: flex; flex-direction: column; gap: 14px; }
.pi-top { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
.pi-titles { flex: 1 1 480px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.pi-crumb { font-size: 12px; color: var(--faint); }
.pi-crumb .linkish { font-size: 12px; color: var(--go); }
.pi-title { margin: 0; font-family: var(--serif); font-size: 23px; font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; }
.pi-brief { font-size: 13px; color: var(--muted); }
.pi-owner { font-size: 12px; color: var(--muted); padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; white-space: nowrap; }
.pi-menu { width: 230px; }
.pi-menu .menu-sec { padding: 6px 16px; }
.pi-menu .menu-item.pi-danger { color: var(--bad); }
.pi-note, .pi-move { display: flex; gap: 8px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
.pi-note { flex-direction: column; }
.pi-note[hidden], .pi-move[hidden], .pi-send[hidden] { display: none; }
.pi-track { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); gap: 8px; }
.pi-stage { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 10px 12px; border-radius: var(--r-lg); background: var(--panel); border: 1px solid var(--line); }
.pi-sname { display: flex; align-items: center; gap: 8px; min-width: 0; }
.pi-sname b { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi-num { width: 20px; height: 20px; flex: none; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line-2); box-sizing: border-box; }
.pi-swho { font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi-sstate { font-size: 11.5px; color: var(--faint); }
.pi-stage.done .pi-num { background: var(--ok); border-color: var(--ok); color: var(--bg); }
.pi-stage.done .pi-sstate { color: var(--ok); }
.pi-stage.now { border-color: var(--go); background: color-mix(in srgb, var(--go) 6%, var(--panel)); }
.pi-stage.now .pi-num { background: var(--go); border-color: var(--go); color: var(--go-ink); }
.pi-stage.now .pi-sstate { color: var(--go); }
.pi-stage.need { border-color: color-mix(in srgb, var(--need) 45%, var(--line)); background: color-mix(in srgb, var(--need) 8%, var(--panel)); }
.pi-stage.need .pi-num { background: var(--need); border-color: var(--need); color: var(--need-ink); }
.pi-stage.need .pi-sstate { color: var(--need); font-weight: 600; }
.pi-stage.stuck { border-color: var(--bad-line); background: var(--bad-soft); }
.pi-stage.stuck .pi-num { background: var(--bad); border-color: var(--bad); color: var(--bad-ink); }
.pi-stage.stuck .pi-sstate { color: var(--bad); font-weight: 600; }
.pi-band { display: flex; flex-direction: column; gap: 12px; padding: 14px 18px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel); }
.pi-band.need { background: color-mix(in srgb, var(--need) 8%, var(--panel)); border-color: color-mix(in srgb, var(--need) 40%, var(--line)); }
.pi-band.bad { background: var(--bad-soft); border-color: var(--bad-line); }
.pi-band.wait { border-color: color-mix(in srgb, var(--go) 35%, var(--line)); }
.pi-band.wait .pi-bandic { background: var(--go-soft); color: var(--go); }
.pi-band.ok { background: var(--ok-soft); border-color: color-mix(in srgb, var(--ok) 35%, var(--line)); }
.pi-bandrow { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.pi-bandic { width: 36px; height: 36px; flex: none; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; background: var(--panel-2); color: var(--muted); }
.pi-band.need .pi-bandic { background: var(--need-soft); color: var(--need); }
.pi-band.bad .pi-bandic { background: var(--bad-soft); color: var(--bad); }
.pi-band.ok .pi-bandic { background: var(--ok-soft); color: var(--ok); }
.pi-bandtext { flex: 1 1 380px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pi-bandtext b { font-size: 14.5px; font-weight: 650; }
.pi-bandsub { font-size: 12.5px; color: var(--muted); }
.pi-send { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--need) 30%, var(--line)); }
.pi-send textarea { resize: vertical; }
.pi-pick { border: 1px solid var(--line-2); border-radius: var(--r); padding: 6px 12px; font: 600 12.5px var(--sans); cursor: pointer; background: transparent; color: var(--muted); }
.pi-pick[aria-pressed="true"] { border-color: var(--need); background: var(--need-soft); color: var(--need); }
.pi-cols { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
.pi-main { flex: 999 1 640px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.pi-aside { flex: 1 1 300px; min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 14px; }
.pi-tabs { display: flex; gap: 4px; padding: 4px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); flex-wrap: wrap; align-self: flex-start; max-width: 100%; }
.pi-tabs button { border: 0; border-radius: 7px; padding: 7px 14px; display: inline-flex; gap: 7px; align-items: center; font: 600 13px var(--sans); cursor: pointer; background: transparent; color: var(--muted); }
.pi-tabs button:hover { color: var(--ink); }
.pi-tabs button[aria-selected="true"] { background: var(--panel-2); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-2); }
.pi-count { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--panel-2); color: var(--muted); line-height: 17px; }
.pi-tabs button[aria-selected="true"] .pi-count { background: var(--go); color: var(--go-ink); }
.pi-card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.pi-stand { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
.pi-lead { font-size: 15.5px; line-height: 1.55; color: var(--ink); }
.pi-lead p { margin: 0 0 8px; }
.pi-sum { font-size: 13.5px; color: var(--muted); }
.pi-sum p { margin: 0 0 6px; }
.pi-sum.clamp { max-height: 18.6em; overflow: hidden; -webkit-mask-image: linear-gradient(180deg, #000 70%, transparent); mask-image: linear-gradient(180deg, #000 70%, transparent); }
.pi-showall { align-self: flex-start; color: var(--go); }
.pi-flist { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
.pi-frow + .pi-frow { border-top: 1px solid var(--line); }
.pi-fline { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; }
.pi-fopen { appearance: none; flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 8px; border: 0; background: none; padding: 4px 0; font: 600 13px var(--sans); color: var(--ink); cursor: pointer; text-align: left; }
.pi-fopen span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi-fopen svg { flex: none; color: var(--faint); }
.pi-fopen:hover span { text-decoration: underline; }
.pi-fview { padding: 10px 14px; border-top: 1px solid var(--line); background: var(--bg); max-height: 520px; overflow: auto; font-size: 13.5px; }
.pi-fview[hidden] { display: none; }
.pi-fview pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; }
.pi-art { display: flex; flex-direction: column; gap: 10px; }
.pi-arthead { display: flex; align-items: flex-start; gap: 10px; }
.pi-earlier { display: flex; flex-direction: column; gap: 4px; }
.pi-step { border-top: 1px solid var(--line); padding: 8px 0 2px; }
.pi-earlier .label + .pi-step { border-top: 0; }
.pi-step summary { cursor: pointer; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 13.5px; padding: 2px 0 6px; }
.pi-stepbody { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 10px; }
.pi-jbody .pi-flist { margin-top: 6px; }
.pi-lead.clamp { max-height: 18.6em; overflow: hidden; -webkit-mask-image: linear-gradient(180deg, #000 70%, transparent); mask-image: linear-gradient(180deg, #000 70%, transparent); }
.pi-chip { font: inherit; font-size: 12.5px; text-decoration: none; padding: 5px 10px; border: 1px solid var(--line-2); border-radius: var(--r); color: var(--muted); background: none; cursor: pointer; }
.pi-chip:hover { color: var(--ink); border-color: var(--faint); }
span.pi-chip { cursor: default; }
.pi-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.pi-mini { display: flex; flex-direction: column; gap: 10px; min-width: 0; font-size: 13px; }
.pi-mini .label, .pi-side .label { font-size: 11px; letter-spacing: 0.08em; }
.pi-mini .label.pi-need { color: var(--need); }
.pi-mini .label.pi-go { color: var(--go); }
.pi-voter, .pi-crew { display: flex; align-items: center; gap: 10px; min-width: 0; }
.pi-vname { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pi-vname > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi-vname .faint { font-size: 11.5px; }
.pi-tag { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
.pi-tag.ok { background: var(--ok-soft); color: var(--ok); }
.pi-tag.need { background: var(--need-soft); color: var(--need); }
.pi-tag.redo { background: var(--bad-soft); color: var(--bad); }
.pi-tag.now { background: var(--go-soft); color: var(--go); }
.pi-handed { display: flex; flex-direction: column; gap: 2px; }
.pi-handed b { font-size: 13px; font-weight: 600; }
.pi-handed .muted { font-size: 12px; }
.pi-nextrow { display: flex; gap: 10px; align-items: flex-start; }
.pi-ndot { width: 8px; height: 8px; border-radius: 999px; background: var(--go); flex: none; margin-top: 6px; }
.pi-journey { list-style: none; margin: 0; padding: 18px 20px; display: flex; flex-direction: column; }
.pi-journey li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 14px; position: relative; }
.pi-journey li:not(:last-child)::before { content: ""; position: absolute; left: 6px; top: 18px; bottom: 0; width: 2px; background: var(--line-2); }
.pi-jdot { width: 12px; height: 12px; border-radius: 999px; margin-top: 4px; background: var(--ok); position: relative; z-index: 1; }
.pi-journey li.start .pi-jdot { background: var(--faint); }
.pi-journey li.note .pi-jdot { background: var(--info); }
.pi-journey li.redo .pi-jdot { background: var(--bad); }
.pi-journey li.need .pi-jdot { background: var(--need); box-shadow: 0 0 0 3px var(--need-soft); }
.pi-journey li.now .pi-jdot { background: var(--go); box-shadow: 0 0 0 3px var(--go-soft); }
.pi-jbody { min-width: 0; padding-bottom: 18px; display: flex; flex-direction: column; gap: 2px; }
.pi-journey li:last-child .pi-jbody { padding-bottom: 0; }
.pi-jhead { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.pi-jhead b { font-size: 13.5px; font-weight: 600; }
.pi-jdetail { font-size: 12.5px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.pi-files { padding: 0; overflow: hidden; }
.pi-file { appearance: none; font: inherit; color: inherit; text-align: left; text-decoration: none; box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 11px 16px; border: 0; border-top: 1px solid var(--line); background: none; }
.pi-file:first-child { border-top: 0; }
button.pi-file, a.pi-file { cursor: pointer; }
button.pi-file:hover, a.pi-file:hover { background: var(--panel-2); }
.pi-fic { display: inline-flex; color: var(--faint); flex: none; }
.pi-fname { flex: 0 1 240px; min-width: 0; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pi-ffrom { flex: 1 1 200px; min-width: 0; color: var(--muted); font-size: 12.5px; }
.pi-req { margin: 0; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.pi-side { display: flex; flex-direction: column; gap: 12px; }
.pi-crew.on .pi-cstage { font-weight: 600; }
.pi-cstage { font-size: 13px; }
.pi-took { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.pi-badge { width: 26px; height: 26px; flex: none; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; font-size: 11.5px; font-weight: 700; }
.pi-badge.W { color: var(--info); background: var(--info-soft); }
.pi-badge.T { color: var(--violet); background: var(--violet-soft); }
.pi-badge.P { color: var(--need); background: var(--need-soft); }
.pi-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; gap: 2px; }
.pi-bar > span { min-width: 4px; }
.pi-bar > .W { background: var(--info); }
.pi-bar > .T { background: var(--violet); }
.pi-bar > .P { background: var(--need); }
/* A team task, the page's whole width (the process item page's pieces, plus these). */
.tt-spend { flex: none; }
.tt-spend .t-spend { font-size: 11.5px; gap: 8px; white-space: nowrap; }
.tt-spend .t-spend .meter { width: 80px; }
.tt-track { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); gap: 4px; }
.tt-track li { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.tt-bar { height: 5px; border-radius: 3px; background: var(--line-2); }
.tt-sname { font-size: 11.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt-track .done .tt-bar { background: var(--ok); }
.tt-track .part .tt-bar { background: var(--need); }
.tt-track .failed .tt-bar { background: var(--bad); }
.tt-track .now .tt-bar { background: var(--go); }
.tt-track .need .tt-bar { background: var(--need); }
.tt-track .now .tt-sname { color: var(--go); font-weight: 600; }
.tt-track .need .tt-sname { color: var(--need); font-weight: 600; }
.tt-track .failed .tt-sname { color: var(--bad); }
.tt-bandbody { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--need) 30%, var(--line)); }
.tt-c { width: 26px; height: 26px; border-radius: 999px; font-size: 11px; color: var(--muted); background: var(--panel-2); }
.pi-mini .label.tt-ok { color: var(--ok); }
.tt-item { display: flex; gap: 9px; align-items: flex-start; }
.tt-tick { display: inline-flex; color: var(--ok); flex: none; margin-top: 2px; }
.tt-pick { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.tt-pick input[type=checkbox] { margin-top: 3px; width: 15px; height: 15px; flex: none; accent-color: var(--go); }
.tt-asked { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); padding: 4px 2px; }
.tt-asked b { color: var(--ink); font-weight: 600; }
.tt-reply { display: flex; gap: 12px; }
.tt-reply.wrap { border-color: color-mix(in srgb, var(--go) 35%, var(--line)); }
.tt-rbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.tt-gist { margin: 0; font-size: 14px; color: var(--ink); }
.tt-detail { font-size: 13.5px; color: var(--muted); border-left: 2px solid var(--line-2); padding-left: 12px; }
.tt-detail[hidden] { display: none; }
.tt-link { appearance: none; border: 0; background: none; padding: 4px 0; font: 600 12px var(--sans); color: var(--go); cursor: pointer; }
.tt-ask { background: var(--panel); border: 1px solid var(--line-2); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.tt-ask textarea.tt-askin { flex: 1; min-width: 0; min-height: 0; height: auto; resize: none; border: 0; background: transparent; outline: none; padding: 4px 0; font: inherit; font-size: 14px; line-height: 1.5; box-shadow: none; }
.tt-try { appearance: none; font: inherit; font-size: 12px; color: var(--muted); padding: 4px 10px; border: 1px solid var(--line-2); border-radius: 999px; background: none; cursor: pointer; }
.tt-try:hover { color: var(--ink); border-color: var(--faint); }
.tt-fileline { appearance: none; border: 0; background: none; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tt-fileline b { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tt-fileline:hover b { text-decoration: underline; }
.tt-crew { appearance: none; border: 0; background: none; padding: 0; text-align: left; font: inherit; color: inherit; cursor: pointer; width: 100%; }
.tt-crew .avatar.s { width: 24px; height: 24px; font-size: 10px; }
.tt-n { width: 22px; height: 22px; border-radius: 6px; }
.pi-num.tt-n.done { background: var(--ok-soft); color: var(--ok); border-color: transparent; }
.pi-num.tt-n.now { background: var(--go); color: var(--go-ink); border-color: var(--go); }
.pi-num.tt-n.need, .pi-num.tt-n.part { background: var(--need); color: var(--need-ink); border-color: var(--need); }
.pi-num.tt-n.failed { background: var(--bad-soft); color: var(--bad); border-color: transparent; }
.tt-stage { padding: 0; }
.tt-stage > summary { cursor: pointer; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 16px; font-size: 13.5px; }
.tt-stage.now, .tt-stage.need { border-color: color-mix(in srgb, var(--go) 35%, var(--line)); }
.tt-stagebody { display: flex; flex-direction: column; gap: 10px; padding: 0 16px 14px; }
@media (max-width: 760px) { .pi-track, .tt-track { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* Comments on a team task's work: the floating button by a selection, the
   small box it opens, and the lists of what's been said. */
.cm-float { position: fixed; z-index: 61; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--go); background: var(--go); color: var(--go-ink); font: 600 12.5px var(--sans); cursor: pointer; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22); }
.cm-pop { position: fixed; z-index: 60; width: min(380px, calc(100vw - 24px)); display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--panel); border: 1px solid var(--line-2); border-radius: var(--r-lg); box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28); }
.cm-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 14px; }
.cm-pop textarea { min-height: 76px; resize: vertical; }
.cm-notes { margin: 0; padding-left: 18px; color: var(--faint); font-size: 12.5px; display: flex; flex-direction: column; gap: 3px; }
.cm-quote { margin: 0; padding: 6px 10px; border-left: 3px solid var(--line-2); background: var(--panel-2); border-radius: 0 var(--r-sm) var(--r-sm) 0; color: var(--muted); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto; }
.cm-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; font-size: 12.5px; }
.cm-bar .btn { margin-left: -10px; }
.cm-host ::selection { background: var(--go-soft); }
.cm-file { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
.cm-file:empty { display: none; }
.cm-list { display: flex; flex-direction: column; }
.cm-list .cm-row + .cm-row { border-top: 1px solid var(--line); }
.cm-list .cm-row { padding: 10px 0; }
.cm-list .cm-row:first-child { padding-top: 0; }
.cm-row { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cm-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }
.cm-meta b { font-weight: 600; color: var(--ink); }
.cm-link { color: var(--ink); font-weight: 600; font-size: 12.5px; overflow-wrap: anywhere; }
.cm-link:hover { color: var(--go); }
.cm-text { margin: 0; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cm-about { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12.5px; }

/* The Inbox: what needs you, everything in flight in one list, what finished. */
.if-sum { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 22px; font-size: 13px; color: var(--muted); margin: -4px 0 6px; }
.if-next { font-size: 12.5px; text-align: right; min-width: 0; }
.if-sum b { font-size: 16px; color: var(--ink); margin-right: 2px; }
.if-sum b.need { color: var(--need); }
.if-sum b.ok { color: var(--ok); }
.if-needlabel { color: var(--need); }
.if-need { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid var(--need); background: var(--need-soft); border-radius: var(--r-lg); }
.if-rows { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; }
.if-row { appearance: none; font: inherit; color: inherit; text-align: left; width: 100%; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 12px 16px; border: 0; border-top: 1px solid var(--line); background: none; cursor: pointer; }
.if-row:first-child { border-top: 0; }
.if-row:hover { background: var(--panel-2); }
.if-row:focus-visible { outline: 2px solid var(--go); outline-offset: -2px; }
.if-mark { width: 32px; height: 32px; flex: none; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
.if-mark.worker, .if-kind.worker { color: var(--info); background: var(--info-soft); }
.if-mark.team, .if-kind.team { color: var(--violet); background: var(--violet-soft); }
.if-mark.process, .if-kind.process { color: var(--ok); background: var(--ok-soft); }
.if-kind.need { color: var(--need); background: var(--panel); }
.if-kind { flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; }
.if-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 280px; }
.if-main .faint { font-size: 12.5px; }
.if-title { font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.if-where { display: flex; flex-direction: column; gap: 6px; flex: 0 1 320px; min-width: 200px; }
.if-now { font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.if-now.bad { color: var(--bad); }
.if-age { width: 64px; text-align: right; font-size: 12.5px; flex: none; }
.if-done { padding: 4px 0; }
`;

export const CONSOLE_JS = String.raw`
(function () {
  'use strict';
  var TOKEN_KEY = 'overcli-org-token';
  var THEME_KEY = 'overcli-org-theme';
  var SVG = 'http://www.w3.org/2000/svg';
  var state = { tab: 'today', me: null, counts: { today: 0 }, hire: null, workerId: null, workMine: true };
  var app = document.getElementById('app');

  // The page you're on lives in the address (#reports, #worker/<id>/triggers,
  // #setup/secrets), so a refresh, a bookmark or Back lands where you were.
  function hashFor() {
    if (state.tab === 'worker' && state.workerId) return 'worker/' + encodeURIComponent(state.workerId) + '/' + (state.workerTab || 'talk');
    if (state.tab === 'team' && state.teamId) return 'team/' + encodeURIComponent(state.teamId);
    if (state.tab === 'process' && state.processId) return 'process/' + encodeURIComponent(state.processId) + (state.processItem ? '/' + encodeURIComponent(state.processItem) : '');
    if (state.tab === 'proclib') return 'proclib' + (state.libId ? '/' + encodeURIComponent(state.libId) : '');
    if (state.tab === 'processedit') return 'processedit' + (state.processId ? '/' + encodeURIComponent(state.processId) : '');
    if ((state.tab === 'teamtask' || state.tab === 'teamfiles') && state.taskId) return state.tab + '/' + encodeURIComponent(state.taskId);
    if (state.tab === 'read' && state.readId) return 'read/' + encodeURIComponent(state.readId);
    if (state.tab === 'file' && state.fileLink) return 'file/' + state.fileLink + '/' + encodeURIComponent(state.fileName || '');
    if (state.tab === 'setup') return 'setup/' + (state.setupTab || 'ready');
    return state.tab;
  }
  function fromHash() {
    var raw = location.hash.replace(/^#\/?/, '');
    var qAt = raw.indexOf('?');
    state.hashQuery = qAt >= 0 ? new URLSearchParams(raw.slice(qAt + 1)) : null;
    var parts = (qAt >= 0 ? raw.slice(0, qAt) : raw).split('/');
    if (!parts[0] || !/^[a-z]+$/.test(parts[0])) return;
    state.tab = parts[0];
    if (parts[0] === 'worker') { state.workerId = decodeURIComponent(parts[1] || ''); state.workerTab = parts[2] || 'talk'; if (!state.workerId) state.tab = 'workers'; }
    if (parts[0] === 'read') { state.readId = decodeURIComponent(parts[1] || ''); if (!state.readId) state.tab = 'library'; }
    if (parts[0] === 'file') { state.fileLink = parts[1] || ''; state.fileName = decodeURIComponent(parts[2] || ''); if (!state.fileLink) state.tab = 'library'; }
    if (parts[0] === 'team') { state.teamId = decodeURIComponent(parts[1] || ''); if (!state.teamId) state.tab = 'teams'; }
    if (parts[0] === 'process') { state.processId = decodeURIComponent(parts[1] || ''); state.processItem = parts[2] ? decodeURIComponent(parts[2]) : null; if (!state.processId) state.tab = 'processes'; }
    if (parts[0] === 'proclib') state.libId = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (parts[0] === 'processedit') state.processId = parts[1] ? decodeURIComponent(parts[1]) : null;
    if (parts[0] === 'teamtask' || parts[0] === 'teamfiles') { state.taskId = decodeURIComponent(parts[1] || ''); if (!state.taskId) state.tab = 'teams'; }
    if (parts[0] === 'setup' && parts[1]) state.setupTab = parts[1];
  }
  fromHash();
  window.addEventListener('popstate', function () { fromHash(); render(); });

  function store(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) {} }
  function read(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function token() { return read(TOKEN_KEY); }
  // Per tab: a team being made, so a reload picks it back up.
  var TEAM_RUN_KEY = 'overcli-team-run';
  function readSession(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function writeSession(key, value) { try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch (e) {} }
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
  /// Replace an element's children with a list as append takes it: nested
  /// arrays flattened, null and false left out. replaceChildren would print
  /// both as text.
  function fill(el, c) { el.textContent = ''; append(el, c); return el; }
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
    x: [['path', 'M6 6l12 12M18 6L6 18']],
    tick: [['path', 'M5 12l5 5 9-10']],
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
    dots: [['circle', 5, 12, 1.2], ['circle', 12, 12, 1.2], ['circle', 19, 12, 1.2]],
    alert: [['circle', 12, 12, 9], ['path', 'M12 7v6M12 16.5v.5']],
    arrow: [['path', 'M4 12h12M12 6l6 6-6 6']],
    library: [['path', 'M5 4h4v16H5zM10 4h4v16h-4z'], ['path', 'M15.5 5.2l3.8-1 3.2 15.6-3.8 1z']],
    bolt: [['path', 'M13 3L5 14h6l-1 7 8-11h-6z']],
    bars: [['path', 'M4 20h16M7 16v-5M12 16V6M17 16v-8']],
    clock: [['circle', 12, 12, 9], ['path', 'M12 7v5l3 2']],
    lock: [['path', 'M6 11h12v9H6z'], ['path', 'M9 11V8a3 3 0 0 1 6 0v3']],
    chevron: [['path', 'M6 9l6 6 6-6']],
    globe: [['circle', 12, 12, 8.5], ['path', 'M3.5 12h17'], ['path', 'M12 3.5c2.4 2.4 3.5 5.3 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.3-3.5-8.5s1.1-6.1 3.5-8.5z']],
    search: [['circle', 11, 11, 7], ['path', 'M20 20l-3.5-3.5']],
    bell: [['path', 'M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9'], ['path', 'M10 20.5h4']],
    slack: [['path', 'M4 6h16v10H9l-5 4z']],
    image: [['rect', 3, 5, 18, 14], ['circle', 9, 10, 1.6], ['path', 'M21 16l-5-5-9 8']]
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
      return res.json().then(function (x) { notePictures(path, x); return x; });
    });
  }

  /// Workers' pictures, by id, from whatever lists them: avatar() draws
  /// a picture where there is one, initials where there isn't.
  var PICTURES = {};
  function notePictures(path, x) {
    var one = function (w) { if (w && typeof w.id === 'string' && typeof w.name === 'string' && 'tagline' in w) { if (w.avatarUrl) PICTURES[w.id] = w.avatarUrl; else delete PICTURES[w.id]; } };
    var team = function (t) { if (t && typeof t.id === 'string' && Array.isArray(t.members)) { if (t.avatarUrl) PICTURES[t.id] = t.avatarUrl; else delete PICTURES[t.id]; } };
    if (/^\/api\/workers(\?|$)/.test(path) && Array.isArray(x)) x.forEach(one);
    else if (/^\/api\/teams(\?|$)/.test(path) && Array.isArray(x)) x.forEach(team);
    else if (x && x.worker) one(x.worker);
    else if (x && x.team) team(x.team);
  }

  function money(n) { n = n || 0; return '$' + (n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, '')); }
  function initials(name) { var p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
  // FNV-1a, so ids that differ in a few characters still land far apart.
  function hue(s) { var x = 2166136261; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) % 360; }
  function avatar(seed, name, size) {
    if (PICTURES[seed]) return h('span', { class: 'avatar pic ' + (size || 'm'), 'data-face': seed, 'aria-hidden': 'true' }, h('img', { src: PICTURES[seed], alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
    return h('span', { class: 'avatar ' + (size || 'm'), 'data-face': seed, style: 'background:hsl(' + hue(seed + name) + ' 42% 40%)', text: initials(name), 'aria-hidden': 'true' });
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
  // Markdown a worker writes, drawn as elements: paragraphs, headings, lists,
  // quotes, rules, code, bold, italic and links. Built with nodes and text,
  // never markup, so nothing a worker writes can run in the page.
  function md(src) {
    var root = h('div', { class: 'prose' });
    var lines = String(src || '').replace(/\r/g, '').split('\n');
    var FENCE = /^\s*(\x60{3}|~{3})/;
    var i = 0, list = null, para = [], m;
    var flush = function () {
      if (!para.length) return;
      var p = h('p');
      para.join(' ').split(/<br\s*\/?>/i).forEach(function (part, n) { if (n) p.appendChild(h('br')); inline(p, part); });
      root.appendChild(p); para = [];
    };
    while (i < lines.length) {
      var ln = lines[i];
      if (FENCE.test(ln)) {
        flush(); list = null; var code = []; i++;
        while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++]);
        i++; root.appendChild(h('pre', null, h('code', { text: code.join('\n') }))); continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(ln))) { flush(); list = null; root.appendChild(inline(h('h' + Math.min(6, m[1].length + 2)), m[2].replace(/\s+#+\s*$/, ''))); i++; continue; }
      if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(ln))) {
        flush();
        var ordered = /\d/.test(m[1]);
        if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = h(ordered ? 'ol' : 'ul'); root.appendChild(list); }
        list.appendChild(inline(h('li'), m[2])); i++; continue;
      }
      // A table: a row of cells, then a |---| rule. Workers write them often,
      // and merged into a paragraph they read as a wall of pipes.
      if (/^\s*\|/.test(ln) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
        flush(); list = null;
        var cells = function (row) { return row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(function (c) { return c.trim().replace(/\\\|/g, '|'); }); };
        var cell = function (tag, text) {
          var el = h(tag);
          String(text).split(/<br\s*\/?>/i).forEach(function (part, n) { if (n) el.appendChild(h('br')); inline(el, part); });
          return el;
        };
        var head_ = cells(ln);
        i += 2;
        var body_ = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) body_.push(cells(lines[i++]));
        root.appendChild(h('div', { class: 'md-table' }, h('table', null,
          h('thead', null, h('tr', null, head_.map(function (c) { return cell('th', c); }))),
          h('tbody', null, body_.map(function (r) { return h('tr', null, r.map(function (c) { return cell('td', c); })); })))));
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { flush(); list = null; root.appendChild(h('hr')); i++; continue; }
      if (/^\s*>/.test(ln)) { flush(); list = null; root.appendChild(inline(h('blockquote'), ln.replace(/^\s*>\s?/, ''))); i++; continue; }
      if (!ln.trim()) { flush(); list = null; i++; continue; }
      if (list && /^\s{2,}\S/.test(ln)) { inline(list.lastChild, ' ' + ln.trim()); i++; continue; }
      list = null; para.push(ln.trim()); i++;
    }
    flush();
    return root;
  }
  function inline(el, text) {
    var re = /\*\*([^*]+)\*\*|__([^_]+)__|\x60([^\x60]+)\x60|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\*([^*\s][^*]*)\*/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[1] || m[2]) el.appendChild(h('strong', { text: m[1] || m[2] }));
      else if (m[3]) el.appendChild(h('code', { text: m[3] }));
      else if (m[4]) el.appendChild(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer', text: m[4] }));
      else if (m[6]) el.appendChild(h('a', { href: m[6], target: '_blank', rel: 'noopener noreferrer', text: m[6] }));
      else if (m[7]) el.appendChild(h('em', { text: m[7] }));
      last = re.lastIndex;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
    return el;
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
  /// A titled section, the title in the card's header bar. Flush drops the
  /// padding, for a list whose rows pad themselves.
  function card(id, title, action, body, flush) {
    return h('section', { class: 'sec', 'aria-labelledby': id },
      h('div', { class: 'sec-head' }, h('h2', { id: id, class: 'label', text: title }), action || null),
      h('div', { class: 'sec-body' + (flush ? ' flush' : '') }, body));
  }
  /// A card that opens something: a click anywhere on it, or Enter or Space
  /// when it has focus. Buttons and links inside keep their own clicks.
  function openCard(cls, label, open) {
    var el = h('article', { class: cls + ' clickable', role: 'link', tabindex: '0', 'aria-label': label });
    var inner = 'button, a, input, select, textarea, summary, label';
    el.onclick = function (e) { var hit = e.target && e.target.closest ? e.target.closest(inner) : null; if (hit && hit !== el && el.contains(hit)) return; open(); };
    el.onkeydown = function (e) { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } };
    for (var i = 3; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function kpiIcon(name, tone) { return h('span', { class: 'kpi-ic' + (tone ? ' ' + tone : ''), 'aria-hidden': 'true' }, icon(name, 19)); }
  function emptyState(title, sub, action) {
    return h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: title }), sub ? h('p', { text: sub }) : null,
      action ? h('div', { style: 'margin-top:18px' }, action) : null);
  }
  function go(tab, extra) {
    state.tab = tab; state.hashQuery = null; if (extra) Object.assign(state, extra);
    try { history.pushState(null, '', '#' + hashFor()); } catch (e) {}
    render(); window.scrollTo(0, 0);
  }
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
      api('GET', '/api/whoami').then(function (me) { state.me = me; return api('GET', '/api/workers').then(null, function () {}); }).then(function () { render(); })
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
    return h('a', { class: 'btn go', style: 'min-height:42px;justify-content:center', href: '/sso/start?next=' + encodeURIComponent(next), text: 'Sign in with ' + st.provider });
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
      { id: 'processes', label: 'Processes', icon: 'arrow' },
      { id: 'reports', label: 'Reports', icon: 'bars' }
    ];
    if (state.me && state.me.admin) {
      t.push('sep', { group: 'Admin' });
      t.push({ id: 'setup', label: 'Setup', icon: 'list', issue: 'setup' });
      t.push({ id: 'people', label: 'People', icon: 'person', count: 'people' });
      t.push({ id: 'admin', label: 'Activity', icon: 'doc' });
    }
    return t;
  }

  /// Which nav item a page belongs under.
  function navFor(tab) {
    return { process: 'processes', processedit: 'processes', proclib: 'processes', worker: 'workers', team: 'teams', newteam: 'teams', teamtask: 'teams', teamfiles: 'teams', read: 'library', chart: 'workers', work: 'today', tools: 'setup', rules: 'setup', log: 'admin' }[tab] || tab;
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

  /// The chrome every page shares: whose org this is, a way to jump to any
  /// worker, and the two things that pull you back in (the inbox, Slack).
  function topBar(me) {
    var find = h('input', { type: 'search', id: 'top-search', placeholder: 'Find a worker', 'aria-label': 'Find a worker', value: state.workersQuery || '' });
    find.onkeydown = function (e) {
      if (e.key === 'Enter') go('workers', { workersQuery: find.value.trim() });
      if (e.key === 'Escape') find.blur();
    };
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
    return h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, brandMark(28),
        h('div', { style: 'min-width:0' }, h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('span', { class: 'brand-name', text: 'overcli' }), h('span', { class: 'alpha', title: 'Org workers are an early alpha: expect rough edges and changes.', text: 'alpha' })),
          h('div', { class: 'brand-sub org', text: me.org }))),
      h('label', { class: 'search' }, icon('search', 15), find, h('kbd', { text: mac ? '⌘K' : 'Ctrl K' })),
      h('div', { class: 'top-right' },
        workingPill(),
        h('button', { class: 'top-link', onclick: function () { go('connect'); } }, icon('slack', 16), h('span', { class: 'lbl', text: 'Slack & Claude' })),
        h('button', { class: 'top-link top-bell', 'aria-label': 'Inbox', onclick: function () { go('today'); } }, icon('bell', 17),
          h('span', { class: 'count', 'data-count': 'today', hidden: !state.counts.today, text: state.counts.today ? String(state.counts.today) : '' })),
        userMenu(me)));
  }

  // ---- what's moving, everywhere --------------------------------------------

  /// One poller for "work is being done", shared by the bar on every page
  /// and the Inbox: every 5 s while something moves, every 20 s otherwise,
  /// and not at all while the tab is hidden.
  var nowWork = { items: [], subs: [], timer: null, started: false };
  function nowPoll() {
    clearTimeout(nowWork.timer);
    if (document.hidden || !state.me) { nowWork.timer = setTimeout(nowPoll, 5000); return; }
    api('GET', '/api/now').then(function (items) {
      if (Array.isArray(items)) {
        nowWork.items = items;
        nowWork.subs = nowWork.subs.filter(function (s) { return s.el.isConnected; });
        nowWork.subs.forEach(function (s) { s.fn(items); });
      }
      nowWork.timer = setTimeout(nowPoll, nowWork.items.length ? 5000 : 20000);
    }, function () { nowWork.timer = setTimeout(nowPoll, 20000); });
  }
  function onNow(el, fn) {
    nowWork.subs.push({ el: el, fn: fn });
    fn(nowWork.items);
    if (!nowWork.started) { nowWork.started = true; document.addEventListener('visibilitychange', function () { if (!document.hidden) nowPoll(); }); nowPoll(); }
  }
  function openWorking(x) {
    if ((x.kind === 'run' || x.kind === 'waiting') && x.id.indexOf('run:') === 0) { watchRun(x.id.slice(4), x.workerName + ' · ' + x.title); return; }
    if (x.teamId && x.kind === 'team') go('team', { teamId: x.teamId });
    else if (x.workerId) openWorker(x.workerId);
  }
  var NOW_KIND = { run: ['working', 'Running'], deciding: ['working', 'Deciding'], waiting: ['waiting', 'Waiting'], team: ['working', 'Team'] };
  function workingRow(x) {
    var b = NOW_KIND[x.kind] || ['', x.kind];
    return h('button', { class: 'work-row', onclick: function () { openWorking(x); } },
      x.kind === 'team' ? h('span', { class: 'avatar s', style: 'background:var(--go)', 'aria-hidden': 'true' }, icon('team', 14)) : avatar(x.workerId || '', x.workerName || '?', 's'),
      h('span', { class: 'stack', style: 'gap:2px;min-width:0;flex:1;text-align:left' },
        h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' },
          h('b', { style: 'font-weight:600;white-space:nowrap', text: x.kind === 'team' ? x.teamName : x.workerName }),
          h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0', text: x.title })),
        h('span', { class: 'faint', style: 'font-size:12.5px', text: x.detail + (x.teamName && x.kind !== 'team' ? ' · for ' + x.teamName : '') + ' · ' + secs(Date.now() - x.at) + (x.costUSD ? ' · ' + money(x.costUSD) : '') })),
      h('span', { class: 'badge ' + b[0], text: b[1] }));
  }
  /// The bar's pill: how many things are moving, and a list on click.
  function workingPill() {
    var count = h('span', { class: 'lbl' });
    var dot = h('span', { class: 'livedot' });
    var pop = h('div', { class: 'work-pop', hidden: true, role: 'dialog', 'aria-label': 'Working now' });
    var btn = h('button', { class: 'top-link working-pill', 'aria-expanded': 'false', hidden: true }, dot, count);
    var wrap = h('div', { class: 'working-wrap' }, btn, pop);
    var close = function (e) { if (!wrap.contains(e.target)) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', close); } };
    btn.onclick = function () {
      pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', pop.hidden ? 'false' : 'true');
      if (!pop.hidden) setTimeout(function () { document.addEventListener('click', close); }, 0);
    };
    onNow(wrap, function (items) {
      var waiting = items.filter(function (x) { return x.kind === 'waiting'; }).length;
      var moving = items.length - waiting;
      btn.hidden = !items.length;
      dot.className = 'livedot' + (moving ? '' : ' need');
      count.textContent = moving ? moving + ' working' + (waiting ? ' · ' + waiting + ' waiting' : '') : waiting + ' waiting';
      pop.replaceChildren(h('div', { class: 'work-pop-head' }, h('b', { text: 'Working now' }), h('span', { class: 'faint', text: 'refreshes on its own' })),
        items.length ? h('div', null, items.map(workingRow)) : h('p', { class: 'muted', style: 'padding:12px 14px', text: 'Nothing running.' }));
    });
    return wrap;
  }

  /// Who you are, your allowance, appearance and sign-out, behind your avatar.
  function userMenu(me) {
    var pct = me.allowanceUSD ? Math.min(100, (me.committedUSD / me.allowanceUSD) * 100) : 0;
    var pop = h('div', { class: 'menu', role: 'menu', hidden: true },
      h('div', { class: 'menu-who' }, avatar('', me.name, 'm'),
        h('div', { style: 'min-width:0' }, h('div', { class: 'me-name', text: me.name }), h('div', { class: 'me-role', text: (me.admin ? 'Admin' : me.canHire ? 'Can hire' : 'Member') + ' · ' + me.org }))),
      me.allowanceUSD != null ? h('div', { class: 'menu-sec stack', style: 'gap:6px' },
        h('div', { class: 'allow-label' }, h('span', { text: 'Your monthly allowance' }), h('span', { text: money(me.committedUSD) + ' of ' + money(me.allowanceUSD) })),
        h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' }))) : null,
      h('div', { class: 'menu-sec stack', style: 'gap:6px' }, h('span', { class: 'allow-label', text: 'Appearance' }), themeSwitch()),
      h('div', { class: 'menu-sec' },
        h('button', { class: 'menu-item', role: 'menuitem', onclick: function () { close(); go('connections'); } }, icon('plug', 16), 'Your connections'),
        h('button', { class: 'menu-item', role: 'menuitem', onclick: function () { close(); go('connect'); } }, icon('slack', 16), 'Use from Slack or Claude'),
        h('button', { class: 'menu-item', role: 'menuitem', onclick: function () { var done = function () { store(TOKEN_KEY, null); state.me = null; render(); }; api('POST', '/api/signout').then(done, done); } }, icon('back', 16), 'Sign out')));
    var btn = h('button', { class: 'top-link', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, avatar('', me.name, 's'), h('span', { class: 'lbl', text: me.name }));
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    function esc(e) { if (e.key === 'Escape') { close(); btn.focus(); } }
    function close() {
      pop.hidden = true; btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc);
    }
    btn.onclick = function () {
      if (!pop.hidden) { close(); return; }
      pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', outside); document.addEventListener('keydown', esc);
    };
    var wrap = h('div', { class: 'menu-wrap' }, btn, pop);
    return wrap;
  }

  // ⌘K or / from anywhere puts you in the finder.
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
      var box = document.getElementById('top-search');
      if (box) { e.preventDefault(); box.focus(); box.select(); }
    }
  });

  // ⌘↵ (Ctrl+Enter) in a text box sends it: the box's own main button, the
  // nearest one around it. A box that handles its own keys is left to them.
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.defaultPrevented || !t || t.tagName !== 'TEXTAREA' || t.onkeydown) return;
    // No further than the box's own card: a box with no button of its own
    // must not press one somewhere else on the page.
    for (var el = t.parentElement; el && el !== document.body; el = el.parentElement) {
      var b = el.querySelector('button.go:not([disabled])');
      if (b) { e.preventDefault(); b.click(); return; }
      if (el.matches('section, article, aside, form, .panel, .reader, [role="dialog"]')) return;
    }
  });

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
    // The picture a draft came from, open beside the editor, closes with it.
    document.body.classList.remove('pi-open');
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
      api('GET', '/api/whoami').then(function (me) { state.me = me; return api('GET', '/api/workers').then(null, function () {}); }).then(function () { render(); }).catch(function (e) {
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
    // Tabs inside a page (a worker's, Setup's) change state and re-render
    // without going through go(): keep the address in step either way.
    try { if (location.hash !== '#' + hashFor()) history.replaceState(null, '', '#' + hashFor()); } catch (e) {}
    document.title = me.org + ' — overcli';
    // Hiring is narrow once it's questions or an offer; the brief has the
    // ideas beside it.
    var main = h('div', { class: 'page' + (state.tab === 'connect' || (state.tab === 'hire' && state.hire) ? ' narrow' : '') }, thinking('Loading…'));
    var activeTab = navFor(state.tab);
    app.appendChild(h('div', { class: 'frame' },
      topBar(me),
      h('aside', { class: 'side' },
        h('nav', { class: 'nav', 'aria-label': 'Sections' }, tabs().map(function (t) {
          if (t === 'sep') return h('div', { class: 'sep', 'aria-hidden': 'true' });
          if (t.group) return h('div', { class: 'group', text: t.group });
          return h('button', { 'aria-current': activeTab === t.id ? 'page' : null, onclick: function () { go(t.id); } },
            icon(t.icon), t.label,
            t.count ? h('span', { class: 'count', 'data-count': t.count, hidden: !state.counts[t.count], text: state.counts[t.count] ? String(state.counts[t.count]) : '' }) : null,
            t.issue ? h('span', { class: 'issue', 'data-issue': t.issue, hidden: !state.counts[t.issue], text: state.counts[t.issue] ? plural(state.counts[t.issue], 'issue', 'issues') : '' }) : null);
        })),
        // At the foot of the menu: always to hand, never louder than the page.
        me.canHire ? h('button', { class: 'btn side-hire', 'aria-current': state.tab === 'hire' ? 'page' : null, onclick: function () { go('hire'); } }, icon('plus', 16), 'Hire a worker') : null),
      h('main', { class: 'main' }, main)));
    refreshCounts();
    if (state.tab === 'tools' || state.tab === 'rules') { state.setupTab = state.tab; state.tab = 'setup'; }
    var view = { today: viewToday, work: viewWork, workers: viewWorkers, worker: viewWorker, teams: viewTeams, processes: viewProcesses, proclib: viewProcLibrary, process: viewProcess, processedit: viewProcessEdit, newteam: viewNewTeam, team: viewTeam, teamtask: viewTeamTask, teamfiles: viewTeamFiles, connections: viewConnections, read: viewRead, file: viewFile, chart: viewChart, hire: viewHire, people: viewPeople, admin: viewAdmin, connect: viewConnect, rules: viewRules, log: viewLog, tools: viewTools, setup: viewSetup, library: viewLibrary, reports: viewReports }[state.tab] || viewToday;
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
      // Later steps needing only the same tools: one OK for all of them.
      var later = it.coversLater || 0;
      var whole = later ? h('button', { class: 'btn go', text: 'Approve for this run' }) : null;
      var approve = h('button', { class: later ? 'btn' : 'btn go', text: later ? 'Just this step' : 'Approve' });
      var reject = h('button', { class: 'btn danger', text: 'Turn down' });
      var decide = function (yes, forRun) {
        return function () {
          approve.disabled = reject.disabled = true; if (whole) whole.disabled = true;
          api('POST', '/api/approval', { runId: it.runId, approve: yes, forRun: !!forRun }).then(done(!yes ? 'Rejected. The run is stopped.' : forRun ? 'Approved for this run. It won’t ask again unless a step needs something new.' : 'Approved. The step is running.'))
            .then(function (r) { if (r.ok === false) { approve.disabled = reject.disabled = false; if (whole) whole.disabled = false; } });
        };
      };
      approve.onclick = decide(true); reject.onclick = decide(false); if (whole) whole.onclick = decide(true, true);
      var covers = later ? ' Approving for this run also covers ' + (later === 1 ? 'the 1 later step that uses' : 'the ' + later + ' later steps that use') + ' the same tools; anything new still asks.' : ' Approving covers this one step.';
      body = [h('p', { class: 'muted', text: it.reaches && it.reaches.length
          ? 'Its next step ' + it.reaches.join(', ') + ', so it asks first.' + covers
          : 'Its next step reaches outside overcli: it may push code, send a message, publish, or change a service.' + covers }),
        it.instructions ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'faint', text: 'What the step is told to do' }), h('div', { class: 'preview' }, h('pre', { text: it.instructions }))) : null,
        (it.inputs || []).map(function (inp) {
          return h('details', null, h('summary', { text: 'What it will use: ' + inp.name }), h('div', { class: 'preview', style: 'margin-top:8px' }, h('pre', { text: inp.preview })));
        }),
        h('div', { class: 'row' }, whole, approve, reject)];
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

  /// What a team task needs from you, as controls: answers to the
  /// coordinator's questions, the plan to approve, or a stop to clear.
  /// A tail, when given, sits at the right end of the controls' own button
  /// row (the card's spend and Open), so the card has one footer, not three.
  function teamTaskControls(t, out, after, tail) {
    var right = function () { return tail ? h('span', { class: 'row', style: 'gap:12px;margin-left:auto;flex-wrap:nowrap' }, tail) : null; };
    var act = function (body, okText) {
      return function () {
        api('POST', '/api/team-tasks/' + encodeURIComponent(t.id), body).then(function (r) { out.textContent = ''; out.appendChild(msg(r, okText)); if (r.ok !== false) after(); });
      };
    };
    var controls = null;
    if (t.waitingOnYou && t.needs === 'answers') {
      var boxes = (t.questions || []).map(function (q) { return { q: q, ta: h('textarea', { 'aria-label': q, placeholder: 'Your answer', style: 'min-height:56px' }) }; });
      controls = h('div', { class: 'stack' }, boxes.map(function (b) { return h('div', { class: 'qa' }, h('div', { class: 'quote', style: 'font-size:15.5px', text: b.q }), b.ta); }),
        h('p', { class: 'faint', style: 'margin:0;font-size:13px', text: 'Answer what you can. One left blank takes the assumption in brackets.' }),
        h('div', { class: 'row', style: 'align-items:center' }, h('button', { class: 'btn go', text: 'Send answers', title: '⌘↵', onclick: function () {
          act({ kind: 'answer', answers: boxes.map(function (b) { return b.ta.value; }) }, 'Sent. The coordinator is planning.')();
        } }), h('button', { class: 'btn danger', text: 'Cancel the task', onclick: act({ kind: 'cancel' }, 'Cancelled.') }), right()));
    } else if (t.waitingOnYou && t.needs === 'plan') {
      var fb = h('input', { type: 'text', placeholder: 'Or say what to change', 'aria-label': 'Changes to the plan' });
      controls = h('div', { class: 'stack' },
        t.planNote ? h('div', { class: 'quote', style: 'font-size:15.5px', text: t.planNote }) : null,
        h('div', { class: 'row', style: 'align-items:center' },
          h('button', { class: 'btn go', text: 'Approve the plan', onclick: act({ kind: 'approve' }, 'Approved. The team is on it.') }),
          h('button', { class: 'btn danger', text: 'Cancel', onclick: act({ kind: 'cancel' }, 'Cancelled.') }), right()),
        h('div', { class: 'inline-form' }, fb, h('button', { class: 'btn', text: 'Ask for changes', onclick: function () { if (fb.value.trim()) act({ kind: 'revise', feedback: fb.value }, 'Sent back to the coordinator.')(); } })));
    } else if (t.status === 'queued') {
      controls = h('div', { class: 'row', style: 'align-items:center' }, h('button', { class: 'btn small', text: 'Take it out of the queue', onclick: act({ kind: 'cancel' }, 'Taken out. The team won’t start it.') }), right());
    } else if (t.waitingOnYou) {
      controls = h('div', { class: 'stack' },
        t.waitingMessage ? h('p', { class: 'why', text: t.waitingMessage }) : null,
        h('div', { class: 'row', style: 'align-items:center' },
          h('button', { class: 'btn go', text: 'Carry on', onclick: act({ kind: 'continue' }, 'Carrying on.') }),
          h('button', { class: 'btn danger', text: 'Cancel the task', onclick: act({ kind: 'cancel' }, 'Cancelled.') }), right()));
    }
    return controls;
  }

  function teamTaskCard(t) {
    var out = h('div');
    var card = h('article', { class: 'panel pad stack' + (t.waitingOnYou ? ' ask need' : '') });
    if (t.waitingOnYou) card.style.setProperty('display', 'flex');
    var controls = teamTaskControls(t, out, function () { setTimeout(render, 900); });
    var status = t.waitingOnYou ? 'Waiting on you' : t.status === 'running' ? 'Working' : t.status[0].toUpperCase() + t.status.slice(1);
    append(card, h('div', { class: 'stack', style: 'width:100%' },
      h('div', { class: 'spread' },
        h('div', null,
          h('h3', { class: 'serif', style: 'font-size:19px' }, h('button', { class: 'linkish', style: 'color:var(--ink);font:inherit', text: t.title, onclick: function () { go('team', { teamId: t.teamId }); } })),
          h('p', { class: 'faint', text: t.teamName + (t.requestedBy ? ', for ' + t.requestedBy : '') + '. ' + money(t.spentUSD) + ' spent of a ' + money(t.budgetUSD) + ' cap.' })),
        h('span', { class: 'tag' + (t.waitingOnYou ? ' need' : t.status === 'done' ? ' go' : ''), text: status })),
      t.stages.length ? stageStrip(t) : null,
      t.packSummary ? h('details', null, h('summary', { text: 'What the team delivered' }), h('div', { style: 'font-size:14px;margin-top:8px' }, md(t.packSummary))) : null,
      t.code ? teamCode(t) : null,
      controls, out));
    return card;
  }

  /// A team task's code: its branch in each repo, and — once it's done —
  /// pushing them, with one link per repo to open the pull request.
  function teamCode(t) {
    var said = h('div');
    var changed = t.code.repos.filter(function (r) { return r.ahead !== 0; });
    var waiting = changed.filter(function (r) { return !r.pushed; });
    var push = t.status === 'done' && waiting.length ? h('button', { class: 'btn go small', text: 'Push the branches', onclick: function (e) {
      var restore = busy(e.target, 'Pushing…');
      api('POST', '/api/team-tasks/' + encodeURIComponent(t.id) + '/push', {}).then(function (r) {
        restore(); said.textContent = '';
        if (r.ok === false) { said.appendChild(msg(r)); return; }
        r.failed.forEach(function (f) { said.appendChild(h('div', { class: 'msg err', text: f.repo + ': ' + f.error })); });
        if (r.pushed.length) setTimeout(render, 900);
      });
    } }) : null;
    return h('div', { class: 'stack', style: 'gap:6px' },
      h('div', { class: 'faint', text: 'Code on ' + t.code.branch }),
      t.code.repos.map(function (r) {
        return h('div', { class: 'row', style: 'gap:8px;align-items:center' },
          h('code', { text: r.name }),
          h('span', { class: 'faint', text: r.ahead === 0 ? 'no changes' : r.ahead ? plural(r.ahead, 'commit', 'commits') : '' }),
          r.pushed ? (r.pushed.url ? h('a', { href: r.pushed.url, target: '_blank', rel: 'noopener', text: 'Open a pull request ↗' }) : h('span', { class: 'tag go', text: 'Pushed' })) : null);
      }),
      push, said);
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
    var detail = h('div', { hidden: true, style: 'font-size:13.5px' }, md(d.summary));
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

  function proposalCard(b, after) {
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
        if (typeof after === 'function') after(x);
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
        h('span', { class: 'faint', style: 'flex:none;display:flex' }, icon('arrow', 16)), who, text, h('button', { class: 'btn go small', text: 'Ask', onclick: send })),
      out);
  }

  /// One thing that came in, as a line that opens it: a team task's page, a
  /// kept file in its folder, or anything else in the reader, in full.
  function cameInRow(x) {
    var k = LIB_KIND[x.kind] || ['doc', '', 'Item'];
    var src = libSource(x);
    var o = libOrigin(x);
    var open = function () {
      if (x.kind === 'task') return openTask(o.taskId);
      if (x.kind === 'file') return go('teamfiles', { taskId: o.taskId, teamFilePick: (x.source && x.source.file) || x.title });
      openReader(x.title, src.filter(Boolean).join(' · '), function (put) {
        api('GET', '/api/library/' + encodeURIComponent(x.id)).then(function (y) {
          var it = y.ok === false ? x : y.item;
          put([y.ok === false ? msg(y) : null, x.runId ? runFiles(x.runId, [x.workerName, x.title].join(' · ')) : null, it.body ? md(it.body) : h('p', { class: 'muted', text: 'Nothing written.' })]);
        }, function () { put([x.body ? md(x.body) : null]); });
      }, 'read/' + encodeURIComponent(x.id));
    };
    return h('button', { class: 'camerow', onclick: open },
      h('span', { class: 'kpi-ic libkind ' + k[1], 'aria-hidden': 'true' }, icon(k[0], 15)),
      h('span', { class: 'stack', style: 'gap:2px;min-width:0' },
        h('b', { class: 'cametitle', text: nameOf(x) }),
        h('span', { class: 'libsrc' }, h('span', { class: 'libtag ' + k[1], text: src[0] }), h('span', { text: src[1] })),
        h('span', { class: 'faint', text: ago(x.at) + (x.kind === 'task' && x.pack ? ' · ' + plural(x.pack.files.length, 'deliverable', 'deliverables') : '') })));
  }

  function viewToday() {
    return Promise.all([api('GET', '/api/today'), api('GET', '/api/tools').catch(function () { return { ok: false }; }), api('GET', '/api/workers'), api('GET', '/api/library').catch(function () { return []; }), api('GET', '/api/inflight').catch(function () { return { ok: false }; })]).then(function (r) {
      var t = r[0], tl = r[1], workers = r[2].filter(function (w) { return w.enabled; });
      // Came in: what triggers delivered in the last day, then finished work.
      var dayAgo = Date.now() - 86400000;
      // The Library's items, not raw work: each says where it came from, and a
      // team task is one entry rather than one per stage.
      var cameIn = (Array.isArray(r[3]) ? r[3] : []).filter(function (x) { return x.status === 'delivered' && x.at >= dayAgo; });
      t.delivered = cameIn;
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
      // Everything in flight, from workers, teams and processes, in one list;
      // what waits on you is in Needs you instead.
      var flight = r[4] && r[4].ok !== false ? r[4].items || [] : [];
      var decisions = flight.filter(function (x) { return x.kind === 'process' && x.needsYou; });
      var moving = flight.filter(function (x) { return !x.needsYou; }).sort(function (a, b) { return (b.stuck ? 1 : 0) - (a.stuck ? 1 : 0) || b.since - a.since; });
      needs += decisions.length;
      var KIND = { worker: ['W', 'Worker'], team: ['T', 'Team'], process: ['P', 'Process'] };
      var openFlight = function (x) {
        if (x.kind === 'worker') return go('worker', { workerId: x.workerId, workerTab: 'talk' });
        if (x.kind === 'team') return openTask(x.id);
        go('process', { processId: x.processId, processItem: x.id });
      };
      var flightTab = state.flightTab || 'all';
      var flightBody = h('div', { class: 'if-rows' });
      var drawFlight = function () {
        var shown = moving.filter(function (x) { return flightTab === 'all' || x.kind === flightTab; });
        fill(flightBody, shown.length ? shown.map(function (x) {
          return h('button', { type: 'button', class: 'if-row' + (x.stuck ? ' stuck' : ''), onclick: function () { openFlight(x); } },
            h('span', { class: 'if-mark ' + x.kind, 'aria-hidden': 'true', text: KIND[x.kind][0] }),
            h('span', { class: 'if-main' },
              h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' }, h('span', { class: 'if-kind ' + x.kind, text: KIND[x.kind][1] }), h('b', { class: 'if-title', text: x.title })),
              h('span', { class: 'faint', text: x.who })),
            h('span', { class: 'if-where' },
              h('span', { class: 'pv-track', style: 'grid-template-columns:repeat(' + Math.max(1, x.total) + ',minmax(0,1fr))' }, Array.apply(null, Array(Math.max(1, x.total))).map(function (_, i) {
                return h('span', { class: i < x.at ? 'done' : i === x.at ? (x.stuck ? 'stuck' : 'now') : '' });
              })),
              h('span', { class: 'if-now' + (x.stuck ? ' bad' : ''), text: x.now })),
            h('span', { class: 'faint if-age', text: ago(x.since) }));
        }) : [h('p', { class: 'muted', style: 'margin:0;padding:16px', text: moving.length ? 'Nothing of this kind in flight.' : 'Nothing running right now.' })]);
      };
      drawFlight();
      var flightTabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [['all', 'All'], ['worker', 'Workers'], ['team', 'Teams'], ['process', 'Processes']].map(function (o) {
        return h('button', { type: 'button', 'aria-pressed': flightTab === o[0] ? 'true' : 'false', onclick: function () { state.flightTab = o[0]; render(); } }, o[1]);
      }));
      var decisionCard = function (x) {
        return h('div', { class: 'if-need' },
          h('span', { class: 'if-kind need', text: 'Decision' }),
          h('div', { class: 'stack', style: 'gap:2px;min-width:0;flex:1 1 300px' }, h('b', { text: x.title }), h('span', { class: 'faint', text: x.who + ' · ' + x.now })),
          h('button', { class: 'btn small go', text: 'Decide', onclick: function () { openFlight(x); } }));
      };
      var finished = cameIn.slice().sort(function (a, b) { return b.at - a.at; });
      // The title's count now includes process decisions.
      nodes[0].querySelector('.page-title').textContent = (WORDS[needs] || plural(needs, 'thing', 'things')) + (needs === 1 || needs === 0 ? ' needs you' : ' need you');
      nodes.push(h('div', { class: 'if-sum' },
        h('span', null, h('b', { class: needs ? 'need' : '', text: String(needs) }), ' need you'),
        h('span', null, h('b', { text: String(moving.length) }), ' in flight'),
        h('span', null, h('b', { class: 'ok', text: String(finished.length) }), ' finished since yesterday'),
        h('span', { class: 'faint' }, money(t.spend.spentUSD) + ' this month' + (t.spend.allowanceUSD != null ? ' of ' + money(t.spend.allowanceUSD) : ''))));
      nodes.push(h('div', { class: 'stack', style: 'gap:22px' },
        // Needs you shows only when something does: the title already says
        // when nothing does. A crew of nobody gets the way to hire one.
        needs ? h('section', { class: 'stack', style: 'gap:8px', 'aria-label': 'Needs you' },
          h('span', { class: 'label if-needlabel', text: 'Needs you · ' + needs }),
          h('div', { class: 'stack', style: 'gap:8px' }, fixes.map(fixCard), t.waiting.map(waitingCard), decisions.map(decisionCard), t.proposals.map(proposalCard), t.hireApprovals.map(hireApprovalCard), mineTasks.map(teamTaskCard)))
          : !t.crew.length ? h('div', { class: 'empty' }, h('div', { class: 'quote', text: 'Nobody to hear from yet.' }),
              h('p', { text: 'Hire a worker and what it needs from you lands here.' }),
              state.me.canHire ? h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn go', text: 'Hire your first worker', onclick: function () { go('hire'); } })) : null) : null,
        h('section', { class: 'stack', style: 'gap:8px', 'aria-label': 'In flight' },
          h('div', { class: 'row', style: 'gap:12px' }, h('span', { class: 'label', style: 'flex:1', text: 'In flight · ' + moving.length }),
            upcoming.length ? h('span', { class: 'faint if-next' }, 'Up next: ', upcoming.map(function (w, i) {
              return [i ? ' · ' : '', h('button', { class: 'linkish', style: 'font-size:12.5px', text: w.name, onclick: function () { openWorker(w.id); } }), ' ' + when(w.nextShiftAt)];
            })) : null,
            moving.length ? flightTabs : null),
          flightBody),
        h('section', { class: 'stack', style: 'gap:8px', 'aria-label': 'Finished since yesterday' },
          h('div', { class: 'row', style: 'gap:12px' }, h('span', { class: 'label', style: 'flex:1', text: 'Finished since yesterday · ' + finished.length }), h('button', { class: 'linkish', text: 'Library →', onclick: function () { go('library'); } })),
          finished.length ? h('div', { class: 'panel if-done' }, finished.slice(0, 8).map(cameInRow)) : h('p', { class: 'muted', style: 'margin:0', text: 'Nothing finished since yesterday.' }))));
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

  var TRUST_RUNG = { probation: 'Asks first', trusted: 'Trusted', autonomous: 'On its own' };

  /// A worker's state as a badge: the class says how loudly, the text what.
  function workerBadge(w) {
    var st = workerStatus(w);
    var cls = st.cls || (w.state === 'working' ? 'working' : w.enabled ? 'ok' : '');
    var short = !w.enabled ? 'Paused' : st.cls === 'bad' ? 'Can’t reach a tool' : w.waiting ? 'Waiting on you' : w.state === 'working' ? 'Working' : w.state === 'stuck' ? 'Stuck' : 'Idle';
    return h('span', { class: 'badge ' + cls, title: st.text, text: short });
  }

  function spendCell(spent, budget) {
    var pct = budget ? Math.min(100, (spent / budget) * 100) : 0;
    return h('div', { class: 'spendcell' },
      h('div', { class: 'meter' + (pct >= 100 ? ' over' : pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })),
      h('span', { text: money(spent) + ' / ' + money(budget) }));
  }

  function viewWorkers() {
    return api('GET', '/api/workers').then(function (list) {
      if (!list.length) return [head('Workers', null, hireButton(), 'Workspace'), emptyState('No workers you can see yet.', 'Hire one, or ask your admin to make a team’s workers visible to you.', hireButton())];
      var filter = state.workersFilter || 'all';
      var attention = function (w) { return workerStatus(w).cls === 'bad' || w.waiting > 0 || w.state === 'stuck'; };
      var counts = { all: list.length, mine: list.filter(function (w) { return w.youManage; }).length, attention: list.filter(attention).length };
      var body = h('tbody');
      var shown = h('span');
      var query = h('input', { type: 'search', placeholder: 'Filter by name', 'aria-label': 'Filter workers', value: state.workersQuery || '' });
      var trust = h('select', { 'aria-label': 'Trust level' }, h('option', { value: '', text: 'Any trust level' }),
        Object.keys(TRUST_RUNG).map(function (k) { return h('option', { value: k, text: TRUST_RUNG[k] }); }));
      var draw = function () {
        var q = query.value.trim().toLowerCase();
        state.workersQuery = query.value.trim();
        body.textContent = '';
        var rows = list.filter(function (w) {
          if (filter === 'mine' && !w.youManage) return false;
          if (filter === 'attention' && !attention(w)) return false;
          if (trust.value && w.trust !== trust.value) return false;
          return !q || (w.name + ' ' + w.tagline + ' ' + (w.manager || '')).toLowerCase().indexOf(q) >= 0;
        });
        rows.forEach(function (w) {
          var tr = h('tr', { class: 'link', tabindex: '0', onclick: function () { openWorker(w.id); }, onkeydown: function (e) { if (e.key === 'Enter') openWorker(w.id); } },
            h('td', null, h('div', { class: 'who' }, avatar(w.id, w.name, 's'), h('div', { style: 'min-width:0' }, h('b', { text: w.name }), h('span', { class: 'sub', text: w.tagline })))),
            h('td', null, workerBadge(w)),
            h('td', null, h('span', { class: 'badge t-' + w.trust, text: TRUST_RUNG[w.trust] || w.trust })),
            h('td', { class: 'muted', text: w.manager || '—' }),
            h('td', { class: 'muted' }, w.schedule, w.enabled && w.nextRunAt ? h('span', { class: 'sub', text: 'Next ' + when(w.nextRunAt) }) : null),
            h('td', null, spendCell(w.spentThisMonthUSD, w.budgetUSDPerMonth)));
          body.appendChild(tr);
        });
        if (!rows.length) body.appendChild(h('tr', null, h('td', { colspan: '6', class: 'muted', style: 'padding:28px 16px;text-align:center', text: 'No workers match.' })));
        shown.textContent = 'Showing ' + rows.length + ' of ' + list.length;
      };
      query.oninput = draw;
      trust.onchange = draw;
      draw();
      var waitingN = list.filter(function (w) { return w.waiting > 0; }).reduce(function (n, w) { return n + w.waiting; }, 0);
      var working = list.filter(function (w) { return w.state === 'working'; }).length;
      var broken = list.filter(function (w) { return workerStatus(w).cls === 'bad'; }).length;
      var spent = list.reduce(function (n, w) { return n + (w.spentThisMonthUSD || 0); }, 0);
      var budget = list.reduce(function (n, w) { return n + (w.enabled ? w.budgetUSDPerMonth || 0 : 0); }, 0);
      var tab = function (id, label) {
        return h('button', { 'aria-pressed': filter === id ? 'true' : 'false', onclick: function () { state.workersFilter = id; render(); } }, label, h('span', { class: 'c', text: String(counts[id]) }));
      };
      return [head('Workers', null, h('div', { class: 'page-actions' }, h('button', { class: 'btn', onclick: function () { go('chart'); } }, icon('chart', 16), 'Org chart'), hireButton()), 'Workspace'),
        h('div', { class: 'kpis' },
          h('div', { class: 'kpi' }, kpiIcon('people'), h('span', { class: 'k', text: 'Workers' }), h('span', { class: 'v', text: String(list.length) }), h('span', { class: 'n', text: list.filter(function (w) { return !w.enabled; }).length + ' paused' })),
          h('div', { class: 'kpi' }, kpiIcon('inbox', 'need'), h('span', { class: 'k', text: 'Waiting on you' }), h('span', { class: 'v' + (waitingN ? ' need' : ''), text: String(waitingN) }), waitingN ? h('button', { class: 'n', text: 'Open inbox →', onclick: function () { go('today'); } }) : h('span', { class: 'n', text: 'All clear' })),
          h('div', { class: 'kpi' }, kpiIcon('bolt', 'ok'), h('span', { class: 'k', text: 'Working now' }), h('span', { class: 'v', text: String(working) }), h('span', { class: 'n', text: broken ? plural(broken, 'can’t reach a tool', 'can’t reach a tool') : 'Every tool reachable' })),
          h('div', { class: 'kpi' }, kpiIcon('bars', 'violet'), h('span', { class: 'k', text: 'Spend this month' }), h('span', { class: 'v', text: money(spent) }), h('button', { class: 'n', text: 'of ' + money(budget) + ' budgeted · Reports →', onclick: function () { go('reports'); } }))),
        h('section', { class: 'tcard', 'aria-label': 'Workers' },
          h('div', { class: 'tbar' },
            h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' }, tab('all', 'All'), tab('mine', 'Managed by me'), tab('attention', 'Needs attention')),
            h('div', { class: 'tools' }, query, trust)),
          h('div', { class: 'tscroll' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, ['Worker', 'Status', 'Trust', 'Manager', 'Schedule', 'Spend this month'].map(function (t) { return h('th', { text: t }); }))),
            body)),
          h('div', { class: 'tfoot' }, shown, h('button', { class: 'linkish', style: 'color:var(--go)', text: 'View as org chart →', onclick: function () { go('chart'); } })))];
    });
  }

  /// Every run a worker has finished, newest first, 50 at a time. A row
  /// opens to show what the run produced.
  function runsView(w) {
    var outcome = state.runsOutcome || '';
    var body = h('tbody');
    var foot = h('div', { class: 'tfoot' });
    var count = h('span', { class: 'faint' });
    var before = null;
    var MARK = { done: ['Finished', 'ok'], failed: ['Failed', 'bad'], stopped: ['Stopped', ''] };
    var row = function (r) {
      var isMd = r.result && /\.(md|markdown|txt)$/i.test(r.result.name);
      var detail = h('tr', { class: 'run-detail', hidden: true }, h('td', { colspan: '6' },
        r.error ? h('div', { class: 'msg err', style: 'margin-bottom:10px', text: r.error }) : null,
        r.result ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint' }, 'What it produced: ', h('code', { text: r.result.name })),
          h('div', { class: 'wc-out', style: 'margin-top:0' }, isMd ? md(r.result.body) : h('pre', { text: r.result.body })))
          : !r.error ? h('span', { class: 'faint', text: 'It produced no file.' }) : null));
      var open = !!(r.result || r.error);
      var tr = h('tr', { class: open ? 'link' : null, tabindex: open ? '0' : null, 'aria-expanded': open ? 'false' : null },
        h('td', { class: 'muted', text: when(r.at) }),
        h('td', null, h('b', { style: 'font-weight:600', text: r.title }), r.result ? h('span', { class: 'sub', text: r.result.name }) : null),
        h('td', null, h('span', { class: 'badge ' + MARK[r.outcome][1], text: MARK[r.outcome][0] })),
        h('td', { class: 'r', text: String(r.steps) }),
        h('td', { class: 'r', text: r.minutes ? r.minutes + ' min' : '<1 min' }),
        h('td', { class: 'r', text: r.costUSD ? money(r.costUSD) : '—' }));
      if (open) {
        var toggle = function () { detail.hidden = !detail.hidden; tr.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true'); };
        tr.onclick = toggle; tr.onkeydown = function (e) { if (e.key === 'Enter') toggle(); };
      }
      return [tr, detail];
    };
    var more = h('button', { class: 'btn small', text: 'Load 50 more' });
    var load = function () {
      var q = '/api/workers/' + encodeURIComponent(w.id) + '/runs?limit=50' + (outcome ? '&outcome=' + outcome : '') + (before ? '&before=' + before : '');
      var restore = before ? busy(more, 'Loading…') : function () {};
      return api('GET', q).then(function (x) {
        restore();
        if (x.ok === false) { body.replaceChildren(h('tr', null, h('td', { colspan: '6' }, msg(x)))); return; }
        if (!before && !x.runs.length) body.appendChild(h('tr', null, h('td', { colspan: '6', class: 'muted', style: 'padding:28px 16px;text-align:center', text: outcome ? 'No runs like that.' : w.name + ' hasn’t finished a run yet.' })));
        x.runs.forEach(function (r) { append(body, row(r)); });
        before = x.nextBefore;
        var shown = body.querySelectorAll('tr:not(.run-detail)').length;
        count.textContent = x.total ? 'Showing ' + Math.min(shown, x.total) + ' of ' + plural(x.total, 'run', 'runs') : '';
        more.hidden = !before;
      });
    };
    more.onclick = load;
    var tab = function (id, label) { return h('button', { 'aria-pressed': outcome === id ? 'true' : 'false', text: label, onclick: function () { state.runsOutcome = id; render(); } }); };
    var node = h('section', { class: 'tcard', 'aria-label': 'Runs' },
      h('div', { class: 'tbar' }, h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' }, tab('', 'All'), tab('done', 'Finished'), tab('failed', 'Failed'), tab('stopped', 'Stopped'))),
      h('div', { class: 'tscroll' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', { text: 'Started' }), h('th', { text: 'Run' }), h('th', { text: 'Outcome' }), h('th', { class: 'r', text: 'Steps' }), h('th', { class: 'r', text: 'Took' }), h('th', { class: 'r', text: 'Cost' }))),
        body)),
      foot);
    append(foot, [count, more]);
    load();
    return node;
  }

  // ---- a worker's work, as threads -----------------------------------------

  /// One poller per worker page, shared by the bar above the tabs and the
  /// conversation: fast while something is moving, slow otherwise, so an
  /// approval given in Slack still shows up here.
  var live = { workerId: null, data: null, subs: [], timer: null, seq: 0 };
  function liveFor(workerId) {
    if (live.workerId !== workerId) {
      clearTimeout(live.timer);
      live = { workerId: workerId, data: null, subs: [], timer: null, seq: 0 };
    }
    return live;
  }
  function liveSubscribe(workerId, fn) {
    var l = liveFor(workerId);
    l.subs.push(fn);
    if (l.data) fn(l.data);
    livePoke(workerId, 0);
  }
  function livePoke(workerId, delay) {
    var l = liveFor(workerId);
    clearTimeout(l.timer);
    l.timer = setTimeout(function () { liveFetch(workerId); }, delay || 0);
  }
  function liveFetch(workerId) {
    var l = liveFor(workerId);
    var seq = ++l.seq;
    api('GET', '/api/workers/' + encodeURIComponent(workerId) + '/threads?limit=' + (l.limit || 20)).then(function (x) {
      if (live !== l || seq !== l.seq) return;
      l.subs = l.subs.filter(function (s) { return s.alive ? s.alive() : true; });
      if (!l.subs.length || state.tab !== 'worker' || state.workerId !== workerId) return;
      if (x.ok === false) return;
      l.data = x;
      l.subs.forEach(function (s) { s(x); });
      var live_ = function (t) { return t.stage === 'deciding' || t.stage === 'running' || t.selfStage === 'deciding' || t.selfStage === 'running'; };
      var moving = x.threads.some(function (t) { return live_(t) || (t.followUps || []).some(live_); });
      l.timer = setTimeout(function () { liveFetch(workerId); }, moving ? 3000 : 20000);
    }, function () { if (live === l) l.timer = setTimeout(function () { liveFetch(workerId); }, 10000); });
  }

  function secs(ms) {
    var s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return s + ' s';
    var m = Math.round(s / 60);
    if (m < 90) return m + ' min';
    var hr = Math.round(m / 60);
    return hr < 48 ? hr + 'h' : Math.round(hr / 24) + ' days';
  }
  function clock(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }

  /// A lifecycle, left to right: what's done, what's happening, what's next.
  function segs(steps) {
    return h('ol', { class: 'segs', 'aria-label': 'Progress' }, steps.map(function (s) {
      var mark = s.state === 'done' ? '✓ ' : s.state === 'failed' ? '✕ ' : '';
      return h('li', { class: s.state }, h('span', { class: 'bar' }), h('span', { class: 'l', text: mark + s.label }),
        h('span', { class: 's', text: s.detail ? (s.at ? clock(s.at) + ' · ' : '') + s.detail : s.at ? clock(s.at) : s.state === 'now' ? 'now' : s.state === 'need' ? 'waiting on you' : '' }));
    }));
  }

  var STAGE_BADGE = {
    deciding: ['working', 'Deciding'], running: ['working', 'Running'], waiting: ['waiting', 'Needs your OK'], needsYou: ['waiting', 'Needs you'],
    done: ['ok', 'Done'], answered: ['ok', 'Answered'], nothing: ['', 'Nothing to do'], declined: ['', 'Skipped'], failed: ['bad', 'Failed'], stopped: ['bad', 'Stopped']
  };

  /// What set a thread off, as a label.
  function threadSource(t) {
    var me = state.me && t.by === state.me.name;
    if (t.source === 'ask') return me ? 'You asked' : (t.by || 'Someone') + ' asked' + (t.via === 'slack' ? ' in Slack' : '');
    if (t.source === 'trigger') return 'A trigger fired';
    if (t.source === 'runNow') return t.by ? (me ? 'You' : t.by) + ' pressed Run now' : 'Run now';
    if (t.source === 'schedule') return 'Scheduled check';
    if (t.source === 'colleague') return (t.by || 'A colleague') + ' passed this on';
    return 'Run';
  }

  /// The worker's own words in a thread: its answer, or why it chose what it
  /// chose. An answer is the point, so it shows; reasoning behind work that
  /// has its own result folds away.
  function threadReply(t, w) {
    if (!t.reply || !t.reply.text) return null;
    var body = h('div', { class: 't-say' }, avatar(w.id, w.name, 's'),
      h('div', { class: 'stack', style: 'gap:4px;min-width:0' }, linkFiles(md(t.reply.text), w.id, w.name),
        h('span', { class: 'faint', text: w.name + ' · ' + clock(t.reply.at) + (t.reply.tookMs ? ' · took ' + secs(t.reply.tookMs) : '') })));
    var open = t.stage === 'answered' || (t.source === 'ask' && t.stage !== 'done');
    return open ? body : h('details', { class: 't-why' }, h('summary', { text: t.stage === 'nothing' ? 'Why' : 'Why ' + w.name + ' chose this' }), body);
  }

  /// What it proposed, to decide right here.
  function threadProposal(t, w, ctx) {
    var p = t.proposal;
    if (!p) return null;
    var waiting = p.items.filter(function (i) { return i.status === 'waiting'; });
    if (!waiting.length) return null;
    if (!ctx.youManage) return h('p', { class: 'muted', text: 'Waiting for ' + (w.manager || 'its manager') + ' to say yes.' });
    var out = h('div', { 'aria-live': 'polite' });
    var boxes = waiting.map(function (it) {
      var box = h('input', { type: 'checkbox', checked: true, 'aria-label': it.title });
      return { it: it, box: box, row: h('label', { class: 't-item' }, waiting.length > 1 ? box : null,
        h('span', { class: 'stack', style: 'gap:2px;min-width:0' }, h('b', { text: it.title }), it.detail ? h('span', { class: 'faint', text: it.detail }) : null)) };
    });
    var yes = h('button', { class: 'btn go', text: waiting.length === 1 ? 'Run it' : 'Run the ticked' });
    var no = h('button', { class: 'btn', text: 'Not now' });
    var decide = function (approve, skip, button, label) {
      var restore = busy(button, label);
      no.disabled = yes.disabled = true;
      api('POST', '/api/proposals/' + encodeURIComponent(p.batchId), { approve: approve, skip: skip }).then(function (x) {
        restore();
        out.textContent = '';
        if (x.ok === false) { no.disabled = yes.disabled = false; out.appendChild(msg(x)); return; }
        refreshCounts();
        out.appendChild(msg(x, approve.length || approve === 'all' ? 'Starting it now…' : 'Skipped.'));
        livePoke(w.id, 300);
      }, function () { restore(); no.disabled = yes.disabled = false; });
    };
    yes.onclick = function () {
      var picked = boxes.filter(function (b) { return b.box.checked; }).map(function (b) { return b.it.candidateId; });
      var left = boxes.filter(function (b) { return !b.box.checked; }).map(function (b) { return b.it.candidateId; });
      if (!picked.length) { decide([], left, yes, 'Skipping…'); return; }
      decide(left.length ? picked : 'all', left, yes, 'Starting…');
    };
    no.onclick = function () { decide([], waiting.map(function (i) { return i.candidateId; }), no, 'Skipping…'); };
    return h('div', { class: 't-ok' },
      h('div', { class: 'stack', style: 'gap:8px' }, boxes.map(function (b) { return b.row; })),
      h('p', { class: 'faint', text: w.trust === 'probation' ? w.name + ' asks first, so nothing starts until you say.' : 'This needs your OK before it starts.' }),
      h('div', { class: 'row' }, yes, no), out);
  }

  /// The thread's lifecycle with its one running run's stages in place of
  /// "Running · step 1 of 2": one rail, not two.
  function mergedRail(t) {
    var r = t.runs.length === 1 && (t.runs[0].state === 'working' || t.runs[0].state === 'paused') ? t.runs[0] : null;
    if (!r || !r.steps || r.steps.length < 2) return t.progress;
    return [].concat.apply([], t.progress.map(function (p) {
      if (p.state !== 'now') return [p];
      return r.steps.map(function (s) {
        return { label: s.label, state: s.state, detail: s.state === 'done' && s.tookMs ? secs(s.tookMs) : s.state === 'now' ? 'now · ' + secs(Date.now() - r.startedAt) : '' };
      });
    }));
  }

  /// Keeps an element saying how long since \x60from\x60, every second, while
  /// it's on the page.
  function ticking(el, from, suffix) {
    var put = function () { el.textContent = secs(Date.now() - from) + (suffix || ''); };
    put();
    var id = setInterval(function () { if (!el.isConnected) clearInterval(id); else put(); }, 1000);
    return el;
  }

  /// A thread opened in full: its steps as one timeline, top to bottom, with
  /// what belongs to each inside it (the worker's plan under its decision,
  /// the buttons under the OK it waits for, the live activity under the step
  /// running, a failure's reason under the step that failed), and how far
  /// along it is above. The rail in one place, not a bar and a feed apart.
  function threadTimeline(t, w, ctx) {
    var steps = mergedRail(t);
    // A run that failed or was stopped: its own steps, to the one it stopped
    // on, in place of "Ran in 22 min"; the answer it never gave isn't a failure.
    var broke = t.runs.length === 1 && (t.runs[0].state === 'failed' || t.runs[0].state === 'stopped') ? t.runs[0] : null;
    if (broke && broke.steps && broke.steps.length) {
      var lastRun = -1;
      steps.forEach(function (s, i) { if (s.state === 'failed' && i < steps.length - 1) lastRun = i; });
      if (lastRun >= 0) steps = steps.slice(0, lastRun).concat(broke.steps.map(function (s) {
        return { label: s.label, state: s.state === 'next' ? 'skipped' : s.state, detail: s.state === 'done' && s.tookMs ? secs(s.tookMs) : '' };
      }), steps.slice(lastRun + 1));
    }
    steps = steps.map(function (s, i) { return i === steps.length - 1 && s.state === 'failed' ? { label: s.label, state: 'skipped', detail: '' } : s; });
    var live = t.runs.filter(function (r) { return r.state === 'working' || r.state === 'paused'; })[0];
    var asking = t.runs.filter(function (r) { return r.state === 'question' || r.state === 'approval'; })[0];
    var cur = steps.findIndex(function (s) { return s.state === 'now' || s.state === 'need'; });
    var failedAt = steps.findIndex(function (s) { return s.state === 'failed'; });
    var ended = t.stage === 'done' || t.stage === 'answered' || t.stage === 'declined' || t.stage === 'nothing';
    // Not reached, after a failure, isn't done.
    var doneN = steps.filter(function (s) { return s.state === 'done' || (s.state === 'skipped' && failedAt < 0); }).length;
    // How far along: done steps whole, the one in hand a sliver, nothing invented.
    var bar = h('div', { class: 'vp-bar', role: 'img', 'aria-label': doneN + ' of ' + steps.length + ' steps done' },
      h('span', { style: 'width:' + (100 * doneN / steps.length) + '%;background:var(--ok)' }),
      cur >= 0 ? h('span', { style: 'width:' + (40 / steps.length) + '%;background:' + (steps[cur].state === 'need' ? 'var(--need)' : 'var(--go)') }) : null,
      failedAt >= 0 ? h('span', { style: 'width:' + (100 / steps.length) + '%;background:var(--bad)' }) : null);
    var lastAt = Math.max.apply(null, [t.at].concat(t.runs.map(function (r) { return r.endedAt || 0; }), t.reply ? [t.reply.at] : []));
    var line = h('div', { class: 'vp-line' },
      cur >= 0 ? h('span', null, h('b', { text: 'Step ' + (cur + 1) + ' of ' + steps.length }), ' · ' + steps[cur].label)
        : failedAt >= 0 ? h('span', null, h('b', { text: 'Stopped at step ' + (failedAt + 1) + ' of ' + steps.length }), ' · ' + steps[failedAt].label)
          : h('span', null, h('b', { text: ended ? 'Finished' : steps.length + ' steps' })),
      cur >= 0 ? ticking(h('span'), t.at, ' so far') : h('span', { text: ended && lastAt > t.at ? 'took ' + secs(lastAt - t.at) : '' }));
    var rows = steps.map(function (s, i) {
      var inside = [];
      if (i === 0 && t.reply) inside.push(threadReply(t, w));
      if (i === 0 && t.stage === 'deciding') inside.push(thinking(t.source === 'ask' ? w.name + ' is working out how to answer' : w.name + ' is reading its job, its journal and what changed'));
      if (s.state === 'need') {
        inside.push(threadProposal(t, w, ctx));
        if (asking) {
          var it = (ctx.waiting || []).filter(function (x) { return x.runId === asking.runId; })[0];
          inside.push(it ? waitingCard(it) : h('p', { class: 'muted', style: 'margin:0', text: 'Waiting on ' + (w.manager || 'its manager') + '.' }));
        }
      }
      if (s.state === 'now' && i > 0 && live) inside.push(liveRunView(live.runId, 'step'));
      if (i === failedAt) {
        var why = t.error || (broke && (broke.error || (broke.state === 'stopped' ? 'It was stopped before it finished.' : '')));
        if (why) inside.push(h('div', { class: 'msg err', text: why }));
        if (broke && broke.runId) inside.push(runFiles(broke.runId, w.name + ' · ' + broke.title));
      }
      var cls = s.state + (i === steps.length - 1 && s.state === 'next' ? ' last' : '');
      var tag = s.state === 'now' ? (i === 0 ? 'Working it out' : 'Running') : s.state === 'need' ? 'Needs you' : s.state === 'failed' ? (broke && broke.state === 'stopped' ? 'Stopped' : 'Failed') : s.state === 'skipped' && failedAt < 0 ? 'Skipped' : '';
      var sub = s.state === 'next' ? (i === steps.length - 1 ? 'Arrives here when it’s done' + (t.via === 'slack' ? ', and in Slack' : '') : 'Up next')
        : s.state === 'skipped' && failedAt >= 0 ? (i === steps.length - 1 ? 'Not produced' : 'Not reached') : '';
      var time = s.state === 'now' && i > 0 && live ? ticking(h('span'), live.startedAt) : s.state === 'done' ? (s.detail && !/^now/.test(s.detail) ? s.detail : s.at ? clock(s.at) : '') : '';
      return h('li', { class: 'vstep ' + cls },
        h('div', { class: 'vs-rail' }, h('span', { class: 'vs-dot', 'aria-hidden': 'true' }, s.state === 'done' ? icon('check', 12) : s.state === 'failed' ? '×' : null), h('span', { class: 'vs-link' })),
        h('div', { class: 'vs-body' }, h('div', { class: 'vs-name' }, h('b', { text: s.label }), tag ? h('span', { class: 'vs-tag', text: tag }) : null, sub ? h('span', { class: 'vs-sub', text: sub }) : null), inside),
        h('span', { class: 'vs-time' }, time));
    });
    return h('div', { class: 'stack', style: 'gap:0' }, h('div', { class: 'vprog' }, line, bar), h('ol', { class: 'vsteps', 'aria-label': 'Steps' }, rows));
  }

  /// Stop a run that's going, after a yes: what it wrote stays.
  function stopRunButton(runId, w) {
    var b = h('button', { class: 'btn small quiet', text: 'Stop' });
    b.onclick = function () {
      if (!window.confirm('Stop ' + w.name + '’s run? What it has written so far stays; nothing it was about to do happens.')) return;
      var restore = busy(b, 'Stopping…');
      api('POST', '/api/runs/' + encodeURIComponent(runId) + '/stop', {}).then(function (x) {
        restore();
        if (x.ok === false) { alert(x.error); return; }
        livePoke(w.id, 0);
      });
    };
    return b;
  }

  /// One run inside a thread: where it is, or what it found.
  function threadRun(r, t, w, ctx) {
    var head = h('div', { class: 't-top' }, h('b', { text: r.title }),
      h('span', { class: 'faint', text: (r.endedAt ? 'took ' + secs(r.endedAt - r.startedAt) : r.state === 'working' ? secs(Date.now() - r.startedAt) + ' in' : 'started ' + ago(r.startedAt)) + (r.costUSD ? ' · ' + money(r.costUSD) : '') }));
    // Opened on the right with its stages on the rail: the rail and "What
    // it's doing" say it all.
    if ((r.state === 'working' || r.state === 'paused') && ctx.merge && t.runs.length === 1 && r.steps && r.steps.length > 1) return null;
    if (r.state === 'working' || r.state === 'paused') {
      if (ctx.youManage) head.appendChild(stopRunButton(r.runId, w));
      head.appendChild(h('button', { class: 'btn small', text: 'Watch', onclick: function () { watchRun(r.runId, w.name + ' · ' + r.title); } }));
      return h('div', { class: 't-run' }, head, segs(r.steps.map(function (s) { return { label: s.label, state: s.state, detail: s.tookMs && s.state === 'done' ? secs(s.tookMs) : '' }; })));
    }
    if (r.state === 'question' || r.state === 'approval') {
      var it = (ctx.waiting || []).filter(function (x) { return x.runId === r.runId; })[0];
      return h('div', { class: 't-run' }, head, it ? waitingCard(it) : h('p', { class: 'muted', text: 'Waiting on ' + (w.manager || 'its manager') + '.' }));
    }
    if (r.state === 'interrupted') {
      var carry = h('button', { class: 'btn go small', text: 'Carry on now' });
      carry.onclick = function () {
        var restore = busy(carry, 'Starting…');
        api('POST', '/api/runs/' + encodeURIComponent(r.runId) + '/resume', {}).then(function (x) { restore(); if (x.ok === false) carry.after(msg(x)); else livePoke(w.id, 300); });
      };
      return h('div', { class: 't-run' }, head,
        h('p', { class: 'muted', text: 'Stopped at step ' + r.step.index + ' of ' + r.step.total + ' (' + r.step.name.toLowerCase() + ') when the server restarted. Nothing was lost.' }),
        ctx.youManage ? h('div', null, carry) : null);
    }
    var slot = h('div');
    var isMd = r.result && /\.(md|markdown|txt)$/i.test(r.result.name);
    var ok = r.state === 'done';
    return h('div', { class: 't-run' },
      t.runs.length > 1 ? head : null,
      ok ? h('div', { class: 't-answer' }, h('span', { class: 't-kind', text: 'What it found' }),
          r.summary ? h('p', { style: 'margin:0', text: r.summary }) : h('p', { class: 'muted', style: 'margin:0', text: r.result ? 'It wrote ' + r.result.name + '.' : 'It finished without writing a file.' }))
        : h('div', { class: 'msg err', text: r.state === 'stopped' ? 'It was stopped before it finished.' : 'It failed' + (r.error ? ': ' + r.error : '.') }),
      r.runId && r.state !== 'stopped' ? runFiles(r.runId, w.name + ' · ' + r.title) : null,
      h('div', { class: 't-top' },
        r.result ? h('details', { class: 't-report' }, h('summary', null, 'Read the full report · ', h('code', { text: r.result.name })),
          h('div', { class: 'wc-out' }, isMd ? md(r.result.body) : h('pre', { text: r.result.body }))) : h('span'),
        ok && r.entryId ? h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Was this useful?' }), rateButtons({ entryId: r.entryId, workerName: w.name, rating: r.rating }, slot)) : null),
      slot);
  }

  /// What a thread (or one reply in it) came to: where it stands, its
  /// lifecycle, the worker's words, what it proposed and its runs.
  function threadBody(t, w, ctx, isReply) {
    var asked = t.source === 'ask' || t.source === 'trigger' || t.source === 'colleague';
    var ended = t.stage === 'done' || t.stage === 'answered';
    var hasWork = (t.proposal && t.proposal.items.length) || t.runs.length;
    // Opened in full: one timeline holds the steps and what belongs to each;
    // what finished runs found follows it.
    if (ctx.merge && t.progress && t.progress.length > 1 && (!isReply || hasWork)) {
      return [
        threadTimeline(t, w, ctx),
        // A broken run's reason and files are in its step already.
        t.runs.filter(function (r) { return r.state === 'done' || r.state === 'interrupted' || ((r.state === 'failed' || r.state === 'stopped') && t.runs.length > 1); }).map(function (r) { return threadRun(r, t, w, ctx); }),
        t.stage === 'nothing' && t.note && t.note !== t.headline ? h('p', { class: 'muted', text: t.note }) : null
      ];
    }
    return [
      asked && !ended && t.stage !== 'deciding' && !(isReply && t.stage === 'nothing') && !(ctx.merge && mergedRail(t) !== t.progress) ? h('p', { class: 't-head', text: t.headline }) : null,
      t.progress && t.progress.length > 1 && (!isReply || hasWork) ? segs(ctx.merge ? mergedRail(t) : t.progress) : null,
      t.stage === 'deciding' ? h('div', { class: 'stack', style: 'gap:4px' },
        thinking(t.source === 'ask' ? w.name + ' is working out how to answer (' + secs(Date.now() - t.at) + ' so far)' : w.name + ' is reading its job, its journal and what changed (' + secs(Date.now() - t.at) + ' so far)'),
        h('span', { class: 'faint', text: 'Usually under a minute. You can leave this page; it carries on.' })) : null,
      t.stage === 'failed' && t.error ? h('div', { class: 'msg err', text: t.error }) : null,
      threadReply(t, w),
      threadProposal(t, w, ctx),
      t.runs.map(function (r) { return threadRun(r, t, w, ctx); }),
      t.stage === 'nothing' && t.note && t.note !== t.headline ? h('p', { class: 'muted', text: t.note }) : null
    ];
  }

  /// Replies being typed, by thread, so a refresh doesn't eat them.
  var drafts = {};

  /// Reply in the thread: the worker's one-tap answers, and a box for your own.
  function threadComposer(t, w, last) {
    if (!w.enabled || last.stage === 'deciding') return null;
    var out = h('div', { 'aria-live': 'polite' });
    var send = function (text, button) {
      text = (text || '').trim();
      if (!text) return;
      var restore = busy(button, 'Sending…');
      api('POST', '/api/ask', { worker: w.id, message: text, replyTo: t.id }).then(function (r) {
        restore();
        if (r.ok === false) { out.textContent = ''; out.appendChild(msg(r)); return; }
        delete drafts[t.id];
        livePoke(w.id, 150);
      }, function () { restore(); });
    };
    var box = h('textarea', { rows: '2', placeholder: 'Reply to ' + w.name + '…', 'aria-label': 'Reply in this thread' });
    box.value = drafts[t.id] || '';
    box.oninput = function () { drafts[t.id] = box.value; };
    var go_ = h('button', { class: 'btn go small', text: 'Send' });
    go_.onclick = function () { send(box.value, go_); };
    box.onkeydown = function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(box.value, go_); };
    var form = h('div', { class: 't-compose', hidden: !drafts[t.id] }, box, h('div', { class: 'row', style: 'justify-content:flex-end' }, go_));
    var open = h('button', { class: 'linkish', style: 'color:var(--go);font-size:13.5px', text: 'Reply', onclick: function () { form.hidden = false; open.hidden = true; box.focus(); } });
    if (drafts[t.id]) open.hidden = true;
    var choices = (last.choices || []).map(function (c) {
      var b = h('button', { class: 'chip', style: 'min-height:34px;font-size:13px', text: c });
      b.onclick = function () { send(c, b); };
      return b;
    });
    return h('div', { class: 't-replybar' },
      h('div', { class: 'row', style: 'gap:8px' }, choices, open), form, out);
  }

  function threadCard(t, w, ctx) {
    var badge = STAGE_BADGE[t.stage] || ['', t.stage];
    var cls = t.stage === 'deciding' || t.stage === 'running' ? ' live' : t.stage === 'waiting' || t.stage === 'needsYou' ? ' need' : t.stage === 'failed' || t.stage === 'stopped' ? ' bad' : '';
    var own = t.followUps ? Object.assign({}, t, { stage: t.selfStage, headline: t.selfHeadline }) : t;
    var asked = t.source === 'ask' || t.source === 'trigger' || t.source === 'colleague';
    // A finished thread's result says what it found; its title says what it was.
    var ended = own.stage === 'done' || own.stage === 'answered';
    var title = asked ? t.prompt : ended && t.runs.length ? t.runs[0].title + (t.runs.length > 1 ? ' and ' + plural(t.runs.length - 1, 'more', 'more') : '') : own.headline;
    var follow = t.followUps || [];
    var me = state.me && state.me.name;
    return h('article', { class: 'thread' + cls, id: 'thread-' + t.id, 'data-at': String(t.at) },
      h('div', { class: 't-main' },
        h('div', { class: 't-top' },
          h('div', { class: 't-src' }, h('span', { class: 't-kind', text: threadSource(t) }), h('span', { class: 't-prompt', text: title })),
          h('span', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, h('span', { class: 'badge ' + badge[0], text: badge[1] }), h('span', { class: 'faint', text: clock(t.at) + (t.costUSD ? ' · ' + money(t.costUSD) : '') }))),
        threadBody(own, w, ctx, false),
        follow.map(function (f) {
          return h('div', { class: 't-turn', id: 'thread-' + f.id },
            h('div', { class: 'stack', style: 'gap:4px;align-items:flex-end' },
              h('div', { class: 'bubble-me', text: f.prompt }),
              h('span', { class: 'faint', text: (f.by && f.by !== me ? f.by : 'You') + ' · ' + clock(f.at) })),
            threadBody(f, w, ctx, true));
        }),
        threadComposer(t, w, follow.length ? follow[follow.length - 1] : own)));
  }

  /// A brief, short enough for a line under a title. A process stage's brief
  /// carries everything earlier stages produced: its original request and
  /// which stage it is are what a person wants there.
  function briefShort(brief) {
    var b = String(brief || '');
    var m = /\nThe original request, from [^:\n]+:\n([\s\S]*?)(?=\n\nIt was sent back|\n\nThe code so far|\n\nThis is run|\n\nWhat earlier stages produced|$)/.exec(b);
    var text = (m ? m[1] : b).replace(/\s+/g, ' ').trim();
    var st = /^This is stage[ ](\d+)[ ]of[ ](\d+),[ ]"([^"]+)",[ ]in[ ]the[ ](.+?)[ ]process/.exec(b);
    return { text: text.length > 220 ? text.slice(0, 219).trim() + '…' : text, stage: st ? 'Stage ' + st[1] + ' of ' + st[2] + ' (' + st[3] + ') of ' + st[4] : '', long: b.length > 260 };
  }

  /// Slack's link markup, as text: older requests were kept with it.
  /// A worker's place, as a person would say it.
  function placeText(p) {
    if (!p) return 'No repo: it can’t change code';
    if (p.kind === 'workspace') return p.name + (p.repos && p.repos.length ? ' (' + p.repos.join(', ') + ')' : '');
    return (p.kind === 'repo' ? 'Repo ' : 'Folder ') + p.name;
  }
  function plainSlack(s) { return String(s || '').replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2').replace(/<((?:https?|mailto):[^>]+)>/g, '$1'); }

  /// Set by the bar above the tabs: hides it while the thread it tells of is
  /// the one open on the right, which says the same.
  var nowBarSync = null;

  /// The bar above the tabs: what it's doing this moment, in one sentence,
  /// with the run's steps when there is one. Hidden when it's doing nothing.
  function nowBar(w) {
    var box = h('div', { class: 'nowslot' });
    var shown = '';
    var current = null;
    var sync = function () {
      var open = (state.workerTab || 'talk') === 'talk' && state.wlSel && state.wlSel[w.id];
      box.hidden = !!(current && open && open === current.threadId);
    };
    nowBarSync = sync;
    liveSubscribe(w.id, Object.assign(function (x) {
      var n = x.now;
      current = n;
      sync();
      var key = n ? JSON.stringify(n) : '';
      if (key === shown) return;
      shown = key;
      box.textContent = '';
      // Keep the header's badge in step with what's happening.
      var need = x.threads.filter(function (t) { return t.stage === 'waiting' || t.stage === 'needsYou'; }).length;
      var moving = x.threads.some(function (t) { return t.stage === 'running' || t.stage === 'deciding'; });
      var badge = document.querySelector('.page-head .badge:not([class*="t-"])');
      if (badge) badge.replaceWith(workerBadge(Object.assign({}, w, { waiting: need, state: moving ? 'working' : w.state === 'working' ? 'idle' : w.state })));
      if (!n) return;
      var waitingOnYou = /waiting/.test(n.sentence) && !moving;
      var go_ = h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: state.workerTab && state.workerTab !== 'talk' ? 'Open it in Conversation' : 'Show me', onclick: function () {
        var jump = function () { var el = document.getElementById('thread-' + n.threadId); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 1600); } };
        if ((state.workerTab || 'talk') !== 'talk') { state.workerTab = 'talk'; render(); setTimeout(jump, 600); } else jump();
      } });
      append(box, h('section', { class: 'nowbar' + (waitingOnYou ? ' need' : ''), 'aria-live': 'polite', 'aria-label': 'What ' + w.name + ' is doing now' },
        h('div', { class: 'line' },
          h('div', { class: 'say' }, h('span', { class: 'livedot' + (waitingOnYou ? ' need' : '') }), h('span', { text: n.sentence })),
          h('span', { class: 'row', style: 'gap:12px;flex-wrap:nowrap' },
            h('span', { class: 'faint', text: [n.since ? (n.run && n.run.state !== 'working' ? 'started ' + ago(n.since) : secs(Date.now() - n.since) + ' in') : '', n.costUSD ? money(n.costUSD) + ' so far' : ''].filter(Boolean).join(' · ') }), go_)),
        n.run && n.run.steps.length > 1 ? segs(n.run.steps.map(function (s) { return { label: s.label, state: s.state, detail: s.tookMs && s.state === 'done' ? secs(s.tookMs) : '' }; })) : null));
    }, { alive: function () { return box.isConnected; } }));
    return box;
  }

  /// The conversation's threads, newest first under a heading per day. A
  /// thread is redrawn only when it changes, so an open report or a half-typed
  /// answer survives the refresh. Runs of "nothing to do" fold into one line.
  function threadsFeed(w) {
    var list = h('div', { class: 'stack', style: 'gap:14px' });
    var foot = h('div', { class: 'more-row' });
    var drawn = {};
    var keyOne = function (t) { return [t.stage, t.selfStage, t.headline, t.progress, t.reply && t.reply.text.length, t.choices, t.proposal, t.runs.map(function (r) { return [r.state, r.step.index, r.steps, r.summary, r.rating, r.costUSD && Math.round(r.costUSD * 100)]; })]; };
    var keyOf = function (t) { return JSON.stringify([keyOne(t), (t.followUps || []).map(keyOne), t.stage === 'deciding' || (t.followUps || []).some(function (f) { return f.stage === 'deciding'; }) ? Math.floor(Date.now() / 10000) : 0]); };
    var openQuiet = {};
    var draw = function (x) {
      var ctx = { waiting: x.waiting, youManage: x.youManage };
      var keep = {};
      var nodes = [];
      var lastDay = null;
      var quiet = [];
      var flushQuiet = function () {
        if (!quiet.length) return;
        var group = quiet; quiet = [];
        if (group.length === 1) { nodes.push(group[0].node); return; }
        var id = group[0].t.id;
        var inner = h('div', { class: 'stack', style: 'gap:14px', hidden: !openQuiet[id] }, group.map(function (g) { return g.node; }));
        var toggle = h('button', { class: 'quietrow', 'aria-expanded': openQuiet[id] ? 'true' : 'false' },
          plural(group.length, 'check', 'checks') + ' found nothing to do · latest ' + ago(group[0].t.at) + ' · ', h('span', { style: 'color:var(--go)', text: openQuiet[id] ? 'hide' : 'show' }));
        toggle.onclick = function () { openQuiet[id] = !openQuiet[id]; inner.hidden = !openQuiet[id]; toggle.setAttribute('aria-expanded', openQuiet[id] ? 'true' : 'false'); toggle.lastChild.textContent = openQuiet[id] ? 'hide' : 'show'; };
        nodes.push(h('div', { class: 'stack', style: 'gap:14px' }, toggle, inner));
      };
      x.threads.forEach(function (t) {
        var day = dayLabel(t.lastAt || t.at);
        if (day !== lastDay) { flushQuiet(); nodes.push(h('div', { class: 'dayhead', text: day })); lastDay = day; }
        var k = keyOf(t);
        var node = drawn[t.id] && drawn[t.id].key === k ? drawn[t.id].node : keepPlace(drawn[t.id] && drawn[t.id].node, threadCard(t, w, ctx));
        keep[t.id] = { key: k, node: node };
        if (t.stage === 'nothing' && t.source === 'schedule') quiet.push({ t: t, node: node });
        else { flushQuiet(); nodes.push(node); }
      });
      flushQuiet();
      drawn = keep;
      setChildren(list, nodes.length ? nodes : [h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: 'Nothing between you yet.' }),
        h('p', { text: 'Ask ' + w.name + ' something above, or press Run now. Each question and each check shows up here with what it decided, what it ran and what it found.' }))]);
      foot.textContent = '';
      if (x.nextBefore) {
        var more = h('button', { class: 'btn small', text: 'Show older' });
        more.onclick = function () { var l = liveFor(w.id); l.limit = (l.limit || 20) + 20; busy(more, 'Loading…'); livePoke(w.id, 0); };
        foot.appendChild(more);
      }
    };
    liveSubscribe(w.id, Object.assign(draw, { alive: function () { return list.isConnected; } }));
    return h('div', { class: 'stack', style: 'gap:14px' }, list, foot);
  }

  /// The conversation with a worker: a box to ask it something, then
  /// everything between you, newest first — answers, delivered work and the
  /// questions it asked.
  /// A worker's page, list and detail: everything it has done down the left,
  /// one line each and filterable; the one you pick on the right in full —
  /// what it found, its report, its run live while it works, and replies.
  function conversation(w) {
    var input = h('input', { type: 'text', placeholder: 'Ask ' + w.name + ' something, or give it a task…', 'aria-label': 'Message for ' + w.name, style: 'flex:1;min-width:0;border:0;outline:none;background:transparent;font:inherit;min-height:36px' });
    var out = h('div', { 'aria-live': 'polite' });
    var send = h('button', { class: 'btn go small', text: 'Send' });
    var submit = function () {
      var text = input.value.trim();
      if (!text) { input.focus(); return; }
      var restore = busy(send, 'Sending…');
      api('POST', '/api/ask', { worker: w.id, message: text }).then(function (r) {
        restore(); out.textContent = '';
        if (r.ok === false) { out.appendChild(msg(r)); return; }
        input.value = '';
        sel = 'ask:' + r.askId; state.wlSel = state.wlSel || {}; state.wlSel[w.id] = sel;
        livePoke(w.id, 150);
      }, function () { restore(); });
    };
    send.onclick = submit;
    input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };

    state.wlSel = state.wlSel || {};
    var sel = state.wlSel[w.id] || null;
    var filter = state.wlFilter || 'all';
    var me = state.me && state.me.name;
    var data = null;
    var list = h('div', { class: 'wl-list', role: 'listbox', 'aria-label': w.name + '’s work' });
    var detail = h('div', { class: 'wl-detail' });
    var chips = h('div', { class: 'row', role: 'group', 'aria-label': 'Show', style: 'gap:4px' });
    var q = h('input', { type: 'search', placeholder: 'Search its work', 'aria-label': 'Search its work', style: 'width:170px;font-size:13px' });
    var more = h('button', { class: 'wl-more', text: 'Show older' });
    more.onclick = function () { var l = liveFor(w.id); l.limit = (l.limit || 20) + 30; busy(more, 'Loading…'); livePoke(w.id, 0); };

    var titleOf = function (t) {
      // A title, not the whole request: the rest is in the thread.
      if (t.source === 'ask' || t.source === 'trigger' || t.source === 'colleague') { var p = plainSlack(t.prompt); return p.length > 200 ? p.slice(0, 199).trim() + '…' : p; }
      if (t.runs.length) return t.runs[0].title;
      return t.source === 'runNow' ? 'Run now' : 'Scheduled check';
    };
    var whoFor = function (t) {
      if (t.team) return 'For ' + t.team.name;
      if (t.source === 'ask') return t.by && t.by !== me ? t.by + ' asked' : 'You asked';
      if (t.source === 'trigger') return 'A trigger';
      if (t.source === 'runNow') return 'Run now';
      if (t.source === 'schedule') return 'Scheduled';
      if (t.source === 'colleague') return 'From ' + (t.by || 'a colleague');
      return 'Run';
    };
    var DOT = { deciding: 'live', running: 'live', waiting: 'need', needsYou: 'need', done: 'ok', answered: 'ok', failed: 'bad', stopped: 'bad', nothing: 'quiet', declined: 'quiet' };
    var inFilter = function (t) {
      if (filter === 'mine') return t.source === 'ask' && !t.team && (!t.by || t.by === me);
      if (filter === 'team') return !!t.team;
      if (filter === 'scheduled') return t.source === 'schedule' || t.source === 'runNow';
      if (filter === 'needs') return t.stage === 'waiting' || t.stage === 'needsYou';
      return true;
    };
    var matches = function (t) {
      var words = q.value.trim().toLowerCase();
      return !words || (titleOf(t) + ' ' + t.headline + ' ' + (t.team ? t.team.name : '')).toLowerCase().indexOf(words) >= 0;
    };
    var row = function (t) {
      var on = t.id === sel;
      var meta = t.stage === 'running' || t.stage === 'deciding' ? secs(Date.now() - t.at) : t.stage === 'failed' || t.stage === 'stopped' ? (t.stage === 'failed' ? 'Failed' : 'Stopped') : t.stage === 'waiting' || t.stage === 'needsYou' ? 'Needs you' : t.costUSD ? money(t.costUSD) : '';
      var sub = whoFor(t) + ' · ' + (t.stage === 'running' ? 'running' : t.stage === 'deciding' ? 'deciding' : t.headline);
      return h('button', { class: 'wl-row' + (on ? ' on' : '') + (t.stage === 'nothing' || t.stage === 'declined' ? ' quiet' : ''), role: 'option', 'aria-selected': on ? 'true' : 'false', onclick: function () { sel = t.id; state.wlSel[w.id] = sel; drawList(); drawDetail(true); } },
        h('span', { class: 'wl-dot ' + (DOT[t.stage] || '') }),
        h('span', { class: 'wl-title', text: titleOf(t) }),
        h('span', { class: 'wl-meta' + (t.stage === 'failed' || t.stage === 'stopped' ? ' bad' : t.stage === 'waiting' || t.stage === 'needsYou' ? ' need' : ''), text: meta }),
        h('span'),
        h('span', { class: 'wl-sub', text: sub }),
        h('span', { class: 'wl-meta', text: dayLabel(t.lastAt || t.at) === 'Today' ? clock(t.lastAt || t.at) : new Date(t.lastAt || t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }));
    };
    var drawList = function () {
      if (!data) return;
      var counts = { all: data.threads.length, needs: 0, mine: 0, team: 0, scheduled: 0 };
      data.threads.forEach(function (t) {
        if (t.stage === 'waiting' || t.stage === 'needsYou') counts.needs++;
        if (t.source === 'ask' && !t.team && (!t.by || t.by === me)) counts.mine++;
        if (t.team) counts.team++;
        if (t.source === 'schedule' || t.source === 'runNow') counts.scheduled++;
      });
      chips.replaceChildren.apply(chips, [['all', 'All'], ['needs', 'Needs you'], ['mine', 'Asked by me'], ['team', 'Team work'], ['scheduled', 'Scheduled']].filter(function (c) { return c[0] === 'all' || counts[c[0]]; }).map(function (c) {
        return h('button', { class: 'chip small', 'aria-pressed': filter === c[0] ? 'true' : 'false', text: c[1] + ' · ' + counts[c[0]], onclick: function () { filter = c[0]; state.wlFilter = c[0]; drawList(); } });
      }));
      var shown = data.threads.filter(function (t) { return inFilter(t) && matches(t); });
      var keepScroll = list.scrollTop;
      var nodes = [], lastDay = null;
      shown.forEach(function (t) {
        var day = dayLabel(t.lastAt || t.at);
        if (day !== lastDay) { nodes.push(h('div', { class: 'wl-day', text: day })); lastDay = day; }
        nodes.push(row(t));
      });
      if (!nodes.length) nodes.push(h('p', { class: 'muted', style: 'padding:24px 16px;text-align:center', text: data.threads.length ? 'Nothing matches.' : 'Nothing yet. Ask ' + w.name + ' something above, or press Run now.' }));
      if (data.nextBefore) nodes.push(more);
      list.replaceChildren.apply(list, nodes);
      list.scrollTop = keepScroll;
    };
    var detailKey = '';
    var drawDetail = function (force) {
      if (!data) return;
      var t = data.threads.filter(function (x) { return x.id === sel; })[0] || data.threads[0];
      if (!t) { detail.replaceChildren(h('div', { class: 'wl-empty muted', text: 'Pick something on the left to see it in full.' })); return; }
      if (!sel) { sel = t.id; state.wlSel[w.id] = sel; }
      var key = JSON.stringify([t.id, t.stage, t.selfStage, t.headline, t.progress, t.reply && t.reply.text.length, t.choices, t.proposal, (t.followUps || []).length, t.runs.map(function (r) { return [r.state, r.step.index, r.summary, r.rating]; })]);
      if (!force && key === detailKey) return;
      detailKey = key;
      var ctx = { waiting: data.waiting, youManage: data.youManage, merge: true };
      var liveRun = t.runs.filter(function (r) { return r.state === 'working' || r.state === 'paused'; })[0];
      // One run: its title says what the work is; what was asked sits under it.
      var one = t.runs.length === 1 ? t.runs[0] : null;
      var asked = t.source === 'ask' || t.source === 'trigger' || t.source === 'colleague';
      var heading = one ? one.title : titleOf(t);
      var ask = asked && one && plainSlack(t.prompt) !== heading ? plainSlack(t.prompt) : '';
      var fresh = h('div', { class: 'wl-detail-in' },
        h('div', { class: 'wl-detail-head' },
          h('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' },
            h('span', { class: 'row', style: 'gap:8px;flex:1;min-width:0;font-size:12.5px' },
              h('span', { class: 'badge ' + (STAGE_BADGE[t.stage] || [''])[0], text: (STAGE_BADGE[t.stage] || ['', t.stage])[1] }),
              h('span', { class: 'faint' }, t.team ? ['For ', h('button', { class: 'linkish', style: 'color:var(--go);font-size:12.5px', text: t.team.name, onclick: function () { go('team', { teamId: t.team.id }); } })] : whoFor(t), ' · ' + when(t.at) + (t.costUSD ? ' · ' + money(t.costUSD) : ''))),
            liveRun && data.youManage ? stopRunButton(liveRun.runId, w) : null,
            liveRun ? h('button', { class: 'btn small', text: 'Watch live', onclick: function () { watchRun(liveRun.runId, w.name + ' · ' + liveRun.title); } }) : null),
          h('h2', { class: 'wl-detail-title', text: heading }),
          ask ? h('p', { class: 'wl-detail-ask', text: '“' + (ask.length > 300 ? ask.slice(0, 299).trim() + '…' : ask) + '”' }) : null),
        // The live activity sits inside the timeline's running step.
        h('div', { class: 'wl-detail-body' }, threadCard(t, w, ctx),
          liveRun && !(t.progress && t.progress.length > 1) ? h('section', { class: 'stack', style: 'gap:8px;margin-top:14px' }, h('div', { class: 't-kind', text: 'What it’s doing' }), liveRunView(liveRun.runId, true)) : null),
        h('div', { class: 'wl-detail-foot' },
          t.team ? h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Open the team task', onclick: function () { go('team', { teamId: t.team.id }); } }) : null));
      detail.replaceChildren(keepPlace(detail.firstChild, fresh));
      if (nowBarSync) nowBarSync();
    };
    q.oninput = drawList;
    liveSubscribe(w.id, Object.assign(function (x) { data = x; drawList(); drawDetail(false); }, { alive: function () { return list.isConnected; } }));
    return h('section', { class: 'stack', style: 'gap:12px', 'aria-label': w.name + '’s work' },
      w.enabled ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'wl-ask' }, input, send), out)
        : h('p', { class: 'muted', text: w.name + ' is paused. Resume it to ask it things.' }),
      h('div', { class: 'wl' },
        h('div', { class: 'wl-left' }, h('div', { class: 'wl-tools' }, chips, q), list),
        detail));
  }

  /// Every way to reach a worker or a team, with its own name filled in and
  /// a copy button on each: here, Slack, Claude (MCP) and a script.
  function reachView(kind, name, who) {
    var base = location.origin;
    var copyBlock = function (text) {
      var b = h('button', { class: 'btn small', text: 'Copy' });
      b.onclick = function () { try { navigator.clipboard.writeText(text).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1500); }); } catch (e) {} };
      return h('div', { class: 'reach-code' }, h('pre', { text: text }), b);
    };
    var lower = name.toLowerCase();
    var way = function (title, sub, blocks, extra) {
      return h('section', { class: 'panel pad stack', style: 'gap:10px' }, h('h2', { class: 'section-title', text: title }), sub ? h('p', { class: 'faint', text: sub }) : null, blocks.map(copyBlock), extra || null);
    };
    var isWorker = kind === 'worker';
    return h('div', { class: 'stack', style: 'gap:16px' },
      h('p', { class: 'muted', text: isWorker
        ? (who ? who + ' can ask ' + name + ' things.' : 'Anyone who can see ' + name + ' can ask it things.') + ' However you ask, the answer and any work it starts land on its Conversation tab too.'
        : 'Anyone who manages someone on ' + name + ' can give it a task. Its questions and its plan come back to whoever asked, here and in Slack.' }),
      way('In Slack', 'If your admin connected Slack. Mention the app anywhere, DM it, or use the slash command.', isWorker
        ? ['@overcli ' + name + ', what changed on the competitor’s pricing page this week?', '/worker ' + lower + ' ask what changed on the competitor’s pricing page this week?']
        : ['/team ' + name + ': what is the best thing on our roadmap?'],
        h('p', { class: 'faint', style: 'font-size:13px', text: isWorker ? 'Name it and it takes the request; screenshots and the thread come along. Without a name, whoever fits best picks it up.' : 'The coordinator answers in the thread with its questions, then its plan for you to approve.' })),
      way('From Claude', 'Claude Code, Claude Desktop or Codex, once connected to your org on the Slack & Claude page. Then just say it:', [isWorker ? 'Ask ' + name + ' what changed on the competitor’s pricing page this week.' : 'Give ' + name + ' the task: what is the best thing on our roadmap?'],
        h('button', { class: 'linkish', style: 'color:var(--go);font-size:13.5px;align-self:flex-start', text: 'Connect Claude →', onclick: function () { go('connect'); } })),
      way('From a script', 'With a key from the Slack & Claude page. It answers at once with an id; the answer lands when it’s ready.', isWorker
        ? ['curl -s ' + base + '/api/ask \\\n  -H "Authorization: Bearer $OVERCLI_ORG_TOKEN" -H "Content-Type: application/json" \\\n  -d \'' + JSON.stringify({ worker: name, message: 'What changed this week?' }) + '\'', 'curl -s ' + base + '/api/asks/<id> -H "Authorization: Bearer $OVERCLI_ORG_TOKEN"']
        : ['curl -s ' + base + '/api/teams/brief \\\n  -H "Authorization: Bearer $OVERCLI_ORG_TOKEN" -H "Content-Type: application/json" \\\n  -d \'' + JSON.stringify({ team: name, text: 'What is the best thing on our roadmap?' }) + '\'']));
  }

  function viewWorker() {
    return Promise.all([api('GET', '/api/workers/' + encodeURIComponent(state.workerId) + '/detail'), api('GET', '/api/workers'),
      state.me.admin ? api('GET', '/api/admin/people') : Promise.resolve({ ok: false }), api('GET', '/api/repos').catch(function () { return { ok: false }; })]).then(function (r) {
      var d = r[0], all = r[1], ppl = r[2], places = r[3] && r[3].ok !== false ? r[3] : { repos: [], workspaces: [] };
      if (d.ok === false) return [msg(d)];
      var w = d.worker;
      var out = h('div');
      var setTrust = function (level) {
        api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/trust', { trust: level }).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else render(); });
      };
      var rd = d.readiness;
      var RUNG = { probation: 'Asks first', trusted: 'Trusted', autonomous: 'On its own' };
      var explain = rd.level === 'probation' ? 'It proposes each run’s work and asks before anything leaves the server. ' : rd.level === 'trusted' ? 'It starts its own runs, and still asks before anything that changes something outside the server: a ticket, a message, a push. ' : 'It starts its own work and acts outside the server without asking. ';
      var trustCard = card('trust', 'How much it does alone', null, [
        h('ol', { class: 'rungs', 'aria-label': 'Trust levels' }, ['probation', 'trusted', 'autonomous'].map(function (lvl) {
          var at = ['probation', 'trusted', 'autonomous'];
          return h('li', { 'data-l': lvl, class: lvl === rd.level ? 'on' : at.indexOf(lvl) < at.indexOf(rd.level) ? 'past' : lvl === rd.readyFor ? 'next' : '', 'aria-current': lvl === rd.level ? 'step' : null },
            RUNG[lvl], lvl === rd.readyFor ? h('span', { class: 'faint', text: ' · ready' }) : null);
        })),
        h('p', { style: 'font-size:13.5px', text: explain }, h('span', { class: 'muted', text: rd.reason })),
        // Its manager's call, whatever its record says: the record only
        // says when it's earned it. Autonomy stays an admin's call.
        (function () {
          if (!w.youManage) return null;
          var up = rd.level === 'probation' ? 'trusted' : rd.level === 'trusted' && state.me.admin ? 'autonomous' : null;
          var earned = up && rd.readyFor === up;
          return h('div', { class: 'stack', style: 'gap:6px' },
            h('div', { class: 'row' },
              up ? h('button', { class: 'btn ' + (earned ? 'go' : '') + ' small', text: up === 'trusted' ? 'Trust it to start its own work' : 'Let it act on its own', onclick: function () { setTrust(up); } }) : null,
              rd.level !== 'probation' ? h('button', { class: 'btn quiet small', text: 'Back to asks first', onclick: function () { setTrust('probation'); } }) : null),
            up && !earned ? h('span', { class: 'faint', style: 'font-size:12.5px', text: up === 'trusted'
              ? 'Its record doesn’t show it yet, but it’s your call. Trusted, it starts its own runs and still asks before anything that changes something outside the server.'
              : 'On its own, it acts outside the server without asking. Only for work you’d never want to check first.' }) : null);
        })(),
        out]);

      var settings = null;
      if (w.youManage) {
        var reports = h('select', { 'aria-label': 'Reports to' }, h('option', { value: '', text: 'Nobody, it’s at the top' }),
          all.filter(function (x) { return x.id !== w.id; }).map(function (x) { return h('option', { value: x.id, text: x.name, selected: !!(w.reportsTo && w.reportsTo.id === x.id) }); }));
        var vis = h('select', { 'aria-label': 'Who may ask it' }, ['private', 'team', 'org'].map(function (v) { return h('option', { value: v, text: VIS[v], selected: w.visibility === v }); }));
        var budget = h('input', { type: 'number', min: '1', step: '1', value: String(w.budgetUSDPerMonth), 'aria-label': 'Monthly budget' });
        var sched = scheduleEditor(w.cadence);
        var saved = h('div');
        // Where it works: one repo or one workspace of repos. Moving it swaps
        // the flow that ends in pushed branches for the new place's.
        var here = w.place && w.place.kind !== 'folder' ? w.place.name : '';
        var where = places.repos.length || places.workspaces.length ? h('select', { 'aria-label': 'Where it works' },
          !here ? h('option', { value: '', text: w.place ? 'Folder: ' + w.place.name : 'Nowhere yet: it can’t change code', selected: true }) : null,
          places.workspaces.map(function (x) { return h('option', { value: x.name, text: 'Workspace: ' + x.name + ' (' + x.repos.join(', ') + ')', selected: x.name === here }); }),
          places.repos.map(function (x) { return h('option', { value: x.name, text: 'Repo: ' + x.name, selected: x.name === here }); })) : null;
        // Handing a worker to someone else is an admin's call.
        var mgr = null;
        if (state.me.admin && ppl.ok !== false) {
          var candidates = ppl.people.filter(function (p) { return p.slackUserId; });
          mgr = h('select', { 'aria-label': 'Manager' },
            h('option', { value: '', text: w.managerSlackUserId ? 'No manager of its own' : !w.manager ? 'No manager' : w.managerInherited ? w.manager + ' (through its boss)' : w.manager + ' (not linked to Slack)', selected: !w.managerSlackUserId }),
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
          var move = where && where.value && where.value !== here
            ? api('POST', '/api/repos/' + encodeURIComponent(where.value) + '/workers', { worker: w.id })
            : Promise.resolve({ ok: true });
          move.then(function (m) {
            if (m.ok === false) { restore(); saved.textContent = ''; saved.appendChild(msg(m)); return; }
            return api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: patch })
              .then(function (x) { restore(); saved.textContent = ''; saved.appendChild(msg(x, 'Saved. It applies from its next run.')); if (x.ok !== false && where && where.value !== here) setTimeout(render, 800); });
          });
        };
        settings = h('div', { class: 'stack', style: 'gap:16px' },
          group('Picture', 'Its face here and on what it posts in Slack. Pick one, or use a link to your own image.', [picturePicker(w, function (url) { return api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { avatarUrl: url } }); },
            function () { return api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/picture/pick', {}); })]),
          group('When it runs', 'On its own schedule, or only when someone asks.', [sched.node]),
          group('Who it answers to', 'Its questions and approvals go here, climbing the chain if its boss can’t answer.', [
            h('div', { class: 'grid2' }, mgr ? h('label', { class: 'field' }, 'Manager', mgr) : h('div', { class: 'field' }, h('span', { text: 'Manager' }), h('span', { style: 'color:var(--ink)', text: w.manager || 'Nobody yet' })),
              h('label', { class: 'field' }, 'Reports to (another worker)', reports))]),
          group('Who can ask it', 'Anyone who can ask it can learn what its tools can reach.', [h('div', { style: 'max-width:360px' }, vis)]),
          group('Where it works', 'The repo, or workspace of repos, it reads and changes. Its changes arrive as branches to open pull requests from.', [
            where ? h('div', { style: 'max-width:480px' }, where)
              : h('p', { class: 'faint', text: (w.place ? placeText(w.place) + '. ' : '') + (state.me.admin ? 'Connect a repo under Setup → Repos to let it change code there.' : 'An admin connects repos under Setup → Repos.') })]),
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
        var box = h('div', { class: 'sec-body', style: 'gap:16px' });
        var out = h('div', { 'aria-live': 'polite' });
        var edit = w.youManage ? h('button', { class: 'btn', text: 'Edit the job' }) : null;
        if (edit) edit.onclick = function () {
          edit.hidden = true;
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
        append(box, text);
        return h('div', { class: 'split' }, h('div', { class: 'wide' },
            h('section', { class: 'sec', 'aria-labelledby': 'jobh' }, h('div', { class: 'sec-head' }, h('h2', { id: 'jobh', class: 'label', text: 'The job it was hired for' }), edit), box)),
          h('aside', { class: 'narrow' }, card('learned', 'What it has learned', null, [
            h('p', { class: 'faint', text: 'From your ratings and notes. It reads these alongside its job before every run.' }),
            d.learned.length ? h('ul', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13.5px' }, d.learned.map(function (l) { return h('li', { text: l.note }); }))
              : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Nothing yet.' })])));
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
      var onItsOwn = card('own', 'On its own',
        (d.triggers || []).length || w.youManage ? h('button', { class: 'linkish', text: (d.triggers || []).length ? 'Triggers' : 'Add a trigger', onclick: function () { state.workerTab = 'triggers'; state.triggerOpen = !(d.triggers || []).length; render(); } }) : null, [
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { class: 'faint', style: 'display:inline-flex' }, icon('sun', 15)), h('span', { style: 'font-size:13.5px', text: w.cadence ? w.schedule : 'No schedule: works when asked' })),
        (d.triggers || []).map(function (t) {
          return h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { style: 'display:inline-flex;color:' + (t.enabled ? 'var(--go)' : 'var(--faint)') }, icon('bolt', 15)), h('span', { style: 'font-size:13.5px', text: t.name + (t.enabled ? '' : ' (off)') }));
        }),
        d.value && d.value.handled ? h('p', { class: 'faint', text: plural(d.value.handled, 'event', 'events') + ' handled this month' + (d.value.medianMinutes != null ? ', typically in ' + (d.value.medianMinutes < 1 ? 'under a minute' : Math.round(d.value.medianMinutes) + ' min') : '') + '.' }) : null]);
      var aside = h('aside', { class: 'narrow', 'aria-label': 'Setup' },
        onItsOwn,
        trustCard,
        (w.tools || []).length ? card('tl', 'Tools', null,
          w.tools.map(function (t) { return toolScopeRow(w, t); })) : null,
        card('setup', 'Setup', change ? h('button', { class: 'linkish', text: 'Settings', onclick: change }) : null, h('div', { style: 'padding:2px 18px' },
          row('Runs', w.schedule + (w.nextRunAt ? ' · next ' + when(w.nextRunAt) : '')),
          row('Answers to', (w.manager || 'Nobody yet') + (w.managerInherited ? ' (through its boss)' : '')),
          w.reportsTo ? row('Reports to', w.reportsTo.name) : null,
          row('Who can ask it', VIS[w.visibility]),
          row('Works in', placeText(w.place)),
          h('div', { class: 'setup-row', style: 'flex-direction:column;align-items:stretch;gap:8px' },
            h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { style: 'flex:1' }, h('span', { class: 'k', text: 'Budget' }), h('span', { class: 'v', text: money(w.spentThisMonthUSD) + ' of ' + money(w.budgetUSDPerMonth) + ' this month' })),
              change ? h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Change', onclick: change }) : null),
            h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' }))),
          job), true),
        card('learn', 'What it remembers', null, [
          d.learned.length ? h('ul', { style: 'margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:13.5px' }, d.learned.map(function (l) { return h('li', { text: l.note }); }))
            : h('p', { class: 'muted', style: 'font-size:13.5px', text: 'Nothing from you yet. Answer “Was this useful?” under a result and it reads that before every run.' }),
          h('p', { class: 'faint', text: 'In the last 30 days: ' + plural(d.stats.runs, 'run', 'runs') + (d.stats.failed ? ', ' + d.stats.failed + ' failed' : '') + (d.stats.usefulPct != null ? ', ' + d.stats.usefulPct + '% rated useful' : ', none rated yet') + '.' })]));

      var pause = function (e) {
        busy(e.target, w.enabled ? 'Pausing…' : 'Resuming…');
        api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/paused', { paused: w.enabled }).then(function (x) {
          if (x.ok === false) { var note = document.getElementById('run-note'); if (note) { note.textContent = ''; note.appendChild(msg(x)); } } else render();
        });
      };
      return [h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Workers', onclick: function () { go('workers'); } }), ' / ' + w.name),
            h('div', { class: 'row', style: 'gap:16px;flex-wrap:nowrap' }, avatar(w.id, w.name, 'xl'),
              h('div', { style: 'min-width:0;display:flex;flex-direction:column;gap:6px' },
                h('h1', { class: 'page-title', text: w.name }),
                h('div', { class: 'row', style: 'gap:8px' }, workerBadge(w), w.tagline ? h('span', { class: 'muted', style: 'font-size:13.5px', text: w.tagline }) : null),
                h('div', { class: 'faint', style: 'font-size:13px' },
                  [w.cadence ? w.schedule + (w.nextRunAt ? ' · next ' + when(w.nextRunAt) : '') : 'Works when asked', TRUST_RUNG[w.trust] || w.trust, money(w.spentThisMonthUSD) + ' of ' + money(w.budgetUSDPerMonth) + ' this month', plural((w.tools || []).length, 'tool', 'tools')].join(' · '),
                  w.youManage ? [' · ', h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Settings', onclick: function () { state.workerTab = 'settings'; render(); } })] : null)))),
          h('div', { class: 'page-actions' },
            w.youManage ? h('button', { class: 'btn', text: w.enabled ? 'Pause' : 'Resume', onclick: pause }) : null,
            w.youManage && w.enabled ? h('button', { class: 'btn', text: 'Run now', onclick: function (e) {
              // Starting a run takes a few seconds; say so at once rather
              // than leave the button looking unpressed.
              var restore = busy(e.target, 'Starting…');
              var note = document.getElementById('run-note');
              var badge = document.querySelector('.page-head .badge');
              var was = badge && { cls: badge.className, text: badge.textContent };
              if (badge) { badge.className = 'badge working'; badge.textContent = 'Starting'; }
              if (note) note.replaceChildren(h('div', { class: 'msg ok', role: 'status' }, thinking('Starting ' + w.name + '’s run…')));
              api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/run').then(function (x) {
                restore();
                if (x.ok === false && badge) { badge.className = was.cls; badge.textContent = was.text; }
                else if (badge) badge.textContent = 'Working';
                if (x.ok === false) { if (note) note.replaceChildren(msg(x)); return; }
                if (note) note.textContent = '';
                livePoke(w.id, 0);
              }, function () { restore(); if (badge) { badge.className = was.cls; badge.textContent = was.text; } });
              // Deciding what to do takes up to a minute and the reply waits
              // for it. The server reports it meanwhile, so draw the page
              // from that — and it survives switching tabs.
              setTimeout(function () { if (note) note.textContent = ''; livePoke(w.id, 0); }, 1200);
            } }) : null,
            null)),
        h('div', { id: 'run-note' }),
        nowBar(w),
        missing.length ? h('div', { class: 'banner', role: 'status' },
          h('span', { style: 'color:var(--bad);flex:none' }, icon('alert', 20)),
          h('span', { text: w.name + '’s job needs ' + missing.join(', ') + ', which ' + (missing.length === 1 ? 'isn’t' : 'aren’t') + ' installed on this server — so it works without ' + (missing.length === 1 ? 'it' : 'them') + '.' }),
          state.me.admin ? h('button', { class: 'btn bad', text: 'Install ' + missing[0], onclick: function () { go('setup', { setupTab: 'tools' }); } }) : h('span', { class: 'faint', style: 'flex:none', text: 'Ask an admin to install it.' })) : null,
        h('div', { class: 'tabs', role: 'tablist', 'aria-label': w.name },
          [['talk', 'Conversation'], ['runs', 'Runs'], ['files', 'Files'], ['journal', 'Journal'], ['triggers', 'Triggers' + ((d.triggers || []).length ? ' · ' + d.triggers.length : '')], ['job', 'Job'], ['reach', 'How to reach'], w.youManage ? ['settings', 'Settings'] : null].filter(Boolean).map(function (t) {
            return h('button', { role: 'tab', 'aria-selected': tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.workerTab = t[0]; render(); } });
          })),
        tab === 'reach' ? reachView('worker', w.name, VIS[w.visibility || 'private'])
          : tab === 'runs' ? runsView(w)
          : tab === 'files' ? filesView(w)
          : tab === 'journal' ? journalView(w)
          : tab === 'triggers' ? triggersView(w, d)
          : tab === 'job' ? h('div', { class: 'stack', style: 'gap:16px' }, jobView(), w.youManage ? null : aside)
          : tab === 'settings' && settings ? h('div', { class: 'split' }, h('div', { class: 'wide' }, settings), aside)
          : conversation(w)];
    });
  }

  // ---- teams -----------------------------------------------------------

  // ---- processes -------------------------------------------------------

  /// A process: one item moving through teams and people's decisions. The
  /// list, one process's board, an item's story, and the editor.

  function viewProcesses() {
    return api('GET', '/api/processes').then(function (r) {
      if (r.ok === false) return [msg(r)];
      var list = r.processes || [];
      var intro = 'Work that moves between teams and people: an idea becomes a PR/FAQ, a prototype, a decision, a build, a launch. Each stage is a team or people who decide, and each item carries what earlier stages produced.';
      var action = h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: function () { go('proclib', { libId: null }); } }, icon('library', 16), 'Process library'),
        h('button', { class: 'btn', onclick: fromImageDialog }, icon('image', 16), 'From an image'),
        h('button', { class: 'btn go', onclick: function () { go('processedit', { processId: null }); } }, icon('plus', 16), 'New process'));
      if (!list.length) return [head('Processes', intro, action), emptyState('No processes yet.', 'Start from the library: eleven ways SaaS teams commonly run work across teams, from idea to launch to incident postmortems. Each suggests which of your teams fits each stage.', h('button', { class: 'btn go', text: 'Browse the process library', onclick: function () { go('proclib', { libId: null }); } }))];
      var cards = list.map(function (p) {
        return openCard('tmcard prc', 'Open ' + p.name, function () { go('process', { processId: p.id, processItem: null }); },
          h('div', { style: 'min-width:0' },
            h('span', { class: 'tmname', text: p.name }),
            p.purpose ? h('p', { class: 'tmpurpose', text: p.purpose }) : null),
          h('ol', { class: 'prc-strip', 'aria-label': 'Stages' }, p.stages.map(function (s, i) {
            return h('li', { class: s.kind + (p.byStage[i] ? ' busy' : ''), title: s.name + (p.byStage[i] ? ': ' + p.byStage[i] + ' here' : '') },
              h('span', { class: 'prc-ic', 'aria-hidden': 'true' }, icon(s.kind === 'people' ? 'person' : 'team', 13)),
              h('span', { class: 'prc-sn', text: s.name }),
              p.byStage[i] ? h('span', { class: 'prc-n', text: String(p.byStage[i]) }) : null);
          })),
          h('div', { class: 'tmmeta' }, h('span', { class: 'faint tmstats', text: ['Owned by ' + p.owner.name, plural(p.stages.length, 'stage', 'stages'), plural(p.active, 'item', 'items') + ' in flight'].concat(p.canSteer ? [accessText(p.access)] : []).join(' · ') })),
          p.canStart === false ? null : h('div', { class: 'tmfoot' },
            h('button', { class: 'btn small go', text: 'Put something in', onclick: function (e) { e.stopPropagation(); submitToProcess(p, function (item) { go('process', { processId: p.id, processItem: item.id }); }); } })));
      });
      return [head('Processes', intro, action), h('div', { class: 'tmgrid' }, cards)];
    });
  }

  /// "Put something in": a title and what it is.
  function submitToProcess(p, done) {
    var title = h('input', { type: 'text', maxlength: '200', placeholder: 'e.g. Let customers export reports to CSV', 'aria-label': 'Title' });
    var brief = h('textarea', { rows: '6', placeholder: 'What it is, who wants it and why. Links help.', 'aria-label': 'What it is' });
    var out = h('div');
    var scrim = h('div', { class: 'scrim' });
    var close = function () { scrim.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    scrim.onclick = function (e) { if (e.target === scrim) close(); };
    document.addEventListener('keydown', onKey);
    var send = h('button', { class: 'btn go', text: 'Put it in' });
    send.onclick = function () {
      var restore = busy(send, 'Putting it in…');
      api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/items', { title: title.value, brief: brief.value }).then(function (x) {
        restore();
        if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); return; }
        close(); done(x.item);
      });
    };
    append(scrim, h('div', { class: 'dialog small', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ps-title' },
      h('div', null, h('h2', { id: 'ps-title', text: 'Put something into ' + p.name }), h('p', { class: 'muted', style: 'margin-top:4px', text: 'It starts at ' + p.stages[0].name + '. You hear as it moves, here and in Slack.' })),
      h('label', { class: 'field' }, 'Title', title), h('label', { class: 'field' }, 'What it is', brief), out,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn quiet', text: 'Cancel', onclick: close }), send)));
    document.body.appendChild(scrim);
    setTimeout(function () { title.focus(); }, 0);
  }

  /// "From an image": a picture of a process someone found (a flowchart, a
  /// swimlane, a slide) drafted into one. Drop it, pick it or paste it, say
  /// what to change, and the editor opens with the draft, unsaved.
  var PI_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  function fromImageDialog() {
    var picked = null, closed = false, working = false;
    var out = h('div', { 'aria-live': 'polite' });
    var file = h('input', { type: 'file', accept: PI_TYPES.join(','), style: 'display:none' });
    var drop = h('button', { type: 'button', class: 'pi-drop', 'aria-label': 'Pick a picture of the process' },
      h('span', { class: 'pi-dropic' }, icon('image', 22)),
      h('b', { text: 'Drop a picture of the process here' }),
      h('span', { class: 'faint', text: 'Or click to pick one, or paste it with ⌘V. PNG, JPEG, WebP or GIF, under 5 MB.' }));
    var thumb = h('div', { class: 'pi-thumb', hidden: true });
    var note = h('textarea', { rows: '2', maxlength: '1000', 'aria-label': 'What to change', placeholder: 'What to change, e.g. use our Product Team for design' });
    var draftBtn = h('button', { class: 'btn go', text: 'Draft it', disabled: true });
    var scrim = h('div', { class: 'scrim' });
    var close = function () { closed = true; scrim.remove(); document.removeEventListener('keydown', onKey); document.removeEventListener('paste', onPaste); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    var take = function (f) {
      if (!f || working) return;
      if (PI_TYPES.indexOf(f.type) < 0) { fill(out, [msg({ ok: false, error: 'Use a PNG, JPEG, WebP or GIF picture.' })]); return; }
      if (f.size > 5 * 1024 * 1024) { fill(out, [msg({ ok: false, error: 'That picture is over 5 MB. A screenshot of the diagram is plenty.' })]); return; }
      var reader = new FileReader();
      reader.onload = function () {
        picked = String(reader.result);
        fill(thumb, [h('img', { src: picked, alt: 'The picture you picked' }),
          h('button', { type: 'button', class: 'linkish', text: 'Use another picture', onclick: function () { file.click(); } })]);
        thumb.hidden = false; drop.hidden = true; draftBtn.disabled = false; fill(out, []);
      };
      reader.onerror = function () { fill(out, [msg({ ok: false, error: 'Couldn’t read that file.' })]); };
      reader.readAsDataURL(f);
    };
    var onPaste = function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) { e.preventDefault(); take(items[i].getAsFile()); return; }
      }
    };
    drop.onclick = function () { file.click(); };
    file.onchange = function () { take(file.files && file.files[0]); file.value = ''; };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('on'); };
    drop.ondragleave = function () { drop.classList.remove('on'); };
    drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('on'); take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); };
    scrim.ondragover = function (e) { e.preventDefault(); };
    scrim.ondrop = function (e) { e.preventDefault(); take(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]); };
    scrim.onclick = function (e) { if (e.target === scrim && !working) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('paste', onPaste);
    draftBtn.onclick = function () {
      if (!picked) return;
      working = true;
      var restore = busy(draftBtn, 'Reading the diagram…');
      fill(out, [h('div', { class: 'pi-working', role: 'status' }, h('span', { class: 'livedot' }), 'Reading the diagram… This can take 30 to 60 seconds.')]);
      var done = function (x) {
        working = false; restore();
        if (closed) return;
        if (x.ok === false) { fill(out, [msg(x)]); return; }
        close();
        state.processDraft = { draft: x.draft, notes: x.notes || [], image: picked };
        go('processedit', { processId: null, processFrom: null });
      };
      api('POST', '/api/processes/draft-from-image', { image: picked, note: note.value.trim() || undefined }).then(done, function (e) { done({ ok: false, error: String((e && e.message) || e) }); });
    };
    append(scrim, h('div', { class: 'dialog small pi-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pi-title' },
      h('div', null, h('h2', { id: 'pi-title', text: 'Make a process from a picture' }),
        h('p', { class: 'muted', style: 'margin-top:4px', text: 'A flowchart, a swimlane or a slide you found. Each box becomes a stage, decisions become people deciding, and rework arrows say where work goes back. Nothing is saved until you check it.' })),
      drop, thumb, file,
      h('label', { class: 'field' }, 'What to change (optional)', note), out,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn quiet', text: 'Cancel', onclick: close }), draftBtn)));
    document.body.appendChild(scrim);
    setTimeout(function () { drop.focus(); }, 0);
  }

  /// A length of time in words: "4 min", "6 h", "1.4 days".
  function spanWords(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return Math.max(1, m) + ' min';
    var hr = m / 60;
    if (hr < 36) return Math.round(hr) + ' h';
    var d = hr / 24, v = d < 10 ? Math.round(d * 10) / 10 : Math.round(d);
    return v + (v === 1 ? ' day' : ' days');
  }
  function median(xs) {
    var s = xs.slice().sort(function (a, b) { return a - b; }), n = s.length;
    return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
  }
  /// "a, b and c".
  function listWords(xs) { return xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }
  /// Where "send it back" from a stage lands: its chosen stage, else the
  /// nearest team or worker stage before it, else the start. As the server has it.
  function sendBackIndex(p, from) {
    var chosen = (p.stages[from] || {}).sendBackTo;
    if (chosen) for (var i = 0; i < p.stages.length; i++) if (p.stages[i].id === chosen) return i;
    for (var j = from - 1; j >= 0; j--) if (p.stages[j].kind !== 'people') return j;
    return 0;
  }
  /// Time an item spent in each stage, from its history: an "entered" runs
  /// to that stage's "finished", the next "entered", or the end. Open is
  /// the stage it's in now and since when.
  function itemSpans(it) {
    var closed = [], cur = null, from = 0;
    var shut = function (at) { if (cur) closed.push({ stageId: cur, ms: Math.max(0, at - from), at: at }); cur = null; };
    (it.history || []).forEach(function (e) {
      if (e.kind === 'entered' && e.stageId) { shut(e.at); cur = e.stageId; from = e.at; }
      else if ((e.kind === 'finished' && e.stageId === cur) || e.kind === 'done' || e.kind === 'stopped') shut(e.at);
    });
    return { closed: closed, open: it.status === 'active' && cur ? { stageId: cur, since: from } : null };
  }
  /// How long each stage takes, from every item's history: the usual time
  /// once three items went through it, else the last one's; end to end and
  /// the slowest stage once three items finished.
  function processTimes(p, items) {
    var per = {}, perDone = {}, last = {};
    items.forEach(function (it) {
      var tot = {}, at = {};
      itemSpans(it).closed.forEach(function (c) { tot[c.stageId] = (tot[c.stageId] || 0) + c.ms; at[c.stageId] = c.at; });
      Object.keys(tot).forEach(function (id) {
        (per[id] = per[id] || []).push(tot[id]);
        if (it.status === 'done') (perDone[id] = perDone[id] || []).push(tot[id]);
        if (!last[id] || at[id] > last[id].at) last[id] = { ms: tot[id], at: at[id] };
      });
    });
    var done = items.filter(function (i) { return i.status === 'done' && i.finishedAt; });
    var enough = done.length >= 3;
    var usual = function (s) { var xs = per[s.id] || []; return xs.length >= 3 ? median(xs) : null; };
    var inStage = enough ? p.stages.map(function (s) { var xs = perDone[s.id] || []; return xs.length ? median(xs) : null; }) : null;
    var slowest = null;
    if (inStage) inStage.forEach(function (ms, i) { if (ms != null && (slowest == null || ms > inStage[slowest])) slowest = i; });
    return {
      usual: usual,
      text: function (s) {
        var u = usual(s);
        return u != null ? 'usually ' + spanWords(u) : last[s.id] ? 'took ' + spanWords(last[s.id].ms) + ' last time' : '';
      },
      endToEnd: enough ? median(done.map(function (i) { return i.finishedAt - i.createdAt; })) : null,
      inStage: inStage,
      slowest: slowest == null ? null : p.stages[slowest]
    };
  }
  /// The ways work comes into a process: by hand, /idea, its schedules and intakes.
  function waysIn(p, r) {
    var out = [
      { short: 'page', long: 'this page', what: 'This page', detail: 'anyone who can see it', tone: 'go' },
      { short: 'Slack', long: '/idea in Slack', what: '/idea in Slack, starting with “' + p.name + ':”', detail: 'anyone in the org', tone: 'violet' }
    ];
    (r.schedules || []).forEach(function (s) {
      out.push({ short: 'schedule', long: 'a schedule', what: s.title, detail: s.when + (Number.isFinite(s.nextAt) ? ' · next ' + when(s.nextAt) : ''), tone: 'info' });
    });
    (r.intake || []).forEach(function (t) {
      var last = t.lastFiredAt ? 'last one ' + ago(t.lastFiredAt) : 'nothing yet';
      if (t.kind === 'watch') out.push({ short: t.watch.server, long: 'a watch on ' + t.watch.server, what: 'Watch on ' + t.watch.server + ': ' + t.watch.tool, detail: t.lastError || 'every ' + t.watch.everyMinutes + ' min · ' + last, tone: t.lastError ? 'bad' : 'ok' });
      else if (t.kind === 'webhook') out.push({ short: 'events', long: 'posted events', what: 'Posted events', detail: t.lastError || last, tone: t.lastError ? 'bad' : 'need' });
      else out.push({ short: 'a channel', long: 'a Slack channel', what: 'Every new message in ' + (t.channel || 'a channel'), detail: t.lastError || last, tone: t.lastError ? 'bad' : 'violet' });
    });
    return out;
  }
  /// What an item came to, in a line: the last thing handed on, or why it stopped.
  function procOutcome(p, it) {
    if (it.status === 'stopped') {
      var ev = (it.history || []).filter(function (e) { return e.kind === 'stopped'; }).pop();
      var at = (p.stages[it.stageIndex] || {}).name;
      return 'Stopped' + (ev && ev.by ? ' by ' + ev.by : '') + (at ? ' at ' + at : '') + (ev && ev.note ? ': “' + ev.note + '”' : '.');
    }
    var a = (it.artifacts || []).slice(-1)[0];
    var line = a ? (String(a.summary || '').split('\n').filter(function (l) { return l.trim(); })[0] || '').replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '') : '';
    var first = (/^.*?[.!?](?=\s|$)/.exec(line) || [line])[0];
    return first ? (first.length > 200 ? first.slice(0, 199).trim() + '…' : first) : 'Made it through every stage.';
  }
  function itemSource(it) {
    var me = (state.me && state.me.name) || '';
    var by = me && it.initiator && it.initiator.name.toLowerCase() === me.toLowerCase() ? 'you' : (it.initiator || {}).name;
    var from = { console: 'from this page', slack: 'from Slack', trigger: 'came in by itself', schedule: 'on its schedule', api: 'from the API', desktop: 'from the desktop app' }[it.source] || 'put in';
    return from + (by ? ', ' + by : '');
  }

  /// The column grid a process is drawn on: a start, one column per stage, an
  /// end. The board uses it too, so each stage's items sit under its card.
  var PF_GAP = 56, PF_LANE = 26, pfSeq = 0;
  function procGrid(n) {
    return { cols: 'minmax(128px, 0.7fr) repeat(' + n + ', minmax(176px, 1fr)) minmax(100px, 0.5fr)', min: 128 + n * 176 + 100 + (n + 1) * PF_GAP };
  }
  /// How a process runs, drawn: a card to start, one per stage, one to end;
  /// solid arrows from each to the next, and dashed loops round the outside
  /// for what goes back round (a send back, a repeat). The lines are drawn
  /// from where the cards actually are, and again when the layout changes.
  function procDiagram(p, who, times, ways, onStart) {
    var grid = procGrid(p.stages.length);
    var loops = [];
    p.stages.forEach(function (s, i) {
      if (s.repeat && s.kind !== 'people') loops.push({ from: i, to: i, label: 'every ' + plural(s.repeat.everyDays, 'day', 'days') + ' × ' + s.repeat.times, prefer: 'above' });
    });
    p.stages.forEach(function (s, i) {
      if (s.kind === 'people') loops.push({ from: i, to: sendBackIndex(p, i), label: 'sent back with what to change', prefer: 'below' });
    });
    loops.forEach(function (l) { l.lo = Math.min(l.from, l.to); l.hi = Math.max(l.from, l.to); });
    // Repeats first, then the shortest loops nearest the cards. A loop takes
    // the first lane (below, then above, then further out) it meets nothing on.
    loops.sort(function (a, b) { return (a.from === a.to ? 0 : 1) - (b.from === b.to ? 0 : 1) || (a.hi - a.lo) - (b.hi - b.lo); });
    var lanes = { below: [], above: [] };
    loops.forEach(function (l) {
      var order = l.prefer === 'above' ? ['above', 'below'] : ['below', 'above'];
      for (var k = 0; k < 80; k++) {
        var side = order[k % 2], n = Math.floor(k / 2);
        var lane = lanes[side][n] || (lanes[side][n] = []);
        if (lane.every(function (o) { return o.hi < l.lo || l.hi < o.lo; })) { lane.push(l); l.side = side; l.lane = n + 1; break; }
      }
    });
    // Where each loop leaves and lands on its cards: inner lanes nearest the
    // middle, so an outer loop's line never crosses an inner one's.
    var outs = {}, ins = {};
    loops.slice().sort(function (a, b) { return a.lane - b.lane; }).forEach(function (l) {
      if (l.from === l.to) return;
      var ko = l.side + l.from, ki = l.side + l.to;
      l.outN = outs[ko] = (outs[ko] || 0) + 1;
      l.inN = ins[ki] = (ins[ki] || 0) + 1;
    });

    var tag = function (text, cls) { return h('span', { class: 'pf-tag ' + cls, text: text }); };
    var shortWays = [];
    ways.forEach(function (w) { if (shortWays.indexOf(w.short) < 0) shortWays.push(w.short); });
    var cards = [h(onStart ? 'button' : 'div', { type: onStart ? 'button' : null, class: 'pf-card start', onclick: onStart || null, 'aria-label': onStart ? 'Comes in from ' + listWords(ways.map(function (w) { return w.long; })) + '. Show how work comes in.' : null },
      tag('Start', 'start'), h('b', { text: 'Comes in' }), h('span', { class: 'pf-sub', text: shortWays.join(' · ') }))]
      .concat(p.stages.map(function (s, i) {
        var t = times.text(s);
        return h('div', { class: 'pf-card ' + s.kind }, tag((i + 1) + ' · ' + KIND_WORD[s.kind], s.kind), h('b', { text: s.name }), h('span', { class: 'pf-sub' }, who.node ? who.node(s) : who(s), t ? ' · ' + t : ''));
      }))
      .concat([h('div', { class: 'pf-card end' }, tag('End', 'end'), h('b', { text: 'Done' }), h('span', { class: 'pf-sub', text: 'whoever put it in hears' }))]);
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'pf-lines');
    svg.setAttribute('aria-hidden', 'true');
    var labels = h('div', { class: 'pf-labels', 'aria-hidden': 'true' });
    var host = h('div', { class: 'pf-host', style: 'min-width:' + grid.min + 'px;padding-top:' + (12 + lanes.above.length * PF_LANE) + 'px;padding-bottom:' + (12 + lanes.below.length * PF_LANE) + 'px' },
      h('div', { class: 'pf-grid', style: 'grid-template-columns:' + grid.cols + ';column-gap:' + PF_GAP + 'px' }, cards), svg, labels);
    var seq = ++pfSeq;
    var el = function (tag_, attrs) { var n = document.createElementNS(SVG, tag_); for (var k in attrs) n.setAttribute(k, attrs[k]); return n; };
    var marker = function (id, cls) {
      var m = el('marker', { id: id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', markerUnits: 'userSpaceOnUse', orient: 'auto' });
      m.appendChild(el('path', { d: 'M0 0L10 5L0 10z', class: cls }));
      return m;
    };
    var note = function (cls, text, x, y) { var n = h('span', { class: cls, text: text }); n.style.left = Math.round(x) + 'px'; n.style.top = Math.round(y) + 'px'; labels.appendChild(n); };
    var draw = function () {
      if (!host.isConnected) return;
      var base = host.getBoundingClientRect();
      var R = cards.map(function (c) {
        var r = c.getBoundingClientRect();
        return { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top, cx: (r.left + r.right) / 2 - base.left };
      });
      var W = host.offsetWidth, H = host.offsetHeight;
      svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H)); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.textContent = ''; labels.textContent = '';
      var defs = el('defs', {});
      defs.appendChild(marker('pf-a' + seq, 'pf-headfill'));
      defs.appendChild(marker('pf-l' + seq, 'pf-headfill loop'));
      svg.appendChild(defs);
      var line = function (d, loop) { svg.appendChild(el('path', { d: d, class: loop ? 'pf-loop' : 'pf-solid', 'marker-end': 'url(#' + (loop ? 'pf-l' : 'pf-a') + seq + ')' })); };
      var top = R[0].t, bottom = R[0].b, mid = Math.round((top + bottom) / 2);
      for (var k = 0; k + 1 < R.length; k++) {
        line('M' + (R[k].r + 2) + ' ' + mid + 'H' + (R[k + 1].l - 2), false);
        var s = p.stages[k];
        if (s && s.delayDays) note('pf-wait', 'waits ' + (s.delayDays % 7 === 0 ? plural(s.delayDays / 7, 'week', 'weeks') : plural(s.delayDays, 'day', 'days')), (R[k].r + R[k + 1].l) / 2, mid - 6);
      }
      loops.forEach(function (l) {
        var below = l.side === 'below', edge = below ? bottom : top, dir = below ? 1 : -1;
        var y = edge + dir * l.lane * PF_LANE, end = edge + dir * 2;
        var a = R[l.from + 1], b = R[l.to + 1], x1, x2;
        if (l.from === l.to) { x1 = a.r - 18; x2 = x1 - 64; }
        else {
          var sign = l.to < l.from ? 1 : -1;
          x1 = a.cx + sign * (2 + 12 * l.outN);
          x2 = b.cx - sign * (2 + 12 * l.inN);
        }
        line('M' + x1 + ' ' + edge + 'V' + y + 'H' + x2 + 'V' + end, true);
        note('pf-note', l.label, (x1 + x2) / 2, y);
      });
    };
    var queued = false;
    var redraw = function () { if (queued) return; queued = true; requestAnimationFrame(function () { queued = false; draw(); }); };
    if (typeof ResizeObserver === 'function') {
      var ro = new ResizeObserver(function () { if (!host.isConnected) { ro.disconnect(); return; } redraw(); });
      ro.observe(host);
    } else {
      var onResize = function () { if (!host.isConnected) { window.removeEventListener('resize', onResize); return; } redraw(); };
      window.addEventListener('resize', onResize);
    }
    setTimeout(redraw, 0);
    return { node: h('div', { class: 'pf-scroll' }, host), redraw: redraw, grid: grid };
  }
  function pfLegend() {
    return h('span', { class: 'pf-legend' }, h('span', { class: 'on', text: 'moves on' }), h('span', { class: 'loop', text: 'goes back round' }));
  }

  /// One process. Nothing in flight: how it works, a way to put something
  /// in and what came out lately. Busy: the counts, how it works, and a board
  /// with each item under the stage it's at, then what finished lately.
  var KIND_WORD = { team: 'Team', worker: 'Worker', people: 'Decision' };
  function viewProcess() {
    return api('GET', '/api/processes/' + encodeURIComponent(state.processId)).then(function (r) {
      if (r.ok === false) return [msg(r)];
      var p = r.process, items = r.items || [], who = procWho(r);
      // One item open: it takes the page.
      var picked = state.processItem ? items.filter(function (i) { return i.id === state.processItem; })[0] : null;
      if (picked) return [itemPage(p, picked, who)];
      var me = ((state.me && state.me.name) || '').toLowerCase();
      var isMe = function (name) { return !!me && String(name || '').toLowerCase() === me; };
      var live = items.filter(function (i) { return i.status === 'active'; });
      var month = Date.now() - 30 * 86400000;
      var ended = items.filter(function (i) { return i.status !== 'active'; }).sort(function (a, b) { return (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt); });
      var lately = ended.filter(function (i) { return (i.finishedAt || i.updatedAt) > month; });
      var yours = live.filter(function (i) { return i.yourTurn; });
      var stuck = live.filter(function (i) { return i.blocked; });
      var mine = live.filter(function (i) { return isMe(i.initiator && i.initiator.name); });
      var times = processTimes(p, items);
      var ways = waysIn(p, r);
      var busyMode = live.length > 0;
      var openItem = function (it) { return function () { go('process', { processId: p.id, processItem: it.id }); }; };
      var first = p.stages[0];

      var summary;
      if (busyMode) {
        var num = function (n, words, tone) { return h('span', null, h('b', { class: tone, text: String(n) }), words); };
        summary = h('div', { class: 'pf-sum big' },
          num(live.length, 'in flight', ''), num(yours.length, 'waiting on you', yours.length ? 'need' : ''), num(stuck.length, 'stuck', stuck.length ? 'bad' : ''),
          num(lately.filter(function (i) { return i.status === 'done'; }).length, 'done in 30 days', 'ok'),
          times.endToEnd != null ? h('span', { class: 'faint', text: 'usually ' + spanWords(times.endToEnd) + ' end to end' + (times.slowest ? ' · most of it waiting at ' + times.slowest.name : '') }) : null);
      } else {
        var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
        var thisMonth = function (status) { return ended.filter(function (i) { return i.status === status && (i.finishedAt || i.updatedAt) >= monthStart.getTime(); }).length; };
        var doneN = thisMonth('done'), stoppedN = thisMonth('stopped');
        summary = h('p', { class: 'pf-sum' }, [
          'Owned by ' + (isMe(p.owner.name) ? 'you' : p.owner.name), 'Nothing in flight',
          doneN ? doneN + ' done this month' : null, stoppedN ? stoppedN + ' stopped this month' : null,
          p.codeIn ? 'Code in ' + p.codeIn.name : null,
          'Comes in from ' + listWords(ways.map(function (w) { return w.long; }))
        ].filter(Boolean).map(function (t) { return h('span', { text: t }); }));
      }

      var header = h('header', { class: 'page-head' },
        h('div', { style: 'min-width:0;flex:1 1 520px' },
          h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Processes', onclick: function () { go('processes'); } })),
          h('h1', { class: 'page-title', text: p.name }),
          p.purpose ? h('p', { class: 'page-sub', text: p.purpose }) : null,
          busyMode ? null : summary),
        h('div', { class: 'row' },
          p.canSteer ? h('button', { class: 'btn', text: 'Edit', onclick: function () { go('processedit', { processId: p.id }); } }) : null,
          busyMode && p.canStart !== false ? h('button', { class: 'btn go', onclick: function () { submitToProcess(p, function (item) { go('process', { processId: p.id, processItem: item.id }); }); } }, icon('plus', 16), 'Put something in') : null));

      // How work comes in, the owner's panel to add and remove ways.
      var waysOpen = !!state.processWays;
      var toggleWays = function () { state.processWays = !waysOpen; render(); };
      var waysPanel = function () {
        return h('div', { class: 'stack', style: 'gap:8px' },
          intakePanel(p, r.intake || [], r.schedules || []),
          h('button', { class: 'linkish pf-link', text: 'Close', onclick: toggleWays }));
      };

      var diagram = procDiagram(p, who, times, ways, busyMode ? toggleWays : null);
      var howHead = h('div', { class: 'pf-head' }, h('span', { class: 'label', style: 'flex:1', text: 'How it works · ' + plural(p.stages.length, 'stage', 'stages') }), pfLegend());

      if (!busyMode) {
        var steps = h('ol', { class: 'pf-steps' }, p.stages.map(function (s, i) {
          var does = s.why || s.ask || (s.kind === 'people' ? who(s) + (/,/.test(who(s)) ? ' decide' : ' decides') + ': approve it, send it back or stop it.' : who(s) + ' does this stage.');
          return h('li', null, h('b', { text: (i + 1) + ' · ' + s.name }), h('span', { text: does }));
        }));
        var how = h('section', { class: 'pf-panel', 'aria-label': 'How it works' }, howHead, diagram.node, steps);

        var title = h('input', { type: 'text', id: 'pf-title', maxlength: '200', placeholder: 'e.g. Let customers export reports to CSV' });
        var brief = h('textarea', { id: 'pf-brief', rows: '3', placeholder: 'What it is, who wants it and why. Links help.' });
        var out = h('div', { 'aria-live': 'polite' });
        var send = h('button', { class: 'btn go', text: 'Start at ' + first.name });
        send.onclick = function () {
          var restore = busy(send, 'Putting it in…');
          api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/items', { title: title.value, brief: brief.value }).then(function (x) {
            restore();
            if (x.ok === false) { fill(out, msg(x)); return; }
            go('process', { processId: p.id, processItem: x.item.id });
          });
        };
        var waysList = h('div', { class: 'pf-split' }, h('span', { class: 'pf-small', text: 'Other ways in' }),
          ways.slice(1).map(function (w) {
            return h('div', { class: 'pf-way' }, h('span', { class: 'pf-dot ' + w.tone, 'aria-hidden': 'true' }), h('span', { class: 'pf-what', text: w.what }), h('span', { class: 'faint', text: w.detail }));
          }),
          p.canSteer ? h('button', { class: 'linkish pf-link', text: 'Add a way in: Slack channel, schedule, tool watch, webhook', onclick: toggleWays }) : null);
        var put = h('section', { class: 'pf-panel', 'aria-labelledby': 'pf-put' },
          h('h2', { class: 'label pf-accent', id: 'pf-put', text: 'Put something in' }),
          h('label', { class: 'field' }, 'What is it?', title),
          h('label', { class: 'field' }, 'Details, steps, a link', brief),
          out,
          h('div', { class: 'row', style: 'gap:10px' }, send, h('span', { class: 'faint', text: first.kind === 'people' ? who(first) + (/,/.test(who(first)) ? ' decide' : ' decides') + ' first.' : who(first) + ' picks it up within a minute.' })),
          waysOpen && p.canSteer ? h('div', { class: 'pf-split' }, waysPanel()) : waysList);
        // Someone who sees it through a stage they're in, but isn't in its audience.
        if (p.canStart === false) put = h('section', { class: 'pf-panel', 'aria-labelledby': 'pf-put' },
          h('h2', { class: 'label pf-accent', id: 'pf-put', text: 'Put something in' }),
          h('p', { class: 'muted', text: 'Only some people can start ' + p.name + '. Ask ' + p.owner.name + ', who owns it.' }));

        var track = function (it) {
          return h('span', { class: 'pv-track', style: 'grid-template-columns:repeat(' + p.stages.length + ',minmax(0,1fr))', 'aria-label': it.status === 'done' ? 'Made it through' : 'Stopped at stage ' + (it.stageIndex + 1) + ' of ' + p.stages.length },
            p.stages.map(function (s, i) { return h('span', { class: it.status === 'done' || i < it.stageIndex ? 'done' : i === it.stageIndex ? 'stuck' : '' }); }));
        };
        var recentRows = lately.slice(0, 8).map(function (it) {
          return h('button', { type: 'button', class: 'pf-done', onclick: openItem(it) },
            h('span', { class: 'pf-top' }, h('b', { text: it.title }), h('span', { class: 'badge' + (it.status === 'done' ? ' ok' : ''), text: it.status === 'done' ? 'Done' : 'Stopped' }), h('span', { class: 'faint', text: when(it.finishedAt || it.updatedAt) })),
            track(it), h('span', { class: 'pf-out', text: procOutcome(p, it) }));
        });
        var maxIn = times.inStage ? Math.max.apply(null, times.inStage.map(function (x) { return x || 0; }).concat([1])) : 1;
        var spend = h('div', { class: 'pf-split' }, h('span', { class: 'pf-small', text: 'Where items spend their time' }),
          times.inStage ? [
            h('div', { class: 'pf-bars' }, p.stages.map(function (s, i) {
              var ms = times.inStage[i];
              return [h('span', { class: 'pf-barname', text: s.name }),
                h('span', { class: 'pf-bar', 'aria-hidden': 'true' }, h('span', { class: s.kind, style: 'width:' + (ms ? Math.max(2, Math.round(ms / maxIn * 100)) : 0) + '%' })),
                h('span', { class: 'faint', text: ms != null ? spanWords(ms) : 'not reached' })];
            })),
            h('span', { class: 'faint', text: 'Middle of the items that finished. ' + (times.endToEnd != null ? 'Usually ' + spanWords(times.endToEnd) + ' end to end.' : '') })]
            : h('span', { class: 'faint', text: 'After a few items finish, this shows which stage they wait in longest and how long the whole thing usually takes.' }));
        var recent = h('section', { class: 'pf-panel', 'aria-labelledby': 'pf-recent' },
          h('h2', { class: 'label', id: 'pf-recent', text: 'Recent · last 30 days' }),
          recentRows.length ? recentRows : h('span', { class: 'faint', text: ended.length ? 'Nothing finished or stopped in the last 30 days.' : 'Nothing has been through it yet.' }),
          spend);
        return [header, h('div', { class: 'stack', style: 'gap:18px;min-width:0' }, how, h('div', { class: 'pf-two' }, put, recent))];
      }

      // Busy: what to show, the diagram (it folds away), the board.
      var tab = state.processTab || 'all';
      var fits = { all: function () { return true; }, you: function (i) { return !!i.yourTurn; }, stuck: function (i) { return !!i.blocked; }, mine: function (i) { return isMe(i.initiator && i.initiator.name); } };
      if (!fits[tab]) tab = 'all';
      var shown = live.filter(fits[tab]);
      var filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Show' }, [['all', 'All', live.length], ['you', 'Waiting on you', yours.length], ['stuck', 'Stuck', stuck.length], ['mine', 'Mine', mine.length]].map(function (t) {
        return h('button', { type: 'button', 'aria-pressed': tab === t[0] ? 'true' : 'false', onclick: function () { state.processTab = t[0]; render(); } }, t[1] + ' ' + t[2]);
      }));
      var how2 = h('details', { class: 'pf-panel pf-how', open: state.processHow !== false },
        h('summary', null, h('span', { class: 'label', style: 'flex:1' }, icon('back', 12), 'How it works · ' + plural(p.stages.length, 'stage', 'stages')), pfLegend()),
        diagram.node,
        waysOpen ? waysPanel() : null);
      how2.ontoggle = function () { state.processHow = how2.open; if (how2.open) diagram.redraw(); };

      var board = h('div', { class: 'pf-scroll pf-boardwrap' }, h('div', { class: 'pf-board', role: 'list', 'aria-label': 'Items by stage', style: 'grid-template-columns:' + diagram.grid.cols + ';column-gap:' + PF_GAP + 'px;min-width:' + diagram.grid.min + 'px' },
        p.stages.map(function (s, i) {
          var here = shown.filter(function (it) { return it.stageIndex === i; })
            .sort(function (a, b) { return (b.yourTurn ? 1 : 0) - (a.yourTurn ? 1 : 0) || (b.blocked ? 1 : 0) - (a.blocked ? 1 : 0) || b.updatedAt - a.updatedAt; });
          var t = times.text(s);
          return h('section', { class: 'pf-col ' + s.kind, role: 'listitem', style: 'grid-column:' + (i + 2), 'aria-label': s.name + ': ' + plural(here.length, 'item', 'items') },
            h('div', { class: 'pf-colhead' },
              h('span', { class: 'pf-coltop' }, h('span', { class: 'pf-tag ' + s.kind, text: (i + 1) + ' · ' + KIND_WORD[s.kind] }), h('span', { class: 'pf-count', text: String(here.length) })),
              h('b', { text: s.name }),
              h('span', { class: 'faint', text: who(s) + (t ? ' · ' + t : '') })),
            here.length ? here.map(function (it) {
              var open = itemSpans(it).open;
              var since = open ? open.since : it.updatedAt;
              var now = it.blocked ? 'Stuck: ' + it.blocked
                : it.yourTurn ? 'Waiting on you · ' + spanWords(Date.now() - since)
                  : it.stageNote || (it.waitsOn ? 'Waiting on ' + it.waitsOn + ' · ' + spanWords(Date.now() - since) : who(s) + (s.kind === 'people' ? ' deciding' : ' is on it'));
              return h('button', { type: 'button', class: 'pf-item' + (it.blocked ? ' stuck' : it.yourTurn ? ' yours' : ''), onclick: openItem(it) },
                h('b', { text: it.title }), h('span', { class: 'pf-now', text: now }),
                h('span', { class: 'faint', text: itemSource(it) + ' · ' + spanWords(Date.now() - it.createdAt) }));
            }) : h('span', { class: 'pf-none', text: 'Nothing here' }));
        })));

      var allDone = !!state.processAllDone;
      var doneList = (allDone ? ended.slice(0, 60) : lately.slice(0, 6));
      var finished = ended.length ? h('section', { class: 'stack', style: 'gap:8px', 'aria-labelledby': 'pf-fin' },
        h('div', { class: 'row' }, h('h2', { class: 'label', id: 'pf-fin', style: 'flex:1', text: allDone ? 'Finished and stopped' : 'Finished recently' }),
          ended.length > doneList.length || allDone ? h('button', { class: 'linkish pf-link', text: allDone ? 'Recent only' : 'All ' + ended.length, onclick: function () { state.processAllDone = !allDone; render(); } }) : null),
        doneList.length ? h('div', { class: 'pf-cards' }, doneList.map(function (it) {
          return h('button', { type: 'button', class: 'pf-done', onclick: openItem(it) },
            h('span', { class: 'pf-top' }, h('span', { class: 'badge' + (it.status === 'done' ? ' ok' : ''), text: it.status === 'done' ? 'Done' : 'Stopped' }), h('span', { class: 'faint', text: when(it.finishedAt || it.updatedAt) })),
            h('b', { text: it.title }), h('span', { class: 'pf-out', text: procOutcome(p, it) }));
        })) : h('span', { class: 'faint', text: 'Nothing finished in the last 30 days.' })) : null;

      return [header, h('div', { class: 'stack', style: 'gap:16px;min-width:0' }, summary, how2,
        h('div', { class: 'stack', style: 'gap:10px;min-width:0' },
          h('div', { class: 'pf-head' }, h('h2', { class: 'label', style: 'flex:1', text: 'The board · each item sits under the stage it’s at' }), filters),
          board),
        finished)];
    });
  }

  /// Who does a stage, by name: its team, its worker, or the people and groups deciding.
  function procWho(r) {
    var teams = {}, workersById = {};
    (r.teams || []).forEach(function (t) { teams[t.id] = t.name; });
    (r.workers || []).forEach(function (w) { workersById[w.id] = w.name; });
    var who = function (s) {
      return s.kind === 'team' ? (teams[s.teamId] || 'A team') : s.kind === 'worker' ? (workersById[s.workerId] || 'A worker')
        : (s.approverGroups || []).map(function (g) { return g.name; }).concat((s.approvers || []).map(function (a) { return a.name; })).join(', ') || 'Nobody yet';
    };
    // The team or worker as a link to its own page; people stay names.
    who.node = function (s) {
      var name = who(s);
      if (s.kind === 'team' && teams[s.teamId]) return h('button', { type: 'button', class: 'linkish pf-who', text: name, title: 'Open ' + name, onclick: function () { go('team', { teamId: s.teamId }); } });
      if (s.kind === 'worker' && workersById[s.workerId]) return h('button', { type: 'button', class: 'linkish pf-who', text: name, title: 'Open ' + name, onclick: function () { openWorker(s.workerId); } });
      return name;
    };
    return who;
  }

  /// How work comes in: by hand and from Slack, a schedule, a watch on a
  /// tool, a channel or posted events. Each way is a row; its owner adds
  /// more from the choices underneath.
  function intakePanel(p, intake, schedules) {
    var out = h('div', { 'aria-live': 'polite' });
    var remove = function (path) {
      return function () { api('POST', path, {}).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else render(); }); };
    };
    var way = function (ic, title, sub, action) {
      return h('div', { class: 'in-row' }, h('span', { class: 'in-ic', 'aria-hidden': 'true' }, icon(ic, 16)),
        h('div', { class: 'stack', style: 'gap:2px;min-width:0;flex:1' }, h('b', { text: title }), sub), action || null);
    };
    var rows = [
      way('slack', 'Slack, by anyone', h('span', { class: 'faint' }, h('code', { text: '/idea ' + p.name + ': …' }), ' or ', h('code', { text: '@overcli idea: …' }), '. ', h('code', { text: '/idea' }), ' alone shows where theirs are.')),
    ].concat((schedules || []).map(function (s) {
      return way('clock', s.title, h('span', { class: 'faint', text: s.when + '. Next: ' + (Number.isFinite(s.nextAt) ? new Date(s.nextAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never') + '.' }),
        p.canSteer ? h('button', { class: 'btn small quiet', text: 'Remove', onclick: remove('/api/processes/' + encodeURIComponent(p.id) + '/schedules/' + encodeURIComponent(s.id) + '/remove') }) : null);
    })).concat(intake.map(function (t) {
      var title = t.kind === 'watch' ? 'New items in ' + t.watch.server : t.kind === 'webhook' ? 'Posted events' : 'Every new message in ' + (t.channel || 'a channel');
      var sub = t.kind === 'watch' ? t.watch.tool + ', checked every ' + t.watch.everyMinutes + ' min. ' : t.kind === 'webhook' ? 'Its secret URL was shown once. ' : 'Invite the bot to the channel. ';
      return way(t.kind === 'watch' ? 'search' : t.kind === 'webhook' ? 'bolt' : 'slack', title,
        h('span', { class: t.lastError ? 'msg err' : 'faint', text: t.lastError ? t.lastError : sub + (t.lastFiredAt ? 'Last one ' + ago(t.lastFiredAt) + '.' : 'Nothing yet.') }),
        p.canSteer ? h('button', { class: 'btn small quiet', text: 'Remove', onclick: remove('/api/process-intake/' + encodeURIComponent(t.id) + '/remove') }) : null);
    }));
    if (!p.canSteer) return card('pd-in', 'How work comes in', null, h('div', { class: 'stack', style: 'gap:0' }, rows, out));

    var slot = h('div');
    var adders = h('div', { class: 'in-add' });
    var choose = function (form) { fill(slot, [form]); adders.hidden = true; };
    var done = function () { slot.textContent = ''; adders.hidden = false; };
    append(adders, [
      h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Add a way in:' }),
      h('button', { class: 'btn small', onclick: function () { choose(scheduleForm(p, done, out)); } }, icon('clock', 14), 'On a schedule'),
      h('button', { class: 'btn small', onclick: function () { choose(watchForm(p, done, out)); } }, icon('search', 14), 'Watch a tool'),
      h('button', { class: 'btn small quiet', onclick: function () { choose(channelForm(p, done, out)); } }, icon('slack', 14), 'A Slack channel'),
      h('button', { class: 'btn small quiet', onclick: function () {
        api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/intake', { kind: 'webhook' }).then(function (x) {
          out.textContent = '';
          if (x.ok === false) { out.appendChild(msg(x)); return; }
          out.appendChild(h('div', { class: 'msg ok', role: 'status' }, 'Post events to this URL. It is shown once, so copy it now: ', h('code', { text: location.origin + x.webhookPath })));
        });
      } }, icon('bolt', 14), 'Posted events')
    ]);
    return card('pd-in', 'How work comes in', null, h('div', { class: 'stack', style: 'gap:0' }, rows, h('div', { class: 'in-foot' }, adders, slot), out));
  }

  /// "Every quarter, plan the roadmap": when, and the item each one puts in.
  function scheduleForm(p, done, out) {
    var when = h('select', { 'aria-label': 'When' },
      [['weekly', 'Every week'], ['weekdays', 'Every weekday'], ['monthly', 'On the 1st of each month'], ['quarterly', 'On the first day of each quarter']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    var day = h('select', { 'aria-label': 'On', style: 'width:auto' }, DAY_NAMES.map(function (n, i) { return h('option', { value: String(i), text: n, selected: i === 1 }); }));
    var time = h('input', { type: 'time', value: '09:00', 'aria-label': 'At', style: 'width:130px' });
    var dayWrap = h('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('span', { class: 'faint', text: 'on' }), day);
    when.onchange = function () { dayWrap.hidden = when.value !== 'weekly'; };
    var title = h('input', { type: 'text', maxlength: '100', placeholder: 'e.g. Quarterly roadmap', 'aria-label': 'Title' });
    var brief = h('textarea', { rows: '3', 'aria-label': 'What each one is about', placeholder: 'What the first stage should do each time, e.g. Plan next quarter’s roadmap from this quarter’s requests, usage and churn.' });
    var save = h('button', { class: 'btn go small', text: 'Add the schedule' });
    save.onclick = function () {
      var hm = (time.value || '09:00').split(':');
      var cadence = when.value === 'weekly' ? { kind: 'daily', time: time.value || '09:00', days: [Number(day.value)] }
        : when.value === 'weekdays' ? { kind: 'daily', time: time.value || '09:00', days: [1, 2, 3, 4, 5] }
          : { kind: 'cron', expr: Number(hm[1]) + ' ' + Number(hm[0]) + ' 1 ' + (when.value === 'quarterly' ? '1,4,7,10' : '*') + ' *' };
      var restore = busy(save, 'Adding…');
      api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/schedules', { cadence: cadence, title: title.value, brief: brief.value }).then(function (x) {
        restore();
        out.textContent = '';
        if (x.ok === false) { out.appendChild(msg(x)); return; }
        render();
      });
    };
    return h('div', { class: 'in-form' },
      h('b', { text: 'Start an item on a schedule' }),
      h('div', { class: 'row', style: 'gap:8px' }, when, dayWrap, h('span', { class: 'faint', text: 'at' }), time),
      h('label', { class: 'field' }, 'Each one is called', title, h('span', { class: 'faint pm-hint', text: 'The date is added: “Quarterly roadmap · Jan 1, 2027”.' })),
      h('label', { class: 'field' }, 'What each one is about', brief),
      h('div', { class: 'row' }, save, h('button', { class: 'btn small quiet', text: 'Cancel', onclick: done })));
  }

  /// Each new item a tool returns (a ticket in a view, a row) goes in: the
  /// same watch a worker's trigger uses, tried before it's saved.
  function watchForm(p, done, out) {
    var server = h('select', { 'aria-label': 'Tool' }, h('option', { value: '', text: 'Loading tools…' }));
    var call = h('select', { 'aria-label': 'What to ask it' }, h('option', { value: '', text: 'Pick a tool first' }));
    var args = h('textarea', { 'aria-label': 'With (JSON)', placeholder: '{ "jql": "project = ACME AND type = Bug AND created >= -1d" }', style: 'min-height:64px;font-family:var(--mono);font-size:12.5px' });
    var every = h('select', { 'aria-label': 'How often' }, [5, 10, 15, 30, 60].map(function (n) { return h('option', { value: String(n), text: 'every ' + n + ' min', selected: n === 15 }); }));
    var itemsPath = h('input', { type: 'text', placeholder: 'e.g. issues', 'aria-label': 'Where the list is' });
    var idPath = h('input', { type: 'text', placeholder: 'e.g. key', 'aria-label': 'What identifies an item' });
    var note = h('textarea', { rows: '2', 'aria-label': 'Add to each brief', placeholder: 'Optional: what the first stage should know about every item from here.' });
    var tried = h('div', { 'aria-live': 'polite' });
    var parse = function () { if (!args.value.trim()) return {}; try { return JSON.parse(args.value); } catch (e) { return null; } };
    var watch = function () {
      var a = parse();
      return a === null ? null : { server: server.value, tool: call.value, args: a, everyMinutes: Number(every.value), itemsPath: itemsPath.value.trim(), idPath: idPath.value.trim() };
    };
    api('GET', '/api/tools').then(function (r) {
      server.textContent = '';
      var tools = r.ok === false ? [] : r.tools;
      if (!tools.length) { server.appendChild(h('option', { value: '', text: 'No tools installed: add one under Setup → Tools' })); return; }
      server.appendChild(h('option', { value: '', text: 'Pick a tool' }));
      tools.forEach(function (t) { server.appendChild(h('option', { value: t.name, text: t.name })); });
    });
    // A tool that can list alarms in ALARM state (AWS's CloudWatch MCP
    // server) gets a one-click setup: each alarm that goes off is a new item,
    // and one that recovers and goes off again is a new item again.
    var preset = h('div', { class: 'msg', hidden: true });
    var alarmPreset = function () {
      call.value = 'get_active_alarms';
      args.value = '{}';
      every.value = '5';
      fireOn.value = 'new';
      itemsPath.value = ''; idPath.value = '';
      if (!name.value.trim()) name.value = 'CloudWatch alarms';
      if (!instructions.value.trim()) instructions.value = 'An alarm went off. Pull the logs around the time it changed state with a Logs Insights query, find the likely cause, and post a short summary: what broke, since when, how bad, and what to check first.';
      syncFire();
    };
    server.onchange = function () {
      call.textContent = ''; call.appendChild(h('option', { value: '', text: 'Loading…' }));
      preset.hidden = true;
      if (!server.value) return;
      api('GET', '/api/tools/' + encodeURIComponent(server.value) + '/calls').then(function (r) {
        call.textContent = '';
        if (r.ok === false) { call.appendChild(h('option', { value: '', text: r.error })); return; }
        r.tools.forEach(function (t) { call.appendChild(h('option', { value: t.name, text: t.name, title: t.description || '' })); });
        if (!r.tools.some(function (t) { return t.name === 'get_active_alarms'; })) return;
        preset.textContent = '';
        append(preset, [h('span', { text: 'This tool lists CloudWatch alarms. ' }), h('button', { type: 'button', class: 'btn small', text: 'Set it up for CloudWatch alarms', onclick: alarmPreset })]);
        preset.hidden = false;
      });
    };
    var test = h('button', { class: 'btn small', text: 'Try it now' });
    test.onclick = function () {
      var w = watch();
      tried.textContent = '';
      if (!w) { tried.appendChild(h('div', { class: 'msg err', text: 'The arguments aren’t valid JSON.' })); return; }
      var restore = busy(test, 'Asking the tool…');
      api('POST', '/api/triggers/test', { watch: w }).then(function (x) {
        restore();
        if (x.ok === false) { tried.appendChild(msg(x)); return; }
        append(tried, [h('p', { class: 'faint', style: 'margin:0', text: 'It sees ' + plural(x.items.length, 'item', 'items') + ' now. These are skipped; each new one after goes in.' }),
          h('ul', { style: 'margin:6px 0 0;padding-left:18px;font-size:13px' }, x.items.slice(0, 6).map(function (i) { return h('li', { text: i.title }); }))]);
      });
    };
    var save = h('button', { class: 'btn go small', text: 'Start watching' });
    save.onclick = function () {
      var w = watch();
      if (!w) { tried.textContent = ''; tried.appendChild(h('div', { class: 'msg err', text: 'The arguments aren’t valid JSON.' })); return; }
      var restore = busy(save, 'Saving…');
      api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/intake', { kind: 'watch', watch: w, instructions: note.value }).then(function (x) {
        restore();
        out.textContent = '';
        if (x.ok === false) { out.appendChild(msg(x)); return; }
        render();
      });
    };
    return h('div', { class: 'in-form' },
      h('b', { text: 'Each new item in a tool goes in' }),
      h('p', { class: 'faint', style: 'margin:0', text: 'A new ticket in a view, a new deal, a new row: checked every few minutes, from inside your network too. What is there now is skipped.' }),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Tool', server), h('label', { class: 'field' }, 'What to ask it', call)),
      h('label', { class: 'field' }, 'With (JSON)', args),
      h('div', { class: 'row', style: 'gap:10px;align-items:flex-end' }, h('label', { class: 'field', style: 'width:180px' }, 'How often', every), test),
      tried,
      h('label', { class: 'field' }, 'Add to each brief', note),
      h('details', null, h('summary', { text: 'If it can’t tell items apart' }), h('div', { class: 'grid2', style: 'margin-top:10px' }, h('label', { class: 'field' }, 'Where the list is', itemsPath), h('label', { class: 'field' }, 'What identifies an item', idPath))),
      h('div', { class: 'row' }, save, h('button', { class: 'btn small quiet', text: 'Cancel', onclick: done })));
  }

  function channelForm(p, done, out) {
    var channel = h('input', { type: 'text', placeholder: 'C012AB3CD', 'aria-label': 'Slack channel ID', style: 'max-width:240px' });
    var save = h('button', { class: 'btn go small', text: 'Take in the channel' });
    save.onclick = function () {
      var restore = busy(save, 'Adding…');
      api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/intake', { kind: 'slack', channel: channel.value }).then(function (x) { restore(); out.textContent = ''; if (x.ok === false) out.appendChild(msg(x)); else render(); });
    };
    return h('div', { class: 'in-form' },
      h('b', { text: 'Every new message in a channel goes in' }),
      h('label', { class: 'field' }, 'Channel ID (channel details, at the bottom)', channel),
      h('p', { class: 'faint', style: 'margin:0', text: 'Invite the bot to the channel first: /invite @overcli.' }),
      h('div', { class: 'row' }, save, h('button', { class: 'btn small quiet', text: 'Cancel', onclick: done })));
  }

  /// One item, the whole width of the page: where it is across every stage,
  /// the call waiting on you (or why it's stuck), then what it stands on,
  /// its journey, what it handed on and the request; who does each stage
  /// and the time each took beside it. It refreshes itself while you read.
  function itemPage(p, it, who) {
    var me = (state.me && state.me.name) || '';
    var stage = p.stages[it.stageIndex] || {};
    var active = it.status === 'active';
    var now_ = Date.now();
    var KIND_LETTER = { team: 'T', worker: 'W', people: 'P' };
    var dur = function (ms) {
      var m = Math.round(ms / 60000);
      if (m < 60) return Math.max(1, m) + ' min';
      var hr = Math.round(m / 60);
      return hr < 48 ? hr + ' h' : Math.round(hr / 24) + ' d';
    };
    var clock = function (ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
    var stamp = function (ms) { var d = dayLabel(ms); return (d === 'Today' ? '' : d + ' ') + clock(ms); };
    var clip = function (t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n - 1).trim() + '…' : t; };
    var firstLine = function (t) { return (String(t || '').split('\n').filter(function (l) { return l.trim(); })[0] || '').replace(/^[#>*\-\s]+/, ''); };
    var stageById = function (id) { return p.stages.filter(function (s) { return s.id === id; })[0]; };
    var stageName = function (id) { var s = stageById(id); return s ? s.name : 'a stage'; };
    var isMe = function (name) { return !!me && String(name).toLowerCase() === me.toLowerCase(); };
    // How many must approve at a people stage, and the rule in words.
    var needOf = function (s) { var n = (s.approvers || []).length; return s.needs === 'all' ? Math.max(1, n) : typeof s.needs === 'number' ? s.needs : 1; };
    var ruleText = function (s) {
      var n = (s.approvers || []).length, groups = (s.approverGroups || []).length;
      if (s.needs === 'all') return 'all of them';
      if (typeof s.needs === 'number' && s.needs > 1) return 'any ' + s.needs + (groups ? '' : ' of ' + n);
      return n + groups > 1 ? 'any one' : '';
    };
    var whoLine = function (s) {
      if (s.kind === 'people') { var r = ruleText(s); return who(s) + (r ? ' · ' + r : ''); }
      return who(s) + ' · ' + (s.kind === 'team' ? 'team' : 'worker');
    };
    // Where "send it back" lands by default: its chosen stage, else the
    // nearest team or worker stage before it, else the start.
    var backIndex = function (from) {
      var s = p.stages[from] || {};
      if (s.sendBackTo) { for (var i = 0; i < p.stages.length; i++) if (p.stages[i].id === s.sendBackTo) return i; }
      for (var j = from - 1; j >= 0; j--) if (p.stages[j].kind !== 'people') return j;
      return 0;
    };

    // Time in each stage, from its history: each "entered" runs to the next.
    var spans = {}, redoCount = {}, cur = null, from = it.createdAt, enteredAt = it.createdAt;
    var close = function (at) { if (cur) spans[cur] = (spans[cur] || 0) + Math.max(0, at - from); cur = null; };
    it.history.forEach(function (e) {
      // A redo: sent back to a stage, or a stage started again.
      if (e.kind === 'sentBack' && e.stageId) redoCount[e.stageId] = (redoCount[e.stageId] || 0) + 1;
      if (e.kind === 'retried' && cur) redoCount[cur] = (redoCount[cur] || 0) + 1;
      if (e.kind === 'entered' && e.stageId) { close(e.at); cur = e.stageId; from = e.at; if (cur === stage.id) enteredAt = e.at; }
      else if (e.kind === 'done' || e.kind === 'stopped') close(e.at);
    });
    if (active) close(now_);
    var redos = function (s) { return redoCount[s.id] || 0; };
    var phase = function (i) {
      if (it.status === 'done' || i < it.stageIndex) return 'done';
      if (i === it.stageIndex) return it.status === 'stopped' || it.blocked ? 'stuck' : it.canDecide || it.yourTurn ? 'need' : 'now';
      return 'next';
    };

    // A team or worker stage stopped for its owner: what they're asked to do.
    var TURN = { questions: ['answer the questions', 'answers the questions'], plan: ['approve the plan', 'approves the plan'], pack: ['sign off the pack', 'signs off the pack'], paused: ['unblock the run', 'unblocks the run'] };
    var turn = active && !it.blocked && it.ownerTurn && TURN[it.ownerTurn] ? TURN[it.ownerTurn] : null;
    var waitsOn = it.waitsOn || who(stage);
    var mineNow = !!(it.canDecide || it.yourTurn);
    var openStage = function () { if (stage.kind === 'worker' && stage.workerId) openWorker(stage.workerId); else if (it.taskId) openTask(it.taskId); };
    var flash = state.procFlash && state.procFlash.id === it.id ? state.procFlash.text : '';
    state.procFlash = null;
    var out = h('div', { 'aria-live': 'polite' }, flash ? h('div', { class: 'msg ok', role: 'status', text: flash }) : null);
    var act = function (action, extra, label, button, after) {
      var restore = button ? busy(button, label) : function () {};
      api('POST', '/api/process-items/' + encodeURIComponent(it.id) + '/act', Object.assign({ action: action }, extra || {})).then(function (x) {
        restore();
        if (x.ok === false) { fill(out, msg(x)); return; }
        if (after) after(x);
        render();
      });
    };
    // What a stage handed on: its files, read through the item, so anyone
    // who can see the item can read them, team or not.
    var fileCache = {};
    var loadFile = function (a, name) {
      var key = a.taskId + '/' + name;
      if (fileCache[key]) return Promise.resolve(fileCache[key]);
      return api('GET', '/api/process-items/' + encodeURIComponent(it.id) + '/file?task=' + encodeURIComponent(a.taskId) + '&name=' + encodeURIComponent(name)).then(function (x) {
        if (x && x.ok !== false) fileCache[key] = x;
        return x;
      });
    };
    var saveText = function (name, body) {
      var l = h('a', { href: URL.createObjectURL(new Blob([body], { type: 'text/plain' })), download: name.replace(/^.*\//, '') });
      document.body.appendChild(l); l.click(); l.remove();
    };
    var fileList = function (a) {
      if (!a.files || !a.files.length) return null;
      if (!a.taskId) return h('span', { class: 'faint', text: plural(a.files.length, 'file', 'files') + ': ' + a.files.join(', ') });
      return h('div', { class: 'pi-flist' }, a.files.map(function (name) {
        var view = h('div', { class: 'pi-fview', hidden: true });
        var shown = false;
        var openBtn = h('button', { type: 'button', class: 'pi-fopen', 'aria-expanded': 'false', title: 'Read it here' }, icon('doc', 15), h('span', { text: name }));
        openBtn.onclick = function () {
          shown = !shown; view.hidden = !shown; openBtn.setAttribute('aria-expanded', shown ? 'true' : 'false');
          if (!shown || view.firstChild) return;
          append(view, h('span', { class: 'faint', text: 'Loading…' }));
          loadFile(a, name).then(function (x) { fill(view, x.ok === false ? msg(x) : /\.(md|markdown)$/i.test(name) ? md(x.body) : h('pre', { text: x.body })); });
        };
        var dl = h('button', { type: 'button', class: 'btn small quiet', text: 'Download' });
        dl.onclick = function () { var restore = busy(dl, 'Getting…'); loadFile(a, name).then(function (x) { restore(); if (x.ok === false) { fill(out, msg(x)); return; } saveText(name, x.body); }); };
        return h('div', { class: 'pi-frow' }, h('div', { class: 'pi-fline' }, openBtn, dl), view);
      }));
    };
    var longText = function (t) { t = String(t || ''); return t.split('\n').length > 12 || t.length > 1200; };
    var mdBlock = function (t, big) {
      var long_ = longText(t);
      var box = h('div', { class: (big ? 'pi-lead' : 'pi-sum') + (long_ ? ' clamp' : '') }, md(t));
      return [box, long_ ? h('button', { class: 'linkish pi-showall', text: 'Show all', onclick: function (e) { box.classList.remove('clamp'); e.target.remove(); } }) : null];
    };
    var allFiles = [];
    (it.artifacts || []).forEach(function (a) { if (a.taskId) (a.files || []).forEach(function (f) { allFiles.push([a, f]); }); });
    var downloadAll = function (e) {
      var btn = e.target, restore = busy(btn, 'Downloading…'), n = 0;
      var next = function () {
        if (n >= allFiles.length) { restore(); return; }
        var pair = allFiles[n++];
        loadFile(pair[0], pair[1]).then(function (x) { if (x.ok === false) { restore(); fill(out, msg(x)); return; } saveText(pair[1], x.body); setTimeout(next, 300); });
      };
      next();
    };
    var teamArt = function (a) { var s = stageById(a.stageId); return !!(a.taskId && (!s || s.kind === 'team')); };
    var arts = it.artifacts || [];
    var last = arts[arts.length - 1];
    var prUrl = '';
    arts.forEach(function (a) { var m = /https?:\/\/[^\s)<>]+\/(?:pull|merge_requests)\/\d+/.exec(a.summary || ''); if (m) prUrl = m[0]; });
    var prLabel = prUrl ? 'Open PR #' + prUrl.replace(/.*\//, '') : '';
    var branch = it.branch || (last && last.branch) || '';

    // ---- Header: the process, the item, what it is, and what you can do.
    var src = it.source === 'slack' ? 'via Slack' : it.source === 'trigger' ? 'came in automatically' : it.source === 'schedule' ? 'on its schedule' : '';
    var day = dayLabel(it.createdAt);
    var started = 'started ' + (day === 'Today' ? 'today ' : day === 'Yesterday' ? 'yesterday ' : day + ', ') + clock(it.createdAt);
    var noteOpen = false, sendOpen = false;
    var noteBox = h('div', { class: 'pi-note', hidden: true });
    var noteText = h('textarea', { rows: '2', placeholder: 'A note everyone on this item sees in its journey', 'aria-label': 'Note' });
    var noteSave = h('button', { class: 'btn small go', text: 'Add the note' });
    noteSave.onclick = function () { act('note', { note: noteText.value }, 'Adding…', noteSave); };
    append(noteBox, [noteText, h('div', { class: 'row', style: 'gap:6px' }, noteSave, h('button', { class: 'btn small quiet', text: 'Cancel', onclick: function () { toggleNote(false); } }))]);
    var toggleNote = function (open) { noteOpen = open; noteBox.hidden = !open; if (open) noteText.focus(); };

    var moveRow = null;
    var menuItems = [];
    if (active && it.canSteer && it.startsAt) menuItems.push(['Start now', function () { act('startNow', {}, 'Starting…'); }]);
    if (it.taskId && stage.kind === 'team') menuItems.push(['Open the task', function () { openTask(it.taskId); }]);
    if (active && it.canSteer && stage.kind !== 'people' && !it.blocked) menuItems.push(['Start this stage again', function () { act('retry', {}, 'Starting…'); }]);
    if (active && it.canSteer) {
      var to = h('select', { 'aria-label': 'Move to stage', style: 'width:auto' }, p.stages.map(function (s, i) { return h('option', { value: String(i), text: (i + 1) + '. ' + s.name, selected: i === it.stageIndex }); }));
      var moveBtn = h('button', { class: 'btn small', text: 'Move it' });
      moveBtn.onclick = function () { act('move', { stageIndex: Number(to.value) }, 'Moving…', moveBtn); };
      moveRow = h('div', { class: 'pi-move row', hidden: true }, h('span', { class: 'muted', style: 'font-size:13px', text: 'Move it to' }), to, moveBtn,
        h('button', { class: 'btn small quiet', text: 'Cancel', onclick: function () { moveRow.hidden = true; } }));
      menuItems.push(['Move to another stage…', function () { moveRow.hidden = false; to.focus(); }]);
    }
    if (active && (it.canSteer || it.canDecide)) menuItems.push(['Stop it', function () { if (confirm('Stop "' + it.title + '"? Work in progress is cancelled; what it produced stays.')) act('stop', {}, 'Stopping…'); }, true]);
    var more = moreMenu(menuItems);
    var brief1 = clip(firstLine(it.brief), 220);
    var header = h('header', { class: 'pi-head' },
      h('div', { class: 'pi-top' },
        h('div', { class: 'pi-titles' },
          h('span', { class: 'pi-crumb' },
            h('button', { class: 'linkish', text: p.name, onclick: function () { go('process', { processId: p.id, processItem: null }); } }),
            ' · ' + ['from ' + it.initiator.name + (src ? ' ' + src : ''), started, p.codeIn ? 'code in ' + p.codeIn.name : null].filter(Boolean).join(' · ')),
          h('h1', { class: 'pi-title', text: it.title }),
          brief1 && brief1 !== it.title ? h('span', { class: 'pi-brief', text: brief1 }) : null),
        h('div', { class: 'row', style: 'gap:10px' },
          h('span', { class: 'pi-owner', text: 'Owner · ' + p.owner.name }),
          h('button', { class: 'btn', text: 'Add a note', onclick: function () { toggleNote(!noteOpen); } }),
          more)),
      noteBox, moveRow,
      h('ol', { class: 'pi-track', 'aria-label': 'Stages', style: '--n:' + Math.min(p.stages.length, 6) }, p.stages.map(function (s, i) {
        var ph = phase(i), r = redos(s);
        var said = ph === 'done' ? 'Done' + (spans[s.id] ? ' · ' + dur(spans[s.id]) : '') + (r ? ', ' + plural(r, 'redo', 'redos') : '')
          : ph === 'stuck' ? (it.status === 'stopped' ? 'Stopped here' : 'Stuck')
            : ph === 'need' ? 'Waiting on you'
              : ph === 'now' ? (turn ? 'Waiting on ' + waitsOn : it.startsAt ? 'Starts ' + new Date(it.startsAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : it.stageNote || (s.kind === 'people' ? 'Waiting on ' + who(s) : 'Working'))
                : timingText(s) || (i === it.stageIndex + 1 && active ? 'Next' : 'Later');
        return h('li', { class: 'pi-stage ' + ph, 'aria-current': i === it.stageIndex && active ? 'step' : null },
          h('span', { class: 'pi-sname' }, h('span', { class: 'pi-num', 'aria-hidden': 'true' }, ph === 'done' ? icon('tick', 11) : String(i + 1)), h('b', { text: s.name })),
          h('span', { class: 'pi-swho', text: whoLine(s) }),
          h('span', { class: 'pi-sstate', text: said }));
      })));

    // ---- The band: your call, or why it's stuck, or how it ended.
    var band = null;
    var votes = it.votes || [];
    var need = stage.kind === 'people' ? needOf(stage) : 1;
    var left = Math.max(1, need - votes.length);
    var nextStage = p.stages[it.stageIndex + 1];
    if (active && it.canDecide && stage.kind === 'people') {
      var rule = ruleText(stage);
      var sub = [who(stage) + (rule ? ', ' + rule : '') + '.'];
      if (votes.length) sub.push(votes.map(function (v) { return v.by + ' approved at ' + clock(v.at); }).join('; ') + (left === 1 ? ', so yours would settle it.' : '.'));
      sub.push('Waiting ' + dur(now_ - enteredAt) + '.');
      var earlier = p.stages.slice(0, it.stageIndex);
      var pick = backIndex(it.stageIndex);
      var why = h('textarea', { rows: '2', id: 'pi-why', placeholder: 'What needs to change, so the stage it goes back to knows' });
      var sendGo = h('button', { class: 'btn go' });
      var picks = h('div', { class: 'row', role: 'group', 'aria-label': 'Send back to', style: 'gap:6px' });
      var paintPicks = function () {
        fill(picks, earlier.map(function (s, i) {
          return h('button', { type: 'button', class: 'pi-pick', 'aria-pressed': i === pick ? 'true' : 'false', text: s.name, onclick: function () { pick = i; paintPicks(); } });
        }));
        sendGo.textContent = 'Send back to ' + (p.stages[pick] || {}).name;
      };
      paintPicks();
      sendGo.onclick = function () {
        if (!why.value.trim()) { fill(out, msg({ ok: false, error: 'Say what needs to change, so the stage it goes back to knows.' })); why.focus(); return; }
        var wanted = pick;
        act('sendBack', { note: why.value, stageIndex: wanted }, 'Sending back…', sendGo, function (x) {
          var landed = x.item && typeof x.item.stageIndex === 'number' ? x.item.stageIndex : wanted;
          state.procFlash = { id: it.id, text: landed === wanted ? 'Sent back to ' + p.stages[wanted].name + '.' : 'Sent back to ' + (p.stages[landed] || {}).name + ', where this stage sends things back.' };
        });
      };
      var sendBox = h('div', { class: 'pi-send', hidden: true },
        earlier.length > 1 ? [h('span', { class: 'pi-bandsub', text: 'Send it back to' }), picks] : null,
        h('label', { for: 'pi-why', class: 'pi-bandsub', text: 'What needs to change' }), why,
        h('div', { class: 'row', style: 'gap:8px' }, sendGo, h('button', { class: 'btn', text: 'Cancel', onclick: function () { toggleSend(false); } })));
      var sendBtn = h('button', { class: 'btn', text: 'Send back…', 'aria-expanded': 'false' });
      var toggleSend = function (open) { sendOpen = open; sendBox.hidden = !open; sendBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); if (open) why.focus(); };
      sendBtn.onclick = function () { toggleSend(!sendOpen); };
      var approve = h('button', { class: 'btn go', text: 'Approve' });
      approve.onclick = function () { act('approve', {}, 'Approving…', approve); };
      band = h('section', { class: 'pi-band need', 'aria-label': 'Your call' },
        h('div', { class: 'pi-bandrow' },
          h('span', { class: 'pi-bandic' }, icon('check', 18)),
          h('div', { class: 'pi-bandtext' }, h('b', { text: 'Your call: ' + stage.name.charAt(0).toLowerCase() + stage.name.slice(1) }), h('span', { class: 'pi-bandsub', text: sub.join(' ') })),
          h('div', { class: 'row', style: 'gap:8px' }, approve, earlier.length ? sendBtn : null,
            prUrl ? h('a', { class: 'btn', href: prUrl, target: '_blank', rel: 'noopener', text: prLabel }) : null)),
        earlier.length ? sendBox : null);
    } else if (turn) {
      var primary = stage.kind === 'worker' ? (stage.workerId ? 'Open ' + who(stage) : null) : it.taskId ? (it.ownerTurn === 'pack' ? 'Review the pack' : 'Open the task') : null;
      band = h('section', { class: 'pi-band ' + (it.yourTurn ? 'need' : 'wait'), 'aria-label': it.yourTurn ? 'Your turn' : 'Waiting' },
        h('div', { class: 'pi-bandrow' },
          h('span', { class: 'pi-bandic' }, icon(it.yourTurn ? 'check' : 'clock', 18)),
          h('div', { class: 'pi-bandtext' },
            h('b', { text: it.yourTurn ? 'Your turn: ' + turn[0] : 'Waiting on ' + waitsOn + ': ' + turn[0] }),
            h('span', { class: 'pi-bandsub', text: stage.name + ' · ' + who(stage) + (it.yourTurn ? ' stopped for you' : ' stopped for ' + waitsOn) + '. Waiting ' + dur(now_ - enteredAt) + '.' })),
          h('div', { class: 'row', style: 'gap:8px' },
            primary ? h('button', { class: 'btn' + (it.yourTurn ? ' go' : ''), text: primary, onclick: openStage }) : null,
            prUrl ? h('a', { class: 'btn', href: prUrl, target: '_blank', rel: 'noopener', text: prLabel }) : null)));
    } else if (active && it.blocked) {
      band = h('section', { class: 'pi-band bad', 'aria-label': 'Stuck' },
        h('div', { class: 'pi-bandrow' },
          h('span', { class: 'pi-bandic' }, icon('alert', 18)),
          h('div', { class: 'pi-bandtext' }, h('b', { text: 'Stuck at ' + stage.name }), h('span', { class: 'pi-bandsub', text: it.blocked })),
          h('div', { class: 'row', style: 'gap:8px' },
            it.canSteer && stage.kind !== 'people' ? h('button', { class: 'btn go', text: 'Start it again', onclick: function (e) { act('retry', {}, 'Starting…', e.target); } }) : null,
            it.taskId && stage.kind === 'team' ? h('button', { class: 'btn', text: 'Open the task', onclick: function () { openTask(it.taskId); } }) : null,
            moveRow ? h('button', { class: 'btn', text: 'Move it…', onclick: function () { moveRow.hidden = false; } }) : null)));
    } else if (!active) {
      var stopEv = it.history.filter(function (e) { return e.kind === 'stopped'; }).slice(-1)[0];
      band = h('section', { class: 'pi-band ' + (it.status === 'done' ? 'ok' : 'off') },
        h('div', { class: 'pi-bandrow' },
          h('span', { class: 'pi-bandic' }, icon(it.status === 'done' ? 'tick' : 'x', 18)),
          h('div', { class: 'pi-bandtext' }, h('b', { text: it.status === 'done' ? 'Made it through ' + p.name : 'Stopped at ' + stage.name }),
            h('span', { class: 'pi-bandsub', text: (it.status === 'stopped' && stopEv ? 'Stopped by ' + (isMe(stopEv.by) ? 'you' : stopEv.by) + (stopEv.note ? ': ' + stopEv.note : '') + ' · ' : '') + (it.finishedAt ? stamp(it.finishedAt) + ' · ' : '') + dur((it.finishedAt || it.updatedAt) - it.createdAt) + ' end to end' })),
          prUrl ? h('a', { class: 'btn', href: prUrl, target: '_blank', rel: 'noopener', text: prLabel }) : null));
    }

    // ---- What happens next, in sentences.
    var nextSteps = [];
    if (!active) nextSteps.push(it.status === 'done' ? 'Nothing: it made it through.' : 'Nothing: it was stopped.');
    else {
      if (it.blocked) nextSteps.push('It waits until someone starts ' + stage.name + ' again, moves it or stops it.');
      else if (stage.kind === 'people') {
        if (it.canDecide) nextSteps.push((left === 1 ? 'Your approval settles it' : 'It needs ' + left + ' more approvals, yours included') + (left === 1 ? (nextStage ? ', and it moves to ' + nextStage.name + '.' : ', and it is done.') : '.'));
        else nextSteps.push('Waiting on ' + who(stage) + (need > 1 ? ': ' + left + ' more to approve.' : ' to decide.'));
        if (it.stageIndex > 0) nextSteps.push('Sent back, it returns to ' + p.stages[backIndex(it.stageIndex)].name + ' with what they said.');
      } else if (it.startsAt) nextSteps.push(stage.name + ' starts ' + new Date(it.startsAt).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) + '.');
      else if (turn) nextSteps.push(stage.name + ' goes on once ' + (it.yourTurn ? 'you ' + turn[0] : waitsOn + ' ' + turn[1]) + '.');
      else nextSteps.push(who(stage) + ' finishes ' + stage.name + (stage.kind === 'team' ? ', and its owner signs off the pack.' : '.'));
      p.stages.slice(it.stageIndex + 1, it.stageIndex + 3).forEach(function (s) {
        var t = timingText(s);
        nextSteps.push(s.name + (s.kind === 'people' ? ': ' + who(s) + ' decide' : ': ' + who(s)) + (t ? ', ' + t : '') + '.');
      });
      if (it.stageIndex + 3 >= p.stages.length) nextSteps.push('Then it is done, and ' + (isMe(it.initiator.name) ? 'you are' : it.initiator.name + ' is') + ' told.');
    }

    // ---- Tabs.
    var journeyRows = [];
    var at_ = null;
    it.history.forEach(function (e, n) {
      var prev = it.history[n - 1];
      var row = { when: stamp(e.at), k: 'done', title: '', detail: e.note || '' };
      if (e.kind === 'submitted') { row.title = 'Put in by ' + (e.by || it.initiator.name); row.k = 'start'; row.detail = src ? 'Came in ' + src + '.' : brief1; }
      else if (e.kind === 'entered') {
        var s = stageById(e.stageId) || {};
        at_ = e.stageId;
        var again = prev && (prev.kind === 'sentBack' || prev.kind === 'moved' || prev.kind === 'retried');
        if (again) return;
        row.title = (s.name || 'A stage') + ' started';
        row.detail = s.kind ? whoLine(s) : '';
      } else if (e.kind === 'finished') {
        row.title = stageName(e.stageId) + ' handed on';
        row.art = arts.filter(function (a) { return a.stageId === e.stageId && Math.abs(a.at - e.at) < 5000; })[0] || null;
      }
      else if (e.kind === 'approved') { row.title = (isMe(e.by) ? 'You' : e.by) + ' approved' + (at_ ? ' ' + stageName(at_) : ''); }
      else if (e.kind === 'sentBack') { row.title = 'Sent back to ' + stageName(e.stageId) + ' by ' + (isMe(e.by) ? 'you' : e.by); row.k = 'redo'; row.tag = 'Redo'; row.detail = e.note ? '“' + e.note + '”' : ''; }
      else if (e.kind === 'retried') { row.title = stageName(at_) + ' started again by ' + e.by; row.k = 'redo'; row.tag = 'Redo'; }
      else if (e.kind === 'moved') { row.title = 'Moved to ' + stageName(e.stageId) + (e.by ? ' by ' + e.by : ''); row.k = 'note'; }
      else if (e.kind === 'blocked') { row.title = 'Stuck at ' + stageName(e.stageId || at_); row.k = 'redo'; }
      else if (e.kind === 'note') { row.title = 'Note from ' + (isMe(e.by) ? 'you' : e.by); row.k = 'note'; }
      else if (e.kind === 'stopped') { row.title = 'Stopped by ' + e.by; row.k = 'redo'; }
      else if (e.kind === 'done') { row.title = 'Made it through ' + p.name; }
      else row.title = e.kind;
      journeyRows.push(row);
    });
    if (active) journeyRows.push({ when: 'now', k: mineNow ? 'need' : it.blocked ? 'redo' : 'now', tag: 'Now', detail: nextSteps[0],
      title: it.blocked ? 'Stuck at ' + stage.name : turn ? (it.yourTurn ? 'Your turn: ' + turn[0] : 'Waiting on ' + waitsOn + ': ' + turn[0]) : it.canDecide ? 'Waiting on you' : stage.name + (it.stageNote ? ': ' + it.stageNote : '') });

    var nHanded = arts.reduce(function (n, a) { return n + 1 + (a.files || []).length; }, 0);
    var stageWho = function (a) { var s = stageById(a.stageId); return s ? who(s) : ''; };

    if (state.procItemFor !== it.id) { state.procItemTab = 'where'; state.procItemFor = it.id; }
    var tab = state.procItemTab || 'where';
    var TABS = [['where', it.status === 'done' ? 'Outcome' : 'Where it stands', 0], ['journey', 'Journey', journeyRows.length], ['files', 'Handed on', nHanded], ['brief', 'The request', 0]];
    var tabs = h('div', { class: 'pi-tabs', role: 'tablist', 'aria-label': 'Item views' }, TABS.map(function (t) {
      return h('button', { type: 'button', role: 'tab', 'aria-selected': tab === t[0] ? 'true' : 'false', onclick: function () { state.procItemTab = t[0]; render(); } },
        t[1], t[2] ? h('span', { class: 'pi-count', text: String(t[2]) }) : null);
    }));

    var body;
    if (tab === 'journey') {
      body = h('ol', { class: 'pi-card pi-journey' }, journeyRows.map(function (j) {
        return h('li', { class: j.k },
          h('span', { class: 'pi-jdot', 'aria-hidden': 'true' }),
          h('div', { class: 'pi-jbody' },
            h('span', { class: 'pi-jhead' }, h('b', { text: j.title }), h('span', { class: 'faint', text: j.when }), j.tag ? h('span', { class: 'pi-tag ' + j.k, text: j.tag }) : null),
            j.detail ? h('span', { class: 'pi-jdetail', text: clip(j.detail, 400) }) : null,
            j.art ? fileList(j.art) : null));
      }));
    } else if (tab === 'files') {
      body = arts.length ? h('div', { class: 'stack', style: 'gap:12px' },
        allFiles.length > 1 ? h('div', { class: 'row' }, h('button', { class: 'btn small', text: 'Download all ' + allFiles.length + ' files', onclick: downloadAll })) : null,
        arts.slice().reverse().map(function (a) {
          return h('section', { class: 'pi-card pi-art' },
            h('div', { class: 'pi-arthead' },
              h('div', { class: 'pi-vname' }, h('b', { text: a.title }), h('span', { class: 'faint', text: [a.stageName, stageWho(a), stamp(a.at)].filter(Boolean).join(' · ') })),
              teamArt(a) ? h('button', { class: 'btn small quiet', text: 'Open the task', onclick: function () { openTask(a.taskId); } }) : null),
            mdBlock(a.summary), fileList(a),
            a.branch ? h('span', { class: 'faint' }, 'Code on ', h('code', { text: a.branch })) : null);
        })) : h('div', { class: 'pi-card muted', text: 'Nothing handed on yet. Each stage’s pack shows here when it finishes.' });
    } else if (tab === 'brief') {
      body = h('div', { class: 'pi-card stack', style: 'gap:8px' },
        h('span', { class: 'label', text: 'The request · from ' + it.initiator.name }),
        h('p', { class: 'pi-req', text: it.brief }),
        it.sourceUrl ? h('a', { href: it.sourceUrl, target: '_blank', rel: 'noopener', text: 'Where it came from' }) : null,
        it.fromItemId ? h('span', { class: 'faint', text: 'Reopened from an earlier item.' }) : null);
    } else {
      var lead = last ? [mdBlock(last.summary, true), fileList(last)]
        : h('div', { class: 'pi-lead' }, h('p', { text: it.blocked || (active ? (stage.kind === 'people' ? 'Nothing handed on yet: ' + who(stage) + ' decide at ' + stage.name + ' on the request itself.' : 'Nothing handed on yet. ' + who(stage) + ' is on ' + stage.name + '.') : 'It ended before any stage handed anything on.') }));
      var chips = [];
      if (prUrl) chips.push(h('a', { class: 'pi-chip', href: prUrl, target: '_blank', rel: 'noopener', text: prLabel.replace(/^Open /, '') }));
      if (branch) chips.push(h('span', { class: 'pi-chip' }, 'Branch ', h('code', { text: branch })));
      if (last && teamArt(last)) chips.push(h('button', { type: 'button', class: 'pi-chip', text: 'Open ' + last.stageName + '’s task', onclick: function () { openTask(last.taskId); } }));
      if (!active && allFiles.length > 1) chips.push(h('button', { type: 'button', class: 'pi-chip', text: 'Download everything · ' + plural(allFiles.length, 'file', 'files'), onclick: downloadAll }));
      var cards = [];
      if (active && stage.kind === 'people') {
        var rows = [];
        var seen = {};
        votes.forEach(function (v) { seen[v.by.toLowerCase()] = 1; rows.push({ name: v.by, note: clock(v.at) + (v.note ? ' · “' + v.note + '”' : ''), st: 'ok', said: 'Approved' }); });
        (stage.approvers || []).forEach(function (a) {
          if (seen[a.name.toLowerCase()]) return;
          var you = isMe(a.name);
          rows.push({ name: a.name, note: you && it.canDecide ? 'Asked in Slack and here' : '', st: votes.length >= need ? 'off' : 'need', said: votes.length >= need ? 'Not needed' : 'Waiting' });
        });
        (stage.approverGroups || []).forEach(function (g) { rows.push({ name: 'Anyone in ' + g.name, note: '', st: 'need', said: 'Waiting', group: true }); });
        cards.push(h('div', { class: 'pi-card pi-mini' },
          h('span', { class: 'label pi-need', text: need > 1 ? 'The vote · ' + votes.length + ' of ' + need + ' needed' : 'The decision · ' + (ruleText(stage) || 'theirs') }),
          rows.map(function (r) {
            return h('div', { class: 'pi-voter' }, r.group ? h('span', { class: 'pi-badge P', text: 'G', 'aria-hidden': 'true' }) : avatar('', r.name, 's'),
              h('span', { class: 'pi-vname' }, h('span', { text: isMe(r.name) ? 'You' : r.name }), r.note ? h('span', { class: 'faint', text: r.note }) : null),
              h('span', { class: 'pi-tag ' + r.st, text: r.said }));
          })));
      } else if (active) {
        cards.push(h('div', { class: 'pi-card pi-mini' },
          h('span', { class: 'label', text: 'Now · ' + stage.name }),
          h('span', { text: turn ? 'Waiting on ' + (it.yourTurn ? 'you' : waitsOn) + ' to ' + turn[0] + '.' : it.startsAt ? it.stageNote || 'Waiting to start.' : who(stage) + (stage.kind === 'people' ? ' decide' : !it.stageNote || it.stageNote === 'Working' ? ' is on it' : ': ' + it.stageNote) + '.' }),
          h('span', { class: 'faint', text: 'At this stage ' + dur(now_ - enteredAt) + (redos(stage) ? ' · ' + plural(redos(stage), 'redo', 'redos') : '') }),
          it.taskId && stage.kind === 'team' ? h('button', { class: 'btn small', style: 'align-self:flex-start', text: 'Open the task', onclick: function () { openTask(it.taskId); } }) : null));
      }
      cards.push(h('div', { class: 'pi-card pi-mini' }, h('span', { class: 'label', text: 'Handed on so far' }),
        arts.length ? arts.map(function (a) { return h('div', { class: 'pi-handed' }, h('b', { text: a.stageName }), h('span', { class: 'muted', text: clip(firstLine(a.summary), 160) })); })
          : h('span', { class: 'muted', text: 'Nothing yet.' })));
      cards.push(h('div', { class: 'pi-card pi-mini' }, h('span', { class: 'label pi-go', text: 'What happens next' }),
        nextSteps.map(function (x) { return h('div', { class: 'pi-nextrow' }, h('span', { class: 'pi-ndot', 'aria-hidden': 'true' }), h('span', { text: x })); })));
      var standLabel = it.status === 'done' ? 'The outcome' : it.status === 'stopped' ? 'Where it stopped' : 'Where it stands';
      var stand = h('div', { class: 'pi-card pi-stand' },
        h('span', { class: 'label', text: standLabel + (last ? ' · from ' + last.stageName : '') }),
        lead,
        chips.length ? h('div', { class: 'row', style: 'gap:8px' }, chips) : null);
      // Finished: the outcome, then a line per earlier stage that opens to what it handed on.
      body = active ? h('div', { class: 'stack', style: 'gap:14px' }, stand, h('div', { class: 'pi-cards' }, cards))
        : h('div', { class: 'stack', style: 'gap:14px' }, stand,
          arts.length > 1 ? h('div', { class: 'pi-card pi-earlier' },
            h('span', { class: 'label', text: 'Along the way' }),
            arts.slice(0, -1).map(function (a) {
              var n = (a.files || []).length;
              return h('details', { class: 'pi-step' },
                h('summary', null, h('b', { text: a.stageName }), h('span', { class: 'faint', text: [stageWho(a), n ? plural(n, 'file', 'files') : null, stamp(a.at)].filter(Boolean).join(' · ') })),
                h('div', { class: 'pi-stepbody' }, a.title !== a.stageName ? h('b', { text: a.title }) : null, mdBlock(a.summary), fileList(a),
                  teamArt(a) ? h('button', { class: 'btn small quiet', style: 'align-self:flex-start', text: 'Open the task', onclick: function () { openTask(a.taskId); } }) : null));
            })) : null);
    }

    // ---- Beside it: who does each stage, and where the time went.
    var crew = h('div', { class: 'pi-card pi-side' }, h('span', { class: 'label', text: 'Who does what' }), p.stages.map(function (s, i) {
      var ph = phase(i), t = spans[s.id];
      var took = ph === 'done' ? (t ? dur(t) : 'done') : ph === 'next' ? (i === it.stageIndex + 1 && active ? 'next' : '') : t ? dur(t) + (active ? ' so far' : '') : '';
      return h('div', { class: 'pi-crew' + (i === it.stageIndex && active ? ' on' : '') },
        h('span', { class: 'pi-badge ' + KIND_LETTER[s.kind], text: KIND_LETTER[s.kind], title: KIND_WORD[s.kind] }),
        h('span', { class: 'pi-vname' }, h('span', { class: 'pi-cstage', text: s.name }), h('span', { class: 'faint', text: whoLine(s) })),
        h('span', { class: 'pi-took', text: took }));
    }));
    var total = Math.max(0, (it.finishedAt || (active ? now_ : it.updatedAt)) - it.createdAt);
    var timed = p.stages.filter(function (s) { return spans[s.id] > 0; });
    var timeCard = h('div', { class: 'pi-card pi-side' }, h('span', { class: 'label', text: 'Time so far' }),
      timed.length ? h('div', { class: 'pi-bar', role: 'img', 'aria-label': 'Time in each stage' }, timed.map(function (s) {
        return h('span', { class: KIND_LETTER[s.kind], style: 'flex:' + Math.max(1, Math.round(spans[s.id] / 60000)), title: s.name + ' · ' + dur(spans[s.id]) });
      })) : null,
      h('span', { class: 'faint', text: [dur(total) + ' in all'].concat(timed.map(function (s) {
        var r = redos(s);
        return s.name + ' ' + dur(spans[s.id]) + (active && s.id === stage.id ? ' so far' : '') + (r ? ', including ' + (r === 1 ? 'one redo' : r + ' redos') : '');
      })).join(' · ') }));

    var page = h('div', { class: 'pi-page' }, header, out, band,
      h('div', { class: 'pi-cols' },
        h('div', { class: 'pi-main' }, tabs, body),
        h('aside', { class: 'pi-aside', 'aria-label': 'Who does each stage' }, crew, timeCard)));

    // Keep it current while it's open, unless you're in the middle of something.
    var editing = function () {
      var el = document.activeElement;
      if (el && page.contains(el) && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'INPUT')) return true;
      if (noteOpen || (moveRow && !moveRow.hidden) || sendOpen) return true;
      return !!page.querySelector('.pi-menu:not([hidden])');
    };
    var painted = Date.now();
    var tick = function () {
      setTimeout(function () {
        if (!page.isConnected || !active) return;
        if (editing()) { tick(); return; }
        api('GET', '/api/processes/' + encodeURIComponent(p.id)).then(function (r) {
          if (!page.isConnected) return;
          var fresh = r && r.ok !== false ? (r.items || []).filter(function (x) { return x.id === it.id; })[0] : null;
          if (!fresh || editing() || (fresh.updatedAt === it.updatedAt && Date.now() - painted < 60000)) { tick(); return; }
          page.replaceWith(itemPage(r.process, fresh, procWho(r)));
        }, function () { tick(); });
      }, 10000);
    };
    tick();
    return page;
  }

  /// A stage's timing in words: "2 weeks after the stage before · weekly, 4 times".
  function timingText(s) {
    var span = function (d) { return d % 7 === 0 ? plural(d / 7, 'week', 'weeks') : plural(d, 'day', 'days'); };
    var parts = [];
    if (s.delayDays) parts.push(span(s.delayDays) + ' after the stage before');
    if (s.repeat) parts.push((s.repeat.everyDays === 7 ? 'weekly' : 'every ' + span(s.repeat.everyDays)) + ', ' + s.repeat.times + ' times');
    return parts.join(' · ');
  }

  /// Who the org knows: its people and its groups, fetched once a page.
  var directoryCache = null;
  function directory() {
    if (!directoryCache) directoryCache = api('GET', '/api/directory').then(function (x) { return x && x.ok !== false ? x : { people: [], groups: [] }; }, function () { return { people: [], groups: [] }; });
    return directoryCache;
  }

  /// A dropdown of people (and groups, when onGroup is given) that opens on
  /// click and narrows as you type: groups first, then the people the org
  /// knows, then anyone else in Slack. Calls pick with { name, slackUserId }
  /// and onGroup with { id, name }.
  function personPicker(label, pick, opts) {
    opts = opts || {};
    var q = h('input', { type: 'text', placeholder: opts.onGroup ? 'Pick a person or a group' : 'Pick a person', 'aria-label': label, autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false' });
    var list = h('div', { class: 'pp-list', role: 'listbox' });
    var box = h('div', { class: 'pp' }, q, list);
    var timer = null, seq = 0;
    var close = function () { list.textContent = ''; q.setAttribute('aria-expanded', 'false'); };
    var choose = function (fn, v) { close(); q.value = ''; fn(v); };
    var option = function (main, sub, fn) { return h('button', { type: 'button', role: 'option', class: 'pp-opt', onmousedown: function (e) { e.preventDefault(); }, onclick: fn }, main, sub ? h('span', { class: 'pp-sub', text: sub }) : null); };
    var draw = function () {
      var term = q.value.trim().toLowerCase();
      var mine = ++seq;
      directory().then(function (d) {
        if (mine !== seq) return;
        var has = function (n) { return !term || n.toLowerCase().indexOf(term) >= 0; };
        var groups = opts.onGroup ? d.groups.filter(function (g) { return has(g.name); }) : [];
        var people = d.people.filter(function (p) { return has(p.name); }).slice(0, 8);
        var items = [];
        if (groups.length) items.push(h('div', { class: 'pp-head', text: 'Groups' }));
        groups.forEach(function (g) {
          items.push(option(h('span', { class: 'pp-main' }, h('span', { class: 'pp-gi', 'aria-hidden': 'true' }, icon('team', 14)), h('span', { class: 'pp-text' }, h('b', { text: g.name }),
            h('span', { class: 'pp-sub', text: plural(g.members.length, 'person', 'people') + ' · ' + g.members.slice(0, 4).map(function (m) { return m.name; }).join(', ') + (g.members.length > 4 ? '…' : '') }))), null,
            function () { choose(opts.onGroup, { id: g.id, name: g.name }); }));
        });
        if (people.length) items.push(h('div', { class: 'pp-head', text: 'People' }));
        people.forEach(function (p) { items.push(option(h('span', { class: 'pp-main' }, avatar(p.slackUserId, p.name, 's'), h('span', { class: 'pp-text' }, h('b', { text: p.name }))), null, function () { choose(pick, p); })); });
        var shown = function (extra) {
          var all = items.concat(extra);
          if (term.length >= 2) all.push(option(h('span', { class: 'pp-main' }, h('span', { class: 'pp-text' }, h('b', { text: 'Use “' + q.value.trim() + '”' }), h('span', { class: 'pp-sub', text: 'Not in Slack, so no DMs' }))), null, function () { choose(pick, { name: q.value.trim() }); }));
          if (!all.length) all.push(h('div', { class: 'pp-head', text: 'Type a name to search Slack' }));
          fill(list, all);
          q.setAttribute('aria-expanded', 'true');
        };
        shown([]);
        // Anyone else in the workspace, once there's something to search for.
        if (term.length < 2) return;
        clearTimeout(timer);
        timer = setTimeout(function () {
          api('GET', '/api/slack-people?q=' + encodeURIComponent(term)).then(function (x) {
            if (mine !== seq) return;
            var known = {};
            d.people.forEach(function (p) { known[p.slackUserId] = true; });
            var more = ((x && x.people) || []).filter(function (p) { return !known[p.id]; });
            if (!more.length) return;
            shown([h('div', { class: 'pp-head', text: 'Others in Slack' })].concat(more.map(function (p) {
              return option(h('span', { class: 'pp-main' }, avatar(p.id, p.name, 's'), h('span', { class: 'pp-text' }, h('b', { text: p.name }), h('span', { class: 'pp-sub', text: '@' + p.handle }))), null, function () { choose(pick, { name: p.name, slackUserId: p.id }); });
            })));
          });
        }, 200);
      });
    };
    // quiet: open on a click or typing, not on focus alone.
    if (opts.quiet) q.onclick = draw; else q.onfocus = draw;
    q.oninput = draw;
    q.onblur = function () { setTimeout(close, 150); };
    q.onkeydown = function (e) {
      if (e.key === 'Escape') { close(); q.blur(); }
      if (e.key === 'ArrowDown') { var first = list.querySelector('.pp-opt'); if (first) { e.preventDefault(); first.focus(); } }
    };
    list.onkeydown = function (e) {
      var opts_ = [].slice.call(list.querySelectorAll('.pp-opt'));
      var at = opts_.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && at < opts_.length - 1) { e.preventDefault(); opts_[at + 1].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); if (at > 0) opts_[at - 1].focus(); else q.focus(); }
      if (e.key === 'Escape') { close(); q.focus(); }
    };
    return box;
  }

  /// Words that say what something is about, for matching a stage to who
  /// could do it: lower case, four letters or more, minus the filler.
  var MATCH_NOISE = { with: 1, that: 1, this: 1, from: 1, what: 1, when: 1, them: 1, they: 1, each: 1, into: 1, your: 1, their: 1, have: 1, will: 1, more: 1, says: 1, writer: 1, analyst: 1, reviewer: 1, manager: 1, lead: 1, specialist: 1, engineer: 1, builder: 1, turns: 1, makes: 1, write: 1, writes: 1, stage: 1, team: 1, work: 1, needs: 1, needed: 1, about: 1, should: 1 };
  function matchWords(text) {
    var out = {};
    String(text || '').toLowerCase().split(/[^a-z0-9/]+/).forEach(function (w) {
      if (w.length < 4 || MATCH_NOISE[w]) return;
      out[w.replace(/(ing|ers|er|es|s)$/, '')] = w;
    });
    return out;
  }

  /// Pick who does a stage: each option says what it does, the best fits for
  /// this stage come first with the words they share, and a box narrows it.
  /// items: { id, name, about, text }; current: an id; onPick(id).
  /// roleHint: who does the stage, as the picture it was drafted from
  /// says, shown while nobody is picked.
  function doerPicker(label, items, current, stageText, onPick, roleHint) {
    var want = matchWords(stageText);
    var ranked = items.map(function (it) {
      var have = matchWords(it.text);
      var hits = Object.keys(want).filter(function (k) { return have[k]; }).map(function (k) { return want[k]; });
      return { it: it, hits: hits };
    });
    var good = ranked.filter(function (r) { return r.hits.length >= 2; }).sort(function (a, b) { return b.hits.length - a.hits.length; }).slice(0, 3);
    var chosen = items.filter(function (x) { return x.id === current; })[0];
    var wrap = h('div', { class: 'dp' });
    var panel = null;
    var close = function () { if (panel) { panel.remove(); panel = null; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); } };
    var outside = function (e) { if (!wrap.contains(e.target)) close(); };
    var face = function (it) { return avatar(it.id, it.name, 'm'); };
    var btn = h('button', { type: 'button', class: 'dp-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label },
      chosen ? face(chosen) : h('span', { class: 'dp-none', 'aria-hidden': 'true' }, icon('plus', 16)),
      h('span', { class: 'dp-text' }, h('b', { text: chosen ? chosen.name : label }), h('span', { class: 'dp-about', text: chosen ? chosen.about || '' : (roleHint ? 'The picture says: ' + roleHint + '. ' : '') + (good.length ? plural(good.length, 'good match', 'good matches') + ' for this stage' : 'See what each one does') })),
      h('span', { class: 'dp-chev', 'aria-hidden': 'true' }, icon('back', 14)));
    var open = function () {
      if (panel) { close(); return; }
      var q = h('input', { type: 'text', placeholder: 'Search by name or what it does', 'aria-label': 'Search', autocomplete: 'off' });
      var list = h('div', { class: 'dp-list', role: 'listbox' });
      var option = function (r, why) {
        return h('button', { type: 'button', role: 'option', class: 'dp-opt' + (r.it.id === current ? ' on' : ''), 'aria-selected': r.it.id === current ? 'true' : 'false', onclick: function () { close(); onPick(r.it.id); } },
          face(r.it),
          h('span', { class: 'dp-text' }, h('b', { text: r.it.name }), r.it.about ? h('span', { class: 'dp-about', text: r.it.about }) : null,
            why && r.hits.length ? h('span', { class: 'dp-why' }, icon('tick', 11), 'Fits: ' + r.hits.slice(0, 4).join(', ')) : null),
          r.it.id === current ? h('span', { class: 'dp-on', 'aria-hidden': 'true' }, icon('tick', 14)) : null);
      };
      var drawList = function () {
        var term = q.value.trim().toLowerCase();
        var has = function (r) { return !term || (r.it.name + ' ' + (r.it.text || '')).toLowerCase().indexOf(term) >= 0; };
        var out = [];
        var top = term ? [] : good;
        if (top.length) out.push(h('div', { class: 'pp-head', text: 'Good matches for this stage' }), top.map(function (r) { return option(r, true); }));
        var rest = ranked.filter(function (r) { return has(r) && top.indexOf(r) < 0; }).sort(function (a, b) { return a.it.name.localeCompare(b.it.name); });
        if (rest.length) out.push(h('div', { class: 'pp-head', text: top.length ? 'Everyone else' : 'All' }), rest.map(function (r) { return option(r, !!term); }));
        if (!out.length) out.push(h('p', { class: 'faint', style: 'margin:10px', text: 'Nothing matches “' + q.value.trim() + '”.' }));
        fill(list, out);
      };
      q.oninput = drawList;
      q.onkeydown = function (e) { if (e.key === 'Escape') { close(); btn.focus(); } if (e.key === 'ArrowDown') { var f = list.querySelector('.dp-opt'); if (f) { e.preventDefault(); f.focus(); } } };
      list.onkeydown = function (e) {
        var all = [].slice.call(list.querySelectorAll('.dp-opt')), at = all.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' && at < all.length - 1) { e.preventDefault(); all[at + 1].focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (at > 0) all[at - 1].focus(); else q.focus(); }
        if (e.key === 'Escape') { close(); btn.focus(); }
      };
      drawList();
      panel = h('div', { class: 'dp-panel' }, h('div', { class: 'dp-search' }, icon('search', 14), q), list);
      wrap.appendChild(panel);
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', outside);
      setTimeout(function () { q.focus(); }, 0);
    };
    btn.onclick = open;
    append(wrap, btn);
    return wrap;
  }

  /// Who can see and start a process, in a few words.
  function accessText(a) {
    if (!a || a.who === 'everyone') return 'Open to everyone';
    if (a.who === 'private') return 'Private';
    var names = (a.groups || []).map(function (g) { return g.name; }).concat((a.people || []).map(function (x) { return x.name; }));
    return 'Open to ' + (names.length > 3 ? names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' others' : names.join(', '));
  }

  function groupChip(g, remove) {
    return h('span', { class: 'pp-chip group' }, h('span', { class: 'pp-gi', 'aria-hidden': 'true' }, icon('team', 12)), g.name, remove ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + g.name, onclick: remove }, icon('x', 12)) : null);
  }

  function personChip(p, remove) {
    return h('span', { class: 'pp-chip' }, avatar(p.slackUserId || p.name, p.name, 's'), p.name, remove ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + p.name, onclick: remove }, icon('x', 12)) : null);
  }

  /// The editor: the process as a map you can see (where work comes in,
  /// each stage, done), and below it the one stage you picked. The map
  /// wraps rather than scrolling sideways.
  /// The process library: how SaaS teams commonly run work across teams, to
  /// start from. A card per process by category; one opened says when to use
  /// it, why each stage is there, and which of your teams fits each stage.
  function viewProcLibrary() {
    if (state.libId) return viewLibraryProcess();
    return api('GET', '/api/process-library').then(function (r) {
      if (r.ok === false) return [msg(r)];
      var cats = [];
      r.library.forEach(function (p) { if (cats.indexOf(p.category) < 0) cats.push(p.category); });
      return [
        head('Process library', 'Ways SaaS teams commonly run work that crosses teams. Each one says when to use it and why each stage is there, and suggests which of your teams fits each stage.',
          h('button', { class: 'btn', onclick: fromImageDialog }, icon('image', 16), 'From an image'), 'Processes'),
        h('div', { class: 'stack', style: 'gap:26px' }, cats.map(function (c) {
          return h('section', { class: 'stack', style: 'gap:10px', 'aria-label': c },
            h('h2', { class: 'section-title', text: c }),
            h('div', { class: 'tmgrid' }, r.library.filter(function (p) { return p.category === c; }).map(function (p) {
              var open_ = function () { go('proclib', { libId: p.id }); };
              return openCard('tmcard prc', 'Look closer at ' + p.name, open_,
                h('div', { style: 'min-width:0' }, h('span', { class: 'tmname', text: p.name }), h('p', { class: 'tmpurpose', text: p.summary })),
                h('ol', { class: 'prc-strip', 'aria-label': 'Stages' }, p.stages.map(function (s) {
                  return h('li', { class: s.kind }, h('span', { class: 'prc-ic', 'aria-hidden': 'true' }, icon(s.kind === 'people' ? 'person' : 'team', 13)), h('span', { class: 'prc-sn', text: s.name }));
                })),
                h('div', { class: 'tmfoot' },
                  h('button', { class: 'btn small go', text: 'Use this', onclick: function (e) { e.stopPropagation(); go('processedit', { processId: null, processFrom: p.id }); } })));
            })));
        }))
      ];
    });
  }

  function viewLibraryProcess() {
    return api('GET', '/api/process-library/' + encodeURIComponent(state.libId)).then(function (r) {
      if (r.ok === false) return [msg(r)];
      var p = r.process, fits = {};
      (r.fits || []).forEach(function (f) { fits[f.key] = f; });
      var use = h('button', { class: 'btn go', text: 'Use this process', onclick: function () { go('processedit', { processId: null, processFrom: p.id }); } });
      var stages = h('ol', { class: 'lib-stages' }, p.stages.map(function (s, i) {
        var f = fits[s.key] || {};
        var suggest = s.kind === 'people'
          ? h('div', { class: 'lib-fit' }, icon('person', 14), h('span', null, 'Usually decided by ', h('b', { text: s.who })))
          : f.team
            ? h('div', { class: 'lib-fit ok' }, icon('team', 14), h('span', null, h('b', { text: f.team.name }), ' fits. Led by your ', s.who.toLowerCase(), '.'))
            : h('div', { class: 'lib-fit gap' }, icon('team', 14),
              h('span', { style: 'flex:1;min-width:0' }, 'No team of yours fits yet. It needs: ', (s.crew || []).join(', '), '.'),
              h('button', { class: 'btn small', text: 'Make this team', onclick: function () { go('newteam', { teamRunId: null, newTeamPrefill: { name: s.name, purpose: s.ask } }); } }));
        return h('li', { class: 'lib-stage ' + s.kind },
          h('span', { class: 'pm-num big ' + s.kind, text: String(i + 1) }),
          h('div', { class: 'stack', style: 'gap:6px;min-width:0;flex:1' },
            h('div', { class: 'row', style: 'gap:8px' }, h('b', { style: 'font-size:15px', text: s.name }), h('span', { class: 'pm-kind ' + s.kind, text: s.kind === 'team' ? 'Team' : 'Decision' })),
            h('p', { style: 'margin:0', text: s.ask }),
            h('p', { class: 'muted', style: 'margin:0;font-size:13px' }, h('i', { text: 'Why: ' }), s.why),
            timingText(s) ? h('span', { class: 'pm-time' }, icon('clock', 12), timingText(s)) : null,
            suggest));
      }));
      return [
        h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Processes', onclick: function () { go('processes'); } }), ' / ',
              h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Library', onclick: function () { go('proclib', { libId: null }); } }), ' / ' + p.category),
            h('h1', { class: 'page-title', text: p.name }),
            h('p', { class: 'page-sub', text: p.summary })),
          use),
        h('div', { class: 'pm-body' },
          h('div', { class: 'stack', style: 'gap:14px;flex:999 1 560px;min-width:0' }, stages),
          h('aside', { class: 'pm-side' },
            h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'label', text: 'When to use it' }), h('p', { style: 'margin:0;font-size:13.5px', text: p.about })),
            h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'label', text: 'What goes in' }), h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: p.intake })),
            h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'label', text: 'What comes out' }), h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: p.outcome }))))
      ];
    });
  }

  function viewProcessEdit() {
    directoryCache = null;
    var editing = !!state.processId;
    if (state.processTemplate) { state.processFrom = 'idea-to-launch'; state.processTemplate = false; }
    var from = editing ? null : state.processFrom;
    state.processFrom = null;
    // A draft read from a picture (fromImageDialog), unsaved: the editor
    // opens with it once.
    var fromPicture = editing ? null : state.processDraft;
    state.processDraft = null;
    return Promise.all([editing ? api('GET', '/api/processes/' + encodeURIComponent(state.processId)) : Promise.resolve(null), api('GET', '/api/teams'),
      api('GET', '/api/process-library').catch(function () { return {}; }), from ? api('GET', '/api/process-library/' + encodeURIComponent(from)) : Promise.resolve(null),
      api('GET', '/api/workers').catch(function () { return []; }), api('GET', '/api/repos').catch(function () { return { ok: false }; })]).then(function (r) {
      if (r[0] && r[0].ok === false) return [msg(r[0])];
      var places = r[5] && r[5].ok !== false ? r[5] : { repos: [], workspaces: [] };
      var teams = Array.isArray(r[1]) ? r[1] : [];
      var library = r[2] && r[2].library ? r[2].library : [];
      var picked = r[3] && r[3].ok !== false ? r[3] : null;
      var workers = (Array.isArray(r[4]) ? r[4] : []).filter(function (w) { return w.enabled; });
      var teamName = {}, workerName = {};
      teams.forEach(function (t) { teamName[t.id] = t.name; });
      workers.forEach(function (w) { workerName[w.id] = w.name; });
      var p = r[0] ? r[0].process : null;
      var me = state.me || { name: 'You' };
      var model;
      /// Who does each stage in the picture, by stage id, when none of
      /// yours clearly fit: shown in its doer picker.
      var roleHint = {};
      if (p) model = JSON.parse(JSON.stringify({ name: p.name, purpose: p.purpose || '', about: p.about, templateId: p.templateId, owner: p.owner, stages: p.stages }));
      if (p) model.codeIn = p.codeIn ? p.codeIn.name : '';
      // Made before processes had an audience: open to everyone, as it was.
      if (p) model.access = p.access ? JSON.parse(JSON.stringify(p.access)) : { who: 'everyone' };
      else if (picked) {
        var fit = {};
        (picked.fits || []).forEach(function (f) { fit[f.key] = f; });
        model = { name: picked.process.name, purpose: picked.process.summary, about: picked.process.about, templateId: picked.process.id, owner: { name: me.name, slackUserId: me.slackUserId },
          stages: picked.process.stages.map(function (s) {
            var st = { id: s.key, name: s.name, kind: s.kind, ask: s.ask, why: s.why };
            if (s.delayDays) st.delayDays = s.delayDays;
            if (s.repeat) st.repeat = s.repeat;
            if (s.kind === 'people') st.approvers = [];
            else if (fit[s.key] && fit[s.key].team) st.teamId = fit[s.key].team.id;
            return st;
          }) };
      } else if (fromPicture) {
        model = { name: fromPicture.draft.name || '', purpose: fromPicture.draft.about || '', owner: { name: me.name, slackUserId: me.slackUserId },
          stages: (fromPicture.draft.stages || []).map(function (s) {
            var st = JSON.parse(JSON.stringify(s));
            if (st.suggestedRole) roleHint[st.id] = st.suggestedRole;
            delete st.suggestedRole;
            if (st.kind === 'people' && !st.approvers) st.approvers = [];
            return st;
          }) };
      } else model = { name: '', purpose: '', owner: { name: me.name, slackUserId: me.slackUserId }, stages: [] };
      // A new process is its owner's alone until they open it up.
      if (!model.access) model.access = { who: 'private' };
      // What the library says each stage needs: the crew for a team, who decides.
      var tmpl = library.filter(function (x) { return x.id === model.templateId; })[0];
      var hints = {};
      if (tmpl) tmpl.stages.forEach(function (s) { hints[s.key] = s; });
      var sel = 0;
      var seq = model.stages.length;
      var KIND = { team: 'Team', worker: 'Worker', people: 'Decision' };
      var ready = function (s) { return s.kind === 'team' ? !!teamName[s.teamId] : s.kind === 'worker' ? !!workerName[s.workerId] : (s.approvers || []).length + (s.approverGroups || []).length > 0; };
      var doer = function (s) {
        if (s.kind === 'team') return teamName[s.teamId] || 'Pick a team';
        if (s.kind === 'worker') return workerName[s.workerId] || 'Pick a worker';
        var names = (s.approverGroups || []).map(function (g) { return g.name; }).concat((s.approvers || []).map(function (a) { return a.name; }));
        return names.length ? names.join(', ') : 'Who decides?';
      };
      var backTo = function (i) {
        var s = model.stages[i];
        if (s.sendBackTo) { var hit = model.stages.filter(function (x) { return x.id === s.sendBackTo; })[0]; if (hit) return hit.name || 'an unnamed stage'; }
        for (var j = i - 1; j >= 0; j--) if (model.stages[j].kind !== 'people') return model.stages[j].name || 'the stage before';
        return 'the start';
      };

      var name = h('input', { type: 'text', class: 'pm-title', value: model.name, maxlength: '120', placeholder: 'Name the process', 'aria-label': 'Name', oninput: function () { model.name = name.value; } });
      var purpose = h('input', { type: 'text', class: 'pm-purpose', value: model.purpose, maxlength: '300', placeholder: 'What it takes in and what comes out', 'aria-label': 'What it is for', oninput: function () { model.purpose = purpose.value; } });
      // A person shown as a chip, with Change to pick someone else.
      var personSlot = function (label, get, set, fallback) {
        var slot = h('div', { class: 'pm-person' });
        var changing = false;
        var draw_ = function () {
          var who = get();
          fill(slot, changing
            ? [personPicker(label, function (x) { changing = false; set(x); draw_(); }), h('button', { type: 'button', class: 'linkish', text: 'Cancel', onclick: function () { changing = false; draw_(); } })]
            : [who ? personChip(who) : h('span', { class: 'muted', text: fallback }), h('button', { type: 'button', class: 'linkish', text: 'Change', onclick: function () { changing = true; draw_(); var q = slot.querySelector('input'); if (q) q.focus(); } }),
              who && fallback ? h('button', { type: 'button', class: 'linkish', text: 'Reset', onclick: function () { set(null); draw_(); } }) : null]);
        };
        draw_();
        return slot;
      };

      // Where its code lives: every team stage works there, each on the branch
      // the one before left. Library processes that change code ask for it.
      var codeRow = function () {
        var any = places.repos.length || places.workspaces.length;
        if (!any) return tmpl && tmpl.changesCode ? h('span', { class: 'faint', style: 'font-size:12.5px', text: 'This process changes code. Connect a repo under Setup → Repos so its stages share one branch.' }) : null;
        var sel = h('select', { 'aria-label': 'Code lives in', style: 'width:auto;max-width:280px', onchange: function () { model.codeIn = sel.value; } },
          h('option', { value: '', text: 'Each stage in its own place' }),
          (places.workspaces || []).map(function (w) { return h('option', { value: w.name, text: 'Workspace: ' + w.name, selected: model.codeIn === w.name }); }),
          places.repos.map(function (x) { return h('option', { value: x.name, text: 'Repo: ' + x.name, selected: model.codeIn === x.name }); }));
        return h('div', { class: 'pm-owner', title: 'Every team stage works here, starting from the branch the stage before it left, so a build, its tests and its release are one change.' },
          h('span', { class: 'faint', text: 'Code lives in' }), sel,
          tmpl && tmpl.changesCode && !model.codeIn ? h('span', { class: 'badge waiting', text: 'Pick one' }) : null);
      };
      if (model.codeIn === undefined) model.codeIn = '';
      var mapEl = h('div', { class: 'pm-map', role: 'list', 'aria-label': 'Stages in order' });
      var inspector = h('section', { class: 'pm-stage', 'aria-label': 'The stage you picked' });
      var readiness = h('section', { class: 'pm-side' });
      var footNote = h('span', { class: 'faint pm-footnote' });
      var draw = function () { drawMap(); drawStage(); drawReady(); };

      var addStage = function (k) {
        seq += 1;
        model.stages.push({ id: 's' + seq + '-' + Date.now().toString(36), name: k === 'people' ? 'New decision' : 'New stage', kind: k, approvers: k === 'people' ? [] : undefined });
        sel = model.stages.length - 1;
        draw();
      };
      var drawMap = function () {
        var nodes = model.stages.map(function (s, i) {
          return h('div', { class: 'pm-step', role: 'listitem' },
            h('span', { class: 'pm-arrow', 'aria-hidden': 'true' }),
            h('div', { class: 'pm-stack' },
              h('button', { type: 'button', class: 'pm-node ' + s.kind + (i === sel ? ' on' : ''), 'aria-pressed': i === sel ? 'true' : 'false', onclick: function () { sel = i; draw(); } },
                h('span', { class: 'pm-nodehead' },
                  h('span', { class: 'pm-num', text: String(i + 1) }),
                  h('span', { class: 'pm-kind', text: KIND[s.kind] }),
                  ready(s) ? null : h('span', { class: 'pm-warn', title: 'Needs setting up', 'aria-label': 'Needs setting up' })),
                h('span', { class: 'pm-name', text: s.name || 'Unnamed stage' }),
                h('span', { class: 'pm-who' + (ready(s) ? '' : ' missing'), text: doer(s) })),
              s.kind === 'people' ? h('span', { class: 'pm-back' }, h('span', { 'aria-hidden': 'true', text: '↩ ' }), 'Back to ' + backTo(i))
                : timingText(s) ? h('span', { class: 'pm-time' }, icon('clock', 11), timingText(s)) : null));
        });
        fill(mapEl, [h('div', { class: 'pm-end' }, h('span', { class: 'pm-dot' }, icon('inbox', 16)), h('span', { class: 'faint', text: 'Comes in' }))]
          .concat(nodes)
          .concat([h('div', { class: 'pm-step' }, h('span', { class: 'pm-arrow', 'aria-hidden': 'true' }), h('div', { class: 'pm-end' }, h('span', { class: 'pm-dot done' }, icon('tick', 16)), h('span', { class: 'faint', text: 'Done' })))]));
      };

      // One labelled row of the stage form: the label on the left, the
      // control and its one-line note on the right.
      var row = function (label, control, note) {
        return h('div', { class: 'pm-row' }, h('span', { class: 'pm-rl', text: label }),
          h('div', { class: 'pm-rc' }, control, note ? h('span', { class: 'faint pm-hint', text: note }) : null));
      };
      var drawStage = function () {
        if (!model.stages.length) {
          fill(inspector, [h('div', { class: 'pm-empty' }, h('b', { text: 'No stages yet' }), h('p', { class: 'muted', text: 'Add a stage above, or start from a process in the library.' }),
            h('button', { class: 'btn small', text: 'Browse the process library', onclick: function () { go('proclib', { libId: null }); } }))]);
          return;
        }
        sel = Math.max(0, Math.min(sel, model.stages.length - 1));
        var s = model.stages[sel], i = sel;
        var hint = hints[s.id];
        var setKind = function (k) { s.kind = k; if (k === 'people' && !s.approvers) s.approvers = []; draw(); };
        var move = function (d) { var j = i + d; if (j < 0 || j >= model.stages.length) return; model.stages[i] = model.stages[j]; model.stages[j] = s; sel = j; draw(); };
        var sname = h('input', { type: 'text', class: 'pm-sname', value: s.name || '', placeholder: 'Stage name', 'aria-label': 'Stage name', oninput: function () { s.name = sname.value; drawMap(); drawReady(); } });
        var kind = h('div', { class: 'seg', role: 'group', 'aria-label': 'Who does this stage' }, ['team', 'worker', 'people'].map(function (k) {
          return h('button', { type: 'button', 'aria-pressed': s.kind === k ? 'true' : 'false', onclick: function () { setKind(k); } }, k === 'team' ? 'A team' : k === 'worker' ? 'A worker' : 'People decide');
        }));
        var tools = h('span', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move earlier', disabled: i === 0, onclick: function () { move(-1); } }, icon('back', 15)),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move later', disabled: i === model.stages.length - 1, onclick: function () { move(1); } }, h('span', { style: 'display:inline-flex;transform:scaleX(-1)' }, icon('back', 15))),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove this stage', onclick: function () { model.stages.splice(i, 1); draw(); } }, icon('x', 15)));
        var ask = h('textarea', { rows: '3', 'aria-label': 'This stage’s job', placeholder: s.kind === 'people' ? 'What the deciders should look for.' : 'What this stage should produce.', oninput: function () { s.ask = ask.value; } });
        ask.value = s.ask || '';
        var rows = [];
        if (s.kind === 'team' || s.kind === 'worker') {
          var isTeam = s.kind === 'team';
          // What the stage is about, for ranking who fits: its name and job,
          // and what the library says it needs.
          var about = [s.name, s.ask || '', roleHint[s.id] || '', hint ? (hint.words || []).join(' ') + ' ' + (hint.crew || []).join(' ') : ''].join(' ');
          var options = isTeam
            ? teams.map(function (t) {
                var roles = (t.members || []).map(function (m) { return m.role; }).filter(Boolean);
                return { id: t.id, name: t.name, about: t.purpose || (t.members || []).map(function (m) { return m.name; }).join(', '), text: [t.name, t.purpose || ''].concat(roles).join(' ') };
              })
            : workers.map(function (w) { return { id: w.id, name: w.name, about: w.tagline || '', text: w.name + ' ' + (w.tagline || '') }; });
          var pick = options.length
            ? doerPicker(isTeam ? 'Pick a team' : 'Pick a worker', options, isTeam ? s.teamId : s.workerId, about, function (id) { if (isTeam) s.teamId = id; else s.workerId = id; drawMap(); drawReady(); drawStage(); }, roleHint[s.id])
            : h('p', { class: 'muted', style: 'margin:6px 0 0', text: isTeam ? 'No teams yet.' : 'No workers yet.' });
          rows.push(row(isTeam ? 'Team' : 'Worker', pick, isTeam ? 'Briefed with this stage’s job and everything earlier stages produced.' : 'Asked to do this stage on its own: for a step one worker can handle.'));
          if (isTeam && hint && !s.teamId && (hint.crew || []).length) {
            rows.push(row('', h('div', { class: 'lib-fit gap' }, h('span', { style: 'flex:1;min-width:0' }, 'None of your teams fits yet. It needs: ' + hint.crew.join(', ') + '.'),
              h('button', { class: 'btn small', text: 'Make this team', onclick: function () { go('newteam', { teamRunId: null, newTeamPrefill: { name: s.name, purpose: s.ask || '' } }); } }))));
          }
          var waitSel = h('select', { 'aria-label': 'When it starts', onchange: function () { var d = Number(waitSel.value); if (d) s.delayDays = d; else delete s.delayDays; drawMap(); } },
            [[0, 'Right away'], [1, '1 day after the stage before'], [3, '3 days after'], [7, '1 week after'], [14, '2 weeks after'], [30, '30 days after'], [60, '60 days after'], [90, '90 days after']]
              .concat(s.delayDays && [0, 1, 3, 7, 14, 30, 60, 90].indexOf(s.delayDays) < 0 ? [[s.delayDays, s.delayDays + ' days after']] : [])
              .map(function (o) { return h('option', { value: String(o[0]), text: o[1], selected: (s.delayDays || 0) === o[0] }); }));
          var REPEATS = [['', 'Once'], ['7x2', 'Weekly, 2 times'], ['7x3', 'Weekly, 3 times'], ['7x4', 'Weekly, 4 times'], ['7x6', 'Weekly, 6 times'], ['7x8', 'Weekly, 8 times'], ['14x3', 'Every 2 weeks, 3 times'], ['14x6', 'Every 2 weeks, 6 times'], ['30x3', 'Monthly, 3 times'], ['30x6', 'Monthly, 6 times']];
          var cur = s.repeat ? s.repeat.everyDays + 'x' + s.repeat.times : '';
          if (cur && !REPEATS.some(function (o) { return o[0] === cur; })) REPEATS.push([cur, 'Every ' + s.repeat.everyDays + ' days, ' + s.repeat.times + ' times']);
          var repSel = h('select', { 'aria-label': 'How many times it runs', onchange: function () {
            if (!repSel.value) delete s.repeat; else { var pr = repSel.value.split('x'); s.repeat = { everyDays: Number(pr[0]), times: Number(pr[1]) }; }
            drawMap();
          } }, REPEATS.map(function (o) { return h('option', { value: o[0], text: o[1], selected: o[0] === cur }); }));
          rows.push(row('Timing', h('div', { class: 'row', style: 'gap:8px' }, h('span', { style: 'width:auto' }, waitSel), h('span', { style: 'width:auto' }, repSel)),
            'Wait for there to be something to look at, or run it several times, each run building on the last, before the item moves on.'));
          rows.push(row('Lead', personSlot('Who leads this stage', function () { return s.owner || null; }, function (x) { if (x) s.owner = x; else delete s.owner; }, isTeam ? 'The team’s manager' : 'The worker’s manager'),
            (isTeam ? 'Answers the team’s questions, approves its plan and signs off its pack.' : 'Answers the worker’s questions and approves what it does.') + (hint ? ' Usually the ' + hint.who.toLowerCase() + '.' : '')));
        } else {
          var chips = h('div', { class: 'row', style: 'gap:6px' });
          var changed = function () { drawApprovers(); drawMap(); drawReady(); };
          var drawApprovers = function () {
            s.approverGroups = s.approverGroups || [];
            fill(chips, s.approverGroups.map(function (g, n) { return groupChip(g, function () { s.approverGroups.splice(n, 1); changed(); }); })
              .concat(s.approvers.map(function (a, n) { return personChip(a, function () { s.approvers.splice(n, 1); changed(); }); }))
              .concat([personPicker('Add someone or a group who decides', function (x) {
                if (!s.approvers.some(function (a) { return a.slackUserId ? a.slackUserId === x.slackUserId : a.name === x.name; })) s.approvers.push(x);
                changed();
              }, { onGroup: function (g) { if (!s.approverGroups.some(function (x) { return x.id === g.id; })) s.approverGroups.push(g); changed(); } })]));
          };
          drawApprovers();
          var back = h('select', { 'aria-label': 'Send back goes to', onchange: function () { if (back.value) s.sendBackTo = back.value; else delete s.sendBackTo; drawMap(); } },
            h('option', { value: '', text: 'The stage before' }),
            model.stages.slice(0, i).filter(function (x) { return x.kind !== 'people'; }).map(function (x) { return h('option', { value: x.id, text: x.name || 'Unnamed stage', selected: s.sendBackTo === x.id }); }));
          rows.push(row('Who decides', chips, (hint ? 'Usually: ' + hint.who + '. ' : '') + (roleHint[s.id] ? 'The picture says: ' + roleHint[s.id] + '. ' : '') + 'Everyone here, and everyone in a group, gets a Slack DM with Approve, Send back and Stop. Groups are set under Setup → Rules.'));
          var needs = h('select', { 'aria-label': 'How many must approve', onchange: function () {
            if (needs.value === 'any') delete s.needs; else s.needs = needs.value === 'all' ? 'all' : Number(needs.value);
            drawReady();
          } },
            h('option', { value: 'any', text: 'Any one of them', selected: !s.needs || s.needs === 'any' }),
            h('option', { value: 'all', text: 'All of them', selected: s.needs === 'all' }),
            [2, 3, 4, 5].map(function (n) { return h('option', { value: String(n), text: 'At least ' + n, selected: s.needs === n }); }));
          rows.push(row('Approvals', needs, 'A send back or a stop from any one of them acts at once. Everyone’s approval is recorded on the item.'));
          rows.push(row('Send back to', back, 'Briefed with what the decider says needs to change.'));
        }
        rows.push(row(s.kind === 'people' ? 'Look for' : 'The job', ask, s.kind === 'people' ? null : 'Goes in the brief.'));
        fill(inspector, [
          h('div', { class: 'pm-stagehead' }, h('span', { class: 'pm-num big ' + s.kind, text: String(i + 1) }), sname, kind, tools),
          s.why ? h('p', { class: 'pm-why' }, h('b', { text: 'Why this stage. ' }), s.why) : null,
          h('div', { class: 'pm-rows' }, rows)
        ]);
      };
      var drawReady = function () {
        var missing = model.stages.map(function (s, i) { return { s: s, i: i }; }).filter(function (x) { return !ready(x.s); });
        var total = model.stages.length;
        var done = total - missing.length;
        footNote.textContent = !total ? 'Add a stage to start.' : missing.length ? plural(missing.length, 'stage needs', 'stages need') + ' setting up before items can run.' : 'Every stage is set.';
        fill(readiness, [
          h('div', { class: 'stack', style: 'gap:10px' },
            h('span', { class: 'label', text: 'Ready to make?' }),
            h('div', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' },
              h('div', { class: 'meter', style: 'flex:1' }, h('span', { style: 'width:' + (total ? Math.round(done / total * 100) : 0) + '%' })),
              h('span', { class: 'faint', style: 'font-size:12.5px;white-space:nowrap', text: done + ' of ' + total + ' set' })),
            missing.length ? h('ul', { class: 'pm-todo' }, missing.slice(0, 6).map(function (x) {
              return h('li', null, h('button', { type: 'button', class: 'linkish', onclick: function () { sel = x.i; draw(); }, text: (x.i + 1) + '. ' + (x.s.name || 'Unnamed stage') + ': ' + (x.s.kind === 'team' ? 'pick a team' : x.s.kind === 'worker' ? 'pick a worker' : 'say who decides') }));
            })) : null),
          model.about ? h('div', { class: 'stack', style: 'gap:6px;border-top:1px solid var(--line);padding-top:14px' },
            h('span', { class: 'label', text: 'When to use it' }), h('p', { style: 'margin:0;font-size:13px', text: model.about })) : null,
          h('div', { class: 'stack', style: 'gap:8px;border-top:1px solid var(--line);padding-top:14px' },
            h('span', { class: 'label', text: 'How an item moves' }),
            h('ol', { class: 'pm-rules' },
              h('li', { text: 'A team stage ends when its lead signs off the pack.' }),
              h('li', { text: 'A worker stage ends when the worker answers and any work it started is done.' }),
              h('li', { text: 'A decision ends when anyone deciding approves it.' }),
              h('li', { text: 'The owner can move, restart or stop any item, and hears when one is stuck.' })))
        ]);
      };
      draw();

      // A draft from a picture says so above the map, with what the reading
      // was unsure of, and keeps the picture to hand beside the editor.
      var pictureBanner = function () {
        if (!fromPicture) return null;
        var notes = fromPicture.notes || [];
        var viewer = h('aside', { class: 'pi-viewer', hidden: true, 'aria-label': 'Your picture' },
          h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { class: 'label', style: 'flex:1', text: 'Your picture' }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close the picture', onclick: function () { show(false); } }, icon('x', 15))),
          h('div', { class: 'pi-viewbody' }, h('img', { src: fromPicture.image, alt: 'The picture this process was drafted from' })));
        var show = function (open) { viewer.hidden = !open; document.body.classList.toggle('pi-open', open); };
        return [h('div', { class: 'pi-banner', role: 'status' },
          h('button', { type: 'button', class: 'pi-mini', title: 'Show it beside the editor', 'aria-label': 'Show your picture beside the editor', onclick: function () { show(viewer.hidden); } }, h('img', { src: fromPicture.image, alt: '' })),
          h('div', { class: 'stack', style: 'gap:6px;min-width:0;flex:1 1 300px' },
            h('b', { text: 'Drafted from your image — check each stage, who does it and where it sends work back' }),
            notes.length ? h('ul', { class: 'pi-notes' }, notes.map(function (n) { return h('li', { text: n }); })) : null,
            h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Nothing is saved until you make the process. Click the picture to keep it open beside the editor.' }))),
          viewer];
      };

      // Who can see the process and start items in it, from Slack or here: a
      // button beside Owner that says what it is now, opening a panel to change it.
      var ACCESS = [
        ['private', 'Private', 'Only the owner, whoever made it and admins.', 'lock'],
        ['team', 'A team', 'Everyone on the teams you pick, as they change.', 'team'],
        ['people', 'Certain people', 'The people and groups you name.', 'people'],
        ['everyone', 'Everyone', 'Anyone in the org.', 'globe']
      ];
      var accessOpt = function (who) { return ACCESS.filter(function (o) { return o[0] === who; })[0] || ACCESS[0]; };
      var creator = (p && p.creator) || (p ? null : { name: me.name, slackUserId: me.slackUserId });
      var accBtn = h('button', { type: 'button', class: 'acc-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
      var accPop = h('section', { class: 'acc-pop', role: 'dialog', 'aria-labelledby': 'acc-title', hidden: true });
      var accWrap = h('div', { class: 'menu-wrap' }, accBtn, accPop);
      var accOutside = function (e) { if (!accWrap.contains(e.target)) accClose(); };
      var accEsc = function (e) { if (e.key === 'Escape') { accClose(); accBtn.focus(); } };
      var accClose = function () {
        accPop.hidden = true; accBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', accOutside); document.removeEventListener('keydown', accEsc);
      };
      accBtn.onclick = function () {
        if (!accPop.hidden) { accClose(); return; }
        accPop.hidden = false; accBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', accOutside); document.addEventListener('keydown', accEsc);
        var first = accPop.querySelector('[aria-checked="true"]'); if (first) first.focus();
      };
      var drawAccess = function () {
        var a = model.access;
        a.groups = a.groups || []; a.people = a.people || [];
        var opt = accessOpt(a.who), listed = a.who === 'team' || a.who === 'people';
        var names = listed ? a.groups.map(function (g) { return g.name; }).concat(a.people.map(function (x) { return x.name; })) : [];
        fill(accBtn, [icon(opt[3], 15),
          h('span', { class: 'acc-what', text: a.who === 'team' && a.groups.length === 1 && !a.people.length ? a.groups[0].name : opt[1] }),
          names.length ? h('span', { class: 'acc-faces', 'aria-label': names.join(', ') }, names.slice(0, 3).map(function (n) { return avatar(n, n, 's'); })) : null,
          icon('chevron', 13)]);
        accBtn.setAttribute('aria-label', 'Who can see and start it: ' + opt[1] + (names.length ? ', ' + names.join(', ') : ''));
        var group = h('div', { class: 'acc-opts', role: 'radiogroup', 'aria-label': 'Who can see and start it' }, ACCESS.map(function (o) {
          var on = o[0] === a.who;
          return h('button', { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on ? '0' : '-1', class: 'acc-opt' + (on ? ' on' : ''),
            onclick: function () { a.who = o[0]; drawAccess(); var q = accPop.querySelector('.acc-opt.on'); if (q) q.focus(); },
            onkeydown: function (e) {
              var step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              var i = (ACCESS.indexOf(o) + step + ACCESS.length) % ACCESS.length;
              a.who = ACCESS[i][0]; drawAccess();
              var q = accPop.querySelector('.acc-opt.on'); if (q) q.focus();
            } },
            h('span', { class: 'acc-optname' }, icon(o[3], 14), o[1]), h('span', { class: 'acc-opthint', text: o[2] }));
        }));
        var field = listed ? h('div', { class: 'acc-list' },
          h('span', { class: 'acc-label', text: a.who === 'team' ? 'Teams' : 'People and groups' }),
          h('div', { class: 'acc-field' },
            a.groups.map(function (g, n) { return groupChip(g, function () { a.groups.splice(n, 1); drawAccess(); }); })
              .concat(a.people.map(function (x, n) { return personChip(x, function () { a.people.splice(n, 1); drawAccess(); }); }))
              .concat([personPicker(a.who === 'team' ? 'Add a team' : 'Add a person or a group', function (x) {
                if (!a.people.some(function (y) { return y.slackUserId ? y.slackUserId === x.slackUserId : y.name === x.name; })) a.people.push(x);
                drawAccess(); var q = accPop.querySelector('.acc-field input'); if (q) q.focus();
              }, { quiet: true, onGroup: function (g) { if (!a.groups.some(function (y) { return y.id === g.id; })) a.groups.push(g); drawAccess(); var q = accPop.querySelector('.acc-field input'); if (q) q.focus(); } })])),
          a.who === 'team' && !a.groups.length ? h('span', { class: 'acc-need', text: 'Pick at least one team.' }) : null) : null;
        var always = [h('span', null, h('b', { text: model.owner ? model.owner.name : me.name }), ' · owner')];
        if (creator && !(model.owner && (creator.slackUserId ? creator.slackUserId === model.owner.slackUserId : creator.name === model.owner.name))) always.push(h('span', null, h('b', { text: creator.name }), ' · made it'));
        always.push(h('span', null, h('b', { text: 'Admins' })));
        fill(accPop, [
          h('div', { class: 'acc-head' }, h('h2', { id: 'acc-title', text: 'Who can see and start it' }),
            h('p', { text: 'In Slack (/idea, @overcli) and here. Everyone else won’t see it.' })),
          group,
          field,
          h('div', { class: 'acc-always' }, h('span', { class: 'acc-label', text: 'Always' }),
            h('div', { class: 'acc-who' }, always, h('span', { class: 'faint', text: 'People in its stages see the work that reaches them.' }))),
          h('div', { class: 'acc-foot' }, h('button', { type: 'button', class: 'btn go small', text: 'Done', onclick: function () { accClose(); accBtn.focus(); } }))]);
      };
      drawAccess();

      var out = h('div');
      var save = h('button', { class: 'btn go', text: editing ? 'Save changes' : 'Make the process' });
      save.onclick = function () {
        var restore = busy(save, 'Saving…');
        api('POST', editing ? '/api/processes/' + encodeURIComponent(state.processId) : '/api/processes', model).then(function (x) {
          restore();
          if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); return; }
          go('process', { processId: x.process.id, processItem: null });
        });
      };
      var cancel = h('button', { class: 'btn quiet', text: 'Cancel', onclick: function () { if (editing) go('process', { processId: state.processId, processItem: null }); else go('processes'); } });
      var retire = editing ? h('button', { class: 'btn quiet danger', text: 'Retire it', onclick: function () {
        if (!confirm('Retire ' + p.name + '? It takes nothing new; what went through it stays.')) return;
        api('POST', '/api/processes/' + encodeURIComponent(p.id) + '/archive', {}).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else go('processes'); });
      } }) : null;
      return [
        h('header', { class: 'pm-head' },
          h('div', { style: 'flex:1 1 420px;min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Processes', onclick: function () { go('processes'); } }), editing ? ' / ' + p.name : fromPicture ? ' / New, from a picture' : ' / New'),
            name, purpose),
          h('div', { class: 'stack', style: 'gap:8px;align-items:flex-end' },
            h('div', { class: 'pm-owner' }, h('span', { class: 'faint', text: 'Owner' }),
              personSlot('Change the owner', function () { return model.owner; }, function (x) { if (x) { model.owner = x; drawAccess(); } }, ''),
              accWrap),
            codeRow())),
        pictureBanner(),
        h('section', { class: 'pm-mapcard', 'aria-label': 'The process map' },
          h('div', { class: 'pm-legend' },
            h('span', { class: 'label', style: 'flex:1', text: 'The flow' }),
            h('span', { class: 'pm-key team', text: 'A team' }),
            h('span', { class: 'pm-key worker', text: 'A worker' }),
            h('span', { class: 'pm-key people', text: 'People decide' }),
            h('span', { class: 'pm-key warn', text: 'Needs setting up' })),
          mapEl,
          h('div', { class: 'row', style: 'gap:8px' },
            h('button', { class: 'btn small', onclick: function () { addStage('team'); } }, icon('plus', 14), 'Team stage'),
            h('button', { class: 'btn small', onclick: function () { addStage('worker'); } }, icon('plus', 14), 'Worker stage'),
            h('button', { class: 'btn small', onclick: function () { addStage('people'); } }, icon('plus', 14), 'Decision'))),
        h('div', { class: 'pm-body' }, inspector, readiness),
        h('div', { class: 'foot sticky-foot' }, save, cancel, retire, out, footNote)
      ];
    });
  }

  function viewTeams() {
    return Promise.all([api('GET', '/api/teams'), api('GET', '/api/team-tasks'), api('GET', '/api/workers'), api('GET', '/api/repos'), api('GET', '/api/teams/runs').catch(function () { return {}; })]).then(function (r) {
      var teams = r[0], tasks = r[1], workers = r[2], places = r[3] && r[3].ok !== false ? r[3] : { repos: [], workspaces: [] };
      var making = r[4] && Array.isArray(r[4].runs) ? r[4].runs : [];
      var intro = 'Give a team a task. Its coordinator asks what it needs, proposes a plan for you to approve, then runs the members through it. Questions and plans reach you here and in Slack.';
      var openMaker = function () { go('newteam', { teamRunId: null }); };
      // Teams still being made: how far their hiring has got.
      var makingCards = making.map(function (run) {
        var done = run.hires.filter(function (g) { return g.state !== 'drafting'; }).length;
        return openCard('tmcard', 'Open ' + run.name, function () { go('newteam', { teamRunId: run.id }); },
          h('div', { style: 'min-width:0' }, h('span', { class: 'tmname', text: run.name }),
            h('p', { class: 'tmpurpose', text: run.status === 'needsYou' ? 'A hire didn’t go through: retry it or skip it.' : 'Being made: ' + done + ' of ' + plural(run.hires.length, 'new member', 'new members') + ' hired.' })),
          h('div', { class: 'tmmeta' }, h('span', { class: 'tmlive' }, h('span', { class: 'livedot' }), run.status === 'needsYou' ? 'Needs you' : 'Hiring')));
      });
      var action = state.me && state.me.canHire && workers.length >= 2
        ? h('button', { class: 'btn go', onclick: openMaker }, icon('plus', 16), 'Make a team')
        : null;
      if (!teams.length && makingCards.length) return [head('Teams', intro, action), h('div', { class: 'tmgrid' }, makingCards)];
      if (!teams.length) return [head('Teams', intro, action), emptyState('No teams you can see yet.', 'Make one from workers already here, or publish one you built in the overcli app: open the team and press Publish to your org.')];
      var live = function (k) { return k.status === 'running' || k.status === 'planning'; };
      // One card per team: what it's for, who's on it, what it has done, and
      // the two ways in. Giving it a task happens on its page, not in a form
      // repeated on every card.
      var cards = teams.map(function (t) {
        var mine = tasks.filter(function (k) { return k.teamId === t.id; });
        var running = mine.filter(live).length;
        var spent = mine.reduce(function (n, k) { return n + (k.spentUSD || 0); }, 0);
        var finished = mine.filter(function (k) { return k.status === 'done' || k.status === 'review'; }).map(function (k) { return k.updatedAt; });
        var last = finished.length ? Math.max.apply(null, finished) : null;
        return openCard('tmcard', 'Open ' + t.name, function () { go('team', { teamId: t.id }); },
          h('div', { style: 'min-width:0' },
            h('span', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, PICTURES[t.id] ? avatar(t.id, t.name, 'm') : null,
              h('span', { class: 'tmname', text: t.name })),
            t.purpose ? h('p', { class: 'tmpurpose', text: t.purpose }) : null),
          h('div', { class: 'tmmeta' },
            h('span', { class: 'faces', title: t.members.map(function (m) { return m.name; }).join(', ') }, t.members.slice(0, 6).map(function (m) { return avatar(m.name, m.name, 's'); })),
            h('span', { class: 'faint tmstats', text: [plural(t.members.length, 'member', 'members'), plural(mine.length, 'task', 'tasks'), money(spent) + ' spent'].concat(last ? ['delivered ' + ago(last)] : []).join(' · ') }),
            running ? h('span', { class: 'tmlive' }, h('span', { class: 'livedot' }), running + ' running') : null),
          t.canBrief ? h('div', { class: 'tmfoot' },
            h('button', { class: 'btn small go', text: 'Give it a task', onclick: function (e) { e.stopPropagation(); go('team', { teamId: t.id, teamFocusBrief: true }); } })) : null);
      });
      cards = makingCards.concat(cards);
      if (action) cards.push(h('article', { class: 'tmcard add' },
        h('div', { style: 'min-width:0' }, h('span', { class: 'tmname', text: 'Another team' }),
          h('p', { class: 'tmpurpose', text: 'Pick workers you manage, say what the team is for, and give it a budget per task.' })),
        h('div', { class: 'tmfoot' }, h('button', { class: 'btn small', onclick: openMaker }, icon('plus', 14), 'Make a team'))));

      // Every team's tasks in one table, each opening its own page.
      var TABS = [['all', 'All tasks', function () { return true; }], ['running', 'Running', live],
        ['needs', 'Needs you', function (k) { return k.waitingOnYou; }], ['review', 'In review', function (k) { return k.status === 'review'; }]];
      var tab = state.teamsTab || 'all';
      var tabsEl = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' });
      var body = h('tbody');
      var drawTasks = function () {
        tabsEl.replaceChildren.apply(tabsEl, TABS.map(function (t) {
          return h('button', { 'aria-pressed': tab === t[0] ? 'true' : 'false', onclick: function () { tab = t[0]; state.teamsTab = tab; drawTasks(); } }, t[1], h('span', { class: 'c', text: String(tasks.filter(t[2]).length) }));
        }));
        var fit = TABS.filter(function (t) { return t[0] === tab; })[0][2];
        var rows = tasks.filter(fit).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
        fill(body, rows.length ? rows.map(function (k) {
          var b = k.waitingOnYou ? ['waiting', 'Needs you'] : TASK_BADGE[k.status] || ['', k.status];
          var done = k.stages.filter(function (s) { return s.state === 'done'; }).length;
          var open_ = function () { openTask(k.id); };
          return h('tr', { class: 'link', tabindex: '0', onclick: open_, onkeydown: function (e) { if (e.key === 'Enter') open_(); } },
            h('td', { class: 'wrap' }, h('b', { style: 'font-weight:600', text: k.title }), h('span', { class: 'sub', text: (k.requestedBy && k.requestedBy !== (state.me && state.me.name) ? k.requestedBy : 'You') + ' asked' })),
            h('td', { class: 'muted', text: k.teamName }),
            h('td', null, h('span', { class: 'badge ' + b[0], text: b[1] })),
            h('td', null, k.stages.length ? h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
              h('ol', { class: 'tsegs', style: 'width:150px', 'aria-label': done + ' of ' + k.stages.length + ' stages done' }, k.stages.map(function (s) { return h('li', { class: s.state, title: s.label }); })),
              h('span', { class: 'faint', text: done + ' of ' + k.stages.length })) : h('span', { class: 'faint', text: 'Planning' })),
            h('td', { class: 'r muted', text: money(k.spentUSD) }),
            h('td', { class: 'r faint', text: ago(k.updatedAt) }));
        }) : [h('tr', null, h('td', { colspan: '6', class: 'muted', style: 'padding:28px 16px;text-align:center', text: tasks.length ? 'No tasks like that.' : 'No tasks yet. Give a team one.' }))]);
      };
      drawTasks();
      return [head('Teams', 'Workers who take on a task together. Its coordinator plans it, you approve, the members run it.', action, 'Workspace'),
        h('div', { class: 'tmgrid' }, cards),
        h('section', { class: 'tcard', 'aria-label': 'Tasks' },
          h('div', { class: 'tbar' }, tabsEl),
          h('div', { class: 'tscroll' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, ['Task', 'Team', 'Status', 'Stages'].map(function (t) { return h('th', { text: t }); }), h('th', { class: 'r', text: 'Spent' }), h('th', { class: 'r', text: 'Updated' }))),
            body)))];
    });
  }

  /// Make a team: what it's for (and a crew suggested from it), who's on it
  /// with what each does, and where you step in. A preview of the team's card
  /// and of a task's steps follows along on the right.
  function viewNewTeam() {
    // A team already being made (from this page before a reload, or the
    // Teams page's card) shows how it stands instead of a fresh form.
    var runId = state.teamRunId || readSession(TEAM_RUN_KEY);
    if (runId) {
      return api('GET', '/api/teams/runs/' + encodeURIComponent(runId)).then(function (x) {
        if (x.ok !== false && x.run && x.run.status !== 'done' && x.run.status !== 'failed') return teamRunView(x.run);
        state.teamRunId = null; writeSession(TEAM_RUN_KEY, null);
        // Made while you were away from this page: go to it, not a blank form.
        if (x.ok !== false && x.run && x.run.status === 'done' && x.run.team) { go('team', { teamId: x.run.team.id }); return []; }
        return newTeamForm();
      }, function () { return newTeamForm(); });
    }
    return newTeamForm();
  }

  /// A team being made: who is already on it, each new member's hire as it
  /// goes, and the steps in the bar. It carries on if you leave; this page
  /// and the Teams page follow it.
  function teamRunView(first) {
    var list = h('div', { class: 'ntroles' });
    var bar = h('span', { class: 'ntbar-sum' });
    var barActions = h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' });
    var out = h('div', { 'aria-live': 'polite' });
    var timer = null;
    var STATE = {
      drafting: ['run', 'Writing its job and hiring it…'],
      hired: ['ok', 'Hired'],
      waiting: ['need', 'Waiting on an approver · joins the team once approved'],
      failed: ['bad', 'Couldn’t hire'],
      skipped: ['', 'Skipped']
    };
    var act = function (run, path, key) {
      return function (e) {
        var restore = busy(e.currentTarget, path === 'retry' ? 'Retrying…' : 'Skipping…');
        api('POST', '/api/teams/runs/' + encodeURIComponent(run.id) + '/' + path, { key: key }).then(function (x) {
          restore();
          if (x.ok === false) { fill(out, [msg(x)]); return; }
          paint(x.run);
        });
      };
    };
    var paint = function (run) {
      fill(list, run.members.map(function (m) {
        return h('div', { class: 'ntrole' }, avatar(m.workerId, m.name, 's'),
          h('span', { class: 'ntrole-who' }, h('b', { text: m.name }), h('span', { class: 'faint', text: m.role })),
          h('span', { class: 'ntrole-body' }),
          h('span', { class: 'ntstate ok' }, icon('tick', 13), 'On the team'));
      }).concat(run.hires.map(function (g) {
        var st = STATE[g.state] || ['', g.state];
        return h('div', { class: 'ntrole hire' },
          g.state === 'hired' ? avatar(g.key, g.name || '?', 's') : h('span', { class: 'avatar s ntw-new', 'aria-hidden': 'true' }, icon('plus', 14)),
          h('span', { class: 'ntrole-who' }, h('span', { class: 'ntw-tag', text: g.state === 'hired' ? 'New hire' : 'New member' }), h('b', { text: g.name || 'Not named yet' })),
          h('span', { class: 'ntrole-body' }, h('span', { style: 'font-size:13.5px', text: g.role }),
            g.state === 'failed' ? h('span', { style: 'font-size:12.5px;color:var(--bad)', text: g.error || 'It didn’t go through.' }) : null),
          h('span', { class: 'stack', style: 'gap:6px;align-items:flex-end;flex:none' },
            h('span', { class: 'ntstate ' + st[0] }, g.state === 'drafting' ? h('span', { class: 'ntspin', 'aria-hidden': 'true' }) : g.state === 'hired' ? icon('tick', 13) : g.state === 'failed' ? icon('alert', 13) : null,
              g.state === 'hired' ? 'Hired as ' + g.name : st[1]),
            g.state === 'failed' ? h('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' },
              h('button', { class: 'btn small', text: 'Skip', onclick: act(run, 'skip', g.key) }),
              h('button', { class: 'btn small go', text: 'Retry', onclick: act(run, 'retry', g.key) })) : null));
      })));
      var settled = run.hires.filter(function (g) { return g.state !== 'drafting'; }).length;
      var open = function () { state.teamRunId = null; writeSession(TEAM_RUN_KEY, null); go('team', { teamId: run.team.id }); };
      fill(barActions, []);
      if (run.status === 'hiring') bar.textContent = 'Hiring ' + plural(run.hires.length, 'new member', 'new members') + ' · ' + settled + ' of ' + run.hires.length + ' done. You can leave this page: it carries on.';
      else if (run.status === 'needsYou') bar.textContent = 'A hire didn’t go through. Retry it, or skip it and make the team without it.';
      else if (run.status === 'making') bar.textContent = 'Making ' + run.name + '…';
      else if (run.status === 'failed') {
        bar.textContent = run.error || run.name + ' couldn’t be made.';
        writeSession(TEAM_RUN_KEY, null); state.teamRunId = null;
        fill(barActions, [h('button', { class: 'btn', text: 'Start again', onclick: function () { go('newteam'); } })]);
      } else if (run.status === 'done') {
        var waiting = run.hires.filter(function (g) { return g.state === 'waiting'; });
        bar.textContent = run.name + ' is made.' + (waiting.length ? ' ' + waiting.map(function (g) { return g.name; }).join(' and ') + ' joins once approved.' : '');
        fill(barActions, [h('button', { class: 'btn go', text: 'Open the team', onclick: open })]);
        if (!waiting.length) setTimeout(function () { if (list.isConnected) open(); }, 1200);
      }
      if (run.status === 'hiring' || run.status === 'making') {
        clearTimeout(timer);
        timer = setTimeout(function () {
          if (!list.isConnected) return;
          api('GET', '/api/teams/runs/' + encodeURIComponent(run.id)).then(function (x) {
            if (x.ok === false) { bar.textContent = x.error; writeSession(TEAM_RUN_KEY, null); return; }
            paint(x.run);
          }, function () {
            // A check that didn't get through (the server busy, a blip):
            // the team is still being made, so look again rather than freeze.
            bar.textContent = 'Still working. Checking again…';
            timer = setTimeout(function () { if (list.isConnected) paint(run); }, 3000);
          });
        }, 1500);
      }
    };
    paint(first);
    return [head('Making ' + first.name, 'Hiring its new members, then making the team.', null, 'Teams'),
      h('section', { class: 'sec' }, h('div', { class: 'sec-head nthead' }, h('h2', { text: 'The crew' })), h('div', { class: 'sec-body' }, list)),
      h('div', { class: 'ntbar' }, h('div', { class: 'ntbar-inner' }, bar, barActions), out)];
  }

  function newTeamForm() {
    return Promise.all([api('GET', '/api/workers'), api('GET', '/api/repos')]).then(function (r) {
      var all = Array.isArray(r[0]) ? r[0] : [];
      var places = r[1] && r[1].ok !== false ? r[1] : { repos: [], workspaces: [] };
      // The workers you could put on it: yours, or everyone's for an admin, yours first.
      var workers = all.filter(function (w) { return w.enabled && (w.youManage || state.me.admin); })
        .sort(function (a, b) { return (b.youManage ? 1 : 0) - (a.youManage ? 1 : 0) || a.name.localeCompare(b.name); });
      var back = function () { go('teams'); };
      if (workers.length < 2) return [head('Make a team', 'A team needs at least two workers you manage.', null, 'Teams'), emptyState('Not enough workers yet.', 'Hire another worker, then come back to put them together.')];

      var picked = {}, roles = {}, order = [], gaps = [];
      var checks = { askFirst: true, reviewBeforeChallenge: false, finalReview: true, approveRoomWork: true };
      var name = h('input', { type: 'text', placeholder: 'Product', 'aria-label': 'Team name', maxlength: '80' });
      var purpose = h('input', { type: 'text', placeholder: 'What the team produces, and for whom', 'aria-label': 'What the team does', maxlength: '500' });
      // From a process stage that needs a team: its name and job to start from.
      if (state.newTeamPrefill) { name.value = state.newTeamPrefill.name || ''; purpose.value = state.newTeamPrefill.purpose || ''; state.newTeamPrefill = null; }
      var budget = h('input', { type: 'number', min: '1', step: '1', value: '50', 'aria-label': 'Budget per task in dollars', style: 'width:110px' });
      var workIn = places.repos.length ? h('select', { 'aria-label': 'Where the team works' },
        [h('option', { value: '', text: 'Where each member usually works' })]
          .concat((places.workspaces || []).map(function (w) { return h('option', { value: w.name, text: 'Workspace: ' + w.name }); }))
          .concat(places.repos.map(function (x) { return h('option', { value: x.name, text: 'Repo: ' + x.name }); }))) : null;
      var out = h('div', { 'aria-live': 'polite' });
      var make = h('button', { class: 'btn go', text: 'Make the team' });
      var count = h('span', { class: 'faint', style: 'margin-left:auto;font-size:13px' });
      var summary = h('span', { class: 'ntbar-sum' });
      var cards = h('div', { class: 'ntpick' });
      var roleList = h('div', { class: 'stack', style: 'gap:8px' });
      var preview = h('div', { class: 'stack', style: 'gap:14px' });
      var suggestOut = h('div', { 'aria-live': 'polite' });
      var find = h('input', { type: 'search', placeholder: 'Find a worker', 'aria-label': 'Find a worker', style: 'width:220px' });

      var byId = function (id) { return workers.filter(function (w) { return w.id === id; })[0]; };
      // The pool to pick from: equal-height cards, each tagline cut to two lines.
      var drawCards = function () {
        var words = find.value.trim().toLowerCase();
        fill(cards, workers.filter(function (w) { return !words || (w.name + ' ' + (w.tagline || '')).toLowerCase().indexOf(words) >= 0; }).map(function (w) {
          var on = !!picked[w.id];
          var under = state.me.admin && !w.youManage && w.manager ? 'Managed by ' + w.manager : '';
          return h('button', { type: 'button', class: 'ntw', 'aria-pressed': on ? 'true' : 'false', title: (w.tagline || '') + (under ? ' · ' + under : ''), onclick: function () { toggle(w.id, !picked[w.id]); } },
            avatar(w.id, w.name, 's'),
            h('span', { class: 'ntw-text' }, h('b', { text: w.name }), h('span', { class: 'faint ntclamp', text: w.tagline || under || 'No tagline' })),
            h('span', { class: 'ntbox', 'aria-hidden': 'true' }, on ? icon('tick', 13) : null));
        }));
      };
      // The crew first: each member and what it does here, then any job the
      // suggestion said needs a new hire, as a row of its own.
      var drawRoles = function () {
        var hires = state.me.canHire ? gaps : [];
        if (!order.length && !hires.length) {
          fill(roleList, [h('span', { class: 'label', text: 'The crew, and what each does' }),
            h('div', { class: 'ntempty', text: 'Nobody yet. Pick from your workers below, or let overcli suggest a crew.' })]);
          return;
        }
        fill(roleList, [h('span', { class: 'label', text: 'The crew, and what each does' }),
          h('div', { class: 'ntroles' }, order.map(function (id) {
            var w = byId(id);
            var input = h('input', { type: 'text', value: roles[id] || '', placeholder: 'What ' + w.name + ' does on this team', 'aria-label': 'What ' + w.name + ' does on this team', maxlength: '200' });
            input.oninput = function () { roles[id] = input.value; };
            return h('div', { class: 'ntrole', 'data-id': id }, avatar(w.id, w.name, 's'),
              h('span', { class: 'ntrole-who' }, h('b', { text: w.name }), h('span', { class: 'faint', text: w.tagline || '' })), input,
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Take ' + w.name + ' off the team', onclick: function () { toggle(id, false); } }, icon('x', 14)));
          }).concat(hires.map(function (g) {
            var job = h('span', { class: 'faint ntclamp', text: g.job });
            var more = h('button', { type: 'button', class: 'linkish', style: 'color:var(--go);font-size:12px;font-weight:600;align-self:flex-start', text: 'The whole job' });
            more.onclick = function () { var open = job.classList.toggle('ntclamp'); more.textContent = open ? 'The whole job' : 'Less'; };
            return h('div', { class: 'ntrole hire' },
              h('span', { class: 'avatar s ntw-new', 'aria-hidden': 'true' }, icon('plus', 14)),
              h('span', { class: 'ntrole-who' }, h('span', { class: 'ntw-tag', text: 'Not hired yet' }), h('b', { text: 'New member' })),
              h('span', { class: 'ntrole-body' }, h('span', { style: 'font-size:13.5px', text: g.role || 'A new member' }), job,
                h('span', { class: 'row', style: 'gap:6px 12px' }, more, h('span', { class: 'faint', style: 'font-size:12px', text: 'Hired when you make the team' }))),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Skip this hire', title: 'Skip this hire', onclick: function () { gaps = gaps.filter(function (x) { return x !== g; }); draw(); } }, icon('x', 14)));
          }))),
          h('span', { class: 'faint', style: 'font-size:12.5px', text: 'The coordinator isn’t one of them: it plans each task, drafts, and writes the final pack.' })]);
      };
      var drawPreview = function () {
        var names = order.map(function (id) { return byId(id).name; });
        var steps = [];
        if (checks.askFirst) steps.push(['Asks what it needs to know', 'One round of questions, each with the default it will use.', true]);
        steps.push(['You approve the plan', 'Who does what, and the assumptions it rests on.', true]);
        steps.push(['The members work', names.length ? names.join(', ') + ', each on their part.' : 'Pick members to see who.', false]);
        if (checks.reviewBeforeChallenge) steps.push(['You read the draft', 'Before it’s challenged.', true]);
        if (checks.finalReview) steps.push(['You review the result', 'Accept it, or send it back with notes.', true]);
        var n = name.value.trim();
        fill(preview, [
          h('article', { class: 'tmcard', 'aria-label': 'Preview of the team' },
            h('div', { style: 'min-width:0' }, h('span', { class: 'tmname', text: n || 'Your new team' }), purpose.value.trim() ? h('p', { class: 'tmpurpose', text: purpose.value.trim() }) : null),
            h('div', { class: 'tmmeta' },
              order.length ? h('span', { class: 'faces' }, order.slice(0, 6).map(function (id) { var w = byId(id); return avatar(w.id, w.name, 's'); })) : null,
              h('span', { class: 'faint tmstats', text: plural(order.length, 'member', 'members') + ' · $' + (Number(budget.value) || 0) + ' a task' }))),
          h('section', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h2', { class: 'label', text: 'When you give it a task' })),
            h('ol', { class: 'ntflow sec-body' }, steps.map(function (st, i) {
              return h('li', null, h('span', { class: 'ntnum' + (st[2] ? ' you' : ''), text: String(i + 1) }), h('span', { class: 'stack', style: 'gap:1px' }, h('b', { text: st[0] }), h('span', { class: 'faint', text: st[1] })));
            }))),
          h('section', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h2', { class: 'label', text: 'Give it work from Slack' })),
            h('div', { class: 'sec-body stack', style: 'gap:6px' }, codeBlock('@overcli ' + (n || 'Product') + ', write a …'),
              h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Or don’t name it: requests that fit what it’s for come to it. /team ' + (n || 'Product') + ': … works too.' })))]);
      };
      var draw = function () {
        drawCards(); drawRoles(); drawPreview();
        var toHire = state.me.canHire ? gaps.length : 0;
        count.textContent = (order.length ? order.length + ' on the team' : 'None picked yet') + (toHire ? ' · ' + toHire + ' to hire' : '');
        var n = name.value.trim(), total = order.length + toHire;
        summary.textContent = !n ? 'Give the team a name.' : total < 2 ? n + ' needs at least two members.' : n + ': ' + plural(order.length, 'member', 'members') + (toHire ? ' and ' + toHire + ' to hire' : '') + '.';
        make.disabled = !name.value.trim() || order.length + (state.me.canHire ? gaps.length : 0) < 2;
      };
      find.oninput = drawCards;
      name.oninput = draw; purpose.oninput = drawPreview; budget.oninput = drawPreview;

      var suggest = h('button', { type: 'button', class: 'btn', text: 'Suggest a crew' });
      suggest.onclick = function () {
        if (!purpose.value.trim()) { purpose.focus(); fill(suggestOut, [h('span', { class: 'faint', text: 'Say what the team does first.' })]); return; }
        var restore = busy(suggest, 'Picking a crew…');
        fill(suggestOut, []);
        api('POST', '/api/teams/suggest', { purpose: purpose.value, name: name.value }).then(function (x) {
          restore();
          if (x.ok === false) { fill(suggestOut, [msg(x)]); return; }
          if (!name.value.trim() && x.name) name.value = x.name;
          picked = {}; order = []; roles = {}; gaps = x.gaps || [];
          x.members.forEach(function (m) { if (byId(m.workerId)) { picked[m.workerId] = true; order.push(m.workerId); roles[m.workerId] = m.role; } });
          draw();
          fill(suggestOut, [h('div', { class: 'msg', style: 'background:var(--go-soft);color:var(--ink)' },
            x.note || 'Picked from what the team does.',
            gaps.length && state.me.canHire ? h('div', { class: 'faint', style: 'margin-top:4px', text: (gaps.length === 1 ? 'The suggested new member is hired' : 'The suggested new members are hired') + ' when you make the team. Skip any you don’t want.' }) : null)]);
        });
      };

      var sw = function (key, title, help) {
        var b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': checks[key] ? 'true' : 'false', 'aria-label': title });
        b.onclick = function () { checks[key] = !checks[key]; b.setAttribute('aria-checked', checks[key] ? 'true' : 'false'); drawPreview(); };
        return h('div', { class: 'ntcheck' }, h('span', { class: 'stack', style: 'gap:2px;flex:1;min-width:0' }, h('b', { text: title }), h('span', { class: 'faint', text: help })), b);
      };
      var section = function (n, title, right, body) {
        return h('section', { class: 'sec' }, h('div', { class: 'sec-head nthead' }, h('span', { class: 'ntnum you', text: String(n) }), h('h2', { text: title }), right), h('div', { class: 'sec-body stack', style: 'gap:14px' }, body));
      };

      make.onclick = function () {
        var missing = order.filter(function (id) { return !(roles[id] || '').trim(); })[0];
        if (missing) {
          var el = roleList.querySelector('[data-id="' + missing + '"] input');
          if (el) el.focus();
          fill(out, [msg({ ok: false, error: 'Say what ' + byId(missing).name + ' does on this team.' })]);
          return;
        }
        var hires = state.me.canHire ? gaps.map(function (g, i) { return { key: String(i), job: g.job, role: g.role }; }) : [];
        var restore = busy(make, hires.length ? 'Starting…' : 'Making…');
        api('POST', '/api/teams', { name: name.value.trim(), purpose: purpose.value.trim(), budgetUSDPerTask: Number(budget.value), workIn: workIn ? workIn.value : '', checkpoints: checks,
          members: order.map(function (id) { return { workerId: id, role: roles[id].trim() }; }), hires: hires }).then(function (x) {
          restore();
          if (x.ok === false) { fill(out, [msg(x)]); return; }
          if (x.run.status === 'done' && x.run.team) { go('team', { teamId: x.run.team.id }); return; }
          if (x.run.status === 'failed') { fill(out, [msg({ ok: false, error: x.run.error })]); return; }
          writeSession(TEAM_RUN_KEY, x.run.id);
          go('newteam', { teamRunId: x.run.id });
        });
      };
      draw();
      setTimeout(function () { name.focus(); }, 0);

      return [head('Make a team', 'Workers who take on a task together. A coordinator plans each task, you approve it, the members run it.', null, 'Teams'),
        h('div', { class: 'ntwrap' },
          h('div', { class: 'ntmain' },
            section(1, 'What it’s for', null, [
              h('div', { class: 'ntrow' }, h('label', { class: 'field', style: 'flex:1 1 180px' }, 'Name', name), h('label', { class: 'field', style: 'flex:3 1 320px' }, 'What it does, in a line or two', purpose)),
              workIn ? h('label', { class: 'field' }, 'Works in (code changes get a branch in each repo)', workIn) : null,
              h('div', { class: 'ntsuggest' }, h('span', { style: 'color:var(--go);display:flex;flex:none' }, icon('bolt', 18)),
                h('span', { class: 'muted', style: 'flex:1 1 260px;font-size:13.5px', text: 'Let overcli pick the crew from your workers, from what the team does, and write what each does on it. You can change all of it.' }), suggest),
              suggestOut]),
            section(2, 'Who’s on it', count, [
              roleList,
              h('div', { class: 'stack', style: 'gap:10px' },
                h('div', { class: 'row', style: 'gap:12px' }, h('span', { class: 'label', style: 'flex:1 1 auto', text: state.me.admin ? 'Add workers (yours first)' : 'Add from your workers' }),
                  h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Two to six works best.' }), find),
                cards)]),
            section(3, 'How it works with you', null, [
              h('div', { class: 'ntchecks' },
                sw('askFirst', 'Ask what it needs to know first', 'Before planning, the coordinator asks anything it would otherwise guess, each question with a default.'),
                h('div', { class: 'ntcheck' }, h('span', { class: 'stack', style: 'gap:2px;flex:1;min-width:0' }, h('b', { text: 'You approve the plan' }), h('span', { class: 'faint', text: 'Who does what, in what order, and the assumptions it rests on.' })), h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Always' })),
                sw('reviewBeforeChallenge', 'Read the draft before it’s challenged', 'Steer the main piece before the others build on it.'),
                sw('finalReview', 'Review the result', 'The finished pack waits for you to accept it or send it back.'),
                sw('approveRoomWork', 'Approve follow-up work', 'Extra work the team suggests waits for your OK.')),
              h('div', { class: 'ntrow', style: 'align-items:flex-end' }, h('label', { class: 'field' }, 'Budget per task ($)', budget),
                h('span', { class: 'faint', style: 'flex:1 1 240px;font-size:12.5px;padding-bottom:9px', text: 'Members’ work for one task. When a task would go over, it stops and asks you.' }))])),
          h('aside', { class: 'ntside' }, preview)),
        // Always in reach, however far down the form you are.
        h('div', { class: 'ntbar' }, h('div', { class: 'ntbar-inner' }, summary, h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('button', { class: 'btn', text: 'Cancel', onclick: back }), make)), out)];
    });
  }

  /// Put a redrawn card in place of the old one without losing the reader's
  /// place: which folds were open, and how far each scrolling box was
  /// scrolled. Without it a live page snapped shut and jumped every refresh.
  function keepPlace(oldNode, newNode) {
    if (!oldNode || oldNode === newNode) return newNode;
    var opened = [].map.call(oldNode.querySelectorAll('details'), function (d) { return d.open; });
    [].forEach.call(newNode.querySelectorAll('details'), function (d, i) { if (opened[i] && !d.open) { d.open = true; if (d.ontoggle) d.ontoggle(); } });
    var scrolled = [].map.call(oldNode.querySelectorAll('.wc-out, .tl-list'), function (el) { return el.scrollTop; });
    requestAnimationFrame(function () {
      [].forEach.call(newNode.querySelectorAll('.wc-out, .tl-list'), function (el, i) { if (scrolled[i]) el.scrollTop = scrolled[i]; });
    });
    return newNode;
  }
  /// Make el hold exactly nodes, in order, while touching as little as
  /// possible. Taking an element out and back in resets every scroll box
  /// inside it, so a live page that re-set the same cards each refresh threw
  /// a reader back to the top of the report they were scrolling. Cards that
  /// are gone go first; then the new ones slot in, and an unchanged card is
  /// never moved.
  function setChildren(el, nodes) {
    var keep = new Set(nodes);
    [].slice.call(el.children).forEach(function (c) { if (!keep.has(c)) el.removeChild(c); });
    nodes.forEach(function (n, i) { if (el.children[i] !== n) el.insertBefore(n, el.children[i] || null); });
  }
  /// Team files already read, so a redraw shows them at once.
  var teamFileCache = {};

  // ---- comments on a team task's work ----------------------------------

  /// Each task's comments as the console last saw them, and what to redraw
  /// once one is sent. The task page and the shared folder fill it as they
  /// draw, so a file opened anywhere shows what was said about it.
  var taskTalk = {};
  function noteTaskComments(task, after) {
    taskTalk[task.id] = { task: task, comments: (task.comments || []).slice(), after: after || null };
  }
  function commentsOn(taskId, file) {
    var t = taskTalk[taskId];
    return t ? t.comments.filter(function (c) { return c.file === file; }) : [];
  }
  /// What came of a comment, in words.
  function commentOutcome(c) {
    return { replanned: 'Re-planned with it', steered: 'Sent to ' + (c.workerName || 'the member') + ' while working', asked: 'In the team conversation', queued: 'Briefs the next stages', redo: (c.workerName || 'The member') + ' is redoing it', waiting: 'Goes to the team when it finishes answering' }[c.outcome] || '';
  }
  /// What a comment is about, in words.
  function commentAbout(c) {
    var on = c.file ? 'On ' + c.file : c.about === 'questions' ? 'On the questions' : c.about === 'plan' ? 'On the plan' : c.about === 'coordinator' ? 'To the coordinator' : '';
    return [c.workerName ? 'To ' + c.workerName : '', on].filter(Boolean).join(' · ') || 'On the task';
  }
  /// What a comment sent now does, for the line under a box: re-plans a
  /// plan that waits on you, goes to the team once the pack is written,
  /// reaches a member mid-piece, and otherwise briefs what's still to come.
  function commentGoes(task, working, name) {
    if (task.status === 'proposed') return 'The plan is waiting for your OK, so the coordinator re-plans with it.';
    if (task.status === 'review' || task.status === 'done') return 'The pack is written, so it goes to the team conversation.';
    if (working && name) return name + ' reads it at the next step of the piece they are on.';
    if (task.status === 'questions') return 'It goes into the plan, with your answers.';
    return 'It briefs ' + (name ? name + '’s later pieces' : 'every later piece') + ' and the pack.';
  }

  /// One comment: what it's about, the passage it quotes, what was said,
  /// when, and what came of it. Given open, one about a file opens it.
  function commentRow(c, open, inFile) {
    var out = commentOutcome(c);
    var about = inFile ? (c.workerName ? 'To ' + c.workerName : '') : commentAbout(c);
    return h('div', { class: 'cm-row' },
      h('div', { class: 'cm-meta' },
        about ? (open && c.file ? h('button', { class: 'linkish cm-link', text: about, onclick: function () { open(c.file); } }) : h('b', { text: about })) : null,
        h('span', { class: 'faint', text: ago(c.at) }),
        out ? h('span', { class: 'badge' + (c.outcome === 'steered' || c.outcome === 'redo' ? ' working' : c.outcome === 'replanned' || c.outcome === 'asked' ? ' ok' : ''), text: out }) : null),
      c.quote ? h('blockquote', { class: 'cm-quote', text: c.quote.length > 300 ? c.quote.slice(0, 299) + '…' : c.quote }) : null,
      h('p', { class: 'cm-text', text: c.text }));
  }

  /// The comments on one file, under it, kept current as more are sent.
  function fileCommentList(taskId, file) {
    var box = h('div', { class: 'cm-file' });
    box.cmTask = taskId; box.cmFile = file;
    drawFileComments(box);
    return box;
  }
  function drawFileComments(box) {
    var list = commentsOn(box.cmTask, box.cmFile).slice().reverse();
    fill(box, list.length ? [h('div', { class: 'label', text: 'Comments on this file · ' + list.length }), list.map(function (c) { return commentRow(c, null, true); })] : null);
  }
  function redrawFileComments(taskId) {
    [].forEach.call(document.querySelectorAll('.cm-file'), function (b) { if (b.cmTask === taskId) drawFileComments(b); });
  }

  /// A file's text, marked so a passage selected in it can be commented on.
  function commentable(taskId, file, node) {
    var wrap = h('div', { class: 'cm-host', 'data-cm-file': file }, node);
    wrap.cmTask = taskId; wrap.cmFile = file;
    return wrap;
  }
  /// The line over a file: comment on the whole of it, or select a passage.
  function fileCommentBar(taskId, file) {
    return h('div', { class: 'cm-bar' },
      h('button', { class: 'btn small quiet', onclick: function (e) { fileCommentBox(taskId, file, null, e.currentTarget.getBoundingClientRect()); } }, icon('slack', 14), 'Comment on this file'),
      h('span', { class: 'faint', text: 'or select a passage to comment on it' }));
  }
  function fileCommentBox(taskId, file, quote, at) {
    var task = taskTalk[taskId] && taskTalk[taskId].task;
    commentBox({ taskId: taskId, file: file, quote: quote, at: at, title: quote ? 'Comment on this passage' : 'Comment on ' + file.split('/').pop(),
      notes: [task ? commentGoes(task, false, null) : 'It briefs the work still to come; while the plan waits for your OK, it re-plans it.'] });
  }

  /// The one comment box open at a time, and the floating Comment button.
  var cmPop = null, cmFloat = null;
  function closeCommentBox() {
    if (cmPop) { cmPop.remove(); cmPop = null; }
    document.removeEventListener('mousedown', cmOutside, true);
    document.removeEventListener('keydown', cmEsc);
  }
  function cmOutside(e) { if (cmPop && !cmPop.contains(e.target)) closeCommentBox(); }
  function cmEsc(e) { if (e.key === 'Escape' && cmPop) { e.stopPropagation(); closeCommentBox(); } }
  /// Put a floating box by a spot on screen: under it, or over it when
  /// there's no room below, and never off the edge.
  function placeBy(el, at) {
    var w = el.offsetWidth, ht = el.offsetHeight;
    var left = Math.min(Math.max(12, at.left), window.innerWidth - w - 12);
    var top = at.bottom + 8;
    if (top + ht > window.innerHeight - 12) top = Math.max(12, at.top - ht - 8);
    el.style.setProperty('left', Math.max(12, left) + 'px');
    el.style.setProperty('top', top + 'px');
  }

  /// A small box to say something about a task's work: what it's about on
  /// top (the passage, when one was picked), the text, and Send. With redo,
  /// a second button starts that member's piece again with the note. Under
  /// it, in plain words, what each button does.
  function commentBox(o) {
    closeCommentBox(); hideFloat();
    var ta = h('textarea', { 'aria-label': o.title, placeholder: o.placeholder || 'Say what you think', rows: '3' });
    var said = h('div', { 'aria-live': 'polite' });
    var sendBtn = h('button', { class: 'btn go small', text: 'Send' });
    var redoBtn = o.redo ? h('button', { class: 'btn small', text: 'Redo with this' }) : null;
    var send = function (redo, btn) {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      var body = { text: text };
      if (o.file) body.file = o.file;
      if (o.quote) body.quote = o.quote;
      if (o.about) body.about = o.about;
      if (o.workerId) body.workerId = o.workerId;
      if (redo) body.redo = true;
      var restore = busy(btn, redo ? 'Starting…' : 'Sending…');
      api('POST', '/api/team-tasks/' + encodeURIComponent(o.taskId) + '/comment', body).then(function (r) {
        restore();
        if (r.ok === false) { said.replaceChildren(msg(r)); return; }
        var t = taskTalk[o.taskId];
        var c = r.comment || (redo ? { id: 'local', at: Date.now(), text: text, workerId: o.workerId, workerName: o.workerName, outcome: 'redo' } : null);
        if (c && t && !t.comments.some(function (x) { return x.id === c.id; })) t.comments.push(c);
        redrawFileComments(o.taskId);
        var okText = redo ? (o.workerName || 'The member') + ' is starting the piece again with your note.' : c && commentOutcome(c) ? commentOutcome(c) + '.' : 'Sent.';
        ta.disabled = true; sendBtn.disabled = true; if (redoBtn) redoBtn.disabled = true;
        said.replaceChildren(msg({}, okText));
        var mine = pop;
        setTimeout(function () { if (cmPop === mine) closeCommentBox(); }, 1800);
        var after = o.after || (t && t.after);
        if (after) after();
      }, function (err) { restore(); said.replaceChildren(h('div', { class: 'msg err', role: 'alert', text: err.message })); });
    };
    sendBtn.onclick = function () { send(false, sendBtn); };
    if (redoBtn) redoBtn.onclick = function () { send(true, redoBtn); };
    ta.onkeydown = function (e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(false, sendBtn); } };
    var pop = h('div', { class: 'cm-pop', role: 'dialog', 'aria-label': o.title },
      h('div', { class: 'cm-pop-head' }, h('b', { text: o.title }), h('button', { class: 'btn small quiet icon', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closeCommentBox }, '✕')),
      o.quote ? h('blockquote', { class: 'cm-quote', text: o.quote.length > 400 ? o.quote.slice(0, 399) + '…' : o.quote }) : null,
      ta,
      h('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:nowrap' }, sendBtn, redoBtn, h('span', { class: 'faint', style: 'margin-left:auto;font-size:12px', text: '⌘↵ sends' })),
      o.notes && o.notes.length ? h('ul', { class: 'cm-notes' }, o.notes.map(function (n) { return h('li', { text: n }); })) : null,
      o.extra || null,
      said);
    document.body.appendChild(pop);
    cmPop = pop;
    placeBy(pop, o.at || { left: window.innerWidth / 2 - 180, top: 120, bottom: 120 });
    document.addEventListener('mousedown', cmOutside, true);
    document.addEventListener('keydown', cmEsc);
    setTimeout(function () { ta.focus(); }, 0);
  }

  /// Select a passage of a file the team wrote and a small Comment button
  /// appears by it; it opens the box with the passage quoted.
  function selectionInFile() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var range = sel.getRangeAt(0);
    var node = range.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    var host = el && el.closest('[data-cm-file]');
    if (!host || !host.cmTask) return null;
    var rects = range.getClientRects();
    var r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    return { taskId: host.cmTask, file: host.cmFile, quote: text.slice(0, 1000), rect: r };
  }
  function hideFloat() { if (cmFloat) { cmFloat.remove(); cmFloat = null; } }
  function showFloat() {
    var s = selectionInFile();
    hideFloat();
    if (!s || cmPop) return;
    cmFloat = h('button', { class: 'cm-float', type: 'button' }, icon('slack', 14), 'Comment');
    // Pressing it must not clear the selection it is about.
    cmFloat.onmousedown = function (e) { e.preventDefault(); };
    cmFloat.onclick = function () {
      var at = s.rect;
      hideFloat();
      try { window.getSelection().removeAllRanges(); } catch (e) {}
      fileCommentBox(s.taskId, s.file, s.quote, at);
    };
    document.body.appendChild(cmFloat);
    placeBy(cmFloat, { left: s.rect.right - cmFloat.offsetWidth / 2, top: s.rect.top, bottom: s.rect.bottom });
  }
  document.addEventListener('mouseup', function (e) {
    if ((cmFloat && cmFloat.contains(e.target)) || (cmPop && cmPop.contains(e.target))) return;
    setTimeout(showFloat, 0);
  });
  document.addEventListener('keyup', function (e) { if (e.shiftKey || e.key === 'Shift') setTimeout(showFloat, 0); });
  window.addEventListener('scroll', hideFloat, true);

  /// Say something to one member of a task's team: Send, and for the stage
  /// running now, Redo with this, each explained under the box.
  function memberBox(task, p, current, at, after) {
    var working = p.status === 'running' || p.status === 'paused';
    var redo = current && (task.status === 'running' || task.status === 'waiting') && p.status !== 'pending';
    commentBox({ taskId: task.id, workerId: p.workerId, workerName: p.workerName, at: at, after: after, redo: redo,
      title: 'Say something to ' + p.workerName, placeholder: 'What should ' + p.workerName + ' know or change?',
      notes: ['Send: ' + commentGoes(task, working, p.workerName)].concat(redo ? ['Redo with this: ' + p.workerName + '’s piece of this stage starts again, with your note.'] : []),
      extra: h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Open ' + p.workerName + '’s page →', onclick: function () { closeCommentBox(); openWorker(p.workerId); } }) });
  }

  /// Comment on the coordinator's questions or its plan, with what that does.
  function aboutRow(task) {
    var plan = task.status === 'proposed' || !!task.planNote;
    var asks = task.status === 'questions';
    if (!plan && !asks) return null;
    var open = function (about, title) {
      return function (e) { commentBox({ taskId: task.id, about: about, at: e.currentTarget.getBoundingClientRect(), title: title, notes: [commentGoes(task, false, null)] }); };
    };
    return h('div', { class: 'cm-about' },
      asks ? h('button', { class: 'btn small quiet', onclick: open('questions', 'Comment on the questions') }, icon('slack', 14), 'Comment on the questions') : null,
      plan ? h('button', { class: 'btn small quiet', onclick: open('plan', 'Comment on the plan') }, icon('slack', 14), 'Comment on the plan') : null,
      h('span', { class: 'faint', text: task.status === 'proposed' ? 'Commenting while the plan waits for your OK re-plans it.' : asks ? 'A comment goes into the plan, with your answers.' : 'A comment on the plan now briefs the stages still to come.' }));
  }

  /// Every comment on a task, newest first; one on a file opens it.
  function commentsCard(task) {
    var list = (task.comments || []).slice().reverse();
    var open = function (file) { go('teamfiles', { taskId: task.id, teamFilePick: file }); };
    var add = h('span', { class: 'row', style: 'gap:14px' },
      h('button', { class: 'linkish', text: 'Tell the coordinator', title: 'A note it reads at its next stage, e.g. a member redid a piece and the new version should be used', onclick: function (e) {
        commentBox({ taskId: task.id, at: e.currentTarget.getBoundingClientRect(), title: 'Say something to the coordinator', about: 'coordinator',
          notes: [task.status === 'proposed' ? 'The coordinator re-plans with it.' : 'The coordinator reads it at its next stage, and every member after it does too.'] });
      } }),
      h('button', { class: 'linkish', text: 'Comment on the task', onclick: function (e) {
        commentBox({ taskId: task.id, at: e.currentTarget.getBoundingClientRect(), title: 'Comment on the task', notes: [commentGoes(task, false, null)] });
      } }));
    return card('taskcomments', 'Comments · ' + list.length, add,
      list.length ? h('div', { class: 'cm-list' }, list.map(function (c) { return commentRow(c, open, false); }))
        : h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: 'Nothing said yet. Select a passage in a file to comment on it, or pick a member to say something to them.' }));
  }

  // ---- one team --------------------------------------------------------

  /// A shared file of a team task, read when opened.
  function teamFile(taskId, name, label) {
    var body = h('div', { class: 'wc-out' }, h('span', { class: 'faint', text: 'Loading…' }));
    var said = commentsOn(taskId, name).length;
    var d = h('details', { class: 't-report' }, h('summary', null, label || 'Read ', h('code', { text: name }), said ? h('span', { class: 'faint', text: ' · ' + plural(said, 'comment', 'comments') }) : null), body);
    var loaded = false;
    var key = taskId + '/' + name;
    // Over the text, a way to comment on it; under it, what's been said.
    var show = function (text) {
      fill(body, [fileCommentBar(taskId, name), commentable(taskId, name, /\.(md|markdown|txt)$/i.test(name) ? md(text) : h('pre', { text: text })), fileCommentList(taskId, name)]);
    };
    d.ontoggle = function () {
      if (!d.open || loaded) return;
      loaded = true;
      if (teamFileCache[key] != null) { show(teamFileCache[key]); return; }
      api('GET', '/api/team-tasks/' + encodeURIComponent(taskId) + '/file?name=' + encodeURIComponent(name)).then(function (x) {
        if (x.ok === false) { body.textContent = ''; body.appendChild(msg(x)); return; }
        teamFileCache[key] = x.body;
        show(x.body);
      });
    };
    return d;
  }

  var PIECE = { pending: ['', 'Next'], running: ['working', 'Working'], paused: ['waiting', 'Paused'], done: ['ok', 'Done'], failed: ['bad', 'Failed'], skipped: ['', 'Skipped'] };

  /// One member's piece of a stage: what they were asked, where they are,
  /// an approval they wait on, and what they wrote.
  function teamPiece(task, p, after) {
    var b = p.waiting ? ['waiting', 'Needs your OK'] : PIECE[p.status] || ['', p.status];
    var current = task.stagesDetail.some(function (s) { return s.current && s.pieces.indexOf(p) >= 0; });
    var slot = h('div', { 'aria-live': 'polite' });
    var retry = p.status === 'failed' && current && (task.status === 'running' || task.status === 'waiting') ? h('button', { class: 'btn go small', text: 'Retry ' + p.workerName + '’s piece' }) : null;
    if (retry) retry.onclick = function () {
      var restore = busy(retry, 'Starting…');
      api('POST', '/api/team-tasks/' + encodeURIComponent(task.id), { kind: 'retryPiece', workerId: p.workerId }).then(function (x) {
        restore(); slot.textContent = ''; slot.appendChild(msg(x, p.workerName + ' is on it again.'));
        if (x.ok !== false && after) after();
      });
    };
    return h('div', { class: 't-piece' },
      avatar(p.workerId, p.workerName, 's'),
      h('div', { class: 'stack', style: 'gap:6px;min-width:0;flex:1' },
        h('div', { class: 't-top' },
          h('span', null, h('button', { class: 'linkish', style: 'color:var(--ink);font-weight:600', text: p.workerName, title: 'Say something to ' + p.workerName, onclick: function (e) { memberBox(task, p, current, e.currentTarget.getBoundingClientRect(), after); } }),
            p.step && p.status === 'running' ? h('span', { class: 'faint', text: ' · step ' + p.step.index + ' of ' + p.step.total + ', ' + p.step.name.replace(/[-_]/g, ' ') }) : null),
          h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' },
            p.runId ? h('button', { class: 'btn small', text: p.status === 'running' ? 'Watch' : 'See what it did', onclick: function () { watchRun(p.runId, p.workerName + ' · ' + task.title); } }) : null,
            p.startedAt && p.status === 'running' ? h('span', { class: 'faint', text: secs(Date.now() - p.startedAt) + ' in' }) : null,
            p.costUSD ? h('span', { class: 'faint', text: money(p.costUSD) }) : null,
            h('span', { class: 'badge ' + b[0], text: b[1] }))),
        h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: p.ask.length > 260 ? p.ask.slice(0, 259) + '…' : p.ask }),
        p.error ? h('div', { class: 'msg err', text: p.error === 'Interrupted by app restart.' ? 'Stopped by a server restart before it got going.' : p.error }) : null,
        retry ? h('div', null, retry) : null, slot,
        p.waiting ? waitingCard(p.waiting) : null,
        p.file ? teamFile(task.id, p.file, 'Read what ' + p.workerName + ' wrote · ') : null));
  }

  /// A team task as a thread: what you asked, where it stands in a sentence,
  /// its stages, what it needs from you, the members' pieces, and the pack.
  function teamTaskThread(task, after) {
    noteTaskComments(task, after);
    var b = task.waitingOnYou || task.piecesNeedYou ? ['waiting', 'Needs you'] : { queued: ['', 'Up next'], planning: ['working', 'Planning'], running: ['working', 'Running'], done: ['ok', 'Done'], failed: ['bad', 'Failed'], cancelled: ['', 'Cancelled'], waiting: ['waiting', 'Waiting'], questions: ['waiting', 'Has questions'], proposed: ['waiting', 'Plan ready'] }[task.status] || ['', task.status];
    var cls = task.waitingOnYou || task.piecesNeedYou ? ' need' : task.status === 'running' || task.status === 'planning' ? ' live' : task.status === 'failed' ? ' bad' : '';
    var cur = task.stagesDetail.filter(function (s) { return s.current; })[0];
    var out = h('div', { 'aria-live': 'polite' });
    var me = state.me && state.me.name;
    var stageState = function (s) {
      if (s.status === 'done') return 'done';
      if (s.status === 'failed') return 'failed';
      if (s.status === 'skipped') return 'skipped';
      if (s.current && task.status !== 'proposed' && task.status !== 'questions' && task.status !== 'planning') return s.pieces.some(function (p) { return p.waiting; }) || task.status === 'waiting' ? 'need' : 'now';
      return 'next';
    };
    var done = task.status === 'done';
    return h('article', { class: 'thread' + cls, id: 'task-' + task.id },
      h('div', { class: 't-main' },
        h('div', { class: 't-top', style: 'align-items:flex-start' },
          h('div', { style: 'min-width:0;flex:1 1 320px' },
            h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, cls === ' live' ? h('span', { class: 'livedot' }) : null, h('b', { class: 't-title', text: task.title || task.brief })),
            h('div', { class: 'faint', style: 'margin-top:2px', text: (task.requestedBy && task.requestedBy !== me ? task.requestedBy : 'You') + ' asked' + (task.title && task.title !== task.brief ? ' “' + briefShort(task.brief).text + '”' : '') + ' · ' + when(task.createdAt) })),
          h('span', { class: 'badge ' + b[0], text: b[1] + (cur && !done && (task.status === 'running' || task.status === 'waiting') ? ' · stage ' + (task.stagesDetail.indexOf(cur) + 1) + ' of ' + task.stagesDetail.length : '') })),
        !done && !(cur && cur.pieces.length && task.status !== 'proposed') ? h('p', { class: 't-head', text: task.nowSentence }) : null,
        task.status === 'planning' ? thinking('The coordinator is reading the brief and its members’ jobs, then writing questions or a plan.') : null,
        task.stagesDetail.length ? segs(task.stagesDetail.map(function (s, i) {
          return { label: (i + 1) + ' · ' + (s.title || s.label), state: stageState(s), detail: s.pieces.length ? s.pieces.map(function (p) { return p.workerName; }).join(', ') : 'Coordinator' };
        })) : null,
        task.error ? h('div', { class: 'msg err', text: task.error }) : null,
        teamTaskControls(task, out, after),
        cur && !done && cur.pieces.length && task.status !== 'proposed' ? h('div', { class: 'stack', style: 'gap:10px' },
          cur.pieces.map(function (p) { return teamPiece(task, p, after); })) : null,
        done && task.pack ? h('div', { class: 't-answer' }, h('span', { class: 't-kind', text: 'What the team delivered' }), md(task.pack.summary)) : null,
        done && task.pack ? h('div', { class: 'stack', style: 'gap:6px' }, task.pack.files.map(function (f) { return teamFile(task.id, f, 'Read ') ; })) : null,
        task.code ? teamCode(task) : null,
        h('div', { class: 't-spend' }, h('div', { class: 'meter' + (task.budgetUSD && task.spentUSD / task.budgetUSD >= 0.85 ? ' high' : '') }, h('span', { style: 'width:' + (task.budgetUSD ? Math.min(100, (task.spentUSD / task.budgetUSD) * 100) : 0).toFixed(1) + '%' })),
          h('span', { text: money(task.spentUSD) + ' of ' + money(task.budgetUSD) })),
        task.stagesDetail.some(function (s) { return s.status === 'done' || s.file || s.pieces.some(function (p) { return p.file; }); }) ? h('details', { class: 't-why' },
          h('summary', { text: 'Every stage and what it wrote' }),
          h('div', { class: 'stack', style: 'gap:14px' }, task.stagesDetail.map(function (s, i) {
            return h('div', { class: 'stack', style: 'gap:8px' },
              h('div', { class: 't-top' }, h('b', { text: (i + 1) + '. ' + s.title }), h('span', { class: 'faint', text: s.label + ' · ' + s.status + (s.finishedAt && s.startedAt ? ' · took ' + secs(s.finishedAt - s.startedAt) : '') })),
              s.file ? teamFile(task.id, s.file, 'Read the coordinator’s ') : null,
              s.pieces.map(function (p) { return teamPiece(task, p, after); }));
          }))) : null,
        out));
  }

  function openTask(id) { go('teamtask', { taskId: id, taskStage: null }); }

  var TASK_BADGE = { queued: ['', 'Up next'], planning: ['working', 'Planning'], running: ['working', 'Running'], done: ['ok', 'Done'], failed: ['bad', 'Failed'], cancelled: ['', 'Cancelled'], waiting: ['waiting', 'Waiting'], questions: ['waiting', 'Has questions'], proposed: ['waiting', 'Plan to approve'], review: ['waiting', 'In review'] };
  function taskBadge(task) {
    var cur = task.stagesDetail.filter(function (s) { return s.current; })[0];
    var b = task.waitingOnYou || task.piecesNeedYou ? ['waiting', 'Needs you'] : TASK_BADGE[task.status] || ['', task.status];
    var at = cur && (task.status === 'running' || task.status === 'waiting') ? ' · stage ' + (task.stagesDetail.indexOf(cur) + 1) + ' of ' + task.stagesDetail.length : '';
    return h('span', { class: 'badge ' + b[0], text: b[1] + at });
  }
  function spendBar(task) {
    var pct = task.budgetUSD ? Math.min(100, (task.spentUSD / task.budgetUSD) * 100) : 0;
    return h('div', { class: 't-spend' }, h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(1) + '%' })), h('span', { text: money(task.spentUSD) + ' of ' + money(task.budgetUSD) }));
  }
  function stageMarks(task) {
    return h('ol', { class: 'tsegs', 'aria-label': 'Stages' }, task.stagesDetail.map(function (s, i) {
      return h('li', { class: stageClass(task, s), title: (i + 1) + '. ' + (s.title || s.label) });
    }));
  }
  function stageClass(task, s) {
    if (s.status === 'done') return s.pieces.some(function (p) { return p.status === 'failed'; }) ? 'part' : 'done';
    if (s.status === 'failed') return 'failed';
    if (s.status === 'skipped') return 'skipped';
    if (s.current && task.status !== 'proposed' && task.status !== 'questions' && task.status !== 'planning') return s.pieces.some(function (p) { return p.waiting; }) || task.status === 'waiting' ? 'need' : 'now';
    return 'next';
  }
  /// How long is too long for a piece still running: three times the
  /// slowest finished piece of this task, and never under half an hour.
  function slowAfter(task) {
    var took = [];
    task.stagesDetail.forEach(function (s) { s.pieces.forEach(function (p) { if (p.status === 'done' && p.startedAt && p.finishedAt) took.push(p.finishedAt - p.startedAt); }); });
    return Math.max(30 * 60000, 3 * Math.max.apply(null, took.concat([0])));
  }

  /// A team task on its team's page: what it is, where it stands, and the
  /// way into it. What it needs from you is answered right here.
  function taskSummary(task, after) {
    var out = h('div', { 'aria-live': 'polite' });
    var cur = task.stagesDetail.filter(function (s) { return s.current; })[0];
    var live = task.status === 'running' || task.status === 'planning';
    var working = cur ? cur.pieces.filter(function (p) { return p.status === 'running'; }) : [];
    var limit = slowAfter(task);
    var slow = working.filter(function (p) { return p.startedAt && Date.now() - p.startedAt > limit; });
    return h('article', { class: 'tsum' + (task.waitingOnYou || task.piecesNeedYou ? ' need' : live ? ' live' : ''), id: 'task-' + task.id },
      h('div', { class: 't-top', style: 'align-items:flex-start' },
        h('div', { style: 'min-width:0;flex:1 1 320px' },
          h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, live ? h('span', { class: 'livedot' }) : null,
            h('button', { class: 'linkish t-title', style: 'color:var(--ink);text-align:left', text: task.title || task.brief, onclick: function () { openTask(task.id); } })),
          h('div', { class: 'faint', style: 'margin-top:2px', text: (task.requestedBy && task.requestedBy !== (state.me && state.me.name) ? task.requestedBy : 'You') + ' asked · ' + when(task.createdAt) })),
        taskBadge(task)),
      task.stagesDetail.length ? stageMarks(task) : null,
      // Answered from what the team knows: the answer is the whole of it.
      task.answered && task.packSummary ? h('div', { class: 't-answer' }, h('span', { class: 't-kind', text: 'Answered from what the team knows' }), md(task.packSummary),
        h('div', null, h('button', { class: 'btn small', text: 'Plan it as a task instead', onclick: function (e) {
          var restore = busy(e.target, 'Asking…');
          api('POST', '/api/team-tasks/' + encodeURIComponent(task.id), { kind: 'plan' }).then(function (y) { restore(); out.textContent = ''; out.appendChild(msg(y, 'Asked again as work. The coordinator is planning.')); if (y.ok !== false) after(); });
        } }))) : null,
      cur && working.length ? h('p', { class: 't-now' }, h('b', { text: working.map(function (p) { return p.workerName; }).join(', ') }), ' ' + (working.length === 1 ? 'is' : 'are') + ' on ' + (task.stagesDetail.indexOf(cur) + 1) + '. ' + (cur.title || cur.label) + '.',
        slow.length ? h('span', { class: 'badge waiting', style: 'margin-left:8px', text: slow.map(function (p) { return p.workerName; }).join(', ') + ' running long' }) : null)
        : task.status === 'planning' ? h('p', { class: 't-now', text: 'The coordinator is planning.' }) : null,
      (function () {
        // One footer: what needs you on the left, spend and Open on the right.
        var tail = [spendBar(task), h('button', { class: 'btn small', text: 'Open the task →', onclick: function () { openTask(task.id); } })];
        var controls = teamTaskControls(task, out, after, tail);
        if (controls) return [controls, out];
        // Nothing waits on you: a task still going can still be stopped.
        var stop = live ? h('button', { class: 'btn small danger', text: 'Stop', onclick: function (e) {
          if (!confirm('Stop this task? Work already written stays in its folder.')) return;
          var restore = busy(e.target, 'Stopping…');
          api('POST', '/api/team-tasks/' + encodeURIComponent(task.id), { kind: 'cancel' }).then(function (y) { restore(); out.textContent = ''; out.appendChild(msg(y, 'Stopped.')); if (y.ok !== false) after(); });
        } }) : null;
        return [out, h('div', { class: 'row', style: 'align-items:center' }, stop, h('span', { class: 'row', style: 'gap:12px;margin-left:auto;flex-wrap:nowrap' }, tail))];
      })());
  }

  /// A "…" button opening a short menu: items are [label, onclick, danger].
  /// Null when there is nothing to put in it.
  function moreMenu(items) {
    items = items.filter(Boolean);
    if (!items.length) return null;
    var wrap, btn, pop;
    var outside = function (e) { if (!wrap.contains(e.target)) close(); };
    var esc = function (e) { if (e.key === 'Escape') { close(); btn.focus(); } };
    var close = function () { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
    pop = h('div', { class: 'menu pi-menu', role: 'menu', hidden: true }, h('div', { class: 'menu-sec' }, items.map(function (m) {
      return h('button', { class: 'menu-item' + (m[2] ? ' pi-danger' : ''), role: 'menuitem', text: m[0], onclick: function (e) { close(); m[1](e); } });
    })));
    btn = h('button', { class: 'btn icon', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('dots', 16));
    btn.onclick = function () {
      if (!pop.hidden) { close(); return; }
      pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', outside); document.addEventListener('keydown', esc);
    };
    wrap = h('div', { class: 'menu-wrap' }, btn, pop);
    return wrap;
  }

  // ---- a team's talk about its pack -------------------------------------
  // The coordinator's wrap-up read into its parts, and each reply folded to
  // its point: ported from shared/flows/teamWrapUp.ts and the desk's
  // landedView.ts, which the console can't import.

  var WRAP_LABELS = [['changes', 'worth changing in the pack|changes? (?:to|in|for) the pack|worth changing|pack changes?'], ['open', 'still open|open questions?|unresolved|open'], ['agreed', 'agreed|agreement|consensus'], ['bottom', 'bottom line|in short|tl;?dr|summary']];
  var WRAP_ALT = WRAP_LABELS.map(function (l) { return l[1]; }).join('|');
  var WRAP_NOTHING = new RegExp('^(?:none|nothing|n\\/?a|no(?:ne)? (?:yet|so far)|—|-|–|…|\\.\\.\\.)\\.?$', 'i');
  var LIST_MARK = new RegExp('^\\s*(?:[-*•+]|\\d+[.)])\\s+');
  function wrapSection(label) {
    var l = label.toLowerCase();
    for (var i = 0; i < WRAP_LABELS.length; i++) if (new RegExp('^(?:' + WRAP_LABELS[i][1] + ')$', 'i').test(l)) return WRAP_LABELS[i][0];
    return 'bottom';
  }
  function wrapClean(text) {
    return text.replace(LIST_MARK, '').replace(/\*\*|__/g, '').replace(new RegExp('(^|\\s)[*_](\\S[^*_]*\\S|\\S)[*_](?=\\s|[.,;:!?]|$)', 'g'), '$1$2').replace(/\s+/g, ' ').trim();
  }
  function wrapItems(body) {
    var out = [], lines = body.split('\n');
    var anyBullet = lines.some(function (l) { return LIST_MARK.test(l); });
    var current = null;
    var flush = function () { if (current === null) return; var c = wrapClean(current); if (c && !WRAP_NOTHING.test(c)) out.push(c); current = null; };
    lines.forEach(function (line) {
      if (!line.trim()) { if (!anyBullet) flush(); return; }
      if (LIST_MARK.test(line)) { flush(); current = line; } else if (current === null) current = line; else current += ' ' + line.trim();
    });
    flush();
    return out;
  }
  /// { bottomLine, agreed, open, changes }, or null when it has none of the labels.
  function parseWrapUp(text) {
    var src = String(text || '').replace(/\r\n?/g, '\n');
    var bold = new RegExp('(?:\\*\\*|__)\\s*(' + WRAP_ALT + ')\\s*(?::\\s*(?:\\*\\*|__)|(?:\\*\\*|__)\\s*:)', 'gi');
    var line = new RegExp('^[ \\t]*(?:#{1,6}[ \\t]*)?(?:[-*•][ \\t]+)?(?:\\*\\*|__)?(' + WRAP_ALT + ')(?:\\*\\*|__)?[ \\t]*(?::|$)', 'gim');
    var marks = [];
    [bold, line].forEach(function (re) {
      re.lastIndex = 0;
      for (var m = re.exec(src); m; m = re.exec(src)) {
        var at = m.index, end = at + m[0].length;
        if (marks.some(function (k) { return at < k.end && end > k.at; })) continue;
        marks.push({ at: at, end: end, section: wrapSection(m[1]) });
      }
    });
    if (!marks.some(function (m) { return m.section !== 'bottom'; })) return null;
    marks.sort(function (a, b) { return a.at - b.at; });
    var out = { bottomLine: '', agreed: [], open: [], changes: [] }, bottom = [];
    var lead = src.slice(0, marks[0].at).trim();
    if (lead) bottom.push(lead);
    marks.forEach(function (mark, i) {
      var body = src.slice(mark.end, marks[i + 1] ? marks[i + 1].at : src.length).replace(/^[ \t]*(?:\*\*|__)?[ \t]*/, '');
      if (mark.section === 'bottom') { if (body.trim()) bottom.push(body.trim()); return; }
      out[mark.section] = out[mark.section].concat(wrapItems(body));
    });
    out.bottomLine = wrapClean(bottom.join(' ').replace(/^#{1,6}\s+.*$/gm, ''));
    if (WRAP_NOTHING.test(out.bottomLine)) out.bottomLine = '';
    return out;
  }
  /// An open item's question, and who answers it by when: "Q? — finance, by Friday".
  function splitOwner(item) {
    var dash = item.match(/^(.*\S)\s+(?:—|–|--|-)\s+(\S.*)$/);
    if (dash && dash[1].length >= 8) return { text: dash[1], who: dash[2] };
    var paren = item.match(/^(.*\S)\s*\(([^()]+)\)\.?$/);
    if (paren && paren[1].length >= 8) return { text: paren[1], who: paren[2] };
    return { text: item };
  }
  function plainLine(text) {
    return String(text || '').replace(/\x60{3}[\s\S]*?\x60{3}/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_\x60#>]/g, '').replace(/\s+/g, ' ').trim();
  }
  /// A reply folded to its point: its bold lead, else its first sentence;
  /// "more" is how much "Show detail" opens to.
  function replyGist(text) {
    var src = String(text || '').trim(), flat = plainLine(src);
    var lm = src.match(/^(?:\*\*|__)([^*_\n]{8,200}?)(?:\*\*|__)/);
    var lead = lm ? lm[1].trim().replace(/[:\s]+$/, '') : '';
    var sm = flat.match(/^.{20,}?[.!?](?=\s|$)/);
    var gist = lead || (sm ? sm[0] : '') || flat;
    if (gist.length > 240) { var cut = gist.slice(0, 240), sp = cut.lastIndexOf(' '); gist = (sp > 160 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…'; }
    if (flat.length - plainLine(gist.replace(/…$/, '')).length <= 8) return { gist: gist, more: 0 };
    var bullets = src.split('\n').filter(function (l) { return LIST_MARK.test(l); }).length;
    if (bullets > 0) return { gist: gist, more: bullets };
    var sentences = (flat.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [flat]).length;
    return { gist: gist, more: Math.max(1, sentences - 1) };
  }
  /// Who a reply answers: teammates it names who spoke before it in the
  /// exchange; you, when it's the first answer; everyone, for a wrap-up.
  function repliesTo(messages, index) {
    var m = messages[index];
    if (!m || m.speaker.kind === 'you') return [];
    if (m.wrapUp) return ['everyone'];
    var self = m.speaker.kind === 'member' ? m.speaker.name : 'Coordinator';
    var before = messages.slice(0, index).filter(function (x) { return x.exchange === m.exchange; });
    var earlier = [];
    before.forEach(function (x) { if (x.speaker.kind === 'member' && x.speaker.name !== self && earlier.indexOf(x.speaker.name) < 0) earlier.push(x.speaker.name); });
    var text = m.text.toLowerCase();
    var named = earlier.filter(function (name) {
      var n = name.toLowerCase().replace(/[.*+?^$\x7b}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9_])@?' + n + '(?![a-z0-9_])').test(text);
    });
    if (named.length) return named;
    var asked = before.some(function (x) { return x.speaker.kind === 'you'; });
    var answered = before.some(function (x) { return x.speaker.kind !== 'you' && !x.failed; });
    return asked && !answered ? ['you'] : [];
  }
  /// The coordinator's latest wrap-up that reads as one, and whether the pack has it.
  function latestWrapUp(task) {
    var ms = (task.room && task.room.messages) || [];
    for (var i = ms.length - 1; i >= 0; i--) {
      if (!ms[i].wrapUp || ms[i].failed) continue;
      var wrap = parseWrapUp(ms[i].text);
      if (wrap) return { message: ms[i], index: i, wrap: wrap, folded: i < ((task.room && task.room.foldedThrough) || 0) };
    }
    return null;
  }
  function teamReplies(ms) { return ms.filter(function (m) { return m.speaker.kind !== 'you' && !m.failed; }).length; }
  /// Exchanges since the pack was written, with a reply in them.
  function unfoldedExchanges(task) {
    var ms = (task.room && task.room.messages) || [], seen = {};
    ms.slice((task.room && task.room.foldedThrough) || 0).forEach(function (m) { if (m.speaker.kind !== 'you' && !m.failed) seen[m.exchange] = 1; });
    return Object.keys(seen).length;
  }
  function canKeepDebating(task) {
    var ms = (task.room && task.room.messages) || [];
    if (!ms.length || (task.room && task.room.busy)) return false;
    var last = ms[ms.length - 1].exchange;
    return ms.some(function (m) { return m.exchange === last && m.speaker.kind === 'member' && !m.failed; });
  }

  /// One team task on its own page, the whole width: its stages across the
  /// top, what it needs from you, then where the team landed, its debate,
  /// the pack and the brief; what changed and who did what beside them.
  function viewTeamTask() {
    var id = state.taskId;
    var load = function () {
      return Promise.all([api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/page'), api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/files').catch(function () { return { ok: false }; })]);
    };
    return load().then(function (r) {
      var x = r[0];
      if (x.ok === false) return [msg(x)];
      var team = x.team;
      var host = h('div', { class: 'pi-page tt-page' });
      var timer = null, fastUntil = 0, lastKey = '';
      var seenBy = state.taskSeen || (state.taskSeen = {});
      var offBy = state.taskOff || (state.taskOff = {});
      var drafts = state.taskDraft || (state.taskDraft = {});

      var draw = function (task, files) {
        noteTaskComments(task, refresh);
        var me = state.me && state.me.name;
        var room = task.room || { messages: [] };
        var ms = room.messages || [];
        var pack = task.pack;
        var version = pack ? pack.version || 1 : 0;
        var done = task.status === 'done', review = task.status === 'review';
        var active = ['queued', 'planning', 'questions', 'proposed', 'running', 'waiting'].indexOf(task.status) >= 0;
        var talkable = !!pack && (review || done) && task.canSteer;
        var landed = latestWrapUp(task);
        var pending = landed && !landed.folded ? landed.wrap.changes : [];
        var talked = unfoldedExchanges(task);
        var out = h('div', { 'aria-live': 'polite' });
        var post = function (path, body, okText, button, label) {
          var restore = button ? busy(button, label || 'Sending…') : function () {};
          return api('POST', '/api/team-tasks/' + encodeURIComponent(task.id) + path, body || {}).then(function (y) {
            restore();
            fill(out, y.ok === false ? msg(y) : okText ? msg(y, okText) : null);
            if (y.ok !== false) { fastUntil = Date.now() + 120000; setTimeout(refresh, 800); }
            return y;
          });
        };
        var decide = function (body, okText) { return function (e) { post('', body, okText, e && e.target); }; };
        var setTab = function (t) { state.taskTab = t; if (t === 'debate') seenBy[task.id] = ms.length; draw(task, files); };

        // ---- Header: the team, the task, the crew, the spend.
        var bs = briefShort(task.brief);
        var asker = task.requestedBy && task.requestedBy !== me ? task.requestedBy : 'You';
        var crumbs = [task.code ? 'code on ' + task.code.branch : null, asker + ' asked ' + when(task.createdAt).replace(/^Today /, 'today ')].filter(Boolean).join(' · ');
        var menu = moreMenu([
          review && task.canSteer ? ['Accept the pack', function (e) { post('', { kind: 'accept' }, 'Accepted. The task is done.'); }] : null,
          ['Open the shared folder', function () { go('teamfiles', { taskId: task.id }); }],
          bs.long ? ['Read the whole brief', function () { openReader('The brief', task.title || '', function (put) { put([md(task.brief)]); }); }] : null,
          active && task.canSteer ? ['Stop the task', function () { if (confirm('Stop this task? Work already written stays in its folder.')) post('', { kind: 'cancel' }, 'Stopped.'); }, true] : null,
        ]);
        var cur = task.stagesDetail.filter(function (s) { return s.current; })[0];
        var faces = (team.members || []).slice(0, 6);
        var header = h('header', { class: 'pi-head' },
          h('div', { class: 'pi-top' },
            h('div', { class: 'pi-titles' },
              h('span', { class: 'pi-crumb' }, h('button', { class: 'linkish', text: 'Teams', onclick: function () { go('teams'); } }), ' / ',
                h('button', { class: 'linkish', text: team.name, onclick: function () { go('team', { teamId: team.id }); } }), ' · ' + crumbs),
              h('div', { class: 'row', style: 'gap:10px' }, h('h1', { class: 'pi-title', text: task.title || bs.text }), room.busy ? h('span', { class: 'badge working', text: room.busy.speaker + ' is answering' }) : taskBadge(task)),
              task.title && bs.text !== task.title ? h('span', { class: 'pi-brief', text: bs.text }) : null),
            h('div', { class: 'row', style: 'gap:14px' },
              faces.length ? h('span', { class: 'faces', 'aria-label': 'The team: ' + faces.map(function (m) { return m.name; }).join(', ') }, faces.map(function (m) { var a = avatar(m.workerId, m.name, 's'); a.setAttribute('title', m.name + (m.role ? ' · ' + m.role : '')); return a; })) : null,
              h('div', { class: 'tt-spend' }, spendBar(task)),
              menu)),
          task.stagesDetail.length ? h('ol', { class: 'tt-track', 'aria-label': 'Stages', style: '--n:' + Math.min(task.stagesDetail.length, 8) }, task.stagesDetail.map(function (s, i) {
            var c = stageClass(task, s);
            return h('li', { class: c, title: (i + 1) + '. ' + (s.title || s.label) + ' · ' + s.status }, h('span', { class: 'tt-bar' }), h('span', { class: 'tt-sname', text: s.title || s.label }));
          })) : null);

        // ---- Your turn: what it needs from you, plainly, with what answers it.
        var band = null;
        var bandRow = function (tone, ic, title, detail, actions, below) {
          return h('section', { class: 'pi-band ' + tone, 'aria-label': 'Your turn' },
            h('div', { class: 'pi-bandrow' }, h('span', { class: 'pi-bandic' }, icon(ic, 18)),
              h('div', { class: 'pi-bandtext' }, h('b', { text: title }), detail ? h('span', { class: 'pi-bandsub', text: detail }) : null),
              actions && actions.length ? h('div', { class: 'row', style: 'gap:8px' }, actions) : null),
            below || null);
        };
        // In review the band below is the whole of it; the controls are for questions, a plan or a checkpoint.
        var controls = review ? null : teamTaskControls(task, out, refresh);
        if (!room.busy && review && task.canSteer) {
          var head = 'Version ' + version + ', ' + plural(pack.files.length, 'file', 'files') + '.';
          var keep = canKeepDebating(task) ? h('button', { class: 'btn', text: 'Keep debating', onclick: function (e) { post('/room/continue', {}, 'Another round: the team is weighing in.', e.target); setTab('debate'); } }) : null;
          if (pending.length) {
            band = bandRow('need', 'check', 'Your turn: the pack is ready to review', head + ' The team debated after it was built, and ' + (pending.length === 1 ? '1 change they agreed on isn’t' : pending.length + ' changes they agreed on aren’t') + ' in it yet.', [
              h('button', { class: 'btn go', text: 'Add the ' + plural(pending.length, 'change', 'changes') + ', then review', onclick: function (e) { post('/update-pack', { changes: pending }, 'The coordinator is folding them into the pack.', e.target, 'Asking…'); } }),
              h('button', { class: 'btn', text: 'Review v' + version + ' as it is', onclick: function () { setTab('pack'); } }), keep]);
          } else if (talked) {
            band = bandRow('need', 'check', 'Your turn: the pack is ready to review', head + ' The team talked after it was built: ' + plural(talked, 'exchange isn’t', 'exchanges aren’t') + ' in it.', [
              h('button', { class: 'btn go', text: 'Review v' + version, onclick: function () { setTab('pack'); } }),
              h('button', { class: 'btn', text: 'Update the pack first', onclick: function (e) { post('/update-pack', {}, 'The coordinator is folding the talk into the pack.', e.target, 'Asking…'); } }), keep]);
          } else {
            band = bandRow('need', 'check', 'Your turn: the pack is ready to review', head, [h('button', { class: 'btn go', text: 'Review v' + version, onclick: function () { setTab('pack'); } })]);
          }
        } else if (!room.busy && task.waitingOnYou && task.needs === 'answers') {
          var nq = (task.questions || []).length;
          band = bandRow('need', 'check', 'Your turn: the coordinator has ' + plural(nq, 'question', 'questions'), 'Answer what you can before it plans. Leave one blank and the coordinator decides.', null, h('div', { class: 'tt-bandbody' }, controls, aboutRow(task)));
        } else if (!room.busy && task.waitingOnYou && task.needs === 'plan') {
          var crew = {};
          task.stagesDetail.forEach(function (s) { s.pieces.forEach(function (p) { crew[p.workerId] = 1; }); });
          band = bandRow('need', 'check', 'Your turn: approve the plan', plural(task.stagesDetail.length, 'stage', 'stages') + ' with ' + plural(Object.keys(crew).length, 'member', 'members') + '. Nothing runs until you approve.', [
            h('button', { class: 'btn go', text: 'Approve and start', onclick: decide({ kind: 'approve' }, 'Approved. The team is on it.') }),
            h('button', { class: 'btn', text: 'Read the plan first', onclick: function () { setTab('plan'); } })]);
        } else if (!room.busy && task.waitingOnYou) {
          band = bandRow('need', 'check', task.needs === 'budget' ? 'Your turn: the task reached its budget' : task.needs === 'checkpoint' ? 'Your turn: a checkpoint' : 'Your turn: a stage needs you', '', null, controls ? h('div', { class: 'tt-bandbody' }, controls) : null);
        } else if (!room.busy && task.piecesNeedYou) {
          band = bandRow('need', 'check', 'Your turn: ' + plural(task.piecesNeedYou, 'step waits', 'steps wait') + ' for your OK', cur ? 'At ' + (cur.title || cur.label) + '.' : '', [h('button', { class: 'btn go', text: 'See what they need', onclick: function () { setTab('plan'); } })]);
        }

        // ---- Tabs.
        var replies = teamReplies(ms);
        var landedFresh = landed && teamReplies(ms.slice(landed.index + 1)) === 0;
        var roomWork = (task.status === 'running' || task.status === 'waiting') && cur && cur.fromRoom;
        var TABS = [landed ? ['landed', 'Where it landed', 0] : null, ms.length || talkable ? ['debate', 'Debate', replies] : null, pack ? ['pack', 'Pack', 'v' + version] : null, ['plan', 'Brief & plan', 0]].filter(Boolean);
        if (state.taskTabFor !== task.id) {
          state.taskTabFor = task.id;
          var seen = seenBy[task.id] || 0;
          var fresh = teamReplies(ms.slice(seen)) > 0 || (ms.length && pack && (ms[ms.length - 1].at || 0) > (pack.updatedAt || 0));
          state.taskTab = !pack ? 'plan' : room.busy || roomWork ? 'debate' : landed && landedFresh ? 'landed' : ms.length && fresh ? 'debate' : 'pack';
        }
        var tab = TABS.some(function (t) { return t[0] === state.taskTab; }) ? state.taskTab : TABS[0][0];
        if (tab === 'debate') seenBy[task.id] = ms.length;
        var tabs = h('div', { class: 'pi-tabs', role: 'tablist', 'aria-label': 'Task views' }, TABS.map(function (t) {
          return h('button', { type: 'button', role: 'tab', 'aria-selected': tab === t[0] ? 'true' : 'false', onclick: function () { setTab(t[0]); } }, t[1], t[2] ? h('span', { class: 'pi-count', text: String(t[2]) }) : null);
        }));

        // The box to talk to the team, under every tab once there is a pack.
        var ask = null, askBox = null;
        if (talkable) {
          askBox = h('textarea', { rows: '1', class: 'tt-askin', placeholder: 'e.g. @' + ((team.members || [])[0] ? team.members[0].name : 'Name') + ' redo this with the new numbers', 'aria-label': 'Ask the team, or one person, to change something', value: drafts[task.id] || '' });
          // It grows with what you type, up to a few lines.
          var fit = function () { askBox.style.height = 'auto'; askBox.style.height = Math.min(askBox.scrollHeight, 160) + 'px'; };
          askBox.oninput = function () { drafts[task.id] = askBox.value; fit(); };
          var send = function (e) {
            var text = askBox.value.trim();
            if (!text) { askBox.focus(); return; }
            post('/room', { text: text }, null, e && e.target && e.target.tagName === 'BUTTON' ? e.target : null).then(function (y) { if (y.ok !== false) { drafts[task.id] = ''; state.taskTab = 'debate'; } });
          };
          // Enter or ⌘↵ sends; Shift+Enter starts a new line.
          askBox.onkeydown = function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e); } };
          var tries = [talked ? ['Fold in the debate', function (e) { post('/update-pack', {}, 'The coordinator is folding the talk into the pack.', e.target, 'Asking…'); }] : null]
            .concat((team.members || []).slice(0, 3).map(function (m) { return ['@' + m.name, function () { askBox.value = '@' + m.name + ' ' + askBox.value.replace(/^@\S+\s*/, ''); drafts[task.id] = askBox.value; askBox.focus(); }]; })).filter(Boolean);
          ask = h('div', { class: 'tt-ask' },
            h('label', { class: 'faint', text: 'Ask the team, or one person, to change something' }),
            h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, askBox, h('button', { class: 'btn small go', text: 'Send', onclick: send })),
            tries.length ? h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Try' }), tries.map(function (t) { return h('button', { type: 'button', class: 'tt-try', text: t[0], onclick: t[1] }); })) : null);
        }
        var replyTo = function (name) {
          if (!askBox) return;
          askBox.value = '@' + name + ' ' + askBox.value.replace(/^@\S+\s*/, '');
          drafts[task.id] = askBox.value;
          askBox.focus();
          askBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
        };

        var body;
        if (tab === 'landed') {
          var w = landed.wrap;
          var off = offBy[task.id + ':' + landed.message.id] || (offBy[task.id + ':' + landed.message.id] = {});
          var picked = w.changes.filter(function (c, i) { return !off[i]; });
          var sendBtn = h('button', { class: 'btn go', style: 'align-self:flex-start', text: 'Send ' + picked.length + ' to the pack', disabled: !picked.length || !talkable || !!room.busy });
          sendBtn.onclick = function () { post('/update-pack', { changes: w.changes.filter(function (c, i) { return !off[i]; }) }, 'The coordinator is folding them into the pack.', sendBtn, 'Asking…'); };
          var pickCount = h('span', { text: picked.length + ' picked' });
          var cardsL = [];
          if (w.agreed.length) cardsL.push(h('div', { class: 'pi-card pi-mini' }, h('span', { class: 'label tt-ok', text: 'Agreed · ' + w.agreed.length }),
            w.agreed.map(function (a) { return h('div', { class: 'tt-item' }, h('span', { class: 'tt-tick' }, icon('tick', 14)), h('span', { text: a })); })));
          if (w.open.length) cardsL.push(h('div', { class: 'pi-card pi-mini' }, h('span', { class: 'label pi-need', text: 'Still open · ' + w.open.length }),
            w.open.map(function (o) { var s = splitOwner(o); return h('div', { class: 'pi-handed' }, h('span', { text: s.text }), s.who ? h('span', { class: 'faint', text: s.who }) : null); })));
          if (w.changes.length) cardsL.push(h('div', { class: 'pi-card pi-mini' },
            landed.folded ? h('span', { class: 'label pi-go', text: 'In the pack · ' + w.changes.length }) : h('span', { class: 'label pi-go' }, 'Change in the pack · ', pickCount),
            w.changes.map(function (c, i) {
              if (landed.folded) return h('div', { class: 'tt-item' }, h('span', { class: 'tt-tick' }, icon('tick', 14)), h('span', { text: c }));
              var box = h('input', { type: 'checkbox', checked: !off[i] });
              box.onchange = function () { off[i] = !box.checked; var n = w.changes.filter(function (_c, j) { return !off[j]; }).length; pickCount.textContent = n + ' picked'; sendBtn.textContent = 'Send ' + n + ' to the pack'; sendBtn.disabled = !n || !talkable || !!room.busy; };
              return h('label', { class: 'tt-pick' }, box, h('span', { text: c }));
            }),
            landed.folded ? h('span', { class: 'faint', text: 'Already folded into v' + version + '.' }) : talkable ? sendBtn : null));
          body = h('div', { class: 'stack', style: 'gap:14px' },
            h('div', { class: 'pi-card pi-stand' },
              h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'pi-badge P tt-c', text: 'C', 'aria-hidden': 'true' }), h('span', { class: 'label', text: 'The bottom line · from the coordinator · ' + when(landed.message.at) })),
              h('p', { class: 'pi-lead', style: 'margin:0', text: w.bottomLine || 'The coordinator went straight to the lists.' })),
            cardsL.length ? h('div', { class: 'pi-cards' }, cardsL) : null);
        } else if (tab === 'debate') {
          var rows = [];
          var openKey = state.taskOpenReply || (state.taskOpenReply = {});
          ms.forEach(function (m, i) {
            if (m.speaker.kind === 'you') { rows.push(h('div', { class: 'tt-asked' }, h('b', { text: 'You asked' }), h('span', { text: plainLine(m.text) }), h('span', { class: 'faint', text: clock(m.at) }))); return; }
            var name = m.speaker.kind === 'member' ? m.speaker.name : 'Coordinator';
            if (m.failed) { rows.push(h('div', { class: 'tt-asked faint', text: name + ' couldn’t answer: ' + m.text })); return; }
            var to = repliesTo(ms, i);
            var g = m.wrapUp && landed && landed.message.id === m.id ? { gist: 'Wrote up where this landed: ' + [plural(landed.wrap.agreed.length, 'agreed', 'agreed'), landed.wrap.open.length + ' open', plural(landed.wrap.changes.length, 'change', 'changes') + ' for the pack'].join(', ') + '.', more: 1 } : replyGist(m.text);
            var isOpen = !!openKey[m.id];
            var detail = h('div', { class: 'tt-detail', hidden: !isOpen }, isOpen ? md(m.text) : null);
            var toggle = h('button', { type: 'button', class: 'tt-link', text: isOpen ? 'Hide detail' : 'Show detail (' + g.more + ')' });
            toggle.onclick = function () {
              var now = !openKey[m.id]; openKey[m.id] = now; detail.hidden = !now;
              if (now && !detail.firstChild) append(detail, md(m.text));
              toggle.textContent = now ? 'Hide detail' : 'Show detail (' + g.more + ')';
            };
            rows.push(h('article', { class: 'pi-card tt-reply' + (m.wrapUp ? ' wrap' : '') },
              m.speaker.kind === 'member' ? avatar(m.speaker.workerId || name, name, 's') : h('span', { class: 'pi-badge P tt-c', text: 'C', 'aria-hidden': 'true' }),
              h('div', { class: 'tt-rbody' },
                h('div', { class: 'row', style: 'gap:8px' }, h('b', { text: name }), m.wrapUp ? h('span', { class: 'pi-tag now', text: 'Summed up' }) : null,
                  h('span', { class: 'faint', text: (to.length ? 'to ' + to.join(', ') + ' · ' : '') + clock(m.at) })),
                h('p', { class: 'tt-gist', text: g.gist }),
                detail,
                h('div', { class: 'row', style: 'gap:6px' },
                  g.more ? toggle : null,
                  m.wrapUp ? h('button', { type: 'button', class: 'tt-link', text: 'See where it landed', onclick: function () { setTab('landed'); } }) : null,
                  m.speaker.kind === 'member' && askBox ? [g.more || m.wrapUp ? h('span', { class: 'faint', text: '·' }) : null, h('button', { type: 'button', class: 'tt-link', text: 'Reply to ' + name, onclick: function () { replyTo(name); } })] : null))));
          });
          body = h('div', { class: 'stack', style: 'gap:10px' },
            h('div', { class: 'row', style: 'gap:10px' },
              h('span', { class: 'faint', style: 'flex:1', text: ms.length ? plural(replies, 'reply', 'replies') + (talked ? ' · ' + plural(talked, 'exchange', 'exchanges') + ' since the pack was written' : '') + ' · each folded to its point' : 'Nobody has said anything yet. Ask the team about the pack below.' }),
              canKeepDebating(task) && talkable ? h('button', { class: 'btn small', text: 'Keep debating', onclick: function (e) { post('/room/continue', {}, null, e.target); } }) : null),
            rows,
            room.busy ? thinking(room.busy.speaker + ' is answering…') : null,
            room.queued ? h('span', { class: 'faint', text: plural(room.queued, 'question waits', 'questions wait') + ' its turn.' }) : null);
        } else if (tab === 'pack') {
          var changedSet = pack.changed || pack.files;
          body = h('div', { class: 'stack', style: 'gap:14px' },
            h('div', { class: 'pi-card pi-stand' },
              h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'label', style: 'flex:1', text: 'Pack v' + version + (pack.updatedAt ? ' · ' + when(pack.updatedAt) : '') }),
                review && task.canSteer ? h('button', { class: 'btn small go', text: 'Accept the pack', title: 'Read it first. Accepting marks the task done.', onclick: function (e) { post('', { kind: 'accept' }, 'Accepted. The task is done.', e.target, 'Accepting…'); } }) : null),
              h('div', { class: 'pi-lead' }, md(pack.summary))),
            pack.files.length ? h('div', { class: 'stack', style: 'gap:6px' }, pack.files.map(function (f) {
              var d = teamFile(task.id, f, 'Read ');
              if (changedSet.indexOf(f) >= 0 && version > 1) d.querySelector('summary').appendChild(h('span', { class: 'pi-tag now', style: 'margin-left:8px', text: 'changed in v' + version }));
              return d;
            })) : null,
            task.code ? card('taskcode', 'Code', null, teamCode(task)) : null);
        } else {
          // The brief, your answers, the plan, and every stage with its members' pieces.
          var limit = slowAfter(task);
          var qa = (task.questions || []).map(function (q, i) { return task.answers && task.answers[i] ? [q, task.answers[i]] : null; }).filter(Boolean);
          var stagesList = task.stagesDetail.length ? h('div', { class: 'stack', style: 'gap:10px' }, task.stagesDetail.map(function (s, i) {
            var c = stageClass(task, s);
            var took = s.finishedAt && s.startedAt ? secs(s.finishedAt - s.startedAt) : s.startedAt && (c === 'now' || c === 'need') ? secs(Date.now() - s.startedAt) + ' so far' : '';
            var d = h('details', { class: 'pi-card tt-stage ' + c, open: s.current || (state.taskStage === i) },
              h('summary', null, h('span', { class: 'pi-num tt-n ' + c, text: c === 'done' ? '✓' : c === 'failed' ? '✕' : String(i + 1) }),
                h('b', { text: s.title || s.label }), h('span', { class: 'faint', text: [s.label, s.pieces.length ? s.pieces.map(function (p) { return p.workerName; }).join(', ') : 'Coordinator', took].filter(Boolean).join(' · ') })),
              h('div', { class: 'tt-stagebody' },
                s.error ? h('div', { class: 'msg err', text: s.error }) : null,
                s.file ? teamFile(task.id, s.file, 'Read the coordinator’s ') : null,
                s.pieces.length ? h('div', { class: 'prows' }, s.pieces.map(function (p) { return pieceRow(task, p, limit, refresh); })) : h('p', { class: 'muted', style: 'margin:0', text: 'The coordinator does this stage itself.' })));
            return d;
          })) : h('p', { class: 'muted', text: task.status === 'planning' ? 'The coordinator is reading the brief and writing questions or a plan.' : 'No stages yet.' });
          body = h('div', { class: 'stack', style: 'gap:14px' },
            task.status === 'planning' ? thinking('The coordinator is planning.') : null,
            !done && task.nowSentence ? h('p', { class: 'muted', style: 'margin:0', text: task.nowSentence }) : null,
            task.waitingOnYou && task.needs === 'plan' && controls ? h('div', { class: 'pi-card' }, h('span', { class: 'label pi-need', text: 'The plan, waiting on you' }), controls, aboutRow(task)) : null,
            stagesList,
            h('div', { class: 'pi-card stack', style: 'gap:8px' },
              h('span', { class: 'label', text: 'What ' + (asker === 'You' ? 'you' : asker) + ' asked for · ' + when(task.createdAt) }),
              h('div', { class: 'pi-sum', style: 'color:var(--ink)' }, md(task.brief)),
              qa.length ? h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'label', text: 'Your answers' }), qa.map(function (p) { return h('div', { class: 'pi-handed' }, h('b', { text: p[0] }), h('span', { class: 'muted', text: p[1] })); })) : null),
            task.planNote && !(task.waitingOnYou && task.needs === 'plan') ? h('div', { class: 'pi-card stack', style: 'gap:8px' }, h('span', { class: 'label', text: 'The plan' }), md(task.planNote), aboutRow(task)) : null);
        }

        // ---- Beside it: what changed in the pack, and who did what.
        var aside = [];
        var fileRows = files && files.ok !== false ? files.files : [];
        var authorOf = function (name) { var f = (task.files || []).filter(function (x) { return x.name === name; })[0]; return f ? f.author + ' · ' + ago(f.at) : ''; };
        var openFolder = h('button', { class: 'linkish', style: 'color:var(--go)', text: 'Open folder', onclick: function () { go('teamfiles', { taskId: task.id }); } });
        if (pack) {
          var changed = pack.changed || pack.files;
          aside.push(h('div', { class: 'pi-card pi-side' },
            h('div', { class: 'row' }, h('span', { class: 'label', style: 'flex:1', text: (version > 1 ? 'Changed in v' + version : 'In the pack') + (pack.updatedAt ? ' · ' + clock(pack.updatedAt) : '') }), openFolder),
            changed.length ? changed.slice(0, 4).map(function (f) {
              return h('button', { type: 'button', class: 'tt-fileline', onclick: function () { go('teamfiles', { taskId: task.id, teamFilePick: f }); } }, h('b', { text: f }), h('span', { class: 'faint', text: authorOf(f) }));
            }) : h('span', { class: 'muted', text: 'No files changed.' }),
            pack.files.length > Math.min(4, changed.length) ? h('button', { type: 'button', class: 'tt-link', style: 'align-self:flex-start', text: plural(pack.files.length - Math.min(4, changed.length), 'more file', 'more files') + ' in the pack', onclick: function () { setTab('pack'); } }) : null));
        } else if (fileRows.length) {
          aside.push(h('div', { class: 'pi-card pi-side' },
            h('div', { class: 'row' }, h('span', { class: 'label', style: 'flex:1', text: 'Written so far · ' + fileRows.length }), openFolder),
            fileRows.slice(0, 5).map(function (f) { return h('button', { type: 'button', class: 'tt-fileline', onclick: function () { go('teamfiles', { taskId: task.id, teamFilePick: f.name }); } }, h('b', { text: f.name }), h('span', { class: 'faint', text: authorOf(f.name) })); }),
            fileRows.length > 5 ? h('span', { class: 'faint', text: '+ ' + (fileRows.length - 5) + ' more' }) : null));
        }
        var worked = task.stagesDetail.filter(function (s) { return s.status !== 'pending' || s.startedAt; });
        var nPieces = worked.reduce(function (n, s) { return n + Math.max(1, s.pieces.length); }, 0);
        if (worked.length) aside.push(h('div', { class: 'pi-card pi-side' },
          h('span', { class: 'label', text: 'Who did what · ' + plural(nPieces, 'piece', 'pieces') }),
          worked.map(function (s) {
            var i = task.stagesDetail.indexOf(s);
            var span = s.startedAt ? clock(s.startedAt) + (s.finishedAt && clock(s.finishedAt) !== clock(s.startedAt) ? '–' + clock(s.finishedAt) : '') : '';
            var fin = s.pieces.filter(function (p) { return p.status === 'done'; }).length;
            return h('button', { type: 'button', class: 'pi-crew tt-crew', onclick: function () { state.taskStage = i; setTab('plan'); } },
              h('span', { class: 'pi-num tt-n ' + stageClass(task, s), text: String(i + 1) }),
              h('span', { class: 'pi-vname' }, h('span', { class: 'pi-cstage', text: s.title || s.label }), h('span', { class: 'faint', text: ['Stage ' + (i + 1), s.pieces.length > 1 ? fin + ' of ' + s.pieces.length + ' done' : null, span].filter(Boolean).join(' · ') })),
              h('span', { class: 'faces' }, s.pieces.length ? s.pieces.slice(0, 4).map(function (p) { var a = avatar(p.workerId, p.workerName, 's'); a.setAttribute('title', p.workerName); return a; }) : h('span', { class: 'pi-badge P tt-c', text: 'C', title: 'Coordinator' })));
          })));
        if (task.code && tab !== 'pack') aside.push(h('div', { class: 'pi-card pi-side' }, h('span', { class: 'label', text: 'Code' }), teamCode(task)));

        var y = window.scrollY;
        var was = host.firstChild ? host.cloneNode(false) : null;
        if (was) while (host.firstChild) was.appendChild(host.firstChild);
        fill(host, [header, band, out, task.error ? h('div', { class: 'msg err', text: task.error }) : null,
          h('div', { class: 'pi-cols' },
            h('div', { class: 'pi-main' }, tabs, body, ask, commentsCard(task)),
            aside.length ? h('aside', { class: 'pi-aside', 'aria-label': 'Files and pieces' }, aside) : null)]);
        if (was) { keepPlace(was, host); requestAnimationFrame(function () { window.scrollTo(0, y); }); }
        lastKey = taskKey(task, files);
        clearTimeout(timer);
        if (active || room.busy || Date.now() < fastUntil) timer = setTimeout(refresh, room.busy ? 3000 : 5000);
      };
      // What the page shows, in short: a refresh that changes none of it
      // draws nothing, so the page stays still under the reader.
      var taskKey = function (task, files) {
        var room = task.room || {};
        return JSON.stringify([task.status, task.stageIndex, task.waitingOnYou, task.piecesNeedYou, task.error || '',
          task.stagesDetail.map(function (s) { return [s.status, s.file || '', s.pieces.map(function (p) { return [p.status, !!p.waiting, p.step ? p.step.index : 0, p.file || '']; })]; }),
          files && files.ok !== false ? files.files.length : -1,
          (task.comments || []).map(function (c) { return c.id + (c.outcome || ''); }).join(),
          (room.messages || []).length, room.busy ? room.busy.speaker : '', room.foldedThrough || 0, room.queued || 0,
          task.pack ? [task.pack.version || 1, task.pack.updatedAt || 0] : 0]);
      };
      // Typing in the page holds a redraw back until you're done.
      var typing = function () { var el = document.activeElement; return !!(el && host.contains(el) && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'))); };
      var refresh = function () {
        clearTimeout(timer);
        if (!host.isConnected || state.tab !== 'teamtask' || state.taskId !== id) return;
        load().then(function (y) {
          if (y[0].ok === false || !host.isConnected) return;
          if (taskKey(y[0].task, y[1]) === lastKey || typing()) { timer = setTimeout(refresh, 5000); return; }
          draw(y[0].task, y[1]);
        }, function () { timer = setTimeout(refresh, 10000); });
      };
      draw(x.task, r[1]);
      return [host];
    });
  }

  /// A member's piece of a stage, as one row: who, what they were asked (one
  /// line, the rest on request), how long and what it cost, and one action.
  function pieceRow(task, p, limit, after) {
    var b = p.waiting ? ['waiting', 'Needs your OK'] : PIECE[p.status] || ['', p.status];
    var slow = p.status === 'running' && p.startedAt && Date.now() - p.startedAt > limit;
    if (slow) b = ['waiting', 'Running long'];
    var slot = h('div', { 'aria-live': 'polite' });
    var retry = (p.status === 'failed' || slow) && (task.status === 'running' || task.status === 'waiting') ? h('button', { class: 'btn small', text: 'Retry', onclick: function (e) {
      var restore = busy(e.target, 'Starting…');
      api('POST', '/api/team-tasks/' + encodeURIComponent(task.id), { kind: 'retryPiece', workerId: p.workerId }).then(function (x) { restore(); slot.replaceChildren(msg(x, p.workerName + ' is on it again.')); if (x.ok !== false && after) after(); });
    } }) : null;
    var meta = [p.startedAt && p.status === 'running' ? secs(Date.now() - p.startedAt) + ' in' : p.startedAt && p.finishedAt ? secs(p.finishedAt - p.startedAt) : '', p.costUSD ? money(p.costUSD) : ''].filter(Boolean).join(' · ');
    // The member's name, or the speech mark by their badge, opens a box to
    // say something to them: sent as they work, or their piece done again.
    var current = task.stagesDetail.some(function (s) { return s.current && s.pieces.indexOf(p) >= 0; });
    var talk = function (e) { memberBox(task, p, current, e.currentTarget.getBoundingClientRect(), after); };
    return h('div', { class: 'prow' + (slow ? ' slow' : '') },
      h('div', { class: 'prow-main' },
        avatar(p.workerId, p.workerName, 's'),
        h('div', { style: 'flex:1;min-width:0' },
          h('button', { class: 'linkish', style: 'color:var(--ink);font-weight:600', text: p.workerName, title: 'Say something to ' + p.workerName, onclick: talk }),
          h('details', { class: 'pask' }, h('summary', { text: p.ask.split(/(?<=[.!?])\s/)[0].slice(0, 160) }), h('p', { text: p.ask }))),
        h('div', { class: 'prow-acts' },
          meta ? h('span', { class: 'faint', text: meta }) : null,
          h('span', { class: 'badge ' + b[0], text: b[1] }),
          h('button', { class: 'btn small quiet icon', 'aria-label': 'Say something to ' + p.workerName, title: 'Say something to ' + p.workerName, onclick: talk }, icon('slack', 15)),
          retry,
          p.runId ? h('button', { class: 'btn small', text: p.status === 'running' ? 'Watch' : 'See what it did', onclick: function () { watchRun(p.runId, p.workerName + ' · ' + task.title); } }) : null)),
      p.error ? h('div', { class: 'msg err', text: p.error === 'Interrupted by app restart.' ? 'Stopped by a server restart before it got going.' : p.error }) : null,
      p.waiting ? waitingCard(p.waiting) : null,
      p.file ? teamFile(task.id, p.file, 'Read what ' + p.workerName + ' wrote · ') : null,
      slot);
  }

  /// A task's shared folder: every file the team wrote, where each has been
  /// kept, and the places a file can go from here.
  function viewTeamFiles() {
    var id = state.taskId;
    return Promise.all([api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/page'), api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/files')]).then(function (r) {
      var x = r[0], fx = r[1];
      if (x.ok === false) return [msg(x)];
      if (fx.ok === false) return [msg(fx)];
      var task = x.task;
      noteTaskComments(task, null);
      var picked = {};
      var view = state.teamFilePick || null;
      var bar = h('div', { class: 'fbar' }), body = h('tbody'), out = h('div', { 'aria-live': 'polite' });
      var EXT = { md: 'MD', markdown: 'MD', html: 'HTML', htm: 'HTML', csv: 'CSV', json: 'JSON', txt: 'TXT' };
      var ext = function (n) { var m = /\.([a-z0-9]+)$/i.exec(n); return m ? (EXT[m[1].toLowerCase()] || m[1].toUpperCase().slice(0, 4)) : 'FILE'; };
      var names = function () { return Object.keys(picked).filter(function (k) { return picked[k]; }); };
      var act = function (destination, label) {
        return function (e) {
          var list = names(); if (!list.length) return;
          var restore = busy(e.target, 'Saving…');
          var call = destination === 'library'
            ? api('POST', '/api/team-tasks/' + encodeURIComponent(id) + '/files/keep', { names: list })
            : api('POST', '/api/team-tasks/' + encodeURIComponent(id) + '/files/save', { names: list, destination: destination });
          call.then(function (y) {
            restore();
            if (y.ok === false) { out.replaceChildren(msg(y)); return; }
            var failed = y.failed || [];
            fill(out, [msg({}, (destination === 'library' ? 'Added to the Library.' : 'Saved to ' + label + '.') + (failed.length ? ' ' + failed.length + ' didn’t save.' : '')),
              failed.map(function (f) { return h('div', { class: 'msg err', text: f.name + ': ' + f.error }); })]);
            reload();
          });
        };
      };
      var drawBar = function () {
        var n = names().length;
        bar.classList.toggle('on', n > 0);
        bar.replaceChildren.apply(bar, n ? [h('b', { text: n + ' selected' }),
          h('button', { class: 'btn small go', onclick: act('library', 'the Library') }, 'Add to Library')].concat(fx.destinations.filter(function (d) { return d.id !== 'library'; }).map(function (d) {
            return h('button', { class: 'btn small', disabled: !d.ready, title: d.ready ? '' : d.why || '', onclick: act(d.id, d.label) }, 'Save to ' + d.label);
          })).concat([h('button', { class: 'btn small quiet', text: 'Clear', onclick: function () { picked = {}; drawRows(); drawBar(); } })])
          : [h('span', { class: 'muted', style: 'font-size:13px', text: 'Tick files to add them to the Library, or save them somewhere your team works.' })]);
      };
      var KEPT = function (f) {
        var where = (f.kept.library ? ['Library'] : []).concat(f.kept.saved.map(function (s) { return s.label; }));
        return where.length ? h('span', { class: 'badge ok', text: where.join(' · ') }) : h('span', { class: 'badge', text: 'Only here' });
      };
      // Reading a file wants width, so it opens in a panel over the page
      // rather than a column beside the table; the table keeps the room for
      // choosing files.
      var drawer = null;
      var closeDrawer = function () {
        if (!drawer) return;
        drawer.remove(); drawer = null;
        document.removeEventListener('keydown', onKey);
        view = null; state.teamFilePick = null; drawRows();
      };
      var onKey = function (e) {
        if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        if (e.key === 'Escape') closeDrawer();
        else if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); step(1); }
        else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); step(-1); }
      };
      var step = function (d) {
        var i = fx.files.map(function (z) { return z.name; }).indexOf(view);
        var next = fx.files[i + d];
        if (next) { view = next.name; state.teamFilePick = view; drawRows(); drawPreview(); }
      };
      var download = function (f) {
        api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/file?name=' + encodeURIComponent(f.name)).then(function (y) {
          if (y.ok === false) return;
          var a = h('a', { href: URL.createObjectURL(new Blob([y.body], { type: 'text/plain' })), download: f.name.split('/').pop() });
          document.body.appendChild(a); a.click(); a.remove();
        });
      };
      var drawPreview = function () {
        var f = fx.files.filter(function (z) { return z.name === view; })[0];
        if (!f) { closeDrawer(); return; }
        var i = fx.files.indexOf(f);
        var html = /\.html?$/i.test(f.name), img = /\.(png|jpe?g|gif|webp)$/i.test(f.name);
        var box = h('div', { class: 'drawer-body' + (html ? ' frame' : '') }, h('span', { class: 'faint', text: 'Loading…' }));
        var said = h('div', { 'aria-live': 'polite' });
        // Wider for a report or a wide table, remembered as the reader is.
        var wide = read('overcli-reader-wide') === '1';
        var grow = h('button', { class: 'btn small', 'aria-pressed': wide ? 'true' : 'false', title: 'Make the panel wider', text: wide ? 'Narrow' : 'Expand', onclick: function () {
          wide = !wide; panel.classList.toggle('wide', wide); grow.textContent = wide ? 'Narrow' : 'Expand'; grow.setAttribute('aria-pressed', wide ? 'true' : 'false');
          store('overcli-reader-wide', wide ? '1' : null);
        } });
        var keepOne = function (destination, label) { return function (e) { picked = {}; picked[f.name] = true; act(destination, label)(e); }; };
        var panel = h('aside', { class: 'drawer' + (wide ? ' wide' : ''), role: 'dialog', 'aria-label': f.name },
          h('div', { class: 'drawer-head' },
            h('div', { style: 'min-width:0;flex:1' },
              h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { class: 'ftype', text: ext(f.name) }), h('code', { class: 'drawer-name', text: f.name })),
              h('div', { class: 'faint', style: 'margin-top:4px', text: 'Written by ' + (f.writtenBy ? f.writtenBy.name : 'the coordinator') + (f.stage ? ' in ' + f.stage.index + '. ' + f.stage.title : '') + ' · ' + ago(f.modifiedAt) })),
            h('div', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' },
              grow,
              h('button', { class: 'btn small icon', 'aria-label': 'Previous file', title: 'Previous (↑)', disabled: i <= 0, onclick: function () { step(-1); } }, '↑'),
              h('button', { class: 'btn small icon', 'aria-label': 'Next file', title: 'Next (↓)', disabled: i >= fx.files.length - 1, onclick: function () { step(1); } }, '↓'),
              h('button', { class: 'btn small icon', 'aria-label': 'Close', title: 'Close (Esc)', onclick: closeDrawer }, '✕'))),
          h('div', { class: 'drawer-acts' },
            h('button', { class: 'btn small go', text: f.kept.library ? 'In the Library' : 'Add to Library', disabled: f.kept.library, onclick: keepOne('library', 'the Library') }),
            fx.destinations.filter(function (d) { return d.id !== 'library'; }).map(function (d) {
              return h('button', { class: 'btn small', disabled: !d.ready, title: d.ready ? '' : d.why || '', onclick: keepOne(d.id, d.label) }, 'Save to ' + d.label);
            }),
            h('button', { class: 'btn small quiet', text: 'Download', onclick: function () { download(f); } }),
            h('button', { class: 'btn small quiet', onclick: function (e) { fileCommentBox(id, f.name, null, e.currentTarget.getBoundingClientRect()); } }, icon('slack', 14), 'Comment on this file'),
            html && f.url ? h('a', { class: 'btn small quiet', href: f.url, target: '_blank', rel: 'noopener', text: 'Open in a new tab ↗' }) : null,
            KEPT(f)),
          said, html || img ? fileCommentList(id, f.name) : null, box);
        if (drawer) drawer.replaceWith(panel); else { document.body.appendChild(panel); document.addEventListener('keydown', onKey); }
        drawer = panel;
        // An HTML report is shown as the page it is, from its own link, in a
        // sandbox: its styles and scripts run, but cannot reach the console.
        if (html && f.url) { box.replaceChildren(h('iframe', { class: 'drawer-frame', src: f.url, sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', title: f.name })); return; }
        if (img && f.url) { box.replaceChildren(h('img', { src: f.url, alt: f.name, style: 'max-width:100%;border-radius:8px' })); return; }
        api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/file?name=' + encodeURIComponent(f.name)).then(function (y) {
          if (drawer !== panel) return;
          if (y.ok === false) { box.replaceChildren(msg(y)); return; }
          // The text can be commented on a passage at a time; what's been
          // said about the file follows it.
          fill(box, [commentable(id, f.name, /\.(md|markdown|txt)$/i.test(f.name) ? md(y.body) : /\.json$/i.test(f.name) ? h('pre', { text: (function () { try { return JSON.stringify(JSON.parse(y.body), null, 2); } catch (e) { return y.body; } })() }) : h('pre', { text: y.body })),
            fileCommentList(id, f.name)]);
        });
      };
      var drawRows = function () {
        body.replaceChildren.apply(body, fx.files.map(function (f) {
          var cb = h('input', { type: 'checkbox', 'aria-label': 'Select ' + f.name });
          cb.checked = !!picked[f.name];
          cb.onclick = function (e) { e.stopPropagation(); };
          cb.onchange = function () { picked[f.name] = cb.checked; drawBar(); tr.classList.toggle('picked', cb.checked); };
          var tr = h('tr', { class: 'link' + (f.name === view ? ' viewing' : '') + (picked[f.name] ? ' picked' : ''), onclick: function () { view = f.name; state.teamFilePick = f.name; drawRows(); drawPreview(); } },
            h('td', { style: 'width:34px' }, cb),
            h('td', null, h('span', { class: 'ftype', text: ext(f.name) }), ' ', h('code', { class: 'fname', text: f.name })),
            h('td', { class: 'muted', text: f.writtenBy ? f.writtenBy.name : 'Coordinator' }),
            h('td', { class: 'muted', text: f.stage ? f.stage.index + '. ' + f.stage.title : '' }),
            h('td', null, KEPT(f)),
            h('td', { class: 'r muted', text: ago(f.modifiedAt) }));
          return tr;
        }));
      };
      var reload = function () {
        api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/files').then(function (y) { if (y.ok !== false) { fx = y; drawRows(); drawBar(); drawPreview(); } });
      };
      var zip = h('button', { class: 'btn', onclick: function (e) {
        var restore = busy(e.target, 'Packing…');
        fetch('/api/team-tasks/' + encodeURIComponent(id) + '/files.zip', { headers: { Authorization: 'Bearer ' + token() } }).then(function (res) {
          if (!res.ok) throw new Error('The zip didn’t download.');
          return res.blob();
        }).then(function (blob) {
          restore();
          var a = h('a', { href: URL.createObjectURL(blob), download: (task.title || 'team-task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.zip' });
          document.body.appendChild(a); a.click(); a.remove();
        }, function (err) { restore(); out.replaceChildren(h('div', { class: 'msg err', text: err.message })); });
      } }, 'Download all (.zip)');
      drawRows(); drawBar(); if (view) drawPreview();
      if (state.hashQuery && state.hashQuery.get('connected') === 'google') out.replaceChildren(msg({}, 'Google Drive is connected. Tick files and Save to Your Google Drive.'));
      var gone = new MutationObserver(function () { if (!body.isConnected) { closeDrawer(); gone.disconnect(); } });
      gone.observe(document.body, { childList: true, subtree: true });
      // A destination that can't take files yet explains itself in a dialog:
      // what connecting does, who has to act, and the one button that helps.
      var explain = function (d) {
        var drive = d.kind === 'drive';
        if (d.id === 'google:me') {
          smallDialog('Connect your Google Drive', 'Files you save go into your own Drive, as you. overcli never sees your password.', [
            h('div', { class: 'msg', style: 'background:var(--need-soft);color:var(--ink)' },
              h('b', { text: 'Google sign-in isn’t turned on for this server yet. ' }),
              state.me.admin ? 'You can turn it on once for everyone: register overcli with Google, then add its two secrets.' : 'An admin turns it on once for everyone. Until then, files stay here and in the Library.'),
            state.me.admin && d.why ? h('p', { class: 'faint', style: 'font-size:12.5px', text: d.why }) : null
          ], state.me.admin ? [h('button', { class: 'btn go', text: 'Show me how', onclick: function () { go('connections'); } })] : []);
          return;
        }
        smallDialog('Connect ' + (drive ? 'your Google Drive' : 'SharePoint or OneDrive'), 'Files would save as you, into your own ' + (drive ? 'Drive' : 'OneDrive or a SharePoint site you can use') + '. You’d connect your ' + (drive ? 'Google' : 'Microsoft') + ' account once, from your menu. That’s coming next.', [
          h('p', { class: 'faint', style: 'font-size:13px', text: 'Today an admin can add a ' + (drive ? 'Google Drive' : 'SharePoint') + ' tool on Setup → Tools instead. Files then save as the server’s own account, into its folders, for everyone.' })
        ], state.me.admin ? [h('button', { class: 'btn go', text: 'Open Setup → Tools', onclick: function () { go('setup', { setupTab: 'tools' }); } })] : []);
      };
      var dests = h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'deststrip' }, h('span', { class: 'label', text: 'Where files can go' }), fx.destinations.map(function (d) {
        return h('span', { class: 'dest' }, h('b', { text: d.label }),
          d.ready ? h('span', { class: 'badge ok', text: d.kind === 'library' ? 'Always on' : 'Ready' })
            : h('button', { class: 'linkish', style: 'color:var(--go);font-size:12.5px', text: 'Connect', onclick: function () {
              if (d.id === 'google:me' && /Connect your Google account/.test(d.why || '')) connectGoogle('#teamfiles/' + encodeURIComponent(id));
              else explain(d);
            } }));
      })));
      return [h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: x.team.name, onclick: function () { go('team', { teamId: x.team.id }); } }), ' / ',
              h('button', { class: 'linkish', style: 'font-size:12.5px', text: task.title || task.brief, onclick: function () { openTask(task.id); } }), ' / Shared folder'),
            h('h1', { class: 'page-title', text: 'Shared folder' }),
            h('p', { class: 'page-sub', text: plural(fx.files.length, 'file', 'files') + ' the team wrote for this task. Keep what’s worth keeping.' })),
          h('div', { class: 'page-actions' }, zip)),
        out,
        h('div', { class: 'stack', style: 'gap:12px' },
          h('section', { class: 'tcard', 'aria-label': 'Files' }, bar,
            fx.files.length ? h('div', { class: 'tscroll' }, h('table', { class: 'data files' },
              h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr', text: 'Select' })), h('th', { text: 'File' }), h('th', { text: 'Written by' }), h('th', { text: 'Stage' }), h('th', { text: 'Kept in' }), h('th', { class: 'r', text: 'Updated' }))), body))
              : h('p', { class: 'muted', style: 'padding:28px 16px;text-align:center', text: 'Nothing written yet.' })),
          dests)];
    });
  }

  /// Send the browser to Google to connect the person's own Drive, coming back
  /// to where they were.
  /// A short modal: a title, a line under it, a body and its buttons. Closes on
  /// Escape, on the scrim, on Close, and when one of its buttons is pressed.
  function smallDialog(title, sub, body, actions) {
    var scrim = h('div', { class: 'scrim' });
    var close = function () { scrim.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    scrim.onclick = function (e) { if (e.target === scrim) close(); };
    document.addEventListener('keydown', onKey);
    var quit = h('button', { class: 'btn quiet', text: actions.length ? 'Not now' : 'Close', onclick: close });
    actions.forEach(function (b) { var run = b.onclick; b.onclick = function (e) { close(); if (run) run(e); }; });
    append(scrim, h('div', { class: 'dialog small', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sd-title' },
      h('div', null, h('h2', { id: 'sd-title', text: title }), sub ? h('p', { class: 'muted', style: 'margin-top:4px', text: sub }) : null),
      body,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, quit, actions)));
    document.body.appendChild(scrim);
    setTimeout(function () { (actions[0] || quit).focus(); }, 0);
  }

  function connectGoogle(next) {
    api('POST', '/api/connections/google/start', { next: next || '#connections' }).then(function (r) {
      if (r.ok === false) { alert(r.error); return; }
      location.href = r.url;
    });
  }

  var CONNECT_ERR = { denied: 'You said no on Google’s page, so nothing was connected.', expired: 'That took too long. Try again.', browser: 'Google sent you back to a different browser or address than the one you started in. Start again from this page.',
    'not-configured': 'Google sign-in isn’t set up on this server yet.', exchange: 'Google didn’t accept the connection. Try again.', 'no-email': 'Google didn’t say which account this is.',
    'no-refresh-token': 'Google didn’t give lasting access. Remove overcli from your Google account’s third-party access, then connect again.', scope: 'Drive access was unticked on Google’s page, so files can’t be saved. Connect again and leave it ticked.', server: 'Something went wrong on the server. Try again.' };

  /// The accounts a person has connected for overcli to act as them: today
  /// their Google Drive, so team files save into it.
  /// What an admin needs to know to turn on Google Drive for everyone: who does
  /// what, the steps in Google Cloud in order, what overcli can and can't
  /// reach, and what each failure means.
  function googleSetupGuide(c) {
    var uri = c.redirectUri || '';
    var local = /^http:\/\/(localhost|127\.0\.0\.1)/.test(uri);
    var step = function (n, title, body) { return h('li', { class: 'gstep' }, h('span', { class: 'gnum', text: String(n) }), h('div', { class: 'stack', style: 'gap:6px;min-width:0' }, h('b', { text: title }), body)); };
    var p = function (t) { return h('p', { text: t }); };
    return h('div', { class: 'gsetup' },
      h('div', { class: 'gwho' },
        h('div', null, h('span', { class: 'label', text: 'You, once' }), p('Register overcli with Google for the whole org. This connects nobody’s Drive: it only lets overcli ask Google.')),
        h('div', null, h('span', { class: 'label', text: 'Each person, for themselves' }), p('Connects their own Google account from Your connections, and approves it on Google’s own page. Their files save into their Drive, as them.'))),
      local ? h('div', { class: 'msg', style: 'background:var(--need-soft);color:var(--ink)' },
        h('b', { text: 'This server’s address is localhost. ' }), 'That works for trying it on this machine. For your team, set the console address first (Setup → Rules, “Console address”, or publicUrl in org.json), then come back: the address below changes to match, and that is the one to give Google.') : null,
      h('ol', { class: 'gsteps' },
        step(1, 'Pick a Google Cloud project', [p('In console.cloud.google.com, choose or create a project for overcli. Any project in your company’s Google Workspace is fine.')]),
        step(2, 'Turn on the Google Drive API', [p('APIs & Services → Library → search “Google Drive API” → Enable.')]),
        step(3, 'Set up the consent screen', [
          p('APIs & Services → OAuth consent screen (in newer consoles: Google Auth Platform → Branding and Audience).'),
          h('ul', { class: 'gbul' },
            h('li', null, h('b', { text: 'Audience: Internal' }), ' if everyone uses your company’s Google Workspace. Only your company’s accounts can connect, and Google needs no review.'),
            h('li', null, h('b', { text: 'External' }), ' only if people use personal Gmail. While it’s in “Testing”, add each person as a test user; their access then lasts 7 days at a time.'),
            h('li', null, 'App name “overcli”, your support email, and under Data access add the scope ', h('code', { text: '…/auth/drive.file' }), '. Nothing broader is needed.'))]),
        step(4, 'Create the OAuth client', [
          p('APIs & Services → Credentials → Create credentials → OAuth client ID → Application type “Web application”.'),
          p('Under Authorized redirect URIs, add exactly this address:'),
          codeBlock(uri),
          h('p', { class: 'faint', text: 'Leave Authorized JavaScript origins empty. Google shows the client ID and secret once you save.' })]),
        step(5, 'Give overcli the client ID and secret', [
          p('On Setup → Secrets, add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET with the values Google showed. They apply at once, with no restart.'),
          h('div', { class: 'row' }, h('button', { class: 'btn small', text: 'Open Setup → Secrets', onclick: function () { go('setup', { setupTab: 'secrets' }); } }))]),
        step(6, 'Check it', [p('Come back to this page: Google Drive shows “Not connected” with a Connect button. Connect your own account first to try it, then tell your team it’s on.')])),
      h('details', { class: 'gmore' }, h('summary', { text: 'What overcli can reach, and where it’s kept' }),
        h('ul', { class: 'gbul' },
          h('li', { text: 'Only files overcli creates, in a folder called “overcli” in each person’s Drive (the drive.file permission). It can’t list, open or change anything else in their Drive.' }),
          h('li', { text: 'Each person’s Google access is stored on this server, encrypted, under a key kept in the secrets store. It never goes to workers, and never appears in the console or a URL.' }),
          h('li', { text: 'A connection can only be started by a signed-in person, in their own browser, and lasts ten minutes; a link to Google’s page sent to someone else won’t attach their Drive to your account.' }),
          h('li', { text: 'Disconnecting on Your connections revokes the access at Google. People can also remove “overcli” from their Google account’s third-party access at any time.' }),
          h('li', { text: 'Removing the client secret from Setup → Secrets turns saving off for everyone; existing connections stop working until it’s back.' }))),
      h('details', { class: 'gmore' }, h('summary', { text: 'If connecting fails' }),
        h('ul', { class: 'gbul' },
          h('li', null, h('b', { text: 'redirect_uri_mismatch on Google’s page: ' }), 'the address in step 4 doesn’t match this server’s exactly. Copy it again from here, including http or https and the port.'),
          h('li', null, h('b', { text: '“access blocked” or “app not verified”: ' }), 'the consent screen is External and the person isn’t a test user, or it needs Internal for your Workspace.'),
          h('li', null, h('b', { text: '“came back to a different browser or address”: ' }), 'start from the same address as the console address. Using localhost while the console address is something else fails on purpose.'),
          h('li', null, h('b', { text: '“didn’t give lasting access”: ' }), 'the person had connected before. They remove overcli from their Google account’s third-party access, then connect again.'))),
      h('a', { class: 'faint', href: '/docs/admins#google-drive-for-everyone', target: '_blank', rel: 'noopener', text: 'The same steps in the admin docs ↗' }));
  }

  function viewConnections() {
    return api('GET', '/api/connections').then(function (r) {
      var nodes = [head('Your connections', 'Accounts overcli may use as you. Each is yours alone: nobody else’s files go through it, and you can disconnect any time.', null, 'You')];
      var hq = state.hashQuery;
      var err = location.hash.indexOf('google-error') >= 0 ? (hq && hq.get('reason')) || 'server' : null;
      if (hq && hq.get('connected') === 'google') nodes.push(msg({}, 'Google Drive is connected.'));
      if (err) nodes.push(h('div', { class: 'msg err', text: CONNECT_ERR[err] || CONNECT_ERR.server }));
      if (r.ok === false) return nodes.concat([msg(r)]);
      return nodes.concat(r.connections.map(function (c) {
        var out = h('div', { 'aria-live': 'polite' });
        var status = c.connected ? h('span', { class: 'badge ok', text: 'Connected' }) : c.ready ? h('span', { class: 'badge', text: 'Not connected' }) : h('span', { class: 'badge waiting', text: 'Not set up' });
        var body = [
          h('p', { class: 'muted', text: c.provider === 'google' ? 'Save a team’s files into your own Drive, into a folder called “overcli”. overcli can only see files it made there, never the rest of your Drive.' : '' }),
          c.connected ? h('p', { text: 'Connected as ' + (c.account || 'your account') + (c.connectedAt ? ' · ' + ago(c.connectedAt) : '') + '.' }) : null,
          !c.connected && c.account && c.why ? h('div', { class: 'msg err', text: c.why }) : null,
          h('div', { class: 'row' },
            c.connected ? h('button', { class: 'btn', text: 'Disconnect', onclick: function (e) {
              if (!confirm('Disconnect ' + c.label + '? Files already saved stay in your Drive.')) return;
              var restore = busy(e.target, 'Disconnecting…');
              api('POST', '/api/connections/' + c.provider + '/disconnect', {}).then(function (y) { restore(); if (y.ok === false) fill(out, msg(y)); else render(); });
            } }) : c.ready ? h('button', { class: 'btn go', text: (c.account ? 'Connect again' : 'Connect ' + c.label), onclick: function () { connectGoogle('#connections'); } }) : null),
          !c.ready ? h('div', { class: 'stack', style: 'gap:8px' },
            h('p', { class: 'faint', text: c.why || '' }),
            state.me.admin ? googleSetupGuide(c) : h('p', { class: 'faint', text: 'Ask an admin to set it up.' })) : null,
          c.ready && state.me.admin ? h('details', { class: 'gsetup-done' }, h('summary', { text: 'How this is set up (for admins)' }), googleSetupGuide(c)) : null,
          out];
        return card('conn-' + c.provider, c.label, status, body);
      }));
    });
  }

  /// A team's check-ins and whether its members ask before acting outside
  /// their sandbox: switches that save as they change.
  function teamSettings(t) {
    var out = h('div', { 'aria-live': 'polite' });
    var save = function (body, b, undo) {
      api('POST', '/api/teams/' + encodeURIComponent(t.id) + '/settings', body).then(function (x) {
        fill(out, x.ok === false ? [msg(x)] : []);
        if (x.ok === false) undo();
      });
    };
    var sw = function (title, help, on, change) {
      var b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': title });
      b.onclick = function () {
        var next = b.getAttribute('aria-checked') !== 'true';
        b.setAttribute('aria-checked', next ? 'true' : 'false');
        change(next, function () { b.setAttribute('aria-checked', next ? 'false' : 'true'); });
      };
      return h('div', { class: 'ntcheck' }, h('span', { class: 'stack', style: 'gap:2px;flex:1;min-width:0' }, h('b', { text: title }), h('span', { class: 'faint', text: help })), b);
    };
    var check = function (key, title, help) {
      return sw(title, help, t.checkpoints[key], function (next, undo) { var cp = {}; cp[key] = next; save({ checkpoints: cp }, null, undo); });
    };
    return h('div', { class: 'stack', style: 'gap:4px' },
      h('div', { class: 'ntchecks' },
        check('askFirst', 'Asks what it needs to know first', 'One round of questions before it plans.'),
        check('reviewBeforeChallenge', 'You read the draft before it’s challenged', 'Steer the main piece first.'),
        check('finalReview', 'You review the result', 'The pack waits for you to accept it.'),
        check('approveRoomWork', 'You approve follow-up work', 'Extra work it suggests waits for your OK.'),
        sw('Members ask before acting outside', 'Off: on this team’s tasks, members push, send or update services without asking each time. Their managers still see everything they do.', t.piecesAskFirst, function (next, undo) {
          if (!next && !window.confirm('Members of ' + t.name + ' will act outside their sandbox on its tasks without asking first: pushing code, sending messages, updating a tracker, a CRM or a wiki.\n\nTurn it off?')) { undo(); return; }
          save({ piecesAskFirst: next }, null, undo);
        })),
      h('span', { class: 'faint', style: 'font-size:12.5px', text: 'You always approve the plan. Changes apply to work that starts after them.' }),
      out);
  }

  /// Retiring a team: disband it (its work stays in the Library, its members
  /// stay hired), or, for an admin, delete it with everything it delivered.
  /// Press twice, as letting a worker go is.
  function teamEnd(t) {
    var out = h('div', { 'aria-live': 'polite' });
    var twice = function (label, sure, warn, path) {
      var b = h('button', { class: 'btn danger small', text: label });
      var armed = null;
      b.onclick = function () {
        if (!armed) {
          b.textContent = sure;
          out.replaceChildren(h('div', { class: 'msg err', role: 'alert', text: warn + ' Press again to confirm.' }));
          armed = setTimeout(function () { armed = null; b.textContent = label; out.replaceChildren(); }, 6000);
          return;
        }
        clearTimeout(armed); armed = null;
        var restore = busy(b, 'Working…');
        api('POST', '/api/teams/' + encodeURIComponent(t.id) + '/' + path, {}).then(function (x) {
          restore();
          if (x.ok === false) { out.replaceChildren(msg(x)); return; }
          go('teams');
        });
      };
      return b;
    };
    return card('teamend', 'Disband ' + t.name, null, h('div', { class: 'stack', style: 'gap:10px' },
      h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: 'It stops taking work and leaves every list. What it delivered stays in the Library, and its members stay hired.' }),
      h('div', { class: 'row', style: 'gap:8px' },
        twice('Disband the team', 'Yes, disband ' + t.name, 'Any task it has open is cancelled. Its finished work stays in the Library, and ' + (t.members.length > 3 ? t.members.slice(0, 2).map(function (m) { return m.name; }).join(', ') + ' and the rest' : t.members.map(function (m) { return m.name; }).join(' and ')) + ' stay on as workers.', 'disband'),
        state.me && state.me.admin ? twice('Delete it and its work', 'Yes, delete everything', 'This deletes ' + t.name + ' and every task it ran, with their files. It leaves the Library too, and can’t be undone.', 'delete') : null),
      out));
  }

  /// How the team should go about its work, in the words of the people who
  /// run it. Its coordinator plans by it, above its own habits.
  function teamGuide(t) {
    var box = h('div', { class: 'stack', style: 'gap:10px' });
    var out = h('div', { 'aria-live': 'polite' });
    var show = function () {
      var edit = t.canChange ? h('button', { class: 'btn small', text: t.guidance ? 'Edit' : 'Add guidance', onclick: write }) : null;
      box.replaceChildren(
        t.guidance ? h('div', { class: 'guide-body' }, md(t.guidance))
          : h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: 'Tell it how you want work done: the process for a kind of ask, who goes first, what a good result looks like. Write it, or upload a process doc you already have. Its coordinator plans by it.' }),
        edit ? h('div', null, edit) : null, out);
    };
    var write = function () {
      var area = h('textarea', { 'aria-label': 'How ' + t.name + ' should work', style: 'min-height:200px;font-size:13.5px', maxlength: '20000',
        placeholder: 'When the ask is a PRFAQ: Hugo pulls the roadmap and what customers asked for first, Priya drafts, Nadia challenges it, Iris reviews anything with UX.\n\nWhen it is a quick question about the roadmap: answer from what the team knows, no plan.\n\nAlways cite the ticket or feature each claim comes from.' });
      area.value = t.guidance || '';
      // A process already written down: its text goes into the box, to read
      // and trim before saving. Text and Markdown only; the browser reads it.
      var pick = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/plain,text/markdown', style: 'display:none' });
      pick.onchange = function () {
        var f = pick.files && pick.files[0];
        pick.value = '';
        if (!f) return;
        if (!/\.(md|markdown|txt)$/i.test(f.name) && !/^text\//.test(f.type)) { out.replaceChildren(h('div', { class: 'msg err', text: 'Upload a .md or .txt file. From Word or a PDF, save it as text first, or paste it in.' })); return; }
        if (f.size > 200000) { out.replaceChildren(h('div', { class: 'msg err', text: f.name + ' is too big. Keep the guidance under 20,000 characters.' })); return; }
        f.text().then(function (text) {
          area.value = area.value.trim() ? area.value.trim() + '\n\n' + text.trim() : text.trim();
          out.replaceChildren(area.value.length > 20000
            ? h('div', { class: 'msg err', text: 'That makes ' + area.value.length.toLocaleString() + ' characters. Trim it under 20,000 to save.' })
            : h('div', { class: 'msg ok', text: 'Added ' + f.name + '. Read it over, then save.' }));
          area.focus();
        });
      };
      var upload = h('button', { class: 'btn small', type: 'button', onclick: function () { pick.click(); } }, icon('doc', 14), ' Upload a file');
      var save = h('button', { class: 'btn go small', text: 'Save' });
      save.onclick = function () {
        var restore = busy(save, 'Saving…');
        api('POST', '/api/teams/' + encodeURIComponent(t.id) + '/settings', { guidance: area.value }).then(function (x) {
          restore();
          if (x.ok === false) { out.replaceChildren(msg(x)); return; }
          t.guidance = area.value.trim();
          show();
          out.replaceChildren(msg(x, 'Saved. Tasks planned from now on follow it.'));
        });
      };
      box.replaceChildren(area,
        h('div', { class: 'row', style: 'gap:8px' }, save, h('button', { class: 'btn small', text: 'Cancel', onclick: function () { out.replaceChildren(); show(); } }), upload, pick), out);
      area.focus();
    };
    show();
    return card('teamguide', 'How it should work', null, box);
  }

  /// What the team knows: learned by its members from their own tools, read
  /// at the start of every task so simple questions are answered straight
  /// away. Learn it, read it, refresh it.
  function teamKnows(t, after) {
    var k = t.knowledge;
    var out = h('div', { 'aria-live': 'polite' });
    var learn = function (label) {
      var b = h('button', { class: 'btn small' + (k && k.status === 'ready' ? '' : ' go'), text: label });
      b.onclick = function () {
        var restore = busy(b, 'Starting…');
        api('POST', '/api/teams/' + encodeURIComponent(t.id) + '/learn', {}).then(function (x) {
          restore(); out.textContent = ''; out.appendChild(msg(x, 'Learning. Each member is looking through its own tools.'));
          if (x.ok !== false) setTimeout(after, 800);
        });
      };
      return t.canBrief ? b : null;
    };
    var read = function () {
      openReader('What ' + t.name + ' knows', k.updatedAt ? 'Updated ' + ago(k.updatedAt) : '', function (put) {
        api('GET', '/api/teams/' + encodeURIComponent(t.id) + '/knowledge').then(function (x) { put([x.ok === false ? msg(x) : md(x.body)]); });
      });
    };
    var body;
    if (!k || (k.status === 'failed' && !k.words)) {
      body = [h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: k && k.error ? 'The last try didn’t finish: ' + k.error : 'It doesn’t know your world yet, so it asks before it plans.' }),
        h('p', { class: 'faint', style: 'margin:0;font-size:13px', text: 'Each member spends a few minutes with its own tools and writes down what it finds: what’s planned, what’s decided, who owns what. Then the team answers simple questions straight away and asks less. Up to ' + money(Math.min(t.budgetUSDPerTask, 10)) + '.' }),
        h('div', null, learn('Learn now'))];
    } else if (k.status === 'learning') {
      body = [h('p', { class: 'row', style: 'margin:0;gap:8px;font-size:13.5px' }, h('span', { class: 'livedot' }), 'Learning: each member is looking through its tools.'),
        k.taskId ? h('div', null, h('button', { class: 'linkish', text: 'Watch it →', onclick: function () { openTask(k.taskId); } })) : null];
    } else {
      // Weekly unless someone said only when asked; up to its learning cap each time.
      var every = t.canChange ? h('select', { 'aria-label': 'When ' + t.name + ' refreshes what it knows', style: 'width:auto;font-size:13px' },
        h('option', { value: 'weekly', text: 'Refreshes weekly', selected: k.refresh !== 'off' }), h('option', { value: 'off', text: 'Only when I ask', selected: k.refresh === 'off' })) : null;
      if (every) every.onchange = function () {
        api('POST', '/api/teams/' + encodeURIComponent(t.id) + '/refresh', { mode: every.value }).then(function (x) { out.textContent = ''; out.appendChild(msg(x, every.value === 'weekly' ? 'It refreshes when what it knows is a week old, once the team is free. Up to ' + money(Math.min(t.budgetUSDPerTask, 10)) + ' each time.' : 'It refreshes only when you press Refresh.')); });
      };
      body = [h('p', { style: 'margin:0;font-size:13.5px', text: 'Updated ' + (k.updatedAt ? ago(k.updatedAt) : 'recently') + (k.words ? ' · ' + k.words.toLocaleString() + ' words' : '') + '. Every task starts from it.' }),
        k.error ? h('p', { class: 'faint', style: 'margin:0;font-size:13px', text: k.error }) : null,
        h('div', { class: 'row', style: 'gap:8px' }, h('button', { class: 'btn small', text: 'Read it', onclick: read }), learn('Refresh'), every)];
    }
    return card('teamknows', 'What the team knows', null, h('div', { class: 'stack', style: 'gap:10px' }, body, out));
  }

  function viewTeam() {
    var id = state.teamId;
    // Finished work folds into a table; what is still moving stays a card.
    var FINISHED = { done: 1, failed: 1, cancelled: 1, review: 1 };
    return api('GET', '/api/teams/' + encodeURIComponent(id) + '/page').then(function (x) {
      if (x.ok === false) return [msg(x)];
      var t = x.team;
      var nowSlot = h('div', { class: 'nowslot' });
      var kpiSlot = h('div', { class: 'kpis' });
      var faces = h('div', { class: 'faces', 'aria-hidden': 'true' });
      var list = h('div', { class: 'stack', style: 'gap:14px' });
      var earlier = h('div');
      var membersBox = h('div', { class: 'members' });
      var drawn = {};
      var opened = {};
      var timer = null;
      var draw = function (x) {
        var working = x.team.members.filter(function (m) { return m.state === 'working'; });
        faces.replaceChildren.apply(faces, x.team.members.slice(0, 6).map(function (m) { return avatar(m.workerId, m.name, 's'); }));
        membersBox.replaceChildren.apply(membersBox, x.team.members.map(function (m) {
          return h('button', { class: 'member', onclick: function () { openWorker(m.workerId); } },
            avatar(m.workerId, m.name, 's'),
            h('span', { class: 'stack', style: 'gap:1px;min-width:0;text-align:left;flex:1' },
              h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('b', { text: m.name }), h('span', { class: 'badge ' + (m.state === 'working' ? 'working' : m.state === 'waiting' ? 'waiting' : m.state === 'stuck' ? 'bad' : ''), text: STATE[m.state] || m.state })),
              h('span', { class: 'm-role' + (m.state === 'working' ? ' doing' : ''), title: m.doing || m.role || '', text: m.doing || m.role || '' })));
        }));
        var running = x.tasks.filter(function (k) { return k.status === 'running' || k.status === 'planning'; }).length;
        var needs = x.tasks.filter(function (k) { return k.waitingOnYou || k.piecesNeedYou; }).length;
        var spent = x.tasks.reduce(function (n, k) { return n + (k.spentUSD || 0); }, 0);
        var kpi = function (ic, tone, k, v, n, vcls) { return h('div', { class: 'kpi' }, kpiIcon(ic, tone), h('span', { class: 'k', text: k }), h('span', { class: 'v' + (vcls ? ' ' + vcls : ''), text: v }), h('span', { class: 'n', text: n })); };
        kpiSlot.replaceChildren(
          kpi('list', '', 'Tasks', String(x.tasks.length), x.tasks.filter(function (k) { return k.status === 'done'; }).length + ' done'),
          kpi('bolt', 'ok', 'Running now', String(running), working.length ? working.map(function (m) { return m.name; }).join(', ') + (working.length === 1 ? ' is working' : ' are working') : 'Nobody working'),
          kpi('inbox', 'need', 'Needs you', String(needs), needs ? 'Answer below' : 'All clear', needs ? 'need' : ''),
          kpi('bars', 'violet', 'Spent', money(spent), money(t.budgetUSDPerTask) + ' cap per task'));
        // The banner is for the one thing worth interrupting you with: the
        // team waiting on you. Progress is already on the task's own card.
        nowSlot.textContent = '';
        if (x.now && x.now.waitingOnYou) {
          append(nowSlot, h('section', { class: 'nowbar need' },
            h('div', { class: 'line' },
              h('div', { class: 'say' }, h('span', { class: 'livedot need' }), h('span', { text: x.now.sentence })),
              h('button', { class: 'linkish', style: 'color:var(--go);font-size:13px', text: 'Show me', onclick: function () {
                var el = document.getElementById('task-' + x.now.taskId); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 1600); }
              } }))));
        }
        var keep = {};
        var thread = function (task) {
          var key = JSON.stringify([task.status, task.waitingOnYou, task.piecesNeedYou, task.nowSentence, task.spentUSD, task.stagesDetail.map(function (s) { return [s.status, s.file, s.pieces.map(function (p) { return [p.status, p.file, p.error, p.step && p.step.index, !!p.waiting]; })]; }), task.pack, task.questions, task.code]);
          var node = drawn[task.id] && drawn[task.id].key === key ? drawn[task.id].node : keepPlace(drawn[task.id] && drawn[task.id].node, teamTaskThread(task, refresh));
          keep[task.id] = { key: key, node: node };
          return node;
        };
        var live = x.tasks.filter(function (k) { return !FINISHED[k.status] || k.waitingOnYou || k.piecesNeedYou; });
        var past = x.tasks.filter(function (k) { return live.indexOf(k) < 0; });
        setChildren(list, live.map(function (task) { return taskSummary(task, refresh); }));
        var BADGE = { done: ['ok', 'Done'], failed: ['bad', 'Failed'], cancelled: ['', 'Cancelled'], review: ['waiting', 'In review'] };
        earlier.replaceChildren(past.length ? h('section', { class: 'tcard', 'aria-labelledby': 'earlier' },
          h('div', { class: 'sec-head' }, h('h2', { id: 'earlier', class: 'label', text: 'Earlier tasks' }), h('span', { class: 'faint', text: String(past.length) })),
          h('div', { class: 'tscroll' }, h('table', { class: 'data' }, h('tbody', null, past.map(function (task) {
            var ok = task.stagesDetail.filter(function (s) { return s.status === 'done'; }).length;
            var b = BADGE[task.status] || ['', task.status];
            var row = h('tr', { class: 'link', tabindex: '0' },
              h('td', { class: 'wrap' }, h('b', { style: 'font-weight:600', text: task.title || task.brief }), h('span', { class: 'sub', text: (task.requestedBy && task.requestedBy !== (state.me && state.me.name) ? task.requestedBy : 'You') + ' asked · ' + when(task.createdAt) })),
              h('td', null, h('span', { class: 'badge ' + b[0], text: b[1] })),
              h('td', { class: 'muted', text: task.stagesDetail.length ? ok + ' of ' + task.stagesDetail.length + ' stages' : '' }),
              h('td', { class: 'r muted', text: money(task.spentUSD) }),
              h('td', { class: 'r' }, h('span', { style: 'color:var(--go);font-size:13px', text: 'Open →' })));
            var open_ = function () { openTask(task.id); };
            row.onclick = open_; row.onkeydown = function (e) { if (e.key === 'Enter') open_(); };
            return row;
          })))) ) : '');
        drawn = keep;
        if (!x.tasks.length) setChildren(list, [h('div', { class: 'panel empty' }, h('div', { class: 'quote', text: 'No tasks yet.' }), h('p', { text: 'Give ' + t.name + ' a task. Its coordinator asks what it needs, proposes a plan for you to approve, then runs the members through it.' }))]);
        var moving = x.tasks.some(function (k) { return k.status === 'running' || k.status === 'planning'; });
        clearTimeout(timer);
        timer = setTimeout(refresh, moving ? 4000 : 20000);
      };
      var refresh = function () {
        clearTimeout(timer);
        if (!list.isConnected || state.tab !== 'team' || state.teamId !== id) return;
        api('GET', '/api/teams/' + encodeURIComponent(id) + '/page').then(function (y) { if (y.ok !== false && list.isConnected) draw(y); }, function () { timer = setTimeout(refresh, 10000); });
      };
      draw(x);
      var input = h('textarea', { placeholder: 'What do you want back from ' + t.name + '?', 'aria-label': 'Task for ' + t.name, style: 'min-height:70px' });
      var out = h('div', { 'aria-live': 'polite' });
      var give = h('button', { class: 'btn go', text: 'Give it the task', title: '⌘↵' });
      give.onclick = function () {
        if (input.value.trim().length < 10) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', text: 'Say a little more about the task.' })); input.focus(); return; }
        var restore = busy(give, 'Sending…');
        api('POST', '/api/teams/brief', { team: t.id, text: input.value }).then(function (r) {
          restore(); out.textContent = ''; out.appendChild(msg(r, 'The coordinator is planning. Its questions or plan appear above and in Slack.'));
          if (r.ok !== false) { input.value = ''; setTimeout(refresh, 800); }
        });
      };
      var composer = t.canBrief ? card('teambrief', 'Give ' + t.name + ' a task', null, h('div', { class: 'stack', style: 'gap:10px' }, input,
          h('div', { class: 'row' }, give, h('span', { class: 'faint', text: 'The coordinator asks what it needs, then proposes a plan for you to approve. ' + money(t.budgetUSDPerTask) + ' cap.' })), out))
        : h('p', { class: 'faint', text: 'Only people who manage someone on this team can give it work.' });
      var toComposer = function () { composer.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(function () { input.focus(); }, 300); };
      if (state.teamFocusBrief && t.canBrief) { state.teamFocusBrief = false; setTimeout(toComposer, 150); }
      return [h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Teams', onclick: function () { go('teams'); } }), ' / ' + t.name),
            h('div', { class: 'row', style: 'gap:12px;flex-wrap:nowrap' }, PICTURES[t.id] ? avatar(t.id, t.name, 'l') : null, h('h1', { class: 'page-title', text: t.name })),
            t.purpose ? h('p', { class: 'page-sub', text: t.purpose }) : null),
          h('div', { class: 'page-actions' }, faces, t.canBrief ? h('button', { class: 'btn go', onclick: toComposer }, icon('plus', 16), 'Give it a task') : null)),
        nowSlot,
        kpiSlot,
        h('div', { class: 'split quarters' },
          h('div', { class: 'wide stack', style: 'gap:16px' }, x.tasks.length ? [list, earlier, composer] : [composer, list]),
          h('aside', { class: 'narrow stack', style: 'gap:16px' },
            teamKnows(t, refresh),
            t.canChange || t.guidance ? teamGuide(t) : null,
            card('teammembers', 'Members · ' + t.members.length, null, membersBox, true),
            t.canChange ? card('teamhow', 'How it works with you', null, teamSettings(t)) : null,
            t.canChange ? card('teampic', 'Picture', null, h('details', null, h('summary', { text: t.avatarUrl ? 'Change its picture' : 'Give it a picture' }), h('div', { style: 'margin-top:12px' },
              picturePicker(t, function (url) { return api('POST', '/api/teams/' + encodeURIComponent(t.id) + '/settings', { avatarUrl: url }); })))) : null,
            card('teamreach', 'Reach ' + t.name, null, h('details', null, h('summary', { text: 'From Slack, Claude or the API' }), h('div', { style: 'margin-top:12px' }, reachView('team', t.name)))),
            t.canChange ? teamEnd(t) : null))];
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
      var crew = (r[0] || []).filter(function (w) { return w.youManage; });
      var faces = crew.length ? h('div', { class: 'row hire-crew', style: 'gap:10px' },
        h('span', { class: 'faces' }, crew.slice(0, 5).map(function (w) { return avatar(w.id, w.name, 's'); })),
        h('span', { class: 'faint', text: 'Joins ' + (crew.length <= 2 ? crew.map(function (w) { return w.name; }).join(' and ') : crew.slice(0, 2).map(function (w) { return w.name; }).join(', ') + ' and ' + plural(crew.length - 2, 'other', 'others')) + ' you manage.' })) : null;
      var main = [head('What do you need done?', 'Describe the job the way you’d brief a new colleague. You review the worker before anything runs.'),
        faces,
        wrap,
        h('ol', { class: 'hiresteps', 'aria-label': 'How hiring works' },
          h('li', { class: 'on' }, h('span', { class: 'faint', text: '1' }), h('b', { style: 'font-weight:600', text: 'You describe the job' }), h('span', { class: 'muted', style: 'font-size:13px', text: 'It may ask a question or two, and says if someone already does it.' })),
          h('li', null, h('span', { class: 'faint', text: '2' }), h('b', { style: 'font-weight:600', text: 'You read its offer' }), h('span', { class: 'muted', style: 'font-size:13px', text: 'Its routine, schedule, tools and budget, in plain words. Change anything.' })),
          h('li', null, h('span', { class: 'faint', text: '3' }), h('b', { style: 'font-weight:600', text: 'It starts carefully' }), h('span', { class: 'muted', style: 'font-size:13px', text: 'It asks you before each run and before anything leaves the server, until it earns more trust.' })))];
      var nodes = main;
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
      return [h('div', { class: 'hirelay' }, h('div', { class: 'hire-main' }, nodes), hireIdeas(ctx))];
    });
  }

  function show(ctx, r) {
    ctx.wrap.textContent = '';
    if (r.ok === false) { state.hire = null; ctx.wrap.appendChild(describe(ctx, r.error)); return; }
    // Questions and the offer are their own narrow page, without the ideas.
    state.hire = r.hire;
    render();
    window.scrollTo(0, 0);
  }

  /// What workers are good at, by how they run, each with a brief written
  /// the way the drafter likes, when it would run, and a taste of what lands.
  var HIRE_KINDS = [
    { id: 'schedule', label: 'On a schedule', icon: 'clock', help: 'It checks something on a cadence and tells you what changed.', ex: [
      { title: 'Competitor watch', when: 'Mondays 8:00', lands: '3 changes worth a look: one competitor cut its Pro price 10%…', text: 'Every Monday morning, check our competitors’ pricing pages and changelogs, and tell me what changed and which changes matter for us, with links.' },
      { title: 'Site audit', when: 'Weekly', lands: '12 fixes ranked by payoff; 4 new since last week…', text: 'Every week, crawl our website, rank the SEO fixes worth making by payoff against effort, and compare with last week’s audit.' },
      { title: 'Metrics digest', when: 'Fridays 4:00', lands: 'Sign-ups up 8%, driven by the new onboarding flow…', text: 'Every Friday afternoon, pull the week’s product usage numbers and explain what moved, and why it might matter, in a short summary.' }] },
    { id: 'slack', label: 'Asked in Slack', icon: 'slack', help: 'People mention @overcli in any channel or DM it, and it answers in the thread.', ex: [
      { title: 'Ticket status', when: 'When asked', lands: 'In review since Tuesday, owned by Sam, blocked on the API change…', text: 'When someone asks about a ticket in Slack, look it up in our tracker and answer with its status, owner, blockers and what happens next.' },
      { title: 'Account briefing', when: 'When asked', lands: 'Renewal in 6 weeks, 2 open tickets, usage down 15%…', text: 'When someone asks about a customer, gather our notes, open tickets and product usage into a short briefing with what to watch.' },
      { title: 'Bug triage', when: 'When asked', lands: 'Reproduced; the cause is a null date. Pull request with a fix and a test…', text: 'When someone asks you to look at a bug, reproduce it, find the cause, and open a pull request with a fix and a test.' }] },
    { id: 'event', label: 'When something happens', icon: 'bolt', help: 'A webhook, a Slack message or a change in a tool starts it.', ex: [
      { title: 'New support ticket', when: 'On each ticket', lands: 'Billing question; draft reply ready; 2 similar tickets linked…', text: 'When a support ticket arrives, classify it, draft a reply, and link similar past tickets for the agent who picks it up.' },
      { title: 'Ready for QA', when: 'On a status change', lands: '14 test cases written; smoke suite passed…', text: 'When a ticket moves to Ready for QA, write the test cases for it and run the smoke suite, then post the results on the ticket.' },
      { title: 'New lead', when: 'On each form', lands: 'Mid-size company, 3 seats today, likely fit…', text: 'When the sign-up form sends a new lead, research the company and post a short summary to the lead’s owner.' }] },
    { id: 'team', label: 'As a team', icon: 'team', help: 'Several workers on one deliverable, with a coordinator and your review.', team: true, ex: [
      { title: 'PR/FAQ', when: 'Per idea', lands: 'Press release, customer FAQ and internal FAQ, challenged before it’s final', text: '' },
      { title: 'Quarterly review', when: 'Each quarter', lands: 'One reviewed pack from many sources', text: '' },
      { title: 'Design critique', when: 'Per design', lands: 'A UX review, a challenge, and the changes to make', text: '' }] }
  ];

  /// The right side of the Hire page: what workers are good at, by how they
  /// run, each example one tap from a brief in the box.
  function hireIdeas(ctx) {
    var pick = state.hireKind || 'schedule';
    var tabs = h('div', { class: 'hk-tabs', role: 'tablist', 'aria-label': 'How it runs' });
    var body = h('div', { class: 'stack', style: 'gap:10px' });
    var draw = function () {
      var k = HIRE_KINDS.filter(function (x) { return x.id === pick; })[0];
      fill(tabs, HIRE_KINDS.map(function (x) {
        return h('button', { type: 'button', role: 'tab', class: 'hk-tab hk-' + x.id, 'aria-selected': x.id === pick ? 'true' : 'false', onclick: function () { pick = x.id; state.hireKind = pick; draw(); } },
          h('span', { class: 'hk-ic', 'aria-hidden': 'true' }, icon(x.icon, 17)), h('span', { text: x.label }));
      }));
      fill(body, [h('p', { class: 'muted', style: 'margin:0;font-size:13px', text: k.help })].concat(k.ex.map(function (e) {
        var use = h('button', { type: 'button', class: 'btn small', text: k.team ? 'Make a team' : 'Use this' });
        use.onclick = function () {
          if (k.team) { go('newteam', { teamRunId: null }); return; }
          ctx.job.value = e.text;
          ctx.job.dispatchEvent(new Event('input'));
          ctx.job.focus();
          ctx.job.scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        return h('article', { class: 'hk-card hk-' + k.id },
          h('div', { class: 'hk-card-top' },
            h('span', { class: 'stack', style: 'gap:4px;flex:1;min-width:0' }, h('b', { text: e.title }), h('span', { class: 'hk-when', text: e.when })),
            use),
          h('div', { class: 'hk-lands' }, h('span', { class: 'hk-lands-k', text: 'What lands' }), h('span', { text: e.lands })));
      })));
    };
    draw();
    return h('aside', { class: 'hire-ideas', 'aria-label': 'What workers are good at' },
      h('span', { class: 'label', text: 'What workers are good at' }), tabs, body,
      h('section', { class: 'hk-fit' },
        h('b', { text: 'Works best when it’s' }),
        h('ul', null,
          h('li', null, h('span', { class: 'hk-tick', 'aria-hidden': 'true' }, icon('tick', 12)), h('span', null, h('b', { text: 'Recurring or triggered: ' }), 'a schedule or an event starts it.')),
          h('li', null, h('span', { class: 'hk-tick', 'aria-hidden': 'true' }, icon('tick', 12)), h('span', null, h('b', { text: 'Something you read: ' }), 'a report, a summary, a pull request.')),
          h('li', null, h('span', { class: 'hk-tick', 'aria-hidden': 'true' }, icon('tick', 12)), h('span', null, h('b', { text: 'Cheap to approve: ' }), 'a quick yes before it changes anything.'))),
        h('p', { class: 'faint', text: 'Not a fit: decisions with no review step, or hours of live back-and-forth. Several angles on one document? Make a team instead.' })));
  }

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
    ctx.job = job;
    // What a good brief covers, ticked off as it's typed: word checks, no model.
    var hints = h('div', { class: 'brief-hints', 'aria-live': 'polite' });
    var HINTS = [['what it does', function (t) { return t.length > 24; }],
      ['for whom', function (t) { return /\b(for|me|us|our|team|customers?|owner|someone|manager)\b/.test(t); }],
      ['how often', function (t) { return /\b(every|each|weekly|daily|monthly|morning|monday|tuesday|wednesday|thursday|friday|when|whenever)\b/.test(t); }],
      ['where the information lives', function (t) { return /\b(tracker|site|website|pages?|notes|tickets?|usage|form|changelog|slack|repo|docs?|crm|sheet|dashboard|inbox|calendar)\b/.test(t); }]];
    var drawHints = function () {
      var t = job.value.toLowerCase();
      fill(hints, [h('span', { class: 'faint', text: 'A good brief says' })].concat(HINTS.map(function (x) {
        var on = x[1](t);
        return h('span', { class: 'bh' + (on ? ' on' : '') }, on ? icon('tick', 11) : null, x[0]);
      })));
    };
    job.addEventListener('input', drawHints);
    drawHints();
    return h('div', { class: 'stack' }, h('div', { class: 'panel pad stack hire-brief' },
      job, hints,
      h('div', { class: 'spread', style: 'align-items:center;border-top:1px solid var(--line);padding-top:12px' },
        h('span', { class: 'status' }, h('span', { class: 'sdot ok' }), left != null ? (left > 0 ? 'Within your allowance: ' + money(left) + ' left this month' : 'Over your allowance: an approver will be asked') : 'You’ll be its manager. Its questions come to you.'),
        draft),
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
    return h('div', { class: 'stack' }, steps(1), alreadyDoes(hire), h('div', { class: 'panel pad stack', style: 'gap:18px' },
      h('p', { class: 'muted', text: 'The drafter wants a little more before it writes the offer. Answer what you can.' }),
      boxes.map(function (b) { return h('div', { class: 'qa' }, h('div', { class: 'quote', style: 'font-size:16px', text: b.q }), b.ta); }),
      h('div', { class: 'row' }, cont, skipBtn), out));
  }

  /// Someone you have already does this job: say so before you hire again.
  function alreadyDoes(hire) {
    var a = hire.alreadyDoes;
    if (!a) return null;
    return h('div', { class: 'msg', style: 'background:var(--need-soft);color:var(--ink);display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
      h('span', { style: 'flex:1 1 320px' }, h('b', { text: a.name + ' may already do this. ' }), a.why || a.tagline || '', ' Ask ' + a.name + ' instead, or carry on to hire.'),
      h('button', { class: 'btn small', text: 'Open ' + a.name, onclick: function () { openWorker(a.workerId); } }));
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
    return h('div', { class: 'stack' }, steps(2), alreadyDoes(hire), h('article', { class: 'panel offer' },
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
        'In the overcli app, open Settings, Your org, paste this address and press Sign in. Your browser opens here to confirm it\u2019s you; there is nothing to copy.',
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

      // Signed in before Slack was connected: nothing in Slack can reach
      // you, and workers you manage DM nobody. Slack asks you to confirm.
      if (!state.me.slackUserId) {
        var sid = h('input', { type: 'text', placeholder: 'U012AB3CD', 'aria-label': 'Your Slack member ID', style: 'width:180px' });
        var linked = h('div');
        var send = h('button', { class: 'btn go small', text: 'Send me a DM to confirm' });
        send.onclick = function () {
          var restore = busy(send, 'Sending…');
          api('POST', '/api/me/slack', { slackUserId: sid.value.trim() }).then(function (x) {
            restore(); linked.textContent = '';
            linked.appendChild(msg(x, 'Check your Slack DMs and press “Yes, that’s me”. Then reload this page.'));
          });
        };
        nodes.push(h('section', { class: 'panel pad stack ask need', style: 'display:flex', 'aria-labelledby': 'link-slack' },
          h('h2', { id: 'link-slack', class: 'section-title', text: 'Link your Slack' }),
          h('p', { class: 'muted', style: 'margin:0', text: 'You signed in as “' + state.me.name + '” before Slack was connected, so Slack can’t reach you and the workers you manage message nobody. Link your Slack account: your sign-in becomes you, by your Slack name, and your workers DM you there.' }),
          h('div', { class: 'row', style: 'gap:8px' }, sid, send),
          h('p', { class: 'faint', style: 'margin:0', text: 'Your member ID is in Slack: your profile → ⋮ → Copy member ID. Slack DMs that person a button, and only they can press it.' }),
          linked));
      }

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

      var table = h('div', { class: 'tscroll' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, ['Person', 'Can', 'Workers', 'Spend of allowance', 'Signed in on', ''].map(function (t) { return h('th', { scope: 'col', text: t }); }))),
        h('tbody', null, ppl.people.map(function (p) { return personRows(p, ppl.people); }))));

      nodes.push(h('div', { class: 'people-grid' },
        h('section', { class: 'tcard', 'aria-labelledby': 'ppl' }, h('div', { class: 'sec-head' }, h('h2', { id: 'ppl', class: 'label', text: plural(ppl.people.length, 'person', 'people') })), table),
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
      var join = h('button', { class: 'btn go', style: 'min-height:42px;font-size:14px', text: info.setup ? 'Sign in as the first admin' : 'Join ' + info.org + ' as ' + info.name });
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
        appText.appendChild(linkBox(base, 'In the overcli app: Settings, Your org. Paste this address and press Sign in, then confirm the code it shows.'));
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
        var allow = h('button', { class: 'btn go', style: 'min-height:42px;font-size:14px', text: 'Allow' });
        var deny = h('button', { class: 'btn', style: 'min-height:42px', text: 'Don’t allow' });
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
        card('sp', 'Spend this month', h('span', { class: 'big', style: 'font-size:20px;font-family:var(--sans);font-weight:700', text: money(total) + (hl.spend.orgBudgetUSD ? ' of ' + money(hl.spend.orgBudgetUSD) : '') }), [
          hl.spend.orgBudgetUSD ? h('div', { class: 'meter' + (total / hl.spend.orgBudgetUSD >= 0.85 ? ' high' : ''), role: 'img', 'aria-label': Math.round((total / hl.spend.orgBudgetUSD) * 100) + '% of the org budget' },
            h('span', { style: 'width:' + Math.min(100, (total / hl.spend.orgBudgetUSD) * 100).toFixed(0) + '%' })) : null,
          spendBars('By manager', hl.spend.byManager, total),
          hl.spend.byTeam.length ? spendBars('By team', hl.spend.byTeam, total) : null]),
        fl.ok !== false && fl.servers.length ? fleetPanel(fl.servers) : null,
        card('lg', 'Recent decisions', h('button', { class: 'linkish', text: 'Search and export', onclick: function () { go('log'); } }),
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
      h('h2', { class: 'section-title', text: title }), sub ? h('p', { class: 'hint', style: 'font-size:13px', text: sub }) : null,
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
      var webAsk = h('input', { type: 'checkbox', checked: !!R.webNeedsApproval });
      var cleared = h('input', { type: 'text', value: R.allowedMcpServers.join(', '), placeholder: 'acme-crm, acme-docs' });
      var hiring = ruleSection('Hiring', 'Who may hire, what their workers may cost before a hire needs approval, and who approves.',
        h('div', { class: 'stack' },
          h('label', { class: 'toggle' }, everyone, h('span', { text: 'Everyone with access may hire' })),
          hirers.node,
          h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Allowance per person (USD a month)', allowance), h('label', { class: 'field' }, 'Tools any hire may have without approval', cleared)),
          h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'faint', text: 'Approves hires over an allowance (none ticked: the admins)' }), approvers.node),
          h('label', { class: 'toggle' }, visAdmin, h('span', { text: 'Making a worker visible to everyone needs an admin' })),
          h('label', { class: 'toggle' }, webAsk, h('span', { text: 'Workers ask before reading the web (searching, or opening a page). Off: research runs without asking; anything that acts still asks.' }))),
        function () {
          return { hirers: everyone.checked ? '*' : hirers.value(), budgetAllowanceUSD: Number(allowance.value || 0), approvers: approvers.value(), orgVisibilityNeedsAdmin: visAdmin.checked, webNeedsApproval: webAsk.checked, allowedMcpServers: list(cleared.value) };
        });

      // Spending.
      var cap = h('input', { type: 'number', min: '1', step: '1', value: R.orgBudgetUSD == null ? '' : String(R.orgBudgetUSD), placeholder: 'No cap' });
      var alertAt = h('input', { type: 'number', min: '0', max: '100', step: '5', value: String(R.alertAtPercent) });
      var spending = ruleSection('Spending', 'A cap on what every worker together may cost in a month, and when to warn people they are getting close.',
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Org-wide budget (USD a month)', cap), h('label', { class: 'field' }, 'Warn at (% of a budget; 0 for never)', alertAt)),
        function () { return { orgBudgetUSD: numOrNull(cap), alertAtPercent: Number(alertAt.value || 0) }; });

      // Records.
      var keep = h('input', { type: 'number', min: '7', step: '1', value: R.retentionDays == null ? '' : String(R.retentionDays), placeholder: 'Forever' });
      var records = ruleSection('Records', 'How long the decision log, finished runs and each run’s step-by-step activity are kept. Older ones are deleted each night. Left blank, records stay forever and run activity a week.',
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
  /// A run, live: where it is, then each thing it did — the tools it used,
  /// what it said, anything refused or failed — newest at the bottom. Checks
  /// every 3 s while it runs and is on screen; stops when it ends.
  ///
  /// Boxed, under a thread that already shows where the run is: no status
  /// line, and the list scrolls in a box of its own, following its newest
  /// line, so what's above it stays where you left it.
  /// What a run did, in plain words: its tool calls grouped by kind, a line
  /// each with a count, the exact lines kept for "Show the commands".
  var ACT_HOST = /https?:\/\/(?:www\.)?([^\/\s"'|>]+)/;
  function activityGroup(a) {
    var t = a.text, host = (ACT_HOST.exec(t) || [])[1];
    var n_ = function (n, one, many) { return n === 1 ? one : many.replace('#', n); };
    if (a.kind === 'said') return { key: 'said:' + a.at, line: '“' + t + '”', cls: 'said' };
    if (a.kind !== 'tool') return { key: a.kind + ':' + a.at, line: t, cls: a.kind === 'error' ? 'bad' : 'need' };
    if (/^Read /.test(t)) return { key: 'read', line: function (n) { return n === 1 ? t : 'Read ' + n + ' files'; } };
    if (/^(Looked for|Searched files for) /.test(t)) return { key: 'look', line: function (n) { return n_(n, 'Looked through its files', 'Looked through its files · # searches'); } };
    if (/^(Wrote|Edited) /.test(t)) return { key: 'write', line: function (n) { return n === 1 ? t : 'Wrote or changed ' + n + ' files'; } };
    if (/^Searched the web: /.test(t)) return { key: 'web', line: function (n) { return n === 1 ? t : 'Searched the web · ' + n + ' searches'; } };
    if (/^Opened /.test(t)) return { key: 'open:' + (host || ''), line: function (n) { return 'Read ' + (host || 'a web page') + (n > 1 ? ' · ' + n + ' pages' : ''); } };
    if (/^Ran /.test(t)) {
      var cmd = t.slice(4);
      if (/\b(curl|wget)\b/.test(cmd)) return { key: 'fetch:' + (host || ''), line: function (n) { return 'Fetched pages' + (host ? ' from ' + host : '') + (n > 1 ? ' · ' + n + ' times' : ''); } };
      if (/\bgit\b/.test(cmd)) return { key: 'git', line: function (n) { return n_(n, 'Worked with git', 'Worked with git · # commands'); } };
      if (/\b(npm|pnpm|yarn|npx|pytest|jest|vitest|make|cargo|go test)\b/.test(cmd)) return { key: 'build', line: function (n) { return n_(n, 'Ran a build or tests', 'Ran builds or tests · #'); } };
      return { key: 'cmd', line: function (n) { return n_(n, 'Ran a command in its workspace', 'Ran # commands in its workspace'); } };
    }
    if (/^Updated its to-do list/.test(t)) return { key: 'todo', line: function () { return 'Updated its plan'; } };
    var tool = /^([^:]{1,40}): /.exec(t);
    if (tool) return { key: 'tool:' + tool[1], line: function (n) { return 'Used ' + tool[1] + (n > 1 ? ' · ' + n + ' calls' : ''); } };
    return { key: 'other:' + a.at, line: t };
  }
  /// Housekeeping in its workspace: looking, reading, running commands.
  /// Back-to-back within a minute it is one line, however it alternates.
  var ROUTINE = { look: 1, read: 1, cmd: 1, git: 1, build: 1, todo: 1, write: 1 };
  function routineLine(counts) {
    var parts = [];
    var n = function (k, one, many) { return counts[k] + ' ' + (counts[k] === 1 ? one : many); };
    if (counts.read) parts.push('read ' + n('read', 'file', 'files'));
    if (counts.look) parts.push('searched its files');
    if (counts.cmd) parts.push('ran ' + n('cmd', 'command', 'commands'));
    if (counts.write) parts.push('wrote ' + n('write', 'file', 'files'));
    if (counts.git) parts.push('used git');
    if (counts.build) parts.push('ran builds or tests');
    if (counts.todo) parts.push('updated its plan');
    var said = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  function groupActivity(items) {
    var out = [];
    items.forEach(function (a) {
      var g = activityGroup(a), last = out[out.length - 1];
      if (last && last.key === g.key && typeof g.line === 'function') {
        last.items.push(a); last.at = a.at;
        if (last.routine) last.counts[g.key] = (last.counts[g.key] || 0) + 1;
        return;
      }
      // Mixed housekeeping in the same minute joins the line before it.
      if (last && ROUTINE[g.key] && last.routine && a.at - last.from < 60000) {
        last.items.push(a); last.at = a.at; last.counts[g.key] = (last.counts[g.key] || 0) + 1; last.mixed = true;
        return;
      }
      var counts = {}; if (ROUTINE[g.key]) counts[g.key] = 1;
      out.push({ key: g.key, line: g.line, cls: g.cls || '', items: [a], at: a.at, from: a.at, routine: !!ROUTINE[g.key], counts: counts });
    });
    return out.map(function (g) {
      if (g.mixed) {
        return { text: routineLine(g.counts), cls: '', at: g.at, raw: g.items.map(function (a) { return a.text; }) };
      }
      return { text: typeof g.line === 'function' ? g.line(g.items.length) : g.line, cls: g.cls, at: g.at, raw: g.items.map(function (a) { return a.text; }) };
    });
  }

  /// \x60boxed\x60 'step': inside a timeline's running step, it leads with the
  /// last thing the worker said and keeps the list folded behind one line.
  function liveRunView(runId, boxed) {
    var compact = boxed === 'step';
    var opened = false;
    var head_ = h('div', { class: 'watch-head' }, thinking('Connecting…'));
    var list = h('ol', { class: 'watch-list' + (boxed ? ' boxed' : '') });
    var lead = h('div', { class: 'vs-live' }, h('span', { class: 'vs-spin', 'aria-hidden': 'true' }), h('span', { text: 'Getting started…' }));
    var count = h('span', { class: 'faint' });
    var fold = h('button', { class: 'linkish', style: 'color:var(--go);font-size:12.5px', text: 'Show activity' });
    var empty = h('p', { class: 'muted', text: 'Nothing yet. Its steps show up here as it takes them.' });
    var raw = h('button', { class: 'linkish', style: 'color:var(--go);font-size:12.5px' });
    var items = [];
    var ended = false;
    var draw = function () {
      raw.textContent = state.showCommands ? 'Hide the commands' : 'Show the commands';
      var groups = groupActivity(items);
      var near = boxed ? list.scrollHeight - list.scrollTop - list.clientHeight < 160 : true;
      fill(list, groups.map(function (g, i) {
        var now = !ended && i === groups.length - 1 && !g.cls;
        return h('li', { class: 'watch-item ' + g.cls + (now ? ' now' : '') }, h('span', { class: 'faint watch-at', text: now ? 'now' : clock(g.at) }),
          h('span', { class: 'stack', style: 'gap:4px;min-width:0' },
            h('span', { class: g.cls === 'said' ? 'watch-said' : '', text: g.text }),
            state.showCommands && !g.cls ? h('pre', { class: 'watch-raw', text: g.raw.join('\n') }) : null));
      }));
      empty.hidden = !!items.length;
      raw.hidden = !items.length;
      if (near && boxed) list.scrollTop = list.scrollHeight;
      if (compact) {
        // The worker's own words when it has said any; else what it's doing.
        var said = items.filter(function (a) { return a.kind === 'said'; }).pop();
        var latest = said ? said.text : groups.length ? groups[groups.length - 1].text : '';
        lead.lastChild.textContent = latest ? (latest.length > 220 ? latest.slice(0, 219).trim() + '…' : latest) : 'Getting started…';
        lead.firstChild.hidden = ended;
        count.textContent = plural(items.length, 'action', 'actions') + (ended ? '' : ' so far');
        fold.textContent = opened ? 'Hide activity' : 'Show activity';
        fold.hidden = !items.length;
        list.hidden = empty.hidden = !opened;
        raw.hidden = !opened || !items.length;
      }
    };
    raw.onclick = function () { state.showCommands = !state.showCommands; draw(); };
    fold.onclick = function () { opened = !opened; draw(); };
    var box = compact
      ? h('div', { class: 'stack', style: 'gap:6px' }, lead, h('div', { class: 'row', style: 'gap:12px;font-size:12.5px' }, count, fold, h('span', { style: 'margin-left:auto' }, raw)), list, empty)
      : h('div', null, head_, h('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:6px' }, raw), list, empty);
    var last = 0;
    var tick = function () {
      if (!box.isConnected && last) return;
      api('GET', '/api/runs/' + encodeURIComponent(runId) + '/live?after=' + last).then(function (x) {
        if (x.ok === false) { head_.hidden = false; head_.replaceChildren(msg(x)); return; }
        var r = x.run;
        ended = /^(done|failed|aborted)/.test(r.state);
        head_.hidden = !!boxed;
        head_.replaceChildren(h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' },
          h('span', { class: 'badge ' + (ended ? (r.state === 'done' ? 'ok' : 'bad') : /^paused/.test(r.state) ? 'waiting' : 'working'), text: ended ? (r.state === 'done' ? 'Finished' : 'Ended') : /^paused/.test(r.state) ? 'Paused' : 'Running' }),
          h('span', { text: (r.workerName ? r.workerName + ' · ' : '') + 'step ' + r.step.index + ' of ' + r.step.total + ', ' + r.step.name.replace(/[-_]+/g, ' ') }),
          h('span', { class: 'faint', text: secs(Date.now() - r.startedAt) + (r.costUSD ? ' · ' + money(r.costUSD) : '') })));
        if (!last) last = 1;
        x.activity.forEach(function (a) { last = Math.max(last, a.at); items.push(a); });
        draw();
        if (!boxed && x.activity.length) { var sc = box.closest('.reader-body'); if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight; }
        if (!ended) setTimeout(function () { if (box.isConnected) tick(); }, 3000);
      }, function () { setTimeout(function () { if (box.isConnected) tick(); }, 6000); });
    };
    setTimeout(tick, 0);
    return box;
  }
  function watchRun(runId, title) {
    openReader(title || 'Run', 'Live', function (put) { put([liveRunView(runId)]); });
  }

  /// A side panel that reads one thing in full: a Library item, fetched
  /// whole (the list only carries a preview). Esc or the backdrop closes it.
  function fileSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  var TEXT_FILE = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|svg|tsx?|jsx?|css|py|sql|sh|log)$/i;

  /// The files a run wrote besides its report: the HTML it rendered, the
  /// data behind it. Asked for once per run, since a thread redraws often,
  /// and drawn as buttons that open each in the side panel. A run that wrote
  /// none shows nothing.
  var runFilesCache = {};
  function runFiles(runId, sub) {
    var box = h('div', { class: 'run-files' });
    var draw = function (files) {
      if (!files || !files.length) return;
      append(box, [h('span', { class: 't-kind', text: 'Files it made' }),
        h('div', { class: 'row', style: 'gap:6px' }, files.map(function (f) {
          return h('button', { class: 'btn small', title: f.name, onclick: function () { openRunFile(f, sub); } },
            h('code', { text: f.name.split('/').pop() }), f.bytes ? h('span', { class: 'faint', text: ' · ' + fileSize(f.bytes) }) : null);
        }))]);
    };
    // Links are good for an hour; asked again well before that.
    var hit = runFilesCache[runId];
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) draw(hit.files);
    else api('GET', '/api/runs/' + encodeURIComponent(runId) + '/files').then(function (x) {
      if (x.ok === false) return;
      runFilesCache[runId] = { at: Date.now(), files: x.files };
      draw(x.files);
    });
    return box;
  }

  var SCOPE_LABEL = { full: 'Whole tool', read: 'Read only', only: 'Calls I pick' };
  function scopeWords(s) { return !s || s.mode === 'full' ? 'whole tool' : s.mode === 'read' ? 'read only' : (s.calls.length === 1 ? '1 call' : s.calls.length + ' calls'); }

  /// A tool's scope on the Manage panel: its default for every worker that
  /// has it (with what that allows and refuses, call by call), then each
  /// worker with its own scope and the last week's use.
  function toolScopeSection(t, workers) {
    var box = h('div', { class: 'stack', style: 'gap:18px' }, h('span', { class: 'faint', text: 'Reading its calls…' }));
    var out = h('div', { 'aria-live': 'polite' });
    api('GET', '/api/admin/tools/' + encodeURIComponent(t.name) + '/scope').then(function (p) {
      box.textContent = '';
      if (p.ok === false) { box.appendChild(msg(p)); return; }
      var def = p.default || { mode: 'full' };
      var picked = def.mode === 'only' ? def.calls.slice() : [];
      var mode = def.mode;
      var radios = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Default scope for ' + t.name });
      var lists = h('div', { class: 'stack', style: 'gap:10px' });
      var allows = function (c) { return mode === 'full' || (mode === 'read' ? c.read : picked.indexOf(c.name) >= 0); };
      var drawLists = function () {
        lists.textContent = '';
        if (!p.calls.length) { lists.appendChild(h('span', { class: 'faint', text: 'Its calls show once it connects.' })); return; }
        if (mode === 'only') {
          lists.appendChild(h('div', { class: 'stack', style: 'gap:4px;max-height:240px;overflow:auto' }, p.calls.map(function (c) {
            var id = 'dc-' + t.name + '-' + c.name;
            var box_ = h('input', { type: 'checkbox', id: id, checked: picked.indexOf(c.name) >= 0 });
            box_.onchange = function () { if (box_.checked) picked.push(c.name); else picked = picked.filter(function (x) { return x !== c.name; }); };
            return h('label', { for: id, class: 'row', style: 'gap:8px;flex-wrap:nowrap;font-size:13px' }, box_, h('code', { text: c.name }), h('span', { class: 'faint', text: c.read ? 'reads' : 'changes' }));
          })));
          return;
        }
        var ok = p.calls.filter(allows), no = p.calls.filter(function (c) { return !allows(c); });
        var chips = function (xs, cls) { return h('div', { class: 'row', style: 'gap:6px' }, xs.slice(0, 8).map(function (c) { return h('code', { class: 'tag ' + cls, text: c.name }); }), xs.length > 8 ? h('span', { class: 'faint', text: '+' + (xs.length - 8) + ' more' }) : null); };
        append(lists, [h('div', { class: 'stack', style: 'gap:4px' }, h('b', { style: 'font-size:13px;color:var(--go)', text: 'Allowed · ' + ok.length }), ok.length ? chips(ok, 'go') : h('span', { class: 'faint', text: 'Nothing.' })),
          no.length ? h('div', { class: 'stack', style: 'gap:4px' }, h('b', { style: 'font-size:13px;color:var(--need)', text: 'Refused · ' + no.length }), chips(no, 'need')) : null]);
      };
      var drawRadios = function () {
        radios.textContent = '';
        ['full', 'read', 'only'].forEach(function (m) {
          radios.appendChild(h('button', { role: 'radio', 'aria-checked': mode === m ? 'true' : 'false', class: 'seg-b' + (mode === m ? ' on' : ''), text: SCOPE_LABEL[m], onclick: function () { mode = m; drawRadios(); drawLists(); } }));
        });
      };
      var saveDef = h('button', { class: 'btn go small', text: 'Save the default' });
      saveDef.onclick = function () {
        var restore = busy(saveDef, 'Saving…');
        var value = mode === 'full' ? null : mode === 'read' ? { mode: 'read' } : { mode: 'only', calls: picked };
        api('POST', '/api/admin/tools/' + encodeURIComponent(t.name) + '/scope', { default: value }).then(function (x) {
          restore(); out.textContent = ''; out.appendChild(msg(x, 'Saved. Every worker that has ' + t.name + ' gets this unless it has its own.'));
          if (x.ok !== false) { def = x.default || { mode: 'full' }; drawRows(); }
        });
      };
      drawRadios(); drawLists();
      // Each worker that has it.
      var rows = h('div', { class: 'stack', style: 'gap:0' });
      var drawRows = function () {
        rows.textContent = '';
        if (!p.workers.length) { rows.appendChild(h('p', { class: 'muted', style: 'margin:0', text: 'No worker has it yet.' })); return; }
        p.workers.forEach(function (w) {
          var wide = w.own && (def.mode !== 'full') && (w.own.mode === 'full' || (def.mode === 'read' && w.own.mode === 'only' && w.own.calls.some(function (c) { var hit = p.calls.filter(function (x) { return x.name === c; })[0]; return hit && !hit.read; })));
          var pick = h('select', { 'aria-label': w.name + '’s scope for ' + t.name },
            h('option', { value: 'default', text: 'Default · ' + scopeWords(def), selected: !w.own }),
            ['full', 'read', 'only'].map(function (m) { return h('option', { value: m, text: SCOPE_LABEL[m] + (m === 'only' && w.own && w.own.mode === 'only' ? ' · ' + w.own.calls.length : ''), selected: !!w.own && w.own.mode === m }); }));
          var note = h('span', { class: 'faint', style: 'font-size:12px' });
          if (w.own && w.own.mode === 'only') note.textContent = w.own.calls.slice(0, 3).join(', ') + (w.own.calls.length > 3 ? '…' : '');
          if (wide) { note.textContent = 'Wider than the default, set by an admin'; note.style.color = 'var(--need)'; }
          pick.onchange = function () {
            var v = pick.value === 'default' ? null : pick.value === 'full' ? { mode: 'full' } : pick.value === 'read' ? { mode: 'read' } : { mode: 'only', calls: (w.own && w.own.calls) || p.calls.filter(function (c) { return c.read; }).map(function (c) { return c.name; }) };
            var patch = {}; patch[t.name] = v;
            pick.disabled = true;
            api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { toolScopes: patch } }).then(function (x) {
              pick.disabled = false;
              out.textContent = ''; out.appendChild(msg(x, 'Saved ' + w.name + '.'));
              if (x.ok !== false) { if (v) w.own = v; else delete w.own; drawRows(); }
            });
          };
          rows.appendChild(h('div', { class: 'scope-row' + (wide ? ' wide' : '') },
            h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap;min-width:0' }, avatar(w.id, w.name, 's'), h('b', { style: 'font-weight:600', text: w.name })),
            h('span', { class: 'faint', text: w.manager || '' }),
            h('span', { class: 'stack', style: 'gap:2px;min-width:0' }, pick, note),
            h('span', { class: 'faint', style: 'font-size:13px', text: (w.calls ? plural(w.calls, 'call', 'calls') : 'Not used') + (w.refused ? ' · ' + w.refused + ' refused' : '') })));
        });
      };
      drawRows();
      append(box, [
        h('section', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'spread' }, h('div', { class: 't-kind', text: 'Default scope' }), h('span', { class: 'faint', style: 'font-size:12.5px', text: 'For every worker that has it, unless set below' })),
          radios, lists, h('div', null, saveDef)),
        h('section', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'spread' }, h('div', { class: 't-kind', text: 'Each worker' }), h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Narrower: any manager. Wider: an admin. Last 7 days on the right.' })),
          rows),
        out]);
    });
    return box;
  }

  /// One tool on a worker's card: whether the server has it, how much of it
  /// the worker may use, and for its manager a way to narrow that: the whole
  /// tool, only calls that read, or calls picked by name.
  function toolScopeRow(w, t) {
    var scope = t.scope;
    var label = !scope ? null : scopeWords(scope) + (t.scopeFrom === 'default' ? ' · default' : '');
    var editor = h('div', { class: 'stack', style: 'gap:8px;padding:6px 0 4px 18px' });
    editor.hidden = true;
    var save = function (value, btn) {
      var restore = busy(btn, 'Saving…');
      var patch = {}; patch[t.name] = value;
      api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { toolScopes: patch } }).then(function (x) {
        restore();
        if (x.ok === false) { editor.appendChild(msg(x)); return; }
        render();
      });
    };
    var open = function () {
      editor.hidden = !editor.hidden;
      if (editor.hidden || editor.childNodes.length) return;
      var mode = !scope || t.scopeFrom === 'default' ? 'default' : scope.mode;
      var pick = h('select', { 'aria-label': 'How much of ' + t.name + ' ' + w.name + ' may use', style: 'width:auto' },
        [['default', 'The org’s default' + (t.scopeFrom === 'default' ? ' (' + scopeWords(scope) + ')' : ' (whole tool)')], ['full', 'The whole tool'], ['read', 'Read only: refuse anything that changes something'], ['only', 'Only the calls I pick']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: o[0] === mode }); }));
      var calls = h('div', { class: 'stack', style: 'gap:4px;max-height:220px;overflow:auto' });
      var go_ = h('button', { class: 'btn go small', text: 'Save' });
      var drawCalls = function () {
        calls.textContent = '';
        if (pick.value !== 'only') return;
        calls.appendChild(h('span', { class: 'faint', text: 'Loading its calls…' }));
        api('GET', '/api/tools/' + encodeURIComponent(t.name) + '/calls').then(function (r) {
          calls.textContent = '';
          if (r.ok === false || !r.tools.length) { calls.appendChild(h('span', { class: 'faint', text: r.ok === false ? r.error : 'It reports no calls.' })); return; }
          var on = scope && scope.mode === 'only' ? scope.calls : [];
          // Only own picks: a default list is the org's, not this worker's.
          r.tools.forEach(function (c) {
            var id = 'call-' + t.name + '-' + c.name;
            calls.appendChild(h('label', { for: id, class: 'row', style: 'gap:8px;flex-wrap:nowrap;font-size:13px' },
              h('input', { type: 'checkbox', id: id, value: c.name, checked: on.indexOf(c.name) >= 0 }), h('code', { text: c.name })));
          });
        });
      };
      pick.onchange = drawCalls;
      go_.onclick = function () {
        if (pick.value === 'default') return save(null, go_);
        if (pick.value === 'full') return save({ mode: 'full' }, go_);
        if (pick.value === 'read') return save({ mode: 'read' }, go_);
        var picked = [].slice.call(calls.querySelectorAll('input:checked')).map(function (i) { return i.value; });
        save({ mode: 'only', calls: picked }, go_);
      };
      append(editor, [pick, calls, h('div', { class: 'row', style: 'gap:8px' }, go_,
        h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Calls outside it are refused, even with your OK. Wider than the org’s default needs an admin.' }))]);
      drawCalls();
    };
    return h('div', { class: 'stack', style: 'gap:0' },
      h('div', { class: 'row', style: 'flex-wrap:nowrap' }, h('span', { class: 'sdot ' + (t.ok ? 'ok' : 'bad') }), h('span', { style: 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: t.name, text: t.name }),
        label ? h('span', { class: 'badge', text: label }) : null,
        t.ok ? h('span', { class: 'faint', text: t.shared ? 'Every worker has it' : 'Installed' }) : state.me.admin ? h('button', { class: 'linkish', style: 'color:var(--bad);font-size:13px', text: 'Not on this server — install', onclick: function () { go('setup', { setupTab: 'tools' }); } }) : h('span', { class: 'faint', style: 'color:var(--bad)', text: 'Not on this server' }),
        w.youManage && t.ok ? h('button', { class: 'linkish', style: 'font-size:13px', 'aria-expanded': 'false', text: 'Scope', onclick: function (e) { open(); e.target.setAttribute('aria-expanded', editor.hidden ? 'false' : 'true'); } }) : null),
      editor);
  }

  /// A worker's own files, asked for once a minute at most: the Files tab
  /// and the links in its replies share the list.
  var workerFilesCache = {};
  function workerFiles(workerId) {
    var hit = workerFilesCache[workerId];
    if (hit && Date.now() - hit.at < 60 * 1000) return Promise.resolve(hit.files);
    return api('GET', '/api/workers/' + encodeURIComponent(workerId) + '/files').then(function (x) {
      if (x.ok === false) return [];
      workerFilesCache[workerId] = { at: Date.now(), files: x.files };
      return x.files;
    }, function () { return []; });
  }

  /// A path in a reply to a file in the worker's own folder (a report it
  /// built while answering) becomes a button that opens it. The rest of the
  /// reply is left as it was.
  function linkFiles(node, workerId, workerName) {
    var marker = '/worker-files/' + workerId + '/';
    if ((node.textContent || '').indexOf(marker) < 0) return node;
    workerFiles(workerId).then(function (files) {
      var byName = {};
      files.forEach(function (f) { byName[f.name] = f; });
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      var hits = [];
      while (walker.nextNode()) if (walker.currentNode.nodeValue.indexOf(marker) >= 0) hits.push(walker.currentNode);
      hits.forEach(function (text) {
        var parts = text.nodeValue.split(/(\S*\/worker-files\/[\w-]+\/\S+)/);
        var frag = document.createDocumentFragment();
        parts.forEach(function (part) {
          var at = part.indexOf(marker);
          var f = at >= 0 ? byName[part.slice(at + marker.length).replace(/[).,;:]+$/, '')] : null;
          if (!f) { frag.appendChild(document.createTextNode(part)); return; }
          frag.appendChild(h('button', { class: 'btn small', title: f.name, onclick: function () { openRunFile(f, workerName + ' · its files'); } }, icon('doc', 14), ' ' + f.name.split('/').pop()));
        });
        // A path shown as code becomes the button itself, not a button in code.
        var host = text.parentNode;
        if (host && host.tagName === 'CODE' && host.childNodes.length === 1) host.replaceWith(frag);
        else text.replaceWith(frag);
      });
    });
    return node;
  }

  /// Everything a worker has made, newest first, by day: reports it filed
  /// from runs and files it wrote while answering. Each opens in the panel.
  function filesView(w) {
    var box = h('div', { class: 'stack', style: 'gap:14px' }, thinking('Loading its files…'));
    var q = h('input', { type: 'search', placeholder: 'Search its files', 'aria-label': 'Search ' + w.name + '’s files', style: 'max-width:280px' });
    var list = h('div', { class: 'stack', style: 'gap:14px' });
    var all = [];
    var draw = function () {
      var words = q.value.trim().toLowerCase();
      var shown = all.filter(function (f) { return !words || f.name.toLowerCase().indexOf(words) >= 0; });
      list.textContent = '';
      if (!shown.length) { list.appendChild(h('p', { class: 'muted', text: all.length ? 'Nothing matches.' : w.name + ' hasn’t made any files yet. Reports from its runs, and files it writes while answering, land here.' })); return; }
      var days = [];
      shown.forEach(function (f) {
        var day = dayLabel(f.at);
        var last = days[days.length - 1];
        if (!last || last.day !== day) days.push(last = { day: day, files: [] });
        last.files.push(f);
      });
      days.forEach(function (d) {
        list.appendChild(h('section', { class: 'panel', 'aria-label': d.day },
          h('div', { class: 'wl-day', text: d.day }),
          d.files.map(function (f) {
            var folder = f.name.indexOf('/') > 0 ? f.name.slice(0, f.name.lastIndexOf('/')).replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/[-_]+/g, ' ') : '';
            return h('button', { class: 'wl-row', style: 'grid-template-columns:auto 1fr auto;width:100%;text-align:left', onclick: function () { openRunFile(f, w.name + ' · ' + (folder || 'its files')); } },
              icon('doc', 16),
              h('span', { class: 'stack', style: 'gap:2px;min-width:0' }, h('span', { class: 'wl-title', text: f.name.split('/').pop() }), folder ? h('span', { class: 'wl-sub', text: folder }) : null),
              h('span', { class: 'wl-meta', text: clock(f.at) + ' · ' + fileSize(f.bytes) }));
          })));
      });
    };
    q.oninput = draw;
    workerFiles(w.id).then(function (files) {
      all = files;
      box.textContent = '';
      append(box, [h('div', { class: 'row', style: 'justify-content:space-between' }, h('p', { class: 'muted', style: 'margin:0', text: 'What ' + w.name + ' has made, newest first. Open one to read it, or download it.' }), q), list]);
      draw();
    });
    return box;
  }

  /// A picture for a worker or a team: search about 1,600 of Microsoft's
  /// Fluent pictures by name (people by role, animals, things), or draw
  /// avatars, or link an image of your own. Saves as it's picked. Slack needs
  /// a public https image, which is why it's a link, not an upload.
  /// \x60who\x60: { id, name, avatarUrl }; \x60put(url|null)\x60 saves and returns the reply;
  /// \x60pick()\x60, when given, has one picked for it from its job.
  function picturePicker(who, put, pick) {
    var out = h('div', { 'aria-live': 'polite' });
    var now = h('div', { class: 'row', style: 'gap:12px' });
    var grid = h('div', { class: 'picgrid' });
    var kind = 'fluent';
    var save = function (url, b) {
      var restore = b ? busy(b, '…') : function () {};
      return put(url).then(function (x) {
        restore();
        if (x.ok === false) { out.replaceChildren(msg(x)); return; }
        who.avatarUrl = url || undefined;
        if (url) PICTURES[who.id] = url; else delete PICTURES[who.id];
        drawNow();
        [].forEach.call(grid.children, function (c) { if (c._url) c.setAttribute('aria-pressed', c._url === url ? 'true' : 'false'); });
        out.replaceChildren(msg(x, url ? 'Saved. Its Slack messages use it from now on.' : 'Back to initials.'));
      });
    };
    var drawNow = function () {
      // setChildren, not replaceChildren: that writes a null out as "null".
      setChildren(now, [avatar(who.id, who.name, 'xl'),
        h('span', { class: 'faint', text: who.avatarUrl ? 'Its picture now.' : 'Its initials, here and on its Slack messages.' }),
        who.avatarUrl ? h('button', { class: 'btn small', text: 'Use initials', title: 'Its initials here, and on an initials tile in Slack', onclick: function (e) { save(null, e.target); } }) : null].filter(Boolean));
      // Every other place on the page it's drawn: the header, its rows.
      [].forEach.call(document.querySelectorAll('[data-face="' + who.id + '"]'), function (el) {
        if (now.contains(el)) return;
        var size = (el.className.match(/\b(s|m|l|xl)\b/) || [])[1] || 'm';
        el.replaceWith(avatar(who.id, who.name, size));
      });
    };
    var q = h('input', { type: 'search', placeholder: 'Search pictures: owl, detective, rocket, scientist…', 'aria-label': 'Search pictures', style: 'max-width:360px' });
    var timer = null, asked = 0;
    // Fluent's people come in five skin tones besides the default yellow.
    var tone = '';
    var TONES = [['', '#f5c33b', 'Default'], ['Light', '#f7d7c4', 'Light'], ['Medium-Light', '#e2b590', 'Medium light'], ['Medium', '#c68e62', 'Medium'], ['Medium-Dark', '#8f5e3c', 'Medium dark'], ['Dark', '#5b3a29', 'Dark']];
    var tones = h('span', { class: 'row tones', role: 'group', 'aria-label': 'Skin tone for people' });
    var drawTones = function () {
      tones.replaceChildren.apply(tones, TONES.map(function (t) {
        return h('button', { type: 'button', class: 'tone', title: t[2], 'aria-label': t[2] + ' skin tone', 'aria-pressed': tone === t[0] ? 'true' : 'false', style: 'background:' + t[1], onclick: function () { tone = t[0]; kind = 'fluent'; drawTones(); load(); } });
      }));
    };
    var load = function () {
      var mine = ++asked;
      grid.replaceChildren(thinking(kind === 'drawn' ? 'Drawing some…' : 'Looking…'));
      api('GET', '/api/avatars?' + (kind === 'drawn' ? 'kind=drawn' : 'q=' + encodeURIComponent(q.value.trim()) + (tone ? '&tone=' + tone : ''))).then(function (x) {
        if (mine !== asked) return;
        if (x.ok === false) { grid.replaceChildren(msg(x)); return; }
        if (!x.choices.length) { grid.replaceChildren(h('p', { class: 'muted', style: 'margin:0;grid-column:1/-1', text: 'Nothing called that. Try one word: owl, robot, chart, judge.' })); return; }
        grid.replaceChildren.apply(grid, x.choices.map(function (c) {
          var b = h('button', { type: 'button', title: c.style, 'aria-pressed': c.url === who.avatarUrl ? 'true' : 'false', 'aria-label': 'Use ' + c.style.replace(/-/g, ' '), onclick: function () { save(c.url); } },
            h('img', { src: c.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }));
          b._url = c.url;
          return b;
        }));
      });
    };
    q.oninput = function () { kind = 'fluent'; clearTimeout(timer); timer = setTimeout(load, 250); };
    var drawn = h('button', { class: 'btn small', text: 'Drawn people', onclick: function () { kind = 'drawn'; q.value = ''; load(); } });
    var auto = pick ? h('button', { class: 'btn small', text: 'Pick one for me', title: 'Picks a picture that suits its job' }) : null;
    if (auto) auto.onclick = function () {
      var restore = busy(auto, 'Picking…');
      pick().then(function (x) {
        restore();
        if (x.ok === false) { out.replaceChildren(msg(x)); return; }
        who.avatarUrl = x.avatarUrl; PICTURES[who.id] = x.avatarUrl;
        drawNow();
        out.replaceChildren(msg(x, 'Picked one that suits its job. Not right? Press again, or search.'));
      });
    };
    var link = h('input', { type: 'url', placeholder: 'https://… a square PNG or JPG', 'aria-label': 'Link to a picture for ' + who.name, style: 'max-width:300px' });
    var useLink = h('button', { class: 'btn small', text: 'Use this link' });
    useLink.onclick = function () {
      var url = link.value.trim();
      if (!/^https:\/\/\S+$/.test(url)) { out.replaceChildren(h('div', { class: 'msg err', text: 'Use an https:// link to an image Slack can reach.' })); return; }
      save(url, useLink).then(function () { link.value = ''; });
    };
    drawNow(); drawTones(); load();
    return h('div', { class: 'stack', style: 'gap:12px' }, now,
      h('div', { class: 'row', style: 'gap:8px' }, q, tones, drawn, auto),
      grid,
      h('div', { class: 'row', style: 'gap:8px' }, link, useLink),
      h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Pictures: Fluent Emoji, © Microsoft, MIT licence. Drawn avatars: DiceBear, from random seeds. No names are sent.' }),
      out);
  }

  /// Its journal: the notes it keeps (standing instructions, from people and
  /// from itself, read by every turn it plans), then what it did, newest
  /// first. Managers add a note or take one back.
  var JOURNAL_KIND = { shift: 'Checked in', proposed: 'Proposed', launched: 'Started', approved: 'You approved', rejected: 'Turned down', completed: 'Finished', failed: 'Failed', errand: 'Asked', delegated: 'Handed on', demoted: 'Trust lowered', compacted: 'Tidied up' };
  function journalView(w) {
    var box = h('div', { class: 'stack', style: 'gap:16px' }, thinking('Loading its journal…'));
    var notesBox = h('div', { class: 'stack', style: 'gap:0' });
    var list = h('div', { class: 'stack', style: 'gap:14px' });
    var more = h('div');
    var out = h('div', { 'aria-live': 'polite' });
    var entries = [];
    var drawNotes = function (x) {
      notesBox.replaceChildren.apply(notesBox, x.notes.length ? x.notes.map(function (n) {
        var forget = x.canChange ? h('button', { class: 'btn small', text: 'Remove', onclick: function () {
          var restore = busy(forget, 'Removing…');
          api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/journal/forget', { entryId: n.id }).then(function (r) { restore(); if (r.ok === false) { out.replaceChildren(msg(r)); return; } load(); });
        } }) : null;
        return h('div', { class: 'wl-row', style: 'grid-template-columns:1fr auto auto;align-items:center' },
          h('span', { class: 'wl-title', style: 'white-space:normal', text: n.note }), h('span', { class: 'wl-meta', text: when(n.at) }), forget);
      }) : [h('p', { class: 'muted', style: 'margin:0;padding:12px 16px', text: 'No notes yet. When you tell ' + w.name + ' to change how it works, from here or in a conversation, the note lands here and every turn it plans reads it.' })]);
    };
    var drawEntries = function () {
      list.textContent = '';
      if (!entries.length) { list.appendChild(h('p', { class: 'muted', text: 'Nothing yet. Its check-ins, questions and runs land here.' })); return; }
      var days = [];
      entries.forEach(function (e) {
        var day = dayLabel(e.at);
        var last = days[days.length - 1];
        if (!last || last.day !== day) days.push(last = { day: day, items: [] });
        last.items.push(e);
      });
      days.forEach(function (d) {
        list.appendChild(h('section', { class: 'panel', 'aria-label': d.day }, h('div', { class: 'wl-day', text: d.day }),
          d.items.map(function (e) {
            var bad = e.kind === 'failed' || e.kind === 'rejected' || e.kind === 'demoted';
            return h('div', { class: 'wl-row', style: 'grid-template-columns:120px 1fr auto;align-items:start' },
              h('span', { class: 'badge' + (bad ? ' bad' : e.kind === 'completed' ? ' ok' : ''), style: 'justify-self:start', text: JOURNAL_KIND[e.kind] || e.kind }),
              h('span', { class: 'stack', style: 'gap:2px;min-width:0' },
                e.title ? h('span', { class: 'wl-title', style: 'white-space:normal', text: e.title }) : null,
                e.note ? h('span', { class: 'wl-sub', style: 'white-space:normal', text: e.note }) : null),
              h('span', { class: 'wl-meta', text: clock(e.at) + (e.costUSD ? ' · ' + money(e.costUSD) : '') }));
          })));
      });
    };
    var page = function (before) {
      return api('GET', '/api/workers/' + encodeURIComponent(w.id) + '/journal' + (before ? '?before=' + before : ''));
    };
    var showMore = function (x) {
      more.replaceChildren(x.nextBefore ? h('div', { style: 'text-align:center' }, h('button', { class: 'btn small', text: 'Show older', onclick: function (ev) {
        var restore = busy(ev.target, 'Loading…');
        page(x.nextBefore).then(function (y) { restore(); if (y.ok === false) return; entries = entries.concat(y.entries); drawEntries(); showMore(y); });
      } })) : null);
    };
    var load = function () {
      page().then(function (x) {
        if (x.ok === false) { box.replaceChildren(msg(x)); return; }
        entries = x.entries;
        drawNotes(x); drawEntries(); showMore(x);
        if (box.querySelector('.journal-notes')) return;
        var input = h('input', { placeholder: 'A standing note for ' + w.name + ', e.g. “Also cover Introw in the weekly check”', 'aria-label': 'Note for ' + w.name, maxlength: '600' });
        var add = h('button', { class: 'btn go small', text: 'Add note' });
        add.onclick = function () {
          if (!input.value.trim()) { input.focus(); return; }
          var restore = busy(add, 'Adding…');
          api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/journal', { note: input.value }).then(function (r) { restore(); out.replaceChildren(msg(r, 'Noted. Its next turn reads it.')); if (r.ok !== false) { input.value = ''; load(); } });
        };
        input.onkeydown = function (e) { if (e.key === 'Enter') add.click(); };
        box.replaceChildren(
          h('section', { class: 'panel journal-notes', 'aria-labelledby': 'jnotes' },
            h('div', { class: 'sec-head' }, h('h2', { id: 'jnotes', class: 'label', text: 'Notes it keeps' }), h('span', { class: 'faint', style: 'font-size:12.5px', text: 'Read by every turn it plans' })),
            notesBox,
            x.canChange ? h('div', { class: 'inline-form', style: 'padding:12px 16px;border-top:1px solid var(--line)' }, input, add) : null,
            h('div', { style: 'padding:0 16px' }, out)),
          h('div', { class: 't-kind', text: 'What it did' }),
          list, more);
      });
    };
    load();
    return box;
  }

  function openRunFile(f, sub) {
    openReader(f.name.split('/').pop(), sub, function (put) { fileView(f).then(put); },
      'file/' + f.url.split('/')[2] + '/' + encodeURIComponent(f.name));
  }

  /// A run file, shown as what it is: an HTML report in a sandboxed frame
  /// (served on its own origin, so its scripts never see this page), an
  /// image as itself, Markdown rendered, other text as text.
  function fileView(f, tall) {
    var base = f.name.split('/').pop();
    var html = /\.html?$/i.test(base);
    var actions = h('div', { class: 'row', style: 'gap:6px;margin-bottom:12px' },
      h('a', { class: 'btn small', href: f.url + '?download=1', download: base, text: 'Download' }),
      html ? h('a', { class: 'btn small', href: f.url, target: '_blank', rel: 'noopener', text: 'Open in a new tab ↗' }) : null,
      f.bytes ? h('span', { class: 'faint', text: fileSize(f.bytes) }) : null);
    if (html) return Promise.resolve([actions, h('iframe', { class: 'file-frame' + (tall ? ' tall' : ''), src: f.url, sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', title: base })]);
    if (/\.(png|jpe?g|gif|webp)$/i.test(base)) return Promise.resolve([actions, h('img', { src: f.url, alt: base, style: 'max-width:100%;border-radius:8px' })]);
    if (!TEXT_FILE.test(base)) return Promise.resolve([actions, h('p', { class: 'muted', text: 'This kind of file opens on your computer. Download it to see it.' })]);
    return fetch(f.url).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) return [h('div', { class: 'msg err', text: text })];
        return [actions, /\.(md|markdown)$/i.test(base) ? md(text) : h('pre', { class: 'wc-out', text: text })];
      });
    }, function () { return [h('div', { class: 'msg err', text: 'Could not load the file.' })]; });
  }

  function openReader(title, sub, load, popHash) {
    var prev = document.getElementById('reader');
    if (prev) prev.remove();
    var body = h('div', { class: 'reader-body' }, thinking('Loading…'));
    var close = function () { wrap.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    var shut = h('button', { class: 'btn small', 'aria-label': 'Close', text: 'Close', onclick: close });
    // Wider, for a long report or a wide table; remembered for next time.
    var wide = read('overcli-reader-wide') === '1';
    var panel = h('aside', { class: 'reader' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    var grow = h('button', { class: 'btn small', 'aria-pressed': wide ? 'true' : 'false', text: wide ? 'Narrow' : 'Expand' });
    grow.onclick = function () {
      wide = !wide; panel.classList.toggle('wide', wide);
      grow.textContent = wide ? 'Narrow' : 'Expand'; grow.setAttribute('aria-pressed', wide ? 'true' : 'false');
      store('overcli-reader-wide', wide ? '1' : null);
    };
    // Its own page, in a new tab: to read side by side, or keep open.
    var pop = popHash ? h('a', { class: 'btn small', href: '#' + popHash, target: '_blank', rel: 'noopener', text: 'Pop out ↗' }) : null;
    append(panel, [h('div', { class: 'reader-head' }, h('div', { class: 'stack', style: 'gap:2px;min-width:0' }, h('b', { style: 'font-size:16px', text: title }), sub ? h('span', { class: 'faint', text: sub }) : null),
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, grow, pop, shut)),
      body]);
    var wrap = h('div', { id: 'reader', class: 'reader-wrap' }, h('div', { class: 'reader-back', onclick: close }), panel);
    document.body.appendChild(wrap);
    document.addEventListener('keydown', onKey);
    shut.focus();
    load(function (nodes) { body.textContent = ''; append(body, nodes); });
  }

  /// The first thing a report says, for the card: past headings and rules.
  function previewOf(text) {
    var line = String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l && !/^(#|\||-{3,}|\*{3,})/.test(l) && !/:\**$/.test(l); })[0] || '';
    line = line.replace(/\*\*|__|\x60/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[-*+]\s+/, '');
    return line.length > 240 ? line.slice(0, 239) + '…' : line;
  }

  // ---- reports ---------------------------------------------------------

  // The desktop app's crew report (WorkerReportPane), for the workers you can
  // see: what they delivered, what it cost, and where the time went. Money
  // leads the table because "what did this cost me" is why the page is open.
  function workedTime(ms) {
    var mins = Math.round((ms || 0) / 60000);
    if (mins <= 0) return '—';
    return mins < 60 ? mins + 'm' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  }
  function tokens(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0); }
  function cents(n) { return '$' + (n || 0).toFixed(2); }
  function perJob(r) { return r.itemsDone > 0 ? r.costUSD / r.itemsDone : null; }
  function shortDay(key) {
    var p = key.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // One measure per chart, each on its own axis: jobs, dollars, hours and
  // tokens are four units, and no two belong on one scale. Hues match the
  // desktop report's.
  var METRICS = [
    { key: 'itemsDone', label: 'Jobs finished', tint: '#5d72ff', fmt: String },
    { key: 'costUSD', label: 'Spend', tint: '#d97706', fmt: cents },
    { key: 'workedMs', label: 'Agent time', tint: '#059669', fmt: workedTime },
    { key: 'tokens', label: 'Tokens', tint: '#a855f7', fmt: tokens }
  ];

  function dayChart(m, daily) {
    var total = daily.reduce(function (n, d) { return n + (d[m.key] || 0); }, 0);
    var max = Math.max.apply(null, daily.map(function (d) { return d[m.key] || 0; }).concat([0]));
    var bars = h('div', { class: 'dbars', role: 'img', 'aria-label': m.label + ' by day, ' + m.fmt(total) + ' in total' });
    bars.style.setProperty('--bar', m.tint);
    daily.forEach(function (d) {
      var v = d[m.key] || 0;
      bars.appendChild(h('i', { class: v ? '' : 'zero', title: shortDay(d.day) + ': ' + m.fmt(v), style: 'height:' + (max ? Math.max(4, (v / max) * 100) : 0).toFixed(1) + '%' }));
    });
    if (!total) bars.appendChild(h('span', { class: 'none', text: 'None in this window' }));
    return h('div', { class: 'mchart' },
      h('div', { class: 'k' }, h('span', { text: m.label }), total ? h('span', { text: 'peak ' + m.fmt(max) + ' a day' }) : null),
      h('div', { class: 'v', text: m.fmt(total) }),
      bars,
      daily.length ? h('div', { class: 'axis' }, h('span', { text: shortDay(daily[0].day) }), h('span', { text: shortDay(daily[daily.length - 1].day) })) : null);
  }

  function reportCsv(rows) {
    var cols = ['Worker', 'Jobs finished', 'Jobs failed', 'Shifts', 'Quiet shifts', 'Failed shifts', 'Agent minutes', 'Tokens', 'Spend USD', 'Spend per job USD'];
    var esc = function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return [cols].concat(rows.map(function (r) {
      var pj = perJob(r);
      return [r.name, r.itemsDone, r.itemsFailed, r.shifts, r.quietShifts, r.failedShifts, Math.round(r.workedMs / 60000), r.inputTokens + r.outputTokens, r.costUSD.toFixed(2), pj == null ? '' : pj.toFixed(2)];
    })).map(function (row) { return row.map(esc).join(','); }).join('\n');
  }

  function viewReports() {
    var days = state.reportDays == null ? 30 : state.reportDays;
    return api('GET', '/api/report?days=' + days).then(function (r) {
      var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Window' }, [[7, '7 days'], [30, '30 days'], [0, 'All time']].map(function (o) {
        return h('button', { 'aria-pressed': days === o[0] ? 'true' : 'false', text: o[1], onclick: function () { state.reportDays = o[0]; render(); } });
      }));
      var sub = 'What your workers delivered, what it cost, and where the time went.';
      if (r.ok === false) return [head('Reports', sub, seg, 'Workspace'), emptyState('No report yet.', r.error)];
      var rep = r.report || r;
      var t = rep.totals;
      var multiplier = r.savedMultiplier || 1.5;
      if (!rep.byWorker.length) return [head('Reports', sub, seg, 'Workspace'), emptyState('Nobody to report on yet.', 'Hire a worker and this fills in after its first shift.', hireButton())];
      if (!t.shifts && !t.runs) return [head('Reports', sub, seg, 'Workspace'), emptyState('Nothing in this window.', 'No shifts ran. Try a longer range.')];

      var sortKey = state.reportSort || 'cost';
      var SORT = {
        cost: function (x) { return x.costUSD; },
        perJob: function (x) { var p = perJob(x); return p == null ? -1 : p; },
        done: function (x) { return x.itemsDone; },
        shifts: function (x) { return x.shifts; },
        time: function (x) { return x.workedMs; },
        tokens: function (x) { return x.inputTokens + x.outputTokens; }
      };
      var rows = rep.byWorker.slice().sort(function (a, b) { return SORT[sortKey](b) - SORT[sortKey](a) || a.name.localeCompare(b.name); });
      // The roster's own median rate flags the expensive worker, not a
      // threshold picked from outside it.
      var rates = rows.map(perJob).filter(function (x) { return x != null; }).sort(function (a, b) { return a - b; });
      var median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
      var dear = median > 0 ? median * 2 : Infinity;

      var savedMin = (t.workedMs / 60000) * multiplier;
      var econ = function (k, v) { return h('div', null, h('span', { class: 'muted', text: k }), h('b', { text: v })); };
      var th = function (key, label, right) {
        return h('th', { class: right ? 'r' : null, 'aria-sort': sortKey === key ? 'descending' : null },
          key ? h('button', { 'aria-pressed': sortKey === key ? 'true' : 'false', text: label + (sortKey === key ? ' ↓' : ''), onclick: function () { state.reportSort = key; render(); } }) : label);
      };
      var exportBtn = h('button', { class: 'btn small', onclick: function () {
        var a = h('a', { href: URL.createObjectURL(new Blob([reportCsv(rows)], { type: 'text/csv' })), download: 'worker-report-' + (days || 'all') + 'd.csv' });
        document.body.appendChild(a); a.click(); a.remove();
      } }, 'Export CSV');

      return [head('Reports', sub, h('div', { class: 'page-actions' }, seg, exportBtn), 'Workspace'),
        h('div', { class: 'lede' },
          card('wc', 'Work completed', null, [
            h('div', { class: 'big', text: plural(t.itemsDone, 'finished job', 'finished jobs') }),
            h('p', { class: 'muted', style: 'font-size:13px', text: plural(t.shifts, 'shift', 'shifts') + ' run, ' + t.quietShifts + ' of them quiet checks that found nothing to do. Quiet is a success, not idle time.' }),
            h('div', { class: 'econ' },
              econ('Agent time', workedTime(t.workedMs)),
              econ('Recorded spend', cents(t.costUSD)),
              econ('Tokens', tokens(t.inputTokens + t.outputTokens)),
              t.rejected ? econ('Proposals you turned down', String(t.rejected)) : null,
              t.skippedShifts ? econ('Shifts that never ran', String(t.skippedShifts)) : null)]),
          card('ev', 'Estimated value', null, [
            h('div', { class: 'big', text: savedMin >= 1 ? '≈' + workedTime(savedMin * 60000) + ' saved' : 'Nothing measured yet' }),
            h('p', { class: 'muted', style: 'font-size:13px', text: 'Estimated at ' + multiplier + '× measured agent time: one active agent hour stands in for about ' + multiplier + ' hours of a person’s.' }),
            h('div', { class: 'econ' },
              econ('Spend per finished job', t.itemsDone ? cents(t.costUSD / t.itemsDone) : '—'),
              econ('Spend per agent hour', t.workedMs ? cents(t.costUSD / (t.workedMs / 3600000)) : '—'),
              econ('Spend per hour saved', savedMin ? cents(t.costUSD / (savedMin / 60)) : '—'))])),
        h('div', { class: 'charts' }, METRICS.map(function (m) { return dayChart(m, rep.daily || []); })),
        h('section', { class: 'tcard', 'aria-label': 'By worker' },
          h('div', { class: 'sec-head' }, h('h2', { class: 'label', text: 'By worker' }), h('span', { class: 'faint', text: 'Click a column to sort' })),
          h('div', { class: 'tscroll' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, th(null, 'Worker'), th('done', 'Jobs', true), th('shifts', 'Shifts', true), th('time', 'Agent time', true), th('tokens', 'Tokens', true), th('cost', 'Spend', true), th('perJob', 'Per job', true), th(null, 'Last shift', true))),
            h('tbody', null, rows.map(function (x) {
              var pj = perJob(x);
              var split = [x.quietShifts && x.quietShifts + ' quiet', x.workingShifts && x.workingShifts + ' spawned work', x.failedShifts && x.failedShifts + ' failed'].filter(Boolean).join(' · ');
              return h('tr', { class: 'link', tabindex: '0', onclick: function () { openWorker(x.workerId); }, onkeydown: function (e) { if (e.key === 'Enter') openWorker(x.workerId); } },
                h('td', null, h('div', { class: 'who' }, avatar(x.workerId, x.name, 's'), h('div', { style: 'min-width:0' }, h('b', { text: x.name }), h('span', { class: 'sub', text: (x.manager ? x.manager + ' · ' : '') + (x.enabled ? '' : 'Paused · ') + (split || 'No shifts') })))),
                h('td', { class: 'r', text: String(x.itemsDone) + (x.itemsFailed ? ' (' + x.itemsFailed + ' failed)' : '') }),
                h('td', { class: 'r', text: String(x.shifts) }),
                h('td', { class: 'r', text: workedTime(x.workedMs) }),
                h('td', { class: 'r', text: tokens(x.inputTokens + x.outputTokens) }),
                h('td', { class: 'r', text: cents(x.costUSD) }),
                h('td', { class: 'r' + (pj != null && pj > dear ? ' dear' : ''), title: pj != null && pj > dear ? 'More than twice the roster’s median cost per job' : null, text: pj == null ? '—' : cents(pj) }),
                h('td', { class: 'r muted', text: x.lastShiftAt ? ago(x.lastShiftAt) : '—' }));
            })),
            h('tfoot', null, h('tr', null,
              h('td', { text: 'All workers' }), h('td', { class: 'r', text: String(t.itemsDone) }), h('td', { class: 'r', text: String(t.shifts) }),
              h('td', { class: 'r', text: workedTime(t.workedMs) }), h('td', { class: 'r', text: tokens(t.inputTokens + t.outputTokens) }), h('td', { class: 'r', text: cents(t.costUSD) }),
              h('td', { class: 'r', text: t.itemsDone ? cents(t.costUSD / t.itemsDone) : '—' }), h('td')))))),
        h('p', { class: 'faint', text: 'Spend is each run’s model cost as its backend reports it; backends that don’t report a price count as $0, and planning and chat turns aren’t included. Only workers you can see are counted.' })];
    });
  }

  /// One Library item on a page of its own: what Pop out opens.
  function viewRead() {
    var id = state.readId;
    return api('GET', '/api/library/' + encodeURIComponent(id)).then(function (r) {
      if (r.ok === false) return [msg(r)];
      var x = r.item;
      return [h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Library', onclick: function () { go('library'); } }), ' / ' + x.workerName),
            h('h1', { class: 'page-title', style: 'font-size:26px', text: x.title }),
            h('p', { class: 'page-sub', text: [x.workerName, ago(x.at)].join(' · ') }))),
        h('article', { class: 'panel pad read-page' }, x.runId ? runFiles(x.runId, [x.workerName, x.title].join(' · ')) : null, x.body ? md(x.body) : h('p', { class: 'muted', text: 'Nothing written.' }))];
    });
  }

  /// One run file on a page of its own: what Pop out opens.
  function viewFile() {
    var base = state.fileName.split('/').pop() || 'file';
    var f = { url: '/files/' + state.fileLink + '/' + encodeURIComponent(base), name: state.fileName || base };
    return fileView(f, true).then(function (nodes) {
      return [h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Library', onclick: function () { go('library'); } }), ' / a file a worker made'),
            h('h1', { class: 'page-title', style: 'font-size:26px', text: base }))),
        h('article', { class: 'panel pad read-page' }, nodes)];
    });
  }

  // Search words, shown where they were found: a piece of text with each
  // word wrapped in <mark>, built as nodes so nothing found can run.
  function marked(text, words, el) {
    el = el || h('span');
    if (!words.length) { el.textContent = text; return el; }
    var re = new RegExp('(' + words.map(function (w) { return w.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'ig');
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      el.appendChild(h('mark', { text: m[0] }));
      last = re.lastIndex;
      if (!m[0].length) re.lastIndex++;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
    return el;
  }
  /// The stretch of a long text around its first match, cut at word edges.
  function snippetOf(text, words, span) {
    var flat = String(text || '').replace(/[#*_\x60>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    var low = flat.toLowerCase(), at = -1;
    words.forEach(function (w) { var i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; });
    if (at < 0) return null;
    var start = Math.max(0, at - (span || 70)), end = Math.min(flat.length, at + (span || 70) * 2);
    while (start > 0 && flat[start] !== ' ') start--;
    while (end < flat.length && flat[end] !== ' ') end++;
    return (start > 0 ? '…' : '') + flat.slice(start, end).trim() + (end < flat.length ? '…' : '');
  }
  /// Mark every match inside a rendered page, and say how many there were.
  function markIn(root, words) {
    if (!words.length) return [];
    var re = new RegExp(words.map(function (w) { return w.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&'); }).join('|'), 'ig');
    var walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentNode && /^(SCRIPT|STYLE|MARK)$/.test(n.parentNode.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } });
    var hits = [], nodes = [];
    while (walk.nextNode()) nodes.push(walk.currentNode);
    nodes.forEach(function (n) {
      re.lastIndex = 0;
      if (!re.test(n.nodeValue)) return;
      var frag = marked(n.nodeValue, words, document.createDocumentFragment());
      [].slice.call(frag.querySelectorAll ? frag.querySelectorAll('mark') : []).forEach(function (m) { hits.push(m); });
      n.parentNode.replaceChild(frag, n);
    });
    return hits;
  }

  // An HTML file kept in the Library is a page, not text: read its title and
  // the words a person would see, never its markup. DOMParser builds an inert
  // document (no scripts run, nothing loads), so this is safe for any file.
  var pageCache = {};
  function isPage(x) { return /^\s*(<!doctype html|<html[\s>])/i.test(x.body || '') || /\.html?$/i.test((x.source && x.source.file) || x.title || ''); }
  function pageOf(x) {
    if (!isPage(x) || !x.body) return null;
    if (pageCache[x.id]) return pageCache[x.id];
    var doc = new DOMParser().parseFromString(x.body, 'text/html');
    [].slice.call(doc.querySelectorAll('script,style,noscript,template,svg')).forEach(function (n) { n.remove(); });
    // Blocks end in a space, so a heading and the paragraph after it don't run together.
    [].slice.call(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,dt,dd,div,section,article,header,footer,td,th,tr,br,blockquote,pre')).forEach(function (n) { n.appendChild(doc.createTextNode(' ')); });
    var heading = doc.querySelector('h1');
    var title = ((doc.title || (heading && heading.textContent) || '') + '').replace(/\s+/g, ' ').trim();
    var text = ((doc.body && doc.body.textContent) || '').replace(/\s+/g, ' ').trim();
    return (pageCache[x.id] = { title: title, text: text });
  }
  /// The words of an item to show and search: a page's visible text, else its body.
  function wordsOf(x) { var pg = pageOf(x); return pg ? pg.text : x.body || ''; }
  /// What to call an item: a kept page by its own title, not its file name.
  function nameOf(x) { var pg = x.kind === 'file' ? pageOf(x) : null; return pg && pg.title ? pg.title : x.title; }

  // What kind of thing a Library item is, and where it came from, worked out
  // from the server's origin when it sends one and from older fields if not.
  function libOrigin(x) {
    if (x.origin) return x.origin;
    var src = x.source || {};
    if (x.kind === 'file' && src.kind === 'team') return { kind: 'task', teamId: src.teamId, teamName: src.teamName, taskId: src.taskId, taskTitle: src.teamName };
    if (x.kind === 'event') return { kind: 'event', triggerName: src.triggerName || SOURCE[src.kind] || 'An event', workerName: x.workerName };
    return { kind: 'run', runId: x.runId, workerName: x.workerName, how: 'other' };
  }
  // Each kind as an icon in its own colour; its name is in the row's label.
  var LIB_KIND = { task: ['team', 'go', 'Team task'], work: ['doc', 'info', 'Report'], event: ['bolt', 'violet', 'Trigger'], file: ['library', 'need', 'Kept file'], answer: ['slack', 'ok', 'Answer'] };
  var RUN_HOW = { schedule: 'On its schedule', runNow: 'Run now', trigger: 'Set off by a trigger', asked: 'Started by a question', other: 'A run' };
  // Private is the default, so it reads quietly; wider sharing gets colour.
  var LIB_VIS = { 'private': ['Only its manager', ''], team: ['Its team', 'working'], org: ['Everyone', 'ok'] };
  function libSource(x) {
    var o = libOrigin(x);
    if (o.kind === 'task') return ['Team task', o.teamName + (o.taskTitle && o.taskTitle !== o.teamName && x.kind !== 'task' ? ' · ' + o.taskTitle : ''), x.kind === 'file' ? ((x.source && x.source.file) || x.title).split('/').pop() + (o.stage ? ' · stage ' + o.stage.index + ', ' + o.stage.title : '') : o.stage ? '› ' + o.stage.index + '. ' + o.stage.title : x.kind === 'task' ? (x.pack ? plural(x.pack.files.length, 'deliverable', 'deliverables') : '') : ''];
    if (o.kind === 'errand') return ['Errand', (o.askedBy && o.askedBy !== (state.me && state.me.name) ? o.askedBy : 'You') + ' asked ' + o.workerName, o.via ? 'in ' + ({ console: 'the console', slack: 'Slack', mcp: 'Claude', app: 'the app' }[o.via] || o.via) : ''];
    if (o.kind === 'event') return ['Trigger', o.triggerName || 'An event', o.workerName ? 'for ' + o.workerName : ''];
    return ['Run', o.workerName + (o.flowName ? ' · ' + o.flowName : ''), o.how === 'trigger' && o.triggerName ? 'set off by “' + o.triggerName + '”' : RUN_HOW[o.how] || ''];
  }

  /// The Library: finished work, newest first, each row saying what it is,
  /// where it came from and who can see it. A row opens in place on what it
  /// delivered; a team task shows its final pack, its working files a click on.
  function viewLibrary() {
    // The newest LIB_MAX come down at once and are filtered here. Past that,
    // a search asks the server, which looks through everything.
    var LIB_MAX = 500, LIB_PAGE = 50;
    return Promise.all([api('GET', '/api/library?limit=' + LIB_MAX), api('GET', '/api/workers'), api('GET', '/api/teams').catch(function () { return []; })]).then(function (r) {
      var newest = Array.isArray(r[0]) ? r[0] : r[0].items || [], workers = r[1], teams = Array.isArray(r[2]) ? r[2] : [];
      var all = newest, more = newest.length >= LIB_MAX, asked = '', askTimer = null;
      var tab = state.libTab || 'all';
      var opened = {};
      var showing = LIB_PAGE;
      var from = h('select', { 'aria-label': 'From' }, h('option', { value: '', text: 'Every worker and team' }),
        workers.map(function (w) { return h('option', { value: 'w:' + w.id, text: w.name }); }),
        teams.map(function (t) { return h('option', { value: 't:' + t.id, text: t.name + ' (team)' }); }));
      var seen = h('select', { 'aria-label': 'Who can see' }, h('option', { value: '', text: 'Anyone who can see it' }),
        Object.keys(LIB_VIS).map(function (k) { return h('option', { value: k, text: LIB_VIS[k][0] }); }));
      var q = h('input', { type: 'search', placeholder: 'Search everything delivered', 'aria-label': 'Search the Library' });
      var body = h('div', { class: 'librows' });
      var foot = h('div', { class: 'tfoot' });
      var TABS = [['all', 'Everything', function () { return true; }], ['task', 'Team tasks', function (x) { return x.kind === 'task'; }],
        ['report', 'Reports', function (x) { return x.kind === 'work' || x.kind === 'event'; }], ['file', 'Kept files', function (x) { return x.kind === 'file'; }],
        ['answer', 'Answers', function (x) { return x.kind === 'answer'; }]];
      var tabsEl = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show' });
      var searchWords = function () { return q.value.trim().toLowerCase().split(/\s+/).filter(function (w) { return w.length > 1; }); };
      var draw = function () {
        var words = searchWords();
        if (more) {
          var text = words.join(' ');
          if (text !== asked) {
            asked = text;
            clearTimeout(askTimer);
            if (!text) all = newest;
            else askTimer = setTimeout(function () {
              api('GET', '/api/library?limit=' + LIB_MAX + '&q=' + encodeURIComponent(text)).then(function (y) { if (asked === text && Array.isArray(y)) { all = y; draw(); } });
            }, 300);
          }
        }
        var fit = TABS.filter(function (t) { return t[0] === tab; })[0][2];
        var match = function (x) {
          var o = libOrigin(x);
          if (from.value) {
            var id = from.value.slice(2);
            if (from.value[0] === 'w' && x.workerId !== id) return false;
            if (from.value[0] === 't' && o.teamId !== id) return false;
          }
          if (seen.value && (x.visibility || 'private') !== seen.value) return false;
          return words.every(function (w) { return (nameOf(x) + ' ' + x.title + ' ' + x.workerName + ' ' + wordsOf(x) + ' ' + libSource(x).join(' ')).toLowerCase().indexOf(w) >= 0; });
        };
        var pool = all.filter(match);
        tabsEl.replaceChildren.apply(tabsEl, TABS.map(function (t) {
          return h('button', { 'aria-pressed': tab === t[0] ? 'true' : 'false', onclick: function () { tab = t[0]; state.libTab = tab; showing = LIB_PAGE; draw(); } }, t[1], h('span', { class: 'c', text: String(pool.filter(t[2]).length) }));
        }));
        var shown = pool.filter(fit);
        var page = shown.slice(0, showing);
        body.replaceChildren.apply(body, shown.length ? page.map(libRow).concat(shown.length > page.length ? [h('div', { class: 'libmore' }, h('button', { class: 'btn small', text: 'Show ' + Math.min(LIB_PAGE, shown.length - page.length) + ' more', onclick: function () { showing += LIB_PAGE; draw(); } }))] : []) : [h('div', { class: 'empty' }, h('div', { class: 'quote', text: all.length ? 'Nothing matches.' : 'Nothing delivered yet.' }),
          h('p', { text: all.length ? 'Try other words, another tab, or every worker.' : 'What workers and teams finish lands here, with where it came from and who can see it.' }))]);
        foot.replaceChildren(h('span', { text: 'Showing ' + page.length + ' of ' + shown.length + (more && !words.length ? ' · the newest ' + LIB_MAX + '; search to find older work' : '') }), h('span', { text: 'A team task’s working files stay in its folder.' }));
      };
      var libRow = function (x) {
        var k = LIB_KIND[x.kind] || ['doc', '', 'Item'];
        var src = libSource(x);
        var vis = LIB_VIS[x.visibility || 'private'];
        var words = searchWords();
        var name = nameOf(x);
        var inTitle = words.some(function (w) { return name.toLowerCase().indexOf(w) >= 0; });
        var snip = words.length ? snippetOf(wordsOf(x), words) : null;
        var where = !words.length ? null : snip ? 'In what it delivered' : inTitle ? null : 'In where it came from';
        var detail = h('div', { class: 'libopen', hidden: !opened[x.id] });
        var row = h('button', { class: 'librow', 'aria-expanded': opened[x.id] ? 'true' : 'false', onclick: function () {
          opened[x.id] = !opened[x.id];
          detail.hidden = !opened[x.id];
          row.setAttribute('aria-expanded', opened[x.id] ? 'true' : 'false');
          if (opened[x.id] && !detail.firstChild) detail.appendChild(libDetail(x));
        } },
          h('span', { class: 'kpi-ic libkind ' + k[1], title: k[2], 'aria-label': k[2] }, icon(k[0], 17)),
          h('span', { class: 'libmain' },
            marked(name, words, h('span', { class: 'libtitle' })),
            h('span', { class: 'libsrc' }, h('span', { class: 'libtag ' + k[1], text: src[0] }), marked(src[1], words, h('b')), src[2] ? marked('· ' + src[2], words, h('span')) : null),
            snip ? h('span', { class: 'libsnip' }, h('span', { class: 'libwhere', text: where }), marked(snip, words, h('span'))) : where ? h('span', { class: 'libsnip' }, h('span', { class: 'libwhere', text: where })) : null),
          h('span', { class: 'libfrom' }, avatar(x.workerId, x.workerName, 's'), h('span', { text: x.kind === 'task' || x.kind === 'file' ? (libOrigin(x).teamName || x.workerName) : x.workerName })),
          h('span', { class: 'badge ' + vis[1], title: x.visibleTo || '', text: vis[0] }),
          h('span', { class: 'faint libwhen', text: ago(x.at) }),
          h('span', { class: 'librate' + (x.rating ? x.rating.useful ? ' yes' : ' no' : ''), text: x.status === 'failed' ? 'Failed' : x.rating ? (x.rating.useful ? 'Useful' : 'Not useful') : '' }));
        if (opened[x.id]) detail.appendChild(libDetail(x));
        return h('div', null, row, detail);
      };
      var libDetail = function (x) {
        var o = libOrigin(x);
        var out = h('div', { 'aria-live': 'polite' });
        var reader = function () {
          var words = searchWords();
          openReader(x.title, libSource(x).filter(Boolean).join(' · '), function (put) {
            var show = function (text, extra) {
              var doc = text ? md(text) : h('p', { class: 'muted', text: 'Nothing written.' });
              var hits = markIn(doc, words), at = 0;
              var go_ = function (d) {
                if (!hits.length) return;
                hits[at].classList.remove('on'); at = (at + d + hits.length) % hits.length; hits[at].classList.add('on');
                hits[at].scrollIntoView({ behavior: 'smooth', block: 'center' }); count.textContent = (at + 1) + ' of ' + hits.length;
              };
              var count = h('span', { text: hits.length ? '1 of ' + hits.length : '' });
              var bar = words.length ? h('div', { class: 'findbar' }, icon('search', 14), h('span', { text: '“' + words.join(' ') + '”' }),
                hits.length ? [count, h('button', { class: 'btn small icon', 'aria-label': 'Previous match', onclick: function () { go_(-1); } }, '↑'), h('button', { class: 'btn small icon', 'aria-label': 'Next match', onclick: function () { go_(1); } }, '↓')]
                  : h('span', { class: 'faint', text: 'Not in this text; it matched ' + (x.title.toLowerCase().indexOf(words[0]) >= 0 ? 'the title' : 'where it came from') + '.' })) : null;
              put([bar].concat(extra || [], [doc]));
              if (hits.length) setTimeout(function () { hits[0].classList.add('on'); hits[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 60);
            };
            api('GET', '/api/library/' + encodeURIComponent(x.id)).then(function (y) {
              var it = y.ok === false ? x : y.item;
              show(it.body, [y.ok === false ? msg(y) : null, x.runId ? runFiles(x.runId, [x.workerName, x.title].join(' · ')) : null]);
            }, function () { show(x.body); });
          }, 'read/' + encodeURIComponent(x.id));
        };
        var rate = x.kind === 'answer' || x.kind === 'task' || x.status !== 'delivered' ? null : h('span', { class: 'row', style: 'gap:6px;margin-left:auto' }, h('span', { class: 'faint', text: 'Useful?' }),
          [true, false].map(function (useful) {
            return h('button', { class: 'btn small icon', 'aria-label': useful ? 'Useful' : 'Not useful', 'aria-pressed': x.rating && x.rating.useful === useful ? 'true' : 'false', onclick: function () {
              var path = x.kind === 'event' ? '/api/library/' + encodeURIComponent(x.id) + '/rate' : '/api/rate';
              api('POST', path, x.kind === 'event' ? { useful: useful } : { entryId: x.id, useful: useful }).then(function (y) {
                out.replaceChildren(msg(y, useful ? 'Marked useful. It leans that way next time.' : 'Noted.'));
                if (y.ok !== false) { x.rating = { useful: useful, by: state.me.name }; draw(); }
              });
            } }, icon(useful ? 'up' : 'down', 15));
          }));
        var preview = isPage(x) ? (pageOf(x) || { text: '' }).text.slice(0, 280) + ((pageOf(x) || { text: '' }).text.length > 280 ? '…' : '') : x.body ? previewOf(x.body) : '';
        var parts = [];
        if (x.error) parts.push(h('div', { class: 'msg err', text: x.error }));
        if (preview && preview !== x.title) parts.push(h('p', { class: 'libsum', text: preview }));
        if (x.kind === 'task') {
          var files = (x.pack && x.pack.files) || [];
          parts.push(h('div', { class: 'label', text: 'What the team delivered' }),
            files.length ? h('div', { class: 'libfiles' }, files.map(function (f) {
              var name = typeof f === 'string' ? f : f.name;
              return h('button', { class: 'libfile', onclick: function () { go('teamfiles', { taskId: o.taskId, teamFilePick: name }); } },
                h('span', { class: 'ftype', text: (/\.([a-z0-9]+)$/i.exec(name) || [0, 'file'])[1].toUpperCase().slice(0, 4) }), h('code', { text: name }),
                f.writtenBy ? h('span', { class: 'faint', text: f.writtenBy }) : null, h('span', { class: 'go-link', text: 'Read' }));
            })) : h('p', { class: 'muted', text: 'Its summary is the delivery.' }),
            h('div', { class: 'row' },
              h('button', { class: 'btn small go', text: 'Open the task', onclick: function () { openTask(o.taskId); } }),
              x.workingFiles ? h('button', { class: 'btn small', text: 'Open its folder · ' + plural(x.workingFiles, 'working file', 'working files'), onclick: function () { go('teamfiles', { taskId: o.taskId }); } }) : null,
              x.body ? h('button', { class: 'btn small quiet', text: 'Read the summary', onclick: reader }) : null));
        } else if (x.kind === 'file') {
          var fname = (x.source && x.source.file) || x.title;
          parts.push(h('div', { class: 'row' },
            h('button', { class: 'btn small go', text: 'Read it', onclick: function () { go('teamfiles', { taskId: o.taskId, teamFilePick: fname }); } }),
            o.taskId ? h('button', { class: 'btn small', text: 'Open the task it came from', onclick: function () { openTask(o.taskId); } }) : null, rate));
        } else if (x.kind === 'answer') {
          parts.push(h('div', { class: 'row' },
            h('button', { class: 'btn small go', text: 'Read the answer', onclick: reader }),
            h('button', { class: 'btn small', text: 'Open the conversation', onclick: function () { openWorker(x.workerId); } })));
        } else {
          parts.push(h('div', { class: 'row' },
            x.body ? h('button', { class: 'btn small go', text: 'Read', onclick: reader }) : null,
            x.runId ? h('button', { class: 'btn small', text: 'See the run', onclick: function () { watchRun(x.runId, x.workerName + ' · ' + x.title); } }) : null,
            x.source && x.source.url ? h('a', { class: 'btn small quiet', href: x.source.url, target: '_blank', rel: 'noopener', text: 'What set it off ↗' }) : null,
            (x.links || []).slice(0, 4).map(function (l) {
              var label = /\/pull\/\d+/.test(l) ? 'PR #' + l.split('/pull/')[1].split(/[/?#]/)[0] : /docs\.google|notion\.so|confluence/.test(l) ? 'Doc' : l.replace(/^https?:\/\//, '').split('/')[0];
              return h('a', { class: 'btn small quiet', href: l, target: '_blank', rel: 'noopener', text: label + ' ↗' });
            }), rate));
          if (x.deliveredTo && x.deliveredTo.length) parts.push(h('span', { class: 'faint', text: 'Delivered to ' + x.deliveredTo.join(', ') }));
        }
        parts.push(h('span', { class: 'faint', text: 'Who can see it: ' + (x.visibleTo || LIB_VIS[x.visibility || 'private'][0]) }), out);
        return h('div', { class: 'stack', style: 'gap:10px' }, parts);
      };
      var refilter = function () { showing = LIB_PAGE; draw(); };
      from.onchange = refilter; seen.onchange = refilter; q.oninput = refilter;
      draw();
      return [h('header', { class: 'page-head' },
          h('div', null, h('div', { class: 'eyebrow', text: 'Workspace' }), h('h1', { class: 'page-title', text: 'Library' }),
            h('p', { class: 'page-sub', text: 'The finished work your workers and teams delivered, that you’re allowed to see.' })),
          h('label', { class: 'search lib-search' }, icon('search', 15), q)),
        h('section', { class: 'tcard', 'aria-label': 'Library' },
          h('div', { class: 'tbar' }, tabsEl, h('div', { class: 'tools' }, from, seen)),
          h('div', { class: 'libhead', 'aria-hidden': 'true' }, h('span'), h('span', { text: 'What, and where it came from' }), h('span', { text: 'From' }), h('span', { text: 'Who can see' }), h('span', { class: 'r', text: 'When' }), h('span', { class: 'r', text: 'Rated' })),
          body, foot)];
    });
  }

  // ---- triggers ------------------------------------------------------------

  /// A trigger in one plain sentence: what sets it off.
  function triggerWhen(t) {
    if (t.kind === 'watch' && t.watch && t.watch.changes) return 'Checks ' + (t.watch.tracked ? plural(t.watch.tracked.length, 'tracked item', 'tracked items') + ' in ' : '') + t.watch.server + ' every ' + t.watch.everyMinutes + ' min for a change to ' + t.watch.changes;
    if (t.kind === 'watch' && t.watch) return 'Checks ' + t.watch.server + ' (' + t.watch.tool + ') every ' + t.watch.everyMinutes + ' min for new items';
    if (t.kind === 'webhook') return 'When another system posts to its webhook';
    if (t.kind === 'slack' && t.slack) return (t.slack.on === 'reaction' ? 'When someone reacts :' + t.slack.reaction + ': to a message' : t.slack.on === 'mention' ? 'When someone mentions the bot' : 'On each new message') + ' in #' + t.slack.channel + (t.slack.contains ? ' containing “' + t.slack.contains + '”' : '');
    return 'On an event';
  }

  function triggerRow(t, canEdit) {
    var out = h('div', { 'aria-live': 'polite' });
    var act = function (path, body, ok) { return function () { api('POST', path, body).then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else if (ok) { out.textContent = ''; out.appendChild(msg({}, ok)); setTimeout(render, 1200); } else render(); }); }; };
    var deliver = (t.deliver || []).map(function (d) { return d.kind === 'slack' ? 'posts in #' + d.channel : d.kind === 'thread' ? 'replies in the thread' : d.kind === 'dm' ? 'DMs you' : d.text; });
    // The tickets a change watch follows: add one, or take one off.
    var tracked = t.watch && t.watch.tracked ? (function () {
      var box = h('div', { class: 'row', style: 'gap:6px' });
      var add = h('input', { type: 'text', placeholder: 'ACME-412', 'aria-label': 'Track another', style: 'width:130px;min-height:30px;font-size:13px' });
      var track = function (item, on) {
        api('POST', '/api/workers/' + encodeURIComponent(t.workerId) + '/track', { item: item, on: on }).then(function (x) {
          if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); return; }
          render();
        });
      };
      add.onkeydown = function (e) { if (e.key === 'Enter' && add.value.trim()) track(add.value.trim(), true); };
      append(box, [h('span', { class: 'faint', style: 'font-size:12.5px', text: t.watch.tracked.length ? 'Tracking' : 'Tracking nothing yet' })].concat(t.watch.tracked.map(function (k) {
        return h('span', { class: 'tag' }, k, canEdit ? h('button', { class: 'linkish', style: 'margin-left:4px;color:inherit', 'aria-label': 'Stop tracking ' + k, onclick: function () { track(k, false); } }, icon('x', 11)) : null);
      }), canEdit ? [add, h('button', { class: 'btn small', text: 'Track', onclick: function () { if (add.value.trim()) track(add.value.trim(), true); } })] : []));
      return box;
    })() : null;
    return h('article', { class: 'panel', style: 'padding:16px 18px;display:flex;flex-direction:column;gap:8px' + (t.enabled ? '' : ';opacity:.7') },
      h('div', { class: 'spread', style: 'align-items:center' },
        h('div', { class: 'row', style: 'gap:10px' }, h('span', { style: 'color:var(--go);display:inline-flex' }, icon('bolt', 17)), h('b', { style: 'font-weight:600', text: t.name }), h('span', { class: 'tag' + (t.enabled ? ' go' : ''), text: t.enabled ? 'On' : 'Off' })),
        canEdit ? h('div', { class: 'row', style: 'gap:6px' },
          t.kind === 'watch' && t.enabled ? h('button', { class: 'btn small', text: 'Check now', onclick: act('/api/triggers/' + encodeURIComponent(t.id) + '/check', {}, 'Checked.') }) : null,
          h('button', { class: 'btn small', text: t.enabled ? 'Pause' : 'Turn on', onclick: act('/api/triggers/' + encodeURIComponent(t.id), { patch: { enabled: !t.enabled } }) }),
          h('button', { class: 'btn small quiet', text: 'Remove', onclick: function () { if (window.confirm('Remove “' + t.name + '”? What it already delivered stays in the Library.')) act('/api/triggers/' + encodeURIComponent(t.id) + '/remove', {})(); } })) : null),
      h('span', { class: 'muted', style: 'font-size:13.5px', text: triggerWhen(t) + ' → ' + (t.notifyOnly ? 'says what changed' : t.instructions.split('\n')[0].slice(0, 140)) + (deliver.length ? ' → ' + deliver.join(', ') : '') }),
      tracked,
      h('span', { class: 'faint', text: [t.handledTotal + ' handled', t.handledToday + ' today of ' + t.maxPerDay, t.lastFiredAt ? 'last ' + ago(t.lastFiredAt) : 'not set off yet', t.kind === 'watch' && t.lastPolledAt ? 'checked ' + ago(t.lastPolledAt) : null].filter(Boolean).join(' · ') }),
      t.lastError ? h('div', { class: 'msg err', text: t.lastError }) : null,
      out);
  }

  /// Build a trigger in plain steps: what sets it off, what to do, where the
  /// result goes. A watch can be tried before it is saved.
  function triggerBuilder(w, done) {
    var kind = 'watch';
    var name = h('input', { type: 'text', placeholder: 'e.g. New bugs in Support Backlog', 'aria-label': 'Name' });
    var kinds = h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'What sets it off' });
    var parts = {};
    // Watch
    var server = h('select', { 'aria-label': 'Tool' }, h('option', { value: '', text: 'Loading tools…' }));
    var call = h('select', { 'aria-label': 'Call' }, h('option', { value: '', text: 'Pick a tool first' }));
    var args = h('textarea', { 'aria-label': 'Arguments (JSON)', placeholder: '{ "jql": "project = ACME AND sprint = \\"Support Backlog\\" AND statusCategory != Done" }', style: 'min-height:70px;font-family:var(--mono);font-size:12.5px' });
    var every = h('select', { 'aria-label': 'How often' }, [5, 10, 15, 30, 60].map(function (n) { return h('option', { value: String(n), text: 'every ' + n + ' min', selected: n === 15 }); }));
    var itemsPath = h('input', { type: 'text', placeholder: 'e.g. issues', 'aria-label': 'Where the list is' });
    var idPath = h('input', { type: 'text', placeholder: 'e.g. key', 'aria-label': 'What identifies an item' });
    // New items, or a change to one field of the items it sees.
    var fireOn = h('select', { 'aria-label': 'Set off by' }, h('option', { value: 'new', text: 'a new item' }), h('option', { value: 'change', text: 'a change to a field' }));
    var field = h('input', { type: 'text', placeholder: 'e.g. fields.status.name', 'aria-label': 'Which field' });
    var onlyTracked = h('input', { type: 'checkbox' });
    var trackList = h('input', { type: 'text', placeholder: 'ACME-412, ACME-415 (add more later from Slack)', 'aria-label': 'Items to track' });
    var plain = h('input', { type: 'checkbox', checked: true });
    var changeBox = h('div', { class: 'stack', style: 'gap:10px' },
      h('label', { class: 'field', style: 'max-width:360px' }, 'Which field', field),
      h('label', { class: 'toggle' }, onlyTracked, h('span', null, h('b', { text: 'Only items I track' }), h('span', { class: 'faint', style: 'display:block;font-size:12.5px', text: 'Put {{ids}} in the arguments, e.g. "jql": "key in ({{ids}})". Add or remove items here, or in Slack: “@overcli ' + w.name + ', track ACME-412”.' }))),
      h('label', { class: 'field', style: 'max-width:440px' }, 'Start with', trackList),
      h('label', { class: 'toggle' }, plain, h('span', null, h('b', { text: 'Just tell me what changed' }), h('span', { class: 'faint', style: 'display:block;font-size:12.5px', text: '“ACME-412 moved from In review to Done”, with a link. No worker turn, so nothing to pay while it’s quiet. Off: the worker gets each change to act on.' }))));
    var syncFire = function () {
      changeBox.hidden = fireOn.value !== 'change';
      trackList.closest('label').hidden = !onlyTracked.checked;
      instrStep.hidden = fireOn.value === 'change' && plain.checked;
    };
    fireOn.onchange = syncFire; onlyTracked.onchange = syncFire; plain.onchange = syncFire;
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
      preset,
      h('label', { class: 'field' }, 'With (JSON)', args),
      h('div', { class: 'row', style: 'align-items:flex-end;gap:12px' }, h('label', { class: 'field', style: 'width:200px' }, 'How often to check', every), h('label', { class: 'field', style: 'width:200px' }, 'Set off by', fireOn), test),
      changeBox,
      testOut,
      h('details', null, h('summary', { text: 'If it can’t tell items apart' }), h('div', { class: 'grid2', style: 'margin-top:10px' }, h('label', { class: 'field' }, 'Where the list is', itemsPath), h('label', { class: 'field' }, 'What identifies an item', idPath))));
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
    var KINDS = [['watch', 'Something new or changed in a tool', 'A new ticket, deal or row, or one whose status changes, checked every few minutes. Works anywhere, inside a VPC too.'],
      ['webhook', 'Another system tells us', 'Jira, GitHub, a CRM or Zapier posts each event to a secret address.'],
      ['slack', 'Something happens in Slack', 'A new message, a mention, or an emoji reaction in a channel.']];
    var drawKinds = function () {
      kinds.textContent = '';
      KINDS.forEach(function (k) {
        kinds.appendChild(h('button', { type: 'button', role: 'radio', 'aria-checked': kind === k[0] ? 'true' : 'false', class: 'choice', onclick: function () { kind = k[0]; drawKinds(); sync(); } },
          h('b', { text: k[1] }), h('span', { text: k[2] })));
      });
    };
    var kindBody = h('div');
    var thread = h('input', { type: 'checkbox' });
    var threadRow = h('label', { class: 'toggle' }, thread, h('span', { text: 'Reply in the Slack thread it came from' }));
    var sync = function () { kindBody.textContent = ''; kindBody.appendChild(parts[kind]); threadRow.style.display = kind === 'slack' ? '' : 'none'; };
    drawKinds(); sync();
    var instructions = h('textarea', { 'aria-label': 'What to do with each one', placeholder: 'e.g. Triage the ticket: reproduce it if you can, label it, and say who owns it. If it’s small and clear, fix it and open a PR.', style: 'min-height:90px' });
    var instrStep = h('div', { class: 'fstep' }, h('span', { class: 'label', text: '2 · What it does with each one' }), instructions,
      h('p', { class: 'hint', text: 'It gets the event’s details with this. ' + (w.trust === 'probation' ? 'On probation, it proposes what it would do and waits for you.' : 'Trusted, it goes ahead.') }));
    syncFire();
    var postTo = h('input', { type: 'text', placeholder: 'Channel ID, e.g. C012AB3CD (optional)', 'aria-label': 'Post each result in this Slack channel' });
    var itself = h('input', { type: 'text', placeholder: 'e.g. Comment your triage on the ticket (optional)', 'aria-label': 'The worker delivers it itself' });
    var perDay = h('input', { type: 'number', min: '1', max: '500', value: '50', 'aria-label': 'At most per day' });
    var dmMe = h('input', { type: 'checkbox' });
    var out = h('div', { 'aria-live': 'polite' });
    var save = h('button', { class: 'btn go', text: 'Save trigger' });
    save.onclick = function () {
      var a = kind === 'watch' ? parseArgs() : {};
      if (a === null) { out.textContent = ''; out.appendChild(h('div', { class: 'msg err', text: 'The arguments aren’t valid JSON.' })); return; }
      var deliver = [];
      if (postTo.value.trim()) deliver.push({ kind: 'slack', channel: postTo.value.trim() });
      if (kind === 'slack' && thread.checked) deliver.push({ kind: 'thread' });
      if (itself.value.trim()) deliver.push({ kind: 'worker', text: itself.value.trim() });
      if (dmMe.checked) deliver.push({ kind: 'dm' });
      var changes = kind === 'watch' && fireOn.value === 'change';
      var trigger = { name: name.value.trim(), kind: kind, instructions: instructions.value.trim(), deliver: deliver, maxPerDay: Number(perDay.value) || 50, notifyOnly: changes && plain.checked,
        watch: Object.assign({ server: server.value, tool: call.value, args: a, everyMinutes: Number(every.value), itemsPath: itemsPath.value.trim(), idPath: idPath.value.trim() },
          changes ? { changes: field.value.trim() } : {},
          changes && onlyTracked.checked ? { tracked: trackList.value.split(/[\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean) } : {}),
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
    return card('newtrig', 'New trigger for ' + w.name, h('button', { class: 'linkish', text: 'Cancel', onclick: done }), h('div', { class: 'form' },
      h('div', { class: 'fstep' }, h('label', { class: 'field', style: 'max-width:440px' }, 'Name', name)),
      h('div', { class: 'fstep' }, h('span', { class: 'label', text: '1 · What sets it off' }), kinds, kindBody),
      instrStep,
      h('div', { class: 'fstep' }, h('span', { class: 'label', text: '3 · Where the result goes' }),
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Post each result in a Slack channel', postTo), h('label', { class: 'field' }, 'Or the worker delivers it itself', itself)),
        h('label', { class: 'toggle' }, dmMe, h('span', { text: 'DM me in Slack' })),
        threadRow, h('p', { class: 'hint', text: 'Everything it delivers is also kept in the Library.' })),
      h('div', { class: 'fstep' }, h('span', { class: 'label', text: '4 · Limit' }),
        h('div', { class: 'row', style: 'align-items:flex-end;gap:12px' }, h('label', { class: 'field', style: 'width:200px' }, 'Most it handles a day', perDay), h('span', { class: 'hint', style: 'padding-bottom:9px', text: 'Keeps cost in check if a tool floods it.' }))),
      h('div', { class: 'form-foot' }, save, h('button', { class: 'btn quiet', text: 'Cancel', onclick: done }), out)));
  }

  function triggersView(w, d) {
    var list = d.triggers || [];
    var holder = h('div', { class: 'stack', style: 'gap:12px' });
    var opened = false;
    var showBuilder = function (e) { if (e && e.currentTarget) e.currentTarget.hidden = true; holder.textContent = ''; holder.appendChild(triggerBuilder(w, function () { state.triggerOpen = false; render(); })); holder.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    // Asked for from elsewhere ("Add a trigger"), or nothing to show yet: open
    // the builder rather than make them click again.
    if (w.youManage && (state.triggerOpen || !list.length)) {
      state.triggerOpen = false; opened = true;
      holder.appendChild(triggerBuilder(w, function () { state.triggerOpen = false; render(); }));
    }
    var v = d.value;
    return h('div', { class: 'stack', style: 'gap:16px' },
      v ? h('div', { class: 'kpis' },
        h('div', { class: 'kpi' }, kpiIcon('bolt', 'ok'), h('span', { class: 'k', text: 'Handled this month' }), h('span', { class: 'v', text: String(v.handled) })),
        h('div', { class: 'kpi' }, kpiIcon('clock', 'info'), h('span', { class: 'k', text: 'Typical time' }), h('span', { class: 'v', text: v.medianMinutes == null ? '—' : v.medianMinutes < 1 ? '<1 min' : Math.round(v.medianMinutes) + ' min' })),
        h('div', { class: 'kpi' }, kpiIcon('bars', 'violet'), h('span', { class: 'k', text: 'Cost per item' }), h('span', { class: 'v', text: v.costPerItemUSD == null ? '—' : money(v.costPerItemUSD) })),
        h('div', { class: 'kpi' }, kpiIcon('up', 'violet'), h('span', { class: 'k', text: 'Rated useful' }), h('span', { class: 'v', text: v.rated ? Math.round((100 * v.useful) / v.rated) + '%' : '—' }))) : null,
      h('div', { class: 'spread', style: 'align-items:center' },
        h('p', { class: 'muted', text: list.length ? 'What sets ' + w.name + ' off on its own, besides its schedule (' + w.schedule.toLowerCase() + ').' : w.name + ' only works on its schedule (' + w.schedule.toLowerCase() + ') and when asked. Give it a trigger so it acts the moment work shows up.' }),
        w.youManage && !opened ? h('button', { class: 'btn go', onclick: showBuilder }, icon('bolt', 15), 'Add a trigger') : null),
      list.map(function (t) { return triggerRow(t, w.youManage); }),
      holder);
  }

  // ---- setup (org) -------------------------------------------------------

  /// Everything an admin sets up, in one place: how ready the server is,
  /// the tools workers can use, and the rules.
  function viewSetup() {
    var tab = state.setupTab || 'ready';
    var tabs_ = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Setup' },
      [['ready', 'Readiness'], ['offers', 'From desktops'], ['tools', 'Tools'], ['repos', 'Repos'], ['secrets', 'Secrets'], ['rules', 'Rules, spending and sign-in']].map(function (t) {
        return h('button', { role: 'tab', 'aria-selected': tab === t[0] ? 'true' : 'false', text: t[1], onclick: function () { state.setupTab = t[0]; render(); } });
      }));
    var learn = { offers: 'setup--from-desktops', ready: 'setup--readiness', tools: 'setup--tools', repos: 'setup--repos', secrets: 'setup--secrets', rules: 'setup--rules-spending-and-sign-in' }[tab];
    var headNode = head('Setup', 'What this server needs so workers can do their jobs. Everything here applies at once.',
      h('a', { class: 'btn small', href: '/docs/admins' + (learn ? '#' + learn : ''), target: '_blank', rel: 'noopener', text: 'Learn more ↗' }));
    var body = tab === 'offers' ? viewOffers() : tab === 'tools' ? viewTools() : tab === 'repos' ? viewRepos() : tab === 'secrets' ? viewSecrets() : tab === 'rules' ? viewRules() : readiness();
    return body.then(function (nodes) { return [headNode, tabs_].concat(tab === 'ready' ? nodes : nodes.slice(1)); });
  }

  /// Code repos workers may change by pushing branches: connect one, then let
  /// a worker work on it.
  /// Setups people published from their desktops: each tool, repo and
  /// workspace with what it takes to have it here — keys typed in, a repo
  /// connected, a workspace made from repos already connected.
  function viewOffers() {
    return api('GET', '/api/setup/offers').then(function (x) {
      var top = head('From desktops');
      if (x.ok === false) return [top, msg(x)];
      if (!x.offers.length) return [top, emptyState('Nothing published yet.', 'In the overcli app: Settings → Your org → Publish my setup. Pick the workspaces, repos and tools this server should have; they land here for you to install.')];
      var done = function (label) { return h('span', { class: 'tag go', text: '✓ ' + label }); };
      return [top].concat(x.offers.map(function (o) {
        var out = h('div', { 'aria-live': 'polite' });
        var after = function (r, okText) { out.textContent = ''; out.appendChild(msg(r, okText)); if (r.ok !== false) setTimeout(render, 700); };
        var toolRow = function (t) {
          if (t.installed) return h('div', { class: 'srow' }, h('div', { class: 'stack', style: 'gap:2px;min-width:0' }, h('b', { text: t.name }), h('span', { class: 'faint mono', text: t.kind === 'http' ? t.url : [t.command].concat(t.args || []).join(' ') })),
            done(o.installed.indexOf(t.name) >= 0 ? 'Installed with the keys sent' : 'Installed'));
          var inputs = t.envKeys.map(function (k) { return { k: k, where: 'env', el: h('input', { type: 'password', placeholder: k, 'aria-label': k + ' for ' + t.name, autocomplete: 'off' }) }; })
            .concat(t.headerKeys.map(function (k) { return { k: k, where: 'headers', el: h('input', { type: 'password', placeholder: k + ' (header)', 'aria-label': k + ' header for ' + t.name, autocomplete: 'off' }) }; }));
          var install = h('button', { class: 'btn go small', text: 'Install' });
          install.onclick = function () {
            var env = {}, headers = {};
            inputs.forEach(function (i) { if (i.el.value) (i.where === 'env' ? env : headers)[i.k] = i.el.value; });
            var restore = busy(install, 'Installing…');
            api('POST', '/api/admin/tools', { tool: { name: t.name, kind: t.kind, command: t.command || '', args: t.args || [], url: t.url || '', env: env, headers: headers } }).then(function (r) { restore(); after(r, t.name + ' is installed.'); });
          };
          return h('div', { class: 'srow', style: 'align-items:flex-start' },
            h('div', { class: 'stack', style: 'gap:6px;min-width:0;flex:1' }, h('b', { text: t.name }), h('span', { class: 'faint mono', text: t.kind === 'http' ? t.url : [t.command].concat(t.args || []).join(' ') }),
              inputs.length ? h('div', { class: 'stack', style: 'gap:6px;max-width:420px' }, inputs.map(function (i) { return i.el; }),
                h('span', { class: 'faint', style: 'font-size:12px', text: 'Use a service account or bot token made for the org, not a person’s own: every worker that uses this tool acts with it.' })) : null),
            install);
        };
        // How each repo can come over: its remote when the host's token is
        // set, else the copy on that desktop when this server may clone from
        // its own disk. Null: nothing will work yet, and the row says why.
        var sourceOf = function (r) {
          if (r.url && !r.needsToken) return { url: r.url, label: 'Connect' };
          if (x.allowLocalRepos && r.localPath) return { url: 'file://' + r.localPath, label: 'Use my local copy' };
          return null;
        };
        var connectOne = function (r, button, slot) {
          var src = sourceOf(r);
          if (!src) return Promise.resolve({ ok: false });
          var restore = button ? busy(button, 'Cloning…') : function () {};
          if (slot) { slot.textContent = ''; slot.appendChild(h('span', { class: 'faint', style: 'font-size:12px', text: 'Cloning ' + r.name + '… big repos take a minute.' })); }
          return api('POST', '/api/repos', { url: src.url, name: r.name }).then(function (y) {
            restore();
            if (slot) { slot.textContent = ''; slot.appendChild(y.ok === false ? h('div', { class: 'msg err', text: y.error }) : h('span', { class: 'tag go', text: '✓ Connected' })); }
            if (y.ok !== false) { r.connected = true; if (button) button.remove(); }
            return y;
          }, function () { restore(); return { ok: false }; });
        };
        var repoRow = function (r) {
          if (r.connected) return h('div', { class: 'srow' }, h('div', { class: 'stack', style: 'gap:2px' }, h('b', { text: r.name }), h('span', { class: 'faint mono', text: r.url || r.localPath })), done('Connected'));
          var src = sourceOf(r);
          var slot = h('div');
          var button = src ? h('button', { class: 'btn go small', text: src.label }) : null;
          if (button) button.onclick = function () { connectOne(r, button, slot).then(function (y) { if (y.ok !== false) setTimeout(render, 900); }); };
          var why = !src
            ? r.needsToken
              ? h('span', { class: 'faint', style: 'font-size:12px', text: 'Needs ' + r.needsToken + ' on the Secrets tab before it can clone.' })
              : h('span', { class: 'faint', style: 'font-size:12px', text: 'It has no git remote on that desktop. Push it to your git host first, or run this server with OVERCLI_ALLOW_LOCAL_REPOS=1 on the same machine.' })
            : null;
          r._row = { button: button, slot: slot };
          return h('div', { class: 'srow' }, h('div', { class: 'stack', style: 'gap:4px;min-width:0' }, h('b', { text: r.name }), h('span', { class: 'faint mono', text: r.url || r.localPath || '' }), why, slot), button);
        };
        // What's in the way of the repos, said once at the top: the token to
        // set, and — on a laptop — the local copies as the other way in.
        var repoBanner = function () {
          var waiting = o.repos.filter(function (r) { return !r.connected; });
          if (!waiting.length) return null;
          var tokens = waiting.map(function (r) { return r.needsToken; }).filter(function (t, i, a) { return t && a.indexOf(t) === i; });
          var ready = waiting.filter(function (r) { return sourceOf(r); });
          var all = ready.length > 1 ? h('button', { class: 'btn go small', text: 'Connect all ' + ready.length }) : null;
          if (all) all.onclick = function () {
            all.disabled = true;
            var i = 0;
            var next = function () {
              if (i >= ready.length) { all.textContent = 'Done'; setTimeout(render, 900); return; }
              var r = ready[i++];
              all.textContent = 'Connecting ' + i + ' of ' + ready.length + '…';
              connectOne(r, r._row && r._row.button, r._row && r._row.slot).then(next, next);
            };
            next();
          };
          return h('div', { class: 'banner', role: 'status', style: 'flex-wrap:wrap;gap:10px' },
            h('span', { style: 'flex:1 1 320px', text: tokens.length
              ? 'Cloning over https needs ' + tokens.join(' and ') + ' on the Secrets tab' + (x.allowLocalRepos ? '. Until then, repos with a copy on that desktop can come from it instead.' : '. On a laptop test you can use the local copies instead: start the server with OVERCLI_ALLOW_LOCAL_REPOS=1.')
              : plural(ready.length, 'repo is', 'repos are') + ' ready to connect.' }),
            tokens.length ? h('button', { class: 'btn small', text: 'Set ' + tokens[0], onclick: function () { go('setup', { setupTab: 'secrets' }); } }) : null,
            all);
        };
        var spaceRow = function (w) {
          if (w.made) return h('div', { class: 'srow' }, h('div', { class: 'stack', style: 'gap:2px' }, h('b', { text: w.name }), h('span', { class: 'faint', text: w.repos.join(', ') })), done('Made'));
          var missing = w.repos.filter(function (n) { return !o.repos.some(function (r) { return r.name === n && r.connected; }); });
          var make = h('button', { class: 'btn go small', text: 'Make it', disabled: missing.length > 0 });
          make.onclick = function () {
            var restore = busy(make, 'Making…');
            api('POST', '/api/workspaces', { name: w.name, repos: w.repos, instructions: w.instructions || '' }).then(function (y) { restore(); after(y, w.name + ' is ready.'); });
          };
          return h('div', { class: 'srow' }, h('div', { class: 'stack', style: 'gap:2px;min-width:0' }, h('b', { text: w.name }), h('span', { class: 'faint', text: w.repos.join(', ') || 'No repos' }),
            missing.length ? h('span', { class: 'faint', style: 'font-size:12px', text: 'Connect ' + missing.join(', ') + ' first.' }) : null), make);
        };
        var section = function (title, rows) { return rows.length ? h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 't-kind', text: title }), rows) : null; };
        var left = o.tools.filter(function (t) { return !t.installed; }).length + o.repos.filter(function (r) { return !r.connected; }).length + o.workspaces.filter(function (w) { return !w.made; }).length;
        return h('section', { class: 'panel pad stack', style: 'gap:16px' },
          h('div', { class: 'spread' },
            h('h2', { class: 'section-title', text: 'From ' + o.by + '’s desktop' }),
            h('span', { class: 'row', style: 'gap:10px' }, h('span', { class: 'faint', text: ago(o.at) + ' · ' + (left ? left + ' to do' : 'all done') }),
              h('button', { class: 'linkish', style: 'font-size:13px', text: 'Dismiss', onclick: function () { api('POST', '/api/setup/offers/' + encodeURIComponent(o.id) + '/remove', {}).then(function (y) { after(y, 'Dismissed.'); }); } }))),
          o.repos.some(function (r) { return !r.connected; }) ? repoBanner() : null,
          section('Repos', o.repos.map(repoRow)),
          section('Workspaces', o.workspaces.map(spaceRow)),
          section('Tools', o.tools.map(toolRow)),
          out);
      }));
    });
  }

  function viewRepos() {
    return Promise.all([api('GET', '/api/repos'), api('GET', '/api/workers')]).then(function (r) {
      var data = r[0], workers = r[1] || [];
      var top = head('Repos');
      if (data.ok === false) return [top, msg(data)];
      var admin = state.me && state.me.admin;
      var url = h('input', { type: 'text', placeholder: 'https://github.com/acme/app', 'aria-label': 'Repo address' });
      var test = h('input', { type: 'text', placeholder: 'npm test', 'aria-label': 'Test command' });
      var out = h('div');
      var connect = admin ? h('section', { class: 'panel pad stack' },
        h('h2', { class: 'section-title', text: 'Connect a repo' }),
        h('p', { class: 'faint', text: 'Workers you point at it push each change as a branch and hand back the link to open a pull request; a person opens it. The server refuses pushes to the default branch, and a worker on probation waits for its manager’s yes before each push. Protect the default branch on your git host too.' }),
        h('p', { class: 'faint', text: 'GitHub, Bitbucket or any git host. Over https the server needs the host’s token, set on the Secrets tab (GH_TOKEN, BITBUCKET_TOKEN or GIT_TOKEN); a git@ address uses the server’s ssh key.' }),
        h('label', { class: 'field' }, 'Address', url),
        h('label', { class: 'field' }, 'Test command (optional, run before every push)', test),
        data.testsOff ? h('p', { class: 'faint', text: 'Repo tests are turned off on this server, so a repo with a test command pushes nothing until they’re on. ' + data.testsOff }) : null,
        h('div', null, h('button', { class: 'btn go', text: 'Connect', onclick: function (e) {
          var restore = busy(e.target, 'Cloning…');
          api('POST', '/api/repos', { url: url.value, testCommand: test.value }).then(function (x) {
            restore(); out.textContent = ''; out.appendChild(msg(x, (x.repo ? x.repo.name : 'The repo') + ' is connected. Point a worker at it below.'));
            if (x.warning) out.appendChild(h('div', { class: 'msg err', role: 'alert', text: x.warning }));
            if (x.ok !== false) setTimeout(render, 1200);
          });
        } })), out) : null;
      var cards = data.repos.map(function (repo) {
        var pick = h('select', { 'aria-label': 'Worker for ' + repo.name }, [h('option', { value: '', text: 'Pick a worker…' })].concat(workers.map(function (w) { return h('option', { value: w.id, text: w.name }); })));
        var said = h('div');
        return h('article', { class: 'panel pad stack' },
          h('div', { class: 'spread' }, h('h3', { text: repo.name }), admin ? h('button', { class: 'linkish', text: 'Disconnect', onclick: function () {
            api('POST', '/api/repos/' + encodeURIComponent(repo.name) + '/remove', {}).then(function (x) { said.textContent = ''; said.appendChild(msg(x, 'Disconnected.')); if (x.ok !== false) setTimeout(render, 800); });
          } }) : null),
          h('p', { class: 'muted', text: repo.url + ' · branches against ' + repo.defaultBranch + (repo.testCommand ? ' · tests: ' + repo.testCommand : ' · no test command') }),
          repo.testCommand && data.testsOff ? h('div', { class: 'msg err', text: 'Nothing is pushed from here yet: repo tests are turned off on this server. ' + data.testsOff }) : null,
          repo.canPush ? null : repo.tokenEnv && admin ? h('div', { class: 'stack', style: 'gap:8px' }, h('p', { class: 'faint', text: 'The server can’t push here yet. Paste ' + repo.tokenEnv + '. It’s kept in the server’s secrets and never shown again.' }), secretField(repo.tokenEnv)) : h('div', { class: 'msg err', text: 'The server can’t push here yet: an admin adds ' + (repo.tokenEnv || 'the host’s token') + ' on Setup → Secrets, or reconnects it with its git@ address.' }),
          h('p', { class: 'faint', text: repo.workers.length ? 'Works here: ' + repo.workers.join(', ') : 'No worker works here yet.' }),
          h('div', { class: 'row', style: 'gap:8px' }, pick, h('button', { class: 'btn', text: 'Let it change this repo', onclick: function (e) {
            if (!pick.value) return;
            var restore = busy(e.target, 'Saving…');
            api('POST', '/api/repos/' + encodeURIComponent(repo.name) + '/workers', { worker: pick.value }).then(function (x) {
              restore(); said.textContent = ''; said.appendChild(msg(x, (x.worker || 'It') + ' works in ' + repo.name + ' now. Ask it for a change and it comes back as a branch, with the link to open a pull request.'));
              if (x.ok !== false) setTimeout(render, 1500);
            });
          } })), said);
      });
      return [top, connect].concat(cards.length ? cards : [emptyState('No repos connected yet.', admin ? 'Connect one above.' : 'Ask an admin to connect one.')], workspacesSection(data, workers, admin));
    });
  }

  /// Repos grouped so one worker or team changes them together. Each run
  /// gets its own worktree of every repo, side by side, and pushes a branch in
  /// each repo it changed.
  function workspacesSection(data, workers, admin) {
    var repos = data.repos || [], spaces = data.workspaces || [];
    if (repos.length < 2 && !spaces.length) return null;
    var intro = h('div', { class: 'stack', style: 'gap:4px;margin-top:12px' },
      h('h2', { class: 'section-title', text: 'Workspaces' }),
      h('p', { class: 'faint', text: 'Group repos that change together, like an API and the app that uses it. A worker or team in a workspace plans across all of them; each run gets its own worktree of every repo, runs each repo’s tests, and pushes a branch in each repo it changed, with one pull request link per repo.' }));
    var make = null;
    if (admin && repos.length >= 2) {
      var name = h('input', { type: 'text', placeholder: 'Storefront', 'aria-label': 'Workspace name' });
      var notes = h('textarea', { placeholder: 'What every run should know: which repo owns what, what must stay in step (the API is the source of truth for prices…)', 'aria-label': 'Workspace instructions', style: 'min-height:70px' });
      var picks = repos.map(function (r) { return { name: r.name, box: h('input', { type: 'checkbox', 'aria-label': 'Include ' + r.name }) }; });
      var said = h('div');
      make = h('section', { class: 'panel pad stack' },
        h('h3', { text: 'Make a workspace' }),
        h('label', { class: 'field' }, 'Name', name),
        h('div', { class: 'row', style: 'gap:14px' }, picks.map(function (p) { return h('label', { class: 'toggle' }, p.box, h('code', { text: p.name })); })),
        h('label', { class: 'field' }, 'Instructions (optional)', notes),
        h('div', null, h('button', { class: 'btn go', text: 'Make the workspace', onclick: function (e) {
          var chosen = picks.filter(function (p) { return p.box.checked; }).map(function (p) { return p.name; });
          var restore = busy(e.target, 'Making…');
          api('POST', '/api/workspaces', { name: name.value, repos: chosen, instructions: notes.value }).then(function (x) {
            restore(); said.textContent = ''; said.appendChild(msg(x, (x.workspace ? x.workspace.name : 'The workspace') + ' is ready. Point a worker at it below.'));
            if (x.ok !== false) setTimeout(render, 1200);
          });
        } })), said);
    }
    var cards = spaces.map(function (ws) {
      var said = h('div');
      var pick = h('select', { 'aria-label': 'Worker for ' + ws.name }, [h('option', { value: '', text: 'Pick a worker…' })].concat(workers.map(function (w) { return h('option', { value: w.id, text: w.name }); })));
      var notes = h('textarea', { 'aria-label': 'Instructions for ' + ws.name, style: 'min-height:70px' });
      notes.value = ws.instructions || '';
      var boxes = repos.map(function (r) { var b = h('input', { type: 'checkbox', 'aria-label': 'Include ' + r.name }); b.checked = ws.repos.indexOf(r.name) >= 0; return { name: r.name, box: b }; });
      var editor = h('div', { class: 'stack', hidden: true },
        h('div', { class: 'row', style: 'gap:14px' }, boxes.map(function (p) { return h('label', { class: 'toggle' }, p.box, h('code', { text: p.name })); })),
        h('label', { class: 'field' }, 'Instructions', notes),
        h('div', null, h('button', { class: 'btn go small', text: 'Save', onclick: function (e) {
          var restore = busy(e.target, 'Saving…');
          api('POST', '/api/workspaces/' + encodeURIComponent(ws.id), { repos: boxes.filter(function (p) { return p.box.checked; }).map(function (p) { return p.name; }), instructions: notes.value }).then(function (x) {
            restore(); said.textContent = ''; said.appendChild(msg(x, 'Saved. Workers in it use the new setup from their next run.'));
            if (x.ok !== false) setTimeout(render, 1200);
          });
        } })));
      return h('article', { class: 'panel pad stack' },
        h('div', { class: 'spread' }, h('h3', { text: ws.name }), admin ? h('div', { class: 'row', style: 'gap:12px' },
          h('button', { class: 'linkish', text: 'Change', onclick: function () { editor.hidden = !editor.hidden; } }),
          h('button', { class: 'linkish', text: 'Remove', onclick: function () {
            api('POST', '/api/workspaces/' + encodeURIComponent(ws.id) + '/remove', {}).then(function (x) { said.textContent = ''; said.appendChild(msg(x, 'Removed.')); if (x.ok !== false) setTimeout(render, 800); });
          } })) : null),
        h('div', { class: 'row', style: 'gap:6px' }, ws.repos.map(function (r) { return h('span', { class: 'tag', text: r }); })),
        ws.instructions ? h('details', null, h('summary', { text: 'Instructions every run reads' }), h('div', { style: 'white-space:pre-wrap;margin-top:6px;font-size:13.5px', text: ws.instructions })) : null,
        editor,
        h('p', { class: 'faint', text: ws.workers.length ? 'Works here: ' + ws.workers.join(', ') : 'No worker works here yet.' }),
        h('div', { class: 'row', style: 'gap:8px' }, pick, h('button', { class: 'btn', text: 'Let it change this workspace', onclick: function (e) {
          if (!pick.value) return;
          var restore = busy(e.target, 'Saving…');
          api('POST', '/api/repos/' + encodeURIComponent(ws.name) + '/workers', { worker: pick.value }).then(function (x) {
            restore(); said.textContent = ''; said.appendChild(msg(x, (x.worker || 'It') + ' works in ' + ws.name + ' now. A change comes back as a branch in each repo it touched, with a link for each.'));
            if (x.ok !== false) setTimeout(render, 1500);
          });
        } })), said);
    });
    return [intro, make].concat(cards);
  }

  /// One secret's value, pasted and saved; never read back. A text field
  /// drawn as dots (.secret), so the password manager leaves it alone.
  function secretField(name, onDone) {
    var input = h('input', { type: 'text', class: 'secret', placeholder: 'Paste the value', 'aria-label': 'Value for ' + name, autocomplete: 'off', spellcheck: 'false' });
    var out = h('div');
    var save = h('button', { class: 'btn go', text: 'Save', onclick: function (e) {
      if (!input.value.trim()) { input.focus(); return; }
      var restore = busy(e.target, 'Saving…');
      api('POST', '/api/secrets', { name: name, value: input.value }).then(function (x) {
        restore(); input.value = ''; out.textContent = ''; out.appendChild(msg(x, name + ' is saved and in use.'));
        if (x.ok !== false) setTimeout(onDone || render, 900);
      });
    } });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save.click(); });
    return h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'inline-form' }, input, save), out);
  }

  /// What the server keeps secret: where, which are set, what needs a missing
  /// one. One row each; values go in and never come back out.
  function viewSecrets() {
    return api('GET', '/api/secrets').then(function (data) {
      var top = head('Secrets');
      if (data.ok === false) return [top, msg(data)];
      var ro = data.store.readOnly;
      var using = data.model ? { anthropic: 'the Anthropic API', bedrock: 'Bedrock', vertex: 'Vertex AI' }[data.model.provider] : '';
      var about = h('section', { class: 'panel pad stack', style: 'gap:10px' },
        h('dl', { class: 'rules' },
          data.model ? [h('dt', { text: 'Model' }), h('dd', { text: data.model.detail })] : null,
          h('dt', { text: 'Kept in' }), h('dd', { text: data.store.where + (ro ? ' (managed there)' : '') })),
        data.store.warning ? h('div', { class: 'msg err', text: data.store.warning }) : null,
        data.error ? h('div', { class: 'msg err', text: 'Could not read them just now: ' + data.error }) : null,
        h('p', { class: 'faint', text: 'Changes apply at once, no restart. A secret set in the server’s environment (its task definition or deploy/.env) wins, and is changed there.' }));
      var when = function (s) { return s.updatedAt ? 'Set ' + new Date(s.updatedAt).toLocaleDateString() + (s.updatedBy ? ' by ' + s.updatedBy : '') : 'Set'; };
      // What needs doing first, what's fine next, what doesn't matter last.
      var rank = function (s) { return s.state === 'missing' && s.neededBy.length ? 0 : s.state === 'stored' || s.state === 'environment' ? 1 : s.state === 'missing' ? 2 : 3; };
      var list = data.secrets.slice().sort(function (a, b) { return rank(a) - rank(b); });
      var rows = list.map(function (s) {
        var chip = s.state === 'environment' ? h('span', { class: 'tag go', text: 'Set by the environment' })
          : s.state === 'stored' ? h('span', { class: 'tag go', text: when(s) })
          : s.state === 'notNeeded' ? h('span', { class: 'tag', text: 'Not needed · using ' + using })
          : s.neededBy.length ? h('span', { class: 'tag need', text: 'Needed for ' + s.neededBy.join(', ') })
          : h('span', { class: 'tag', text: 'Not set' });
        var editor = h('div', { class: 'srow-edit stack', style: 'gap:10px', hidden: true });
        var help = h('div', { class: 'stack', style: 'gap:6px;font-size:13px' },
          h('p', null, h('strong', { text: 'Why: ' }), s.why),
          s.how ? h('p', null, h('strong', { text: 'How to get one: ' }), s.how) : null,
          s.link ? h('a', { href: s.link, target: '_blank', rel: 'noopener', text: 'Open that page ↗' }) : null);
        var open = function () { editor.hidden = !editor.hidden; if (!editor.hidden && !editor.firstChild) { editor.appendChild(help); editor.appendChild(secretField(s.name)); } if (!editor.hidden) { var f = editor.querySelector('input'); if (f) f.focus(); } };
        var actions = ro || s.state === 'environment' ? h('button', { class: 'linkish', text: 'Why?', onclick: function () { editor.hidden = !editor.hidden; if (!editor.firstChild) editor.appendChild(help); } }) : h('div', { class: 'row', style: 'gap:10px;justify-content:flex-end' },
          s.state === 'stored' ? h('button', { class: 'linkish', text: 'Remove', onclick: function () {
            api('POST', '/api/secrets/' + encodeURIComponent(s.name) + '/remove', {}).then(function (x) { if (x.ok === false) { editor.hidden = false; editor.textContent = ''; editor.appendChild(msg(x)); } else render(); });
          } }) : null,
          h('button', { class: 'btn small', text: s.state === 'stored' ? 'Replace' : 'Set', onclick: open }));
        return h('div', { class: 'srow' + (s.state === 'notNeeded' ? ' quiet' : '') },
          h('div', { class: 'srow-name' }, h('code', { text: s.name }), s.label ? h('span', { class: 'faint', text: s.label }) : null),
          chip, actions, editor);
      });
      var custom = ro ? null : (function () {
        var name = h('input', { type: 'text', placeholder: 'JIRA_API_TOKEN', 'aria-label': 'Secret name', spellcheck: 'false' });
        var slot = h('div');
        var next = h('button', { class: 'btn', text: 'Next', onclick: function () { slot.textContent = ''; var n = name.value.trim().toUpperCase(); if (n) { slot.appendChild(secretField(n)); slot.querySelector('input').focus(); } } });
        name.addEventListener('keydown', function (e) { if (e.key === 'Enter') next.click(); });
        return h('section', { class: 'panel pad stack', style: 'gap:10px' },
          h('h2', { class: 'section-title', text: 'Add a tool credential' }),
          h('p', { class: 'faint', text: 'Capitals, ending _TOKEN, _API_KEY, _KEY, _SECRET or _PASSWORD.' }),
          h('div', { class: 'inline-form' }, name, next), slot);
      })();
      return [top, about, h('section', { class: 'panel srows' }, rows), custom];
    });
  }

  /// Rechecked: drawn again by Check again, so the header says it just ran.
  function readiness(rechecked) {
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
        { ok: places.length > 0, title: 'A place to work', detail: places.length ? places.map(function (p) { return p.name; }).join(', ') : 'No repo or folder yet. Connect a repo on the Repos tab, or an operator adds a folder with: overcli projects add <folder>', optional: false,
          action: places.length ? null : ['Connect a repo', function () { state.setupTab = 'repos'; render(); }] },
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
          h('span', { class: 'row', style: 'gap:12px' },
            h('span', { class: 'faint' + (rechecked ? ' rechecked' : ''), style: 'font-size:12.5px;display:inline-flex;align-items:center;gap:5px' }, rechecked ? icon('check', 14) : null, rechecked ? 'Checked just now' : 'Checked at ' + clock(Date.now())),
            h('button', { class: 'btn small', text: 'Check again', onclick: function (e) {
              // Check in place, and long enough to see: a re-render alone is a flash.
              var b = e.currentTarget, sec = b.closest('section'), restore = busy(b, 'Checking…'), t0 = Date.now();
              sec.classList.add('checking');
              readiness(true).then(function (next) {
                setTimeout(function () { if (sec.isConnected && next[0]) sec.replaceWith(next[0]); else { restore(); sec.classList.remove('checking'); } }, Math.max(0, 700 - (Date.now() - t0)));
              }, function () { restore(); sec.classList.remove('checking'); });
            } }))),
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

  /// Off to a remote tool's sign-in page, to sign it in for the whole org.
  /// The server comes back to Setup → Tools.
  function signInTool(tool, button, out) {
    var restore = busy(button, 'Opening the sign-in…');
    api('POST', '/api/admin/tools/signin', { tool: tool, next: '#setup/tools' }).then(function (r) {
      if (r.ok === false) { restore(); out.textContent = ''; out.appendChild(msg(r)); return; }
      location.href = r.url;
    });
  }

  var TOOL_SIGNIN_ERR = { denied: 'You said no on the sign-in page, so nothing was installed.', expired: 'That took too long. Start the sign-in again.', browser: 'The sign-in finished in a different browser than the one it started in. Start again from this page.',
    exchange: 'The service didn’t accept the sign-in. Try again, or check the client ID.', install: 'Signed in, but the tool couldn’t be written to the server’s config. See the server log.', server: 'Something went wrong on the server. Try again.' };

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
    // A remote server says how it signs in: nothing, a token, or a sign-in
    // page. With a sign-in page the token box goes and the button signs in.
    var how = null;
    var signBox = h('div', { class: 'signbox', hidden: true, 'aria-live': 'polite' });
    var clientId = h('input', { type: 'text', placeholder: 'Client ID', 'aria-label': 'Client ID', spellcheck: 'false' });
    var clientSecret = h('input', { type: 'password', placeholder: 'Client secret (if it has one)', 'aria-label': 'Client secret', autocomplete: 'off' });
    var headersField = h('label', { class: 'field' }, 'Headers (one "Name: value" a line)', headers);
    var httpPart = h('div', { class: 'stack', style: 'gap:10px' }, h('label', { class: 'field' }, 'URL', url), signBox, headersField);
    var drawHow = function () {
      var oauth = how && how.signIn === 'oauth';
      headersField.hidden = !!oauth;
      save.textContent = oauth && kind.value === 'http' ? 'Sign in and install' : 'Install';
      if (!how) { signBox.hidden = true; return; }
      signBox.hidden = false;
      if (how.checking) { fill(signBox, [h('span', { class: 'faint', text: 'Checking how it signs in…' })]); return; }
      if (how.ok === false) { fill(signBox, [h('span', { class: 'faint', text: how.error })]); return; }
      if (how.signIn === 'none') { fill(signBox, [h('span', { class: 'faint', text: 'It answers without a sign-in. Install it as it is.' })]); return; }
      if (how.signIn === 'token') { fill(signBox, [h('span', { class: 'faint', text: 'It wants a token, not a sign-in page. Paste it as a header below, e.g. Authorization: Bearer …' })]); return; }
      fill(signBox, [
        h('div', { class: 'row', style: 'gap:8px;align-items:flex-start;flex-wrap:nowrap' }, h('span', { style: 'color:var(--go);flex:none;display:flex;margin-top:2px' }, icon('lock', 16)),
          h('div', { class: 'stack', style: 'gap:4px' },
            h('b', { text: 'Signs in with ' + how.issuer }),
            h('span', { class: 'muted', style: 'font-size:13px', text: 'You approve it once on their page, for the whole org. Every worker you give this tool acts as the account you sign in with, so a service or bot account is best. overcli renews the sign-in itself.' }))),
        how.registers ? null : h('div', { class: 'stack', style: 'gap:8px' },
          h('span', { class: 'muted', style: 'font-size:13px', text: how.issuer + ' doesn’t let apps register themselves. Make an OAuth app there with this redirect address, then paste its client ID and secret:' }),
          codeBlock(how.redirectUri),
          h('div', { class: 'grid2' }, clientId, clientSecret))
      ]);
    };
    var probeTimer = null, probed = '';
    var probe = function () {
      var u = url.value.trim();
      if (kind.value !== 'http' || !/^https?:\/\/[^\s/]+\.[^\s]+/.test(u)) { how = null; probed = ''; drawHow(); return; }
      if (u === probed) return;
      probed = u; how = { checking: true }; drawHow();
      api('POST', '/api/admin/tools/discover', { url: u }).then(function (r) { if (probed === u) { how = r; drawHow(); } });
    };
    url.addEventListener('input', function () { clearTimeout(probeTimer); probeTimer = setTimeout(probe, 700); });
    url.addEventListener('blur', probe);
    var sync = function () { cmdPart.style.display = kind.value === 'command' ? '' : 'none'; httpPart.style.display = kind.value === 'http' ? '' : 'none'; probe(); };
    if (tpl) {
      kind.value = tpl.kind;
      if (tpl.kind === 'http') { url.value = tpl.url || ''; headers.value = tpl.headerKeys.map(function (k) { return k + ': '; }).join('\n'); }
      else { cmd.value = [tpl.command || ''].concat(tpl.args || []).map(function (a) { return /\s/.test(a) ? '"' + a + '"' : a; }).join(' '); env.value = tpl.envKeys.map(function (k) { return k + '='; }).join('\n'); }
    }
    var out = h('div', { 'aria-live': 'polite' });
    var save = h('button', { class: 'btn go', text: 'Install' });
    kind.onchange = sync; sync();
    save.onclick = function () {
      if (kind.value === 'http' && how && how.signIn === 'oauth') {
        if (!name.value.trim()) { name.focus(); return; }
        signInTool({ name: name.value.trim(), url: url.value.trim(), clientId: clientId.value.trim(), clientSecret: clientSecret.value }, save, out);
        return;
      }
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
      h('p', { class: 'faint', text: 'Secrets are written to the server’s own config on its volume and never shown again. A remote server that signs in through a browser is signed in once by you, for everyone; overcli keeps the sign-in encrypted and renews it.' }),
      h('div', { class: 'foot' }, save, out));
  }

  /// Setup → Tools: what needs you first, then one row per tool with who has
  /// it. A row opens a side panel to give or take it, worker by worker or a
  /// whole team at once — built to stay readable with many workers.
  function viewTools() {
    return Promise.all([api('GET', '/api/tools'), api('GET', '/api/workers').catch(function () { return []; }), api('GET', '/api/teams').catch(function () { return []; })]).then(function (rr) {
      var r = rr[0], workers = Array.isArray(rr[1]) ? rr[1] : [], teams = Array.isArray(rr[2]) ? rr[2] : [];
      if (r.ok === false) return [msg(r)];
      var onThisMac = function (t) { return /(^|\s)\/(Users|home)\//.test(t.target); };
      var stateOf = function (t) {
        if (t.signIn && t.signIn.ended) return { tone: 'need', text: 'Sign in again' };
        if (t.status === 'connected') return { tone: 'ok', text: onThisMac(t) ? 'Connects · Mac only' : 'Connects' };
        if (t.status === 'needs-auth') return { tone: 'need', text: 'Needs a sign-in' };
        if (t.status === 'failed') return { tone: 'bad', text: 'Won’t start' };
        if (t.status) return { tone: 'bad', text: t.status };
        return { tone: '', text: onThisMac(t) ? 'Not checked · Mac only' : 'Not checked' };
      };
      var nextStep = function (t) {
        if (t.signIn && t.signIn.ended) return (t.signIn.why || 'The sign-in ended.') + ' Until then workers that have it run without it.';
        if (t.status === 'needs-auth' && t.kind === 'http' && r.signIn) return 'It signs in through a browser. Sign it in below, once, for every worker that has it.';
        if (t.status === 'needs-auth') return 'On this Mac, run “claude mcp” in a terminal (or /mcp in Claude Code), pick ' + t.name + ' and sign in. This server uses the same login. A server elsewhere can’t open a browser: install it with an API token instead.';
        if (t.status === 'failed') return onThisMac(t) ? 'It runs a file from someone’s Mac, which a server elsewhere won’t have. Reinstall it from its package (npx -y <package>).' : 'Check the command, and that its keys are set.';
        if (onThisMac(t)) return 'It runs a file from a Mac, so it only works on a server on that Mac. For a real server, reinstall it from its package.';
        if (!t.status) return 'Check all starts each tool once to see whether it connects.';
        return '';
      };
      var holders = function (t) { return workers.filter(function (w) { return (w.tools || []).some(function (x) { return x.name === t.name && !x.shared; }); }); };
      var LEVEL = { picked: 'Picked', managers: 'Any manager', everyone: 'Every worker' };
      var filter = state.toolsFilter || 'all';
      var q = h('input', { type: 'search', placeholder: 'Find a tool or worker', 'aria-label': 'Find a tool, or a worker to see its tools', style: 'width:220px' });
      var needYou = function (t) { return (t.signIn && t.signIn.ended) || t.status === 'needs-auth' || t.status === 'failed' || (t.access !== 'everyone' && !holders(t).length); };
      var counts = { all: r.tools.length, need: r.tools.filter(needYou).length, everyone: r.tools.filter(function (t) { return t.access === 'everyone'; }).length, nobody: r.tools.filter(function (t) { return t.access !== 'everyone' && !holders(t).length; }).length };
      var chips = h('div', { class: 'row', role: 'group', 'aria-label': 'Show', style: 'gap:6px' });
      var body = h('tbody');
      var check = h('button', { class: 'btn small', text: r.checkedAt ? 'Check again' : 'Check all' });
      var checkOut = h('div', { 'aria-live': 'polite' });
      check.onclick = function () {
        var restore = busy(check, 'Checking… up to a minute');
        api('POST', '/api/admin/tools/check').then(function (x) { restore(); if (x.ok === false) { checkOut.textContent = ''; checkOut.appendChild(msg(x)); return; } render(); });
      };
      var addPanel = h('section', { class: 'panel pad stack', hidden: true }, h('h2', { class: 'section-title', text: 'Install a tool' }), toolForm('', render));
      var row = function (t) {
        var st = stateOf(t);
        var has = holders(t);
        var who = t.access === 'everyone' ? h('span', { style: 'color:var(--go);font-size:13px', text: 'All ' + plural(workers.length, 'worker', 'workers') })
          : has.length ? h('div', { class: 'row', style: 'gap:6px' }, has.slice(0, 3).map(function (w) { return h('span', { class: 'tag', text: w.name }); }),
              has.length > 3 ? h('span', { class: 'faint', style: 'font-size:13px', text: '+' + (has.length - 3) + ' more' }) : null,
              h('span', { class: 'faint', style: 'font-size:12px', text: '· ' + has.length + ' of ' + workers.length }))
          : h('span', { class: 'faint', style: 'font-size:13px', text: 'Nobody yet' });
        var open_ = function () { manage(t); };
        return h('tr', { class: 'link' + (has.length || t.access === 'everyone' ? '' : ' dim'), tabindex: '0', 'aria-label': 'Manage ' + t.name, onclick: open_, onkeydown: function (e) { if (e.key === 'Enter') open_(); } },
          h('td', null, h('div', { class: 'stack', style: 'gap:2px' }, h('b', { text: t.name }), h('span', { class: 'faint', style: 'font-size:12px', text: (t.kind === 'http' ? 'Remote' : 'Command') + (t.signIn ? ' · signed in by ' + t.signIn.by : '') + (onThisMac(t) ? ' · runs a file on a Mac' : '') }))),
          h('td', null, h('span', { class: 'tstate ' + st.tone }, h('span', { class: 'light' + (st.tone === 'ok' ? ' ok' : st.tone ? ' bad' : '') }), st.text)),
          h('td', null, h('span', { class: 'tag' + (t.access === 'everyone' ? ' go' : ''), text: LEVEL[t.access] || t.access })),
          h('td', null, who));
      };
      var draw = function () {
        chips.textContent = '';
        [['all', 'All'], ['need', 'Need you'], ['everyone', 'Every worker'], ['nobody', 'Nobody has it']].forEach(function (c) {
          if (c[0] !== 'all' && !counts[c[0]]) return;
          chips.appendChild(h('button', { class: 'chip', 'aria-pressed': filter === c[0] ? 'true' : 'false', text: c[1] + ' · ' + counts[c[0]], onclick: function () { filter = c[0]; state.toolsFilter = c[0]; draw(); } }));
        });
        var words = q.value.trim().toLowerCase();
        // A worker's name narrows to that worker's tools.
        var worker = words ? workers.filter(function (w) { return w.name.toLowerCase() === words || w.name.toLowerCase().indexOf(words) === 0; })[0] : null;
        var shown = r.tools.filter(function (t) {
          if (filter === 'need' && !needYou(t)) return false;
          if (filter === 'everyone' && t.access !== 'everyone') return false;
          if (filter === 'nobody' && (t.access === 'everyone' || holders(t).length)) return false;
          if (!words) return true;
          if (t.name.toLowerCase().indexOf(words) >= 0) return true;
          return !!worker && (t.access === 'everyone' || (worker.tools || []).some(function (x) { return x.name === t.name; }));
        });
        body.replaceChildren.apply(body, shown.length ? shown.map(row) : [h('tr', null, h('td', { colspan: '5', class: 'muted', style: 'padding:24px 18px;text-align:center', text: r.tools.length ? 'No tools match.' : 'Nothing installed yet. Workers here use only their built-in tools: files, the shell (as allowed) and the web.' }))]);
      };
      q.oninput = draw;
      draw();

      // One tool, opened: its state, what it can do, who can use it, and
      // every worker with a box — searchable, grouped by team.
      var manage = function (t) {
        openReader(t.name, t.target, function (put) {
          var out = h('div', { 'aria-live': 'polite' });
          var st = stateOf(t), step = nextStep(t);
          var actions = h('div', { class: 'faint', text: 'Reading what it can do…' });
          api('GET', '/api/tools/' + encodeURIComponent(t.name) + '/calls').then(function (c) {
            actions.textContent = '';
            if (!c || c.ok === false || !Array.isArray(c.tools)) { actions.appendChild(h('span', { class: 'faint', text: 'Its actions show once it connects (Check all).' })); return; }
            var WRITE = /(^|_)(send|create|update|delete|remove|post|reply|add|edit|set|write|move|archive|invite|transition|assign|comment|upsert|insert|patch|put|merge|publish|close|execute|run|submit|approve|upload|share|schedule)(_|$)/i;
            var names = c.tools.map(function (x) { return x.name; });
            var writes = names.filter(function (n) { return WRITE.test(n.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[-\s]/g, '_')); });
            var reads = names.filter(function (n) { return writes.indexOf(n) < 0; });
            append(actions, [h('div', { class: 'row', style: 'gap:6px' },
              reads.length ? h('span', { class: 'tag', text: 'Reads: ' + reads.length }) : null,
              writes.length ? h('span', { class: 'tag need', text: 'Changes: ' + writes.slice(0, 6).join(', ') + (writes.length > 6 ? ' +' + (writes.length - 6) : '') }) : h('span', { class: 'tag go', text: 'Only reads' }))]);
          });
          var level = h('select', { 'aria-label': 'Who can use ' + t.name },
            [['picked', 'Workers you pick'], ['managers', 'Any manager can give it'], ['everyone', 'Every worker']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: t.access === o[0] }); }));
          level.onchange = function () {
            var to = level.value;
            if (to === 'everyone' && !window.confirm('Every worker, including future hires, gets ' + t.name + '.' + (t.secrets.length ? '\n\nIt uses ' + t.secrets.join(', ') + ': every worker acts with that key.' : '') + '\n\nWorkers that ask first still ask before a step that changes something.')) { level.value = t.access; return; }
            api('GET', '/api/admin/rules').then(function (R) {
              if (R.ok === false) { out.textContent = ''; out.appendChild(msg(R)); return; }
              var allowed = (R.rules.allowedMcpServers || []).filter(function (n) { return n !== t.name; });
              var shared = (R.rules.sharedMcpServers || []).filter(function (n) { return n !== t.name; });
              if (to === 'managers') allowed.push(t.name);
              if (to === 'everyone') shared.push(t.name);
              return api('POST', '/api/admin/rules', { patch: { allowedMcpServers: allowed, sharedMcpServers: shared } }).then(function (x) {
                out.textContent = ''; out.appendChild(msg(x, 'Saved.'));
                if (x.ok !== false) { t.access = to; draw(); drawList(); }
              });
            });
          };
          // Give or take, one worker at a time.
          var give = function (w, on) {
            var list = (w.tools || []).filter(function (x) { return !x.shared; }).map(function (x) { return x.name; }).filter(function (n) { return n !== t.name; });
            if (on) list.push(t.name);
            return api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { mcpServers: list } }).then(function (x) {
              if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); return x; }
              w.tools = (w.tools || []).filter(function (y) { return y.name !== t.name || y.shared; });
              if (on) w.tools.push({ name: t.name, ok: true });
              return x;
            });
          };
          var find = h('input', { type: 'search', placeholder: 'Find a worker, team or manager', 'aria-label': 'Find a worker' });
          var showAll = false;
          var listBox = h('div', { class: 'tl-list' });
          var teamPick = teams.length ? h('select', { 'aria-label': 'Give to a team' }, [h('option', { value: '', text: 'Give to a team…' })].concat(teams.map(function (tm) { return h('option', { value: tm.id, text: tm.name + ' (' + tm.members.length + ')' }); }))) : null;
          if (teamPick) teamPick.onchange = function () {
            var tm = teams.filter(function (x) { return x.id === teamPick.value; })[0];
            if (!tm) return;
            teamPick.disabled = true;
            var names = tm.members.map(function (m) { return m.name; });
            var targets = workers.filter(function (w) { return names.indexOf(w.name) >= 0 && !(w.tools || []).some(function (x) { return x.name === t.name; }); });
            targets.reduce(function (p, w) { return p.then(function () { return give(w, true); }); }, Promise.resolve()).then(function () {
              teamPick.disabled = false; teamPick.value = '';
              out.textContent = ''; out.appendChild(msg({}, targets.length ? 'Gave ' + t.name + ' to ' + plural(targets.length, 'worker', 'workers') + ' on ' + tm.name + '.' : 'Everyone on ' + tm.name + ' already has it.'));
              draw(); drawList();
            });
          };
          var drawList = function () {
            listBox.textContent = '';
            if (t.access === 'everyone') { listBox.appendChild(h('p', { class: 'muted', style: 'padding:12px', text: 'Every worker has it. Choose Workers you pick to give it one by one.' })); return; }
            var words = find.value.trim().toLowerCase();
            var teamOf = function (w) { return teams.filter(function (tm) { return tm.members.some(function (m) { return m.name === w.name; }); }).map(function (tm) { return tm.name; }); };
            var match = workers.filter(function (w) {
              var has = (w.tools || []).some(function (x) { return x.name === t.name; });
              if (!showAll && !words && !has) return false;
              return !words || (w.name + ' ' + (w.tagline || '') + ' ' + (w.manager || '') + ' ' + teamOf(w).join(' ')).toLowerCase().indexOf(words) >= 0;
            });
            var groups = {};
            match.forEach(function (w) { var g = teamOf(w)[0] || (w.manager ? 'Managed by ' + w.manager : 'No team'); (groups[g] = groups[g] || []).push(w); });
            Object.keys(groups).sort().forEach(function (g) {
              listBox.appendChild(h('div', { class: 'tl-group', text: g + ' · ' + groups[g].length }));
              groups[g].forEach(function (w) {
                var box = h('input', { type: 'checkbox', checked: (w.tools || []).some(function (x) { return x.name === t.name; }) });
                box.onchange = function () { box.disabled = true; give(w, box.checked).then(function (x) { box.disabled = false; if (x.ok === false) box.checked = !box.checked; draw(); }); };
                listBox.appendChild(h('label', { class: 'tl-row' }, box, h('span', { style: 'flex:1;min-width:0' }, h('b', { style: 'font-weight:500', text: w.name }), h('span', { class: 'faint', style: 'font-size:13px', text: (w.tagline ? ' · ' + w.tagline : '') + (w.manager ? ' · ' + w.manager : '') }))));
              });
            });
            if (!match.length) listBox.appendChild(h('p', { class: 'muted', style: 'padding:12px', text: words ? 'No worker matches.' : 'Nobody has it yet. Show everyone to give it.' }));
          };
          find.oninput = drawList;
          var toggleAll = h('button', { class: 'chip', 'aria-pressed': 'false', text: 'Show everyone · ' + workers.length });
          toggleAll.onclick = function () { showAll = !showAll; toggleAll.setAttribute('aria-pressed', showAll ? 'true' : 'false'); drawList(); };
          drawList();
          // A remote tool: who signed it in, and signing it in (again).
          var signed = t.kind === 'http' && r.canEdit && r.signIn ? (function () {
            var b = h('button', { class: 'btn small' + (t.signIn && !t.signIn.ended ? '' : ' go'), text: t.signIn ? 'Sign in again' : 'Sign in for everyone' });
            b.onclick = function () { signInTool({ name: t.name, url: t.target }, b, out); };
            var line = t.signIn
              ? (t.signIn.ended ? 'Signed out. ' : 'Signed in by ' + t.signIn.by + ' ' + ago(t.signIn.at) + ', at ' + t.signIn.issuer + '. Renews itself.')
              : t.secrets.length ? 'Uses a pasted key. If it signs in through a browser instead, sign it in here and the key is replaced.' : 'Not signed in. If it asks for a sign-in, do it here, once, for every worker that has it.';
            return h('section', { class: 'stack', style: 'gap:6px' }, h('div', { class: 't-kind', text: 'Sign-in' }),
              h('span', { style: 'font-size:13.5px', text: line }), h('div', null, b));
          })() : null;
          var removeBtn = h('button', { class: 'btn small danger', text: 'Remove tool', onclick: function () {
            if (!window.confirm('Remove ' + t.name + '? Workers that use it carry on without it.')) return;
            api('POST', '/api/admin/tools/' + encodeURIComponent(t.name) + '/remove').then(function (x) { if (x.ok === false) { out.textContent = ''; out.appendChild(msg(x)); } else { document.getElementById('reader').remove(); render(); } });
          } });
          var scopeBox = r.canEdit ? toolScopeSection(t, workers) : null;
          put([h('div', { class: 'stack', style: 'gap:18px' },
            h('section', { class: 'stack', style: 'gap:6px' }, h('div', { class: 't-kind', text: 'State' }), h('span', { class: 'tstate ' + st.tone }, h('span', { class: 'light' + (st.tone === 'ok' ? ' ok' : st.tone ? ' bad' : '') }), st.text + (r.checkedAt ? ' · checked ' + ago(r.checkedAt) : '')), step ? h('p', { class: 'muted', style: 'margin:0;font-size:13.5px', text: step }) : null),
            signed,
            h('section', { class: 'stack', style: 'gap:6px' }, h('div', { class: 't-kind', text: 'What it can do' }), actions),
            r.canEdit ? h('section', { class: 'stack', style: 'gap:6px' }, h('div', { class: 't-kind', text: 'Who can use it' }), level) : null,
            scopeBox,
            h('section', { class: 'stack', style: 'gap:8px' },
              h('div', { class: 'spread' }, h('div', { class: 't-kind', text: 'Workers who have it' }), r.canEdit ? teamPick : null),
              h('div', { class: 'row', style: 'gap:8px' }, h('span', { style: 'flex:1 1 220px' }, find), toggleAll),
              listBox),
            t.secrets.length && !t.signIn ? h('section', { class: 'stack', style: 'gap:6px' }, h('div', { class: 't-kind', text: 'Keys' }), h('span', { style: 'font-size:13.5px', text: t.secrets.join(', ') + ' (values hidden)' })) : null,
            r.canEdit ? h('div', null, removeBtn) : null,
            out)]);
        });
      };

      var mac = r.tools.filter(onThisMac), auth = r.tools.filter(function (t) { return t.status === 'needs-auth'; }), nobody = r.tools.filter(function (t) { return t.access !== 'everyone' && !holders(t).length; });
      var needCard = function (tone, title, items, text) {
        return items.length ? h('div', { class: 'need-card ' + tone }, h('span', { class: 't-kind', text: title + ' · ' + items.length }), h('span', { style: 'font-size:13.5px' }, h('b', { text: items.map(function (t) { return t.name; }).join(', ') }), ' ' + text)) : null;
      };
      var ended = r.tools.filter(function (t) { return t.signIn && t.signIn.ended; });
      var cards = [needCard('need', 'Signed out', ended, '— open it and sign in again.'),
        needCard('need', 'Needs a sign-in', auth, r.signIn ? '— open it and sign it in for everyone.' : '— run “claude mcp” on this Mac and sign in.'),
        needCard('need', 'Only works on this Mac', mac, '— fine here; reinstall from a package for a real server.'),
        needCard('', 'Nobody has it', nobody, '— open it to give it to a worker, or remove it.')].filter(Boolean);
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
      var hq = state.hashQuery;
      var flash = hq && hq.get('signedin') ? msg({}, 'Signed in. ' + hq.get('signedin') + ' is installed; open it below to give it to workers.')
        : hq && hq.get('signin-error') ? msg({ ok: false, error: (hq.get('tool') ? hq.get('tool') + ': ' : '') + (TOOL_SIGNIN_ERR[hq.get('signin-error')] || 'The sign-in didn’t finish.') }) : null;
      return [head('Tools', 'The MCP servers workers here can use, and which workers have each.'),
        flash,
        cards.length ? h('div', { class: 'need-cards' }, cards) : null,
        missing,
        h('section', { class: 'panel', style: 'padding:0;overflow:hidden' },
          h('div', { class: 'spread', style: 'padding:12px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap;gap:10px' }, chips,
            h('div', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, q, r.canEdit ? check : null, r.canEdit ? h('button', { class: 'btn go small', onclick: function () { addPanel.hidden = false; addPanel.scrollIntoView({ behavior: 'smooth' }); } }, icon('plus', 14), 'Install a tool') : null)),
          checkOut,
          h('div', { style: 'overflow-x:auto' }, h('table', { class: 'data tools-table' },
            h('thead', null, h('tr', null, h('th', { text: 'Tool' }), h('th', { text: 'State' }), h('th', { text: 'Who can use it' }), h('th', { text: 'Who has it' }))),
            body)),
          h('p', { class: 'faint', style: 'margin:0;padding:12px 18px;border-top:1px solid var(--line);font-size:13px', text: 'Click a tool to give or take it worker by worker, or a whole team at once. Type a worker’s name above to see just its tools. A worker on Asks first still asks before any step that changes something.' })),
        addPanel];
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
