/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Semantic colors driven by CSS custom properties so the whole app
      // switches theme by toggling `html.dark`. The palette definitions
      // live in src/renderer/styles.css under `:root` (light) and
      // `:root.dark` (dark).
      //
      // Wrapped in `color-mix` with `<alpha-value>` rather than written as a
      // bare `var(--c-*)`. Tailwind 3 cannot apply an opacity modifier to a
      // bare `var()` colour — it DROPS the utility — so `bg-accent/15` used to
      // compile to nothing and `border-accent/50` fell back to preflight's
      // near-white, which is why tinted buttons rendered as pale outlines with
      // no fill. With this form `/nn` works everywhere, and a plain
      // `bg-accent` resolves to `calc(1 * 100%)`, i.e. the colour itself.
      colors: {
        accent: {
          DEFAULT: 'color-mix(in srgb, var(--c-accent) calc(<alpha-value> * 100%), transparent)',
          500: 'color-mix(in srgb, var(--c-accent) calc(<alpha-value> * 100%), transparent)',
          600: 'color-mix(in srgb, var(--c-accent-strong) calc(<alpha-value> * 100%), transparent)',
        },
        surface: {
          DEFAULT: 'color-mix(in srgb, var(--c-surface) calc(<alpha-value> * 100%), transparent)',
          muted: 'color-mix(in srgb, var(--c-surface-muted) calc(<alpha-value> * 100%), transparent)',
          elevated: 'color-mix(in srgb, var(--c-surface-elevated) calc(<alpha-value> * 100%), transparent)',
        },
        ink: {
          DEFAULT: 'color-mix(in srgb, var(--c-ink) calc(<alpha-value> * 100%), transparent)',
          muted: 'color-mix(in srgb, var(--c-ink-muted) calc(<alpha-value> * 100%), transparent)',
          faint: 'color-mix(in srgb, var(--c-ink-faint) calc(<alpha-value> * 100%), transparent)',
        },
        backend: {
          claude: 'color-mix(in srgb, var(--c-backend-claude) calc(<alpha-value> * 100%), transparent)',
          codex: 'color-mix(in srgb, var(--c-backend-codex) calc(<alpha-value> * 100%), transparent)',
          gemini: 'color-mix(in srgb, var(--c-backend-gemini) calc(<alpha-value> * 100%), transparent)',
        },
        // Card fills/borders that read correctly in both themes. Use these
        // instead of `bg-white/5` / `border-white/10` — those hardcode a
        // white tint that's invisible on a near-white light surface.
        card: {
          DEFAULT: 'color-mix(in srgb, var(--c-card-bg) calc(<alpha-value> * 100%), transparent)',
          strong: 'color-mix(in srgb, var(--c-card-bg-strong) calc(<alpha-value> * 100%), transparent)',
          border: 'color-mix(in srgb, var(--c-card-border) calc(<alpha-value> * 100%), transparent)',
          'border-strong': 'color-mix(in srgb, var(--c-card-border-strong) calc(<alpha-value> * 100%), transparent)',
        },
      },
      borderColor: {
        card: 'color-mix(in srgb, var(--c-card-border) calc(<alpha-value> * 100%), transparent)',
        'card-strong': 'color-mix(in srgb, var(--c-card-border-strong) calc(<alpha-value> * 100%), transparent)',
      },
      backgroundColor: {
        card: 'color-mix(in srgb, var(--c-card-bg) calc(<alpha-value> * 100%), transparent)',
        'card-strong': 'color-mix(in srgb, var(--c-card-bg-strong) calc(<alpha-value> * 100%), transparent)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
};
