// Response contracts for the three call types. The JSON schemas go to Gemini as
// responseJsonSchema; the validators re-check every response, since a schema-invalid
// return is retried rather than trusted.

export type ItemType = 'task' | 'problem' | 'note'
export type ItemStatus = 'open' | 'in_progress' | 'done' | 'blocked'

export type ItemFields = Partial<{
  title: string
  content: string
  status: ItemStatus
  deadline: string | null
  tags: string[]
  type: ItemType
}>

export type InputAction =
  | { op: 'create'; type: ItemType; title: string; content: string; tags: string[]; deadline: string | null }
  | { op: 'update'; id: string; fields: ItemFields }
  | { op: 'archive'; id: string; outcome: string; why: string }
  | { op: 'calendar_write'; date: string; block: string }

export type InputResponse = {
  reply: string
  actions: InputAction[]
  next_wake_time: string | null
}

export type HeartbeatResponse = {
  should_ping: boolean
  message: string | null
  target_ids: string[]
  next_wake_time: string
  reasoning: string
}

export type ReflectionResponse = {
  promote: { archive_id: string; why_now: string }[]
  demote: { active_id: string; outcome: string; why: string }[]
  updates: { active_id: string; fields: ItemFields }[]
  todays_log: string
  calendar_roll: { date: string; block: string }
  tomorrow_plan: { date: string; block: string | null }
  next_wake_time: string
}

const TYPES = ['task', 'problem', 'note']
const STATUSES = ['open', 'in_progress', 'done', 'blocked']

const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) })
const nullableStr = (description?: string) => ({ type: ['string', 'null'], ...(description ? { description } : {}) })
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false })

const fieldsSchema = {
  type: 'object',
  description: 'Only the fields to change.',
  properties: {
    title: str(),
    content: str(),
    status: { type: 'string', enum: STATUSES },
    deadline: nullableStr('ISO-8601 or null to clear'),
    tags: { type: 'array', items: str() },
    type: { type: 'string', enum: TYPES },
  },
  additionalProperties: false,
}

// Flattened union: Gemini handles one object shape with an `op` discriminator more
// reliably than anyOf. Fields irrelevant to an op are null.
export const INPUT_SCHEMA = obj({
  reply: str('Message sent back to the user.'),
  actions: {
    type: 'array',
    items: obj({
      op: { type: 'string', enum: ['create', 'update', 'archive', 'calendar_write'] },
      id: nullableStr('update/archive: daemon_active id'),
      type: nullableStr('create: task | problem | note'),
      title: nullableStr(),
      content: nullableStr(),
      tags: { type: ['array', 'null'], items: str() },
      deadline: nullableStr('create: ISO-8601 or null'),
      fields: { ...fieldsSchema, type: ['object', 'null'] },
      outcome: nullableStr('archive'),
      why: nullableStr('archive'),
      date: nullableStr('calendar_write: YYYY-MM-DD'),
      block: nullableStr('calendar_write: markdown for that day'),
    }, ['op']),
  },
  next_wake_time: nullableStr('ISO-8601, or null to leave unchanged'),
})

export const HEARTBEAT_SCHEMA = obj({
  should_ping: { type: 'boolean' },
  message: nullableStr(),
  target_ids: { type: 'array', items: str('daemon_active id being nudged') },
  next_wake_time: str('ISO-8601'),
  reasoning: str('One line, logged, never sent.'),
})

export const REFLECTION_SCHEMA = obj({
  promote: { type: 'array', items: obj({ archive_id: str(), why_now: str() }) },
  demote: { type: 'array', items: obj({ active_id: str(), outcome: str(), why: str() }) },
  updates: { type: 'array', items: obj({ active_id: str(), fields: fieldsSchema }) },
  todays_log: str('Markdown.'),
  calendar_roll: obj({ date: str('YYYY-MM-DD'), block: str('Markdown: planned vs happened.') }),
  tomorrow_plan: obj({ date: str('YYYY-MM-DD'), block: nullableStr('Markdown, or null') }),
  next_wake_time: str('ISO-8601'),
})

class Invalid extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isIso(v)

function need<T>(ok: boolean, what: string, v: T): T {
  if (!ok) throw new Invalid(what)
  return v
}
const s = (v: unknown, what: string) => need(typeof v === 'string', `${what} must be a string`, v as string)
const sOrNull = (v: unknown, what: string) => need(v === null || v === undefined || typeof v === 'string', `${what} must be string|null`, (v ?? null) as string | null)
const isoOrNull = (v: unknown, what: string) => need(v === null || v === undefined || v === '' || isIso(v), `${what} must be ISO-8601|null`, (v || null) as string | null)
const strArr = (v: unknown, what: string) => need(Array.isArray(v) && v.every(x => typeof x === 'string'), `${what} must be string[]`, v as string[])
const arr = (v: unknown, what: string) => need(Array.isArray(v), `${what} must be an array`, v as unknown[])

function fields(v: unknown, what: string): ItemFields {
  need(isObj(v), `${what} must be an object`, v)
  const f = v as Record<string, unknown>
  const out: ItemFields = {}
  if (f.title != null) out.title = s(f.title, `${what}.title`)
  if (f.content != null) out.content = s(f.content, `${what}.content`)
  if (f.status != null) out.status = need(STATUSES.includes(f.status as string), `${what}.status invalid`, f.status as ItemStatus)
  if ('deadline' in f) out.deadline = isoOrNull(f.deadline, `${what}.deadline`)
  if (f.tags != null) out.tags = strArr(f.tags, `${what}.tags`)
  if (f.type != null) out.type = need(TYPES.includes(f.type as string), `${what}.type invalid`, f.type as ItemType)
  return out
}

export function validateInput(v: unknown): InputResponse {
  need(isObj(v), 'response must be an object', v)
  const r = v as Record<string, unknown>
  const actions = arr(r.actions, 'actions').map((a, i): InputAction => {
    const what = `actions[${i}]`
    need(isObj(a), `${what} must be an object`, a)
    const x = a as Record<string, unknown>
    switch (x.op) {
      case 'create':
        return {
          op: 'create',
          type: need(TYPES.includes(x.type as string), `${what}.type invalid`, x.type as ItemType),
          title: need(typeof x.title === 'string' && x.title.trim() !== '', `${what}.title required`, x.title as string),
          content: (sOrNull(x.content, `${what}.content`) ?? ''),
          tags: x.tags == null ? [] : strArr(x.tags, `${what}.tags`),
          deadline: isoOrNull(x.deadline, `${what}.deadline`),
        }
      case 'update':
        return { op: 'update', id: s(x.id, `${what}.id`), fields: fields(x.fields, `${what}.fields`) }
      case 'archive':
        return { op: 'archive', id: s(x.id, `${what}.id`), outcome: sOrNull(x.outcome, `${what}.outcome`) ?? '', why: sOrNull(x.why, `${what}.why`) ?? '' }
      case 'calendar_write':
        return {
          op: 'calendar_write',
          date: need(isDay(x.date), `${what}.date must be YYYY-MM-DD`, x.date as string),
          block: s(x.block, `${what}.block`),
        }
      default:
        throw new Invalid(`${what}.op invalid`)
    }
  })
  return { reply: s(r.reply, 'reply'), actions, next_wake_time: isoOrNull(r.next_wake_time, 'next_wake_time') }
}

export function validateHeartbeat(v: unknown): HeartbeatResponse {
  need(isObj(v), 'response must be an object', v)
  const r = v as Record<string, unknown>
  const should_ping = need(typeof r.should_ping === 'boolean', 'should_ping must be boolean', r.should_ping as boolean)
  const message = sOrNull(r.message, 'message')
  need(!should_ping || !!message?.trim(), 'message required when should_ping', null)
  return {
    should_ping,
    message,
    target_ids: r.target_ids == null ? [] : strArr(r.target_ids, 'target_ids'),
    next_wake_time: need(isIso(r.next_wake_time), 'next_wake_time must be ISO-8601', r.next_wake_time as string),
    reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
  }
}

export function validateReflection(v: unknown): ReflectionResponse {
  need(isObj(v), 'response must be an object', v)
  const r = v as Record<string, unknown>
  const cal = r.calendar_roll as Record<string, unknown>
  const plan = r.tomorrow_plan as Record<string, unknown>
  need(isObj(cal), 'calendar_roll must be an object', cal)
  need(isObj(plan), 'tomorrow_plan must be an object', plan)
  return {
    promote: arr(r.promote, 'promote').map((p, i) => {
      const x = p as Record<string, unknown>
      need(isObj(p), `promote[${i}] must be an object`, p)
      return { archive_id: s(x.archive_id, `promote[${i}].archive_id`), why_now: sOrNull(x.why_now, 'why_now') ?? '' }
    }),
    demote: arr(r.demote, 'demote').map((d, i) => {
      const x = d as Record<string, unknown>
      need(isObj(d), `demote[${i}] must be an object`, d)
      return { active_id: s(x.active_id, `demote[${i}].active_id`), outcome: sOrNull(x.outcome, 'outcome') ?? '', why: sOrNull(x.why, 'why') ?? '' }
    }),
    updates: arr(r.updates, 'updates').map((u, i) => {
      const x = u as Record<string, unknown>
      need(isObj(u), `updates[${i}] must be an object`, u)
      return { active_id: s(x.active_id, `updates[${i}].active_id`), fields: fields(x.fields, `updates[${i}].fields`) }
    }),
    todays_log: s(r.todays_log, 'todays_log'),
    calendar_roll: { date: need(isDay(cal.date), 'calendar_roll.date must be YYYY-MM-DD', cal.date as string), block: s(cal.block, 'calendar_roll.block') },
    tomorrow_plan: { date: need(isDay(plan.date), 'tomorrow_plan.date must be YYYY-MM-DD', plan.date as string), block: sOrNull(plan.block, 'tomorrow_plan.block') },
    next_wake_time: need(isIso(r.next_wake_time), 'next_wake_time must be ISO-8601', r.next_wake_time as string),
  }
}

export { Invalid as SchemaInvalidError }
