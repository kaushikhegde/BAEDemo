/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        scyne: {
          ink: "#464E7E",
          deep: "#363C63",
          line: "#E7E9F0",
          sand: "#C8A878",
          forest: "#3E6B56",
          ocean: "#2F6B78",
          "ink-50": "#EEF0F7",
          "ink-100": "#D9DDEB",
          "ink-200": "#B6BDD6",
          "ink-500": "#5C6593",
          "ink-600": "#464E7E",
          "ink-700": "#363C63",
          glow: "#7C82C8",
          iris: "#8B5CF6",
        },
        success: { 50: "#ECFDF5", 500: "#10B981", 600: "#059669" },
        warning: { 50: "#FFFBEB", 500: "#F59E0B", 600: "#D97706" },
        info: { 50: "#EFF6FF", 500: "#3B82F6", 600: "#2563EB" },
        danger: { 50: "#FFF1F2", 500: "#F43F5E", 600: "#E11D48" },
        progress: { 50: "#EEF2FF", 500: "#6366F1", 600: "#4F46E5" },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        xl: "20px",
        "2xl": "24px",
      },
      boxShadow: {
        "elev-1": "0 1px 2px rgba(15,23,42,.04), 0 1px 1px rgba(15,23,42,.03)",
        "elev-2": "0 2px 4px rgba(15,23,42,.05), 0 1px 2px rgba(15,23,42,.04)",
        "elev-3": "0 8px 24px rgba(15,23,42,.08), 0 2px 6px rgba(15,23,42,.04)",
        "elev-4": "0 24px 48px rgba(15,23,42,.12)",
        glow: "0 8px 32px rgba(124,130,200,.25)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg,#464E7E 0%,#5C6593 45%,#8B5CF6 100%)",
        mesh: "radial-gradient(1200px 600px at 10% -10%, rgba(139,92,246,.10), transparent 60%), radial-gradient(900px 500px at 110% 10%, rgba(99,102,241,.10), transparent 55%), radial-gradient(800px 600px at 50% 120%, rgba(124,130,200,.08), transparent 55%)",
      },
      keyframes: {
        "fade-in": { "0%": { opacity: "0" }, "100%": { opacity: "1" } },
        "slide-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out",
        "slide-up": "slide-up 220ms ease-out",
        "pulse-dot": "pulse-dot 1.4s ease-in-out infinite",
        shimmer: "shimmer 1.8s linear infinite",
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
      transitionTimingFunction: {
        "out-soft": "cubic-bezier(.2,.8,.2,1)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
