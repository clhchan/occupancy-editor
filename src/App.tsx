import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from 'react';
import {
    CheckCircle2,
    CircleHelp,
    Download,
    Eraser,
    File,
    Folder,
    Minus,
    Pencil,
    Redo,
    RefreshCw,
    RotateCcw,
    Scan,
    Square,
    Trash2,
    Undo,
    Upload,
    X,
    XCircle,
    ChevronUp,
} from 'lucide-react';
import clsx from 'clsx';
import { GridCanvas, type GridCanvasHandle } from './components/GridCanvas';
import { useGrid } from './hooks/useGrid';
import { CELL_FREE, CELL_OCCUPIED, type GridData, type GridMetadata } from './types';
import { gridToPgm, gridToYaml, parseMapYaml, parsePgm, pgmToGrid } from './utils/rosMap';

type Tool = 'pencil' | 'rect' | 'line' | 'eraser' | 'unknown';
type EditMode = 'map' | 'mask';
type BrowserMode = 'open' | 'save';
type BrowserPathKind = 'open-map' | 'open-mask' | 'save-map' | 'save-mask';

interface BoardEntry {
    name: string;
    path: string;
    type: 'directory' | 'file';
    size?: number;
}

interface BrowserState {
    open: boolean;
    mode: BrowserMode;
    saveKind: EditMode | null;
    pathKind: BrowserPathKind;
    path: string;
    root: string;
    parent: string | null;
    entries: BoardEntry[];
    selected: BoardEntry | null;
    filename: string;
    loading: boolean;
}

const initialBrowser: BrowserState = {
    open: false,
    mode: 'open',
    saveKind: null,
    pathKind: 'open-map',
    path: '.',
    root: '',
    parent: null,
    entries: [],
    selected: null,
    filename: '',
    loading: false,
};

const defaultMetadata: GridMetadata = {
    image: 'map.pgm',
    resolution: 0.05,
    origin: { x: 0, y: 0, theta: 0 },
    negate: 0,
    occupied_thresh: 0.65,
    free_thresh: 0.196,
    mode: 'trinary',
};

const BROWSER_PATH_KEYS: Record<BrowserPathKind, string> = {
    'open-map': 'occupancy-editor:last-open-path',
    'open-mask': 'occupancy-editor:last-open-path',
    'save-map': 'occupancy-editor:last-save-path',
    'save-mask': 'occupancy-editor:last-save-path',
};
const LEGACY_OPEN_PATH_KEYS = [
    'occupancy-editor:last-open-map-path',
    'occupancy-editor:last-open-mask-path',
];
const LEGACY_SAVE_PATH_KEYS = [
    'occupancy-editor:last-save-map-path',
    'occupancy-editor:last-save-mask-path',
];
const MAX_LAYER_HISTORY = 50;
const NOTICE_DURATION_MS = 5000;

interface DirectoryPayload {
    error?: string;
    root: string;
    path: string;
    parent: string | null;
    entries: BoardEntry[];
}

function readBrowserPath(pathKind: BrowserPathKind): string {
    try {
        const key = BROWSER_PATH_KEYS[pathKind];
        const cached = window.localStorage.getItem(key);
        if (cached) return cached;
        if (pathKind === 'open-map' || pathKind === 'open-mask') {
            // Migrate either older open-browser cache into the shared path.
            for (const legacyKey of LEGACY_OPEN_PATH_KEYS) {
                const legacyPath = window.localStorage.getItem(legacyKey);
                if (legacyPath) {
                    window.localStorage.setItem(key, legacyPath);
                    return legacyPath;
                }
            }
        }
        if (pathKind === 'save-map' || pathKind === 'save-mask') {
            // Migrate the first path saved by older versions into the shared cache.
            for (const legacyKey of LEGACY_SAVE_PATH_KEYS) {
                const legacyPath = window.localStorage.getItem(legacyKey);
                if (legacyPath) {
                    window.localStorage.setItem(key, legacyPath);
                    return legacyPath;
                }
            }
        }
        return '.';
    } catch {
        return '.';
    }
}

function rememberBrowserPath(pathKind: BrowserPathKind, path: string): void {
    try {
        window.localStorage.setItem(BROWSER_PATH_KEYS[pathKind], path);
    } catch {
        // Storage may be unavailable in privacy-restricted browser contexts.
    }
}

async function fetchDirectory(path: string): Promise<DirectoryPayload> {
    const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
    const payload = await response.json() as DirectoryPayload;
    if (!response.ok) throw new Error(payload.error || '无法读取文件目录');
    return payload;
}

async function fetchFile(entry: BoardEntry, errorMessage: string): Promise<Response> {
    const response = await fetch(`/api/file?path=${encodeURIComponent(entry.path)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(errorMessage);
    return response;
}

async function deleteFile(entry: BoardEntry): Promise<void> {
    const response = await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: entry.path }),
    });
    const payload = await response.json() as { error?: string };
    if (!response.ok) throw new Error(payload.error || '删除失败');
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function safeBaseName(value: string): string {
    return value.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'map';
}

function joinBoardPath(directory: string, filename: string): string {
    return directory && directory !== '.' ? `${directory}/${filename}` : filename;
}

function appendLayerSnapshot(history: GridData[], snapshot: GridData): GridData[] {
    const next = [...history, snapshot];
    return next.length > MAX_LAYER_HISTORY ? next.slice(next.length - MAX_LAYER_HISTORY) : next;
}

function normalizeMaskData(data: GridData): GridData {
    const normalized = new Int8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
        normalized[index] = data[index] === CELL_OCCUPIED ? CELL_OCCUPIED : CELL_FREE;
    }
    return normalized;
}

function countOccupied(data: GridData): number {
    let count = 0;
    for (const value of data) if (value === CELL_OCCUPIED) count += 1;
    return count;
}

function formatSize(size?: number): string {
    if (!Number.isFinite(size)) return '';
    if (size! < 1024) return `${size} B`;
    if (size! < 1024 * 1024) return `${(size! / 1024).toFixed(1)} KB`;
    return `${(size! / 1024 / 1024).toFixed(1)} MB`;
}

function NoticeBanner({ notice, embedded = false }: { notice: { text: string; error?: boolean }; embedded?: boolean }) {
    const Icon = notice.error ? XCircle : CheckCircle2;
    return (
        <div role={notice.error ? 'alert' : 'status'} className={clsx(
            'flex items-start gap-2 text-sm',
            embedded
                ? 'border-b border-gray-200 bg-white px-5 py-3 text-gray-700'
                : 'fixed left-1/2 top-20 z-[70] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border border-gray-200 bg-white px-4 py-3 text-gray-700 shadow-2xl',
        )}>
            <Icon size={18} className={clsx('mt-0.5 shrink-0', notice.error ? 'text-red-500' : 'text-emerald-500')} />
            <span>{notice.text}</span>
        </div>
    );
}

function App() {
    const {
        width,
        height,
        gridData,
        metadata,
        updateGrid,
        replaceGrid,
        resetGrid,
        undo,
        redo,
        canUndo,
        canRedo,
        isAtInitial: isMapAtInitial,
    } = useGrid({ initialWidth: 50, initialHeight: 50, initialResolution: 0.05 });

    const canvasRef = useRef<GridCanvasHandle>(null);
    const [tool, setTool] = useState<Tool>('pencil');
    const [brushSize, setBrushSize] = useState(1);
    const [mode, setMode] = useState<EditMode>('map');
    const [maskData, setMaskData] = useState<GridData | null>(null);
    const [maskHistory, setMaskHistory] = useState<GridData[]>([]);
    const [maskFuture, setMaskFuture] = useState<GridData[]>([]);
    const [maskHistoryTruncated, setMaskHistoryTruncated] = useState(false);
    const [maskOccupiedCount, setMaskOccupiedCount] = useState(0);
    const maskEditStartRef = useRef<GridData | null>(null);
    const [sourcePath, setSourcePath] = useState('');
    const [loaded, setLoaded] = useState(false);
    const [mapDirty, setMapDirty] = useState(false);
    const [maskDirty, setMaskDirty] = useState(false);
    const [maskPath, setMaskPath] = useState('');
    const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
    const noticeTimerRef = useRef<number | null>(null);
    const [browser, setBrowser] = useState<BrowserState>(initialBrowser);
    const browserOperationRef = useRef(false);
    const openedMapRef = useRef<{ width: number; height: number; data: GridData; metadata: GridMetadata; maskData: GridData } | null>(null);

    const activeData = useMemo(() => {
        if (mode === 'map') return gridData;
        return maskData || new Int8Array(width * height).fill(CELL_FREE);
    }, [gridData, height, maskData, mode, width]);
    const activeCanUndo = mode === 'map' ? canUndo : maskHistory.length > 0;
    const activeCanRedo = mode === 'map' ? canRedo : maskFuture.length > 0;
    const activeDirty = mode === 'map' ? mapDirty : maskDirty;
    const hasChanges = mapDirty || maskDirty;
    const handleBrushToolWheel = useCallback((event: WheelEvent<HTMLButtonElement>) => {
        if (!loaded || !['pencil', 'eraser'].includes(tool) || event.deltaY === 0) return;
        event.preventDefault();
        const direction = event.deltaY < 0 ? 1 : -1;
        setBrushSize((current) => Math.min(100, Math.max(1, current + direction)));
    }, [loaded, tool]);
    const saveConflict = useMemo(() => {
        if (!browser.open || browser.mode !== 'save' || !browser.filename.trim()) return false;
        const base = safeBaseName(browser.filename);
        const targets = new Set([`${base}.pgm`, `${base}.yaml`].map((name) => name.toLowerCase()));
        return browser.entries.some((entry) => entry.type === 'file' && targets.has(entry.name.toLowerCase()));
    }, [browser.entries, browser.filename, browser.mode, browser.open]);

    useEffect(() => {
        if (mode === 'map' && isMapAtInitial && mapDirty) setMapDirty(false);
    }, [isMapAtInitial, mapDirty, mode]);

    const showNotice = useCallback((text: string, error = false) => {
        if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
        setNotice({ text, error });
        noticeTimerRef.current = window.setTimeout(() => {
            setNotice(null);
            noticeTimerRef.current = null;
        }, NOTICE_DURATION_MS);
    }, []);

    const clearNotice = useCallback(() => {
        if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
        setNotice(null);
    }, []);

    useEffect(() => () => {
        if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    }, []);

    const handleGridUpdate = useCallback((nextData: GridData, commit = true) => {
        if (mode === 'map') {
            updateGrid(nextData, width, height, commit);
        } else {
            if (!commit && !maskEditStartRef.current) {
                maskEditStartRef.current = new Int8Array(maskData || new Int8Array(width * height).fill(CELL_FREE));
            }
            if (commit) {
                const previous = maskEditStartRef.current || maskData;
                if (previous) {
                    if (maskHistory.length >= MAX_LAYER_HISTORY) setMaskHistoryTruncated(true);
                    setMaskHistory((history) => appendLayerSnapshot(history, new Int8Array(previous)));
                }
                maskEditStartRef.current = null;
            }
            // GridCanvas publishes a fresh immutable snapshot for each frame.
            setMaskData(nextData);
            if (commit) setMaskOccupiedCount(countOccupied(nextData));
            if (commit) setMaskFuture([]);
        }
        if (mode === 'map') setMapDirty(true);
        else setMaskDirty(true);
    }, [height, maskData, maskHistory.length, mode, updateGrid, width]);

    const handleUndo = useCallback(() => {
        const maskUndoToInitial = mode === 'mask' && maskHistory.length === 1 && !maskHistoryTruncated;
        if (mode === 'map') undo();
        else if (maskData && maskHistory.length) {
            const previous = maskHistory[maskHistory.length - 1];
            setMaskFuture((future) => appendLayerSnapshot(future, new Int8Array(maskData)));
            setMaskData(new Int8Array(previous));
            setMaskOccupiedCount(countOccupied(previous));
            setMaskHistory((history) => history.slice(0, -1));
            if (maskUndoToInitial) setMaskDirty(false);
        }
        if (mode === 'map') setMapDirty(true);
        else if (!maskUndoToInitial) setMaskDirty(true);
    }, [maskData, maskHistory, maskHistoryTruncated, mode, undo]);

    const handleRedo = useCallback(() => {
        if (mode === 'map') redo();
        else if (maskData && maskFuture.length) {
            const next = maskFuture[maskFuture.length - 1];
            if (maskHistory.length >= MAX_LAYER_HISTORY) setMaskHistoryTruncated(true);
            setMaskHistory((history) => appendLayerSnapshot(history, new Int8Array(maskData)));
            setMaskData(new Int8Array(next));
            setMaskOccupiedCount(countOccupied(next));
            setMaskFuture((future) => future.slice(0, -1));
        }
        if (mode === 'map') setMapDirty(true);
        else setMaskDirty(true);
    }, [maskData, maskFuture, maskHistory.length, mode, redo]);

    const loadDirectory = useCallback(async (path: string, pathKind: BrowserPathKind) => {
        setBrowser((current) => ({ ...current, loading: true, path }));
        try {
            const payload = await fetchDirectory(path);
            setBrowser((current) => ({
                ...current,
                loading: false,
                root: payload.root,
                path: payload.path,
                parent: payload.parent,
                entries: payload.entries || [],
                selected: null,
            }));
            rememberBrowserPath(pathKind, payload.path);
        } catch (error) {
            let loadError = error;
            if (path !== '.') {
                try {
                    const payload = await fetchDirectory('.');
                    setBrowser((current) => ({
                        ...current,
                        loading: false,
                        root: payload.root,
                        path: payload.path,
                        parent: payload.parent,
                        entries: payload.entries || [],
                        selected: null,
                    }));
                    rememberBrowserPath(pathKind, payload.path);
                    return;
                } catch (fallbackError) {
                    loadError = fallbackError;
                }
            }
            setBrowser((current) => ({ ...current, loading: false }));
            showNotice(loadError instanceof Error ? loadError.message : '无法读取文件目录', true);
        }
    }, [showNotice]);

    const openBrowser = useCallback((browserMode: BrowserMode, saveKind: EditMode | null = null) => {
        const pathKind: BrowserPathKind = browserMode === 'open'
            ? saveKind === 'mask' ? 'open-mask' : 'open-map'
            : saveKind === 'mask' ? 'save-mask' : 'save-map';
        clearNotice();
        setBrowser({
            ...initialBrowser,
            open: true,
            mode: browserMode,
            saveKind,
            pathKind,
            filename: browserMode === 'save'
                ? (saveKind === 'mask'
                    ? (maskPath ? safeBaseName(maskPath.split('/').pop() || 'keepout_mask') : 'keepout_mask')
                    : `${safeBaseName(sourcePath.split('/').pop() || 'map')}_edited`)
                : '',
        });
        void loadDirectory(readBrowserPath(pathKind), pathKind);
    }, [clearNotice, loadDirectory, maskPath, sourcePath]);

    const closeBrowser = useCallback(() => setBrowser((current) => ({ ...current, open: false })), []);

    useEffect(() => {
        if (!browser.open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') closeBrowser();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [browser.open, closeBrowser]);

    const yamlForPgm = (entry: BoardEntry | null | undefined): BoardEntry | null => {
        if (!entry) return null;
        const stem = entry.name.replace(/\.pgm$/i, '').toLowerCase();
        return browser.entries.find((item) => item.type === 'file' && /\.ya?ml$/i.test(item.name) && item.name.replace(/\.ya?ml$/i, '').toLowerCase() === stem) || null;
    };

    const openSelectedMap = async (entry?: BoardEntry) => {
        const selected = entry || browser.selected;
        if (!selected || browser.loading || browserOperationRef.current || !/\.pgm$/i.test(selected.name)) return;
        browserOperationRef.current = true;
        setBrowser((current) => ({ ...current, loading: true }));
        try {
            const yamlEntry = yamlForPgm(selected);
            const [pgmResponse, yamlResponse] = await Promise.all([
                fetchFile(selected, '读取 PGM 失败'),
                yamlEntry ? fetchFile(yamlEntry, '读取 YAML 失败') : Promise.resolve(null),
            ]);
            const parsed = parsePgm(await pgmResponse.arrayBuffer());
            const yamlText = yamlResponse ? await yamlResponse.text() : '';
            const fileMetadata = yamlText
                ? parseMapYaml(yamlText)
                : { ...defaultMetadata, origin: { ...defaultMetadata.origin } };
            const nextData = pgmToGrid(parsed, fileMetadata);

            const initialMaskData = new Int8Array(nextData.length).fill(CELL_FREE);
            openedMapRef.current = {
                width: parsed.width,
                height: parsed.height,
                data: nextData,
                metadata: fileMetadata,
                maskData: initialMaskData,
            };
            replaceGrid(nextData, parsed.width, parsed.height, fileMetadata);
            setMaskData(initialMaskData);
            setMaskOccupiedCount(countOccupied(initialMaskData));
            setMaskHistory([]);
            setMaskFuture([]);
            setMaskHistoryTruncated(false);
            setSourcePath(selected.path);
            setMaskPath('');
            setLoaded(true);
            setMapDirty(false);
            setMaskDirty(false);
            setMode('map');
            closeBrowser();
            window.setTimeout(() => canvasRef.current?.resetView(), 0);
            showNotice(yamlEntry ? `已加载 ${selected.name}` : `已加载 ${selected.name}（使用默认 YAML 参数）`);
        } catch (error) {
            showNotice(error instanceof Error ? error.message : '地图加载失败', true);
        } finally {
            browserOperationRef.current = false;
            setBrowser((current) => ({ ...current, loading: false }));
        }
    };

    const openSelectedMask = async (entry?: BoardEntry) => {
        const selected = entry || browser.selected;
        if (!loaded) {
            showNotice('请先打开原图，再打开掩码', true);
            return;
        }
        if (!selected || browser.loading || browserOperationRef.current || !/\.pgm$/i.test(selected.name)) return;
        browserOperationRef.current = true;
        setBrowser((current) => ({ ...current, loading: true }));
        try {
            const yamlEntry = yamlForPgm(selected);
            const [pgmResponse, yamlResponse] = await Promise.all([
                fetchFile(selected, '读取掩码 PGM 失败'),
                yamlEntry ? fetchFile(yamlEntry, '读取掩码 YAML 失败') : Promise.resolve(null),
            ]);
            const parsed = parsePgm(await pgmResponse.arrayBuffer());
            if (parsed.width !== width || parsed.height !== height) {
                throw new Error(`掩码尺寸 ${parsed.width} × ${parsed.height} 与当前地图 ${width} × ${height} 不一致`);
            }
            const maskText = yamlResponse ? await yamlResponse.text() : '';
            const maskMetadata = maskText ? parseMapYaml(maskText) : metadata;
            const resolutionMatches = Math.abs(maskMetadata.resolution - metadata.resolution) < 1e-9;
            if (!resolutionMatches) throw new Error('掩码分辨率与当前地图不一致');
            const originMatches = ['x', 'y', 'theta'].every((key) => Math.abs((maskMetadata.origin[key as keyof GridMetadata['origin']] ?? 0) - (metadata.origin[key as keyof GridMetadata['origin']] ?? 0)) < 1e-9);
            if (!originMatches) throw new Error('掩码原点与当前地图不一致');
            const nextMaskData = normalizeMaskData(pgmToGrid(parsed, maskMetadata));
            setMaskData(nextMaskData);
            setMaskOccupiedCount(countOccupied(nextMaskData));
            setMaskHistory([]);
            setMaskFuture([]);
            setMaskHistoryTruncated(false);
            maskEditStartRef.current = null;
            setMaskPath(selected.path);
            setMaskDirty(false);
            openedMapRef.current = openedMapRef.current
                ? { ...openedMapRef.current, maskData: new Int8Array(nextMaskData) }
                : null;
            setMode('mask');
            closeBrowser();
            window.setTimeout(() => canvasRef.current?.resetView(), 0);
            showNotice(yamlEntry ? `已加载掩码 ${selected.name}` : `已加载掩码 ${selected.name}（使用当前地图参数）`);
        } catch (error) {
            showNotice(error instanceof Error ? error.message : '掩码加载失败', true);
        } finally {
            browserOperationRef.current = false;
            setBrowser((current) => ({ ...current, loading: false }));
        }
    };

    const resetToOpenedMap = useCallback(() => {
        const openedMap = openedMapRef.current;
        if (!openedMap) return;
        resetGrid(openedMap.data, openedMap.width, openedMap.height, openedMap.metadata);
        setMaskData(new Int8Array(openedMap.maskData));
        setMaskOccupiedCount(countOccupied(openedMap.maskData));
        setMaskHistory([]);
        setMaskFuture([]);
        setMaskHistoryTruncated(false);
        maskEditStartRef.current = null;
        setMapDirty(false);
        setMaskDirty(false);
        showNotice('已重置地图');
    }, [resetGrid, showNotice]);

    const savePair = async (pgmPath: string, pgmBytes: Uint8Array, yamlPath: string, yamlBytes: Uint8Array) => {
        const response = await fetch('/api/save-pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pgm: { path: pgmPath, contentBase64: encodeBase64(pgmBytes) },
                yaml: { path: yamlPath, contentBase64: encodeBase64(yamlBytes) },
            }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error || '保存失败');
    };

    const saveSelectedDirectory = async () => {
        if (!browser.saveKind || !loaded || browserOperationRef.current) return;
        browserOperationRef.current = true;
        setBrowser((current) => ({ ...current, loading: true }));
        const base = safeBaseName(browser.filename);
        const data = browser.saveKind === 'map' ? gridData : maskData || new Int8Array(width * height).fill(CELL_FREE);
        const pgmName = `${base}.pgm`;
        try {
            const pgmPath = joinBoardPath(browser.path, pgmName);
            const yamlPath = joinBoardPath(browser.path, `${base}.yaml`);
            await savePair(
                pgmPath,
                gridToPgm(data, width, height, metadata),
                yamlPath,
                new TextEncoder().encode(gridToYaml(metadata, pgmName)),
            );
            if (browser.saveKind === 'map') setMapDirty(false);
            else setMaskDirty(false);
            closeBrowser();
            showNotice(`已保存到 ${pgmPath}`);
        } catch (error) {
            showNotice(error instanceof Error ? error.message : '保存失败', true);
        } finally {
            browserOperationRef.current = false;
            setBrowser((current) => ({ ...current, loading: false }));
        }
    };

    const deleteSelectedFile = async () => {
        const selected = browser.selected;
        if (!selected || selected.type !== 'file' || browser.loading || browserOperationRef.current) return;
        if (!window.confirm(`确定删除文件“${selected.name}”？\n此操作不可撤销。`)) return;
        browserOperationRef.current = true;
        setBrowser((current) => ({ ...current, loading: true }));
        try {
            await deleteFile(selected);
            await loadDirectory(browser.path, browser.pathKind);
            showNotice(`已删除 ${selected.name}`);
        } catch (error) {
            showNotice(error instanceof Error ? error.message : '删除失败', true);
        } finally {
            browserOperationRef.current = false;
            setBrowser((current) => ({ ...current, loading: false }));
        }
    };

    const handleMode = (nextMode: EditMode) => {
        setMode(nextMode);
        if (nextMode === 'mask') {
            if (tool === 'unknown') setTool('pencil');
            if (!maskData) setMaskData(new Int8Array(width * height).fill(CELL_FREE));
            if (!maskData) setMaskOccupiedCount(0);
        }
    };

    const clearMask = useCallback(() => {
        const current = maskData || new Int8Array(width * height).fill(CELL_FREE);
        if (!current.some((value) => value !== CELL_FREE)) return;
        if (maskHistory.length >= MAX_LAYER_HISTORY) setMaskHistoryTruncated(true);
        setMaskHistory((history) => appendLayerSnapshot(history, new Int8Array(current)));
        setMaskFuture([]);
        setMaskData(new Int8Array(width * height).fill(CELL_FREE));
        setMaskOccupiedCount(0);
        setMaskDirty(true);
    }, [height, maskData, maskHistory.length, width]);

    const renderEntries = () => {
        if (browser.loading) return <div className="py-16 text-center text-sm text-gray-400">读取中...</div>;
        const entries = browser.entries;
        const pgmStems = new Set(entries.filter((entry) => entry.type === 'file' && /\.pgm$/i.test(entry.name)).map((entry) => entry.name.replace(/\.pgm$/i, '').toLowerCase()));
        const yamlStems = new Set(entries.filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name)).map((entry) => entry.name.replace(/\.ya?ml$/i, '').toLowerCase()));
        if (!entries.length) return <div className="py-16 text-center text-sm text-gray-400">当前目录没有 PGM/YAML 文件</div>;
        return entries.map((entry) => {
            const isPgm = entry.type === 'file' && /\.pgm$/i.test(entry.name);
            const isYaml = entry.type === 'file' && /\.ya?ml$/i.test(entry.name);
            const stem = entry.name.replace(/\.(?:pgm|ya?ml)$/i, '').toLowerCase();
            const hasPair = isPgm ? yamlStems.has(stem) : isYaml && pgmStems.has(stem);
            const pairLabel = isPgm && !hasPair ? '缺少 YAML' : isYaml && !hasPair ? '缺少 PGM' : '';
            const selected = browser.selected?.path === entry.path;
            return (
                <button
                    key={entry.path}
                    type="button"
                    onClick={() => {
                        if (entry.type === 'directory') void loadDirectory(entry.path, browser.pathKind);
                        else setBrowser((current) => ({ ...current, selected: entry }));
                    }}
                    onDoubleClick={() => {
                        if (browser.mode === 'open' && isPgm) {
                            void (browser.pathKind === 'open-mask' ? openSelectedMask(entry) : openSelectedMap(entry));
                        }
                    }}
                    className={clsx('flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm transition-colors', selected ? 'bg-black text-white' : 'hover:bg-gray-100')}
                >
                    {entry.type === 'directory' ? <Folder size={17} /> : <File size={17} />}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {pairLabel && <span className={clsx('shrink-0 text-xs', selected ? 'text-white' : hasPair ? 'text-emerald-600' : 'text-amber-600')}>{pairLabel}</span>}
                    <span className={clsx('text-xs', selected ? 'text-white' : 'text-gray-400')}>{entry.type === 'directory' ? '目录' : formatSize(entry.size)}</span>
                </button>
            );
        });
    };

    const canOpenSelected = browser.selected?.type === 'file' && /\.pgm$/i.test(browser.selected.name) && (browser.pathKind !== 'open-mask' || loaded);
    const canDeleteSelected = browser.selected?.type === 'file' && /\.(?:pgm|ya?ml)$/i.test(browser.selected.name);

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-white text-black">
            <header className="z-10 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-gray-200 px-6">
                <h1 className="shrink-0 text-xl font-bold tracking-tight">Occupancy Editor</h1>
                <div className="flex min-w-0 items-center gap-1 rounded-md border border-gray-200 bg-white p-1 shadow-sm">
                    <ToolbarBtn icon={<Pencil size={18} />} active={tool === 'pencil'} disabled={!loaded} onClick={() => setTool('pencil')} onWheel={handleBrushToolWheel} title="画笔" />
                    <ToolbarBtn icon={<Square size={18} />} active={tool === 'rect'} disabled={!loaded} onClick={() => setTool('rect')} title="矩形" />
                    <ToolbarBtn icon={<Minus size={18} className="scale-x-150" />} active={tool === 'line'} disabled={!loaded} onClick={() => setTool('line')} title="连线" />
                    <ToolbarBtn icon={<Eraser size={18} />} active={tool === 'eraser'} disabled={!loaded} onClick={() => setTool('eraser')} onWheel={handleBrushToolWheel} title="橡皮擦" />
                    <ToolbarBtn icon={<CircleHelp size={18} />} active={tool === 'unknown'} disabled={!loaded || mode !== 'map'} onClick={() => setTool('unknown')} title="未知区域" />
                    <label className={clsx('flex items-center gap-1 border-l border-gray-200 pl-2 text-xs text-gray-500', (!loaded || !['pencil', 'eraser', 'unknown'].includes(tool)) && 'opacity-40')} title="画笔大小"><input type="number" min={1} max={100} step={1} value={brushSize} disabled={!loaded || !['pencil', 'eraser', 'unknown'].includes(tool)} onChange={(event) => setBrushSize(Math.min(100, Math.max(1, Number(event.target.value) || 1)))} onWheel={(event) => { if (document.activeElement !== event.currentTarget) return; event.preventDefault(); const direction = event.deltaY < 0 ? 1 : -1; setBrushSize((current) => Math.min(100, Math.max(1, current + direction))); }} className="w-12 rounded border border-gray-300 px-1.5 py-1 text-center text-xs text-gray-700 outline-none focus:border-black disabled:cursor-not-allowed disabled:bg-gray-50" aria-label="画笔大小" /><span>px</span></label>
                    <span className="mx-1 h-6 w-px bg-gray-200" />
                    <ToolbarBtn icon={<Undo size={18} />} disabled={!activeCanUndo} onClick={handleUndo} repeatOnHold title="撤销" />
                    <ToolbarBtn icon={<Redo size={18} />} disabled={!activeCanRedo} onClick={handleRedo} repeatOnHold title="重做" />
                    <ToolbarBtn icon={<RotateCcw size={18} />} disabled={!loaded || !hasChanges} onClick={resetToOpenedMap} title="重置" />
                    <ToolbarBtn icon={<Scan size={18} />} disabled={!loaded} onClick={() => canvasRef.current?.resetView()} title="适应窗口" />
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => openBrowser('open')} className="flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100"><Upload size={16} />打开地图</button>
                    <button type="button" disabled={!loaded} onClick={() => openBrowser('open', 'mask')} className="flex items-center gap-2 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-30"><Upload size={16} />打开掩码</button>
                    <button type="button" disabled={!loaded} onClick={() => openBrowser('save', 'map')} className="flex items-center gap-2 rounded-md bg-black px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-30"><Download size={16} />保存地图</button>
                    <button type="button" disabled={!loaded} onClick={() => openBrowser('save', 'mask')} className="flex items-center gap-2 rounded-md bg-black px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-30"><Download size={16} />保存掩码</button>
                </div>
            </header>

            <div className="flex min-h-0 flex-1 overflow-hidden">
                <main className="relative min-w-0 flex-1 overflow-hidden bg-gray-100">
                    {loaded && <GridCanvas ref={canvasRef} width={width} height={height} data={activeData} backgroundData={mode === 'mask' ? gridData : undefined} tool={tool} brushSize={brushSize} onUpdate={handleGridUpdate} />}
                    {!loaded && (
                        <div className="absolute inset-0 z-10 grid place-items-center bg-gray-100 px-6">
                            <div className="flex max-w-sm flex-col items-center text-center">
                                <h2 className="text-lg font-semibold text-gray-900">导入地图</h2>
                                <p className="mt-2 text-sm text-gray-500">选择 PGM 文件开始编辑</p>
                                <div className="mt-5 flex items-center gap-3">
                                    <button type="button" onClick={() => openBrowser('open')} className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800"><Upload size={15} className="mr-2 inline-block" />打开地图</button>
                                </div>
                            </div>
                        </div>
                    )}
                    {loaded && <div className="pointer-events-none absolute bottom-5 left-5 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 shadow-md">
                        <span className="font-mono">{width} × {height} ({metadata.resolution} m/px)</span>
                        <span className="h-4 w-px bg-gray-200" />
                        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-black" />占用</span>
                        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm border border-gray-300 bg-white" />空闲</span>
                        <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[#d1d5db]" />未知</span>
                        {mode === 'mask' && <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[#e5464f]" />禁行</span>}
                    </div>}
                    {activeDirty && <div className="pointer-events-none absolute bottom-5 right-5 rounded-full border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-medium text-amber-700">未保存修改</div>}
                </main>

                <aside className="flex w-80 min-h-0 shrink-0 flex-col border-l border-gray-200 bg-white">
                    <section className="shrink-0 border-b border-gray-200 bg-gray-50 p-4">
                        <h2 className="mb-3 text-lg font-bold text-gray-900">图层编辑</h2>
                        <div className="flex rounded bg-gray-200 p-1">
                            <button type="button" disabled={!loaded} onClick={() => handleMode('map')} className={clsx('flex-1 rounded py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40', mode === 'map' ? 'bg-white text-black shadow-sm' : 'text-gray-600 hover:text-black')}>原图层</button>
                            <button type="button" disabled={!loaded} onClick={() => handleMode('mask')} className={clsx('flex-1 rounded py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40', mode === 'mask' ? 'bg-white text-black shadow-sm' : 'text-gray-600 hover:text-black')}>禁行区层</button>
                        </div>
                    </section>
                    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
                        <section>
                            <div className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-500">地图数据</div>
                            <dl className="space-y-2.5 text-sm">
                                <div className="flex justify-between gap-3"><dt className="text-gray-400">文件</dt><dd className="truncate font-medium text-gray-700">{sourcePath.split('/').pop() || '未加载'}</dd></div>
                                <div className="flex justify-between gap-3"><dt className="text-gray-400">分辨率</dt><dd className="font-medium text-gray-700">{metadata.resolution} m/px</dd></div>
                                <div className="flex justify-between gap-3"><dt className="text-gray-400">原点</dt><dd className="font-medium text-gray-700">{metadata.origin.x}, {metadata.origin.y}</dd></div>
                                <div className="flex justify-between gap-3"><dt className="text-gray-400">当前图层</dt><dd className="font-medium text-gray-700">{mode === 'map' ? '原图层' : '禁行区层'}</dd></div>
                            </dl>
                        </section>
                        <section>
                            <div className="mb-3 flex items-center justify-between gap-3 text-xs font-bold uppercase tracking-wider text-gray-500"><span>禁行区掩码</span><ToolbarBtn icon={<Trash2 size={16} />} disabled={!loaded || maskOccupiedCount === 0} onClick={clearMask} title="清空掩码" /></div>
                            <div className="flex items-center gap-3 rounded border border-gray-200 p-3">
                                <div className="grid h-14 w-14 place-items-center bg-gray-100 text-gray-400"><Square size={23} /></div>
                                <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-gray-700">{maskPath.split('/').pop() || 'keepout_mask'}</div><div className="mt-1 text-xs text-gray-400">{maskOccupiedCount.toLocaleString()} 个禁行栅格</div></div>
                            </div>
                        </section>
                    </div>
                </aside>
            </div>

            {browser.open && (
                <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-5" role="dialog" aria-modal="true">
                    <div className="flex max-h-[min(720px,calc(100vh-40px))] w-[min(680px,100%)] flex-col overflow-hidden rounded-lg bg-white shadow-2xl">
                        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
                            <div><h2 className="font-semibold">{browser.mode === 'open' ? (browser.pathKind === 'open-mask' ? '选择掩码文件' : '选择地图文件') : '保存文件'}</h2><p className="mt-1 text-xs text-gray-400">{browser.mode === 'open' ? (browser.pathKind === 'open-mask' ? '选择 PGM 文件，将匹配同名 YAML 并载入禁行区层' : '选择 PGM 文件及同名 YAML，载入原图层') : '选择保存路径'}</p></div>
                            <button type="button" onClick={closeBrowser} className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-black" title="关闭"><X size={18} /></button>
                        </div>
                        {notice && !notice.error && <NoticeBanner notice={notice} embedded />}
                        <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-5 py-2">
                            <button type="button" disabled={!browser.parent || browser.loading} onClick={() => browser.parent && void loadDirectory(browser.parent, browser.pathKind)} className="rounded p-1 text-gray-600 hover:bg-gray-200 disabled:opacity-30" title="上一级"><ChevronUp size={17} /></button>
                            <code className="min-w-0 flex-1 truncate text-xs text-gray-600">{browser.root ? `${browser.root}${browser.path === '.' ? '' : `/${browser.path}`}` : browser.path}</code>
                            <button type="button" disabled={browser.loading} onClick={() => void loadDirectory(browser.path, browser.pathKind)} className="rounded p-1 text-gray-600 hover:bg-gray-200 disabled:opacity-30" title="刷新"><RefreshCw size={16} /></button>
                        </div>
                        {browser.mode === 'save' && <div className="border-b border-gray-200 px-5 py-3"><div className="flex flex-wrap items-center gap-3"><label htmlFor="serverSaveName" className="text-xs text-gray-500">文件名</label><input id="serverSaveName" value={browser.filename} onChange={(event) => setBrowser((current) => ({ ...current, filename: event.target.value }))} className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black" /><span className="text-xs text-gray-400">.pgm + .yaml</span></div>{saveConflict && <p className="mt-2 text-xs text-amber-600">同名文件已存在，保存将覆盖</p>}</div>}
                        <div className="min-h-[260px] flex-1 overflow-y-auto p-3">{renderEntries()}</div>
                        <div className="flex items-center justify-between gap-4 border-t border-gray-200 px-5 py-4"><div className="min-w-0 truncate text-xs text-gray-500">{browser.mode === 'open' ? (browser.selected ? browser.selected.name : '未选择文件') : `保存到 ${browser.root ? `${browser.root}${browser.path === '.' ? '' : `/${browser.path}`}` : browser.path}`}</div><div className="flex shrink-0 items-center gap-2"><button type="button" disabled={browser.loading || !canDeleteSelected} onClick={() => void deleteSelectedFile()} className="flex items-center gap-1.5 rounded border border-red-200 px-3 py-2 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30" title="删除选中的 PGM/YAML 文件"><Trash2 size={16} />删除文件</button><button type="button" disabled={browser.loading || (browser.mode === 'open' ? !canOpenSelected : !browser.filename.trim())} onClick={() => { if (browser.mode !== 'open') { void saveSelectedDirectory(); return; } if (browser.pathKind === 'open-mask') void openSelectedMask(); else void openSelectedMap(); }} className="shrink-0 rounded bg-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-30">{browser.mode === 'open' ? (browser.pathKind === 'open-mask' ? '打开掩码' : '打开地图') : '保存到此目录'}</button></div></div>
                    </div>
                </div>
            )}
            {notice && (!browser.open || notice.error) && <NoticeBanner notice={notice} />}
        </div>
    );
}

const LONG_PRESS_DELAY_MS = 350;
const REPEAT_INTERVAL_STAGES = [
    { afterMs: 0, intervalMs: 60 },
    { afterMs: 1000, intervalMs: 40 },
    { afterMs: 2500, intervalMs: 25 },
    { afterMs: 5000, intervalMs: 18 },
];

function ToolbarBtn({ icon, active, disabled, onClick, onWheel, repeatOnHold = false, title }: { icon: ReactNode; active?: boolean; disabled?: boolean; onClick: () => void; onWheel?: (event: WheelEvent<HTMLButtonElement>) => void; repeatOnHold?: boolean; title: string }) {
    const actionRef = useRef(onClick);
    const disabledRef = useRef(Boolean(disabled));
    const repeatTimeoutRef = useRef<number | null>(null);
    const repeatStartedAtRef = useRef<number | null>(null);
    const scheduleRepeatRef = useRef<() => void>(() => undefined);
    const longPressRef = useRef(false);
    const suppressClickRef = useRef(false);

    // Keep the timer attached to the newest App callback, especially for Mask history.
    actionRef.current = onClick;
    disabledRef.current = Boolean(disabled);

    const stopRepeat = useCallback((suppressClick: boolean) => {
        if (repeatTimeoutRef.current !== null) {
            window.clearTimeout(repeatTimeoutRef.current);
            repeatTimeoutRef.current = null;
        }
        repeatStartedAtRef.current = null;
        if (suppressClick) suppressClickRef.current = true;
    }, []);

    useEffect(() => () => stopRepeat(false), [stopRepeat]);

    const scheduleRepeat = useCallback(() => {
        const startedAt = repeatStartedAtRef.current;
        if (startedAt === null || disabledRef.current) return;
        const elapsed = window.performance.now() - startedAt;
        let intervalMs = REPEAT_INTERVAL_STAGES[0].intervalMs;
        for (const stage of REPEAT_INTERVAL_STAGES) {
            if (elapsed >= stage.afterMs) intervalMs = stage.intervalMs;
        }
        repeatTimeoutRef.current = window.setTimeout(() => {
            repeatTimeoutRef.current = null;
            if (disabledRef.current) {
                stopRepeat(true);
                return;
            }
            actionRef.current();
            scheduleRepeatRef.current();
        }, intervalMs);
    }, [stopRepeat]);

    scheduleRepeatRef.current = scheduleRepeat;

    const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
        if (!repeatOnHold || event.button !== 0) return;
        longPressRef.current = false;
        suppressClickRef.current = false;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        repeatTimeoutRef.current = window.setTimeout(() => {
            if (disabledRef.current) return;
            longPressRef.current = true;
            repeatStartedAtRef.current = window.performance.now();
            actionRef.current();
            scheduleRepeat();
        }, LONG_PRESS_DELAY_MS);
    };

    const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
        if (!repeatOnHold || event.button !== 0) return;
        stopRepeat(longPressRef.current);
    };

    const handleClick = () => {
        if (repeatOnHold && suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        onClick();
    };

    return <button type="button" onClick={handleClick} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={() => stopRepeat(longPressRef.current)} onLostPointerCapture={() => stopRepeat(longPressRef.current)} onWheel={onWheel} title={title} disabled={disabled} className={clsx('rounded p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-30', active ? 'bg-black text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-black')}>{icon}</button>;
}

export default App;
