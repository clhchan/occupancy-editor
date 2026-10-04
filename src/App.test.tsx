import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import App from './App';
import { createWaypoint, serializeWaypointsYaml } from './utils/waypoints';

vi.mock('./components/GridCanvas', async () => {
    const React = await import('react');
    type MockGridProps = {
        markingSlot?: { id: string } | null;
        onPlaceWaypoint?: (payload: { col: number; row: number; yawRad: number; status: 'ok'; reason: string }) => void;
    };
    return {
        GridCanvas: React.forwardRef<{ resetView: () => void }, MockGridProps>((props, ref) => {
            React.useImperativeHandle(ref, () => ({ resetView: () => {} }));
            return <button type="button" data-testid="map" onClick={() => {
                if (props.markingSlot) props.onPlaceWaypoint?.({ col: 1, row: 1, yawRad: 0, status: 'ok', reason: '' });
            }}>地图</button>;
        }),
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

describe('地点卡片', () => {
    it('切换卡片或点击空白处收起编辑框，保存时跳过未标记卡片', async () => {
        let savedYaml = '';
        const fileList = { root: '/home/xx', path: '.', parent: null, entries: [{ name: 'map.pgm', path: 'map.pgm', type: 'file' }] };
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith('/api/files')) return new Response(JSON.stringify(fileList), { status: 200 });
            if (url === '/api/file?path=map.pgm') {
                return new Response('P2\n4 4\n255\n' + Array(16).fill('255').join(' '), { status: 200 });
            }
            if (url.startsWith('/api/file?')) return new Response('', { status: 404 });
            if (url === '/api/save') {
                const body = JSON.parse(String(init?.body)) as { contentBase64: string };
                savedYaml = atob(body.contentBase64);
                return new Response('{}', { status: 200 });
            }
            throw new Error(`Unexpected request: ${url}`);
        }));

        render(<App />);
        fireEvent.click(screen.getAllByRole('button', { name: '打开地图' })[0]);
        fireEvent.doubleClick(await screen.findByRole('button', { name: /map\.pgm/ }));
        await screen.findByText('0/10 已标记');

        expect(screen.getByText('地点 F')).toBeTruthy();
        expect(screen.getByText('地点 J')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /添加地点/ })).toBeNull();
        fireEvent.doubleClick(screen.getByText('客厅'));
        expect(screen.getByRole('textbox', { name: 'A 显示名称' })).toBeTruthy();
        fireEvent.click(screen.getByText('厨房'));
        expect(screen.queryByRole('textbox', { name: 'A 显示名称' })).toBeNull();
        fireEvent.doubleClick(screen.getByText('厨房'));
        expect(screen.getByRole('textbox', { name: 'B 显示名称' })).toBeTruthy();
        fireEvent.pointerDown(screen.getByText('地图数据'));
        expect(screen.queryByRole('textbox', { name: 'B 显示名称' })).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: '保存地点' }));
        fireEvent.click(await screen.findByRole('button', { name: '保存到此目录' }));
        await waitFor(() => expect(savedYaml).toContain('waypoints: []'));
        expect(screen.getByText('地点 A')).toBeTruthy();
        savedYaml = '';

        fireEvent.click(screen.getByText('地点 A'));
        fireEvent.click(screen.getByTestId('map'));
        await screen.findByText('1/10 已标记');
        fireEvent.click(screen.getByRole('button', { name: '保存地点' }));
        fireEvent.click(await screen.findByRole('button', { name: '保存到此目录' }));
        await waitFor(() => expect(savedYaml).toContain('id: "A"'));
        expect(savedYaml).not.toContain('id: "B"');
        expect(savedYaml).not.toContain('id: "F"');
    });

    it('已有四个点位时其余六张卡使用通用名称，仍只导出标记过的点位', async () => {
        const metadata = { resolution: 0.05, origin: { x: 0, y: 0, theta: 0 } };
        const waypointYaml = serializeWaypointsYaml({
            version: 1,
            frameId: 'map',
            mapBinding: { image: 'map.pgm', resolution: 0.05, origin: [0, 0, 0], width: 4, height: 4 },
            waypoints: ['A', 'B', 'C', 'D'].map((id, index) => createWaypoint({
                id,
                name: ['玄关', '厨房', '卧室', '阳台'][index],
                aliases: [],
                col: index,
                row: 1,
                yawRad: 0,
                height: 4,
                metadata,
            })),
        });
        const fileList = { root: '/home/xx', path: '.', parent: null, entries: [{ name: 'map.pgm', path: 'map.pgm', type: 'file' }] };
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.startsWith('/api/files')) return new Response(JSON.stringify(fileList), { status: 200 });
            if (url === '/api/file?path=map.pgm') {
                return new Response('P2\n4 4\n255\n' + Array(16).fill('255').join(' '), { status: 200 });
            }
            if (url === '/api/file?path=waypoints.yaml') return new Response(waypointYaml, { status: 200 });
            throw new Error(`Unexpected request: ${url}`);
        }));

        render(<App />);
        fireEvent.click(screen.getAllByRole('button', { name: '打开地图' })[0]);
        fireEvent.doubleClick(await screen.findByRole('button', { name: /map\.pgm/ }));
        await screen.findByText('4/10 已标记');
        expect(screen.getByText('玄关')).toBeTruthy();
        expect(screen.queryByText('充电桩')).toBeNull();
        expect(screen.getByText('地点 E')).toBeTruthy();
        expect(screen.getByText('地点 J')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /添加地点/ })).toBeNull();
        fireEvent.click(screen.getByTestId('map'));
        expect(screen.getByText('4/10 已标记')).toBeTruthy();
        fireEvent.click(screen.getByText('地点 E'));
        fireEvent.click(screen.getByTestId('map'));
        await screen.findByText('5/10 已标记');
        expect(screen.getByText('地点 F')).toBeTruthy();
    });
});
