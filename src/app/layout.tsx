import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import { MotionProvider } from "@/components/layout/MotionProvider";
import "./globals.css";

// Display face: uppercase, wide-tracking headings/eyebrows (see `.display`
// utility in globals.css). Only 600/700 are used — no light/regular weights.

export const metadata: Metadata = {
  title: {
    default: "Hall of Blamers",
    template: "Hall of Blamers — %s",
  },
  description: "Hall of Blamers' own broadcast network.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink antialiased">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
