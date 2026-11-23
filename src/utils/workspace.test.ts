import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_METADATA } from './rosMap';
import { hasDraft, readDiskWorkspace, sameBase, sameWaypoints, type Workspace } from './workspace';
import { createWaypoint } from './waypoints';

const cached: Workspace = {
    location: { root: '/maps', map: 'map.pgm', mask: '', waypoints: '', mode: 'mask' },
    base: { width: 1, height: 1, data: new Int8Array([0]), metadata: DEFAULT_METADATA },
    baseMask: new Int8Array([0]), basePoints: [], names: {},
    maskDraft: new Int8Array([100]), mapDraft: null, pointDraft: null,
};

const home = createWaypoint({ id: 'A', name: '客厅', aliases: [], col: 0, row: 0, height: 1, metadata: DEFAULT_METADATA, yawRad: 0 });

afterEach(() => { vi.unstubAllGlobals(); });

describe('workspace recovery', () => {
    it('loads disk changes without sending edits or applying the draft', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
            expect(options.method ?? 'GET').toBe('GET');
            return url.startsWith('/api/files?')
                ? new Response(JSON.stringify({ root: '/maps', entries: [] }))
                : new Response('P2\n1 1\n255\n0');
        }));
        const disk = await readDiskWorkspace(cached);
        expect(disk.base.data).toEqual(new Int8Array([100]));
        expect(disk.baseMask).toEqual(new Int8Array([0]));
        expect(sameBase(cached, disk)).toBe(false);
        expect(hasDraft(disk)).toBe(false);
        expect(hasDraft(cached)).toBe(true);
    });

    it('only treats an empty list as a draft if the file had waypoints', () => {
        expect(hasDraft({ ...cached, maskDraft: null, pointDraft: [] })).toBe(false);
        expect(hasDraft({ ...cached, basePoints: [home], maskDraft: null, pointDraft: [] })).toBe(true);
    });

    it('ignores cached grids identical to the baseline', () => {
        expect(hasDraft({ ...cached, mapDraft: new Int8Array(cached.base.data), maskDraft: new Int8Array(cached.baseMask) })).toBe(false);
    });

    it('recognizes a restored waypoint even after re-marking or reordering it', () => {
        const kitchen = { ...home, id: 'B', name: '厨房' };
        const remarked = { ...home, updatedAt: 'later', orientation: { x: 0, y: 0, z: 0, w: -1 } };
        expect(hasDraft({ ...cached, maskDraft: null, basePoints: [home, kitchen], pointDraft: [kitchen, remarked] })).toBe(false);
        expect(sameWaypoints([home], [{ ...home, name: '书房' }])).toBe(false);
        expect(sameWaypoints([home], [{ ...home, position: { ...home.position, x: home.position.x + 0.1 } }])).toBe(false);
        expect(sameWaypoints([home], [{ ...home, orientation: { x: 0, y: 0, z: 1, w: 0 } }])).toBe(false);
    });

    it('does not rebind drafts to a different server data root', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ root: '/different', entries: [] }))));
        await expect(readDiskWorkspace(cached)).rejects.toThrow('数据目录已改变');
    });
});
