/** Line icons standing in for the SF Symbols the iPhone app uses. Names match the Swift symbol names. */
import type { ReactElement } from "react";

const PATHS: Record<string, ReactElement> = {
  waveform: <><path d="M3 12h1M6 8v8M9 5v14M12 9v6M15 3v18M18 8v8M21 11v2" /></>,
  "square.grid.2x2": <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  book: <><path d="M12 6.5C10 4.8 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5c-3.5-.5-6.5-.2-8.5 1.5z" /><path d="M12 6.5v13" /></>,
  "slider.horizontal.3": <><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" fill="currentColor" /><circle cx="15" cy="12" r="2" fill="currentColor" /><circle cx="8" cy="17" r="2" fill="currentColor" /></>,
  "captions.bubble": <><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 3v-3H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z" /><path d="M7 10h6M15 10h2M7 13.5h2M11 13.5h6" /></>,
  "captions.bubble.fill": <><path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 3v-3H4A1.5 1.5 0 0 1 2.5 16V7A1.5 1.5 0 0 1 4 5.5z" fill="currentColor" /><path d="M7 10h6M15 10h2M7 13.5h2M11 13.5h6" stroke="var(--cream)" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" /></>,
  "mic.slash": <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6M4 4l16 16" /></>,
  "phone.down": <><path d="M3.5 12.5c5-4 12-4 17 0l-1.5 3.5-3.5-1v-2.5c-2-.7-4-.7-6 0V15l-3.5 1z" /></>,
  "text.bubble": <><path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 17h-9l-4 3.5V17H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 5z" /><path d="M7 9.5h10M7 13h6" /></>,
  keyboard: <><rect x="2.5" y="6.5" width="19" height="11" rx="2" /><path d="M6 10h1M9 10h1M12 10h1M15 10h1M18 10h1M6 13h1M9 13h1M12 13h1M15 13h1M18 13h1M8 16h8" /></>,
  sparkles: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z" /><path d="M5 16l.6 1.4 1.4.6-1.4.6L5 20l-.6-1.4-1.4-.6 1.4-.6z" /></>,
  "arrow.counterclockwise": <><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v5h5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  "arrow.up.right": <><path d="M7 17L17 7M9 7h8v8" /></>,
  "arrow.up": <><path d="M12 19V5M6 11l6-6 6 6" /></>,
  "chevron.left": <><path d="M15 5l-7 7 7 7" /></>,
  "chevron.up": <><path d="M6 15l6-6 6 6" /></>,
  "chevron.down": <><path d="M6 9l6 6 6-6" /></>,
  "checkmark.circle.fill": <><circle cx="12" cy="12" r="9.5" fill="currentColor" /><path d="M8 12.5l2.5 2.5L16 9.5" stroke="var(--cream)" /></>,
  circle: <><circle cx="12" cy="12" r="9.5" /></>,
  xmark: <><path d="M6 6l12 12M18 6L6 18" /></>,
  magnifyingglass: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></>,
  "sparkle.magnifyingglass": <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /><path d="M10.5 7l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" /></>,
  "cup.and.saucer": <><path d="M5 8h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z" /><path d="M16 9.5h1.5a2.5 2.5 0 0 1 0 5H16" /><path d="M3 20h16" /></>,
  "sun.horizon": <><path d="M12 5v2M5.5 8.5l1.5 1.5M18.5 8.5L17 10M3 14h2M19 14h2" /><path d="M7 16a5 5 0 0 1 10 0" /><path d="M3 19h18" /></>,
  tree: <><path d="M12 3l5 6h-2.5l3.5 5h-3l3 5H6l3-5H6l3.5-5H7z" /><path d="M12 19v2.5" /></>,
  "fork.knife": <><path d="M7 3v7a2 2 0 0 0 4 0V3M9 12v9" /><path d="M17 3c-2 2-2 8-2 8h2v10" /></>,
  "hand.wave": <><path d="M8 11V6a1.5 1.5 0 0 1 3 0v5M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7.5" /><path d="M8 11v3l-2.5-2a1.6 1.6 0 0 0-2 2.4L8 19a6 6 0 0 0 9 1v-6.5" /></>,
  basket: <><path d="M4 10h16l-1.5 9h-13z" /><path d="M8 10l3-6M16 10l-3-6M9 14v2M12 14v2M15 14v2" /></>,
  tram: <><rect x="6" y="5" width="12" height="13" rx="2" /><path d="M6 11h12M9 21l1.5-3M15 21l-1.5-3M9 15h.5M14.5 15h.5M10 2l2 3 2-3" /></>,
  house: <><path d="M4 11l8-7 8 7v9h-5v-6h-6v6H4z" /></>,
  "person.2": <><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="16.5" cy="9" r="2.5" /><path d="M15 14.5a4.5 4.5 0 0 1 5.5 4.5" /></>,
  briefcase: <><rect x="3" y="8" width="18" height="12" rx="2" /><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18" /></>,
  "cloud.rain": <><path d="M7 15a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 15z" /><path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3" /></>,
  "mountain.2": <><path d="M3 19l6-10 3 5 3-4 6 9z" /><path d="M9 9l1.5-2.5L12 9" /></>,
  "music.note": <><path d="M9 18V6l10-2v11" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="16.5" cy="15" r="2.5" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  "pencil.and.outline": <><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13 7l4 4" /><path d="M14 20h6" /></>,
  "globe.europe.africa": <><circle cx="12" cy="12" r="9" /><path d="M9 4.5c1 2 0 4-1.5 5S6 12 8 13s3 3 2.5 5M14 5c-1 2 1 3 1.5 4.5S13 12 14 14s3 2 2.5 4" /></>,
  wineglass: <><path d="M8 3h8l-.5 6a3.5 3.5 0 0 1-7 0z" /><path d="M12 12.5V20M8.5 20h7" /></>,
  "building.2": <><rect x="3" y="8" width="8" height="12" /><rect x="11" y="4" width="10" height="16" /><path d="M6 11h2M6 14h2M6 17h2M14 7h2M14 10h2M14 13h2M14 16h2M18 7h.5M18 10h.5M18 13h.5M18 16h.5" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h12l-2 4 2 4H5" /></>,
  "quote.bubble": <><path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 17h-9l-4 3.5V17H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 5z" /><path d="M8 13v-2a2 2 0 0 1 2-2M14 13v-2a2 2 0 0 1 2-2" /></>,
  paperplane: <><path d="M21 3L3 10.5l7.5 3L13.5 21z" /><path d="M10.5 13.5L21 3" /></>,
  newspaper: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M7 9h5v4H7zM14 9h3M14 12h3M7 16h10" /></>,
  "figure.walk": <><circle cx="13" cy="4" r="1.8" /><path d="M11.5 8l-3 3 1.5 3.5M11.5 8l3 2 3-1M11.5 8l-1 6-2.5 7M10.5 14l4 2 1 5" /></>,
  leaf: <><path d="M5 19c0-8 5-13 14-13-1 9-6 13-13 13" /><path d="M5 19c3-4 6-7 9-9" /></>,
  "clock.arrow.circlepath": <><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v5h5M12 8v4l3 2" /></>,
  key: <><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15 12v2" /></>,
  "checkmark.shield": <><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  "square.and.arrow.up": <><path d="M12 15V4M8 8l4-4 4 4" /><path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8" /></>,
  "square.and.arrow.down": <><path d="M12 4v11M8 11l4 4 4-4" /><path d="M6 11v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8" /></>,
  "waveform.bubble": <><path d="M4 5h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 17h-9l-4 3.5V17H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 5z" /><path d="M7 11h.5M10 9v4M12.5 7.5v7M15 9v4M17.5 11h.5" /></>,
  "person.crop.circle": <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6 6 0 0 1 11 0" /></>,
  "externaldrive.badge.exclamationmark": <><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 13h.5M12 4v3M12 20v.5" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  pencil: <><path d="M4 20h4l11-11-4-4L4 16z" /><path d="M13 7l4 4" /></>,
};

export function Icon({ name, size, className, strokeWidth = 1.7 }: { name: string; size?: number; className?: string; strokeWidth?: number }) {
  const body = PATHS[name] ?? PATHS["circle"]!;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}
