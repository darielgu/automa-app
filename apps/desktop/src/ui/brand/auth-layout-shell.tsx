import type { ReactNode } from "react";
import { motion } from "framer-motion";

type AuthLayoutShellProps = {
  title: string;
  subtitle: string;
  aside: ReactNode;
  children: ReactNode;
  ctaLabel?: string;
  onCtaClick?: () => void;
};

export function AuthLayoutShell({
  title,
  subtitle,
  aside,
  children,
  ctaLabel,
  onCtaClick
}: AuthLayoutShellProps) {
  return (
    <main className="auth-shell">
      <div className="auth-shell__backdrop" />
      <div className="auth-shell__header">
        <div className="auth-shell__brand">
          <img src="/Automa-B-NBG.png" alt="Automa" className="auth-shell__brand-wordmark auth-shell__brand-wordmark--light" />
          <img src="/Automa-NBG.png" alt="Automa" className="auth-shell__brand-wordmark auth-shell__brand-wordmark--dark" />
          <div className="auth-shell__brand-copy">
            <span className="auth-shell__brand-label">Automa desktop</span>
            <span className="auth-shell__brand-name">Authentication</span>
          </div>
        </div>
        <div className="auth-shell__header-actions">
          <span className="auth-shell__header-status">Local session surface</span>
          {ctaLabel ? (
            <button type="button" className="auth-shell__header-link" onClick={onCtaClick}>
              {ctaLabel}
            </button>
          ) : null}
        </div>
      </div>
      <div className="auth-shell__grid">
        <motion.section
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="auth-shell__story"
        >
          <div className="auth-shell__story-copy">
            <div className="auth-shell__eyebrow">Desktop job automation</div>
            <h1 className="auth-shell__title">{title}</h1>
            <p className="auth-shell__subtitle">{subtitle}</p>
          </div>
          <div className="auth-shell__aside">{aside}</div>
        </motion.section>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
          className="auth-shell__panel"
        >
          <div className="auth-shell__panel-inner">
            <div className="auth-shell__panel-card">{children}</div>
          </div>
        </motion.div>
      </div>
    </main>
  );
}
