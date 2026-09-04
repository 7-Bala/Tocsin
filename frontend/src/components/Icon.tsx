'use client';

/**
 * Shared line-icon set for the dashboard. Replaces emoji glyphs everywhere in
 * the UI with a single consistent visual language: 24x24 viewBox, no fill,
 * currentColor stroke, rounded caps/joins. Every icon inherits font-size and
 * color from its context by default (size defaults to '1em') so it drops
 * into existing text flow without layout changes.
 */

import React from 'react';

export interface IconProps {
  size?: number | string;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

function base(
  paths: React.ReactNode,
  { size = '1em', strokeWidth = 2, className, style, title }: IconProps
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: 'inline-block', verticalAlign: '-0.125em', flexShrink: 0, ...style }}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      {paths}
    </svg>
  );
}

export const AlertTriangleIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    p
  );

export const CheckCircleIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </>,
    p
  );

export const CheckIcon = (p: IconProps = {}) => base(<polyline points="20 6 9 17 4 12" />, p);

export const XCircleIcon = (p: IconProps = {}) =>
  base(
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </>,
    p
  );

export const XIcon = (p: IconProps = {}) =>
  base(
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>,
    p
  );

export const ZapIcon = (p: IconProps = {}) =>
  base(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />, p);

export const ArrowRightIcon = (p: IconProps = {}) =>
  base(
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </>,
    p
  );

export const MicIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </>,
    p
  );

export const MicOffIcon = (p: IconProps = {}) =>
  base(
    <>
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-1" />
      <path d="M5 10v1a7 7 0 0 0 12 5" />
      <path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </>,
    p
  );

export const ClipboardIcon = (p: IconProps = {}) =>
  base(
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <line x1="8" y1="11" x2="16" y2="11" />
      <line x1="8" y1="15" x2="14" y2="15" />
    </>,
    p
  );

export const ClipboardCheckIcon = (p: IconProps = {}) =>
  base(
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="m9 14 2 2 4-4" />
    </>,
    p
  );

export const ShieldIcon = (p: IconProps = {}) =>
  base(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />, p);

export const ShieldAlertIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>,
    p
  );

export const SparklesIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </>,
    { strokeWidth: 1.6, ...p }
  );

export const BrainIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.5A2.5 2.5 0 0 0 4.5 7 2.5 2.5 0 0 0 3 9.5 2.5 2.5 0 0 0 5.5 12a2.5 2.5 0 0 0 0 5A2.5 2.5 0 0 0 7 19.5v.5A2.5 2.5 0 0 0 9.5 22" />
      <path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.5A2.5 2.5 0 0 1 19.5 7 2.5 2.5 0 0 1 21 9.5 2.5 2.5 0 0 1 18.5 12a2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 1-2.5 2.5v.5a2.5 2.5 0 0 1-2.5 2.5" />
      <path d="M9.5 2v20M14.5 2v20" />
    </>,
    { strokeWidth: 1.6, ...p }
  );

export const Volume2Icon = (p: IconProps = {}) =>
  base(
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </>,
    p
  );

export const VolumeXIcon = (p: IconProps = {}) =>
  base(
    <>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </>,
    p
  );

export const RadioIcon = (p: IconProps = {}) =>
  base(
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14" />
    </>,
    p
  );

export const HelpCircleIcon = (p: IconProps = {}) =>
  base(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>,
    p
  );

export const BotIcon = (p: IconProps = {}) =>
  base(
    <>
      <rect x="3" y="9" width="18" height="11" rx="2" />
      <circle cx="8.5" cy="14.5" r="1.5" />
      <circle cx="15.5" cy="14.5" r="1.5" />
      <path d="M12 9V5M9 5h6" />
    </>,
    p
  );

export const SirenIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M7 12a5 5 0 0 1 10 0v6H7v-6Z" />
      <path d="M5 20h14" />
      <path d="M12 2v2M4.2 6.2l1.4 1.4M19.8 6.2l-1.4 1.4" />
    </>,
    p
  );

export const OctagonStopIcon = (p: IconProps = {}) =>
  base(
    <>
      <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
    </>,
    p
  );

export const RepeatIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v1a4 4 0 0 1-4 4H3" />
    </>,
    p
  );

export const FileTextIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
      <line x1="10" y1="9" x2="10" y2="9" />
    </>,
    p
  );

export const ScrollTextIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4v2" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v1a2 2 0 0 0 2 2h1" />
    </>,
    { strokeWidth: 1.7, ...p }
  );

export const BookmarkIcon = (p: IconProps = {}) =>
  base(<path d="M19 21 12 16l-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />, p);

export const LightbulbIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M9 18h6M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1v.2h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z" />
    </>,
    p
  );

export const UsersIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
    p
  );

export const UserIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>,
    p
  );

export const ScaleIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M12 3v18M8 21h8" />
      <path d="m5 7 5-2 5 2M4 10l3-7 3 7-3 2z" />
      <path d="M14 10l3-7 3 7-3 2z" />
    </>,
    { strokeWidth: 1.6, ...p }
  );

export const MessageSquareIcon = (p: IconProps = {}) =>
  base(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />, p);

export const EyeIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    p
  );

export const EyeOffIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.53 13.53 0 0 0 1 12s4 8 11 8a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </>,
    p
  );

export const SearchIcon = (p: IconProps = {}) =>
  base(
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>,
    p
  );

export const ClockIcon = (p: IconProps = {}) =>
  base(
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>,
    p
  );

export const MapPinIcon = (p: IconProps = {}) =>
  base(
    <>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z" />
      <circle cx="12" cy="10" r="3" />
    </>,
    p
  );
