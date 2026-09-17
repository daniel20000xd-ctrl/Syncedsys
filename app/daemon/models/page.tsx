import { getModelPrices, getModelRouting, getModelUsageSummary } from '@/app/daemonActions'
import { ModelPriceEditor } from '../_components/ModelPriceEditor'
import { ModelRoutingEditor } from '../_components/ModelRoutingEditor'
import { Badge, Empty, ErrorPanel, PageTitle, Panel, usd } from '../_components/ui'

export default async function ModelsPage() {
  let routing: Awaited<ReturnType<typeof getModelRouting>>
  let priceData: Awaited<ReturnType<typeof getModelPrices>>
  let usage: Awaited<ReturnType<typeof getModelUsageSummary>>
  try {
    ;[routing, priceData, usage] = await Promise.all([getModelRouting(), getModelPrices(), getModelUsageSummary(7)])
  } catch (e) {
    return <ErrorPanel error={e} />
  }

  return (
    <div className="space-y-4">
      <PageTitle sub="A model change here takes effect on the next call — no redeploy. Prices affect the daily cost cap; nothing on this page is ever written by a model response.">
        Models
      </PageTitle>

      <Panel title="Routing — model per call type">
        <ModelRoutingEditor rows={routing} />
        <p className="text-[11px] text-zinc-600 mt-2">
          Falling back to env means there is no row in daemon_model_config for that call type; the daemon used
          DAEMON_GEMINI_MODEL / DAEMON_EMBEDDING_MODEL instead and logged a warning to the usage ledger. Unconfigured
          means neither exists — that call type aborts before reaching the model.
        </p>
      </Panel>

      <Panel title="Prices — $ per 1M tokens" right={<span className="text-amber-400">used to compute cost_usd and the daily cap</span>}>
        <ModelPriceEditor prices={priceData.prices} unpriced={priceData.unpricedModelsInUse} />
      </Panel>

      <Panel title="Recent usage by model" right="last 7 days">
        {usage.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead className="text-[10px] uppercase tracking-wider text-zinc-500 text-left">
                <tr>
                  {['model', 'call type', 'calls', 'dry runs', 'input tok', 'output tok', 'cost', 'unpriced calls'].map(h => (
                    <th key={h} className="font-normal pb-1 pr-3 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {usage.map(row => (
                  <tr key={`${row.model}-${row.call_type}`} className="align-top">
                    <td className="pr-3 py-1 font-mono text-zinc-200 whitespace-nowrap">{row.model}</td>
                    <td className="pr-3"><Badge>{row.call_type}</Badge></td>
                    <td className="pr-3 text-right">{row.calls}</td>
                    <td className="pr-3 text-right text-zinc-500">{row.dry_runs || '—'}</td>
                    <td className="pr-3 text-right">{row.input_tokens.toLocaleString()}</td>
                    <td className="pr-3 text-right">{row.output_tokens.toLocaleString()}</td>
                    <td className="pr-3 text-right">{usd(row.cost_usd)}</td>
                    <td className="text-right">{row.unknown_cost_calls > 0 ? <span className="text-red-400">{row.unknown_cost_calls}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No model calls in the last 7 days.</Empty>}
        <p className="text-[11px] text-zinc-600 mt-2">This is how a model switch shows up: compare cost and token counts per call type across a change.</p>
      </Panel>
    </div>
  )
}
