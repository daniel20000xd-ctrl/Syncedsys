export default function BoardLoading() {
  return (
    <div className="flex-1 h-full flex items-center justify-center bg-gray-50">
      <div className="flex items-center gap-2 text-gray-300">
        <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
        <span className="w-2 h-2 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
        <span className="w-2 h-2 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
      </div>
    </div>
  )
}
