// ── Persona derivation (single source of truth) ──────────────────────────────
// A persona is the highest-level container: a board with is_persona=true at
// parent_id=null. The "active persona" for any board is found by walking its
// parent_id chain up to that root. Deriving structurally (rather than storing a
// persona_id) keeps the model identical to the existing board hierarchy.
//
// Returns null when no persona ancestor exists (i.e. legacy/pre-migration data
// where top-level boards still sit at parent_id=null). Callers treat a null
// persona as "behave like before personas existed", which makes the whole
// feature a safe no-op until the personas.sql migration has been applied.

type MinBoard = { id: string; parent_id: string | null; is_persona?: boolean }

export function getPersonaId<B extends MinBoard>(
  boardId: string | null | undefined,
  boards: B[],
): string | null {
  if (!boardId) return null
  const byId = new Map(boards.map(b => [b.id, b]))
  const seen = new Set<string>()
  let cur: B | undefined = byId.get(boardId)
  while (cur) {
    if (cur.is_persona) return cur.id
    if (!cur.parent_id || seen.has(cur.id)) return null
    seen.add(cur.id)
    cur = byId.get(cur.parent_id)
  }
  return null
}

// The persona board object (not just its id), or null.
export function getPersona<B extends MinBoard>(
  boardId: string | null | undefined,
  boards: B[],
): B | null {
  const id = getPersonaId(boardId, boards)
  return id ? boards.find(b => b.id === id) ?? null : null
}

// Is `boardId` inside the subtree of `personaId`? (Both null → legacy match.)
export function isInPersona<B extends MinBoard>(
  boardId: string,
  personaId: string | null,
  boards: B[],
): boolean {
  return getPersonaId(boardId, boards) === personaId
}

// All personas for the current user, ordered by tab_position then created_at.
export function listPersonas<B extends MinBoard & { tab_position?: number; created_at?: string }>(
  boards: B[],
): B[] {
  return boards
    .filter(b => b.is_persona)
    .sort((a, b) =>
      (a.tab_position ?? 0) - (b.tab_position ?? 0) ||
      (a.created_at ?? '').localeCompare(b.created_at ?? ''),
    )
}
