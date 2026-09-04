import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#080b12',
        panel: '#111722',
        line: '#263044',
        // shadcn/ui token bridge -- reads the CSS custom properties defined in
        // globals.css so `bg-background`, `border-border`, `text-muted-foreground`
        // etc. resolve consistently across every shadcn primitive and any refined
        // markup that opts into the same restrained, neutral palette.
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Semantic incident-state colors -- desaturated on purpose. These carry
        // meaning (confirmed/healthy, uncertain, critical, proposed-by-AI), not
        // decoration, per the restrained visual language this app targets.
        state: {
          confirmed: 'hsl(var(--state-confirmed))',
          warning: 'hsl(var(--state-warning))',
          critical: 'hsl(var(--state-critical))',
          info: 'hsl(var(--state-info))',
          inference: 'hsl(var(--state-inference))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      boxShadow: {
        panel: '0 18px 50px rgba(0, 0, 0, 0.22)',
      },
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};

export default config;
