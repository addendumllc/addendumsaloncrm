/** Addendum Salon design tokens. One accent (default plum, changeable) on a quiet neutral base. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Background tones are themeable too (Settings → Appearance → Background); see src/lib/theme.ts.
        paper: 'rgb(var(--paper) / <alpha-value>)',
        sidebar: 'rgb(var(--sidebar) / <alpha-value>)',
        // Text tones and surfaces are themeable too (custom text colour, dark mode); see src/lib/theme.ts.
        // "white" is the card/surface colour: white in light mode, a deep grey in dark mode.
        white: 'rgb(var(--surface) / <alpha-value>)',
        ink: { DEFAULT: 'rgb(var(--ink) / <alpha-value>)', soft: 'rgb(var(--ink-soft) / <alpha-value>)' },
        stone: { DEFAULT: 'rgb(var(--stone) / <alpha-value>)', light: 'rgb(var(--stone-light) / <alpha-value>)' },
        line: { DEFAULT: 'rgb(var(--line) / <alpha-value>)', strong: 'rgb(var(--line-strong) / <alpha-value>)' },
        mist: 'rgb(var(--mist) / <alpha-value>)',
        // Accent colour is themeable (Settings → Appearance); values are RGB channels set in src/lib/theme.ts.
        plum: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          dark: 'rgb(var(--accent-dark) / <alpha-value>)',
          tint: 'rgb(var(--accent-tint) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
        },
        sage: { DEFAULT: 'rgb(var(--sage) / <alpha-value>)', tint: 'rgb(var(--sage-tint) / <alpha-value>)' },
        rose: { DEFAULT: 'rgb(var(--rose) / <alpha-value>)', tint: 'rgb(var(--rose-tint) / <alpha-value>)' },
        amber: { DEFAULT: 'rgb(var(--amber) / <alpha-value>)', tint: 'rgb(var(--amber-tint) / <alpha-value>)' },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-body)'],
        // Settings → Appearance → Fonts: links, buttons and the menus can each have their own font.
        link: ['var(--font-link, var(--font-body))'],
        button: ['var(--font-button, var(--font-body))'],
        nav: ['var(--font-nav, var(--font-body))'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        lift: '0 1px 2px rgba(29,28,26,0.04), 0 4px 16px -6px rgba(29,28,26,0.10)',
        pop: '0 12px 40px -12px rgba(29,28,26,0.28)',
      },
      // Corners follow Settings → Appearance (rounded, soft or square); see src/lib/theme.ts.
      borderRadius: { md: 'var(--radius-md, 0.375rem)', lg: 'var(--radius-lg, 0.5rem)', xl: 'var(--radius-xl, 0.75rem)', xl2: 'var(--radius-xl2, 1.125rem)' },
    },
  },
  plugins: [],
};
