import React from 'react';

interface TapeRibbonsProps {
  className?: string;
}

export const TapeRibbons: React.FC<TapeRibbonsProps> = ({ className = '' }) => {
  const tickerText1 = 'OUTSIDE.VIP ✦ LIVE MUSIC ✦ ART & CULTURE ✦ SPORTS ✦ WORKSHOPS ✦ ';
  const tickerText2 = 'FIND YOUR PEOPLE ✦ FOOD & DRINK ✦ CONFERENCES ✦ FESTIVALS ✦ NEW EXPERIENCES ✦ ';

  return (
    <div
      className={`relative w-full overflow-hidden py-10 sm:py-14 ${className}`}
      aria-label="Outside.vip experience categories"
    >
      {/* Tape 1: Tilted slightly counter-clockwise */}
      <div className="relative w-[112%] -left-[6%] rotate-[-2.2deg] bg-[#2A221C] border-y border-[#483B32] shadow-xl py-2.5 sm:py-3 z-10 overflow-hidden">
        <div className="flex whitespace-nowrap text-xs sm:text-sm font-mono uppercase tracking-[0.22em] text-[#ECE5DA] font-bold opacity-90 animate-[marquee_35s_linear_infinite] motion-reduce:animate-none">
          <span>{tickerText1.repeat(4)}</span>
          <span>{tickerText1.repeat(4)}</span>
        </div>
      </div>

      {/* Tape 2: Tilted slightly clockwise, crossing over Tape 1 */}
      <div className="relative w-[112%] -left-[6%] rotate-[1.8deg] -mt-6 sm:-mt-8 bg-[#231C17] border-y border-[#40342B] shadow-2xl py-2.5 sm:py-3 z-20 overflow-hidden">
        <div className="flex whitespace-nowrap text-xs sm:text-sm font-mono uppercase tracking-[0.22em] text-[#E0D8CB] font-bold opacity-85 animate-[marquee-reverse_40s_linear_infinite] motion-reduce:animate-none">
          <span>{tickerText2.repeat(4)}</span>
          <span>{tickerText2.repeat(4)}</span>
        </div>
      </div>
    </div>
  );
};
