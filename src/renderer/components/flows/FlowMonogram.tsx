// Monogram avatar: first letter of the flow name in a tinted square.
// The tint is derived deterministically from the flow name so the same
// flow always gets the same color (within a bounded palette so the look
// stays cohesive). Shared between the sidebar entries, the welcome
// cards, and the run panel header.

const PALETTE = [
  'bg-sky-500/20 text-sky-700 dark:text-sky-200',
  'bg-emerald-500/20 text-emerald-700 dark:text-emerald-200',
  'bg-amber-500/20 text-amber-700 dark:text-amber-200',
  'bg-purple-500/20 text-purple-700 dark:text-purple-200',
  'bg-rose-500/20 text-rose-700 dark:text-rose-200',
  'bg-teal-500/20 text-teal-700 dark:text-teal-200',
];

const SIZE_CLASS: Record<MonogramSize, string> = {
  xs: 'w-4 h-4 text-[9px] rounded-[3px]',
  sm: 'w-5 h-5 text-[10px] rounded-[4px]',
  md: 'w-7 h-7 text-xs rounded-md',
  lg: 'w-10 h-10 text-base rounded-md',
};

export type MonogramSize = 'xs' | 'sm' | 'md' | 'lg';

export function FlowMonogram({
  name,
  size = 'md',
  /// When true the monogram's letter glows and shifts color between its
  /// tint and a theme peak (white in dark mode, black in light) so a live
  /// run's icon reads as "still working" at a glance — mirrors the pulsing
  /// marker in the sidebar's Active section, without flashing the tile.
  live = false,
}: {
  name: string;
  size?: MonogramSize;
  live?: boolean;
}) {
  const letter = (name.match(/[A-Za-z]/)?.[0] ?? '•').toUpperCase();
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const tone = PALETTE[Math.abs(h) % PALETTE.length];
  return (
    <div
      className={`${SIZE_CLASS[size]} ${tone} flex items-center justify-center font-semibold flex-shrink-0${live ? ' flow-monogram-live' : ''}`}
    >
      {letter}
    </div>
  );
}
