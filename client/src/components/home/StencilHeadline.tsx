import React from 'react';

interface StencilHeadlineProps {
  className?: string;
  title?: string;
  subtitle?: string;
}

/**
 * StencilHeadline renders the editorial brand headline for Outside.vip.
 * Crisp, responsive, fully selectable typography with balanced tracking and scale.
 */
export const StencilHeadline: React.FC<StencilHeadlineProps> = ({
  className = '',
  title = "THE WORLD AWAITS",
  subtitle = 'FIND SOMETHING WORTH SHOWING UP FOR',
}) => {
  return (
    <div className={`w-full max-w-5xl mx-auto text-center space-y-3 ${className}`}>
      {/* Primary Brand Headline — High-impact, crisply scaled, and 100% selectable */}
      <h1 className="font-display font-black text-3xl sm:text-5xl md:text-6xl lg:text-7xl tracking-tight text-stone-900 uppercase select-text">
        {title}
      </h1>

      {subtitle && (
        <p className="text-[11px] sm:text-xs font-mono uppercase tracking-[0.22em] text-[#7A7165] font-semibold select-text">
          {subtitle}
        </p>
      )}
    </div>
  );
};

