import { describe, expect, it } from 'vitest';

import type { GridMetadata } from '../types';
import {
    EXAMPLE_SLOT_COUNT,
    PRESET_SLOTS,
    WAYPOINT_NAME_EXAMPLES,
    createWaypoint,
    defaultSlotName,
    describeBindingMismatch,
    evaluatePlacement,
    mapBindingFromMetadata,
    normalizeDegrees,
    parseWaypointsYaml,
    pixelToWorld,
    quaternionToYaw,
    serializeWaypointsYaml,
    worldToPixel,
    yawFromDrag,
    yawToQuaternion,
    type WaypointFile,
} from './waypoints';

const metadata: GridMetadata = {
    resolution: 0.05,
    origin: { x: -10, y: -10, theta: 0 },
};

describe('pixelToWorld / worldToPixel', () => {
    it('把栅格中心换算到世界坐标并在 0.05 m 分辨率下往返一致', () => {
        const world = pixelToWorld(224, 176, 400, metadata);
        expect(world.x).toBeCloseTo(-10 + 224.5 * 0.05, 12);
        expect(world.y).toBeCloseTo(-10 + (400 - 176 - 0.5) * 0.05, 12);
        const back = worldToPixel(world.x, world.y, 400, metadata);
        expect(back.col).toBe(224);
        expect(back.row).toBe(176);
    });

    it('处理非零 origin.theta', () => {
        const rotated: GridMetadata = { ...metadata, origin: { x: 1, y: 2, theta: Math.PI / 2 } };
        const world = pixelToWorld(10, 0, 20, rotated);
        // localX = 10.5*0.05 = 0.525, localY = 19.5*0.05 = 0.975
        // 旋转 90 度后 (-0.975, 0.525)，再加原点 (1, 2)
        expect(world.x).toBeCloseTo(0.025, 9);
        expect(world.y).toBeCloseTo(2.525, 9);
    });

    it('从世界坐标还原带旋转的栅格', () => {
        const rotated: GridMetadata = { ...metadata, origin: { x: 1, y: 2, theta: Math.PI / 2 } };
        const world = pixelToWorld(10, 0, 20, rotated);
        const back = worldToPixel(world.x, world.y, 20, rotated);
        expect(back.col).toBe(10);
        expect(back.row).toBe(0);
    });
});

describe('yawFromDrag / yawToQuaternion', () => {
    it('向右拖时朝向为 0 弧度，向上拖时朝向为 90 度', () => {
        expect(yawFromDrag(10, 10, 20, 10)).toBeCloseTo(0, 9);
        expect(yawFromDrag(10, 10, 10, 0)).toBeCloseTo(Math.PI / 2, 9);
    });

    it('四元数与 yaw 互转一致', () => {
        const yaw = Math.PI / 3;
        const quaternion = yawToQuaternion(yaw);
        expect(quaternionToYaw(quaternion)).toBeCloseTo(yaw, 9);
    });

    it('normalizeDegrees 折算到 -180 到 180', () => {
        expect(normalizeDegrees(270)).toBe(-90);
        expect(normalizeDegrees(-190)).toBe(170);
        expect(normalizeDegrees(45)).toBe(45);
    });
});

describe('evaluatePlacement', () => {
    function makeMap(width: number, height: number, occupied: Array<[number, number]>): Int8Array {
        const data = new Int8Array(width * height).fill(0);
        for (const [col, row] of occupied) data[row * width + col] = 100;
        return data;
    }

    it('自由栅格判定 ok', () => {
        const map = makeMap(50, 50, [[5, 5]], );
        const report = evaluatePlacement({ col: 25, row: 25, width: 50, height: 50, mapData: map });
        expect(report.status).toBe('ok');
    });

    it('落点是障碍物时判定 blocked', () => {
        const map = makeMap(50, 50, [[25, 25]], );
        const report = evaluatePlacement({ col: 25, row: 25, width: 50, height: 50, mapData: map });
        expect(report.status).toBe('blocked');
        expect(report.reason).toContain('障碍');
    });

    it('超出地图范围时判定 blocked', () => {
        const map = makeMap(50, 50, []);
        const report = evaluatePlacement({ col: -1, row: 25, width: 50, height: 50, mapData: map });
        expect(report.status).toBe('blocked');
    });

    it('只看落点本身：邻近障碍和未知栅格不影响判定', () => {
        const data = new Int8Array(50 * 50).fill(0);
        data[24 * 50 + 25] = 100; // 相邻格是障碍
        data[26 * 50 + 25] = -1;  // 相邻格未知
        const report = evaluatePlacement({ col: 25, row: 25, width: 50, height: 50, mapData: data });
        expect(report.status).toBe('ok');
    });
});

describe('waypoint 序列化与解析', () => {
    const sample: WaypointFile = {
        version: 1,
        frameId: 'map',
        mapBinding: { image: 'map.pgm', resolution: 0.05, origin: [-10, -10, 0], width: 400, height: 400 },
        waypoints: [
            {
                id: 'A',
                name: '客厅',
                aliases: ['大厅', '客厅间'],
                position: { x: 1.225, y: 1.175, z: 0 },
                orientation: { x: 0, y: 0, z: 0.3827, w: 0.9239 },
                yawDeg: 45,
                pixel: { col: 224, row: 176 },
                updatedAt: '2026-09-07T16:00:00.000Z',
            },
            {
                id: 'B',
                name: '厨房',
                aliases: [],
                position: { x: -2.475, y: 5.225, z: 0 },
                orientation: { x: 0, y: 0, z: -0.2588, w: 0.9659 },
                yawDeg: 0,
                pixel: { col: 150, row: 95 },
                updatedAt: '2026-09-07T16:01:00.000Z',
            },
        ],
    };

    it('序列化后再解析得到等价的结构', () => {
        const text = serializeWaypointsYaml(sample);
        const parsed = parseWaypointsYaml(text, 400, {
            resolution: 0.05,
            origin: { x: -10, y: -10, theta: 0 },
        });
        expect(parsed.version).toBe(1);
        expect(parsed.frameId).toBe('map');
        expect(parsed.mapBinding).toEqual(sample.mapBinding);
        expect(parsed.waypoints).toHaveLength(2);
        expect(parsed.waypoints[0].name).toBe('客厅');
        expect(parsed.waypoints[0].position.x).toBeCloseTo(1.225, 6);
        expect(parsed.waypoints[0].position.y).toBeCloseTo(1.175, 6);
        // orientation 序列化为四元数，roundtrip 保留原值
        expect(parsed.waypoints[0].orientation.z).toBeCloseTo(0.3827, 4);
        expect(parsed.waypoints[0].orientation.w).toBeCloseTo(0.9239, 4);
        expect(parsed.waypoints[0].yawDeg).toBeCloseTo(45, 1);
        expect(parsed.waypoints[0].pixel).toEqual({ col: 224, row: 176 });
        expect(parsed.waypoints[1].position.x).toBeCloseTo(-2.475, 6);
        expect(parsed.waypoints[1].orientation.w).toBeCloseTo(0.9659, 4);
        expect(parsed.waypoints[1].pixel).toEqual({ col: 150, row: 95 });
    });

    it('十个卡片 ID 固定，前五个示例名称可独立于地点文件修改', () => {
        expect(PRESET_SLOTS.map((slot) => slot.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
        expect(WAYPOINT_NAME_EXAMPLES).toEqual(['客厅', '厨房', '卧室', '卫生间', '充电桩']);
        expect(EXAMPLE_SLOT_COUNT).toBe(5);
        expect(defaultSlotName('A')).toBe('客厅');
        expect(defaultSlotName('F')).toBe('地点 F');
        const renamed: WaypointFile = {
            ...sample,
            waypoints: sample.waypoints.map((waypoint, index) => (
                index === 0 ? { ...waypoint, name: '我的小窝' } : waypoint
            )),
        };
        const parsed = parseWaypointsYaml(serializeWaypointsYaml(renamed));
        expect(parsed.waypoints[0].id).toBe('A');
        expect(parsed.waypoints[0].name).toBe('我的小窝');
    });

    it('十个地点含自定义名称可以完整导出并重新读取', () => {
        const ten: WaypointFile = {
            ...sample,
            waypoints: PRESET_SLOTS.map((slot, index) => ({
                ...sample.waypoints[0],
                id: slot.id,
                name: WAYPOINT_NAME_EXAMPLES[index] || `自定义${slot.id}`,
                position: { x: index * 0.1, y: index * 0.1, z: 0 },
            })),
        };
        const parsed = parseWaypointsYaml(serializeWaypointsYaml(ten));
        expect(parsed.waypoints).toHaveLength(10);
        expect(parsed.waypoints.map((waypoint) => waypoint.id)).toEqual(PRESET_SLOTS.map((slot) => slot.id));
        expect(parsed.waypoints[9].name).toBe('自定义J');
    });

    it('输出为无注释的 Nav2 对齐格式', () => {
        const text = serializeWaypointsYaml(sample);
        expect(text).not.toContain('#');
        expect(text).not.toContain('map_binding');
        expect(text).toContain('map: "map.pgm"');
        expect(text).toContain('size: [400, 400]');
        expect(text).toContain('pose:');
        expect(text).toContain('position: {x: 1.225, y: 1.175, z: 0.0}');
        expect(text).toContain('orientation: {x: 0, y: 0, z: 0.3827, w: 0.9239}');
        expect(text).not.toContain('yaw_mode');
    });

    it('兼容平铺 x/y 加 yaw 的旧格式', () => {
        const legacy = [
            'version: 1',
            'frame_id: map',
            'map: "map.pgm"',
            'resolution: 0.05',
            'origin: [-10, -10, 0]',
            'size: [400, 400]',
            'waypoints:',
            '  - id: "A"',
            '    name: "客厅"',
            '    x: 1.225',
            '    y: 1.175',
            '    yaw: 45',
        ].join('\n');
        const parsed = parseWaypointsYaml(legacy, 400, {
            resolution: 0.05,
            origin: { x: -10, y: -10, theta: 0 },
        });
        expect(parsed.waypoints).toHaveLength(1);
        expect(parsed.waypoints[0].position.x).toBeCloseTo(1.225, 6);
        expect(parsed.waypoints[0].orientation.z).toBeCloseTo(Math.sin(Math.PI / 8), 9);
    });

    it('解析时空点位列表', () => {
        const empty: WaypointFile = { ...sample, waypoints: [] };
        const parsed = parseWaypointsYaml(serializeWaypointsYaml(empty), 400, {
            resolution: 0.05,
            origin: { x: -10, y: -10, theta: 0 },
        });
        expect(parsed.waypoints).toEqual([]);
    });

    it('拒绝缺少朝向的点位', () => {
        const text = serializeWaypointsYaml(sample).replace(
            '      orientation: {x: 0, y: 0, z: 0.3827, w: 0.9239}\n',
            '',
        );
        expect(() => parseWaypointsYaml(text)).toThrow('pose.orientation');
    });

    it('拒绝未知版本', () => {
        const text = serializeWaypointsYaml(sample).replace('version: 1', 'version: 2');
        expect(() => parseWaypointsYaml(text)).toThrow('版本');
    });

    it('拒绝重复 id', () => {
        const text = serializeWaypointsYaml(sample);
        const duplicated = text.replace('id: "B"', 'id: "A"');
        expect(() => parseWaypointsYaml(duplicated)).toThrow('重复');
    });

    it('字段缺失时给出可读错误', () => {
        const text = serializeWaypointsYaml(sample).replace(/origin: \[-10, -10, 0\]/, 'origin: [-10, -10]');
        expect(() => parseWaypointsYaml(text)).toThrow('origin');
    });

    it('拒绝零四元数', () => {
        const text = serializeWaypointsYaml(sample).replace(
            'orientation: {x: 0, y: 0, z: 0.3827, w: 0.9239}',
            'orientation: {x: 0, y: 0, z: 0, w: 0}',
        );
        expect(() => parseWaypointsYaml(text)).toThrow('零四元数');
    });

    it('拒绝非正整数地图尺寸', () => {
        const text = serializeWaypointsYaml(sample).replace('size: [400, 400]', 'size: [400.5, 0]');
        expect(() => parseWaypointsYaml(text)).toThrow('两个正整数');
    });

    it('保存和导入时拒绝重复地点名称', () => {
        const duplicated: WaypointFile = {
            ...sample,
            waypoints: sample.waypoints.map((waypoint) => ({ ...waypoint, name: '客厅' })),
        };
        expect(() => serializeWaypointsYaml(duplicated)).toThrow('名称不能重复');

        const text = serializeWaypointsYaml(sample).replace('name: "厨房"', 'name: "客厅"');
        expect(() => parseWaypointsYaml(text)).toThrow('重复的 name');
    });

    it('createWaypoint 按地图元数据换算世界坐标', () => {
        const waypoint = createWaypoint({
            id: 'D',
            name: '卫生间',
            aliases: [],
            col: 224,
            row: 176,
            yawRad: Math.PI / 4,
            height: 400,
            metadata,
        });
        expect(waypoint.position.x).toBeCloseTo(pixelToWorld(224, 176, 400, metadata).x, 12);
        expect(waypoint.position.y).toBeCloseTo(pixelToWorld(224, 176, 400, metadata).y, 12);
        expect(waypoint.yawDeg).toBeCloseTo(45, 6);
    });
});

describe('map binding 校验', () => {
    const binding = mapBindingFromMetadata(metadata, 400, 400, 'map.pgm');

    it('匹配的元数据返回 null', () => {
        expect(describeBindingMismatch(binding, metadata, 400, 400)).toBeNull();
    });

    it('地图文件名匹配时全字相等才通过', () => {
        expect(describeBindingMismatch(binding, metadata, 400, 400, 'map.pgm')).toBeNull();
        // 大小写不同视为不同地图
        expect(describeBindingMismatch(binding, metadata, 400, 400, 'MAP.PGM')).toContain('不匹配');
    });

    it('地图文件名不匹配时给出提示', () => {
        expect(describeBindingMismatch(binding, metadata, 400, 400, 'other_map.pgm')).toContain('不匹配');
    });

    it('尺寸不一致时给出提示', () => {
        expect(describeBindingMismatch(binding, metadata, 384, 400)).toContain('不匹配');
    });

    it('原点漂移时给出提示', () => {
        const moved: GridMetadata = { ...metadata, origin: { x: -9.5, y: -10, theta: 0 } };
        expect(describeBindingMismatch(binding, moved, 400, 400)).toContain('不匹配');
    });

    it('分辨率不一致时给出提示', () => {
        const coarse: GridMetadata = { ...metadata, resolution: 0.1 };
        expect(describeBindingMismatch(binding, coarse, 400, 400)).toContain('不匹配');
    });
});
