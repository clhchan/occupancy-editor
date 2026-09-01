import { useState, useCallback, useRef } from 'react';
import {
    CELL_FREE,
    type GridData,
    type GridMetadata,
    type GridState
} from '../types';

// Keep history bounded while recording each completed edit as one transaction.
// The imported/reset state is kept separately at index 0, so this is the
// maximum number of editable states after the baseline.
const MAX_HISTORY = 50;

interface UseGridOptions {
    initialWidth: number;
    initialHeight: number;
    initialResolution: number;
}

function sameMetadata(left: GridMetadata, right: GridMetadata): boolean {
    return left.resolution === right.resolution
        && left.origin.x === right.origin.x
        && left.origin.y === right.origin.y
        && left.origin.theta === right.origin.theta
        && left.image === right.image
        && left.negate === right.negate
        && left.occupied_thresh === right.occupied_thresh
        && left.free_thresh === right.free_thresh
        && left.mode === right.mode;
}

export function useGrid({ initialWidth, initialHeight, initialResolution }: UseGridOptions) {
    const [width, setWidth] = useState(initialWidth);
    const [height, setHeight] = useState(initialHeight);

    // Metadata state
    const [metadata, setMetadata] = useState<GridMetadata>({
        resolution: initialResolution,
        origin: { x: 0, y: 0, theta: 0 },
    });

    // Current grid data
    const [gridData, setGridData] = useState<GridData>(() => {
        return new Int8Array(initialWidth * initialHeight).fill(CELL_FREE);
    });

    // History for Undo/Redo
    const historyRef = useRef<GridState[]>([]);
    const historyIndexRef = useRef<number>(-1);
    const [, setVersion] = useState(0); // Trigger re-reners

    const saveToHistory = useCallback((newState: GridState) => {
        const currentIndex = historyIndexRef.current;
        const current = historyRef.current[currentIndex];
        if (current && current.width === newState.width && current.height === newState.height && current.data.length === newState.data.length && current.data.every((value, index) => value === newState.data[index]) && sameMetadata(current.metadata, newState.metadata)) {
            return;
        }
        const newHistory = historyRef.current.slice(0, currentIndex + 1);
        newHistory.push(newState);
        // Never evict index 0: it is the imported/reset baseline used by the
        // dirty-state calculation and by the user's "undo all" expectation.
        const maxEntries = MAX_HISTORY + 1;
        if (newHistory.length > maxEntries) {
            newHistory.splice(1, newHistory.length - maxEntries);
        }
        historyRef.current = newHistory;
        historyIndexRef.current = newHistory.length - 1;
        setVersion(v => v + 1);
    }, []);

    // Initial history push
    if (historyRef.current.length === 0) {
        historyRef.current.push({ width, height, data: gridData, metadata });
        historyIndexRef.current = 0;
    }

    const updateGrid = useCallback((newData: GridData, newWidth: number = width, newHeight: number = height, commit = true) => {
        setGridData(newData);
        if (newWidth !== width) setWidth(newWidth);
        if (newHeight !== height) setHeight(newHeight);

        if (commit) saveToHistory({ width: newWidth, height: newHeight, data: newData, metadata });
    }, [width, height, metadata, saveToHistory]);

    const replaceGrid = useCallback((newData: GridData, newWidth: number, newHeight: number, newMetadata: GridMetadata) => {
        const nextData = new Int8Array(newData);
        const nextMetadata: GridMetadata = {
            ...newMetadata,
            origin: { ...newMetadata.origin },
        };
        const nextState: GridState = { width: newWidth, height: newHeight, data: nextData, metadata: nextMetadata };
        setGridData(nextData);
        setWidth(newWidth);
        setHeight(newHeight);
        setMetadata(nextMetadata);
        // Loading a map establishes a new editing baseline. The previous
        // blank canvas must not remain reachable through Undo.
        historyRef.current = [nextState];
        historyIndexRef.current = 0;
        setVersion(v => v + 1);
    }, []);

    const resetGrid = useCallback((newData: GridData, newWidth: number, newHeight: number, newMetadata: GridMetadata) => {
        const resetData = new Int8Array(newData);
        const resetMetadata: GridMetadata = {
            ...newMetadata,
            origin: { ...newMetadata.origin },
        };
        const resetState: GridState = { width: newWidth, height: newHeight, data: resetData, metadata: resetMetadata };
        setGridData(resetData);
        setWidth(newWidth);
        setHeight(newHeight);
        setMetadata(resetMetadata);
        historyRef.current = [resetState];
        historyIndexRef.current = 0;
        setVersion(v => v + 1);
    }, []);

    const undo = useCallback(() => {
        if (historyIndexRef.current > 0) {
            historyIndexRef.current--;
            const state = historyRef.current[historyIndexRef.current];
            setGridData(state.data);
            setWidth(state.width);
            setHeight(state.height);
            setMetadata(state.metadata);
            setVersion(v => v + 1);
        }
    }, []);

    const redo = useCallback(() => {
        if (historyIndexRef.current < historyRef.current.length - 1) {
            historyIndexRef.current++;
            const state = historyRef.current[historyIndexRef.current];
            setGridData(state.data);
            setWidth(state.width);
            setHeight(state.height);
            setMetadata(state.metadata);
            setVersion(v => v + 1);
        }
    }, []);

    return {
        width,
        height,
        gridData,
        metadata,
        updateGrid,
        replaceGrid,
        resetGrid,
        undo,
        redo,
        canUndo: historyIndexRef.current > 0,
        canRedo: historyIndexRef.current < historyRef.current.length - 1,
        isAtInitial: historyIndexRef.current === 0,
    };
}
