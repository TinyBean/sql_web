const decimalFormatter = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  roundingMode: "halfExpand",
});

/** Format display values only; calculations and stored evidence retain their precision. */
export function formatDisplayNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  const formatted = decimalFormatter.format(value);
  return formatted === "-0.00" ? "0.00" : formatted;
}
