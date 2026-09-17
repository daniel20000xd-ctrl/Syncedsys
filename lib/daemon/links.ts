import { createAdminClient } from '@/lib/supabase/admin'

// Links associate two items; they never merge them. Read bidirectionally, one hop only.

export type LinkKind = 'active' | 'archive'
export type LinkStub = { kind: LinkKind; id: string; title: string; why: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const table = (kind: LinkKind) => (kind === 'active' ? 'daemon_active' : 'daemon_archive')

async function exists(userId: string, kind: LinkKind, id: string): Promise<boolean> {
  const { data } = await createAdminClient().from(table(kind)).select('id').eq('user_id', userId).eq('id', id).maybeSingle()
  return !!data
}

export async function createLink(
  userId: string,
  link: { from_kind: string; from_id: string; to_kind: string; to_id: string; why: string },
): Promise<boolean> {
  const kinds = ['active', 'archive']
  if (!kinds.includes(link.from_kind) || !kinds.includes(link.to_kind)) return false
  if (!UUID.test(link.from_id) || !UUID.test(link.to_id) || link.from_id === link.to_id) return false
  const fromKind = link.from_kind as LinkKind
  const toKind = link.to_kind as LinkKind
  if (!(await exists(userId, fromKind, link.from_id)) || !(await exists(userId, toKind, link.to_id))) {
    console.warn('[daemon/links] skipped, unknown endpoint', link)
    return false
  }
  const admin = createAdminClient()
  const { data: reverse } = await admin.from('daemon_links').select('id')
    .eq('from_id', link.to_id).eq('to_id', link.from_id).maybeSingle()
  if (reverse) return false
  const { error } = await admin.from('daemon_links').upsert(
    { user_id: userId, from_kind: fromKind, from_id: link.from_id, to_kind: toKind, to_id: link.to_id, why: link.why },
    { onConflict: 'from_id,to_id', ignoreDuplicates: true },
  )
  if (error) console.error('[daemon/links] insert failed:', error.message)
  return !error
}

// An item moving between active and archive changes kind (and, for archive, id);
// re-point its links so they keep resolving.
export async function repointLinks(fromKind: LinkKind, fromId: string, toKind: LinkKind, toId: string): Promise<void> {
  const admin = createAdminClient()
  await admin.from('daemon_links').update({ from_kind: toKind, from_id: toId }).eq('from_id', fromId).eq('from_kind', fromKind)
  await admin.from('daemon_links').update({ to_kind: toKind, to_id: toId }).eq('to_id', fromId).eq('to_kind', fromKind)
}

// For each given id, one-line stubs (title + why) of the items on the other end.
export async function loadLinkStubs(userId: string, ids: string[]): Promise<Map<string, LinkStub[]>> {
  const stubs = new Map<string, LinkStub[]>()
  if (!ids.length) return stubs
  const admin = createAdminClient()
  const list = ids.join(',')
  const { data: links, error } = await admin.from('daemon_links')
    .select('from_kind, from_id, to_kind, to_id, why')
    .eq('user_id', userId)
    .or(`from_id.in.(${list}),to_id.in.(${list})`)
  if (error || !links?.length) return stubs

  const wanted = new Set(ids)
  const other: { owner: string; kind: LinkKind; id: string; why: string }[] = []
  for (const l of links) {
    if (wanted.has(l.from_id)) other.push({ owner: l.from_id, kind: l.to_kind, id: l.to_id, why: l.why })
    if (wanted.has(l.to_id)) other.push({ owner: l.to_id, kind: l.from_kind, id: l.from_id, why: l.why })
  }

  const titles = new Map<string, string>()
  for (const kind of ['active', 'archive'] as const) {
    const idsOfKind = [...new Set(other.filter(o => o.kind === kind).map(o => o.id))]
    if (!idsOfKind.length) continue
    const { data } = await admin.from(table(kind)).select('id, title').in('id', idsOfKind)
    for (const r of data ?? []) titles.set(`${kind}:${r.id}`, r.title)
  }

  for (const o of other) {
    const title = titles.get(`${o.kind}:${o.id}`)
    if (title === undefined) continue
    stubs.set(o.owner, [...(stubs.get(o.owner) ?? []), { kind: o.kind, id: o.id, title, why: o.why }])
  }
  return stubs
}
