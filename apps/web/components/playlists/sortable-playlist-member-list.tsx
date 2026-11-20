'use client';

// The reorder-mode branch of the member list. It carries all of dnd-kit, so it
// is loaded with `next/dynamic` from `PlaylistMemberList` and stays out of the
// Library bundle until the owner actually enters reorder mode.

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import type { PlaylistMemberItem } from '@liedmotif/shared';
import { cn } from '@/lib/cn';
import { PlaylistMemberRow } from './playlist-member-row';

export function SortablePlaylistMemberList({
  items,
  onReorder,
  onPlayFrom,
}: {
  items: PlaylistMemberItem[];
  /** The whole list in its new order — the mode buffers it until Done. */
  onReorder: (items: PlaylistMemberItem[]) => void;
  onPlayFrom: (trackId: string) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => item.id === active.id);
    const to = items.findIndex((item) => item.id === over.id);
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(items, from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        {items.map((item) => (
          <SortableMemberRow key={item.id} item={item} onPlay={() => onPlayFrom(item.id)} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableMemberRow({ item, onPlay }: { item: PlaylistMemberItem; onPlay: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  return (
    <PlaylistMemberRow
      item={item}
      onPlay={onPlay}
      containerRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'relative z-10 opacity-80')}
      grip={
        <button
          type="button"
          aria-label={`Drag to Reorder ${item.title ?? 'Untitled Track'}`}
          {...attributes}
          {...listeners}
          className="grid h-10 cursor-grab touch-none place-items-center text-dim active:cursor-grabbing"
        >
          <GripVertical className="h-[17px] w-[17px]" />
        </button>
      }
    />
  );
}
