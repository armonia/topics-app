interface RangeSelectorProps {
  value: string;
  onChange: (range: string) => void;
}

const RANGES = ['1d', '7d', '30d'];

export function RangeSelector({ value, onChange }: RangeSelectorProps) {
  return (
    <div className="flex items-center gap-0.5 bg-surface border border-app-border rounded-md p-0.5">
      {RANGES.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
            value === r
              ? 'bg-primary text-white font-medium'
              : 'text-app-text-muted hover:text-app-text hover:bg-app-hover'
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
