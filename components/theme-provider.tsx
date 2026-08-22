"use client"

/**
 * Theme provider.
 *
 * `next-themes` writes the resolved theme onto the `<html>` element as a class,
 * which is what the `.dark` token block in `app/globals.css` keys off.
 *
 * This file already existed but was never imported by anything, so the app
 * shipped with a hardcoded dark palette and no way to change it.
 */

import { ThemeProvider as NextThemesProvider, type ThemeProviderProps } from "next-themes"

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      // Dark is the design's primary target and stays the default for anyone who
      // has not expressed a preference.
      defaultTheme="dark"
      enableSystem
      // Without this, swapping themes animates every colour on the page at once,
      // which reads as a flash rather than a transition.
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  )
}

export default ThemeProvider
