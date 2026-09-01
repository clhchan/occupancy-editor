import { renderHook, act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CELL_FREE, CELL_OCCUPIED } from '../types';
import { useGrid } from './useGrid';

describe('useGrid history baseline', () => {
    it('starts undo history at the imported map', () => {
        const { result } = renderHook(() => useGrid({ initialWidth: 2, initialHeight: 2, initialResolution: 0.05 }));
        const imported = new Int8Array([CELL_OCCUPIED, CELL_FREE, CELL_FREE, CELL_OCCUPIED]);

        act(() => result.current.replaceGrid(imported, 2, 2, {
            resolution: 0.05,
            origin: { x: 1, y: 2, theta: 0 },
        }));

        expect(result.current.canUndo).toBe(false);
        expect(result.current.isAtInitial).toBe(true);

        act(() => result.current.updateGrid(new Int8Array([CELL_FREE, CELL_FREE, CELL_FREE, CELL_OCCUPIED])));
        expect(result.current.canUndo).toBe(true);

        act(() => result.current.undo());
        expect(result.current.gridData).toEqual(imported);
        expect(result.current.canUndo).toBe(false);
        expect(result.current.isAtInitial).toBe(true);
    });

    it('keeps the imported baseline after the history limit is reached', () => {
        const { result } = renderHook(() => useGrid({ initialWidth: 2, initialHeight: 2, initialResolution: 0.05 }));
        const imported = new Int8Array([CELL_OCCUPIED, CELL_FREE, CELL_FREE, CELL_OCCUPIED]);

        act(() => result.current.replaceGrid(imported, 2, 2, {
            resolution: 0.05,
            origin: { x: 1, y: 2, theta: 0 },
        }));

        for (let index = 0; index < 50; index += 1) {
            act(() => {
                const next = new Int8Array(imported);
                next[index % next.length] = index % 2 === 0 ? CELL_FREE : CELL_OCCUPIED;
                next[(index + 1) % next.length] = index;
                result.current.updateGrid(next);
            });
        }

        for (let index = 0; index < 50; index += 1) {
            act(() => result.current.undo());
        }

        expect(result.current.gridData).toEqual(imported);
        expect(result.current.isAtInitial).toBe(true);
    });
});
