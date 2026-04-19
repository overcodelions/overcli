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
      colors: {
        accent: {
          DEFAULT: 'var(--c-accent)',
          500: 'var(--c-accent)',
          600: 'var(--c-accent-strong)',
        },
        surface: {
          DEFAULT: 'var(--c-surface)',
          muted: 'var(--c-surface-muted)',
          elevated: 'var(--c-surface-elevated)',
        },
        ink: {
          DEFAULT: 'var(--c-ink)',
          muted: 'var(--c-ink-muted)',
          faint: 'var(--c-ink-faint)',
        },
        backend: {
          claude: 'var(--c-backend-claude)',
          codex: 'var(--c-backend-codex)',
          gemini: 'var(--c-backend-gemini)',
        },
        // Card fills/borders that read correctly in both themes. Use these
        // instead of `bg-white/5` / `border-white/10` — those hardcode a
        // white tint that's invisible on a near-white light surface.
        card: {
          DEFAULT: 'var(--c-card-bg)',
          strong: 'var(--c-card-bg-strong)',
          border: 'var(--c-card-border)',
          'border-strong': 'var(--c-card-border-strong)',
        },
      },
      borderColor: {
        card: 'var(--c-card-border)',
        'card-strong': 'var(--c-card-border-strong)',
      },
      backgroundColor: {
        card: 'var(--c-card-bg)',
        'card-strong': 'var(--c-card-bg-strong)',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'system-ui', 'sans-serif'],
        mono: ['SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
};
