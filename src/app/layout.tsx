import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeployNow",
  description: "Self-hosted Docker deployment and management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
