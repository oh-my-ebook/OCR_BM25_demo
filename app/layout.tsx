import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BM25 Browser Lab",
  description: "브라우저에서 PDF OCR, Kiwi 형태소 분석, SQLite BM25 검색 흐름을 관찰하는 데모",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
