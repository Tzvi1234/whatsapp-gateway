import type { CSSProperties, ReactNode } from 'react';

/** The mockups' SVG icon sprite (docs/design/*.html), rendered once in the root layout. */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <symbol id="i-pulse" viewBox="0 0 24 24">
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </symbol>
      <symbol id="i-link" viewBox="0 0 24 24">
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
      </symbol>
      <symbol id="i-alert" viewBox="0 0 24 24">
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </symbol>
      <symbol id="i-list" viewBox="0 0 24 24">
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </symbol>
      <symbol id="i-bell" viewBox="0 0 24 24">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
      </symbol>
      <symbol id="i-key" viewBox="0 0 24 24">
        <circle cx="7.5" cy="15.5" r="5.5" />
        <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
      </symbol>
      <symbol id="i-plus" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" />
      </symbol>
      <symbol id="i-refresh" viewBox="0 0 24 24">
        <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
        <path d="M21 3v5h-5" />
      </symbol>
      <symbol id="i-send" viewBox="0 0 24 24">
        <path d="m22 2-7 20-4-9-9-4z" />
        <path d="M22 2 11 13" />
      </symbol>
      <symbol id="i-info" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </symbol>
      <symbol id="i-check" viewBox="0 0 24 24">
        <path d="M20 6 9 17l-5-5" />
      </symbol>
      <symbol id="i-x" viewBox="0 0 24 24">
        <path d="M18 6 6 18M6 6l12 12" />
      </symbol>
      <symbol id="i-copy" viewBox="0 0 24 24">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </symbol>
      <symbol id="i-play" viewBox="0 0 24 24">
        <path d="M7 4v16l13-8z" />
      </symbol>
    </svg>
  );
}

export type IconName =
  | 'pulse'
  | 'link'
  | 'alert'
  | 'list'
  | 'bell'
  | 'key'
  | 'plus'
  | 'refresh'
  | 'send'
  | 'info'
  | 'check'
  | 'x'
  | 'copy'
  | 'play';

export function Icon({
  name,
  style,
  className,
}: {
  name: IconName;
  style?: CSSProperties | undefined;
  className?: string | undefined;
}) {
  return (
    <svg
      className={className ? `i ${className}` : 'i'}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#i-${name}`} />
    </svg>
  );
}

/** LTR-isolated number / phone / code inside Hebrew text (R5.5). */
export function Num({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi className={className ? `num ${className}` : 'num'} dir="ltr">
      {children}
    </bdi>
  );
}
