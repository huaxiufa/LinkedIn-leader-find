import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "LinkedIn Lead Finder",
  description: "Find publicly accessible LinkedIn post engagers and filter by job title."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
