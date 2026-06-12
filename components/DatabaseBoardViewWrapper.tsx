'use client'

import dynamic from 'next/dynamic'

const DatabaseBoardView = dynamic(
  () => import('./DatabaseBoardView'),
  { ssr: false },
)

export default function DatabaseBoardViewWrapper(props: { boardId: string; config: string; initialReadme: string | null }) {
  return <DatabaseBoardView {...props} />
}
