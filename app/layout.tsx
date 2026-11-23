import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Embedded (OFL, see app/fonts/) so the build needs no internet access.
const sans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist",
  weight: "100 900",
  style: "normal",
});

const display = localFont({
  src: "./fonts/InstrumentSerif-Regular.woff2",
  variable: "--font-instrument",
  weight: "400",
  style: "normal",
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  title: "Mobilya Görsel Stüdyosu",
  description: "Ürün fotoğraflarını odalara yerleştirin, sosyal medya görselleri üretin.",
};

export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="tr" className={`${sans.variable} ${display.variable} h-full antialiased`}>
      <body className="min-h-full bg-canvas font-sans text-body text-ink">{children}</body>
    </html>
  );
}
