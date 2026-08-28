import Anthropic from '@anthropic-ai/sdk'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export async function suggestBoardMeta(
  name: string,
  mode: string,
  apiKey: string,
): Promise<{ suggestion: string; usage: Anthropic.Usage }> {
  const anthropic = new Anthropic({ apiKey })
  const response = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 80,
    messages: [{
      role: 'user',
      content: `Write a 1-2 sentence description for a board named "${name}" (mode: ${mode}). The description helps an AI assistant understand what this board is for. Be specific and concise. Reply with only the description, no quotes.`,
    }],
  })
  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : ''
  return { suggestion: text.slice(0, 150), usage: response.usage }
}
