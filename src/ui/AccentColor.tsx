// Accent-color picker: a row of preset swatches plus a native color input for
// anything custom. Purely presentational — reports every change through onChange.

const PRESETS = ['#5b8cff', '#22d3ee', '#34d399', '#a78bfa', '#f472b6', '#fbbf24', '#fb7185', '#f97316']

type Props = {
  value: string
  onChange: (color: string) => void
  label: string
}

export function AccentColor({ value, onChange, label }: Props) {
  const active = value.toLowerCase()
  return (
    <div class="accent">
      <div class="swatches" role="group" aria-label={label}>
        {PRESETS.map((c) => (
          <button
            key={c}
            type="button"
            class={c === active ? 'swatch is-active' : 'swatch'}
            style={{ background: c }}
            aria-label={c}
            aria-pressed={c === active}
            onClick={() => onChange(c)}
          />
        ))}
        <label class="swatch swatch-custom" title={label}>
          <input
            type="color"
            value={value}
            onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>
    </div>
  )
}
