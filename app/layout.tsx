import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ThemeSync } from "@/components/theme/theme-controls";
import { BUSINESS } from "@/lib/constants/business";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: BUSINESS.name,
    template: "%s · " + BUSINESS.name,
  },
  description: "Secure reservation and order management for " + BUSINESS.name + ".",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The inline script sets data-theme before first paint, so React must
    // accept an <html> attribute it did not render.
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
