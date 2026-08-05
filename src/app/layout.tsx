import type { Metadata } from "next";
import { Barlow_Condensed, Inter } from "next/font/google";
import { MotionProvider } from "@/components/layout/MotionProvider";
import "./globals.css";

// Display face: uppercase, wide-tracking headings/eyebrows (see `.display`
// utility in globals.css). Only 600/700 are used — no light/regular weights.
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
});

// Body face: everything else — copy, table cells, labels.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: {
    default: "Hall of Blamers",
    template: "Hall of Blamers — %s",
  },
  description: "Hall of Blamers' own broadcast network.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${barlowCondensed.variable} ${inter.variable}`}>
      <body className="min-h-screen bg-bg text-ink antialiased">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
