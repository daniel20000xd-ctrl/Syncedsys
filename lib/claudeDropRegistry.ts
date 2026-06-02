// A lightweight registry so FreeBoardView can inject dropped-file text into
// whichever ClaudeChat node is the current drop target, without needing to
// thread callbacks through many layers of props.

type InjectFn = (text: string, filename: string) => void

const registry = new Map<string, InjectFn>()

export const claudeDropRegistry = {
  register(nodeId: string, fn: InjectFn) {
    registry.set(nodeId, fn)
  },
  unregister(nodeId: string) {
    registry.delete(nodeId)
  },
  inject(nodeId: string, text: string, filename: string) {
    registry.get(nodeId)?.(text, filename)
  },
}
