export const CELL_FREE = 0;
export const CELL_OCCUPIED = 100;
export const CELL_UNKNOWN = -1;

export type CellValue = typeof CELL_FREE | typeof CELL_OCCUPIED | typeof CELL_UNKNOWN;

export interface GridMetadata {
    resolution: number; // meters per pixel
    origin: {
        x: number;
        y: number;
        theta: number;
    };
    image?: string;
    negate?: number;
    occupied_thresh?: number;
    free_thresh?: number;
    mode?: string;
}

export type GridData = Int8Array; // Flattened 1D array

export interface GridState {
    width: number;
    height: number;
    data: GridData;
    metadata: GridMetadata;
}
