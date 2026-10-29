import React, { createContext, useContext, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, RotateCcw } from 'lucide-react';
import { InfoTooltip } from '../components/InfoTooltip';

export const DEFAULT_CHART_COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#6366f1',
];

interface ChartColorContextValue {
  colors: string[];
  setColors: React.Dispatch<React.SetStateAction<string[]>>;
  resetColors: () => void;
}

const ChartColorContext = createContext<ChartColorContextValue | undefined>(undefined);

export const ChartColorProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [colors, setColors] = useState<string[]>(DEFAULT_CHART_COLORS);

  const resetColors = () => setColors(DEFAULT_CHART_COLORS);

  return (
    <ChartColorContext.Provider value={{ colors, setColors, resetColors }}>
      {children}
    </ChartColorContext.Provider>
  );
};

export function useChartColors(): ChartColorContextValue {
  const ctx = useContext(ChartColorContext);
  if (!ctx) {
    throw new Error('useChartColors must be used within a ChartColorProvider');
  }
  return ctx;
}

const SortableSwatchItem: React.FC<{ id: string; index: number }> = ({ id, index }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 40 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      title={`Drag to reorder series color #${index + 1} (${id})`}
      className={`flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 cursor-grab active:cursor-grabbing select-none transition-shadow ${
        isDragging ? 'shadow-lg ring-2 ring-blue-500' : 'hover:border-zinc-300 dark:hover:border-zinc-700'
      }`}
    >
      <GripVertical className="w-3 h-3 text-zinc-400" />
      <span
        className="w-3.5 h-3.5 rounded-sm border border-black/10"
        style={{ backgroundColor: id }}
      />
      <span className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{index + 1}</span>
    </div>
  );
};

export const SortableColorPaletteBar: React.FC = () => {
  const { colors, setColors, resetColors } = useChartColors();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setColors((items) => {
        const oldIndex = items.indexOf(String(active.id));
        const newIndex = items.indexOf(String(over.id));
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-[#0c0c0f] border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1.5">
          Chart Series Palette (Drag to Reorder):
          <InfoTooltip
            title="Interactive Chart Series Color Palette"
            description="Drag and drop any color swatch to immediately reorder the series colors across all Apache ECharts visualizations below, or click Reset to restore default colors."
            align="left"
          />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={colors} strategy={horizontalListSortingStrategy}>
            <div className="flex flex-wrap items-center gap-1.5">
              {colors.map((hex, idx) => (
                <SortableSwatchItem key={hex} id={hex} index={idx} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <button
          type="button"
          onClick={resetColors}
          className="inline-flex items-center gap-1 text-xs font-medium text-[#2563eb] dark:text-[#60a5fa] hover:bg-[#eff6ff] dark:hover:bg-[#1e3a8a]/40 rounded-[8px] px-2.5 py-1 transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset
        </button>
      </div>
    </div>
  );
};
