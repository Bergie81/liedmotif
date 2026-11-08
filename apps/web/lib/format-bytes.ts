const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatBinaryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BINARY_UNITS.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${BINARY_UNITS[unit]}`;
}
