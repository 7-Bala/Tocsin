import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#080b12',
        panel: '#111722',
        line: '#263044',
      },
      boxShadow: {
        panel: '0 18px 50px rgba(0, 0, 0, 0.22)',
      },
    },
  },
  plugins: [],
};

export default config;
