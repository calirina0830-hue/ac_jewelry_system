import type { Metadata } from "next";
import type { ReactNode } from "react";

import { BUSINESS } from "@/lib/constants/business";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
