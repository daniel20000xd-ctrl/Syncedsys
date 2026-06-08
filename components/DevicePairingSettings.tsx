'use client'

import { useState, useTransition } from 'react'
import { Smartphone, Plus, Copy, Check, Trash2, Wifi, Clock } from 'lucide-react'
import { createDeviceLink, removeDeviceLink } from '@/app/actions'

type DeviceLink = {
  id: string
  name: string
  pairing_code: string | null
  paired: boolean
  last_seen: string | null
  created_at: string
}

function fmtRelative(iso: string | null): string {
  if (!iso) return 'Never'
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function DevicePairingSettings({ initialDevices }: { initialDevices: DeviceLink[] }) {
  const [devices, setDevices] = useState<DeviceLink[]>(initialDevices)
  const [activeCode, setActiveCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function generate() {
    setError(null)
    setActiveCode(null)
    startTransition(async () => {
      try {
        const result = await createDeviceLink('iOS device')
        setActiveCode(result.code)
        // Add a placeholder unpaired device to the list optimistically
        setDevices(prev => [{
          id: result.id,
          name: 'iOS device',
          pairing_code: result.code,
          paired: false,
          last_seen: null,
          created_at: new Date().toISOString(),
        }, ...prev])
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not generate code')
      }
    })
  }

  function copy() {
    if (!activeCode) return
    navigator.clipboard?.writeText(activeCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  function remove(id: string) {
    setDevices(prev => prev.filter(d => d.id !== id))
    if (devices.find(d => d.id === id)?.pairing_code === activeCode) setActiveCode(null)
    startTransition(async () => {
      try { await removeDeviceLink(id) } catch { /* list already updated locally */ }
    })
  }

  return (
    <section className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-1 flex items-center gap-2">
        <Smartphone size={16} className="text-blue-500" />
        iOS Companion App
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Generate a one-time pairing code and enter it in the iOS app to connect it.
      </p>

      {/* Active pairing code */}
      {activeCode && (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <p className="text-xs font-semibold text-blue-700 mb-2">Enter this code in the iOS app</p>
          <div className="flex items-center gap-3">
            <span className="text-3xl font-mono font-bold tracking-[0.2em] text-blue-900">{activeCode}</span>
            <button
              onClick={copy}
              className="p-2 rounded-lg bg-blue-100 hover:bg-blue-200 text-blue-700 transition-colors"
              title="Copy code"
            >
              {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            </button>
          </div>
          <p className="text-xs text-blue-500 mt-2">Single-use — expires once the app pairs. Refresh this page after pairing to see the device.</p>
        </div>
      )}

      {/* Generate button */}
      <button
        onClick={generate}
        disabled={pending}
        className="flex items-center gap-2 px-4 py-2 bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors mb-4"
      >
        <Plus size={14} />
        {pending ? 'Generating…' : 'Generate pairing code'}
      </button>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

      {/* Device list */}
      {devices.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Linked devices</p>
          {devices.map(device => (
            <div key={device.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <div className="shrink-0">
                {device.paired
                  ? <Wifi size={15} className="text-green-500" />
                  : <Clock size={15} className="text-amber-400" />
                }
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800">{device.name}</p>
                <p className="text-xs text-gray-400">
                  {device.paired
                    ? `Last seen: ${fmtRelative(device.last_seen)}`
                    : 'Waiting to pair…'}
                </p>
              </div>
              {!device.paired && device.pairing_code === activeCode && (
                <span className="text-[10px] font-bold tracking-widest text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-mono">
                  {device.pairing_code}
                </span>
              )}
              <button
                onClick={() => remove(device.id)}
                className="p-1.5 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                title="Remove device"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
