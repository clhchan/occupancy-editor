import React, { useRef, useEffect, useState, useCallback } from 'react';
import { CELL_OCCUPIED, CELL_FREE, CELL_UNKNOWN, type GridData } from '../types';
import {
    evaluatePlacement,
    MIN_YAW_DRAG_PX,
    yawFromDrag,
    type PlacementStatus,
} from '../utils/waypoints';

interface GridCanvasProps {
    width: number;
    height: number;
    data: Int8Array;
    backgroundData?: Int8Array;
    tool: string;
    brushSize: number;
    onUpdate: (data: Int8Array, commit?: boolean) => void;
    // --- 地点标记 ---
    // markingSlot 非空时画布进入标记模式：按下确定位置，拖动确定朝向。
    markingSlot?: { id: string; color: string } | null;
    placedWaypoints?: Array<{ id: string; name: string; color: string; col: number; row: number; yawRad: number | null }>;
    baseMapData?: GridData | null;
    onPlaceWaypoint?: (payload: { col: number; row: number; yawRad: number; status: PlacementStatus; reason: string }) => void;
    onCancelMarking?: () => void;
    // 标记箭头长度（栅格数），按地图真实尺寸绘制。
    markerArrowCells?: number;
}
// Define handle for imperative methods
export interface GridCanvasHandle {
    resetView: () => void;
}

function bresenham(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
        points.push({ x: x0, y: y0 });
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x0 += sx;
        }
        if (e2 < dx) {
            err += dx;
            y0 += sy;
        }
    }
    return points;
}

export const GridCanvas = React.forwardRef<GridCanvasHandle, GridCanvasProps>(({
    width, height, data, backgroundData, tool, brushSize, onUpdate,
    markingSlot = null, placedWaypoints = [], baseMapData = null,
    onPlaceWaypoint, onCancelMarking, markerArrowCells = 15,
}, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Transform state: scale (k), translation (x, y)
    const [transform, setTransform] = useState({ k: 20, x: 50, y: 50 }); // Start with reasonable zoom
    const [initialized, setInitialized] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    // Drawing state
    const [isDrawing, setIsDrawing] = useState(false);
    const startPosRef = useRef<{ x: number, y: number } | null>(null);
    const lastPosRef = useRef<{ x: number, y: number } | null>(null);
    const workingDataRef = useRef<Int8Array | null>(null);

    const [previewRect, setPreviewRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
    const [previewLine, setPreviewLine] = useState<{ x0: number, y0: number, x1: number, y1: number } | null>(null);
    const [hoverCoord, setHoverCoord] = useState<{ x: number, y: number } | null>(null);
    const [previewTool, setPreviewTool] = useState<string | null>(null);
    const baseRasterRef = useRef<{ source: Int8Array; width: number; height: number; canvas: HTMLCanvasElement } | null>(null);
    const maskRasterRef = useRef<{ source: Int8Array; width: number; height: number; canvas: HTMLCanvasElement } | null>(null);
    const gestureToolRef = useRef<string | null>(null);
    const gestureUpdateRef = useRef<typeof onUpdate | null>(null);
    const updateRef = useRef(onUpdate);
    const pointerIdRef = useRef<number | null>(null);
    const gestureChangedRef = useRef(false);
    const pendingPreviewRef = useRef<Int8Array | null>(null);
    const previewFrameRef = useRef<number | null>(null);

    // --- 地点标记状态 ---
    // 标记手势：按下记录起点栅格，拖动更新当前栅格，松开回调提交。
    const [isMarking, setIsMarking] = useState(false);
    const [markPreview, setMarkPreview] = useState<{ col: number; row: number; yawRad: number | null; status: PlacementStatus; reason: string } | null>(null);
    const markStartRef = useRef<{ x: number; y: number } | null>(null);

    updateRef.current = onUpdate;

    const getFitScale = useCallback(() => {
        if (!containerRef.current) return 2;
        const { clientWidth, clientHeight } = containerRef.current;
        const kx = (clientWidth * 0.95) / width;
        const ky = (clientHeight * 0.95) / height;
        // The fit scale is also the minimum zoom: zooming out should stop
        // when the complete map has just become visible.
        return Math.min(Math.min(kx, ky), 50);
    }, [height, width]);

    // Auto-fit function (center the grid)
    const fitView = useCallback(() => {
        if (!containerRef.current) return;
        const { clientWidth, clientHeight } = containerRef.current;
        const k = getFitScale();
        // Center the grid (transform.x and transform.y represent the center point)
        const x = clientWidth / 2;
        const y = clientHeight / 2;
        setTransform({ k, x, y });
    }, [getFitScale]);

    // Initial Auto-fit
    useEffect(() => {
        if (!initialized && containerRef.current) {
            fitView();
            setInitialized(true);
        }
    }, [initialized, fitView]);

    // Coordinate conversion helpers
    // Display coordinates: center-based (-width/2 to +width/2, -height/2 to +height/2)
    // Internal coordinates: 0-based (0 to width-1, 0 to height-1)
    const displayToInternal = useCallback((dx: number, dy: number) => {
        const centerX = Math.floor(width / 2);
        const centerY = Math.floor(height / 2);
        return {
            x: Math.floor(dx + centerX),
            y: Math.floor(dy + centerY)
        };
    }, [width, height]);
    
    const internalToDisplay = useCallback((ix: number, iy: number) => {
        const centerX = Math.floor(width / 2);
        const centerY = Math.floor(height / 2);
        return {
            x: ix - centerX,
            y: iy - centerY
        };
    }, [width, height]);

    // Expose resetView via ref
    React.useImperativeHandle(ref, () => ({
        resetView: fitView
    }));

    // Helper: Screen to Display coordinates (center-based)
    const screenToDisplay = useCallback((sx: number, sy: number) => {
        // transform.x and transform.y represent the center point in screen coordinates
        // Convert screen coords to display coords (center-based)
        const displayX = (sx - transform.x) / transform.k;
        const displayY = (sy - transform.y) / transform.k;
        return {
            x: Math.floor(displayX),
            y: Math.floor(displayY)
        };
    }, [transform]);

    // --- Rendering Loop ---
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const render = () => {
            if (!containerRef.current) return;
            const { clientWidth, clientHeight } = containerRef.current;
            const pixelWidth = Math.max(1, Math.round(clientWidth * dpr));
            const pixelHeight = Math.max(1, Math.round(clientHeight * dpr));

            if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
                canvas.width = pixelWidth;
                canvas.height = pixelHeight;
                ctx.scale(dpr, dpr);
                canvas.style.width = `${clientWidth}px`;
                canvas.style.height = `${clientHeight}px`;
            }

            // Clear Background (Whole Canvas)
            ctx.fillStyle = '#f3f4f6'; // Light gray outer background
            ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

            ctx.save();
            
            // Center-based coordinate system
            const centerX = Math.floor(width / 2);
            const centerY = Math.floor(height / 2);
            
            ctx.translate(transform.x, transform.y);
            ctx.scale(transform.k, transform.k);
            ctx.translate(-centerX, -centerY); // Shift so center is at (0,0)

            // 1. Draw Grid Background
            ctx.fillStyle = '#ffffff'; // Pure White
            // Draw from (0,0) since translate(-centerX) already shifts us
            ctx.fillRect(0, 0, width, height);

            // 2. Render Existing Data
            ctx.imageSmoothingEnabled = false;
            const baseData = backgroundData || data;
            let baseRaster = baseRasterRef.current;
            if (!baseRaster || baseRaster.source !== baseData || baseRaster.width !== width || baseRaster.height !== height) {
                const image = ctx.createImageData(width, height);
                const pixels = new Uint32Array(image.data.buffer);
                for (let i = 0; i < Math.min(baseData.length, width * height); i += 1) {
                    const value = baseData[i];
                    pixels[i] = value === CELL_OCCUPIED ? 0xFF000000 : value === CELL_FREE ? 0xFFFFFFFF : 0xFFDBD5D1;
                }
                const rasterCanvas = document.createElement('canvas');
                rasterCanvas.width = width;
                rasterCanvas.height = height;
                rasterCanvas.getContext('2d')?.putImageData(image, 0, 0);
                baseRaster = { source: baseData, width, height, canvas: rasterCanvas };
                baseRasterRef.current = baseRaster;
            }
            ctx.drawImage(baseRaster.canvas, 0, 0);

            // Keepout mask is independent data: show it as a translucent overlay without
            // replacing the base map underneath.
            if (backgroundData) {
                let maskRaster = maskRasterRef.current;
                if (!maskRaster || maskRaster.source !== data || maskRaster.width !== width || maskRaster.height !== height) {
                    const image = ctx.createImageData(width, height);
                    const pixels = new Uint32Array(image.data.buffer);
                    for (let i = 0; i < Math.min(data.length, width * height); i += 1) {
                        pixels[i] = data[i] === CELL_OCCUPIED ? 0xB04F46E5 : 0;
                    }
                    const rasterCanvas = document.createElement('canvas');
                    rasterCanvas.width = width;
                    rasterCanvas.height = height;
                    rasterCanvas.getContext('2d')?.putImageData(image, 0, 0);
                    maskRaster = { source: data, width, height, canvas: rasterCanvas };
                    maskRasterRef.current = maskRaster;
                }
                ctx.drawImage(maskRaster.canvas, 0, 0);
            }

            // 3. Grid Lines (Black Mesh)
            ctx.lineWidth = 0.5 / transform.k;
            // "visible black edges inside the grid so that each cell is visible"
            // User requested 1.0 alpha black.
            ctx.lineWidth = 0.05; // Thin enough to not obscure data but visible
            ctx.strokeStyle = '#555555'; // Dark Grey

            ctx.beginPath();
            // Vertical lines (center-based)
            // Display coordinates: -centerX to (width - centerX - 1)
            // For 50x50: center=25, range is -25 to +24 (50 cells, no true center)
            // For 51x51: center=25, range is -25 to +25 (51 cells, center at 0,0)
            const minX = -centerX;
            const maxX = width - centerX; // Exclusive upper bound
            const minY = -centerY;
            const maxY = height - centerY; // Exclusive upper bound
            
            // Draw grid lines at positions (x + centerX) so they align correctly after translate(-centerX)
            for (let displayX = minX; displayX <= maxX; displayX++) {
                const gridLineX = displayX + centerX; // Position in transformed space before translate(-centerX)
                ctx.moveTo(gridLineX, minY + centerY);
                ctx.lineTo(gridLineX, maxY + centerY);
            }
            // Horizontal lines
            for (let displayY = minY; displayY <= maxY; displayY++) {
                const gridLineY = displayY + centerY;
                ctx.moveTo(minX + centerX, gridLineY);
                ctx.lineTo(maxX + centerX, gridLineY);
            }
            ctx.stroke();

            // 4. Main Border (Thicker)
            ctx.lineWidth = 2 / transform.k;
            ctx.strokeStyle = '#000000';
            // Border around the entire map area (0,0 to width,height in transformed space)
            ctx.strokeRect(0, 0, width, height);

            // 4.5. Center axes (highlight 0,0)
            ctx.lineWidth = 1 / transform.k;
            ctx.strokeStyle = '#3b82f6'; // Blue for center axes
            ctx.beginPath();
            // Vertical center line (at displayX=0, which is centerX in transformed space)
            ctx.moveTo(centerX, 0);
            ctx.lineTo(centerX, height);
            // Horizontal center line
            ctx.moveTo(0, centerY);
            ctx.lineTo(width, centerY);
            ctx.stroke();

            // 5. Preview Rect (convert to display coordinates, then to transformed space)
            if (previewRect) {
                ctx.fillStyle = backgroundData
                    ? (previewTool || tool) === 'eraser' ? 'rgba(255, 255, 255, 0.35)' : 'rgba(229, 70, 79, 0.55)'
                    : (previewTool || tool) === 'eraser' ? 'rgba(251, 252, 254, 0.8)' : (previewTool || tool) === 'unknown' ? 'rgba(156, 163, 175, 0.62)' : 'rgba(0,0,0,0.5)';
                // previewRect is in internal coordinates, convert to display
                const rectDisplay = internalToDisplay(previewRect.x, previewRect.y);
                // Convert to transformed space
                ctx.fillRect(rectDisplay.x + centerX, rectDisplay.y + centerY, previewRect.w, previewRect.h);
            }

            if (previewLine) {
                ctx.fillStyle = backgroundData ? 'rgba(229, 70, 79, 0.69)' : '#000000';
                for (const point of bresenham(previewLine.x0, previewLine.y0, previewLine.x1, previewLine.y1)) {
                    if (point.x < 0 || point.x >= width || point.y < 0 || point.y >= height) continue;
                    const displayPoint = internalToDisplay(point.x, point.y);
                    ctx.fillRect(displayPoint.x + centerX, displayPoint.y + centerY, 1, 1);
                }
            }

            // Show the effective brush footprint before the pointer is pressed.
            // The same centered offsets and map-boundary clipping are used by
            // modifyGrid, so the preview matches the cells a click will edit.
            if (hoverCoord && !isDrawing && ['pencil', 'eraser', 'unknown'].includes(tool)) {
                const size = Math.max(1, Math.min(100, Math.round(brushSize)));
                const startOffset = -Math.floor(size / 2);
                const endOffset = startOffset + size - 1;
                const centerCellX = hoverCoord.x + centerX;
                const centerCellY = hoverCoord.y + centerY;
                const startX = Math.max(0, centerCellX + startOffset);
                const startY = Math.max(0, centerCellY + startOffset);
                const endX = Math.min(width, centerCellX + endOffset + 1);
                const endY = Math.min(height, centerCellY + endOffset + 1);
                const previewWidth = endX - startX;
                const previewHeight = endY - startY;
                if (previewWidth > 0 && previewHeight > 0) {
                    ctx.fillStyle = backgroundData
                        ? tool === 'eraser' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(229, 70, 79, 0.5)'
                        : tool === 'eraser' ? 'rgba(251, 252, 254, 0.7)' : tool === 'unknown' ? 'rgba(156, 163, 175, 0.55)' : 'rgba(0, 0, 0, 0.25)';
                    ctx.fillRect(startX, startY, previewWidth, previewHeight);
                    ctx.strokeStyle = backgroundData ? '#e5464f' : '#111827';
                    ctx.lineWidth = 1 / transform.k;
                    ctx.strokeRect(startX, startY, previewWidth, previewHeight);
                }
            }

            // 5.5 已放置地点常驻显示 + 标记手势预览。
            // 绘制在内部栅格坐标系里，与底图对齐；线宽和字号除以缩放
            // 比例，保证屏幕上观感恒定。箭头带白色衬底，任何底色上都醒目。
            const statusColor = (status: PlacementStatus, fallback: string) => (
                status === 'blocked' ? '#dc2626' : fallback
            );
            const drawWaypointMarker = (col: number, row: number, color: string, yawRad: number | null, label: string | null, preview = false) => {
                ctx.save();
                ctx.globalAlpha = preview ? 0.42 : 1;
                const centerXPos = col + 0.5;
                const centerYPos = row + 0.5;
                // 中心点：实心彩点加白色描边
                ctx.fillStyle = color;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5 / transform.k;
                ctx.beginPath();
                ctx.arc(centerXPos, centerYPos, Math.max(1, 4 / transform.k), 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                // 朝向箭头：按地图真实尺寸绘制（约 0.76 m），白色衬底 + 彩色主体
                if (yawRad !== null) {
                    const arrowLength = Math.max(markerArrowCells, 3);
                    const endX = centerXPos + Math.cos(yawRad) * arrowLength;
                    const endY = centerYPos - Math.sin(yawRad) * arrowLength;
                    const headSize = Math.max(2, 13 / transform.k);
                    const headAngle = Math.PI / 7;
                    const strokeArrow = (lineWidthScreen: number, style: string) => {
                        ctx.lineWidth = lineWidthScreen / transform.k;
                        ctx.strokeStyle = style;
                        ctx.beginPath();
                        ctx.moveTo(centerXPos, centerYPos);
                        ctx.lineTo(endX, endY);
                        ctx.stroke();
                        ctx.fillStyle = style;
                        ctx.beginPath();
                        ctx.moveTo(endX, endY);
                        ctx.lineTo(endX - Math.cos(yawRad - headAngle) * headSize, endY + Math.sin(yawRad - headAngle) * headSize);
                        ctx.lineTo(endX - Math.cos(yawRad + headAngle) * headSize, endY + Math.sin(yawRad + headAngle) * headSize);
                        ctx.closePath();
                        ctx.fill();
                    };
                    strokeArrow(7, '#ffffff');
                    strokeArrow(3.5, color);
                }
                // 名称标签
                if (label) {
                    const fontSize = 15 / transform.k;
                    ctx.font = `bold ${fontSize}px sans-serif`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    const labelY = centerYPos + 6 / transform.k;
                    const textWidth = ctx.measureText(label).width;
                    ctx.fillStyle = preview ? `${color}E6` : color;
                    ctx.fillRect(centerXPos - textWidth / 2 - 4 / transform.k, labelY, textWidth + 8 / transform.k, fontSize + 4 / transform.k);
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(label, centerXPos, labelY + 2 / transform.k);
                }
                ctx.restore();
            };
            for (const waypoint of placedWaypoints) {
                drawWaypointMarker(waypoint.col, waypoint.row, waypoint.color, waypoint.yawRad, waypoint.name);
            }
            if (markPreview && markingSlot) {
                drawWaypointMarker(
                    markPreview.col,
                    markPreview.row,
                    statusColor(markPreview.status, markingSlot.color),
                    markPreview.yawRad,
                    markPreview.status === 'blocked' ? markPreview.reason : null,
                    markPreview.status !== 'blocked',
                );
            }

            ctx.restore();

            // 6. Axis Rulers (center-based coordinates)
            // Transform stack applied to grid: translate(transform.x, transform.y) -> scale(k) -> translate(-centerX, -centerY)
            // When drawing at display coordinate x (center-based, where 0 is center):
            //   - After translate(-centerX): position is (x - centerX) in scaled space
            //   - After scale: position is (x - centerX) * k in screen space (relative to transform.x)
            //   - After translate(transform.x): position is transform.x + (x - centerX) * k
            //   - Simplifying: transform.x + x*k - centerX*k
            // But since x ranges from -centerX to (width-centerX), and we want x=0 at center:
            //   - For x=0: screenX = transform.x - centerX*k (WRONG - should be transform.x)
            // The issue: display coordinate x is already relative to center, but translate(-centerX) shifts it again
            // Solution: draw grid lines at position (x + centerX) in transformed space, not at x
            // So screen position = transform.x + (x + centerX - centerX) * k = transform.x + x * k ✓
            
            const cellSize = transform.k;

            ctx.font = '10px monospace';
            ctx.fillStyle = '#6b7280';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';

            // X Axis
            const step = Math.ceil(30 / cellSize);

            // X Axis Ruler - grid lines are drawn at display coordinates
            // The grid line at displayX appears at screen: transform.x + displayX * cellSize
            const minDisplayX = -centerX;
            const maxDisplayX = width - centerX;
            for (let displayX = minDisplayX; displayX <= maxDisplayX; displayX += Math.max(1, step)) {
                // Grid line at displayX is drawn at position (displayX + centerX) in transformed space
                // After transforms: screenX = transform.x + (displayX + centerX - centerX) * k = transform.x + displayX * k
                const screenX = transform.x + displayX * cellSize;
                if (screenX > 0 && screenX < clientWidth) {
                    const val = displayX.toString();
                    ctx.fillText(val, screenX, transform.y - 4);
                    ctx.beginPath();
                    ctx.moveTo(screenX, transform.y);
                    ctx.lineTo(screenX, transform.y - 3);
                    ctx.stroke();
                }
            }

            // Y Axis Ruler
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            const minDisplayY = -centerY;
            const maxDisplayY = height - centerY;
            for (let displayY = minDisplayY; displayY <= maxDisplayY; displayY += Math.max(1, step)) {
                const screenY = transform.y + displayY * cellSize;
                if (screenY > 0 && screenY < clientHeight) {
                    const val = (-displayY).toString();
                    ctx.fillText(val, transform.x - 8, screenY);
                    ctx.beginPath();
                    ctx.moveTo(transform.x, screenY);
                    ctx.lineTo(transform.x - 5, screenY);
                    ctx.stroke();
                }
            }
        };

        const id = requestAnimationFrame(render);
        return () => cancelAnimationFrame(id);
    }, [width, height, data, backgroundData, transform, previewRect, previewLine, previewTool, tool, brushSize, hoverCoord, isDrawing, internalToDisplay, markingSlot, placedWaypoints, markPreview, markerArrowCells]);


    const flushPreview = useCallback(() => {
        if (previewFrameRef.current !== null) {
            window.cancelAnimationFrame(previewFrameRef.current);
            previewFrameRef.current = null;
        }
        const pending = pendingPreviewRef.current;
        pendingPreviewRef.current = null;
        if (pending) (gestureUpdateRef.current || updateRef.current)(new Int8Array(pending), false);
    }, []);

    const schedulePreview = useCallback((nextData: Int8Array) => {
        pendingPreviewRef.current = nextData;
        if (previewFrameRef.current !== null) return;
        previewFrameRef.current = window.requestAnimationFrame(() => {
            previewFrameRef.current = null;
            const pending = pendingPreviewRef.current;
            pendingPreviewRef.current = null;
            if (pending) (gestureUpdateRef.current || updateRef.current)(new Int8Array(pending), false);
        });
    }, []);

    useEffect(() => () => {
        if (previewFrameRef.current !== null) window.cancelAnimationFrame(previewFrameRef.current);
    }, []);

    // --- Event Handling ---
    // Edge mouse gestures are driven by compatibility mouse events, so cancel
    // those events during canvas panning in addition to Pointer Events.
    const handleMouseDownCapture = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const handleMouseMoveCapture = (e: React.MouseEvent<HTMLDivElement>) => {
        if ((e.buttons & 2) !== 0 || (e.buttons & 4) !== 0 || ((e.buttons & 1) !== 0 && e.altKey)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const handleMouseUpCapture = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
            e.preventDefault();
            e.stopPropagation();
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.stopPropagation();
        const zoomSensitivity = 0.001;
        const delta = -e.deltaY * zoomSensitivity;
        const scaleFactor = 1 + delta;
        const minZoom = getFitScale();
        const newK = Math.min(Math.max(transform.k * scaleFactor, minZoom), 100); // Max zoom 100, min fit-to-window

        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const wx = (mx - transform.x) / transform.k;
        const wy = (my - transform.y) / transform.k;
        const newTx = mx - wx * newK;
        const newTy = my - wy * newK;

        setTransform({ k: newK, x: newTx, y: newTy });
    };

    // --- 地点标记 ---
    // Esc 取消标记手势。
    useEffect(() => {
        if (!markingSlot) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !isMarking) onCancelMarking?.();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [markingSlot, isMarking, onCancelMarking]);

    const evaluateMarkPlacement = useCallback((col: number, row: number) => {
        const mapData = baseMapData || data;
        return evaluatePlacement({ col, row, width, height, mapData });
    }, [baseMapData, data, height, width]);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button === 2 || e.button === 1 || (e.button === 0 && e.altKey)) {
            // Prevent Edge mouse gestures/autoscroll while preserving right/middle-button panning.
            e.preventDefault();
            e.stopPropagation();
            setIsPanning(true);
            pointerIdRef.current = e.pointerId;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            return;
        }

        if (e.button === 0) {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const display = screenToDisplay(mouseX, mouseY);
            const internal = displayToInternal(display.x, display.y);

            // Bounds check (internal coordinates)
            if (internal.x < 0 || internal.x >= width || internal.y < 0 || internal.y >= height) return;

            // 地点标记手势：按下确定位置，拖动确定朝向，松开提交。
            if (markingSlot) {
                pointerIdRef.current = e.pointerId;
                markStartRef.current = internal;
                setIsMarking(true);
                e.currentTarget.setPointerCapture?.(e.pointerId);
                const report = evaluateMarkPlacement(internal.x, internal.y);
                setMarkPreview({ col: internal.x, row: internal.y, yawRad: null, status: report.status, reason: report.reason });
                return;
            }

            pointerIdRef.current = e.pointerId;
            gestureToolRef.current = tool;
            gestureUpdateRef.current = onUpdate;
            gestureChangedRef.current = false;
            setPreviewTool(tool);
            e.currentTarget.setPointerCapture?.(e.pointerId);

            if (tool === 'pencil' || tool === 'eraser' || tool === 'unknown') {
                setIsDrawing(true);
                workingDataRef.current = new Int8Array(data);
                lastPosRef.current = internal; // Store internal for drawing
                const value = tool === 'pencil' ? CELL_OCCUPIED : tool === 'unknown' ? CELL_UNKNOWN : CELL_FREE;
                modifyGrid([{ x: internal.x, y: internal.y }], value, false, tool);
            } else if (tool === 'rect') {
                setIsDrawing(true);
                workingDataRef.current = new Int8Array(data);
                startPosRef.current = internal; // Store internal for rect
                setPreviewRect({ x: internal.x, y: internal.y, w: 1, h: 1 });
            } else if (tool === 'line') {
                setIsDrawing(true);
                workingDataRef.current = new Int8Array(data);
                startPosRef.current = internal;
                setPreviewLine({ x0: internal.x, y0: internal.y, x1: internal.x, y1: internal.y });
            }
        }
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Update Hover Coord (in display coordinates)
        const display = screenToDisplay(mouseX, mouseY);
        const internal = displayToInternal(display.x, display.y);

        if (internal.x >= 0 && internal.x < width && internal.y >= 0 && internal.y < height) {
            setHoverCoord(display); // Store display coordinates for hover
        } else {
            setHoverCoord(null);
        }

        // Pan. Check the button bitmask as well as state so the first move event
        // is blocked even before React commits the pointer-down state update.
        const isBrowserGesture = (e.buttons & 2) !== 0 || (e.buttons & 4) !== 0 || ((e.buttons & 1) !== 0 && e.altKey);
        if (isPanning || isBrowserGesture) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (isPanning) {
            setTransform(prev => ({
                ...prev,
                x: prev.x + e.movementX,
                y: prev.y + e.movementY
            }));
            return;
        }

        // 地点标记拖动：位置固定在按下点，拖动只决定朝向。
        if (isMarking && markStartRef.current) {
            const start = markStartRef.current;
            const cellDistance = Math.hypot(internal.x - start.x, internal.y - start.y);
            const yawRad = cellDistance * transform.k >= MIN_YAW_DRAG_PX
                ? yawFromDrag(start.x, start.y, internal.x, internal.y)
                : null;
            const report = evaluateMarkPlacement(start.x, start.y);
            setMarkPreview((current) => (
                current && current.yawRad === yawRad && current.status === report.status && current.reason === report.reason
                    ? current
                    : { col: start.x, row: start.y, yawRad, status: report.status, reason: report.reason }
            ));
            return;
        }

        // Draw
        if (isDrawing) {
            const display = screenToDisplay(mouseX, mouseY);
            const internal = displayToInternal(display.x, display.y);
            
            const activeTool = gestureToolRef.current || tool;
            if (activeTool === 'rect' && startPosRef.current) {
                const sx = startPosRef.current.x;
                const sy = startPosRef.current.y;
                setPreviewRect({
                    x: Math.min(sx, internal.x),
                    y: Math.min(sy, internal.y),
                    w: Math.abs(internal.x - sx) + 1,
                    h: Math.abs(internal.y - sy) + 1
                });
            } else if (activeTool === 'line' && startPosRef.current) {
                setPreviewLine({
                    x0: startPosRef.current.x,
                    y0: startPosRef.current.y,
                    x1: internal.x,
                    y1: internal.y
                });
            } else if ((activeTool === 'pencil' || activeTool === 'eraser' || activeTool === 'unknown') && lastPosRef.current) {
                const points = bresenham(lastPosRef.current.x, lastPosRef.current.y, internal.x, internal.y);
                const value = activeTool === 'pencil' ? CELL_OCCUPIED : activeTool === 'unknown' ? CELL_UNKNOWN : CELL_FREE;
                modifyGrid(points, value, false, activeTool);
                lastPosRef.current = { x: internal.x, y: internal.y };
            }
        }
    };

    function finishGesture() {
        const activeTool = gestureToolRef.current || tool;
        setIsPanning(false);
        setIsDrawing(false);

        // 结束地点标记手势；提交在 handlePointerUp 中先行处理，这里只复位。
        if (isMarking) {
            setIsMarking(false);
            markStartRef.current = null;
            setMarkPreview(null);
        }

        if (activeTool === 'rect' && previewRect) {
            const points = [];
            for (let py = previewRect.y; py < previewRect.y + previewRect.h; py++) {
                for (let px = previewRect.x; px < previewRect.x + previewRect.w; px++) {
                    points.push({ x: px, y: py });
                }
            }
            modifyGrid(points, CELL_OCCUPIED, true);
            setPreviewRect(null);
        } else if (activeTool === 'line' && previewLine) {
            const points = bresenham(previewLine.x0, previewLine.y0, previewLine.x1, previewLine.y1);
            modifyGrid(points, CELL_OCCUPIED, true);
            setPreviewLine(null);
        } else if ((activeTool === 'pencil' || activeTool === 'eraser' || activeTool === 'unknown') && gestureChangedRef.current && workingDataRef.current) {
            flushPreview();
            (gestureUpdateRef.current || updateRef.current)(new Int8Array(workingDataRef.current), true);
        }

        if (pointerIdRef.current !== null && containerRef.current?.hasPointerCapture(pointerIdRef.current)) {
            containerRef.current.releasePointerCapture(pointerIdRef.current);
        }
        pendingPreviewRef.current = null;
        startPosRef.current = null;
        lastPosRef.current = null;
        workingDataRef.current = null;
        gestureToolRef.current = null;
        gestureUpdateRef.current = null;
        pointerIdRef.current = null;
        gestureChangedRef.current = false;
        setPreviewTool(null);
    }

    const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return;
        if (isPanning || e.button === 2 || e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
        }
        // 只有形成有效朝向拖拽才提交；单击只结束本次预览。
        if (isMarking && markPreview && markPreview.yawRad !== null && markStartRef.current) {
            onPlaceWaypoint?.({
                col: markPreview.col,
                row: markPreview.row,
                yawRad: markPreview.yawRad,
                status: markPreview.status,
                reason: markPreview.reason,
            });
        }
        finishGesture();
    };

    const modifyGrid = (points: { x: number, y: number }[], explicitValue?: number, commit = true, toolOverride?: string) => {
        const newData = workingDataRef.current || new Int8Array(data);
        let changed = false;
        const activeTool = toolOverride || gestureToolRef.current || tool;
        const targetVal = explicitValue ?? (activeTool === 'eraser' ? CELL_FREE : CELL_OCCUPIED);
        const usesBrush = activeTool === 'pencil' || activeTool === 'eraser' || activeTool === 'unknown';
        const size = Math.max(1, Math.min(100, Math.round(brushSize)));
        const startOffset = usesBrush ? -Math.floor(size / 2) : 0;
        const endOffset = usesBrush ? startOffset + size - 1 : 0;

        points.forEach(p => {
            for (let offsetY = startOffset; offsetY <= endOffset; offsetY += 1) {
                for (let offsetX = startOffset; offsetX <= endOffset; offsetX += 1) {
                    const x = p.x + offsetX;
                    const y = p.y + offsetY;
                    if (x >= 0 && x < width && y >= 0 && y < height) {
                        const idx = y * width + x;
                        if (newData[idx] !== targetVal) {
                            newData[idx] = targetVal;
                            changed = true;
                        }
                    }
                }
            }
        });

        if (changed) {
            workingDataRef.current = newData;
            gestureChangedRef.current = true;
            if (commit) {
                flushPreview();
                (gestureUpdateRef.current || updateRef.current)(new Int8Array(newData), true);
            } else {
                schedulePreview(newData);
            }
        }
    };

    return (
        <div
            ref={containerRef}
            className="w-full h-full overflow-hidden relative touch-none"
            onMouseDownCapture={handleMouseDownCapture}
            onMouseMoveCapture={handleMouseMoveCapture}
            onMouseUpCapture={handleMouseUpCapture}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={finishGesture}
            onLostPointerCapture={finishGesture}
            onPointerLeave={() => { if (!isDrawing && !isPanning) setHoverCoord(null); }}
            onWheel={handleWheel}
            onAuxClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
            <canvas ref={canvasRef} className="cursor-crosshair" />

            {/* Tooltip */}
            {hoverCoord && (
                <div
                    className="absolute pointer-events-none bg-black/80 text-white text-xs px-2 py-1 rounded shadow"
                    style={{
                        left: transform.x + hoverCoord.x * transform.k + 15,
                        top: transform.y + hoverCoord.y * transform.k - 15
                    }}
                >
                    {hoverCoord.x}, {hoverCoord.y}
                </div>
            )}
        </div>
    );
    // End GridCanvas
});
