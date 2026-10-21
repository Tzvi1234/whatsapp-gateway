import { he } from '@/ui/i18n/he';

export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{he.app.loading}</span>
      <div className="skel" style={{ height: 36, width: '55%' }} />
      <div className="skel" style={{ height: 74, marginTop: 22 }} />
      <div className="skel" style={{ height: 140, marginTop: 22 }} />
      <div className="skel" style={{ height: 220, marginTop: 40 }} />
    </div>
  );
}
