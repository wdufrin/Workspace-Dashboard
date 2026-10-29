import React, { useEffect, useRef, useState } from 'react';
import { Info, X } from 'lucide-react';

export interface InfoTooltipProps {
  title: string;
  description: string;
  apiSource?: string;
  align?: 'left' | 'center' | 'right';
}

/**
 * Interactive Information Button (`i`) that reveals a detailed explanation popover
 * on hover/focus OR click-to-pin. Stops event propagation so it can be placed inside
 * or alongside buttons, headers, and KPI cards without triggering parent actions.
 */
export const InfoTooltip: React.FC<InfoTooltipProps> = ({
  title,
  description,
  apiSource,
  align = 'center',
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  const isOpen = isHovered || isPinned;

  useEffect(() => {
    if (!isPinned) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsPinned(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPinned(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isPinned]);

  const alignmentClasses =
    align === 'right'
      ? 'right-0'
      : align === 'left'
        ? 'left-0'
        : 'left-1/2 -translate-x-1/2';

  return (
    <span
      ref={containerRef}
      className="relative inline-flex items-center align-middle"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
      }}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label={`More info: ${title}`}
        aria-expanded={isOpen}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsPinned((prev) => !prev);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            setIsPinned((prev) => !prev);
          }
        }}
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50 ${
          isPinned
            ? 'bg-blue-600 text-white'
            : 'text-zinc-400 hover:text-blue-500 dark:text-zinc-500 dark:hover:text-blue-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800'
        }`}
      >
        <Info className="w-3.5 h-3.5" />
      </span>

      {isOpen && (
        <div
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          className={`absolute top-full mt-2 ${alignmentClasses} z-50 w-72 bg-[#ffffff] dark:bg-[#121217] border border-zinc-200 dark:border-zinc-700 rounded-[10px] p-3.5 shadow-xl text-left normal-case tracking-normal font-normal pointer-events-auto`}
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <span className="text-xs font-bold text-zinc-950 dark:text-zinc-50 leading-snug">
              {title}
            </span>
            {isPinned && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Close info popover"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsPinned(false);
                  setIsHovered(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsPinned(false);
                    setIsHovered(false);
                  }
                }}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-0.5 rounded cursor-pointer"
              >
                <X className="w-3 h-3" />
              </span>
            )}
          </div>
          <p className="text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed">
            {description}
          </p>
          {apiSource && (
            <div className="mt-2 pt-1.5 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-1">
              <span className="text-[10px] font-semibold uppercase text-zinc-400">
                Source / API:
              </span>
              <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/50 px-1.5 py-0.5 rounded truncate max-w-[190px]">
                {apiSource}
              </span>
            </div>
          )}
        </div>
      )}
    </span>
  );
};
