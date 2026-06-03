// Registry so FreeBoardView can inject file attachments into any mounted
// ClaudeChat instance without prop-drilling.

export type ChatAttachment = {
  id: string
  name: string
  content: string          // extracted text (PDF) or raw content (text file)
  kind: 'pdf' | 'text'
  thumbnail?: string       // base-64 JPEG data-URL of page 1 (PDFs only)
}

type InjectFn = (attachment: ChatAttachment) => void

const registry = new Map<string, InjectFn>()

export const claudeDropRegistry = {
  register(nodeId: string, fn: InjectFn) {
    registry.set(nodeId, fn)
  },
  unregister(nodeId: string) {
    registry.delete(nodeId)
  },
  inject(nodeId: string, attachment: ChatAttachment) {
    registry.get(nodeId)?.(attachment)
  },
}
