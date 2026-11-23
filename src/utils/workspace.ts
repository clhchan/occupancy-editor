import { CELL_OCCUPIED, type GridData, type GridState } from '../types';
import { DEFAULT_METADATA, parseMapYaml, parsePgm, pgmToGrid } from './rosMap';
import { describeBindingMismatch, parseWaypointsYaml, PRESET_SLOTS, type Waypoint } from './waypoints';

export type EditMode = 'map' | 'mask' | 'waypoints';

export interface Workspace {
    location: { root: string; map: string; mask: string; waypoints: string; mode: EditMode };
    base: GridState;
    baseMask: GridData;
    basePoints: Waypoint[];
    mapDraft: GridData | null;
    maskDraft: GridData | null;
    pointDraft: Waypoint[] | null;
    names: Record<string, string>;
}

const fields = ['location', 'base', 'baseMask', 'basePoints', 'mapDraft', 'maskDraft', 'pointDraft', 'names'] as const;
let connection: Promise<IDBDatabase> | undefined;
const revisions = new WeakMap<Workspace, string>();

function database() {
    if (!connection) {
        connection = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('occupancy-editor:workspace', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('session');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch((error) => { connection = undefined; throw error; });
    }
    return connection;
}

export async function readWorkspace(): Promise<Workspace | null> {
    const store = (await database()).transaction('session').objectStore('session');
    const values = await Promise.all(fields.map((field) => new Promise((resolve, reject) => {
        const request = store.get(field);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    })));
    return values[0] ? Object.fromEntries(fields.map((key, index) => [key, values[index]])) as unknown as Workspace : null;
}

export async function writeWorkspace(current: Workspace | null, previous?: Workspace | null): Promise<void> {
    const transaction = (await database()).transaction('session', 'readwrite');
    const store = transaction.objectStore('session');
    if (!current) store.clear();
    else {
        const revision = `${Date.now()}:${Math.random()}`;
        const expected = previous ? revisions.get(previous) : undefined;
        revisions.set(current, revision);
        const request = store.get('revision');
        request.onsuccess = () => {
            const incremental = previous && expected && expected === request.result;
            for (const key of fields) {
                if (!incremental || previous[key] !== current[key]) store.put(current[key], key);
            }
            store.put(revision, 'revision');
        };
    }
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
}

export function sameGrid(left: GridData, right: GridData) {
    return left === right || (left.length === right.length && left.every((value, index) => value === right[index]));
}

export function hasDraft(session: Workspace) {
    return Boolean((session.mapDraft && !sameGrid(session.mapDraft, session.base.data))
        || (session.maskDraft && !sameGrid(session.maskDraft, session.baseMask))
        || (session.pointDraft && !sameWaypoints(session.pointDraft, session.basePoints)));
}

export function sameBase(left: Workspace, right: Workspace) {
    return left.base.width === right.base.width && left.base.height === right.base.height
        && JSON.stringify(left.base.metadata) === JSON.stringify(right.base.metadata)
        && sameGrid(left.base.data, right.base.data) && sameGrid(left.baseMask, right.baseMask)
        && sameWaypoints(left.basePoints, right.basePoints);
}

export function sameWaypoints(left: Waypoint[], right: Waypoint[]): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    const sameNumber = (first: number, second: number) => Number(first.toFixed(6)) === Number(second.toFixed(6));
    return left.every(point => {
        const other = right.find(candidate => candidate.id === point.id);
        if (!other || point.name.trim() !== other.name.trim() || !sameNumber(point.position.x, other.position.x) || !sameNumber(point.position.y, other.position.y)) return false;
        const axes = ['x', 'y', 'z', 'w'] as const;
        return [1, -1].some(sign => axes.every(axis => sameNumber(point.orientation[axis], sign * other.orientation[axis])));
    });
}

export function readBoundPoints(text: string, base: Pick<GridState, 'width' | 'height' | 'metadata'>, mapPath: string) {
    const parsed = parseWaypointsYaml(text, base.height, base.metadata);
    const mismatch = describeBindingMismatch(parsed.mapBinding, base.metadata, base.width, base.height, mapPath.split('/').pop());
    if (mismatch) throw new Error(mismatch);
    const unknown = parsed.waypoints.find(point => !PRESET_SLOTS.some(slot => slot.id === point.id));
    if (unknown) throw new Error(`点位 ID ${unknown.id} 不属于当前 A–J 槽位，请先转换地点文件`);
    return parsed.waypoints;
}

export async function readDiskWorkspace(cached: Workspace): Promise<Workspace> {
    const { location } = cached;
    async function readFile(path: string) {
        const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法读取 ${path}`);
        return response;
    }
    async function readGrid(path: string, fallback: GridState['metadata']): Promise<GridState> {
        const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
        const response = await fetch(`/api/files?path=${encodeURIComponent(directory)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`无法读取目录 ${directory}`);
        const listing = await response.json() as {root: string; entries: {type: string; path: string}[]};
        if (listing.root !== location.root) throw new Error('服务的数据目录已改变');
        const stem = path.replace(/\.pgm$/i, '').toLowerCase();
        const yaml = listing.entries.find(entry => entry.type === 'file' && /\.ya?ml$/i.test(entry.path) && entry.path.replace(/\.ya?ml$/i, '').toLowerCase() === stem);
        const [image, metadata] = await Promise.all([readFile(path), yaml ? readFile(yaml.path).then(file => file.text()).then(parseMapYaml) : fallback]);
        const parsed = parsePgm(await image.arrayBuffer());
        return { width: parsed.width, height: parsed.height, metadata, data: pgmToGrid(parsed, metadata) };
    }
    const base = await readGrid(location.map, DEFAULT_METADATA);
    const mask = location.mask ? await readGrid(location.mask, base.metadata) : null;
    if (mask && (mask.width !== base.width || mask.height !== base.height || Math.abs(mask.metadata.resolution - base.metadata.resolution) >= 1e-9 || (['x', 'y', 'theta'] as const).some(key => Math.abs(mask.metadata.origin[key] - base.metadata.origin[key]) >= 1e-9))) throw new Error('磁盘上的掩码与地图不匹配');
    const baseMask = mask ? mask.data.map(value => value === CELL_OCCUPIED ? value : 0) : new Int8Array(base.data.length);
    const basePoints = location.waypoints ? readBoundPoints(await (await readFile(location.waypoints)).text(), base, location.map) : [];
    const names = { ...cached.names };
    for (const point of cached.basePoints) delete names[point.id];
    for (const point of basePoints) names[point.id] = point.name;
    return { location, base, baseMask, basePoints, names, mapDraft: null, maskDraft: null, pointDraft: null };
}
