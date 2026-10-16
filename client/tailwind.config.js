/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          neon: '#D2FF00', // Outside.vip signature electric volt
          'neon-hover': '#BEF200',
          dark: '#08090C',
          sunset: '#FF5733',
          purple: '#9B51E0',
          cyan: '#00F0FF',
        },
        surface: {
          950: '#07080A',
          900: '#0E1015',
          850: '#14171F',
          800: '#1C202B',
          700: '#2A3040',
          600: '#3D455C',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        'neon-sm': '0 0 10px rgba(210, 255, 0, 0.25)',
        'neon-md': '0 0 20px rgba(210, 255, 0, 0.35)',
        'neon-lg': '0 0 35px rgba(210, 255, 0, 0.45)',
        glass: '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
      },
      animation: {
        'pulse-subtle': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
};
