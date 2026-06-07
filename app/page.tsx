import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'

// Seed a welcome board (two linked sticky notes) under the given persona and
// return its id. Mirrors the onboarding content the first board ships with.
async function seedFirstBoard(supabase: SupabaseClient, userId: string, personaId: string): Promise<string | null> {
  const { data: board } = await supabase
    .from('boards')
    .insert({ name: 'My First Board', color: '#6366f1', user_id: userId, parent_id: personaId, tab_position: 0, mode: 'classic' })
    .select()
    .single()
  if (!board) return null

  const id1 = crypto.randomUUID()
  const id2 = crypto.randomUUID()
  await supabase.from('board_elements').insert([
    {
      id: id1, board_id: board.id, type: 'text', x: 160, y: 200, width: 200, height: 160,
      data: { text: 'This is your first board!\n\nFollow the arrow to get started.', bgColor: 'rgba(254,240,64,0.95)', fontSize: 14, color: '#1f2937' },
    },
    {
      id: id2, board_id: board.id, type: 'text', x: 420, y: 200, width: 200, height: 160,
      data: { text: 'Enjoy mapping out everything!', bgColor: 'rgba(254,240,64,0.95)', fontSize: 14, color: '#1f2937' },
    },
  ])
  await supabase.from('board_edges').insert({
    board_id: board.id, source: `el-${id1}`, target: `el-${id2}`,
    source_handle: 'right', target_handle: 'left', data: {},
  })
  return board.id as string
}

export default async function RootPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Land inside the user's first persona — never on a persona row itself.
  const { data: personas } = await supabase
    .from('boards')
    .select('id')
    .eq('user_id', user.id)
    .eq('is_persona', true)
    .order('tab_position', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1)

  const persona = personas?.[0]
  if (persona) {
    const { data: children } = await supabase
      .from('boards')
      .select('id')
      .eq('user_id', user.id)
      .eq('parent_id', persona.id)
      .order('tab_position', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1)
    if (children && children.length > 0) redirect(`/board/${children[0].id}`)
    const seeded = await seedFirstBoard(supabase, user.id, persona.id)
    redirect(seeded ? `/board/${seeded}` : '/boards')
  }

  // Brand-new user (no persona yet): create one + a welcome board.
  const { data: newPersona } = await supabase
    .from('boards')
    .insert({ name: 'Personal', color: '#6366f1', user_id: user.id, is_persona: true, parent_id: null, tab_position: 0, mode: 'classic' })
    .select()
    .single()

  if (newPersona) {
    const seeded = await seedFirstBoard(supabase, user.id, newPersona.id)
    redirect(seeded ? `/board/${seeded}` : '/boards')
  }

  redirect('/boards')
}
