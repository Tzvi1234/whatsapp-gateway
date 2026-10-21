import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { IconSprite } from '@/ui/components/Icon';
import { he } from '@/ui/i18n/he';
import '@/ui/styles/base.css';
import '@/ui/styles/lia.css';
import '@/ui/styles/extra.css';
import '@/ui/styles/app.css';

export const metadata: Metadata = {
  title: { default: he.app.title, template: `%s · ${he.app.title}` },
  description: 'ניהול חשבונות וואטסאפ, חיבורים והתראות',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f3f4ee',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body>
        <IconSprite />
        <a className="skip" href="#main">
          {he.app.skip}
        </a>
        {children}
      </body>
    </html>
  );
}
