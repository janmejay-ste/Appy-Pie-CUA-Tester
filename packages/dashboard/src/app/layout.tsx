import type { Metadata } from 'next';
import { ThemeToggle } from '@/components/ThemeToggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'AppyPie CUA Tester',
  description: 'QA Testing Dashboard for Appy Pie Automate',
  icons: {
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%234F46E5"/><text x="50%25" y="55%25" dominant-baseline="middle" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="14" fill="white">AP</text></svg>',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <header className="border-b border-gray-700 bg-gray-900 backdrop-blur-sm sticky top-0 z-50">
          <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
            <a href="/" className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">
                AP
              </div>
              <h1 className="text-lg font-semibold text-gray-50">AppyPie CUA Tester</h1>
            </a>
            <div className="flex items-center gap-4">
              <nav className="flex gap-6 text-sm">
                <a href="/" className="text-gray-400 hover:text-gray-50 transition-colors">Dashboard</a>
                <a href="/history" className="text-gray-400 hover:text-gray-50 transition-colors">History</a>
              </nav>
              <ThemeToggle />
            </div>
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
