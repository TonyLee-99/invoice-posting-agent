import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "AP Review — invoice-posting-agent", description: "Review queue for recoverable invoice posting" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
