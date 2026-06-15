// Registry so FreeBoardView can inject file attachments into any mounted
// ClaudeChat instance without prop-drilling.

export type ChatAttachment = {
  id: string
  name: string
  content: string          // extracted text (PDF/text) or '' for images
  kind: 'pdf' | 'text' | 'image'
  thumbnail?: string       // base-64 JPEG data-URL (PDFs page 1; full image for image kind)
  dataUrl?: string         // full base-64 data-URL (image kind only)
  mediaType?: string       // MIME type for images, e.g. 'image/jpeg'
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
