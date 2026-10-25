import type { CSSProperties } from 'react';

const paths = {
  outline: 'M5 5h14M5 12h9M5 19h14',
  search: 'm21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h5',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  note: 'M8 6h12M8 12h12M8 18h7M3 6h.01M3 12h.01M3 18h.01',
  history: 'M3 11a9 9 0 1 1 2.8 7M3 4v7h7M12 7v5l3 2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  download: 'M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4',
  upload: 'M12 16V4m-5 5 5-5 5 5M5 16v4h14v-4',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  check: 'm5 12 4 4L19 6',
  device: 'M3 4h18v13H3zM8 21h8M12 17v4',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  panel: 'M3 4h18v16H3zM9 4v16',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
} as const;
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: keyof typeof paths;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3.5 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
