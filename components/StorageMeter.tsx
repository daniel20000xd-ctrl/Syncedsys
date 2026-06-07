import { HardDrive } from 'lucide-react'
import type { StorageUsage } from '@/app/actions'

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export default function StorageMeter({
  usage,
  limitBytes,
}: {
  usage: StorageUsage | null
  limitBytes: number | null
}) {
  if (!usage) return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <HardDrive size={16} className="text-gray-400" /> Storage
      </h2>
      <p className="text-sm text-gray-400">Could not load storage data.</p>
    </section>
  )

  const unlimited = limitBytes === null
  const pct = !unlimited ? Math.min(100, (usage.totalBytes / limitBytes!) * 100) : 0
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-green-500'
  const apps = Object.entries(usage.apps).sort((a, b) => b[1].bytes - a[1].bytes)

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <HardDrive size={16} className="text-gray-400" /> Storage
      </h2>
      <p className="text-sm text-gray-500 mb-3">
        {fmt(usage.totalBytes)} used{unlimited ? ' — Unlimited' : ` of ${fmt(limitBytes!)}`}
      </p>

      {!unlimited && (
        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mb-4">
          <div
            className={`h-full rounded-full ${barColor}`}
            style={{ width: `${pct.toFixed(2)}%` }}
          />
        </div>
      )}

      {apps.length > 0 ? (
        <div className="space-y-2">
          {apps.map(([app, { bytes, count }]) => (
            <div key={app} className="flex items-center justify-between">
              <span className="text-sm text-gray-600 capitalize">{app}</span>
              <span className="text-xs text-gray-400">
                {count} {count === 1 ? 'file' : 'files'} &middot; {fmt(bytes)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">No files stored yet.</p>
      )}
    </section>
  )
}
