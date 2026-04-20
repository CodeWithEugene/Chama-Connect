import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Match ChamaConnect's brand green (from /images/chamaconnect.svg context)
        brand: {
          DEFAULT: "#16a34a",
          50: "#f0fdf4",
          500: "#22c55e",
          600: "#16a34a",
          700: "#15803d",
          800: "#166534",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
