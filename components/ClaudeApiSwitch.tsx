'use client'

import { useState, useTransition } from 'react'
import { Power } from 'lucide-react'
import { setClaudeApiEnabled } from '@/app/actions'

// Admin "big red button": flip the platform Claude API on/off globally. When off,
// platform-key requests are refused (users see "temporarily unavailable"); users on
// their own API key are unaffected.
export default function ClaudeApiSwitch({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [pending, startTransition] = useTransition()

  function toggle(next: boolean) {
    setEnabled(next)
    startTransition(async () => {
      const res = await setClaudeApiEnabled(next)
      if (!res.ok) setEnabled(!next)
    })
  }

  return (
    <section className="bg-white rounded-xl shadow-sm mb-10 p-5 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Power size={18} className={enabled ? 'text-green-600' : 'text-red-600'} />
        <div>
          <h2 className="font-semibold text-gray-800">Platform Claude API</h2>
          <p className="text-sm text-gray-500">
            {enabled
              ? 'On — users without their own key are running on your credits.'
              : 'Off — platform-key requests are refused. Own-key users are unaffected.'}
          </p>
        </div>
      </div>
      <button
        onClick={() => toggle(!enabled)}
        disabled={pending}
        className={`px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 ${
          enabled ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'
        }`}
      >
        {pending ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
      </button>
    </section>
  )
}
