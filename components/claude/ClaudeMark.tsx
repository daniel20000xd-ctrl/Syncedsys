// The Claude sunburst mark — a coral radial burst. Optionally animated so it
// feels "alive": a slow rotation with a gentle breathing pulse. Pure CSS
// transforms (GPU-cheap); respects prefers-reduced-motion.

export const CLAUDE_CORAL = '#D97757'

export function ClaudeMark({ size = 16, animate = false, color = CLAUDE_CORAL }: { size?: number; animate?: boolean; color?: string }) {
  // 12 tapered spokes radiating from the centre, alternating lengths for the
  // organic look of the real mark.
  const spokes = Array.from({ length: 12 }, (_, i) => i)
  return (
    <span className={`inline-flex shrink-0 ${animate ? 'claude-mark-breathe' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 100 100" className={animate ? 'claude-mark-spin' : ''}>
        <g fill={color}>
          {spokes.map(i => {
            const long = i % 2 === 0
            const h = long ? 40 : 30
            const y = 50 - h
            return (
              <rect
                key={i}
                x={47}
                y={y}
                width={6}
                height={h}
                rx={3}
                transform={`rotate(${i * 30} 50 50)`}
              />
            )
          })}
        </g>
      </svg>
    </span>
  )
}
