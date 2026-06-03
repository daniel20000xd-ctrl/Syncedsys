'use client'

// `dynamic({ ssr: false })` must live in a Client Component, not a Server Component.
// This thin wrapper satisfies that constraint while keeping page.tsx as a Server Component
// that can do auth checks and redirects.
import dynamic from 'next/dynamic'

const StockViewer = dynamic(() => import('./StockViewer'), { ssr: false })

export default function StockViewerWrapper() {
  return <StockViewer />
}
