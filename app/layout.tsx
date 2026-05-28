import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Syncedsys',
  description: 'Trello-style kanban board',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full antialiased">{children}</body>
    </html>
  )
}
