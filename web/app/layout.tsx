import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Signa',
  description: 'Translate text into Israeli Sign Language and emojis.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#5b5bd6' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
