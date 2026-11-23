import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { themeScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DeployNow", template: "%s · DeployNow" },
  description: "DeployNow by encorp.ai: self-hosted Docker deployment and management",
  applicationName: "DeployNow",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#05070d" },
    { media: "(prefers-color-scheme: light)", color: "#f5f7fb" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
