"use client";

import { ThemeProvider } from "next-themes";

export function AppProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem>{children}</ThemeProvider>;
}
