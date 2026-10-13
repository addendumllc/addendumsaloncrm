/** Addendum Salon design tokens. One accent (default plum, changeable) on a quiet neutral base. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Background tones are themeable too (Settings → Appearance → Background); see src/lib/theme.ts.
        paper: 'rgb(var(--paper) / <alpha-value>)',
        sidebar: 'rgb(var(--sidebar) / <alpha-value>)',
        ink: { DEFAULT: '#1D1C1A', soft: '#3A3835' },
        stone: { DEFAULT: '#75716B', light: '#A29E97' },
        line: { DEFAULT: 'rgb(var(--line) / <alpha-value>)', strong: 'rgb(var(--line-strong) / <alpha-value>)' },
        mist: 'rgb(var(--mist) / <alpha-value>)',
        // Accent colour is themeable (Settings → Appearance); values are RGB channels set in src/lib/theme.ts.
        plum: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          dark: 'rgb(var(--accent-dark) / <alpha-value>)',
          tint: 'rgb(var(--accent-tint) / <alpha-value>)',
          soft: 'rgb(var(--accent-soft) / <alpha-value>)',
        },
        sage: { DEFAULT: '#557563', tint: '#EAF1EC' },
        rose: { DEFAULT: '#A8544E', tint: '#F7E9E7' },
        amber: { DEFAULT: '#A87A2F', tint: '#F6EEDD' },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        sans: ['var(--font-body)'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        lift: '0 1px 2px rgba(29,28,26,0.04), 0 4px 16px -6px rgba(29,28,26,0.10)',
        pop: '0 12px 40px -12px rgba(29,28,26,0.28)',
      },
      borderRadius: { xl2: '1.125rem' },
    },
  },
  plugins: [],
};
