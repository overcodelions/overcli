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
.side-hire { width: 100%; margin-bottom: 12px; }
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
.main { padding: 32px clamp(20px, 3vw, 56px) 64px; }
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
.tpage { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.trail { flex: 0 0 300px; max-width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); overflow: hidden; position: sticky; top: 76px; }
.tmain { flex: 999 1 560px; min-width: 0; }
.trow { display: flex; gap: 10px; align-items: flex-start; width: 100%; padding: 10px 14px; border: 0; border-left: 2px solid transparent; background: none; text-align: left; font: inherit; color: var(--ink); cursor: pointer; }
.trow:hover { background: var(--panel-2); }
.trow.on { background: var(--panel-2); border-left-color: var(--go); }
.trow b { font-weight: 600; font-size: 13.5px; }
.tdot { width: 22px; height: 22px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; background: var(--line); color: var(--muted); }
.tdot.done { background: var(--ok-soft); color: var(--ok); } .tdot.part { background: var(--need-soft); color: var(--need); } .tdot.failed { background: var(--bad-soft); color: var(--bad); }
.tdot.now { background: var(--go); color: var(--go-ink); } .tdot.need { background: var(--need); color: var(--need-ink); }
.stage-head { padding: 16px 18px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.stage-title { margin: 0; font-family: var(--serif); font-size: 19px; font-weight: 600; }
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
    alert: [['circle', 12, 12, 9], ['path', 'M12 7v6M12 16.5v.5']],
    arrow: [['path', 'M4 12h12M12 6l6 6-6 6']],
    library: [['path', 'M5 4h4v16H5zM10 4h4v16h-4z'], ['path', 'M15.5 5.2l3.8-1 3.2 15.6-3.8 1z']],
    bolt: [['path', 'M13 3L5 14h6l-1 7 8-11h-6z']],
    bars: [['path', 'M4 20h16M7 16v-5M12 16V6M17 16v-8']],
    clock: [['circle', 12, 12, 9], ['path', 'M12 7v5l3 2']],
    lock: [['path', 'M6 11h12v9H6z'], ['path', 'M9 11V8a3 3 0 0 1 6 0v3']],
    search: [['circle', 11, 11, 7], ['path', 'M20 20l-3.5-3.5']],
    bell: [['path', 'M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9'], ['path', 'M10 20.5h4']],
    slack: [['path', 'M4 6h16v10H9l-5 4z']]
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
    return { worker: 'workers', team: 'teams', newteam: 'teams', teamtask: 'teams', teamfiles: 'teams', read: 'library', chart: 'workers', work: 'today', tools: 'setup', rules: 'setup', log: 'admin' }[tab] || tab;
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
    var main = h('div', { class: 'page' + ({ hire: 1, connect: 1 }[state.tab] ? ' narrow' : '') }, thinking('Loading…'));
    var activeTab = navFor(state.tab);
    app.appendChild(h('div', { class: 'frame' },
      topBar(me),
      h('aside', { class: 'side' },
        me.canHire ? h('button', { class: 'btn go side-hire', 'aria-current': state.tab === 'hire' ? 'page' : null, onclick: function () { go('hire'); } }, icon('plus', 16), 'Hire a worker') : null,
        h('nav', { class: 'nav', 'aria-label': 'Sections' }, tabs().map(function (t) {
          if (t === 'sep') return h('div', { class: 'sep', 'aria-hidden': 'true' });
          if (t.group) return h('div', { class: 'group', text: t.group });
          return h('button', { 'aria-current': activeTab === t.id ? 'page' : null, onclick: function () { go(t.id); } },
            icon(t.icon), t.label,
            t.count ? h('span', { class: 'count', 'data-count': t.count, hidden: !state.counts[t.count], text: state.counts[t.count] ? String(state.counts[t.count]) : '' }) : null,
            t.issue ? h('span', { class: 'issue', 'data-issue': t.issue, hidden: !state.counts[t.issue], text: state.counts[t.issue] ? plural(state.counts[t.issue], 'issue', 'issues') : '' }) : null);
        }))),
      h('main', { class: 'main' }, main)));
    refreshCounts();
    if (state.tab === 'tools' || state.tab === 'rules') { state.setupTab = state.tab; state.tab = 'setup'; }
    var view = { today: viewToday, work: viewWork, workers: viewWorkers, worker: viewWorker, teams: viewTeams, newteam: viewNewTeam, team: viewTeam, teamtask: viewTeamTask, teamfiles: viewTeamFiles, connections: viewConnections, read: viewRead, file: viewFile, chart: viewChart, hire: viewHire, people: viewPeople, admin: viewAdmin, connect: viewConnect, rules: viewRules, log: viewLog, tools: viewTools, setup: viewSetup, library: viewLibrary, reports: viewReports }[state.tab] || viewToday;
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
    return Promise.all([api('GET', '/api/today'), api('GET', '/api/tools').catch(function () { return { ok: false }; }), api('GET', '/api/workers'), api('GET', '/api/library').catch(function () { return []; })]).then(function (r) {
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
      nodes.push(h('div', { class: 'split' },
        h('div', { class: 'wide stack', style: 'gap:16px' },
          (function () {
            var box = h('div', { hidden: true });
            onNow(box, function (items) {
              box.textContent = '';
              box.hidden = !items.length;
              if (!items.length) return;
              append(box, card('working', 'Working now', h('span', { class: 'faint', text: plural(items.length, 'thing', 'things') }), h('div', null, items.map(workingRow)), true));
            });
            return box;
          })(),
          card('needs', 'Needs you', needs ? h('span', { class: 'tag need', text: String(needs) }) : null,
            needs ? [fixes.map(fixCard), t.waiting.map(waitingCard), t.proposals.map(proposalCard), t.hireApprovals.map(hireApprovalCard), mineTasks.map(teamTaskCard)]
              : h('div', { class: 'empty' }, h('div', { class: 'quote', text: 'You’re all caught up.' }),
                  h('p', { text: t.crew.length ? 'Questions, approvals and proposed work from your workers land here.' : 'Hire a worker and what it needs from you lands here.' }),
                  !t.crew.length && state.me.canHire ? h('div', { style: 'margin-top:14px' }, h('button', { class: 'btn go', text: 'Hire your first worker', onclick: function () { go('hire'); } })) : null), true)),
        h('aside', { class: 'narrow' },
          card('came', 'Came in', h('button', { class: 'linkish', text: 'Library →', onclick: function () { go('library'); } }),
            cameIn.length ? cameIn.slice(0, 6).map(cameInRow).concat(cameIn.length > 6 ? [h('button', { class: 'linkish camemore', text: '+ ' + (cameIn.length - 6) + ' more in the Library', onclick: function () { go('library'); } })] : []) : h('p', { class: 'muted', text: 'Nothing since yesterday.' }), true),
          card('month', 'Your workers this month', null, [
            h('div', { class: 'row', style: 'align-items:baseline' }, h('span', { class: 'big', text: money(t.spend.spentUSD) }),
              h('span', { class: 'muted', text: (t.spend.allowanceUSD != null ? 'of ' + money(t.spend.allowanceUSD) + ' · ' : '') + 'on track for ' + money(t.spend.projectedUSD) })),
            t.spend.allowanceUSD ? h('div', { class: 'meter' + (pct >= 85 ? ' high' : '') }, h('span', { style: 'width:' + pct.toFixed(0) + '%' })) : null]),
          upcoming.length ? card('next', 'Coming up', null,
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

  /// Slack's link markup, as text: older requests were kept with it.
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
        h('div', { class: 'wl-detail-body' }, threadCard(t, w, ctx),
          liveRun ? h('section', { class: 'stack', style: 'gap:8px;margin-top:14px' }, h('div', { class: 't-kind', text: 'What it’s doing' }), liveRunView(liveRun.runId, true)) : null),
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
          api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: patch })
            .then(function (x) { restore(); saved.textContent = ''; saved.appendChild(msg(x, 'Saved. It applies from its next run.')); });
        };
        settings = h('div', { class: 'stack', style: 'gap:16px' },
          group('Picture', 'Its face here and on what it posts in Slack. Pick one, or use a link to your own image.', [picturePicker(w, function (url) { return api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/update', { patch: { avatarUrl: url } }); },
            function () { return api('POST', '/api/workers/' + encodeURIComponent(w.id) + '/picture/pick', {}); })]),
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

  function viewTeams() {
    return Promise.all([api('GET', '/api/teams'), api('GET', '/api/team-tasks'), api('GET', '/api/workers'), api('GET', '/api/repos'), api('GET', '/api/teams/runs').catch(function () { return {}; })]).then(function (r) {
      var teams = r[0], tasks = r[1], workers = r[2], places = r[3] && r[3].ok !== false ? r[3] : { repos: [], workspaces: [] };
      var making = r[4] && Array.isArray(r[4].runs) ? r[4].runs : [];
      var intro = 'Give a team a task. Its coordinator asks what it needs, proposes a plan for you to approve, then runs the members through it. Questions and plans reach you here and in Slack.';
      var openMaker = function () { go('newteam', { teamRunId: null }); };
      // Teams still being made: how far their hiring has got.
      var makingCards = making.map(function (run) {
        var done = run.hires.filter(function (g) { return g.state !== 'drafting'; }).length;
        return h('article', { class: 'tmcard' },
          h('div', { style: 'min-width:0' }, h('span', { class: 'tmname', text: run.name }),
            h('p', { class: 'tmpurpose', text: run.status === 'needsYou' ? 'A hire didn’t go through: retry it or skip it.' : 'Being made: ' + done + ' of ' + plural(run.hires.length, 'new member', 'new members') + ' hired.' })),
          h('div', { class: 'tmmeta' }, h('span', { class: 'tmlive' }, h('span', { class: 'livedot' }), run.status === 'needsYou' ? 'Needs you' : 'Hiring')),
          h('div', { class: 'tmfoot' }, h('button', { class: 'btn small', text: 'Open', onclick: function () { go('newteam', { teamRunId: run.id }); } })));
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
        return h('article', { class: 'tmcard' },
          h('div', { style: 'min-width:0' },
            h('span', { class: 'row', style: 'gap:10px;flex-wrap:nowrap' }, PICTURES[t.id] ? avatar(t.id, t.name, 'm') : null,
              h('button', { class: 'linkish tmname', text: t.name, onclick: function () { go('team', { teamId: t.id }); } })),
            t.purpose ? h('p', { class: 'tmpurpose', text: t.purpose }) : null),
          h('div', { class: 'tmmeta' },
            h('span', { class: 'faces', title: t.members.map(function (m) { return m.name; }).join(', ') }, t.members.slice(0, 6).map(function (m) { return avatar(m.name, m.name, 's'); })),
            h('span', { class: 'faint tmstats', text: [plural(t.members.length, 'member', 'members'), plural(mine.length, 'task', 'tasks'), money(spent) + ' spent'].concat(last ? ['delivered ' + ago(last)] : []).join(' · ') }),
            running ? h('span', { class: 'tmlive' }, h('span', { class: 'livedot' }), running + ' running') : null),
          h('div', { class: 'tmfoot' },
            t.canBrief ? h('button', { class: 'btn small go', text: 'Give it a task', onclick: function () { go('team', { teamId: t.id, teamFocusBrief: true }); } }) : null,
            h('button', { class: 'btn small', text: 'Open', onclick: function () { go('team', { teamId: t.id }); } })));
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

  // ---- one team --------------------------------------------------------

  /// A shared file of a team task, read when opened.
  function teamFile(taskId, name, label) {
    var body = h('div', { class: 'wc-out' }, h('span', { class: 'faint', text: 'Loading…' }));
    var d = h('details', { class: 't-report' }, h('summary', null, label || 'Read ', h('code', { text: name })), body);
    var loaded = false;
    var key = taskId + '/' + name;
    var show = function (text) { body.textContent = ''; body.appendChild(/\.(md|markdown|txt)$/i.test(name) ? md(text) : h('pre', { text: text })); };
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
          h('span', null, h('button', { class: 'linkish', style: 'color:var(--ink);font-weight:600', text: p.workerName, onclick: function () { openWorker(p.workerId); } }),
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
            h('div', { class: 'faint', style: 'margin-top:2px', text: (task.requestedBy && task.requestedBy !== me ? task.requestedBy : 'You') + ' asked' + (task.title && task.title !== task.brief ? ' “' + task.brief + '”' : '') + ' · ' + when(task.createdAt) })),
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

  /// One team task, on its own page: its stages down the side, the chosen
  /// stage's members and what each wrote, and the folder it is building.
  function viewTeamTask() {
    var id = state.taskId;
    return Promise.all([api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/page'), api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/files').catch(function () { return { ok: false }; })]).then(function (r) {
      var x = r[0], fx = r[1];
      if (x.ok === false) return [msg(x)];
      var team = x.team;
      var head_ = h('div'), rail = h('nav', { class: 'trail', 'aria-label': 'Stages' }), stage = h('div', { class: 'stack', style: 'gap:16px' });
      var timer = null;
      var draw = function (task, files) {
        var cur = task.stagesDetail.filter(function (s) { return s.current; })[0];
        var pick = state.taskStage != null ? state.taskStage : cur ? task.stagesDetail.indexOf(cur) : Math.max(0, task.stagesDetail.length - 1);
        var done = task.status === 'done';
        // The pack is written and held for you: read it, then accept it.
        var review = task.status === 'review';
        var stopOut = h('span');
        var accept = function (e) {
          var restore = busy(e.target, 'Accepting…');
          api('POST', '/api/team-tasks/' + encodeURIComponent(task.id), { kind: 'accept' }).then(function (y) { restore(); stopOut.replaceChildren(msg(y, 'Accepted. The task is done.')); refresh(); });
        };
        var stop = review ? h('button', { class: 'btn go', text: 'Accept the pack', onclick: accept })
          : !done && task.status !== 'failed' && task.status !== 'cancelled' ? h('button', { class: 'btn danger', text: 'Stop the task', onclick: function (e) {
          if (!confirm('Stop this task? Work already written stays in its folder.')) return;
          var restore = busy(e.target, 'Stopping…');
          api('POST', '/api/team-tasks/' + encodeURIComponent(task.id), { kind: 'cancel' }).then(function (y) { restore(); stopOut.replaceChildren(msg(y, 'Stopped.')); refresh(); });
        } }) : null;
        var nFiles = files && files.ok !== false ? files.files.length : null;
        head_.replaceChildren(h('header', { class: 'page-head' },
          h('div', { style: 'min-width:0;max-width:860px' },
            h('div', { class: 'eyebrow' }, h('button', { class: 'linkish', style: 'font-size:12.5px', text: 'Teams', onclick: function () { go('teams'); } }), ' / ',
              h('button', { class: 'linkish', style: 'font-size:12.5px', text: team.name, onclick: function () { go('team', { teamId: team.id }); } }), ' / Task'),
            h('div', { class: 'row', style: 'gap:12px' }, h('h1', { class: 'page-title', text: task.title || task.brief }), taskBadge(task)),
            h('p', { class: 'page-sub', text: (task.requestedBy && task.requestedBy !== (state.me && state.me.name) ? task.requestedBy : 'You') + ' asked “' + task.brief + '” · ' + when(task.createdAt) })),
          h('div', { class: 'page-actions' }, spendBar(task),
            h('button', { class: 'btn', onclick: function () { go('teamfiles', { taskId: task.id }); } }, icon('doc', 16), 'Shared folder' + (nFiles != null ? ' · ' + nFiles : '')),
            stop, stopOut)));
        var needs = teamTaskControls(task, h('div'), refresh);
        fill(rail, [h('div', { class: 'sec-head' }, h('h2', { class: 'label', text: 'Stages' }), h('span', { class: 'faint', text: task.stagesDetail.filter(function (s) { return s.status === 'done'; }).length + ' of ' + task.stagesDetail.length + ' done' })),
          task.stagesDetail.length ? task.stagesDetail.map(function (s, i) {
            var c = stageClass(task, s);
            var took = s.finishedAt && s.startedAt ? secs(s.finishedAt - s.startedAt) : s.startedAt && (c === 'now' || c === 'need') ? secs(Date.now() - s.startedAt) : '';
            return h('button', { class: 'trow' + (i === pick ? ' on' : ''), 'aria-current': i === pick ? 'step' : null, onclick: function () { state.taskStage = i; draw(task, files); } },
              h('span', { class: 'tdot ' + c, text: c === 'done' ? '✓' : c === 'failed' ? '✕' : c === 'part' ? '!' : c === 'now' || c === 'need' ? '' : String(i + 1) }),
              h('span', { class: 'stack', style: 'gap:0;min-width:0;flex:1' }, h('b', { text: (i + 1) + '. ' + (s.title || s.label) }), h('span', { class: 'faint', text: s.pieces.length ? s.pieces.map(function (p) { return p.workerName; }).join(', ') : 'Coordinator' })),
              h('span', { class: 'faint', text: took }));
          }) : h('p', { class: 'muted', style: 'padding:14px 16px', text: task.status === 'planning' ? 'The coordinator is planning the stages.' : 'No stages yet.' })]);
        var s = task.stagesDetail[pick];
        var limit = slowAfter(task);
        // Redrawn while you read: what you opened stays open and scrolled,
        // and the page stays where you were (keepPlace; the scroll below).
        var y = window.scrollY;
        var was = h('div');
        while (stage.firstChild) was.appendChild(stage.firstChild);
        fill(stage, [
          needs ? card('taskneeds', 'Needs you', null, needs) : null,
          (done || review) && task.pack ? card('delivered', review ? 'Ready for your review' : 'What the team delivered', null, [md(task.pack.summary), task.pack.files.map(function (f) { return teamFile(task.id, f, 'Read '); }),
            review ? h('div', { class: 'row', style: 'gap:10px;margin-top:6px' }, h('button', { class: 'btn go', text: 'Accept the pack', onclick: accept }), h('span', { class: 'faint', text: 'Read it first. Accepting marks the task done.' })) : null]) : null,
          task.error ? h('div', { class: 'msg err', text: task.error }) : null,
          s ? h('section', { class: 'sec', 'aria-labelledby': 'stagehead' },
            h('div', { class: 'stage-head' },
              h('div', { class: 'row', style: 'justify-content:space-between;gap:12px' }, h('h2', { id: 'stagehead', class: 'stage-title', text: (pick + 1) + '. ' + (s.title || s.label) }),
                h('span', { class: 'faint', text: s.label + (s.finishedAt && s.startedAt ? ' · took ' + secs(s.finishedAt - s.startedAt) : '') })),
              s.file ? teamFile(task.id, s.file, 'Read the coordinator’s ') : null),
            s.pieces.length ? h('div', { class: 'prows' }, s.pieces.map(function (p) { return pieceRow(task, p, limit, refresh); }))
              : h('p', { class: 'muted', style: 'padding:14px 18px;margin:0', text: 'The coordinator does this stage itself.' })) : null,
          task.code ? card('taskcode', 'Code', null, teamCode(task)) : null,
          files && files.ok !== false && files.files.length ? card('taskfiles', 'What it has written', h('button', { class: 'linkish', text: 'Open the folder →', onclick: function () { go('teamfiles', { taskId: task.id }); } }),
            h('div', { class: 'fgrid' }, files.files.slice(0, 8).map(function (f) {
              return h('button', { class: 'linkish fname', text: f.name, onclick: function () { go('teamfiles', { taskId: task.id, teamFilePick: f.name }); } });
            }), files.files.length > 8 ? h('span', { class: 'faint', text: '+ ' + (files.files.length - 8) + ' more' }) : null)) : null]);
        if (was.firstChild) { keepPlace(was, stage); requestAnimationFrame(function () { window.scrollTo(0, y); }); }
        lastKey = taskKey(task, files);
        clearTimeout(timer);
        if (task.status === 'running' || task.status === 'planning' || task.status === 'waiting') timer = setTimeout(refresh, 5000);
      };
      // What the page shows, in short: a refresh that changes none of it
      // draws nothing, so the page stays still under the reader.
      var lastKey = '';
      var taskKey = function (task, files) {
        return JSON.stringify([task.status, task.stageIndex, task.waitingOnYou, task.piecesNeedYou, task.error || '',
          task.stagesDetail.map(function (s) { return [s.status, s.file || '', s.pieces.map(function (p) { return [p.status, !!p.waiting, p.step ? p.step.index : 0, p.file || '']; })]; }),
          files && files.ok !== false ? files.files.length : -1]);
      };
      var refresh = function () {
        clearTimeout(timer);
        if (!stage.isConnected || state.tab !== 'teamtask' || state.taskId !== id) return;
        Promise.all([api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/page'), api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/files').catch(function () { return { ok: false }; })])
          .then(function (y) {
            if (y[0].ok === false || !stage.isConnected) return;
            if (taskKey(y[0].task, y[1]) === lastKey) { timer = setTimeout(refresh, 5000); return; }
            draw(y[0].task, y[1]);
          }, function () { timer = setTimeout(refresh, 10000); });
      };
      draw(x.task, fx);
      return [head_, h('div', { class: 'tpage' }, rail, h('div', { class: 'tmain' }, stage))];
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
    return h('div', { class: 'prow' + (slow ? ' slow' : '') },
      h('div', { class: 'prow-main' },
        avatar(p.workerId, p.workerName, 's'),
        h('div', { style: 'flex:1;min-width:0' },
          h('button', { class: 'linkish', style: 'color:var(--ink);font-weight:600', text: p.workerName, onclick: function () { openWorker(p.workerId); } }),
          h('details', { class: 'pask' }, h('summary', { text: p.ask.split(/(?<=[.!?])\s/)[0].slice(0, 160) }), h('p', { text: p.ask }))),
        h('div', { class: 'prow-acts' },
          meta ? h('span', { class: 'faint', text: meta }) : null,
          h('span', { class: 'badge ' + b[0], text: b[1] }),
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
            html && f.url ? h('a', { class: 'btn small quiet', href: f.url, target: '_blank', rel: 'noopener', text: 'Open in a new tab ↗' }) : null,
            KEPT(f)),
          said, box);
        if (drawer) drawer.replaceWith(panel); else { document.body.appendChild(panel); document.addEventListener('keydown', onKey); }
        drawer = panel;
        // An HTML report is shown as the page it is, from its own link, in a
        // sandbox: its styles and scripts run, but cannot reach the console.
        if (html && f.url) { box.replaceChildren(h('iframe', { class: 'drawer-frame', src: f.url, sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', title: f.name })); return; }
        if (img && f.url) { box.replaceChildren(h('img', { src: f.url, alt: f.name, style: 'max-width:100%;border-radius:8px' })); return; }
        api('GET', '/api/team-tasks/' + encodeURIComponent(id) + '/file?name=' + encodeURIComponent(f.name)).then(function (y) {
          if (drawer !== panel) return;
          box.replaceChildren(y.ok === false ? msg(y) : /\.(md|markdown|txt)$/i.test(f.name) ? md(y.body) : /\.json$/i.test(f.name) ? h('pre', { text: (function () { try { return JSON.stringify(JSON.parse(y.body), null, 2); } catch (e) { return y.body; } })() }) : h('pre', { text: y.body }));
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

  function liveRunView(runId, boxed) {
    var head_ = h('div', { class: 'watch-head' }, thinking('Connecting…'));
    var list = h('ol', { class: 'watch-list' + (boxed ? ' boxed' : '') });
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
    };
    raw.onclick = function () { state.showCommands = !state.showCommands; draw(); };
    var box = h('div', null, head_, h('div', { class: 'row', style: 'justify-content:flex-end;margin-bottom:6px' }, raw), list, empty);
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
    var kinds = h('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'What sets it off' });
    var parts = {};
    // Watch
    var server = h('select', { 'aria-label': 'Tool' }, h('option', { value: '', text: 'Loading tools…' }));
    var call = h('select', { 'aria-label': 'Call' }, h('option', { value: '', text: 'Pick a tool first' }));
    var args = h('textarea', { 'aria-label': 'Arguments (JSON)', placeholder: '{ "jql": "project = ACME AND sprint = \\"Support Backlog\\" AND statusCategory != Done" }', style: 'min-height:70px;font-family:var(--mono);font-size:12.5px' });
    var every = h('select', { 'aria-label': 'How often' }, [5, 10, 15, 30, 60].map(function (n) { return h('option', { value: String(n), text: 'every ' + n + ' min', selected: n === 15 }); }));
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
      h('div', { class: 'row', style: 'align-items:flex-end;gap:12px' }, h('label', { class: 'field', style: 'width:200px' }, 'How often to check', every), test),
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
    var KINDS = [['watch', 'Something new shows up in a tool', 'A new ticket, deal, row or message, checked every few minutes. Works anywhere.'],
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
    var postTo = h('input', { type: 'text', placeholder: 'Channel ID, e.g. C012AB3CD (optional)', 'aria-label': 'Post each result in this Slack channel' });
    var itself = h('input', { type: 'text', placeholder: 'e.g. Comment your triage on the ticket (optional)', 'aria-label': 'The worker delivers it itself' });
    var perDay = h('input', { type: 'number', min: '1', max: '500', value: '50', 'aria-label': 'At most per day' });
    var out = h('div', { 'aria-live': 'polite' });
    var save = h('button', { class: 'btn go', text: 'Save trigger' });
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
    return card('newtrig', 'New trigger for ' + w.name, h('button', { class: 'linkish', text: 'Cancel', onclick: done }), h('div', { class: 'form' },
      h('div', { class: 'fstep' }, h('label', { class: 'field', style: 'max-width:440px' }, 'Name', name)),
      h('div', { class: 'fstep' }, h('span', { class: 'label', text: '1 · What sets it off' }), kinds, kindBody),
      h('div', { class: 'fstep' }, h('span', { class: 'label', text: '2 · What it does with each one' }), instructions,
        h('p', { class: 'hint', text: 'It gets the event’s details with this. ' + (w.trust === 'probation' ? 'On probation, it proposes what it would do and waits for you.' : 'Trusted, it goes ahead.') })),
      h('div', { class: 'fstep' }, h('span', { class: 'label', text: '3 · Where the result goes' }),
        h('div', { class: 'grid2' }, h('label', { class: 'field' }, 'Post each result in a Slack channel', postTo), h('label', { class: 'field' }, 'Or the worker delivers it itself', itself)),
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
        h('div', null, h('button', { class: 'btn go', text: 'Connect', onclick: function (e) {
          var restore = busy(e.target, 'Cloning…');
          api('POST', '/api/repos', { url: url.value, testCommand: test.value }).then(function (x) {
            restore(); out.textContent = ''; out.appendChild(msg(x, (x.repo ? x.repo.name : 'The repo') + ' is connected. Point a worker at it below.'));
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
  /// it. Manage opens a side panel to give or take it, worker by worker or a
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
        return h('tr', { class: has.length || t.access === 'everyone' ? '' : 'dim' },
          h('td', null, h('div', { class: 'stack', style: 'gap:2px' }, h('b', { text: t.name }), h('span', { class: 'faint', style: 'font-size:12px', text: (t.kind === 'http' ? 'Remote' : 'Command') + (t.signIn ? ' · signed in by ' + t.signIn.by : '') + (onThisMac(t) ? ' · runs a file on a Mac' : '') }))),
          h('td', null, h('span', { class: 'tstate ' + st.tone }, h('span', { class: 'light' + (st.tone === 'ok' ? ' ok' : st.tone ? ' bad' : '') }), st.text)),
          h('td', null, h('span', { class: 'tag' + (t.access === 'everyone' ? ' go' : ''), text: LEVEL[t.access] || t.access })),
          h('td', null, who),
          h('td', { style: 'text-align:right' }, h('button', { class: 'btn small', text: 'Manage', onclick: function () { manage(t); } })));
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
      var cards = [needCard('need', 'Signed out', ended, '— open it with Manage and sign in again.'),
        needCard('need', 'Needs a sign-in', auth, r.signIn ? '— open it with Manage and sign it in for everyone.' : '— run “claude mcp” on this Mac and sign in.'),
        needCard('need', 'Only works on this Mac', mac, '— fine here; reinstall from a package for a real server.'),
        needCard('', 'Nobody has it', nobody, '— give it to a worker with Manage, or remove it.')].filter(Boolean);
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
      var flash = hq && hq.get('signedin') ? msg({}, 'Signed in. ' + hq.get('signedin') + ' is installed; give it to workers with Manage.')
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
            h('thead', null, h('tr', null, h('th', { text: 'Tool' }), h('th', { text: 'State' }), h('th', { text: 'Who can use it' }), h('th', { text: 'Who has it' }), h('th'))),
            body)),
          h('p', { class: 'faint', style: 'margin:0;padding:12px 18px;border-top:1px solid var(--line);font-size:13px', text: 'Manage opens a tool: give or take it worker by worker, or a whole team at once. Type a worker’s name above to see just its tools. A worker on Asks first still asks before any step that changes something.' })),
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
